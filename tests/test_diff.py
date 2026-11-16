import time
from datetime import datetime, timezone

import pytest
from helpers import AB_FACTS, employment_graph, fresh_graph, run, works_at

from selfgraph import ValidationError

ACME = works_at("acme")
GLOBEX = works_at("globex")


def instant():
    time.sleep(0.01)
    stamp = datetime.now(timezone.utc)
    time.sleep(0.01)
    return stamp


def facts_graph():
    g = fresh_graph("diff")
    run(g.insert.facts(AB_FACTS, source_id="doc-1"))
    return g


def test_log_lists_every_write_oldest_first_with_counts():
    g = facts_graph()
    out = run(g.diff())
    assert [(c.kind, c.action) for c in out.changes] == [
        ("entity", "created"),
        ("entity", "created"),
        ("relation", "created"),
        ("source", "created"),
    ]
    assert [c.id for c in out.changes] == [
        "t:a",
        "t:b",
        AB_FACTS["relations"][0]["id"],
        "doc-1",
    ]
    assert out.changes[0].summary == "T A"
    assert out.changes[2].summary == "KNOWS t:a -> t:b"
    assert out.changes[3].summary.startswith("version ")
    assert out.since is None and out.until is None
    assert out.total == 4
    assert out.counts == {"entity": 2, "relation": 1, "source": 1}
    assert sum(out.counts.values()) == out.total
    assert [c.at for c in out.changes] == sorted(c.at for c in out.changes)


def test_window_is_half_open():
    g = fresh_graph("diff")
    run(g.entities.create("A", "T"))
    time.sleep(0.01)
    run(g.entities.create("B", "T"))
    time.sleep(0.01)
    run(g.relations.create("t:a", "KNOWS", "t:b"))
    all_out = run(g.diff())
    assert all_out.total == 3
    first = all_out.changes[0].at
    since = run(g.diff(since=first))
    assert since.total == 2
    assert all(c.at > first for c in since.changes)
    assert [c.id for c in since.changes] == [c.id for c in all_out.changes[1:]]
    mid = all_out.changes[1].at
    until = run(g.diff(until=mid))
    assert until.total == 2
    assert all(c.at <= mid for c in until.changes)
    empty = run(g.diff(since=instant()))
    assert empty.total == 0 and empty.counts == {} and empty.changes == []


def test_entity_update_is_a_separate_change():
    g = fresh_graph("diff")
    run(g.entities.create("Ann", "Person"))
    created = instant()
    run(g.entities.update("person:ann", name="Ann Q Doe"))
    out = run(g.diff())
    entity = [(c.action, c.at > created) for c in out.changes if c.id == "person:ann"]
    assert entity == [("created", False), ("updated", True)]


def test_relation_revision_and_retirement_by_supersede():
    g = employment_graph("diff", contradiction="supersede")
    acme = run(g.relations.create(**ACME))
    globex = run(g.relations.create(**GLOBEX))
    out = run(g.diff())
    rel = [(c.action, c.id, c.summary) for c in out.changes if c.kind == "relation"]
    assert rel == [
        ("created", acme.id, "WORKS_AT person:ann -> company:acme"),
        ("created", globex.id, "WORKS_AT person:ann -> company:globex"),
        ("retired", acme.id, f"WORKS_AT person:ann -> company:acme (by {globex.id})"),
    ]
    assert out.counts["relation"] == 3


def test_decision_created_then_updated():
    g = employment_graph("diff")
    rel = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    dec = run(g.decisions.create("Join Acme", steps=[rel.id], actor_entity="person:ann"))
    created = instant()
    run(g.decisions.update(dec.id, summary="changed"))
    out = run(g.diff())
    events = [(c.action, c.at > created, c.summary) for c in out.changes if c.kind == "decision"]
    assert events == [("created", False, "Join Acme"), ("updated", True, "Join Acme")]


def test_certify_and_uncertify_are_changes():
    g = facts_graph()
    rel = run(g.relations.get(AB_FACTS["relations"][0]["id"]))
    run(g.relations.certify(rel.id, by="qa"))
    out = run(g.diff())
    certified = [(c.action, c.summary) for c in out.changes if c.kind == "relation"]
    assert certified == [("created", "KNOWS t:a -> t:b"), ("certified", "KNOWS t:a -> t:b (by qa)")]
    run(g.relations.uncertify(rel.id))
    out = run(g.diff())
    actions = [c.action for c in out.changes if c.kind == "relation"]
    assert actions == ["created", "certified", "uncertified"]


def test_preference_versions_are_created_then_updated():
    g = facts_graph()
    pref = run(g.preferences.create("t:a", "tool", "t:b", strength=0.5))
    run(g.preferences.update(pref.id, strength=0.9))
    out = run(g.diff())
    prefs = [(c.action, c.id, c.summary) for c in out.changes if c.kind == "preference"]
    assert prefs == [
        ("created", pref.id, "preference tool: t:a -> t:b"),
        ("updated", pref.id, "preference tool: t:a -> t:b"),
    ]


def test_merge_and_unmerge_are_changes():
    g = fresh_graph("diff")
    run(g.insert.facts({"entities": [{"type": "Person", "name": "Robert Smith", "aliases": ["Bob Smith"]}]}))
    res = run(g.insert.facts({"entities": [{"type": "Person", "name": "bob smith"}]}))
    [merge] = res.merges
    out = run(g.diff())
    merges = [(c.action, c.id, c.summary) for c in out.changes if c.kind == "merge"]
    assert merges == [
        (
            "merged",
            merge.id,
            f"{merge.absorbed_id} into {merge.survivor_id}: alias",
        )
    ]
    run(g.entities.unmerge(merge.id))
    out = run(g.diff())
    merges = [(c.action, c.summary) for c in out.changes if c.kind == "merge"]
    assert merges[1][0] == "unmerged"
    assert merges[1][1] == f"{merge.absorbed_id} back out of {merge.survivor_id}"


def test_kinds_filter_and_limit_keep_counts_over_the_whole_window():
    g = facts_graph()
    run(g.insert.facts({"entities": [{"type": "T", "name": "C"}]}))
    run(g.preferences.create("t:a", "tool", "t:b"))
    whole = run(g.diff())
    out = run(g.diff(kinds=["entity"]))
    assert out.total == 3
    assert out.counts == {"entity": 3}
    assert all(c.kind == "entity" for c in out.changes)
    limited = run(g.diff(limit=2))
    assert limited.total == whole.total
    assert len(limited.changes) == 2
    assert [c.id for c in limited.changes] == [c.id for c in whole.changes[-2:]]
    entity_limited = run(g.diff(kinds=["entity"], limit=2))
    assert entity_limited.total == 3
    assert len(entity_limited.changes) == 2


def test_bad_arguments_are_rejected():
    g = facts_graph()
    with pytest.raises(ValidationError, match="kinds must be"):
        run(g.diff(kinds=["nope"]))
    with pytest.raises(ValidationError, match="limit must be"):
        run(g.diff(limit=0))
    with pytest.raises(ValidationError, match="invalid since"):
        run(g.diff(since="yesterday"))

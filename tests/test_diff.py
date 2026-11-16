import time
from datetime import datetime, timezone

import pytest
from helpers import AB_FACTS, create_entities, employment_graph, fresh_graph, instant, run, works_at

from selfgraph import ValidationError


def test_diff_tracks_insert_revision_and_supersede_by_known_time():
    g = employment_graph("diff", contradiction="supersede")
    start = instant()
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2000-01-01"))
    inserted = instant()
    revised = run(g.relations.update(acme.id, set_properties={"role": "cto"}))
    updated = instant()
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time="2001-01-01"))
    end = instant()
    first = run(g.diff(start, inserted))
    assert [(r.id, r.revision) for r in first.relations_added] == [(acme.id, 1)]
    assert first.relations_retired == first.relations_revised == first.entities_created == []
    second = run(g.diff(inserted, updated))
    assert [(r.id, r.revision) for r in second.relations_revised] == [(revised.id, 2)]
    assert second.relations_added == second.relations_retired == second.entities_created == []
    third = run(g.diff(updated, end))
    assert [r.id for r in third.relations_added] == [globex.id]
    assert [(r.id, r.invalidated_by) for r in third.relations_retired] == [(acme.id, globex.id)]
    assert third.relations_revised == third.entities_created == []
    assert run(g.relations.get(acme.id)) is None
    assert {r.id for r in run(g.relations.list(include_invalidated=True)).items} == {acme.id, globex.id}


def test_diff_entities_empty_window_validation_and_namespace():
    g = fresh_graph("diff")
    start = instant()
    create_entities(g, "Person:Ann", "Person:Bob")
    end = instant()
    d = run(g.diff(start.isoformat(), end))
    assert [e.id for e in d.entities_created] == ["person:ann", "person:bob"]
    assert d.limitations == ["Deletes are not visible."]
    assert d.relations_added == d.relations_retired == d.relations_revised == []
    assert run(g.diff(end, end)).entities_created == []
    assert run(fresh_graph("other").diff(start, end)).entities_created == []
    for since, until in ((None, end), (end, start), ("bad", end)):
        with pytest.raises(ValidationError):
            run(g.diff(since, until))
    assert run(g.diff(end)).until >= end


def test_diff_source_replacement_reports_retirement():
    g = fresh_graph("diff-source")
    start = instant()
    run(g.insert.text("Ann works at Acme.", source_id="note"))
    before = instant()
    original = run(g.relations.list()).items
    assert original
    run(g.insert.text("Ann lives in Paris.", source_id="note", replace_source=True))
    after = instant()
    d = run(g.diff(before, after))
    assert {r.id for r in d.relations_retired} == {r.id for r in original}
    assert all(r.invalidated_by.startswith("sv:") for r in d.relations_retired)
    assert {r.id for r in d.relations_added} == {r.id for r in run(g.relations.list()).items}
    assert d.relations_revised == []
    assert [e.id for e in d.entities_created] == ["thing:paris"]
    first = run(g.diff(start, before))
    assert {r.id for r in first.relations_added} == {r.id for r in original}
    assert first.relations_retired == []


def test_diff_boundaries_all_revisions_and_read_only():
    g = fresh_graph("diff-boundaries")
    create_entities(g, "Person:Ann", "Person:Bob")
    r1 = run(g.relations.create("person:ann", "KNOWS", "person:bob"))
    r2 = run(g.relations.update(r1.id, set_properties={"n": 2}))
    r3 = run(g.relations.update(r1.id, set_properties={"n": 3}))
    before = run(g.relations.versions(r1.id))
    d = run(g.diff(r1.created_at, r3.created_at))
    assert d.relations_added == d.relations_retired == d.entities_created == []
    assert [(r.id, r.revision) for r in d.relations_revised] == [(r1.id, 2), (r1.id, 3)]
    assert [r.revision for r in run(g.diff(r1.created_at, r2.created_at)).relations_revised] == [2]
    assert run(g.diff(r3.created_at, r3.created_at)).relations_revised == []
    assert run(g.relations.versions(r1.id)) == before


def test_diff_cli_and_mcp(capsys):
    from helpers import cli, mcp_session

    from selfgraph.cli import build_parser, dispatch
    from selfgraph.mcp import server
    from selfgraph.runtime import to_jsonable

    with mcp_session():
        g = run(server._graph_handle())
        start = instant()
        create_entities(g, "Person:Ann")
        end = instant()
        expected = to_jsonable(run(g.diff(start, end)))
        flags = ["diff", "--since", start.isoformat(), "--until", end.isoformat()]
        assert cli(g, [*flags, "--json"], capsys) == expected
        run(dispatch(g, build_parser().parse_args(flags)))
        summary = capsys.readouterr().out
        assert "Note: Deletes are not visible." in summary
        assert "+ entity person:ann" in summary
        assert "1 entities created, 0 relations added, 0 revised, 0 retired" in summary
        assert run(server.graph_diff(start.isoformat(), end.isoformat())) == expected
        assert "graph_diff" in [tool.__name__ for tool in server.TOOLS]


def test_diff_sync():
    from helpers import make_store, unique_ns

    from selfgraph import SyncSelfGraph

    with SyncSelfGraph(make_store(), namespace=unique_ns("diff-sync")) as g:
        start = instant()
        entity = g.entities.create("Ann", "Person")
        end = instant()
        d = g.diff(start, end)
        assert d.entities_created == [entity]
        assert d.relations_added == d.relations_revised == d.relations_retired == []
        assert d.limitations == ["Deletes are not visible."]


def test_diff_pages_entities_and_skips_internal_edges():
    g = fresh_graph("diff-pages")
    start = instant()
    from selfgraph._ops import _PAGE

    count = _PAGE + 5
    run(g.insert.facts({"entities": [{"type": "T", "name": str(i)} for i in range(count)]}))
    run(
        g.insert.facts(
            {
                "relations": [
                    {"id": f"relation:page-{i}", "from_entity": "t:0", "type": "KNOWS", "to_entity": "t:1"}
                    for i in range(count)
                ]
            }
        )
    )
    rel = run(g.relations.create("t:0", "KNOWS", "t:1"))
    run(g.decisions.create("Decision", steps=[rel.id]))
    end = instant()
    d = run(g.diff(start, end))
    assert len(d.entities_created) == count
    assert len({e.id for e in d.entities_created}) == count
    assert {r.id for r in d.relations_added} == {rel.id, *(f"relation:page-{i}" for i in range(count))}
    assert d.relations_retired == d.relations_revised == []


def test_diff_is_read_only_after_initialization(monkeypatch):
    g = fresh_graph("diff-readonly")
    create_entities(g, "T:A", "T:B")
    rel = run(g.relations.create("t:a", "KNOWS", "t:b"))
    start = rel.created_at

    async def no_write(*args, **kwargs):
        raise AssertionError("diff attempted to write")

    for name in ("initialize", "upsert_node", "upsert_nodes", "create_edges", "delete_node", "lock_node"):
        monkeypatch.setattr(g.store, name, no_write)
    assert run(g.diff(start)).relations_added == []


def test_diff_revisions_do_not_repeat_a_copied_retirement():
    g = employment_graph("diff-copied", contradiction="supersede")
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    start = instant()
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    retired = instant()
    run(
        g.insert.facts(
            {
                "relations": [
                    {
                        "id": acme.id,
                        "from_entity": "person:ann",
                        "type": "WORKS_AT",
                        "to_entity": "company:acme",
                        "properties": {"note": "still retired"},
                        "event_time": "2000-01-01T00:00:00Z",
                    }
                ]
            }
        )
    )
    end = instant()
    assert [(r.id, r.revision) for r in run(g.diff(start, end)).relations_retired] == [(acme.id, 1)]
    later = run(g.diff(retired, end))
    assert later.relations_retired == later.relations_added == []
    assert [(r.id, r.revision) for r in later.relations_revised] == [(acme.id, 2)]
    assert [r.id for r in run(g.retrieve("Ann", known_at=retired)).subgraph.relations] == [globex.id]


def test_diff_validates_naive_and_offset_times_and_closed_graph():
    from datetime import datetime

    from selfgraph import StoreError

    g = fresh_graph("diff-time")
    d = run(g.diff("2020-01-01T05:30:00+05:30", datetime(2020, 1, 1)))
    assert d.since == d.until
    for since, until in ((1, None), ("2020-01-01", False), ("2020-01-01", "bad")):
        with pytest.raises(ValidationError):
            run(g.diff(since, until))
    run(g.close())
    with pytest.raises(StoreError):
        run(g.diff("2020-01-01"))


def test_diff_retirement_boundaries_reassertion_and_delete_limit():
    from datetime import timedelta

    g = employment_graph("diff-retired", contradiction="supersede")
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    old = run(g.relations.versions(acme.id))[0]
    ended = old.invalidated_known_at
    d = run(g.diff(acme.created_at - timedelta(microseconds=1), ended))
    assert {r.id for r in d.relations_added} == {acme.id, globex.id}
    assert [r.id for r in d.relations_retired] == [acme.id]
    assert d.relations_revised == []
    assert run(g.diff(ended, ended)).relations_retired == []
    revived = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    later = run(g.diff(ended, revived.created_at))
    assert [(r.id, r.revision) for r in later.relations_revised] == [(acme.id, 2)]
    assert [r.id for r in later.relations_retired] == [globex.id]
    before_delete = instant()
    run(g.relations.delete(acme.id))
    deleted = run(g.diff(before_delete))
    assert deleted.relations_added == deleted.relations_retired == []
    assert [(r.id, r.revision) for r in deleted.relations_revised] == [(globex.id, 2)]
    assert run(g.relations.get(acme.id)) is None
    assert run(g.relations.get(globex.id)) is not None


def test_bolt_edge_pages_order_revisions_within_each_relation(monkeypatch):
    from selfgraph.models import CypherResult
    from selfgraph.stores._cypher import CypherPrimitives

    store = CypherPrimitives()
    queries = []

    async def capture(query, params):
        queries.append((query, params))
        return CypherResult(columns=[], rows=[])

    monkeypatch.setattr(store, "_run", capture)
    run(store.match_edges("test", from_label="Entity", current_only=False, skip=500, limit=500))
    query, params = queries[0]
    assert "ORDER BY r.id, r.revision SKIP $skip LIMIT $limit" in query
    assert params["skip"] == params["limit"] == 500


def test_diff_late_fact_retirement_correction_and_quiet_restatement():
    g = employment_graph("diff-late", contradiction="supersede")
    create_entities(g, "Company:Initech")
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2000-01-01"))
    initech = run(g.relations.create("person:ann", "WORKS_AT", "company:initech", event_time="2004-01-01"))
    before = instant()
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time="2002-01-01"))
    after = instant()
    d = run(g.diff(before, after))
    assert [r.id for r in d.relations_added] == [globex.id]
    assert [(r.id, r.revision) for r in d.relations_revised] == [(acme.id, 2)]
    assert {r.id: r.invalidated_by for r in d.relations_retired} == {acme.id: globex.id, globex.id: initech.id}
    run(
        g.insert.facts(
            {"relations": [{"from_entity": "person:ann", "type": "WORKS_AT", "to_entity": "company:initech"}]}
        )
    )
    quiet = run(g.diff(after))
    assert quiet.relations_added == quiet.relations_revised == quiet.relations_retired == []
    assert run(g.relations.get(initech.id)).event_time == initech.event_time


@pytest.mark.parametrize("count", [499, 500, 501, 505, 1005])
def test_diff_pages_every_revision_of_one_relation(count):
    from selfgraph._serde import encode_relation_props

    g = fresh_graph("diff-revision-pages")
    create_entities(g, "T:A", "T:B")
    stamp = instant()
    rows = [
        (
            "KNOWS",
            "t:a",
            "t:b",
            encode_relation_props(
                ns=g.namespace,
                id="relation:many",
                revision=revision,
                properties={},
                event_time=None,
                created_at=stamp,
                is_current=revision == count,
                source_count=0,
            ),
        )
        for revision in range(count, 0, -1)
    ]
    run(g.store.create_edges(g.namespace, "Entity", "Entity", rows))
    result = run(g.diff("1900-01-01", "2100-01-01"))
    assert [(r.id, r.revision) for r in result.relations_added] == [("relation:many", 1)]
    assert [(r.id, r.revision) for r in result.relations_revised] == [
        ("relation:many", revision) for revision in range(2, count + 1)
    ]
    assert result.relations_retired == []


@pytest.mark.parametrize("backend", ["kuzu", "hydradb"])
def test_document_edge_pages_order_by_id_and_revision(backend, monkeypatch):
    from selfgraph import HydraDBStore, KuzuStore
    from selfgraph.models import CypherResult

    if backend == "kuzu":
        pytest.importorskip("kuzu")
        store = KuzuStore(":memory:")
    else:
        store = HydraDBStore("bolt://localhost:17687", auth=("neo4j", "test"))
    queries = []

    async def capture(query, params):
        queries.append(query)
        return CypherResult(columns=[], rows=[])

    monkeypatch.setattr(store, "_run", capture)
    try:
        run(store.match_edges("test", from_label="Entity", skip=500, limit=500))
        if backend == "kuzu":
            assert "ORDER BY r.sid, r.revision SKIP 500 LIMIT 500" in queries[-1]
        else:
            assert "r.revision AS __rev" in queries[-1]
            assert "ORDER BY __ob, __rev SKIP $skip LIMIT $limit" in queries[-1]
        run(store.match_edges("test", from_label="Entity", order_by="revision"))
        assert "__rev" not in queries[-1]
        assert "ORDER BY r.revision SKIP" in queries[-1] if backend == "kuzu" else "ORDER BY __ob SKIP" in queries[-1]
    finally:
        run(store.close())


ACME = works_at("acme")
GLOBEX = works_at("globex")

EARLY = datetime(1900, 1, 1, tzinfo=timezone.utc)
LATE = datetime(2100, 1, 1, tzinfo=timezone.utc)


def facts_graph():
    g = fresh_graph("diff")
    run(g.insert.facts(AB_FACTS, source_id="doc-1"))
    return g


def test_log_lists_every_write_oldest_first_with_counts():
    g = facts_graph()
    out = run(g.diff(EARLY, LATE))
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
    late = instant()
    all_out = run(g.diff(EARLY, late))
    assert all_out.total == 3
    first = all_out.changes[0].at
    since = run(g.diff(first, late))
    assert since.total == 2
    assert all(c.at > first for c in since.changes)
    assert [c.id for c in since.changes] == [c.id for c in all_out.changes[1:]]
    mid = all_out.changes[1].at
    until = run(g.diff(EARLY, mid))
    assert until.total == 2
    assert all(c.at <= mid for c in until.changes)
    empty = run(g.diff(late, instant()))
    assert empty.total == 0 and empty.counts == {} and empty.changes == []


def test_entity_update_is_not_a_change():
    g = fresh_graph("diff")
    run(g.entities.create("Ann", "Person"))
    run(g.entities.update("person:ann", name="Ann Q Doe"))
    out = run(g.diff(EARLY, LATE))
    entity = [(c.action, c.summary) for c in out.changes if c.id == "person:ann"]
    assert entity == [("created", "Person Ann Q Doe")]


def test_relation_revision_and_retirement_by_supersede():
    g = employment_graph("diff", contradiction="supersede")
    acme = run(g.relations.create(**ACME))
    globex = run(g.relations.create(**GLOBEX))
    out = run(g.diff(EARLY, LATE))
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
    out = run(g.diff(EARLY, LATE))
    events = [(c.action, c.at > created, c.summary) for c in out.changes if c.kind == "decision"]
    assert events == [("created", False, "Join Acme"), ("updated", True, "Join Acme")]


def test_certify_and_uncertify_are_changes():
    g = facts_graph()
    rel = run(g.relations.get(AB_FACTS["relations"][0]["id"]))
    run(g.relations.certify(rel.id, by="qa"))
    out = run(g.diff(EARLY, LATE))
    certified = [(c.action, c.summary) for c in out.changes if c.kind == "relation"]
    assert certified == [("created", "KNOWS t:a -> t:b"), ("certified", "KNOWS t:a -> t:b (by qa)")]
    run(g.relations.uncertify(rel.id))
    out = run(g.diff(EARLY, LATE))
    actions = [c.action for c in out.changes if c.kind == "relation"]
    assert actions == ["created", "certified", "uncertified"]


def test_certification_survives_a_relation_update():
    g = facts_graph()
    rel = run(g.relations.get(AB_FACTS["relations"][0]["id"]))
    run(g.relations.certify(rel.id, by="qa"))
    run(g.relations.update(rel.id, set_properties={"weight": 2}))
    out = run(g.diff(EARLY, LATE))
    certified = [(c.action, c.id) for c in out.changes if c.kind == "relation"]
    assert certified == [("created", rel.id), ("certified", rel.id), ("updated", rel.id)]


def test_preference_versions_are_created_then_updated():
    g = facts_graph()
    pref = run(g.preferences.create("t:a", "tool", "t:b", strength=0.5))
    run(g.preferences.update(pref.id, strength=0.9))
    out = run(g.diff(EARLY, LATE))
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
    out = run(g.diff(EARLY, LATE))
    merges = [(c.action, c.id, c.summary) for c in out.changes if c.kind == "merge"]
    assert merges == [
        (
            "merged",
            merge.id,
            f"{merge.absorbed_id} into {merge.survivor_id}: alias",
        )
    ]
    run(g.entities.unmerge(merge.id))
    out = run(g.diff(EARLY, LATE))
    merges = [(c.action, c.summary) for c in out.changes if c.kind == "merge"]
    assert merges[1][0] == "unmerged"
    assert merges[1][1] == f"{merge.absorbed_id} back out of {merge.survivor_id}"


def test_kinds_filter_and_limit_keep_counts_over_the_whole_window():
    g = facts_graph()
    run(g.insert.facts({"entities": [{"type": "T", "name": "C"}]}))
    run(g.preferences.create("t:a", "tool", "t:b"))
    whole = run(g.diff(EARLY, LATE))
    out = run(g.diff(EARLY, LATE, kinds=["entity"]))
    assert out.total == whole.total
    assert out.counts == whole.counts
    assert all(c.kind == "entity" for c in out.changes)
    limited = run(g.diff(EARLY, LATE, limit=2))
    assert limited.total == whole.total
    assert limited.counts == whole.counts
    assert len(limited.changes) == 2
    assert [c.id for c in limited.changes] == [c.id for c in whole.changes[-2:]]
    entity_limited = run(g.diff(EARLY, LATE, kinds=["entity"], limit=2))
    assert entity_limited.total == whole.total
    assert len(entity_limited.changes) == 2


def test_bad_arguments_are_rejected():
    g = facts_graph()
    with pytest.raises(ValidationError, match="kinds must be"):
        run(g.diff(EARLY, LATE, kinds=["nope"]))
    with pytest.raises(ValidationError, match="limit must be"):
        run(g.diff(EARLY, LATE, limit=0))
    with pytest.raises(ValidationError, match="invalid since"):
        run(g.diff("yesterday"))

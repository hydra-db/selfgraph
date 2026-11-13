import logging
from datetime import datetime, timedelta, timezone

import pytest
from helpers import (
    cli,
    create_entities,
    employment_graph,
    fresh_graph,
    make_store,
    mcp_session,
    new_graph,
    run,
    t_entities,
    unique_ns,
    utc,
    works_at,
)

from selfgraph import EvidenceInput, SyncSelfGraph, ValidationError
from selfgraph._maintenance import relevance_score

T0 = utc(2026)


def _later(days):
    return datetime.now(timezone.utc) + timedelta(days=days)


def test_relevance_formula():
    assert relevance_score([T0], T0, 30, 0) == 0.5
    assert relevance_score([T0, None], T0 + timedelta(days=30), 30, 1) == 0.375
    assert relevance_score([T0 - timedelta(days=60), T0], T0 + timedelta(days=60), 30, 3) == 0.21875
    assert relevance_score([T0 + timedelta(days=5)], T0, 30, 0) == 0.5
    assert relevance_score([T0], T0, 30, 63) == 0.992188
    assert relevance_score([datetime(2026, 1, 1)], T0 + timedelta(days=10), 7, 2) == 0.309582


def test_decay_scores_in_place_and_is_idempotent():
    g = fresh_graph("mt")
    run(g.entities.create("A", "T", id="t:a", properties={"k": 1}))
    t_entities(g, "b", "c")
    rel = run(g.relations.create("t:a", "KNOWS", "t:b", evidence=[EvidenceInput(source_id="s1")]))
    run(g.relations.create("t:a", "LIKES", "t:c"))
    at = _later(0)

    dry = run(g.maintenance.decay(now=at))
    assert dry.dry_run and dry.updated_entities == dry.updated_relations == 0
    assert run(g.entities.get("t:a")).relevance is None

    before = run(g.entities.get("t:a"))
    result = run(g.maintenance.decay(now=at, dry_run=False))
    assert result.entities == dry.entities and result.relations == dry.relations
    assert (result.updated_entities, result.updated_relations) == (3, 2)
    expected = relevance_score([before.created_at, before.updated_at], at, 30, 2)
    assert result.entities["t:a"] == expected

    a = run(g.entities.get("t:a"))
    assert a.relevance == expected and a.relevance_at == at
    assert a.updated_at == before.updated_at and a.properties == {"k": 1}
    stored = run(g.relations.get(rel.id))
    assert stored.revision == 1 and stored.relevance == result.relations[rel.id]
    assert stored.relevance == relevance_score([rel.created_at], at, 30, 1)
    assert len(run(g.relations.versions(rel.id))) == 1

    again = run(g.maintenance.decay(now=at, dry_run=False))
    assert (again.updated_entities, again.updated_relations) == (0, 0)
    assert again.entities == result.entities

    run(g.entities.update("t:a", properties={"k": 2}))
    assert run(g.entities.get("t:a")).relevance == expected


def test_maintenance_rejects_bad_arguments():
    g = fresh_graph("mt")
    for bad in (0, -1, float("inf"), True, "30"):
        with pytest.raises(ValidationError):
            run(g.maintenance.decay(half_life_days=bad))
    with pytest.raises(ValidationError):
        run(g.maintenance.decay(dry_run="no"))
    with pytest.raises(ValidationError, match=r"^now \d{4}-\d\d-\d\dT[\d:.]+Z is in the future"):
        run(g.maintenance.decay(now=_later(1)))
    for kwargs in ({}, {"types": ["Temp"]}, {"dry_run": False}):
        with pytest.raises(ValidationError):
            run(g.maintenance.prune(**kwargs))
    with pytest.raises(ValidationError):
        run(g.maintenance.prune(older_than=_later(0.0005), dry_run="false"))
    with pytest.raises(ValidationError, match="older_than .* is in the future"):
        run(g.maintenance.prune(older_than=_later(1)))
    for bad in (-1, 1.5):
        with pytest.raises(ValidationError, match="min_relevance must be between 0 and 1"):
            run(g.maintenance.prune(min_relevance=bad))


def test_retrieval_ties_break_on_relevance_only_after_decay():
    g = fresh_graph("mt")
    run(g.entities.create("Acme Red", "Org", id="org:a"))
    run(g.entities.create("Acme Tan", "Org", id="org:z"))
    for name in ("x", "y", "w"):
        run(g.entities.create(name.upper(), "Thing", id=f"thing:{name}"))
        run(g.relations.create("org:z", "OWNS", f"thing:{name}"))
    plain = run(g.retrieve("acme", k=2, depth=0))
    assert [s.id for s in plain.seeds] == ["org:a", "org:z"]
    assert plain.seeds[0].score == plain.seeds[1].score
    assert run(g.retrieve("acme", k=2, depth=0)) == plain

    run(g.maintenance.decay(now=_later(0), dry_run=False))
    decayed = run(g.retrieve("acme", k=2, depth=0))
    assert [s.id for s in decayed.seeds] == ["org:z", "org:a"]
    assert [s.score for s in decayed.seeds] == [s.score for s in plain.seeds]


def _cascading(g):
    create_entities(g, "Person:Keep", "Temp:X", "Temp:Y")
    uses = run(g.relations.create("person:keep", "USES", "temp:x", evidence=[EvidenceInput(source_id="s", quote="q")]))
    link = run(g.relations.create("temp:x", "LINKS", "temp:y"))
    run(g.relations.update(link.id, set_properties={"v": 2}))
    run(g.preferences.create("person:keep", "tool", "person:keep", about_entity="temp:x"))
    run(g.preferences.create("temp:y", "tool", "person:keep"))
    run(
        g.decisions.create(
            "Keep", steps=[], id="decision:keep", alternative_entities=["temp:x", "temp:y", "person:keep"]
        )
    )
    run(g.decisions.create("Gone", steps=[link.id], id="decision:gone"))
    return uses, link


def _state(g):
    pref = run(g.preferences.list(subject_entity="person:keep")).items[0]
    return (
        [e.id for e in run(g.entities.list()).items],
        [(r.from_entity, r.type, r.to_entity) for r in run(g.relations.list()).items],
        [d.id for d in run(g.decisions.list()).items],
        run(g.decisions.get("decision:keep")).alternative_entities,
        (pref.about_entity, pref.revision),
        run(g.store.match_nodes(g.namespace, "Evidence")),
    )


def test_prune_dry_run_then_apply_matches_deleting_entities_one_by_one(caplog):
    one = fresh_graph("mt")
    _cascading(one)
    counts = {}
    for eid in ("temp:x", "temp:y"):
        for key, value in run(one.entities.delete(eid)).model_dump().items():
            counts[key] = counts.get(key, 0) + value
    batched = fresh_graph("mt")
    uses, link = _cascading(batched)
    cutoff = _later(0.0005)
    plan = run(batched.maintenance.prune(older_than=cutoff, types=["Temp"]))
    assert plan.dry_run and plan.entity_ids == ["temp:x", "temp:y"]
    assert plan.relation_ids == sorted([uses.id, link.id])
    assert plan.deleted is None and "deleted" not in plan.model_dump()
    assert run(batched.entities.get("temp:x")) is not None
    narrow = run(batched.maintenance.prune(older_than=T0, types=["Temp"]))
    assert narrow.entity_ids == [] and narrow.relation_ids == []
    with caplog.at_level(logging.INFO, logger="selfgraph"):
        done = run(batched.maintenance.prune(older_than=cutoff, types=["Temp"], dry_run=False))
    assert "pruned 2 entities and 2 relations" in caplog.text
    assert [r.levelname for r in caplog.records] == ["INFO"]
    assert (done.entity_ids, done.relation_ids) == (plan.entity_ids, plan.relation_ids)
    assert done.deleted.model_dump() == counts
    assert counts == {
        "deleted_entities": 2,
        "deleted_relation_versions": 3,
        "deleted_decisions": 1,
        "deleted_preference_versions": 1,
    }
    assert _state(batched) == _state(one)
    assert _state(one)[:5] == (["person:keep"], [], ["decision:keep"], ["person:keep"], (None, 2))


def test_prune_by_relevance_skips_unscored_items_and_filters_by_type():
    g = fresh_graph("mt")
    uses, _ = _cascading(g)
    assert run(g.maintenance.prune(min_relevance=1.0)).entity_ids == []
    run(g.maintenance.decay(now=_later(0), half_life_days=1e-9, dry_run=False))
    run(g.entities.create("Fresh", "Person", id="person:fresh"))
    plan = run(g.maintenance.prune(min_relevance=0.01, relation_types=["USES"]))
    assert plan.entity_ids == [] and plan.relation_ids == [uses.id]
    done = run(g.maintenance.prune(min_relevance=0.01, dry_run=False))
    assert "person:fresh" not in done.entity_ids
    assert run(g.entities.get("person:fresh")) is not None
    assert run(g.entities.get("person:keep")) is None
    g = fresh_graph("mt")
    create_entities(g, "Thing:X", "Thing:Y", "Gadget:Z")
    gadget = run(g.relations.create("thing:x", "GADGET", "thing:y"))
    cutoff = _later(0.0005)
    by_type = run(g.maintenance.prune(older_than=cutoff, types=["Gadget"]))
    assert (by_type.entity_ids, by_type.relation_ids) == (["gadget:z"], [])
    by_rel = run(g.maintenance.prune(older_than=cutoff, relation_types=["gadget"]))
    assert (by_rel.entity_ids, by_rel.relation_ids) == ([], [gadget.id])


def test_dedupe_relations_merges_duplicates_into_the_lowest_id(caplog):
    g = fresh_graph("mt")
    t_entities(g, "a", "b")
    one, two = EvidenceInput(source_id="s1", quote="one"), EvidenceInput(source_id="s2", quote="two")
    run(g.relations.create("t:a", "knows", "t:b", id="relation:x1", properties={"w": 1, "k": True}, evidence=[one]))
    x2 = {"w": 2, "only2": "y"}
    run(
        g.relations.create(
            "t:a", "KNOWS", "t:b", id="relation:x2", properties=x2, event_time=utc(2021), evidence=[two, one]
        )
    )
    run(g.relations.update("relation:x2", set_properties={"v": 2}))
    run(g.relations.create("t:a", "KNOWS", "t:b", id="relation:x4", properties={"only2": "z"}, event_time=utc(2020)))
    run(g.relations.create("t:b", "KNOWS", "t:a", id="relation:x3"))
    dec = run(g.decisions.create("D", steps=["relation:x2", "relation:x3"], id="decision:d"))

    plan = run(g.maintenance.dedupe_relations())
    assert plan.dry_run
    [group] = plan.groups
    assert (group.survivor, group.duplicates, group.type) == ("relation:x1", ["relation:x2", "relation:x4"], "KNOWS")
    assert group.versions_lost == {"relation:x2": 2, "relation:x4": 1}
    assert group.conflicts == {"relation:x2": ["w"], "relation:x4": ["only2"]}
    assert "lowest relation id" in plan.note and "versions_lost" in plan.note
    assert run(g.relations.get("relation:x2")) is not None

    with caplog.at_level(logging.INFO, logger="selfgraph"):
        done = run(g.maintenance.dedupe_relations(dry_run=False))
    assert "deduplicated 1 relation groups" in caplog.text
    assert [r.levelname for r in caplog.records] == ["INFO"]
    assert done.groups[0].conflicts == group.conflicts
    assert done.deleted.deleted_relation_versions == 3 and done.deleted.deleted_decisions == 0
    assert run(g.relations.get("relation:x2")) is None
    survivor = run(g.relations.get("relation:x1"))
    assert survivor.properties == {"w": 1, "k": True, "only2": "y", "v": 2}
    assert (survivor.source_count, survivor.event_time) == (2, utc(2020))
    evidence = run(g.relations.evidence("relation:x1"))
    assert sorted((e.source_id, e.quote) for e in evidence.items) == [("s1", "one"), ("s2", "two")]
    assert [s.relation_id for s in run(g.decisions.get(dec.id)).steps] == ["relation:x1", "relation:x3"]
    again = run(g.maintenance.dedupe_relations())
    assert (again.groups, again.note) == ([], None)


def test_maintenance_skips_relations_a_contradiction_invalidated():
    g = employment_graph("mt", contradiction="supersede")
    acme, globex = (
        run(g.insert.facts({"relations": [works_at(c, year)]})).relations[0].id
        for c, year in (("acme", 2020), ("globex", 2021))
    )
    decay = run(g.maintenance.decay(now=_later(0), dry_run=False))
    assert list(decay.relations) == [globex]
    assert decay.updated_relations == 1
    assert run(g.maintenance.dedupe_relations()).groups == []
    plan = run(g.maintenance.prune(older_than=_later(0.0005), relation_types=["WORKS_AT"]))
    assert plan.relation_ids == [globex]
    run(g.maintenance.prune(older_than=_later(0.0005), relation_types=["WORKS_AT"], dry_run=False))
    assert [r.id for r in run(g.relations.list(include_invalidated=True)).items] == [acme]


def test_sync_cli_and_mcp_expose_maintenance(capsys):
    ns = unique_ns("mtx")
    sg = SyncSelfGraph(make_store(), namespace=ns)
    sg.entities.create("A", "T", id="t:a")
    try:
        assert sg.maintenance.decay(dry_run=True).entities["t:a"] == 0.5
    finally:
        sg.close()

    g = new_graph(namespace=ns)
    out = cli(g, ["maintenance", "prune", "--older-than", _later(0.0005).isoformat()], capsys)
    assert out["dry_run"] is True and out["entity_ids"] == ["t:a"]
    assert cli(g, ["maintenance", "dedupe-relations"], capsys)["groups"] == []
    assert cli(g, ["maintenance", "decay"], capsys)["dry_run"] is True
    assert cli(g, ["maintenance", "decay", "--half-life-days", "7", "--apply"], capsys)["updated_entities"] == 1

    with mcp_session("mtx") as srv:
        run(srv.create_entity("A", "T", id="t:a"))
        assert run(srv.maintenance_prune(older_than=_later(0.0005).isoformat()))["entity_ids"] == ["t:a"]
        assert run(srv.maintenance_dedupe_relations())["dry_run"] is True
        assert run(srv.maintenance_decay(dry_run=True))["entities"]["t:a"] > 0
        with pytest.raises(ValidationError):
            run(srv.maintenance_prune(older_than="not a date"))


def test_prune_notes_when_nothing_is_scored(capsys):
    g = fresh_graph("mt")
    t_entities(g, "a")
    plan = run(g.maintenance.prune(min_relevance=0.5))
    assert (
        plan.entity_ids == []
        and plan.note == "no items have a relevance score yet; run maintenance.decay(dry_run=False) first"
    )
    assert run(g.maintenance.prune(older_than=_later(0.0005))).note is None
    out = cli(g, ["maintenance", "prune", "--min-relevance", "0.5"], capsys)
    assert out["note"] == "no items have a relevance score yet; run maintenance decay --apply first"
    assert run(g.maintenance.decay(now=_later(0.0005))).dry_run
    run(g.maintenance.decay(dry_run=False))
    assert run(g.maintenance.prune(min_relevance=0.5)).note is None


def test_dedupe_relations_repoints_every_step_and_never_deletes_a_decision():
    g = fresh_graph("mt")
    t_entities(g, "a", "b", "c")
    for rid in ("relation:x1", "relation:x2", "relation:x3"):
        run(g.relations.create("t:a", "KNOWS", "t:b", id=rid))
    run(g.relations.create("t:b", "KNOWS", "t:c", id="relation:y1"))
    run(g.relations.create("t:b", "KNOWS", "t:c", id="relation:y2"))
    run(g.relations.update("relation:x3", set_properties={"v": 2}))
    run(g.relations.update("relation:x3", set_properties={"v": 3}))
    steps = {
        "decision:both": ["relation:x1", "relation:x2"],
        "decision:versions": ["relation:x3"],
        "decision:groups": ["relation:x3", "relation:y2", "relation:x2"],
    }
    for tid, ids in steps.items():
        run(g.decisions.create(tid, steps=ids, id=tid))
    done = run(g.maintenance.dedupe_relations(dry_run=False))
    assert done.deleted.deleted_decisions == 0
    assert done.deleted.deleted_relation_versions == 5
    got = {tid: [s.relation_id for s in run(g.decisions.get(tid)).steps] for tid in steps}
    assert got == {
        "decision:both": ["relation:x1", "relation:x1"],
        "decision:versions": ["relation:x1"],
        "decision:groups": ["relation:x1", "relation:y1", "relation:x1"],
    }


def test_dedupe_relations_keeps_a_step_on_a_retired_relation():
    g = employment_graph("mt", contradiction="supersede")
    old = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    run(g.relations.create("person:ann", "WORKS_AT", "company:globex", id="relation:g1"))
    run(g.relations.create("person:ann", "WORKS_AT", "company:globex", id="relation:g2", contradiction="off"))
    run(g.decisions.create("Move", steps=[old.id, "relation:g2"], id="decision:move"))
    done = run(g.maintenance.dedupe_relations(dry_run=False))
    assert [(p.survivor, p.duplicates) for p in done.groups] == [("relation:g1", ["relation:g2"])]
    assert done.deleted.deleted_decisions == 0
    assert [s.relation_id for s in run(g.decisions.get("decision:move")).steps] == [old.id, "relation:g1"]

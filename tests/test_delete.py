import itertools
from contextlib import suppress
from datetime import datetime, timedelta, timezone

import pytest
from helpers import AUTO_COMMIT, create_entities, cut_store_write, fresh_graph, new_graph, run, skip_on_generic

from selfgraph import NotFoundError
from selfgraph._serde import L_STEP, L_TRACE


def build(g):
    create_entities(g, "Person:Soham", "Company:HydraDB", "Company:Neo4j", "Feature:Temporal")
    r1 = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))
    r2 = run(g.relations.create("company:hydradb", "REQUIRES", "feature:temporal"))
    run(g.relations.update(r1.id, set_properties={"role": "CEO"}))
    pref = run(g.preferences.create("person:soham", "database", "company:hydradb"))
    dec = run(g.decisions.create("D", steps=[r1.id, r2.id], id="decision:d", actor_entity="person:soham"))
    return r1, r2, pref, dec


def test_relation_delete_removes_decision_steps():
    g = new_graph()
    r1, r2, pref, dec = build(g)
    run(g.relations.delete(r2.id))
    assert run(g.decisions.get(dec.id)) is None


def test_entity_delete_cascades():
    g = new_graph()
    r1, r2, pref, dec = build(g)
    dr = run(g.entities.delete("person:soham"))
    assert dr.deleted_entities == 1
    assert dr.deleted_relation_versions >= 2
    assert dr.deleted_preference_versions >= 1
    assert dr.deleted_decisions == 1

    assert run(g.entities.get("person:soham")) is None
    assert run(g.relations.get(r1.id)) is None
    assert run(g.preferences.get(pref.id)) is None
    assert run(g.relations.get(r2.id)) is not None
    assert run(g.decisions.get(dec.id)) is None


@skip_on_generic
def test_entity_delete_removes_profile():
    g = new_graph()
    r1, r2, pref, dec = build(g)
    run(g.entities.delete("person:soham"))
    rows = run(g.run_cypher("MATCH (p:Profile {id:'profile:person:soham'}) RETURN p.id AS id"))
    assert rows.rows == []


def test_entity_delete_clears_preference_about_entity():
    g = fresh_graph("about")
    create_entities(g, "Person:Soham", "Company:HydraDB", "Topic:Graphs")
    pref = run(
        g.preferences.create("person:soham", "database", "company:hydradb", about_entity="topic:graphs", strength=0.4)
    )
    dr = run(g.entities.delete("topic:graphs"))
    assert dr.deleted_preference_versions == 0
    current = run(g.preferences.get(pref.id))
    assert current.about_entity is None
    assert current.revision == 2 and current.strength == 0.4
    assert run(g.preferences.update(pref.id, strength=0.6)).about_entity is None


POOL = ("kind0:a", "kind1:b", "kind2:c")
SHAPES = {
    "distinct": (0, 1, 2),
    "subject_is_value": (0, 0, 1),
    "subject_is_about": (0, 1, 0),
    "value_is_about": (0, 1, 1),
    "no_about": (0, 1, None),
}
SUBSETS = ((0,), (1,), (2,), (0, 1), (0, 2), (1, 2), (0, 1, 2))
AUTHORED = 2


def _later():
    return datetime.now(timezone.utc) + timedelta(seconds=30)


def _pool_graph(shape):
    g = fresh_graph("pc")
    for i, eid in enumerate(POOL):
        run(g.entities.create(f"E{i}", f"Kind{i}", id=eid))
    run(g.entities.create("Keep", "Person", id="person:keep"))
    subject, value, about = shape
    pref = run(
        g.preferences.create(
            POOL[subject], "likes", POOL[value], about_entity=None if about is None else POOL[about], strength=0.2
        )
    )
    run(g.preferences.update(pref.id, strength=0.4))
    bystander = run(g.preferences.create("person:keep", "likes", "person:keep"))
    return g, pref.id, bystander.id


def _expected(shape, gone):
    subject, value, about = shape
    removed = subject in gone or value in gone
    count = AUTHORED if removed else 0
    return removed, count


def _check_state(g, pid, bystander, shape, gone, removed):
    assert run(g.preferences.get(bystander)) is not None
    assert len(run(g.preferences.versions(bystander))) == 1
    current = run(g.preferences.get(pid))
    if removed:
        assert current is None
        with pytest.raises(NotFoundError):
            run(g.preferences.versions(pid))
        return
    about = shape[2]
    dropped = about is not None and about in gone
    assert current.about_entity == (None if dropped or about is None else POOL[about])
    assert len(run(g.preferences.versions(pid))) == AUTHORED + dropped


def test_deleted_preference_versions_is_the_same_in_every_delete_order_and_in_prune():
    for name, shape in SHAPES.items():
        for gone in SUBSETS:
            removed, count = _expected(shape, gone)
            for order in itertools.permutations(gone):
                g, pid, bystander = _pool_graph(shape)
                total = [run(g.entities.delete(POOL[i])).deleted_preference_versions for i in order]
                assert sum(total) == count, (name, order)
                _check_state(g, pid, bystander, shape, gone, removed)
            g, pid, bystander = _pool_graph(shape)
            done = run(g.maintenance.prune(older_than=_later(), types=[f"Kind{i}" for i in gone], dry_run=False))
            assert done.entity_ids == sorted(POOL[i] for i in gone), (name, gone)
            assert done.deleted.deleted_preference_versions == count, (name, gone)
            _check_state(g, pid, bystander, shape, gone, removed)


def test_user_updates_are_counted_but_the_about_cleanup_is_not():
    g, pid, _ = _pool_graph(SHAPES["distinct"])
    assert run(g.entities.delete("kind2:c")).deleted_preference_versions == 0
    run(g.preferences.update(pid, strength=0.9))
    assert run(g.entities.delete("kind1:b")).deleted_preference_versions == AUTHORED + 1
    assert run(g.preferences.get(pid)) is None
    g, pid, _ = _pool_graph(SHAPES["distinct"])
    run(g.preferences.update(pid, clear=["about_entity"]))
    assert run(g.entities.delete("kind1:b")).deleted_preference_versions == AUTHORED + 1
    assert run(g.preferences.get(pid)) is None


def test_deleting_a_preference_does_not_count_the_about_cleanup_version():
    g, pid, _ = _pool_graph(SHAPES["distinct"])
    run(g.entities.delete("kind2:c"))
    assert len(run(g.preferences.versions(pid))) == AUTHORED + 1
    assert run(g.preferences.delete(pid)).deleted_preference_versions == AUTHORED
    assert run(g.preferences.get(pid)) is None


def decision_graph():
    g = fresh_graph("cut-delete")
    create_entities(g, "Org:Acme", "Org:Beta", "Org:Gamma", "Person:Bob")
    first = run(g.relations.create("org:acme", "OWNS", "org:beta"))
    second = run(g.relations.create("org:acme", "OWNS", "org:gamma"))
    run(g.decisions.create("Buy", id="decision:d1", steps=[first.id, second.id], actor_entity="person:bob"))
    return g, first


def delete_target(g, first, target):
    if target == "relation":
        return g.relations.delete(first.id)
    return g.entities.delete("org:beta")


def left_after(g):
    return {
        "decisions": [d.id for d in run(g.decisions.list()).items],
        "step_nodes": sorted(n["id"] for n in run(g.store.match_nodes(g.namespace, L_STEP))),
        "relations": sorted(r.id for r in run(g.relations.list()).items),
        "entities": sorted(e.id for e in run(g.entities.list()).items),
    }


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store keeps the writes before a cut")
@pytest.mark.parametrize("target", ["relation", "entity"])
def test_a_delete_cut_off_at_any_write_leaves_no_decision_behind_after_a_retry(monkeypatch, target):
    g, first = decision_graph()
    with cut_store_write(g, monkeypatch) as writes:
        run(delete_target(g, first, target))
    whole = left_after(g)
    assert whole["decisions"] == [] and whole["step_nodes"] == []
    for cut in range(len(writes)):
        g, first = decision_graph()
        with cut_store_write(g, monkeypatch, cut), pytest.raises(ConnectionError):
            run(delete_target(g, first, target))
        with suppress(NotFoundError):
            run(delete_target(g, first, target))
        assert left_after(g) == whole, f"cut at write {cut}: {writes[cut]}"


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store keeps the writes before a cut")
@pytest.mark.parametrize("target", ["relation", "entity"])
def test_a_retry_after_the_trace_node_is_gone_removes_its_steps_and_counts_the_decision(monkeypatch, target):
    g, first = decision_graph()
    trace_gone = []

    def cutting(real):
        async def wrapped(ns, label, *rest):
            if label == L_STEP and trace_gone:
                raise ConnectionError("connection lost")
            await real(ns, label, *rest)
            if label == L_TRACE:
                trace_gone.append(label)

        return wrapped

    with monkeypatch.context() as patch:
        patch.setattr(g.store, "delete_node", cutting(g.store.delete_node))
        patch.setattr(g.store, "delete_nodes", cutting(g.store.delete_nodes))
        with pytest.raises(ConnectionError):
            run(delete_target(g, first, target))
    assert run(g.decisions.get("decision:d1")) is None
    assert left_after(g)["step_nodes"] != []

    assert run(delete_target(g, first, target)).deleted_decisions == 1
    assert left_after(g)["step_nodes"] == []

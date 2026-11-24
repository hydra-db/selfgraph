import pytest
from helpers import create_entities, fresh_graph, new_graph, run, skip_on_generic

from selfgraph import ConflictError, NotFoundError, ValidationError, ids
from selfgraph._serde import L_ENTITY, L_STEP, L_TRACE


def seed(g):
    create_entities(g, "Company:HydraDB", "Company:Neo4j", "Feature:Temporal", "Team:Core")
    r1 = run(g.relations.create("company:hydradb", "REQUIRES", "feature:temporal"))
    r2 = run(g.relations.create("team:core", "SELECTED", "company:hydradb"))
    return r1, r2


@pytest.mark.parametrize("kind", ["relation", "preference", "decision", "profile"])
def test_id_helpers_address_inserted_facts_with_noncanonical_references(kind):
    g = new_graph()
    actor, target = " Person : Jane  Doe ", " Company : Acme "
    run(
        g.insert.facts(
            {
                "entities": [{"type": "Person", "name": "Jane Doe"}, {"type": "Company", "name": "Acme"}],
                "relations": [{"from_entity": actor, "type": "worksAt", "to_entity": target}],
                "preferences": [{"subject_entity": actor, "key": "employer", "value_entity": target}],
                "decisions": [{"actor_entity": actor, "title": "Pick employer"}],
            }
        )
    )
    getters = {
        "relation": lambda: g.relations.get(ids.relation_id(actor, "worksAt", target)),
        "preference": lambda: g.preferences.get(ids.preference_id(actor, "preference", "employer", target)),
        "decision": lambda: g.decisions.get(ids.decision_id(actor, "Pick employer")),
        "profile": lambda: g.store.get_node(g.namespace, "Profile", ids.profile_id(actor)),
    }
    assert run(getters[kind]()) is not None


def test_create_decision_with_steps():
    g = new_graph()
    r1, r2 = seed(g)
    dec = run(
        g.decisions.create(
            "Select the graph database",
            steps=[r1.id, r2.id],
            id="decision:db",
            actor_entity="team:core",
            outcome_entity="company:hydradb",
            alternative_entities=["company:neo4j"],
            rationale="needs temporal history",
        )
    )
    assert dec.id == "decision:db"
    assert dec.status == "completed"
    assert [s.order for s in dec.steps] == [0, 1]
    assert dec.steps[0].relation_id == r1.id
    assert dec.steps[0].from_entity == "company:hydradb"
    assert dec.steps[0].to_entity == "feature:temporal"
    assert dec.outcome_entity == "company:hydradb"
    assert dec.alternative_entities == ["company:neo4j"]


def test_update_in_place_keeps_steps():
    g = new_graph()
    r1, r2 = seed(g)
    dec = run(g.decisions.create("D", steps=[r1.id, r2.id], id="decision:d", actor_entity="team:core"))
    dec2 = run(g.decisions.update(dec.id, status="reversed", summary="changed"))
    assert dec2.status == "reversed"
    assert dec2.summary == "changed"
    assert len(dec2.steps) == 2
    assert dec2.created_at == dec.created_at


def test_step_shows_current_relation_version():
    g = new_graph()
    r1, r2 = seed(g)
    dec = run(g.decisions.create("D", steps=[r1.id], id="decision:d"))
    run(g.relations.update(r1.id, set_properties={"note": "x"}))
    got = run(g.decisions.get(dec.id))
    assert got.steps[0].relation_id == r1.id
    assert got.steps[0].from_entity == "company:hydradb"


@skip_on_generic
def test_walk_up_from_relation():
    g = new_graph()
    r1, r2 = seed(g)
    run(g.decisions.create("D", steps=[r1.id], id="decision:d"))
    rows = run(
        g.run_cypher(
            "MATCH (trace:DecisionTrace)-[:HAS_STEP]->(step:DecisionStep {relation_id:$rid}) RETURN trace.id AS id",
            {"rid": r1.id},
        )
    )
    assert [r["id"] for r in rows.rows] == ["decision:d"]


def test_conflict_notfound_validation():
    g = new_graph()
    r1, r2 = seed(g)
    run(g.decisions.create("D", steps=[r1.id], id="decision:d"))
    with pytest.raises(ConflictError):
        run(g.decisions.create("D2", steps=[r1.id], id="decision:d"))
    with pytest.raises(NotFoundError):
        run(g.decisions.update("decision:nope", status="active"))
    with pytest.raises(ValidationError):
        run(g.decisions.create("Bad", steps=["relation:ghost"], id="decision:bad"))
    with pytest.raises(ValidationError):
        run(g.decisions.create("Bad2", steps=[r1.id], id="decision:bad2", actor_entity="person:ghost"))


def test_list_filters():
    g = new_graph()
    r1, r2 = seed(g)
    run(g.decisions.create("A", steps=[r1.id], id="decision:a", actor_entity="team:core", status="active"))
    run(g.decisions.create("B", steps=[r2.id], id="decision:b", status="completed"))
    active = run(g.decisions.list(status="active"))
    assert [d.id for d in active.items] == ["decision:a"]
    byactor = run(g.decisions.list(actor_entity="team:core"))
    assert [d.id for d in byactor.items] == ["decision:a"]


def test_delete_trace_keeps_relations():
    g = new_graph()
    r1, r2 = seed(g)
    dec = run(g.decisions.create("D", steps=[r1.id, r2.id], id="decision:d"))
    dr = run(g.decisions.delete(dec.id))
    assert dr.deleted_decisions == 1
    assert run(g.decisions.get(dec.id)) is None
    assert run(g.relations.get(r1.id)) is not None


def trace_links(g, tid):
    made = run(g.store.match_edges(g.namespace, from_label=L_ENTITY, to_label=L_TRACE, to_in=[tid]))
    out = run(g.store.match_edges(g.namespace, from_label=L_TRACE, to_label=L_ENTITY, from_in=[tid]))
    ends = run(g.store.match_edges(g.namespace, from_label=L_STEP, to_label=L_ENTITY, from_in=[ids.step_id(tid, 0)]))
    return sorted((e["type"], e["from_id"], e["to_id"]) for e in made + out + ends)


@pytest.mark.parametrize(
    ("with_step", "lost", "extra"),
    [
        (False, [(L_TRACE, "MADE_DECISION"), (L_TRACE, "RESULTED_IN"), (L_TRACE, "CONSIDERED")], []),
        (True, [(L_STEP, "FROM"), (L_STEP, "TO")], [("CONSIDERED", "company:beta"), ("CONSIDERED", "person:ann")]),
    ],
)
def test_reinserting_a_decision_repairs_links_a_partial_write_left_wrong(with_step, lost, extra):
    g = fresh_graph("relink")
    create_entities(g, "Person:Ann", "Company:Acme", "Company:Beta", "Team:X", "Team:Y")
    rel = run(g.relations.create("team:x", "SELECTED", "team:y"))
    decision = {
        "id": "decision:pick",
        "title": "Pick a vendor",
        "steps": [rel.id] if with_step else [],
        "actor_entity": "person:ann",
        "outcome_entity": "company:acme",
        "alternative_entities": ["company:beta"],
    }
    run(g.insert.facts({"decisions": [decision]}))
    whole = trace_links(g, "decision:pick")
    assert len(whole) == (5 if with_step else 3)
    for label, rtype in lost:
        node = ids.step_id("decision:pick", 0) if label == L_STEP else "decision:pick"
        run(g.store.delete_edges_touching_by_type(g.namespace, label, node, rtype))
    if extra:
        rows = [(rtype, "decision:pick", to, {"ns": g.namespace}) for rtype, to in extra]
        run(g.store.create_edges(g.namespace, L_TRACE, L_ENTITY, rows))
    assert trace_links(g, "decision:pick") != whole
    run(g.insert.facts({"decisions": [decision]}))
    assert trace_links(g, "decision:pick") == whole
    repaired = run(g.decisions.get("decision:pick")).updated_at
    run(g.insert.facts({"decisions": [decision]}))
    assert trace_links(g, "decision:pick") == whole
    assert run(g.decisions.get("decision:pick")).updated_at == repaired


def test_decision_steps_default_to_empty():
    g = fresh_graph("nosteps")
    run(g.insert.facts({"decisions": [{"title": "No steps", "id": "decision:none"}]}))
    assert run(g.decisions.get("decision:none")).steps == []
    assert run(g.decisions.create("Also none")).steps == []


def test_update_clears_named_fields_and_unlinks_cleared_references():
    g = fresh_graph("clr")
    create_entities(g, "Person:Ann", "Company:Acme", "Company:Beta", "Team:X", "Team:Y")
    rel = run(g.relations.create("team:x", "SELECTED", "team:y"))
    dec = run(
        g.decisions.create(
            "Pick a vendor",
            steps=[rel.id],
            actor_entity="person:ann",
            outcome_entity="company:acme",
            alternative_entities=["company:beta"],
            summary="s",
            rationale="r",
        )
    )
    with pytest.raises(ValidationError, match=r"^unknown option 'titel' for decisions.update; did you mean 'title'\?$"):
        run(g.decisions.update(dec.id, titel="t"))
    with pytest.raises(ValidationError, match="cannot clear 'title'"):
        run(g.decisions.update(dec.id, clear=["title"]))
    out = run(g.decisions.update(dec.id, clear=["summary"], rationale=None, event_time="2024-03-01T00:00:00Z"))
    assert (out.summary, out.rationale, out.title) == (None, None, "Pick a vendor")
    assert out.event_time.isoformat() == "2024-03-01T00:00:00+00:00"
    clear = ["actor_entity", "outcome_entity", "alternative_entities", "steps"]
    out = run(g.decisions.update(dec.id, clear=clear))
    assert (out.actor_entity, out.outcome_entity, out.alternative_entities, out.steps) == (None, None, [], [])
    assert run(g.decisions.list(actor_entity="person:ann")).items == []
    for eid in ("person:ann", "company:acme", "company:beta", "team:x"):
        assert run(g.entities.delete(eid)).deleted_decisions == 0
    assert run(g.decisions.get(dec.id)) is not None
    with pytest.raises(ValidationError, match="decision status"):
        run(g.decisions.list(status="zzz"))
    with pytest.raises(ValidationError, match="preference stance"):
        run(g.preferences.list(stance="zzz"))


def test_insert_restating_a_decision_keeps_what_it_leaves_out():
    g = fresh_graph("restate")
    r1, r2 = seed(g)
    title = {"title": "Select the graph database", "actor_entity": "team:core"}
    full = {
        **title,
        "steps": [r1.id, r2.id],
        "summary": "embedded wins",
        "rationale": "needs temporal history",
        "outcome_entity": "company:hydradb",
        "alternative_entities": ["company:neo4j"],
        "status": "active",
        "event_time": "2024-03-01T00:00:00Z",
    }
    run(g.insert.facts({"decisions": [full]}, source_id="design"))
    [kept] = run(g.insert.facts({"decisions": [title]}, source_id="notes")).decisions
    assert kept == run(g.decisions.get(kept.id))
    assert (kept.summary, kept.rationale, kept.outcome_entity, kept.alternative_entities, kept.status) == (
        "embedded wins",
        "needs temporal history",
        "company:hydradb",
        ["company:neo4j"],
        "active",
    )
    assert [s.relation_id for s in kept.steps] == [r1.id, r2.id]
    assert kept.event_time.isoformat() == "2024-03-01T00:00:00+00:00"
    given = {"rationale": "no server", "outcome_entity": "company:neo4j", "status": "reversed", "steps": [r2.id]}
    [changed] = run(g.insert.facts({"decisions": [{**title, **given}]})).decisions
    assert (changed.summary, changed.rationale, changed.outcome_entity, changed.status) == (
        "embedded wins",
        "no server",
        "company:neo4j",
        "reversed",
    )
    assert [s.relation_id for s in changed.steps] == [r2.id]
    [dated] = run(g.insert.facts({"decisions": [title]}, event_time="2025-01-01T00:00:00Z")).decisions
    assert dated.event_time.isoformat() == "2025-01-01T00:00:00+00:00"
    assert run(g.insert.facts({"decisions": [{"title": "Fresh"}]})).decisions[0].status == "completed"


@pytest.mark.parametrize("step_first", [False, True])
def test_decision_ids_cannot_overwrite_steps_in_either_creation_order(step_first):
    g = new_graph()
    rel, _ = seed(g)

    def with_step():
        return run(g.decisions.create("With a step", id="decision:first", steps=[rel.id]))

    def with_old_step_id():
        return run(g.decisions.create("Independent decision", id="decision:first:step:0"))

    if step_first:
        with_step()
        with_old_step_id()
    else:
        with_old_step_id()
        with_step()
    assert run(g.decisions.get("decision:first:step:0")).title == "Independent decision"
    assert [s.relation_id for s in run(g.decisions.get("decision:first")).steps] == [rel.id]
    run(g.decisions.delete("decision:first:step:0"))
    assert [s.relation_id for s in run(g.decisions.get("decision:first")).steps] == [rel.id]
    assert run(g.relations.delete(rel.id)).deleted_decisions == 1
    assert run(g.decisions.get("decision:first")) is None


@pytest.mark.parametrize("step_first", [False, True])
def test_internal_step_prefix_is_reserved_in_either_creation_order(step_first):
    g = new_graph()
    rel, _ = seed(g)

    def with_step():
        run(g.decisions.create("With a step", id="decision:first", steps=[rel.id]))

    if step_first:
        with_step()
    with pytest.raises(ValidationError, match="reserved"):
        run(g.entities.create("Intruder", "Thing", id="decisionstep:decision:first:step:0"))
    with pytest.raises(ValidationError, match="must start"):
        run(g.decisions.create("Intruder", id="decisionstep:decision:first:step:0"))
    if not step_first:
        with_step()
    assert [s.relation_id for s in run(g.decisions.get("decision:first")).steps] == [rel.id]


def test_step_ids_round_trip():
    from selfgraph import ids

    for tid in ("decision:first", "decision:first:step:0", "decision:日本語"):
        for order in (0, 1, 99):
            sid = ids.step_id(tid, order)
            assert sid == f"decisionstep:{tid}:step:{order}"
            assert ids.trace_of_step(sid) == tid


def test_listing_decisions_keeps_every_step_when_a_page_holds_more_than_a_thousand():
    g = fresh_graph("many-steps")
    run(g.insert.facts({"entities": [{"type": "Person", "name": "A"}, {"type": "Person", "name": "B"}]}))
    rel = run(g.relations.create("person:a", "KNOWS", "person:b"))
    for i in range(3):
        run(g.decisions.create(f"D{i}", steps=[rel.id] * 400, id=f"decision:d{i}"))
    traces = run(g.decisions.list(limit=10)).items
    assert [[s.order for s in t.steps] for t in traces] == [list(range(400))] * 3

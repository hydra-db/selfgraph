import pytest
from helpers import new_graph, run, skip_on_generic

from selfgraph import ConflictError, NotFoundError, ValidationError


def seed(g):
    run(g.entities.create("HydraDB", "Company", id="company:hydradb"))
    run(g.entities.create("Neo4j", "Company", id="company:neo4j"))
    run(g.entities.create("Temporal History", "Feature", id="feature:temporal"))
    run(g.entities.create("Core Team", "Team", id="team:core"))
    r1 = run(g.relations.create("company:hydradb", "REQUIRES", "feature:temporal"))
    r2 = run(g.relations.create("team:core", "SELECTED", "company:hydradb"))
    return r1, r2


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
        run(g.decisions.update("nope", status="active"))
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


def test_decision_steps_are_required():
    g = new_graph()
    with pytest.raises(ValidationError):
        run(g.insert.ontology({"decisions": [{"title": "No steps"}]}))

from helpers import create_entities, fresh_graph, new_graph, run, skip_on_generic


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

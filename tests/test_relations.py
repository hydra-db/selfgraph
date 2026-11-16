import pytest
from helpers import create_entities, new_graph, run, utc

from selfgraph import ConflictError, NotFoundError


def seed(g):
    create_entities(g, "Person:Soham", "Company:HydraDB")


def test_create_and_versions():
    g = new_graph()
    seed(g)
    r = run(
        g.relations.create(
            "person:soham", "WORKS_AT", "company:hydradb", properties={"role": "Founder"}, event_time=utc(2026, 1, 10)
        )
    )
    assert r.revision == 1 and r.is_current
    assert r.from_entity == "person:soham" and r.to_entity == "company:hydradb"
    assert r.type == "WORKS_AT"
    assert r.event_time == utc(2026, 1, 10)

    r2 = run(g.relations.update(r.id, set_properties={"role": "CEO"}, event_time=utc(2026, 6, 1)))
    assert r2.revision == 2 and r2.is_current
    assert r2.properties == {"role": "CEO"}

    current = run(g.relations.get(r.id))
    assert current.revision == 2

    history = run(g.relations.versions(r.id))
    assert [v.revision for v in history] == [2, 1]
    assert history[-1].is_current is False
    oldest_first = run(g.relations.versions(r.id, newest_first=False))
    assert [v.revision for v in oldest_first] == [1, 2]


def test_relation_versions_distinguish_json_booleans_from_numbers():
    g = new_graph()
    seed(g)
    r = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", properties={"flags": [1]}))

    run(g.relations.update(r.id, set_properties={"flags": [1.0]}))
    run(g.relations.update(r.id, set_properties={"flags": [True]}))
    run(g.relations.update(r.id, set_properties={"flags": [True]}))
    latest, first = run(g.relations.versions(r.id))
    assert latest.revision == 2 and latest.properties["flags"][0] is True
    assert type(first.properties["flags"][0]) is int


def test_remove_properties_in_update():
    g = new_graph()
    seed(g)
    r = run(
        g.relations.create(
            "person:soham", "WORKS_AT", "company:hydradb", properties={"role": "Founder", "team": "core"}
        )
    )
    r2 = run(g.relations.update(r.id, remove_properties=["team"]))
    assert r2.properties == {"role": "Founder"}


def test_create_conflict_and_update_of_a_missing_relation():
    g = new_graph()
    seed(g)
    run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", id="relation:x"))
    with pytest.raises(ConflictError):
        run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", id="relation:x"))
    with pytest.raises(NotFoundError):
        run(g.relations.update("relation:nope", set_properties={"a": 1}))


def test_list_filters():
    g = new_graph()
    seed(g)
    create_entities(g, "Company:Neo4j")
    run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))
    run(g.relations.create("person:soham", "LIKES", "company:neo4j"))

    by_type = run(g.relations.list(type="WORKS_AT"))
    assert len(by_type.items) == 1 and by_type.items[0].type == "WORKS_AT"

    by_to = run(g.relations.list(to_entity="company:neo4j"))
    assert len(by_to.items) == 1 and by_to.items[0].to_entity == "company:neo4j"

    by_from = run(g.relations.list(from_entity="person:soham"))
    assert len(by_from.items) == 2


def test_multiple_relations_same_endpoints():
    g = new_graph()
    seed(g)
    r1 = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))
    r2 = run(g.relations.create("person:soham", "FOUNDED", "company:hydradb"))
    assert r1.id != r2.id
    both = run(g.relations.list(from_entity="person:soham"))
    assert {x.type for x in both.items} == {"WORKS_AT", "FOUNDED"}


def test_whole_number_floats_are_stored_and_read_as_ints_like_typescript():
    g = new_graph()
    create_entities(g, "Person:Ann", "Company:Acme")
    props = {"weight": 2.0, "ratio": 0.5, "zero": -0.0, "big": 1e16, "nested": {"level": 3.0, "list": [1.0, 1.5]}}
    created = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", properties=props))
    expected = {"weight": 2, "ratio": 0.5, "zero": -0.0, "big": 1e16, "nested": {"level": 3, "list": [1, 1.5]}}
    for rel in (created, run(g.relations.get(created.id))):
        assert rel.properties == expected
        assert type(rel.properties["weight"]) is int and type(rel.properties["nested"]["list"][0]) is int
        assert type(rel.properties["zero"]) is float and type(rel.properties["big"]) is float
    assert "weight=2," in run(g.retrieve("Ann")).context
    assert run(g.relations.update(created.id, set_properties={"weight": 2})).revision == created.revision
    facts = {
        "entities": [{"type": "Person", "name": "Bo", "properties": {"age": 30.0}}],
        "preferences": [
            {
                "subject_entity": "person:ann",
                "key": "employer",
                "value_entity": "company:acme",
                "properties": {"n": 1.0},
            }
        ],
    }
    run(g.insert.facts(facts))
    assert type(run(g.entities.get("person:bo")).properties["age"]) is int
    assert type(run(g.preferences.list("person:ann")).items[0].properties["n"]) is int

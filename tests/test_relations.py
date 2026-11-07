from datetime import datetime, timezone

import pytest
from helpers import new_graph, run

from selfgraph import ConflictError, NotFoundError, ValidationError


def _dt(y, m, d):
    return datetime(y, m, d, tzinfo=timezone.utc)


def seed(g):
    run(g.entities.create("Soham", "Person", id="person:soham"))
    run(g.entities.create("HydraDB", "Company", id="company:hydradb"))


def test_create_and_versions():
    g = new_graph()
    seed(g)
    r = run(
        g.relations.create(
            "person:soham", "WORKS_AT", "company:hydradb", properties={"role": "Founder"}, event_time=_dt(2026, 1, 10)
        )
    )
    assert r.revision == 1 and r.is_current
    assert r.from_entity == "person:soham" and r.to_entity == "company:hydradb"
    assert r.type == "WORKS_AT"
    assert r.event_time == _dt(2026, 1, 10)

    r2 = run(g.relations.update(r.id, set_properties={"role": "CEO"}, event_time=_dt(2026, 6, 1)))
    assert r2.revision == 2 and r2.is_current
    assert r2.properties == {"role": "CEO"}

    current = run(g.relations.get(r.id))
    assert current.revision == 2

    history = run(g.relations.versions(r.id))
    assert [v.revision for v in history] == [2, 1]
    assert history[-1].is_current is False
    oldest_first = run(g.relations.versions(r.id, newest_first=False))
    assert [v.revision for v in oldest_first] == [1, 2]


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


def test_create_conflict_and_missing_endpoint():
    g = new_graph()
    seed(g)
    run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", id="relation:x"))
    with pytest.raises(ConflictError):
        run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", id="relation:x"))
    with pytest.raises(ValidationError):
        run(g.relations.create("person:ghost", "WORKS_AT", "company:hydradb"))


def test_update_unknown_raises():
    g = new_graph()
    with pytest.raises(NotFoundError):
        run(g.relations.update("nope", set_properties={"a": 1}))


def test_list_filters():
    g = new_graph()
    seed(g)
    run(g.entities.create("Neo4j", "Company", id="company:neo4j"))
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


def test_non_json_property_rejected_on_create():
    g = new_graph()
    seed(g)
    with pytest.raises(ValidationError):
        run(g.relations.create("person:soham", "R", "company:hydradb", properties={"joined": _dt(2026, 1, 1)}))

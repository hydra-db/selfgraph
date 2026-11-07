import pytest
from helpers import new_graph, run

from selfgraph import Ontology, ValidationError


def test_insert_ontology_dict():
    g = new_graph()
    res = run(
        g.insert.ontology(
            {
                "entities": [
                    {"id": "person:soham", "type": "Person", "name": "Soham"},
                    {"id": "company:hydradb", "type": "Company", "name": "HydraDB"},
                ],
                "relations": [
                    {
                        "id": "relation:employment",
                        "from_entity": "person:soham",
                        "type": "WORKS_AT",
                        "to_entity": "company:hydradb",
                        "properties": {"role": "Founder"},
                    }
                ],
            },
            source_id="meeting-42",
        )
    )
    assert len(res.entities) == 2
    assert len(res.relations) == 1
    assert res.source_id == "meeting-42"
    assert res.source_version is not None
    rel = res.relations[0]
    assert rel.evidence and rel.evidence[0].source_id == "meeting-42"


def test_insert_is_upsert_idempotent():
    g = new_graph()
    payload = {
        "entities": [
            {"id": "person:soham", "type": "Person", "name": "Soham"},
            {"id": "company:hydradb", "type": "Company", "name": "HydraDB"},
        ],
        "relations": [
            {
                "id": "relation:1",
                "from_entity": "person:soham",
                "type": "WORKS_AT",
                "to_entity": "company:hydradb",
                "properties": {"role": "Founder"},
            }
        ],
    }
    run(g.insert.ontology(payload))
    run(g.insert.ontology(payload))
    assert len(run(g.relations.versions("relation:1"))) == 1
    page = run(g.entities.list())
    assert len([e for e in page.items if e.id in ("person:soham", "company:hydradb")]) == 2


def test_insert_changed_properties_creates_version():
    g = new_graph()
    run(
        g.insert.ontology(
            {
                "entities": [{"id": "t:a", "type": "T", "name": "A"}, {"id": "t:b", "type": "T", "name": "B"}],
                "relations": [
                    {"id": "relation:1", "from_entity": "t:a", "type": "R", "to_entity": "t:b", "properties": {"k": 1}}
                ],
            }
        )
    )
    run(
        g.insert.ontology(
            {
                "relations": [
                    {"id": "relation:1", "from_entity": "t:a", "type": "R", "to_entity": "t:b", "properties": {"k": 2}}
                ],
            }
        )
    )
    versions = run(g.relations.versions("relation:1"))
    assert [v.revision for v in versions] == [2, 1]
    assert run(g.relations.get("relation:1")).properties == {"k": 2}


def test_entity_merge_rules():
    g = new_graph()
    run(
        g.insert.ontology(
            {
                "entities": [
                    {"id": "person:e", "type": "Person", "name": "E", "aliases": ["x"], "properties": {"a": 1}},
                ]
            }
        )
    )
    run(
        g.insert.ontology(
            {
                "entities": [
                    {"id": "person:e", "type": "Person", "name": "E", "aliases": ["y"], "properties": {"a": 2, "b": 3}},
                ]
            }
        )
    )
    e = run(g.entities.get("person:e"))
    assert set(e.aliases) == {"x", "y"}
    assert e.properties == {"a": 2, "b": 3}


def test_insert_derives_missing_ids():
    g = new_graph()
    res = run(g.insert.ontology({"entities": [{"type": "Person", "name": "Soham"}]}))
    assert res.entities[0].id == "person:soham"


def test_insert_ontology_object_and_event_time_default():
    g = new_graph()
    run(g.entities.create("A", "T", id="t:a"))
    run(g.entities.create("B", "T", id="t:b"))
    ont = Ontology.model_validate({"relations": [{"from_entity": "t:a", "type": "R", "to_entity": "t:b"}]})
    # text-style default event_time would apply via insert.text; ontology insert has none
    res = run(g.insert.ontology(ont))
    assert res.relations[0].event_time is None


def test_nan_property_is_rejected():
    g = new_graph()
    run(g.entities.create("A", "T", id="t:a"))
    run(g.entities.create("B", "T", id="t:b"))
    with pytest.raises(ValidationError):
        run(
            g.insert.ontology(
                {
                    "relations": [
                        {"from_entity": "t:a", "type": "R", "to_entity": "t:b", "properties": {"score": float("nan")}}
                    ],
                }
            )
        )


def test_invalid_ontology_raises_selfgraph_error():
    g = new_graph()
    with pytest.raises(ValidationError):
        run(g.insert.ontology({"entities": [{"type": "Person"}]}))


def test_upsert_identical_entity_keeps_updated_at():
    g = new_graph()
    payload = {"entities": [{"id": "person:e", "type": "Person", "name": "E", "properties": {"a": 1}}]}
    run(g.insert.ontology(payload))
    first = run(g.entities.get("person:e"))
    run(g.insert.ontology(payload))
    second = run(g.entities.get("person:e"))
    assert first.updated_at == second.updated_at


def test_relation_endpoints_are_immutable():
    g = new_graph()
    for i in ("t:a", "t:b", "t:c"):
        run(g.entities.create(i[-1].upper(), "T", id=i))
    run(g.insert.ontology({"relations": [{"id": "relation:1", "from_entity": "t:a", "type": "R", "to_entity": "t:b"}]}))
    with pytest.raises(ValidationError):
        run(
            g.insert.ontology(
                {"relations": [{"id": "relation:1", "from_entity": "t:a", "type": "R", "to_entity": "t:c"}]}
            )
        )

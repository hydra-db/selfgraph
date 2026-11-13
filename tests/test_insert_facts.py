import pytest
from helpers import fresh_graph, new_graph, run, t_entities

from selfgraph import Extraction, ValidationError

PAYLOAD = {
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
}


def test_insert_facts_dict():
    g = new_graph()
    res = run(g.insert.facts(PAYLOAD, source_id="meeting-42"))
    assert len(res.entities) == 2
    assert len(res.relations) == 1
    assert res.source_id == "meeting-42"
    assert res.source_version is not None
    rel = res.relations[0]
    assert rel.source_count == 1
    assert [e.source_id for e in run(g.relations.evidence(rel.id)).items] == ["meeting-42"]


def test_insert_is_upsert_idempotent_and_keeps_updated_at():
    g = new_graph()
    run(g.insert.facts(PAYLOAD))
    first = run(g.entities.get("person:soham"))
    run(g.insert.facts(PAYLOAD))
    assert len(run(g.relations.versions("relation:employment"))) == 1
    assert run(g.entities.get("person:soham")).updated_at == first.updated_at
    page = run(g.entities.list())
    assert len([e for e in page.items if e.id in ("person:soham", "company:hydradb")]) == 2


def test_insert_changed_properties_creates_version():
    g = new_graph()
    run(
        g.insert.facts(
            {
                "entities": [{"id": "t:a", "type": "T", "name": "A"}, {"id": "t:b", "type": "T", "name": "B"}],
                "relations": [
                    {"id": "relation:1", "from_entity": "t:a", "type": "R", "to_entity": "t:b", "properties": {"k": 1}}
                ],
            }
        )
    )
    run(
        g.insert.facts(
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
        g.insert.facts(
            {
                "entities": [
                    {"id": "person:e", "type": "Person", "name": "E", "aliases": ["x"], "properties": {"a": 1}},
                ]
            }
        )
    )
    run(
        g.insert.facts(
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


def test_insert_facts_object_derives_ids_and_leaves_event_time_unset():
    g = new_graph()
    facts = Extraction.model_validate(
        {
            "entities": [{"type": "T", "name": "A"}, {"type": "T", "name": "B"}],
            "relations": [{"from_entity": "t:a", "type": "R", "to_entity": "t:b"}],
        }
    )
    res = run(g.insert.facts(facts))
    assert [e.id for e in res.entities] == ["t:a", "t:b"]
    assert res.relations[0].event_time is None


def test_nan_property_and_invalid_facts_are_rejected():
    g = new_graph()
    t_entities(g, "a", "b")
    with pytest.raises(ValidationError):
        run(g.insert.facts({"entities": [{"type": "Person"}]}))
    with pytest.raises(ValidationError):
        run(
            g.insert.facts(
                {
                    "relations": [
                        {"from_entity": "t:a", "type": "R", "to_entity": "t:b", "properties": {"score": float("nan")}}
                    ],
                }
            )
        )


def test_relation_endpoints_are_immutable():
    g = new_graph()
    t_entities(g, "a", "b", "c")
    run(g.insert.facts({"relations": [{"id": "relation:1", "from_entity": "t:a", "type": "R", "to_entity": "t:b"}]}))
    with pytest.raises(ValidationError):
        run(
            g.insert.facts({"relations": [{"id": "relation:1", "from_entity": "t:a", "type": "R", "to_entity": "t:c"}]})
        )


def test_missing_relation_endpoints_are_named():
    g = fresh_graph("q4")
    run(g.insert.facts({"entities": [{"type": "T", "name": "A"}]}))
    with pytest.raises(ValidationError, match=r"^relation endpoint not found \(to='t:zz'\);"):
        run(g.insert.facts({"relations": [{"from_entity": "t:a", "type": "R", "to_entity": "t:zz"}]}))
    with pytest.raises(ValidationError, match=r"^relation endpoints not found \(from='t:y', to='t:zz'\);"):
        run(g.insert.facts({"relations": [{"from_entity": "t:y", "type": "R", "to_entity": "t:zz"}]}))
    with pytest.raises(ValidationError, match=r"^relation endpoint not found \(from='t:y'\);"):
        run(g.relations.create("t:y", "R", "t:a"))


def test_insert_facts_event_time_accepts_iso_text():
    g = new_graph()
    res = run(g.insert.facts(PAYLOAD, event_time="2024-03-01T00:00:00Z"))
    assert res.relations[0].event_time.isoformat() == "2024-03-01T00:00:00+00:00"
    with pytest.raises(ValidationError):
        run(g.insert.facts(PAYLOAD, event_time="soon"))
    run(g.close())

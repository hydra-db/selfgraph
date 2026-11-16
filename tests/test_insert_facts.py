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


def test_nested_property_type_changes_on_reinsert_and_update():
    g = new_graph()

    def facts(value):
        props = {"flags": [{"active": value}]}
        return {
            "entities": [
                {"name": "Ann", "type": "Person", "properties": props},
                {"name": "Acme", "type": "Company"},
            ],
            "relations": [
                {"from_entity": "person:ann", "type": "WORKS_AT", "to_entity": "company:acme", "properties": props}
            ],
            "preferences": [
                {"subject_entity": "person:ann", "key": "employer", "value_entity": "company:acme", "properties": props}
            ],
        }

    initial = run(g.insert.facts(facts(0)))
    entity, relation, pref = initial.entities[0], initial.relations[0], initial.preferences[0]
    records = [(g.entities, entity.id), (g.relations, relation.id), (g.preferences, pref.id)]

    run(g.insert.facts(facts(False)))
    for resource, record_id in records:
        assert run(resource.get(record_id)).properties["flags"][0]["active"] is False

    props = {"flags": [{"active": 0}]}
    run(g.entities.update(entity.id, properties=props))
    run(g.relations.update(relation.id, set_properties=props))
    run(g.preferences.update(pref.id, properties=props))
    for resource, record_id in records:
        value = run(resource.get(record_id)).properties["flags"][0]["active"]
        assert type(value) is int and value == 0


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


def test_none_facts_are_rejected_like_other_non_objects():
    g = new_graph()
    for value in (None, [], 5):
        with pytest.raises(ValidationError, match=r"^invalid facts: expected object$"):
            run(g.insert.facts(value))


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


ANN_ACME = [{"type": "Person", "name": "Ann"}, {"type": "Company", "name": "Acme"}]
JOINED = {"from_entity": "person:ann", "type": "JOINED", "to_entity": "company:acme"}
LIKES = {"subject_entity": "person:ann", "key": "employer", "value_entity": "company:acme"}


@pytest.mark.parametrize(
    ("facts", "message"),
    [
        ({"relations": [{**JOINED, "event_time": "2021"}]}, 'relations[0].event_time: invalid ISO 8601 string: "2021"'),
        ({"relations": [{**JOINED, "event_time": 2021}]}, "relations[0].event_time: invalid input"),
        ({"relations": [{**JOINED, "event_time": True}]}, "relations[0].event_time: invalid input"),
        (
            {"preferences": [{**LIKES, "event_time": "2021"}]},
            'preferences[0].event_time: invalid ISO 8601 string: "2021"',
        ),
        ({"decisions": [{"title": "t", "event_time": 1700000000}]}, "decisions[0].event_time: invalid input"),
        (
            {"decisions": [{"title": "t", "event_time": "soon"}]},
            'decisions[0].event_time: invalid ISO 8601 string: "soon"',
        ),
        ({"preferences": [{**LIKES, "strength": "0.9"}]}, "preferences[0].strength: expected number"),
        ({"preferences": [{**LIKES, "strength": True}]}, "preferences[0].strength: expected number"),
        (
            {"relations": [{**JOINED, "evidence": [{"source_id": "s", "confidence": "0.5"}]}]},
            "relations[0].evidence[0].confidence: expected number",
        ),
        (
            {"relations": [{**JOINED, "evidence": [{"source_id": "s", "confidence": False}]}]},
            "relations[0].evidence[0].confidence: expected number",
        ),
    ],
)
def test_facts_reject_times_and_numbers_that_parse_time_and_typescript_reject(facts, message):
    g = fresh_graph("strict_facts")
    run(g.insert.facts({"entities": ANN_ACME}))
    with pytest.raises(ValidationError) as err:
        run(g.insert.facts(facts))
    assert str(err.value) == f"invalid facts: {message}"
    assert run(g.relations.list()).items == []
    run(g.close())


def test_facts_times_accept_iso_text_and_strengths_accept_integers():
    g = fresh_graph("strict_facts")
    res = run(
        g.insert.facts(
            {
                "entities": ANN_ACME,
                "relations": [
                    {**JOINED, "event_time": "2021-03-04", "evidence": [{"source_id": "s", "confidence": 1}]}
                ],
                "preferences": [{**LIKES, "strength": 1, "event_time": "2021-03-04T10:15:00Z"}],
                "decisions": [{"title": "t", "event_time": "2021-03-04T10:15:00+05:30"}],
            }
        )
    )
    assert res.relations[0].event_time.isoformat() == "2021-03-04T00:00:00+00:00"
    assert (res.preferences[0].strength, res.preferences[0].event_time.isoformat()) == (
        1.0,
        "2021-03-04T10:15:00+00:00",
    )
    assert res.decisions[0].event_time.isoformat() == "2021-03-04T04:45:00+00:00"
    run(g.close())


def test_insert_facts_event_time_accepts_iso_text():
    g = new_graph()
    res = run(g.insert.facts(PAYLOAD, event_time="2024-03-01T00:00:00Z"))
    assert res.relations[0].event_time.isoformat() == "2024-03-01T00:00:00+00:00"
    with pytest.raises(ValidationError):
        run(g.insert.facts(PAYLOAD, event_time="soon"))
    run(g.close())

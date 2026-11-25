import pytest
from helpers import KUZU, fresh_graph, new_graph, run, t_entities

from selfgraph import Extraction, ValidationError, entity_id, preference_id, relation_id

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


def test_484_plus_and_sharp_names_stay_separate_entities():
    g = new_graph()
    langs = ["C++", "C#", "C", "F#"]
    run(
        g.insert.facts(
            {
                "entities": [{"type": "Person", "name": "Ann"}, {"type": "Person", "name": "Bob"}]
                + [{"type": "Language", "name": n} for n in langs],
                "relations": [
                    {"from_entity": "person:ann", "type": "USES", "to_entity": entity_id("Language", "C++")},
                    {"from_entity": "person:bob", "type": "USES", "to_entity": entity_id("Language", "C#")},
                ],
            }
        )
    )
    found = {e.id: (e.name, e.aliases) for e in run(g.entities.list(type="Language")).items}
    assert found == {
        "language:c-plus-plus": ("C++", []),
        "language:c-sharp": ("C#", []),
        "language:c": ("C", []),
        "language:f-sharp": ("F#", []),
    }
    used = {r.from_entity: r.to_entity for r in run(g.relations.list(type="USES")).items}
    assert used == {"person:ann": "language:c-plus-plus", "person:bob": "language:c-sharp"}


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


def test_insert_facts_event_time_accepts_iso_text():
    g = new_graph()
    res = run(g.insert.facts(PAYLOAD, event_time="2024-03-01T00:00:00Z"))
    assert res.relations[0].event_time.isoformat() == "2024-03-01T00:00:00+00:00"
    with pytest.raises(ValidationError):
        run(g.insert.facts(PAYLOAD, event_time="soon"))
    run(g.close())


@pytest.mark.parametrize("collision", ["stored", "batch", "generated", "generated-other-source"])
def test_conflicting_relation_id_does_not_write_any_facts(collision):
    g = fresh_graph("relation_identity")
    run(g.entities.create("Ada", "Person"))
    run(g.entities.create("Bob", "Person"))
    original = {"id": "relation:team", "from_entity": "person:ada", "type": "KNOWS", "to_entity": "person:bob"}
    conflicting = {**original, "to_entity": "person:cy"}
    if collision.startswith("generated"):
        original["id"] = relation_id("person:ada", "KNOWS", "person:cy")
        del conflicting["id"]
        if collision == "generated-other-source":
            original["from_entity"] = "person:bob"
    stored = collision != "batch"
    if stored:
        run(g.relations.create(original["from_entity"], "KNOWS", "person:bob", id=original["id"]))

    with pytest.raises(ValidationError, match="already exists with different endpoints/type"):
        run(
            g.insert.facts(
                {
                    "entities": [{"type": "Person", "name": "Cy"}],
                    "relations": [conflicting] if stored else [original, conflicting],
                },
                source_id="bad-import",
            )
        )

    assert run(g.entities.get("person:cy")) is None
    assert run(g.store.match_nodes(g.namespace, "SourceVersion")) == []
    relation = run(g.relations.get(original["id"]))
    if stored:
        assert relation.to_entity == "person:bob"
    else:
        assert relation is None


@pytest.mark.parametrize("collision", ["stored", "batch", "generated"])
def test_conflicting_preference_id_does_not_write_any_facts(collision):
    g = fresh_graph("preference_identity")
    run(g.entities.create("Ada", "Person"))
    run(g.entities.create("Bob", "Person"))
    run(g.entities.create("Tea", "Drink"))
    run(g.entities.create("Coffee", "Drink"))
    original = {"id": "preference:fav", "subject_entity": "person:ada", "key": "drink", "value_entity": "drink:tea"}
    conflicting = {**original, "subject_entity": "person:bob", "value_entity": "drink:coffee"}
    if collision == "generated":
        original["id"] = preference_id("person:bob", "preference", "drink", "drink:coffee")
        del conflicting["id"]
    stored = collision != "batch"
    if stored:
        run(g.preferences.create("person:ada", "drink", "drink:tea", id=original["id"]))

    with pytest.raises(ValidationError, match="already exists with different subject/stance/key/value"):
        run(
            g.insert.facts(
                {
                    "entities": [{"type": "Person", "name": "Cy"}],
                    "relations": [{"from_entity": "person:cy", "type": "KNOWS", "to_entity": "person:ada"}],
                    "preferences": [conflicting] if stored else [original, conflicting],
                },
                source_id="bad-import",
            )
        )

    assert run(g.entities.get("person:cy")) is None
    assert run(g.relations.list()).items == []
    assert run(g.store.match_nodes(g.namespace, "SourceVersion")) == []
    preference = run(g.preferences.get(original["id"]))
    if stored:
        assert (preference.subject_entity, preference.value_entity) == ("person:ada", "drink:tea")
    else:
        assert preference is None


def test_matching_preference_ids_still_merge():
    g = fresh_graph("preference_identity")
    run(g.entities.create("Ada", "Person"))
    run(g.entities.create("Tea", "Drink"))
    pref = {"subject_entity": "person:ada", "key": "drink", "value_entity": "drink:tea"}
    run(g.preferences.create("person:ada", "drink", "drink:tea", id="preference:stored", strength=0.2))
    batch = [
        {**pref, "id": "preference:stored", "strength": 0.9},
        {**pref, "id": "preference:fresh", "strength": 0.2},
        {**pref, "id": "preference:fresh", "strength": 0.9},
    ]

    result = run(g.insert.facts({"preferences": batch}, source_id="restated"))

    assert [p.id for p in result.preferences] == ["preference:stored", "preference:fresh"]
    for pid, versions in (("preference:stored", 2), ("preference:fresh", 1)):
        preference = run(g.preferences.get(pid))
        assert (preference.subject_entity, preference.key, preference.strength) == ("person:ada", "drink", 0.9)
        assert len(run(g.preferences.versions(pid))) == versions


def test_facts_bare_years_and_string_strengths_are_rejected():
    g = new_graph()
    t_entities(g, "a", "b")
    joined = {"from_entity": "t:a", "type": "R", "to_entity": "t:b"}
    likes = {"subject_entity": "t:a", "key": "k", "value_entity": "t:b"}
    cases = [
        ({"relations": [{**joined, "event_time": "2021"}]}, 'relations[0].event_time: invalid ISO 8601 string: "2021"'),
        ({"relations": [{**joined, "event_time": 2021}]}, "relations[0].event_time: invalid input"),
        ({"relations": [{**joined, "event_time": True}]}, "relations[0].event_time: invalid input"),
        (
            {"relations": [{**joined, "evidence": [{"source_id": "s", "confidence": "0.5"}]}]},
            "relations[0].evidence[0].confidence: expected number",
        ),
        ({"preferences": [{**likes, "strength": "0.9"}]}, "preferences[0].strength: expected number"),
        ({"preferences": [{**likes, "strength": False}]}, "preferences[0].strength: expected number"),
        (
            {"preferences": [{**likes, "event_time": "20210304T"}]},
            'preferences[0].event_time: invalid ISO 8601 string: "20210304T"',
        ),
        ({"decisions": [{"title": "t", "event_time": 1700000000}]}, "decisions[0].event_time: invalid input"),
        (
            {"decisions": [{"title": "t", "event_time": "soon", "steps": []}]},
            'decisions[0].event_time: invalid ISO 8601 string: "soon"',
        ),
        (
            {"relations": [{**joined, "event_time": "2021-01-01T00:00:00+05:60"}]},
            'relations[0].event_time: invalid ISO 8601 string: "2021-01-01T00:00:00+05:60"',
        ),
    ]
    for facts, message in cases:
        with pytest.raises(ValidationError) as exc:
            run(g.insert.facts(facts))
        assert str(exc.value) == f"invalid facts: {message}"
    assert run(g.relations.list()).items == []
    run(g.close())


@pytest.mark.skipif(not KUZU, reason="counts Kuzu statements")
def test_relation_id_preflight_batches_kuzu_reads(monkeypatch):
    g = fresh_graph("relation_id_batches")
    run(g.entities.create("Ada", "Person"))
    original = g.store._run
    batches = []
    single_reads = []

    async def capture(query, params=None, **kwargs):
        if "r.sid IN $ids" in query:
            batches.append(len(params["ids"]))
        if "r.sid = $sid" in query and "RETURN r.doc" in query:
            single_reads.append(query)
        return await original(query, params, **kwargs)

    monkeypatch.setattr(g.store, "_run", capture)
    entities = [{"type": "Person", "name": f"Contact {i}"} for i in range(257)]
    relations = [{"from_entity": "person:ada", "type": "KNOWS", "to_entity": f"person:contact-{i}"} for i in range(257)]
    result = run(g.insert.facts({"entities": entities, "relations": relations}))
    assert len(result.relations) == 257
    assert batches == [256, 1]
    assert single_reads == []


@pytest.mark.parametrize("value", [{"__proto__": 1}, {"nested": [{"__proto__": 1}]}])
def test_proto_keys_precede_value_type_validation(value):
    with pytest.raises(ValidationError) as exc:
        Extraction.model_validate({"entities": [{"type": "Person", "name": "Ann", "external_ids": value}]})
    assert str(exc.value) == "property and external id keys cannot be '__proto__'"


@pytest.mark.parametrize("value, key", [({"a": 9007199254740993}, "a"), ({"\x01": 1}, "\x01")])
def test_other_external_id_errors_keep_value_type_validation(value, key):
    with pytest.raises(ValidationError) as exc:
        Extraction.model_validate({"entities": [{"type": "Person", "name": "Ann", "external_ids": value}]})
    assert str(exc.value) == f"invalid facts: entities[0].external_ids.{key}: expected string"


FOLD_ENTITIES = {
    "entities": [
        {"type": "Person", "name": "Ann"},
        {"type": "Food", "name": "Pizza"},
        {"type": "Food", "name": "Pasta"},
    ]
}
FOLD_RELATION = {"from_entity": "person:ann", "type": "LIKES", "to_entity": "food:pasta"}
FOLD_PREFERENCE = {"subject_entity": "person:ann", "key": "food", "value_entity": "food:pizza"}
EARLY = "2020-01-01T00:00:00+00:00"
LATE = "2021-01-01T00:00:00+00:00"

REPEATED_RELATIONS = [
    pytest.param(None, [{"properties": {"w": 1}}, {"properties": {"w": 2}}], [(1, {"w": 2}, None)], id="last-wins"),
    pytest.param(
        None,
        [{"properties": {"a": 1, "w": 1}}, {"properties": {"w": 3}}],
        [(1, {"a": 1, "w": 3}, None)],
        id="keys-merge",
    ),
    pytest.param(
        {"w": 1},
        [{"properties": {"w": 2}}, {"properties": {"w": 3}}],
        [(2, {"w": 3}, None), (1, {"w": 1}, None)],
        id="stored-one-new-revision",
    ),
    pytest.param(
        {"w": 1},
        [{"properties": {"w": 2}}, {"properties": {"w": None}}],
        [(2, {}, None), (1, {"w": 1}, None)],
        id="later-null-removes",
    ),
    pytest.param(
        {"w": 1},
        [{"properties": {"w": None}}, {"properties": {"w": 2}}],
        [(2, {"w": 2}, None), (1, {"w": 1}, None)],
        id="later-value-restores",
    ),
    pytest.param(
        {"w": 1}, [{"properties": {"w": 2}}, {"properties": {"w": 1}}], [(1, {"w": 1}, None)], id="back-to-stored"
    ),
    pytest.param(
        None,
        [{"event_time": EARLY}, {"event_time": LATE}],
        [(1, {}, LATE)],
        id="newest-event-time",
    ),
]


@pytest.mark.parametrize("explicit_id", [None, "relation:fold"])
@pytest.mark.parametrize("stored, given, history", REPEATED_RELATIONS)
def test_repeated_relation_id_writes_one_revision_and_replays_clean(stored, given, history, explicit_id):
    g = fresh_graph("fold")
    run(g.insert.facts(FOLD_ENTITIES))
    named = {**FOLD_RELATION, **({} if explicit_id is None else {"id": explicit_id})}
    rid = explicit_id or relation_id("person:ann", "LIKES", "food:pasta")
    if stored is not None:
        run(g.insert.facts({"relations": [{**named, "properties": stored}]}))
    for _ in range(3):
        res = run(g.insert.facts({"relations": [{**named, **item} for item in given]}))
        assert [r.id for r in res.relations] == [rid]
        versions = run(g.relations.versions(rid))
        assert [(v.revision, v.properties, v.event_time and v.event_time.isoformat()) for v in versions] == history


def test_repeated_relation_id_joins_the_evidence_of_every_input():
    g = fresh_graph("fold")
    run(g.insert.facts(FOLD_ENTITIES))
    rid = relation_id("person:ann", "LIKES", "food:pasta")
    given = [
        {**FOLD_RELATION, "properties": {"w": n}, "evidence": [{"source_id": f"doc-{n}", "quote": f"quote {n}"}]}
        for n in (1, 2)
    ]
    for _ in range(3):
        run(g.insert.facts({"relations": given}))
        [rel] = run(g.relations.versions(rid))
        assert (rel.revision, rel.source_count) == (1, 2)
        assert {(e.source_id, e.quote) for e in run(g.relations.evidence(rid)).items} == {
            ("doc-1", "quote 1"),
            ("doc-2", "quote 2"),
        }


REPEATED_PREFERENCES = [
    pytest.param(None, [{"strength": 1.0}, {"strength": 0.1}], [(1, 0.1, None, {})], id="last-strength-wins"),
    pytest.param(
        None,
        [{"about_entity": "food:pasta", "strength": 0.2}, {"strength": 0.3}],
        [(1, 0.3, "food:pasta", {})],
        id="unset-about-keeps-earlier",
    ),
    pytest.param(
        None,
        [{"properties": {"a": 1, "w": 1}}, {"properties": {"w": 2}}],
        [(1, None, None, {"a": 1, "w": 2})],
        id="properties-merge",
    ),
    pytest.param(
        {"strength": 0.5},
        [{"strength": 0.9}, {"strength": 0.1}],
        [(2, 0.1, None, {}), (1, 0.5, None, {})],
        id="stored-one-new-revision",
    ),
    pytest.param({"strength": 0.5}, [{"strength": 0.9}, {"strength": 0.5}], [(1, 0.5, None, {})], id="back-to-stored"),
]


@pytest.mark.parametrize("explicit_id", [None, "preference:fold"])
@pytest.mark.parametrize("stored, given, history", REPEATED_PREFERENCES)
def test_repeated_preference_id_writes_one_revision_and_replays_clean(stored, given, history, explicit_id):
    g = fresh_graph("fold")
    run(g.insert.facts(FOLD_ENTITIES))
    named = {**FOLD_PREFERENCE, **({} if explicit_id is None else {"id": explicit_id})}
    pid = explicit_id or preference_id("person:ann", "preference", "food", "food:pizza")
    if stored is not None:
        run(g.insert.facts({"preferences": [{**named, **stored}]}))
    for _ in range(3):
        res = run(g.insert.facts({"preferences": [{**named, **item} for item in given]}))
        assert [p.id for p in res.preferences] == [pid]
        versions = run(g.preferences.versions(pid))
        assert [(v.revision, v.strength, v.about_entity, v.properties) for v in versions] == history

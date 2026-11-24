import pytest
from helpers import AUTO_COMMIT, HYDRADB, RAW_CYPHER, create_entities, fresh_graph, interrupt_write, new_graph, run

from selfgraph import ConflictError, NotFoundError, StoreError, TransientError, ValidationError


def seed(g):
    create_entities(g, "Person:Soham", "Company:HydraDB", "Company:Neo4j")


def test_create_preference_makes_profile():
    g = new_graph()
    seed(g)
    pref = run(g.preferences.create("person:soham", "database", "company:hydradb", strength=0.9))
    assert pref.stance == "preference"
    assert pref.key == "database"
    assert pref.value_entity == "company:hydradb"
    assert pref.subject_entity == "person:soham"
    assert pref.profile_id == "profile:person:soham"
    assert pref.revision == 1 and pref.is_current

    if RAW_CYPHER:
        rows = run(g.run_cypher("MATCH (s {id:'person:soham'})-[:HAS_PROFILE]->(p:Profile) RETURN p.id AS id"))
        assert rows.rows and rows.rows[0]["id"] == "profile:person:soham"


def test_disinterest_uses_avoids_edge():
    g = new_graph()
    seed(g)
    pref = run(g.preferences.create("person:soham", "database", "company:neo4j", stance="disinterest"))
    assert pref.stance == "disinterest"
    if RAW_CYPHER:
        rows = run(g.run_cypher("MATCH (p:Profile)-[r:AVOIDS]->(v) RETURN v.id AS id"))
        assert rows.rows[0]["id"] == "company:neo4j"


def test_update_adds_version():
    g = new_graph()
    seed(g)
    pref = run(g.preferences.create("person:soham", "database", "company:hydradb", strength=0.5))
    pref2 = run(g.preferences.update(pref.id, strength=1.0))
    assert pref2.revision == 2 and pref2.strength == 1.0
    history = run(g.preferences.versions(pref.id))
    assert [v.revision for v in history] == [2, 1]


def test_list_and_filters():
    g = new_graph()
    seed(g)
    run(g.preferences.create("person:soham", "database", "company:hydradb"))
    run(g.preferences.create("person:soham", "ide", "company:neo4j", stance="disinterest"))
    allp = run(g.preferences.list("person:soham"))
    assert len(allp.items) == 2
    db = run(g.preferences.list("person:soham", key="database"))
    assert len(db.items) == 1 and db.items[0].key == "database"
    dis = run(g.preferences.list("person:soham", stance="disinterest"))
    assert len(dis.items) == 1 and dis.items[0].stance == "disinterest"


def test_missing_refs_and_errors():
    g = new_graph()
    seed(g)
    with pytest.raises(ValidationError):
        run(g.preferences.create("person:ghost", "database", "company:hydradb"))
    with pytest.raises(ValidationError):
        run(g.preferences.create("person:soham", "database", "company:ghost"))
    with pytest.raises(NotFoundError):
        run(g.preferences.update("preference:nope", strength=1.0))
    run(g.preferences.create("person:soham", "database", "company:hydradb", id="preference:x"))
    with pytest.raises(ConflictError):
        run(g.preferences.create("person:soham", "database", "company:hydradb", id="preference:x"))


def test_delete_preference():
    g = new_graph()
    seed(g)
    pref = run(g.preferences.create("person:soham", "database", "company:hydradb"))
    run(g.preferences.update(pref.id, strength=0.5))
    dr = run(g.preferences.delete(pref.id))
    assert dr.deleted_preference_versions == 2
    assert run(g.preferences.get(pref.id)) is None


def test_list_relations_excludes_preference_edges():
    g = new_graph()
    seed(g)
    run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))
    run(g.preferences.create("person:soham", "database", "company:hydradb"))
    listed = run(g.relations.list())
    assert [r.type for r in listed.items] == ["WORKS_AT"]
    assert all(not r.from_entity.startswith("profile:") for r in listed.items)


def test_insert_result_lists_each_preference_once():
    g = new_graph()
    seed(g)
    pref = {"subject_entity": "person:soham", "key": "database", "value_entity": "company:hydradb"}
    result = run(g.insert.facts({"preferences": [pref, {**pref, "strength": 0.5}, {**pref, "strength": 0.7}]}))
    assert [(p.id, p.strength) for p in result.preferences] == [(result.preferences[0].id, 0.7)]


def test_undated_preference_restatement_keeps_strength_and_event_time():
    g = fresh_graph("pref-restatement")
    seed(g)
    run(
        g.insert.facts(
            {
                "preferences": [
                    {
                        "subject_entity": "person:soham",
                        "key": "database",
                        "value_entity": "company:hydradb",
                        "strength": 0.9,
                        "about_entity": "company:neo4j",
                        "event_time": "2020-01-01T00:00:00+00:00",
                    }
                ]
            },
            source_id="a",
        )
    )
    run(
        g.insert.facts(
            {
                "preferences": [
                    {
                        "subject_entity": "person:soham",
                        "key": "database",
                        "value_entity": "company:hydradb",
                    }
                ]
            },
            source_id="b",
        )
    )
    [pref] = run(g.preferences.list()).items
    assert (pref.strength, pref.about_entity, pref.revision) == (0.9, "company:neo4j", 1)
    assert pref.event_time.isoformat() == "2020-01-01T00:00:00+00:00"


def test_update_clears_named_fields_and_null_keeps():
    g = fresh_graph("q4")
    seed(g)
    pref = run(
        g.preferences.create("person:soham", "database", "company:hydradb", about_entity="company:neo4j", strength=0.9)
    )
    same = run(g.preferences.update(pref.id, strength=None, properties={}))
    assert (same.strength, same.revision) == (0.9, 1)
    with pytest.raises(ValidationError, match="nothing to update"):
        run(g.preferences.update(pref.id, strength=None))
    cleared = run(g.preferences.update(pref.id, clear=["strength", "about_entity"], event_time="2024-01-02"))
    assert (cleared.strength, cleared.about_entity, cleared.revision) == (None, None, 2)
    assert cleared.event_time.isoformat() == "2024-01-02T00:00:00+00:00"
    with pytest.raises(ValidationError, match="cannot clear 'key'"):
        run(g.preferences.update(pref.id, clear=["key"]))
    with pytest.raises(ValidationError, match="cannot both set and clear 'strength'"):
        run(g.preferences.update(pref.id, strength=0.5, clear=["strength"]))


@pytest.mark.skipif(not HYDRADB, reason="the Bolt message limit is HydraDB's")
def test_an_update_over_the_hydradb_message_limit_keeps_the_current_version():
    g = new_graph()
    seed(g)
    pref = run(g.preferences.create("person:soham", "employer", "company:hydradb"))
    with pytest.raises(StoreError, match="Bolt message"):
        run(g.preferences.update(pref.id, properties={"blob": "x" * 1_100_000}))
    current = run(g.preferences.get(pref.id))
    assert (current.revision, current.properties) == (1, {})


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store leaves the gap between retire and create")
@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ({"strength": 0.9}, 0.9),
        ({"strength": 0.5}, 0.5),
        ({"clear": ["strength"]}, None),
    ],
)
def test_an_update_completes_a_preference_an_interrupted_update_left_without_a_current_version(
    monkeypatch, changes, expected
):
    g = fresh_graph("interrupted-update")
    seed(g)
    pref = run(g.preferences.create("person:soham", "database", "company:hydradb", strength=0.5))
    interrupt_write(g, g.preferences.update(pref.id, strength=1.0), monkeypatch)
    assert run(g.preferences.get(pref.id)) is None
    assert [(v.revision, v.is_current) for v in run(g.preferences.versions(pref.id))] == [(1, False)]

    updated = run(g.preferences.update(pref.id, **changes))

    assert (updated.revision, updated.is_current, updated.strength) == (2, True, expected)
    assert run(g.preferences.get(pref.id)) == updated
    history = run(g.preferences.versions(pref.id))
    assert [(v.revision, v.is_current, v.strength) for v in history] == [(2, True, expected), (1, False, 0.5)]
    assert [p.id for p in run(g.preferences.list("person:soham")).items] == [pref.id]


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store leaves the gap between retire and create")
def test_an_insert_completes_a_preference_an_interrupted_update_left_without_a_current_version(monkeypatch):
    g = fresh_graph("interrupted-update")
    seed(g)
    pref = run(g.preferences.create("person:soham", "database", "company:hydradb", strength=0.5, properties={"a": 1}))
    interrupt_write(g, g.preferences.update(pref.id, strength=1.0), monkeypatch)
    facts = {"subject_entity": "person:soham", "key": "database", "value_entity": "company:hydradb"}

    [inserted] = run(g.insert.facts({"preferences": [{**facts, "properties": {"b": 2}}]})).preferences

    assert (inserted.revision, inserted.is_current, inserted.strength) == (2, True, 0.5)
    assert run(g.preferences.get(pref.id)) == inserted
    history = run(g.preferences.versions(pref.id))
    assert [(v.revision, v.is_current, v.properties) for v in history] == [
        (2, True, {"a": 1, "b": 2}),
        (1, False, {"a": 1}),
    ]


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store leaves the gap between retire and create")
@pytest.mark.parametrize("by", ["update", "insert", "recovery"])
def test_a_preference_update_waits_for_a_write_still_running_in_its_transaction_and_completes_it_once_interrupted(
    monkeypatch, by
):
    monkeypatch.setattr("selfgraph.client._TX_RETRY_BASE_DELAY", 0)
    g = fresh_graph("live-write")
    seed(g)
    pref = run(g.preferences.create("person:soham", "database", "company:hydradb", strength=0.5))
    facts = {"subject_entity": "person:soham", "key": "database", "value_entity": "company:hydradb"}
    if by == "recovery":
        interrupt_write(g, g.preferences.update(pref.id, strength=0.7), monkeypatch)
    write = (
        g.insert.facts({"preferences": [{**facts, "strength": 1.0}]})
        if by == "insert"
        else g.preferences.update(pref.id, strength=1.0)
    )

    async def concurrent() -> None:
        with pytest.raises(TransientError) as caught:
            await g.preferences.update(pref.id, strength=0.9)
        assert "concurrent write" in str(caught.value.__cause__)
        with pytest.raises(TransientError) as caught:
            await g.insert.facts({"preferences": [{**facts, "strength": 0.9}]})
        assert "concurrent write" in str(caught.value.__cause__)
        assert [(v.revision, v.is_current) for v in await g.preferences.versions(pref.id)] == [(1, False)]

    interrupt_write(g, write, monkeypatch, while_stuck=concurrent)
    updated = run(g.preferences.update(pref.id, strength=0.9))

    assert (updated.revision, updated.is_current, updated.strength) == (2, True, 0.9)
    assert [(v.revision, v.is_current) for v in run(g.preferences.versions(pref.id))] == [(2, True), (1, False)]

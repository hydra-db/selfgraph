import pytest
from helpers import RAW_CYPHER, new_graph, run

from selfgraph import ConflictError, NotFoundError, ValidationError


def seed(g):
    run(g.entities.create("Soham", "Person", id="person:soham"))
    run(g.entities.create("HydraDB", "Company", id="company:hydradb"))
    run(g.entities.create("Neo4j", "Company", id="company:neo4j"))


def test_create_preference_makes_profile():
    g = new_graph()
    seed(g)
    pref = run(g.preferences.create("person:soham", "database", "company:hydradb", strength=0.9))
    assert pref.kind == "preference"
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
    pref = run(g.preferences.create("person:soham", "database", "company:neo4j", kind="disinterest"))
    assert pref.kind == "disinterest"
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
    run(g.preferences.create("person:soham", "ide", "company:neo4j", kind="disinterest"))
    allp = run(g.preferences.list("person:soham"))
    assert len(allp.items) == 2
    db = run(g.preferences.list("person:soham", key="database"))
    assert len(db.items) == 1 and db.items[0].key == "database"
    dis = run(g.preferences.list("person:soham", kind="disinterest"))
    assert len(dis.items) == 1 and dis.items[0].kind == "disinterest"


def test_missing_refs_and_errors():
    g = new_graph()
    seed(g)
    with pytest.raises(ValidationError):
        run(g.preferences.create("person:ghost", "database", "company:hydradb"))
    with pytest.raises(ValidationError):
        run(g.preferences.create("person:soham", "database", "company:ghost"))
    with pytest.raises(NotFoundError):
        run(g.preferences.update("nope", strength=1.0))
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


def test_update_with_none_keeps_strength():
    g = new_graph()
    seed(g)
    pref = run(g.preferences.create("person:soham", "none-keeps", "company:neo4j", strength=0.3))
    same = run(g.preferences.update(pref.id, strength=None))
    assert same.strength == 0.3 and same.revision == pref.revision

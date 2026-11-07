import pytest
from helpers import new_graph, run, skip_on_falkordb, skip_on_generic

from selfgraph import StoreError

pytestmark = skip_on_generic


def seed(g):
    run(g.entities.create("Soham", "Person", id="person:soham"))
    run(g.entities.create("HydraDB", "Company", id="company:hydradb"))
    run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))


def test_doc_read_query():
    g = new_graph()
    seed(g)
    res = run(g.run_cypher("MATCH (a)-[r]->(b) WHERE r.is_current = true RETURN a.name, type(r), b.name"))
    assert res.columns == ["a.name", "type(r)", "b.name"]
    assert res.rows == [{"a.name": "Soham", "type(r)": "WORKS_AT", "b.name": "HydraDB"}]


def test_run_cypher_write_counters():
    g = new_graph()
    res = run(
        g.run_cypher(
            "MERGE (p:Person {id:$id, ns:$ns}) SET p.name = $name",
            {"id": "person:x", "ns": "default", "name": "X"},
        )
    )
    assert res.counters.get("nodes_created") == 1


def test_raw_cypher_write_adds_no_version():
    g = new_graph()
    seed(g)
    rel = run(g.relations.list(from_entity="person:soham")).items[0]
    assert rel.revision == 1
    # A raw Cypher SET changes the edge in place; typed versioning is bypassed.
    run(
        g.run_cypher(
            "MATCH ()-[r {id:$id, ns:$ns}]->() WHERE r.is_current = true SET r.properties_json = $p",
            {"id": rel.id, "ns": "default", "p": '{"role": "Staff"}'},
        )
    )
    versions = run(g.relations.versions(rel.id))
    assert len(versions) == 1


def test_invalid_query_raises_store_error():
    g = new_graph()
    with pytest.raises(StoreError):
        run(g.run_cypher("THIS IS NOT VALID CYPHER"))


def test_multi_key_order_by():
    g = new_graph()
    rows_in = [(3, "2026-01-01"), (1, "2026-01-02"), (1, "2026-01-03"), (3, "2026-01-04")]
    for i, (a, b) in enumerate(rows_in):
        run(g.run_cypher("CREATE (n:X {id:$id, a:$a, b:$b})", {"id": f"n{i}", "a": a, "b": b}))
    res = run(g.run_cypher("MATCH (n:X) RETURN n.a AS a, n.b AS b ORDER BY n.a, n.b"))
    assert [(r["a"], r["b"]) for r in res.rows] == [
        (1, "2026-01-02"),
        (1, "2026-01-03"),
        (3, "2026-01-01"),
        (3, "2026-01-04"),
    ]


def test_not_equal_null_is_three_valued():
    g = new_graph()
    run(g.run_cypher("CREATE (n:Y {id:'a', status:'active'})"))
    run(g.run_cypher("CREATE (n:Y {id:'b'})"))
    res = run(g.run_cypher("MATCH (n:Y) WHERE n.status <> 'archived' RETURN n.id AS id ORDER BY n.id"))
    assert [r["id"] for r in res.rows] == ["a"]  # null <> 'archived' is null, not true


def test_non_ascii_string_literal_round_trips():
    g = new_graph()
    run(g.run_cypher("CREATE (n:Z {id:'1', name:'café'})"))
    res = run(g.run_cypher("MATCH (n:Z) WHERE n.name = 'café' RETURN n.name AS name"))
    assert res.rows == [{"name": "café"}]


@skip_on_falkordb
def test_run_cypher_write_is_atomic():
    g = new_graph()
    run(g.run_cypher("CREATE (n:Q {id:'a', x:1})"))
    run(g.run_cypher("CREATE (n:Q {id:'b'})"))
    run(g.run_cypher("MATCH (a:Q {id:'a'}),(b:Q {id:'b'}) CREATE (a)-[r:E]->(b)"))
    # DELETE without DETACH on a node with relationships fails; the SET must not persist.
    with pytest.raises(StoreError):
        run(g.run_cypher("MATCH (a:Q {id:'a'}) SET a.x = 999 DELETE a"))
    res = run(g.run_cypher("MATCH (a:Q {id:'a'}) RETURN a.x AS x"))
    assert res.rows == [{"x": 1}]

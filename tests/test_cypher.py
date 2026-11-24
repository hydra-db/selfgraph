import json

import pytest
from helpers import (
    FALKORDB,
    DriverError,
    create_entities,
    fresh_graph,
    mcp_session,
    new_graph,
    run,
    skip_on_falkordb,
    skip_on_generic,
)

from selfgraph import StoreError, TransientError
from selfgraph.stores.cypher import _translate_cypher_error

pytestmark = skip_on_generic


def seed(g):
    create_entities(g, "Person:Soham", "Company:HydraDB")
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
    run(
        g.run_cypher(
            "MATCH ()-[r {id:$id, ns:$ns}]->() WHERE r.is_current = true SET r.properties_json = $p",
            {"id": rel.id, "ns": "default", "p": '{"role": "Staff"}'},
        )
    )
    versions = run(g.relations.versions(rel.id))
    assert len(versions) == 1


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
    assert [r["id"] for r in res.rows] == ["a"]


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
    with pytest.raises(StoreError):
        run(g.run_cypher("MATCH (a:Q {id:'a'}) SET a.x = 999 DELETE a"))
    res = run(g.run_cypher("MATCH (a:Q {id:'a'}) RETURN a.x AS x"))
    assert res.rows == [{"x": 1}]


def test_syntax_error_is_not_a_conflict():
    memgraph = "Memgraph.ClientError.MemgraphError.MemgraphError"
    syntax = DriverError(memgraph, "The underlying parsing error is mismatched input expecting {CONSTRAINT, UNIQUE}")
    assert type(_translate_cypher_error(syntax, "bolt://x", None)) is StoreError
    unique = DriverError(memgraph, "Unable to commit due to unique constraint violation on :Entity(id)")
    assert isinstance(_translate_cypher_error(unique, "bolt://x", None), TransientError)
    neo4j = DriverError("Neo.ClientError.Schema.ConstraintValidationFailed", "Node(1) already exists")
    assert isinstance(_translate_cypher_error(neo4j, "bolt://x", None), TransientError)
    with pytest.raises(StoreError) as err:
        run(new_graph().run_cypher("RETURN"))
    assert not isinstance(err.value, TransientError)


def test_run_cypher_path_properties():
    g = fresh_graph("path")
    run(
        g.run_cypher(
            "CREATE (a:PathTest {ns:$ns, id:'1', _lock:1})-[:REL {w:2, _lock:1}]->(b:PathTest {ns:$ns, id:'2'})",
            {"ns": g.namespace},
        )
    )
    path = {"nodes": [{"ns": g.namespace, "id": "1"}, {"ns": g.namespace, "id": "2"}], "relationships": [{"w": 2}]}
    query = "MATCH p=(a:PathTest {ns:$ns})-[:REL]->(b:PathTest) RETURN p, [p] AS nested"
    assert run(g.run_cypher(query, {"ns": g.namespace})).rows == [{"p": path, "nested": [path]}]
    query = "MATCH p=(a:PathTest {ns:$ns, id:'1'})-[*0..0]->(b) RETURN p"
    assert run(g.run_cypher(query, {"ns": g.namespace})).rows == [
        {"p": {"nodes": [path["nodes"][0]], "relationships": []}}
    ]


@pytest.mark.skipif(not FALKORDB, reason="FalkorDB non-finite result encoding")
def test_run_cypher_non_finite_json():
    query = (
        "RETURN 1.0/0.0 AS positive, -1.0/0.0 AS negative, 0.0/0.0 AS nan, {values: [1.0/0.0, 0.0/0.0, 2.5]} AS nested"
    )
    expected = [{"positive": None, "negative": None, "nan": None, "nested": {"values": [None, None, 2.5]}}]
    result = run(new_graph().run_cypher(query))
    assert result.rows == expected
    json.dumps(result.rows, allow_nan=False)
    with mcp_session("nonfinite") as server:
        result = run(server.build_server().call_tool("run_cypher", {"query": query}))
        assert not result.is_error
        assert result.structured_content["rows"] == expected
        assert json.loads(result.content[0].text) == result.structured_content
        json.dumps(result.structured_content, allow_nan=False)

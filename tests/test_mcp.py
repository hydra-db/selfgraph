import importlib.util

import pytest
from helpers import RAW_CYPHER, run, store_settings, unique_ns

import selfgraph.mcp.server as srv
from selfgraph.errors import ValidationError

_HAS_MCP = importlib.util.find_spec("mcp") is not None


def test_tools_build_and_read_graph():
    srv.configure(store_settings())
    run(srv.create_entity("HydraDB", "Company", id="company:hydradb"))
    assert run(srv.get_entity("company:hydradb"))["name"] == "HydraDB"

    listed = run(srv.list_entities(type="Company"))
    assert [e["id"] for e in listed["items"]] == ["company:hydradb"]

    if RAW_CYPHER:
        rows = run(srv.run_cypher("MATCH (e:Entity {id:'company:hydradb', ns:'default'}) RETURN e.id AS id"))
        assert {"id": "company:hydradb"} in rows["rows"]


def test_insert_ontology_tool_and_relation_versions():
    srv.configure(store_settings())
    run(
        srv.insert_ontology(
            {
                "entities": [
                    {"name": "A", "type": "T", "id": "t:a"},
                    {"name": "B", "type": "T", "id": "t:b"},
                ],
                "relations": [{"from_entity": "t:a", "type": "KNOWS", "to_entity": "t:b", "id": "relation:r1"}],
            }
        )
    )
    assert run(srv.get_relation("relation:r1"))["type"] == "KNOWS"
    run(srv.update_relation("relation:r1", set_properties={"w": 2}))
    assert [v["revision"] for v in run(srv.relation_versions("relation:r1"))] == [2, 1]


def test_build_server_contract():
    if _HAS_MCP:
        assert srv.build_server() is not None
    else:
        with pytest.raises(RuntimeError):
            srv.build_server()


BYPASSES = [
    "MATCH (n) WITH n LIMIT 1 INSERT (m:X) RETURN 1",
    "WITH 1 AS x insert (m:X) RETURN 1",
    "WITH 1 AS x \\u0043REATE (m:X) RETURN 1",
    "WITH 1 AS x \\u0043\\u0052EATE (m:X) RETURN 1",
    "MATCH (n) \\u0044ETACH \\u0044ELETE n",
    "WITH 1 AS x \\U00000043REATE (m:X) RETURN 1",
    "WITH 1 AS x // \\u000a CREATE (m:X) RETURN 1",
    "WITH 1 AS x /* \\u002a/ CREATE (m:X) /* */ RETURN 1",
    "MATCH (n) WHERE n.x = 'a\\u0027 CREATE (m:X) //' RETURN 1",
    "RETURN `a\\u0060 AS y",
    "RETURN '\\\\\\u0027' AS x",
    "WITH 1 AS x \\ CREATE (m:X) RETURN 1",
    "UNWIND [1] AS as WITH as CREATE (m:X) RETURN 1",
    "MATCH (n) WHERE n:as CREATE (m:X) RETURN 1",
    "MATCH (n) RETURN n AS create",
    "SHOW TRANSACTIONS YIELD transactionId AS t TERMINATE TRANSACTIONS t YIELD transactionId AS z RETURN z",
    "RETURN 1; ANALYZE GRAPH",
]

READS = [
    "MATCH (n) RETURN n AS `create`",
    "MATCH (n) WHERE n.path = 'C:\\\\users' RETURN n",
    "RETURN '\\\\u0027' AS x",
    "MATCH (n) RETURN n.set AS x;",
    "RETURN 1; MATCH (n) RETURN n",
]


def test_run_cypher_guard_rejects_bypasses():
    for query in BYPASSES:
        assert srv._is_blocked_query(query), query
        with pytest.raises(ValidationError, match="read-only"):
            run(srv.run_cypher(query))
    for query in READS:
        assert not srv._is_blocked_query(query), query


def _fresh_namespace():
    run(srv.close())
    srv.configure(store_settings(namespace=unique_ns("mcp")))


def test_event_time_and_metadata_reach_the_sdk():
    _fresh_namespace()
    try:
        run(srv.create_entity("Jane", "Person"))
        run(srv.create_entity("Acme", "Company"))
        rel = run(
            srv.create_relation("person:jane", "WORKS_AT", "company:acme", event_time="2020-01-02T03:04:05+00:00")
        )
        assert rel["event_time"].startswith("2020-01-02T03:04:05")
        updated = run(srv.update_relation(rel["id"], set_properties={"w": 1}, event_time="2021-01-01T00:00:00+00:00"))
        assert updated["event_time"].startswith("2021-01-01")
        pref = run(srv.create_preference("person:jane", "employer", "company:acme", event_time="2019-05-05"))
        assert pref["event_time"].startswith("2019-05-05")
        pref = run(srv.update_preference(pref["id"], strength=0.5, event_time="2022-02-02T00:00:00+00:00"))
        assert pref["event_time"].startswith("2022-02-02")
        dec = run(
            srv.create_decision(
                "Join Acme", [rel["id"]], summary="s", rationale="r", event_time="2020-06-01T00:00:00+00:00"
            )
        )
        assert dec["event_time"].startswith("2020-06-01")
        kept = run(srv.update_decision(dec["id"], title="Join Acme Inc"))
        assert (kept["summary"], kept["rationale"], kept["event_time"][:10]) == ("s", "r", "2020-06-01")
        cleared = run(srv.update_decision(dec["id"], summary=None, event_time=None))
        assert (cleared["summary"], cleared["rationale"], cleared["event_time"]) == (None, "r", None)
        with pytest.raises(ValidationError, match="event_time"):
            run(srv.create_relation("person:jane", "KNOWS", "company:acme", event_time="not a date"))
        result = run(
            srv.insert_text("Jane works at Acme.", source_id="note", event_time="2018-01-01", metadata={"k": 1})
        )
        assert result["source_id"] == "note"
    finally:
        run(srv.close())


@pytest.mark.skipif(not _HAS_MCP, reason="mcp is not installed")
def test_update_decision_null_clears_over_the_wire():
    _fresh_namespace()
    server = srv.build_server()
    try:
        run(srv.create_entity("A", "T", id="t:a"))
        run(srv.create_entity("B", "T", id="t:b"))
        rel = run(srv.create_relation("t:a", "KNOWS", "t:b"))
        dec = run(srv.create_decision("Pick", [rel["id"]], summary="s", rationale="r"))

        async def call(args):
            await server.call_tool("update_decision", {"id": dec["id"], **args})
            return await srv.get_decision(dec["id"])

        assert run(call({"title": "Pick it"}))["summary"] == "s"
        got = run(call({"summary": None}))
        assert (got["summary"], got["rationale"]) == (None, "r")
    finally:
        run(srv.close())


def test_evidence_tools_page_through_sources():
    _fresh_namespace()
    try:
        ont = {
            "entities": [{"name": "A", "type": "T", "id": "t:a"}, {"name": "B", "type": "T", "id": "t:b"}],
            "relations": [{"id": "relation:ab", "from_entity": "t:a", "type": "KNOWS", "to_entity": "t:b"}],
        }
        run(srv.insert_ontology(ont, source_id="s1"))
        run(srv.insert_ontology(ont, source_id="s2"))
        assert run(srv.get_entity("t:a"))["source_count"] == 2
        first = run(srv.entity_evidence("t:a", limit=1))
        rest = run(srv.entity_evidence("t:a", limit=1, cursor=first["next_cursor"]))
        assert sorted(e["source_id"] for e in first["items"] + rest["items"]) == ["s1", "s2"]
        assert rest["next_cursor"] is None
        rel = run(srv.relation_evidence("relation:ab"))
        assert sorted(e["source_id"] for e in rel["items"]) == ["s1", "s2"]
    finally:
        run(srv.close())

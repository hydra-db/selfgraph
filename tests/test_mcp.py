import importlib.util
import json
import logging

import pytest
from helpers import AB_FACTS, HYDRADB, RAW_CYPHER, mcp_session, preference_update_recorder, run

import selfgraph
import selfgraph.mcp.server as srv
from selfgraph.errors import ValidationError

_HAS_MCP = importlib.util.find_spec("mcp") is not None
needs_mcp = pytest.mark.skipif(not _HAS_MCP, reason="mcp is not installed")
TOOL_NAMES = [fn.__name__ for fn in srv.TOOLS]


@pytest.fixture
def server():
    with mcp_session():
        yield srv.build_server()


def test_tools_build_and_read_graph():
    with mcp_session(namespace="default"):
        run(srv.create_entity("HydraDB", "Company", id="company:hydradb"))
        assert run(srv.get_entity("company:hydradb"))["name"] == "HydraDB"

        listed = run(srv.list_entities(type="Company"))
        assert [e["id"] for e in listed["items"]] == ["company:hydradb"]

        if RAW_CYPHER:
            rows = run(srv.run_cypher("MATCH (e:Entity {id:'company:hydradb', ns:'default'}) RETURN e.id AS id"))
            assert {"id": "company:hydradb"} in rows["rows"]


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


def test_event_time_and_metadata_reach_the_sdk_and_empty_updates_fail():
    with mcp_session():
        run(srv.create_entity("Jane", "Person"))
        run(srv.create_entity("Acme", "Company"))
        rel = run(srv.create_relation("person:jane", "WORKS_AT", "company:acme", event_time="2020-01-02T03:04:05Z"))
        assert rel["event_time"] == "2020-01-02T03:04:05Z"
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
        with pytest.raises(ValidationError, match="nothing to update"):
            run(srv.update_decision(dec["id"]))
        with pytest.raises(ValidationError, match="text cannot be empty or whitespace"):
            run(srv.insert_text("   "))
        with pytest.raises(ValidationError, match="invalid now: 'soon' is not an ISO 8601 date or time"):
            run(srv.maintenance_decay(now="soon", dry_run=True))


@needs_mcp
def test_server_metadata_tools_and_annotations(server):
    version = getattr(server, "version", None) or server._mcp_server.version
    assert version == selfgraph.__version__
    assert logging.getLogger("mcp").getEffectiveLevel() == logging.WARNING
    listed = run(server.list_tools())
    names = [t.name for t in listed]
    assert len(names) == len(TOOL_NAMES) == 38
    assert sorted(names) == sorted(TOOL_NAMES)
    tools = {t.name: t.annotations.model_dump(by_alias=True) for t in listed}
    for name in (
        "get_entity",
        "list_relations",
        "relation_versions",
        "entity_evidence",
        "run_cypher",
        "retrieve",
    ):
        assert tools[name]["readOnlyHint"] is True
    for name in ("delete_entity", "maintenance_prune", "maintenance_dedupe_relations"):
        assert tools[name]["destructiveHint"] is True and tools[name]["idempotentHint"] is True
    assert tools["create_entity"]["destructiveHint"] is False and tools["create_entity"]["idempotentHint"] is False
    assert tools["insert_facts"]["idempotentHint"] is True
    assert "case or spacing" in srv.update_entity.__doc__


@needs_mcp
def test_call_tool_arguments_results_and_errors(server):
    run(srv.insert_facts(AB_FACTS))
    dec = run(srv.create_decision("Pick", ["relation:ab"], summary="s", rationale="r"))

    async def update(args):
        await server.call_tool("update_decision", {"id": dec["id"], **args})
        return await srv.get_decision(dec["id"])

    assert run(update({"title": "Pick it"}))["summary"] == "s"
    got = run(update({"summary": None}))
    assert (got["summary"], got["rationale"]) == (None, "r")
    for tool, missing in (
        ("get_entity", "x:missing"),
        ("get_relation", "relation:missing"),
        ("get_preference", "preference:missing"),
        ("get_decision", "decision:missing"),
    ):
        result = run(server.call_tool(tool, {"id": missing}))
        assert [c.text for c in result.content] == ["null"]
        assert result.structured_content == {"result": None}
    result = run(server.call_tool("relation_versions", {"id": "relation:ab"}))
    assert len(result.content) == 1
    assert [v["revision"] for v in json.loads(result.content[0].text)] == [1]
    assert result.structured_content == {"result": json.loads(result.content[0].text)}
    with pytest.raises(Exception, match="limit must be >= 1, got 0"):
        run(server.call_tool("list_entities", {"limit": 0}))
    with pytest.raises(
        Exception, match="unknown option 'properties' for update_relation; did you mean 'set_properties'"
    ):
        run(server.call_tool("update_relation", {"id": "relation:x", "properties": {"a": 1}}))
    for tool, args, message in (
        ("get_schema", {"format": "bogus"}, "invalid arguments: format: expected 'selfgraph', 'neo4j' or 'ossie'"),
        ("create_entity", {"name": "a"}, "invalid arguments: type: field required"),
        ("list_entities", {"limit": "x"}, "invalid arguments: limit: expected integer"),
    ):
        with pytest.raises(Exception) as exc:
            run(server.call_tool(tool, args))
        assert str(exc.value).endswith(f"ValidationError: {message}")
        assert "pydantic" not in str(exc.value)
    for flag in ("no", "false", "0", 0, None):
        for tool, args in (
            ("maintenance_prune", {"min_relevance": 2.0}),
            ("maintenance_decay", {}),
            ("maintenance_dedupe_relations", {}),
        ):
            with pytest.raises(Exception, match="dry_run"):
                run(server.call_tool(tool, {**args, "dry_run": flag}))
        with pytest.raises(Exception, match="include_invalidated"):
            run(server.call_tool("list_relations", {"include_invalidated": flag}))
        with pytest.raises(Exception, match="newest_first"):
            run(server.call_tool("relation_versions", {"id": "relation:ab", "newest_first": flag}))
    assert sorted(e["id"] for e in run(srv.list_entities())["items"]) == ["t:a", "t:b"]
    for tool, args in (
        ("list_decisions", {"status": "bogus"}),
        ("list_preferences", {"stance": "bogus"}),
        ("create_decision", {"title": "D", "steps": ["relation:ab"], "status": "bogus"}),
    ):
        with pytest.raises(Exception, match="invalid arguments"):
            run(server.call_tool(tool, args))


def test_run_cypher_needs_every_parameter_and_ids_need_their_prefix():
    with mcp_session():
        with pytest.raises(ValidationError, match=r"missing parameter \$a$"):
            run(srv.run_cypher("RETURN $a AS a, '$b' AS b // $c"))
        if not HYDRADB:
            assert run(srv.run_cypher("RETURN $a AS a", {"a": 1, "b": 2}))["rows"] == [{"a": 1}]
        for call, kind in (
            (srv.relation_evidence("my-rel"), "relation"),
            (srv.update_relation("my-rel", set_properties={"a": 1}), "relation"),
            (srv.preference_versions("my-pref"), "preference"),
            (srv.update_decision("my-dec", title="x"), "decision"),
        ):
            with pytest.raises(ValidationError, match=f"{kind} id must start with '{kind}:'"):
                run(call)


def test_facts_evidence_versions_dry_runs_and_decision_steps():
    with mcp_session():
        out = run(srv.insert_facts(AB_FACTS, source_id="s1", event_time="2020-05-01"))
        assert out["relations"][0]["event_time"] == "2020-05-01T00:00:00Z"
        run(srv.insert_facts(AB_FACTS, source_id="s2"))
        assert run(srv.get_entity("t:a"))["source_count"] == 2
        first = run(srv.entity_evidence("t:a", limit=1))
        rest = run(srv.entity_evidence("t:a", limit=1, cursor=first["next_cursor"]))
        assert sorted(e["source_id"] for e in first["items"] + rest["items"]) == ["s1", "s2"]
        assert rest["next_cursor"] is None
        evidence = [{"source_id": "doc-1", "quote": "A knows B", "confidence": 0.9}]
        created = run(srv.create_relation("t:b", "LIKES", "t:a", evidence=evidence))
        assert run(srv.relation_evidence(created["id"]))["items"][0]["quote"] == "A knows B"
        run(srv.update_relation("relation:ab", set_properties={"w": 2}, evidence=[{"source_id": "doc-2"}]))
        sources = sorted(e["source_id"] for e in run(srv.relation_evidence("relation:ab"))["items"])
        assert sources == ["doc-2", "s1", "s2"]
        assert run(srv.get_relation("relation:ab"))["type"] == "KNOWS"
        assert [v["revision"] for v in run(srv.relation_versions("relation:ab"))] == [3, 2, 1]

        assert "deleted" not in run(srv.maintenance_prune(min_relevance=0.5))
        assert "deleted" not in run(srv.maintenance_dedupe_relations())
        assert "deleted" in run(srv.maintenance_dedupe_relations(dry_run=False))
        assert run(srv.create_decision("No steps"))["steps"] == []
        dec = run(srv.create_decision("Pick", ["relation:ab"], summary="s"))
        assert run(srv.update_decision(dec["id"], steps=[]))["steps"] == []
        run(srv.update_decision(dec["id"], steps=["relation:ab"]))
        cleared = run(srv.update_decision(dec["id"], clear=["steps", "summary"]))
        assert (cleared["steps"], cleared["summary"]) == ([], None)
        with pytest.raises(ValidationError, match="cannot both set and clear 'summary'"):
            run(srv.update_decision(dec["id"], summary="x", clear=["summary"]))

        schema = {"entities": [{"name": "Person"}]}
        with pytest.raises(ValidationError, match="unknown type"):
            run(srv.insert_facts({"entities": [{"name": "X", "type": "T"}]}, schema=schema, schema_mode="strict"))
        result = run(srv.insert_text("Ann met Bob.", schema=schema, schema_mode="off", instructions={"entities": "x"}))
        assert "prompts_ignored" in [w["code"] for w in result["warnings"]]


def test_update_preference_passes_clear_to_the_library():
    run(srv.close())
    srv._graph, calls = preference_update_recorder()
    try:
        run(srv.update_preference("preference:p", clear=["strength", "about_entity"]))
    finally:
        srv._graph = None
    assert calls == [("preference:p", {"clear": ["strength", "about_entity"]})]


def test_run_stdio_validates_settings_and_files_at_startup(tmp_path):
    with pytest.raises(ValidationError, match="llm_timeout must be a positive number"):
        srv.run_stdio(srv.GraphSettings(store="kuzu", llm_timeout="0"))
    with pytest.raises(ValidationError, match="cannot read"):
        srv.run_stdio(srv.GraphSettings(store="kuzu", prompts=str(tmp_path / "missing.json")))
    with pytest.raises(selfgraph.PromptTemplateError, match="missing required variable"):
        srv.run_stdio(
            srv.GraphSettings(store="kuzu", prompts='{"entities": {"system": "s", "user": "x", "version": "1"}}')
        )

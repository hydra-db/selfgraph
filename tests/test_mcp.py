import asyncio
import importlib.util
import json
import logging
from unittest.mock import AsyncMock

import pytest
from helpers import AB_FACTS, HYDRADB, KUZU, RAW_CYPHER, error_links, mcp_session, preference_update_recorder, run

import selfgraph
import selfgraph.mcp.server as srv
from selfgraph.errors import HINTS, WARNING_HINTS, SelfGraphError, ValidationError
from selfgraph.models import CypherResult

_HAS_MCP = importlib.util.find_spec("mcp") is not None
needs_mcp = pytest.mark.skipif(not _HAS_MCP, reason="mcp is not installed")
TOOL_NAMES = [fn.__name__ for fn in srv.TOOLS]


def tool_failure(server, tool, args):
    """Call a tool that must fail and return its structured error, checking the JSON text matches it.

    @param server (Any): the MCP server.
    @param tool (str): the tool name.
    @param args (dict): the arguments.
    @return (dict): the structured error.
    """
    result = run(server.call_tool(tool, args))
    assert result.is_error
    assert json.loads(result.content[0].text) == result.structured_content
    return result.structured_content


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


def test_concurrent_first_calls_open_one_graph(monkeypatch):
    opened = []
    real = srv.build_graph

    def counting(settings):
        graph = real(settings)
        opened.append(graph)
        return graph

    monkeypatch.setattr(srv, "build_graph", counting)

    async def first_calls():
        return await asyncio.gather(*(srv.check_readiness() for _ in range(5)))

    with mcp_session():
        results = run(first_calls())
    assert len(opened) == 1
    assert all(result["reachable"] for result in results)


class _SlowGraph:
    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = 0

    async def initialize(self):
        self.started.set()
        await self.release.wait()

    async def close(self):
        self.closed += 1


@pytest.fixture
def slow_graph(monkeypatch):
    graph = _SlowGraph()
    monkeypatch.setattr(srv, "build_graph", lambda settings: graph)
    run(srv.configure(srv.GraphSettings(store="kuzu")))
    yield graph
    run(srv.close())


def test_close_while_opening_closes_the_graph(slow_graph):
    async def scenario():
        first = asyncio.ensure_future(srv._graph_handle())
        await slow_graph.started.wait()
        await srv.close()
        with pytest.raises(asyncio.CancelledError):
            await first

    run(scenario())
    assert slow_graph.closed == 1
    assert srv._graph is None


def test_configure_while_opening_closes_the_graph(slow_graph):
    async def scenario():
        first = asyncio.ensure_future(srv._graph_handle())
        await slow_graph.started.wait()
        await srv.configure(srv.GraphSettings(store="kuzu"))
        with pytest.raises(asyncio.CancelledError):
            await first

    run(scenario())
    assert slow_graph.closed == 1


def test_cancelled_first_caller_keeps_the_open_for_the_next_call(slow_graph):
    async def scenario():
        first = asyncio.ensure_future(srv._graph_handle())
        await slow_graph.started.wait()
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        slow_graph.release.set()
        return await srv._graph_handle()

    assert run(scenario()) is slow_graph
    run(srv.close())
    assert slow_graph.closed == 1


def test_build_server_contract():
    if _HAS_MCP:
        assert srv.build_server() is not None
    else:
        with pytest.raises(SelfGraphError) as exc:
            srv.build_server()
        assert exc.value.code == "missing_package"


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


def test_run_cypher_guard_recognizes_adjacent_keyword_tokens():
    for fragment in ("42SET", ".5SET", "1.SET", "1.5e+2SET", "'text'SET", "/* text */SET", "]SET"):
        assert srv._is_blocked_query(f"RETURN {fragment}"), fragment
    for fragment in ("offset42SET", "n.set", "{set: 42}", "'42SET'", ".5e+2"):
        assert not srv._is_blocked_query(f"RETURN {fragment}"), fragment


def test_raw_cypher_limits_before_store_dispatch():
    store = AsyncMock()
    store.run_cypher.return_value = CypherResult()
    graph = selfgraph.SelfGraph(store=store)
    prefix = "RETURN 1 // "
    exact_bytes = prefix + "é" * ((65_536 - len(prefix)) // 2)
    for query, limit in (
        (exact_bytes + "é", "maximum length of 65536 UTF-8 bytes"),
        ("RETURN " + "([{item:" * 11 + "1" + "}])" * 11, "maximum nesting depth of 32"),
    ):
        with pytest.raises(ValidationError, match=limit) as exc:
            run(graph.run_cypher(query))
        assert (exc.value.code, exc.value.field) == ("cypher_query_limit", "query")
    store.initialize.assert_not_called()
    store.run_cypher.assert_not_called()
    ignored = "([{ " * 33
    for query in (
        exact_bytes,
        "RETURN " + "(" * 32 + "1" + ")" * 32,
        f"RETURN '{ignored}' AS `{ignored}` /* {ignored} */",
    ):
        assert run(graph.run_cypher(query)) == CypherResult()
        store.run_cypher.assert_awaited_with(query, None)


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
    assert len(names) == len(TOOL_NAMES) == 39
    assert sorted(names) == sorted(TOOL_NAMES)
    tools = {t.name: t.annotations.model_dump(by_alias=True) for t in listed}
    for name in (
        "graph_diff",
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
    assert tool_failure(server, "list_entities", {"limit": 0}) == {
        "error": "limit must be >= 1, got 0",
        "error_type": "ValidationError",
        "code": "invalid_argument",
        "field": "limit",
        "retryable": False,
        **error_links("invalid_argument"),
        "tool": "list_entities",
    }
    assert tool_failure(server, "list_entities", {"limit": -1}) == {
        "error": "limit must be >= 1, got -1",
        "error_type": "ValidationError",
        "code": "invalid_argument",
        "field": "limit",
        "retryable": False,
        "tool": "list_entities",
    }
    assert tool_failure(server, "update_relation", {"id": "relation:x", "properties": {"a": 1}}) == {
        "error": "unknown option 'properties' for update_relation; did you mean 'set_properties'? "
        "(valid options: id, set_properties, remove_properties, event_time, evidence)",
        "error_type": "ValidationError",
        "code": "unknown_key",
        "field": "properties",
        "retryable": False,
        **error_links("unknown_key"),
        "tool": "update_relation",
    }
    for tool, args, message in (
        ("get_schema", {"format": "bogus"}, "invalid arguments: format: expected 'selfgraph', 'neo4j' or 'ossie'"),
        ("create_entity", {"name": "a"}, "invalid arguments: type: field required"),
        ("list_entities", {"limit": "x"}, "invalid arguments: limit: expected number"),
    ):
        failure = tool_failure(server, tool, args)
        assert (failure["error"], failure["code"], failure["field"]) == (
            message,
            "invalid_argument",
            message.split(": ")[1],
        )
    for flag in ("no", "false", "0", 0, None):
        for tool, args in (
            ("maintenance_prune", {"min_relevance": 2.0}),
            ("maintenance_decay", {}),
            ("maintenance_dedupe_relations", {}),
        ):
            assert tool_failure(server, tool, {**args, "dry_run": flag})["field"] == "dry_run"
        assert tool_failure(server, "list_relations", {"include_invalidated": flag})["field"] == "include_invalidated"
        assert (
            tool_failure(server, "relation_versions", {"id": "relation:ab", "newest_first": flag})["field"]
            == "newest_first"
        )
    assert sorted(e["id"] for e in run(srv.list_entities())["items"]) == ["t:a", "t:b"]
    for tool, args in (
        ("list_decisions", {"status": "bogus"}),
        ("list_preferences", {"stance": "bogus"}),
        ("create_decision", {"title": "D", "steps": ["relation:ab"], "status": "bogus"}),
    ):
        assert tool_failure(server, tool, args)["error"].startswith("invalid arguments: ")


NUMBER_ARGUMENT_CASES = [
    ("list_entities", {"limit": "5"}, "limit: expected number"),
    ("list_entities", {"limit": True}, "limit: expected number"),
    ("retrieve", {"query": "x", "depth": "2"}, "depth: expected number"),
    ("check_answerable", {"question": "x", "depth": False}, "depth: expected number"),
    ("maintenance_decay", {"half_life_days": "30"}, "half_life_days: expected number"),
    ("maintenance_prune", {"min_relevance": True}, "min_relevance: expected number"),
    (
        "create_preference",
        {"subject_entity": "t:a", "key": "k", "value_entity": "t:b", "strength": "0.5"},
        "strength: expected number",
    ),
    ("create_decision", {"title": "t", "steps": None}, "steps: expected array"),
]


@pytest.mark.parametrize(("tool", "args", "message"), NUMBER_ARGUMENT_CASES)
def test_number_arguments_and_steps_are_checked_like_typescript(server, tool, args, message):
    assert tool_failure(server, tool, args) == {
        "error": f"invalid arguments: {message}",
        "error_type": "ValidationError",
        "code": "invalid_argument",
        "field": message.split(":")[0],
        "retryable": False,
        **error_links("invalid_argument"),
        "tool": tool,
    }


MCP_ERROR_CASES = [
    ("retrieve", {"query": "x", "k": 0}, "invalid arguments: k: must be >= 1", "k"),
    ("retrieve", {"query": "x", "max_nodes": -1}, "invalid arguments: max_nodes: must be >= 1", "max_nodes"),
    ("retrieve", {"query": "x", "budget_tokens": 0}, "invalid arguments: budget_tokens: must be >= 1", "budget_tokens"),
    ("retrieve", {"query": "x", "k": 9007199254740992}, "invalid arguments: k: must be <= 9007199254740991", "k"),
    ("list_entities", {"limit": -9007199254740992}, "invalid arguments: limit: must be >= -9007199254740991", "limit"),
    (
        "retrieve",
        {"query": "x", "as_of": "soon"},
        "invalid as_of: 'soon' is not an ISO 8601 date or time (e.g. 2024-01-02T03:04:05Z)",
        "as_of",
    ),
    ("check_answerable", {"question": "x", "depth": 0}, "invalid arguments: depth: must be >= 1", "depth"),
    ("maintenance_decay", {"half_life_days": 0}, "half_life_days must be greater than 0, got 0", None),
    ("maintenance_decay", {"half_life_days": -2.0}, "half_life_days must be greater than 0, got -2", None),
    (
        "maintenance_decay",
        {"now": "soon"},
        "invalid now: 'soon' is not an ISO 8601 date or time (e.g. 2024-01-02T03:04:05Z)",
        "now",
    ),
    ("maintenance_prune", {"min_relevance": 2}, "min_relevance must be between 0 and 1, got 2", None),
    (
        "maintenance_prune",
        {"older_than": "soon"},
        "invalid older_than: 'soon' is not an ISO 8601 date or time (e.g. 2024-01-02T03:04:05Z)",
        "older_than",
    ),
    (
        "insert_facts",
        {"facts": {}, "resolver": "bogus"},
        "invalid arguments: resolver: expected 'exact', 'default', 'fuzzy' or 'llm'",
        "resolver",
    ),
    (
        "insert_text",
        {"text": "x", "resolver": "bogus"},
        "invalid arguments: resolver: expected 'exact', 'default', 'fuzzy' or 'llm'",
        "resolver",
    ),
    (
        "create_preference",
        {"subject_entity": "t:a", "key": "k", "value_entity": "t:b", "strength": 2},
        "preference strength must be between 0 and 1, got 2",
        None,
    ),
    (
        "create_relation",
        {"from_entity": "t:a", "type": "R", "to_entity": "t:b", "evidence": [{"source_id": "s", "confidence": 2}]},
        "evidence confidence must be between 0 and 1, got 2",
        None,
    ),
    (
        "graph_diff",
        {"since": "soon"},
        "invalid since: 'soon' is not an ISO 8601 date or time (e.g. 2024-01-02T03:04:05Z)",
        "since",
    ),
]


@needs_mcp
@pytest.mark.parametrize(("tool", "args", "message", "field"), MCP_ERROR_CASES)
def test_330_bad_arguments_give_the_same_error_text_and_field_as_typescript(server, tool, args, message, field):
    failure = tool_failure(server, tool, args)
    assert (failure["error"], failure["code"], failure.get("field")) == (message, "invalid_argument", field)


@needs_mcp
def test_unknown_tool_is_a_structured_invalid_argument_error(server):
    assert tool_failure(server, "list_entitys", {}) == {
        "error": "unknown tool 'list_entitys'",
        "error_type": "ValidationError",
        "code": "invalid_argument",
        "retryable": False,
        **error_links("invalid_argument"),
        "tool": "list_entitys",
    }
    assert tool_failure(server, "nonexistent_tool", {"a": 1}) == {
        "error": "unknown tool 'nonexistent_tool'",
        "error_type": "ValidationError",
        "code": "invalid_argument",
        "retryable": False,
        "tool": "nonexistent_tool",
    }


def test_a_session_gets_each_code_hint_once_and_each_new_warning_code_hint(server):
    schema = {"entities": [{"name": "Person"}]}
    first = run(
        server.call_tool("insert_facts", {"facts": {"entities": [{"name": "B", "type": "Company"}]}, "schema": schema})
    )
    again = run(
        server.call_tool("insert_facts", {"facts": {"entities": [{"name": "C", "type": "Company"}]}, "schema": schema})
    )
    assert first.structured_content["warning_hints"] == {"unknown_entity_type": WARNING_HINTS["unknown_entity_type"]}
    assert "warning_hints" not in again.structured_content
    missing = tool_failure(server, "delete_entity", {"id": "company:bb"})
    assert missing["error"].endswith("; did you mean 'company:b'?")
    assert [missing["tool"], missing["hint"]] == ["delete_entity", HINTS["not_found"]]
    assert "hint" not in tool_failure(server, "delete_entity", {"id": "company:bb"})
    assert tool_failure(server, "list_entities", {"limit": "x"})["hint"] == HINTS["invalid_argument"]
    assert "hint" not in tool_failure(server, "list_entities", {"limit": "x"})
    other = srv.build_server()
    assert tool_failure(other, "delete_entity", {"id": "company:bb"})["hint"] == HINTS["not_found"]
    assert tool_failure(other, "list_entities", {"limit": "x"})["hint"] == HINTS["invalid_argument"]


def test_whole_floats_pass_as_integers_and_integers_as_numbers(server):
    assert json.loads(run(server.call_tool("list_entities", {"limit": 5.0})).content[0].text)["items"] == []
    decay = json.loads(run(server.call_tool("maintenance_decay", {"half_life_days": 7})).content[0].text)
    assert decay["half_life_days"] == 7


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


def test_run_cypher_rejects_an_empty_kuzu_param_with_the_parameter_field(server):
    if not KUZU:
        pytest.skip("the empty-container error is Kuzu-specific")
    failure = tool_failure(server, "run_cypher", {"query": "RETURN $x AS x", "params": {"x": []}})
    assert {key: failure[key] for key in ("error", "error_type", "code", "field", "tool")} == {
        "error": "parameter 'x' is an empty list, which Kuzu cannot type; pass a non-empty list",
        "error_type": "ValidationError",
        "code": "invalid_argument",
        "field": "x",
        "tool": "run_cypher",
    }


def test_facts_evidence_versions_dry_runs_and_decision_steps():
    with mcp_session():
        out = run(srv.insert_facts(AB_FACTS, source_id="s1", event_time="2020-05-01"))
        assert out["relations"][0]["event_time"] == "2020-05-01T00:00:00Z"
        again = run(srv.insert_facts(AB_FACTS, source_id="s2"))
        assert again["relations"][0]["event_time"] == "2020-05-01T00:00:00Z"
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
        assert [v["revision"] for v in run(srv.relation_versions("relation:ab"))] == [2, 1]

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


@needs_mcp
def test_graph_diff_tool_returns_structured_changes_and_validates_window(server):
    run(srv.insert_facts(AB_FACTS))
    result = run(server.call_tool("graph_diff", {"since": "2000-01-01", "until": "2099-01-01"}))
    assert [r["id"] for r in result.structured_content["relations_added"]] == ["relation:ab"]
    assert [e["id"] for e in result.structured_content["entities_created"]] == ["t:a", "t:b"]
    failure = tool_failure(server, "graph_diff", {"since": "2021-01-01", "until": "2020-01-01"})
    assert (failure["error"], failure["code"]) == ("until must be at or after since", "invalid_argument")


def test_proto_keys_are_rejected_by_mcp():
    with mcp_session(namespace="proto_mcp"):
        for fields in [{"properties": {"__proto__": "x"}}, {"external_ids": {"__proto__": "x"}}]:
            with pytest.raises(ValidationError, match="^property and external id keys cannot be '__proto__'$"):
                run(srv.create_entity("Ann", "Person", **fields))
        with pytest.raises(ValidationError, match="^property and external id keys cannot be '__proto__'$"):
            run(
                srv.insert_facts(
                    {"entities": [{"name": "Ann", "type": "Person", "properties": {"nested": [{"__proto__": "x"}]}}]}
                )
            )


@needs_mcp
def test_unexpected_tool_errors_come_back_coded_and_mask_credentials(monkeypatch):
    uri = "bolt://user:store-secret@db.example:7687"
    base_url = "https://proxy:llm-secret@llm.example/v1"
    monkeypatch.setattr(srv, "_settings", srv.GraphSettings(store="neo4j", uri=uri, llm_base_url=base_url))

    async def insert_facts(**kwargs):
        raise RuntimeError(f"driver blew up talking to {uri} and {base_url}")

    error = run(srv._tool(insert_facts, set())()).structured_content
    assert (error["error_type"], error["code"]) == ("InternalError", "internal_error")
    assert "store-secret" not in error["error"] and "llm-secret" not in error["error"]
    assert "bolt://***@db.example:7687" in error["error"]
    assert "https://***@llm.example/v1" in error["error"]

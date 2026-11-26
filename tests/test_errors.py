import ast
import asyncio
import errno
import pathlib
import re
import socket
import sys
import types
from decimal import InvalidOperation
from typing import get_args

import pytest
from helpers import DriverError, FakeLLM, error_links, new_graph, run, unique_ns

from selfgraph import (
    Extraction,
    HydraDBStore,
    KuzuStore,
    LLMConfig,
    Neo4jStore,
    NotFoundError,
    SelfGraph,
    StoreError,
    TransientError,
)
from selfgraph._serde import decode_entity
from selfgraph.errors import (
    HINTS,
    WARNING_HINTS,
    ErrorCode,
    SelfGraphError,
    connection_reason,
    escape_controls,
    internal_error,
)
from selfgraph.llm.base import _fatal
from selfgraph.mcp.server import run_cypher
from selfgraph.models import as_input
from selfgraph.resolution import ResolutionDecision
from selfgraph.runtime import GraphSettings, check_settings
from selfgraph.stores.kuzu import _kuzu_error

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = (ROOT / "docs" / "errors.md").read_text()
CLOSED_PORT = "bolt://127.0.0.1:1"
PEOPLE = {
    "entities": [
        {"name": "Ada", "type": "Person"},
        {"name": "Acme", "type": "Company"},
        {"name": "Globex", "type": "Company"},
    ]
}
WORKS_AT = {"from_entity": "person:ada", "type": "WORKS_AT"}


def _warning_codes():
    """Every literal code= an InsertWarning call names in the source.

    @return (set[str]): the codes.
    """
    found = set()
    for path in (ROOT / "src" / "selfgraph").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "InsertWarning":
                found |= {k.value.value for k in node.keywords if k.arg == "code" and isinstance(k.value, ast.Constant)}
    return found


class _ProviderError(Exception):
    def __init__(self, status_code: int) -> None:
        """An LLM provider error with an HTTP status.

        @param status_code (int): the status.
        """
        super().__init__(f"provider answered {status_code}")
        self.status_code = status_code


class _Resolver:
    def __init__(self, target: str) -> None:
        """A resolver that folds every candidate into one id.

        @param target (str): the id to return.
        """
        self.target = target

    async def resolve(self, candidate, existing):
        return ResolutionDecision(target_id=self.target, confidence=1.0, reason="test")


class _BusyGraph:
    async def query(self, query, params):
        raise RuntimeError("Query timed out")


def _busy_falkordb(monkeypatch):
    """A FalkorDBStore, over a stand-in client module, whose graph times out every query.

    @param monkeypatch (pytest.MonkeyPatch): the test's monkeypatch.
    @return (FalkorDBStore): the store.
    """
    module = types.ModuleType("falkordb.asyncio")
    module.FalkorDB = type("FalkorDB", (), {"__init__": lambda self, host=None, port=None: None})
    monkeypatch.setitem(sys.modules, "falkordb", types.ModuleType("falkordb"))
    monkeypatch.setitem(sys.modules, "falkordb.asyncio", module)
    from selfgraph.stores.falkordb import FalkorDBStore

    store = FalkorDBStore()
    store._graph = _BusyGraph()
    return store


def _without_kuzu(monkeypatch, path):
    """Open a KuzuStore while the kuzu package cannot be imported.

    @param monkeypatch (pytest.MonkeyPatch): the test's monkeypatch.
    @param path (str): the database path.
    @return (KuzuStore): the store; raises StoreError first.
    """
    with monkeypatch.context() as patch:
        patch.setitem(sys.modules, "kuzu", None)
        return KuzuStore(path)


def _unreadable_decimal(monkeypatch, path):
    """Run a statement on a KuzuStore whose driver cannot read a DECIMAL, as Kuzu 0.11.3 does for -0.05.

    @param monkeypatch (pytest.MonkeyPatch): the test's monkeypatch.
    @param path (str): the database path.
    @return (Coroutine): the run_cypher call.
    """

    def get_next():
        raise InvalidOperation

    result = types.SimpleNamespace(get_column_names=lambda: ["v"], has_next=lambda: True, get_next=get_next)
    connection = types.SimpleNamespace(execute=lambda query, parameters=None: result)

    class Database:
        def __init__(self, path, read_only=False, **options):
            pass

    driver = types.SimpleNamespace(Database=Database, Connection=lambda database: connection)
    with monkeypatch.context() as patch:
        patch.setitem(sys.modules, "kuzu", driver)
        store = KuzuStore(path)
    return store.run_cypher("RETURN 1")


def _raise(exc):
    """Raise the error a mapping function returned.

    @param exc (BaseException): the error.
    @return (None): nothing; raises exc.
    """
    raise exc


def _code(call):
    """The code of the SelfGraphError a call raises, or of a coroutine it returns.

    @param call (Callable[[], Any]): the call.
    @return (str | None): the code, or None when nothing was raised.
    """
    try:
        result = call()
        if asyncio.iscoroutine(result):
            run(result)
    except SelfGraphError as exc:
        return exc.code
    return None


def _sections(start, end):
    """The first paragraph of each code section between two second-level headings of docs/errors.md.

    @param start (str): the heading the sections follow.
    @param end (str): the heading after them.
    @return (dict[str, str]): the paragraph by code, as one line of text.
    """
    part = DOCS[DOCS.index(f"\n## {start}\n") : DOCS.index(f"\n## {end}\n")]
    found = re.finditer(r"^#### `(\w+)`\n\n(.*?)(?=\n\n|\n#|\Z)", part, re.S | re.M)
    return {m.group(1): " ".join(m.group(2).split()) for m in found}


def test_every_code_is_documented_and_its_hint_is_the_first_paragraph_of_its_section():
    assert _sections("Codes", "Messages") == HINTS
    assert get_args(ErrorCode) == tuple(HINTS)
    assert _sections("Warning codes", "Warnings and logging") == WARNING_HINTS
    assert _warning_codes() <= WARNING_HINTS.keys()


def test_every_code_comes_back_from_a_real_call(monkeypatch, tmp_path):
    g = new_graph(namespace=unique_ns("codes"))
    run(g.insert.facts(PEOPLE))
    run(g.entities.create("Augusta", "Person", aliases=["Augusta Ada"]))
    merged = run(
        g.insert.facts(
            {
                "entities": [{"name": "Augusta Ada", "type": "Person"}],
                "relations": [{**WORKS_AT, "from_entity": "person:augusta-ada", "to_entity": "company:acme"}],
            }
        )
    )
    merge_id, moved = merged.merges[0].id, merged.relations[0].id
    run(g.relations.certify(moved, by="test"))
    codes = {"relation_certified": _code(lambda: g.entities.unmerge(merge_id))}
    run(g.relations.uncertify(moved))
    run(g.entities.unmerge(merge_id))
    schema = {"relations": [{"type": "WORKS_AT", "from": {"types": ["Person"], "max_count": 1}}]}
    gs = new_graph(store=g.store, namespace=unique_ns("codes"), schema=schema, contradiction="supersede")
    run(
        gs.insert.facts(
            {**PEOPLE, "relations": [{**WORKS_AT, "to_entity": "company:acme", "event_time": "2024-01-01"}]}
        )
    )
    retired = run(gs.relations.list()).items[0].id
    run(gs.insert.facts({"relations": [{**WORKS_AT, "to_entity": "company:globex", "event_time": "2025-01-01"}]}))
    closed_graph = SelfGraph(store=HydraDBStore(CLOSED_PORT, auth="token"))
    run(closed_graph.close())
    closed_store = HydraDBStore(CLOSED_PORT, auth="token")
    run(closed_store.close())
    hydradb, no_token = HydraDBStore(CLOSED_PORT, auth="token"), HydraDBStore(CLOSED_PORT)
    llm = LLMConfig(provider="openai", model="gpt-4o-mini")
    strict = {"schema": {"entities": [{"name": "Person"}]}, "schema_mode": "strict"}
    triggers = {
        "invalid_argument": lambda: g.entities.list(limit=0),
        "unknown_key": lambda: Extraction(entities=[{"name": "A", "type": "Person", "bogus": 1}]),
        "invalid_setting": lambda: check_settings(GraphSettings(store="bogus")),
        "llm_required": lambda: check_settings(GraphSettings(level="max")),
        "embedder_required": lambda: SelfGraph(store=g.store, seeds="embeddings"),
        "schema_required": lambda: check_settings(GraphSettings(schema_mode="strict")),
        "schema_violation": lambda: g.insert.facts({"entities": [{"name": "Bo", "type": "Robot"}]}, **strict),
        "immutable_identity": lambda: g.entities.update("person:ada", type="Robot"),
        "unknown_reference": lambda: g.relations.create("person:ada", "KNOWS", "person:nobody"),
        "relation_invalidated": lambda: gs.relations.certify(retired, by="test"),
        "merge_reverted": lambda: g.entities.unmerge(merge_id),
        "invalid_cursor": lambda: g.entities.list(cursor="bogus"),
        "invalid_resolver_decision": lambda: g.insert.facts(
            {"entities": [{"name": "Cy", "type": "Person"}]}, resolver=_Resolver("person:nobody")
        ),
        "read_only_query": lambda: run_cypher("CREATE (n)"),
        "cypher_query_limit": lambda: g.run_cypher("RETURN 1 // " + " " * 65_536),
        "missing_package": lambda: _without_kuzu(monkeypatch, str(tmp_path / "missing")),
        "not_found": lambda: g.entities.delete("person:nobody"),
        "already_exists": lambda: g.entities.create("Ada", "Person"),
        "extraction_failed": lambda: SelfGraph(
            store=g.store, llm=FakeLLM({"_EntitiesOut": RuntimeError("boom")})
        ).insert.text("Ada."),
        "llm_auth_failed": lambda: _raise(_fatal(_ProviderError(401), llm, llm.model)),
        "llm_model_not_found": lambda: _raise(_fatal(_ProviderError(404), llm, llm.model)),
        "invalid_llm_output": lambda: SelfGraph(
            store=g.store, llm=FakeLLM({"_EntitiesOut": {"nothing": 1}})
        ).insert.text("Ada."),
        "invalid_prompt_template": lambda: SelfGraph(
            store=g.store, prompts={"entities": {"version": "v1", "system": "s", "user": "no placeholder"}}
        ),
        "invalid_stored_data": lambda: decode_entity({"id": "person:broken", "ns": "codes"}),
        "query_failed": lambda: g.run_cypher("RETURN ("),
        "inexact_value": lambda: _unreadable_decimal(monkeypatch, str(tmp_path / "unreadable")),
        "graph_closed": lambda: closed_graph.entities.list(),
        "store_closed": lambda: SelfGraph(store=closed_store).entities.list(),
        "store_unreachable": lambda: SelfGraph(store=Neo4jStore(CLOSED_PORT, auth=("neo4j", "pw"))).entities.list(),
        "store_locked": lambda: _raise(_kuzu_error(RuntimeError("IO exception: Could not set lock on file : g"), "x")),
        "store_auth_failed": lambda: _raise(no_token._error(DriverError("Neo.ClientError.Security.Unauthorized", ""))),
        "database_not_found": lambda: _raise(hydradb._error(DriverError("", "database does not exist"))),
        "wrong_engine": lambda: _raise(hydradb._error(DriverError("", "unsupported protocol version"))),
        "write_too_large": lambda: hydradb.upsert_node("n", "Entity", "x", {"id": "x", "blob": "x" * 3_000_000}),
        "write_conflict": lambda: _raise(hydradb._error(DriverError("", "transaction conflict"))),
        "store_busy": lambda: _busy_falkordb(monkeypatch).run_cypher("RETURN 1"),
        "internal_error": lambda: _raise(internal_error(RuntimeError("boom"))),
    }
    codes |= {code: _code(call) for code, call in triggers.items()}
    assert codes == {code: code for code in HINTS}


def test_the_identity_and_cursor_errors_name_their_argument():
    g = new_graph()
    run(g.insert.facts(PEOPLE))

    with pytest.raises(SelfGraphError) as raised:
        run(g.entities.update("person:ada", type="Robot"))
    assert (raised.value.code, raised.value.field) == ("immutable_identity", "type")

    with pytest.raises(SelfGraphError) as raised:
        run(g.entities.list(cursor="bogus"))
    assert (raised.value.code, raised.value.field) == ("invalid_cursor", "cursor")


def test_a_failed_connection_reads_in_plain_words():
    lookup = RuntimeError("Failed to DNS resolve address nohost.invalid:7687")
    lookup.__cause__ = socket.gaierror(socket.EAI_NONAME, "Name or service not known")
    refused = ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused")
    assert [connection_reason(lookup), connection_reason(refused)] == ["host not found", "connection refused"]


def test_an_error_carries_its_code_hint_retryability_and_both_docs_links():
    missing = NotFoundError("Entity", "person:nobody")
    assert missing.to_dict() == {
        "error": "Entity 'person:nobody' does not exist",
        "error_type": "NotFoundError",
        "code": "not_found",
        "retryable": False,
        **error_links("not_found"),
    }
    assert [TransientError().retryable, StoreError().retryable] == [True, False]


def test_a_missing_entity_names_the_namespace_and_the_closest_id_of_its_type():
    ns = unique_ns("missing")
    g = new_graph(namespace=ns)
    run(g.insert.facts({"entities": [{"name": "Ada", "type": "Person"}, {"name": "Acme", "type": "Company"}]}))
    with pytest.raises(NotFoundError) as near:
        run(g.entities.update("person:ad", name="Ad"))
    with pytest.raises(NotFoundError) as far:
        run(g.entities.delete("person:zzzz"))
    assert str(near.value) == f"Entity 'person:ad' does not exist in namespace '{ns}'; did you mean 'person:ada'?"
    assert str(far.value) == f"Entity 'person:zzzz' does not exist in namespace '{ns}'"
    run(g.insert.facts({"entities": [{"name": "Belxy", "type": "Person"}, {"name": "Kelvo", "type": "Person"}]}))
    with pytest.raises(NotFoundError, match="; did you mean 'person:kelvo'\\?$"):
        run(g.entities.delete("person:belvo"))
    run(g.insert.facts({"entities": [{"name": f"A{i:03d}", "type": "Person"} for i in range(500)]}))
    run(g.insert.facts({"entities": [{"name": "Zelda", "type": "Person"}]}))
    for typo in ("person:zeld", "person:zalda"):
        with pytest.raises(NotFoundError, match="; did you mean 'person:zelda'\\?$"):
            run(g.entities.delete(typo))


@pytest.mark.parametrize(
    ("facts", "code", "field"),
    [
        ({"entities": [{"name": "Ada", "type": "Person", "bogus": 1}]}, "unknown_key", "entities[0].bogus"),
        ({"entities": [{"type": "Person"}]}, "invalid_argument", "entities[0].name"),
    ],
)
def test_bad_input_names_the_field_at_fault(facts, code, field):
    with pytest.raises(SelfGraphError) as exc:
        Extraction(**facts)
    assert (exc.value.code, exc.value.to_dict()["field"]) == (code, field)


@pytest.mark.parametrize("facts", [{1: "x"}, {None: []}, {(1, 2): "y"}])
def test_a_non_string_top_level_key_is_a_coded_error(facts):
    with pytest.raises(SelfGraphError) as exc:
        as_input(Extraction, facts, "facts")
    assert exc.value.code == "unknown_key"
    assert "keys must be strings" in str(exc.value)


@pytest.mark.parametrize(
    ("settings", "code", "field"),
    [
        ({"store": "bogus"}, "invalid_setting", "store"),
        ({"level": "max"}, "llm_required", None),
        ({"schema_mode": "strict"}, "schema_required", None),
        ({"llm_timeout": "-1"}, "invalid_setting", "llm_timeout"),
    ],
)
def test_settings_fail_with_a_narrow_code(settings, code, field):
    with pytest.raises(SelfGraphError) as exc:
        check_settings(GraphSettings(**settings))
    assert (exc.value.code, exc.value.to_dict().get("field")) == (code, field)


def test_query_failed_escapes_control_characters():
    assert escape_controls("a\x1b[2Jb\nc\td\x00\x7f\x85e") == "a\\x1b[2Jb\\nc\\td\\x00\\x7f\\x85e"
    assert escape_controls("a\u202eb") == "a\\u202eb"
    assert escape_controls("a\u200bb\u200cc\u200dd\ufeffe") == "a\\u200bb\\u200cc\\u200dd\\ufeffe"
    assert escape_controls("a\u2066b\u2069c") == "a\\u2066b\\u2069c"
    assert escape_controls("hello world") == "hello world"
    detail = _kuzu_error(RuntimeError("a\tb  c\x85d\u202ee"), "Kuzu query failed")
    assert str(detail) == "Kuzu query failed: a\\tb c\\x85d\\u202ee"
    assert "\t" not in str(detail) and "\x85" not in str(detail) and "\u202e" not in str(detail)
    with pytest.raises(StoreError) as exc:
        run(new_graph().run_cypher("RETURN (\x1b[2J"))
    assert exc.value.code == "query_failed"
    assert "\x1b" not in str(exc.value)
    assert "\\x1b" in str(exc.value)


@pytest.mark.parametrize("kind", ["list", "map"])
def test_cypher_result_depth_is_a_coded_error(kind):
    from selfgraph.errors import ValidationError
    from selfgraph.models import CypherResult

    value = 1
    for _ in range(254):
        value = [value] if kind == "list" else {"a": value}
    assert CypherResult(rows=[{"x": value}]).rows == [{"x": value}]
    value = [value] if kind == "list" else {"a": value}
    with pytest.raises(ValidationError) as caught:
        CypherResult(rows=[{"x": value}])
    assert caught.value.code == "invalid_argument"
    assert caught.value.field == "rows"
    assert str(caught.value) == "run_cypher result exceeds the maximum nesting depth of 254"

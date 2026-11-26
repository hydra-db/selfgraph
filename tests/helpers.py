from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager, nullcontext, suppress
from datetime import datetime, timezone
from typing import Any

import pytest

import selfgraph
from selfgraph import Neo4jStore, SelfGraph
from selfgraph.errors import HINTS


def _env(*names, default=None):
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return default


TEST_STORE = (
    (os.environ.get("SELFGRAPH_TEST_STORE") or _env("SELFGRAPH_TEST_STORES", default="neo4j").split(",")[0])
    .strip()
    .lower()
)
HYDRADB = TEST_STORE == "hydradb"
CYPHER = TEST_STORE in ("cypher", "memgraph")
FALKORDB = TEST_STORE == "falkordb"
KUZU = TEST_STORE == "kuzu"
RAW_CYPHER = not (HYDRADB or KUZU)
AUTO_COMMIT = HYDRADB or KUZU or FALKORDB
NEO4J_URI = _env("SG_NEO4J_URI", "NEO4J_URI", default="bolt://127.0.0.1:7687")
CYPHER_URI = _env("SG_MEMGRAPH_URI", "CYPHER_URI", default="bolt://127.0.0.1:7688")
FALKOR_HOST = _env("FALKOR_HOST", default="localhost")
FALKOR_PORT = int(_env("SG_FALKOR_PORT", "FALKOR_PORT", default="6380"))
KUZU_PATH = _env("KUZU_PATH", default="/tmp/selfgraph_kuzu_test")
HYDRADB_URI = _env("SG_HYDRADB_URI", "HYDRADB_URI", default="bolt://127.0.0.1:17687")
HYDRADB_TOKEN = _env("SG_HYDRADB_TOKEN", "HYDRADB_TOKEN", default="local-dev-auth-token-32-characters-long")
skip_on_falkordb = pytest.mark.skipif(FALKORDB, reason="raw Cypher delete semantics are Neo4j dialect")
skip_on_generic = pytest.mark.skipif(not RAW_CYPHER, reason="raw Cypher is the Neo4j dialect, not a generic backend")
WORKS_AT_SPEC = {
    "entities": [{"name": "Person"}, {"name": "Company"}],
    "relations": [{"type": "WORKS_AT", "from": {"types": ["Person"], "max_count": 1}}],
}
ANN_ACME_GLOBEX = [
    {"type": "Person", "name": "Ann"},
    {"type": "Company", "name": "Acme"},
    {"type": "Company", "name": "Globex"},
]
AB_FACTS = {
    "entities": [{"name": "A", "type": "T", "id": "t:a"}, {"name": "B", "type": "T", "id": "t:b"}],
    "relations": [{"id": "relation:ab", "from_entity": "t:a", "type": "KNOWS", "to_entity": "t:b"}],
}

_LOOP = None


def run(coro):
    """Run a coroutine on a single persistent loop so loop-bound drivers are reusable.

    @param coro (Any): the coroutine to run.
    @return (Any): the coroutine's result.
    """
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
    return _LOOP.run_until_complete(coro)


def neo4j_auth():
    password = os.environ.get("SG_NEO4J_PASSWORD")
    if password:
        return ("neo4j", password)
    raw = os.environ.get("NEO4J_AUTH")
    if not raw:
        return None
    user, _, password = raw.partition(":")
    return (user, password)


def _auth_str():
    auth = neo4j_auth()
    return f"{auth[0]}:{auth[1]}" if auth else None


OPEN_STORES: list = []


def make_store():
    """Open a store for the selected test backend, tracked so the test that opened it closes it.

    @return (Any): the store.
    """
    if HYDRADB:
        from selfgraph import HydraDBStore

        store = HydraDBStore(HYDRADB_URI, auth=("neo4j", HYDRADB_TOKEN), database="default")
    elif CYPHER:
        from selfgraph import CypherStore

        store = CypherStore(CYPHER_URI, auth=neo4j_auth())
    elif FALKORDB:
        from selfgraph import FalkorDBStore

        store = FalkorDBStore(host=FALKOR_HOST, port=FALKOR_PORT, graph="selfgraph_test")
    elif KUZU:
        from selfgraph import KuzuStore

        store = KuzuStore(KUZU_PATH)
    else:
        store = Neo4jStore(NEO4J_URI, auth=neo4j_auth())
    OPEN_STORES.append(store)
    return store


def store_settings(**over):
    from selfgraph.runtime import GraphSettings

    if HYDRADB:
        return GraphSettings(store="hydradb", uri=HYDRADB_URI, auth=f"neo4j:{HYDRADB_TOKEN}", **over)
    if CYPHER:
        return GraphSettings(store="cypher", uri=CYPHER_URI, auth=_auth_str(), **over)
    if FALKORDB:
        return GraphSettings(store="falkordb", uri=f"{FALKOR_HOST}:{FALKOR_PORT}", **over)
    if KUZU:
        return GraphSettings(store="kuzu", uri=KUZU_PATH, **over)
    return GraphSettings(store="neo4j", uri=NEO4J_URI, auth=_auth_str(), **over)


def unique_ns(prefix: str) -> str:
    """Return a namespace no other test run shares.

    @param prefix (str): a readable prefix.
    @return (str): the namespace.
    """
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def new_graph(**kwargs) -> SelfGraph:
    store = kwargs.pop("store", None) or make_store()
    namespace = kwargs.pop("namespace", None) or "default"
    graph = SelfGraph(store=store, namespace=namespace, **kwargs)
    run(graph.initialize())
    return graph


def fresh_graph(prefix: str = "test", **kwargs) -> SelfGraph:
    return new_graph(namespace=unique_ns(prefix), **kwargs)


def employment_graph(prefix: str = "test", **kwargs) -> SelfGraph:
    g = fresh_graph(prefix, schema=WORKS_AT_SPEC, **kwargs)
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX}))
    return g


def interrupt_write(
    g: SelfGraph,
    write: Any,
    monkeypatch: Any,
    *,
    method: str = "create_edge",
    while_stuck: Callable[[], Awaitable[None]] | None = None,
) -> None:
    """Cancel a write after it retires the current version and before it creates the next one.

    @param g (SelfGraph): the graph on an auto-commit store.
    @param write (Any): the write coroutine to interrupt.
    @param monkeypatch (Any): the pytest monkeypatch fixture.
    @param method (str): the store method that blocks, "create_edge", or "create_edges", which writes the first row.
    @param while_stuck (Callable[[], Awaitable[None]] | None): runs while the write is cut off, in its outer transaction.
    @return (None): nothing.
    """

    async def interrupted() -> None:
        reached = asyncio.Event()
        original = getattr(g.store, method)

        async def hang(ns: str, *args: Any) -> Any:
            if reached.is_set():
                return await original(ns, *args)
            if method == "create_edges":
                *ends, rows = args
                await original(ns, *ends, rows[:1])
            reached.set()
            await asyncio.Event().wait()

        with monkeypatch.context() as patch:
            patch.setattr(g.store, method, hang)
            async with g.store.transaction() if while_stuck else nullcontext():
                task = asyncio.ensure_future(write)
                waiter = asyncio.ensure_future(reached.wait())
                try:
                    await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
                    if not reached.is_set():
                        await task
                        raise AssertionError("the write ended before it was cut off")
                    if while_stuck is not None:
                        await while_stuck()
                finally:
                    waiter.cancel()
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task

    run(interrupted())


STORE_WRITES = (
    "upsert_node",
    "upsert_nodes",
    "create_edge",
    "create_edges",
    "delete_node",
    "delete_nodes",
    "delete_nodes_by",
    "delete_edges",
    "delete_edges_touching_by_type",
)


@contextmanager
def cut_store_write(g: SelfGraph, monkeypatch: Any, cut: int | None = None) -> Iterator[list[str]]:
    """Count the store writes made in the block and fail the one at an index, as a lost connection does.

    @param g (SelfGraph): the graph on an auto-commit store.
    @param monkeypatch (Any): the pytest monkeypatch fixture.
    @param cut (int | None): the index of the write to fail, or None to only count.
    @return (Iterator[list[str]]): the names of the writes made so far, the failed one included.
    """
    calls: list[str] = []

    def counting(name: str) -> Callable[..., Awaitable[Any]]:
        """Wrap one store write so it is counted and raises when it is the one to cut.

        @param name (str): the store method.
        @return (Callable[..., Awaitable[Any]]): the wrapped method.
        """
        original = getattr(g.store, name)

        async def wrapped(*args: Any, **kwargs: Any) -> Any:
            """Count the write, then fail it or run it.

            @return (Any): what the store method returns.
            """
            calls.append(name)
            if len(calls) - 1 == cut:
                raise ConnectionError("connection lost")
            return await original(*args, **kwargs)

        return wrapped

    with monkeypatch.context() as patch:
        for name in STORE_WRITES:
            patch.setattr(g.store, name, counting(name))
        yield calls


def utc(year: int, month: int = 1, day: int = 1) -> datetime:
    return datetime(year, month, day, tzinfo=timezone.utc)


def works_at(company: str, year: int | None = None, person: str = "ann", **extra) -> dict[str, Any]:
    rel = {"from_entity": f"person:{person}", "type": "WORKS_AT", "to_entity": f"company:{company}", **extra}
    if year is not None:
        rel["event_time"] = f"{year}-01-01T00:00:00+00:00"
    return rel


def create_entities(g: SelfGraph, *specs: str) -> None:
    for spec in specs:
        type_, _, name = spec.partition(":")
        run(g.entities.create(name, type_))


def t_entities(g: SelfGraph, *names: str) -> None:
    create_entities(g, *(f"T:{name.upper()}" for name in names))


def json_file(tmp_path: Any, name: str, data: Any) -> str:
    path = tmp_path / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


def preference_update_recorder() -> tuple[Any, list[tuple[str, dict[str, Any]]]]:
    calls: list[tuple[str, dict[str, Any]]] = []

    class Preferences:
        async def update(self, id: str, **changes: Any) -> dict[str, Any]:
            calls.append((id, changes))
            return {}

    class Graph:
        preferences = Preferences()

    return Graph(), calls


def cli(g: SelfGraph, argv: list[str], capsys: Any) -> Any:
    from selfgraph.cli import build_parser, dispatch

    run(dispatch(g, build_parser().parse_args(argv)))
    return json.loads(capsys.readouterr().out)


def error_links(code: str) -> dict[str, str]:
    """The hint and both docs links an error of a code carries.

    @param code (str): the error code.
    @return (dict[str, str]): hint, docs, and agent_guide.
    """
    return {
        "hint": HINTS[code],
        "docs": f"https://github.com/hydra-db/selfgraph/blob/v{selfgraph.__version__}/docs/errors.md#{code}",
        "agent_guide": f"site-packages/selfgraph/errors.md#{code}",
    }


def cli_error(code: str, message: str, command: str, field: str | None = None) -> str:
    """The stderr text the CLI prints for a SelfGraph error.

    @param code (str): the error code.
    @param message (str): the message.
    @param command (str): the command that failed, such as "selfgraph entity get".
    @param field (str | None): the field at fault, when one is.
    @return (str): the lines, ending in a newline.
    """
    links = error_links(code)
    lines = [f"error[{code}]: {message}", f"command: {command}", *([f"field: {field}"] if field else [])]
    lines += [f"hint: {links['hint']}", f"docs: {links['docs']}", f"agent guide: {links['agent_guide']}"]
    return "\n".join(lines) + "\n"


def kuzu_main(tmp_path: Any, *argv: str) -> int:
    pytest.importorskip("kuzu")
    from selfgraph.cli import main

    return main(["--store", "kuzu", "--uri", str(tmp_path / "cli.kuzu"), *argv])


@contextmanager
def mcp_session(prefix: str = "mcp", **over) -> Iterator[Any]:
    import selfgraph.mcp.server as srv

    run(srv.close())
    over.setdefault("namespace", unique_ns(prefix))
    run(srv.configure(store_settings(**over)))
    try:
        yield srv
    finally:
        run(srv.close())


class DriverError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class FakeLLM:
    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        """An LLM client that returns scripted structured output per schema type.

        @param responses (dict[str, Any] | None): maps an output class name to an instance, an exception to raise, or a callable (system, user) -> instance. Unmapped types return an empty instance.
        """
        self.responses = responses or {}
        self.calls: list[tuple[str, str, str]] = []

    async def generate(self, *, system: str, user: str, output: type) -> Any:
        self.calls.append((output.__name__, system, user))
        spec = self.responses.get(output.__name__)
        if spec is None:
            return output()
        if isinstance(spec, BaseException):
            raise spec
        if isinstance(spec, Callable):
            return spec(system, user)
        return spec


def extracting_llm(entities: list[tuple[str, str]], relations: list[tuple[str, str, str]] = ()) -> FakeLLM:
    from selfgraph.extraction.extractor import _EntitiesOut, _EntityOut, _RelationsOut, _RelOut

    return FakeLLM(
        {
            "_EntitiesOut": _EntitiesOut(entities=[_EntityOut(type=t, name=n) for t, n in entities]),
            "_RelationsOut": _RelationsOut(
                relations=[_RelOut(from_name=a, type=b, to_name=c) for a, b, c in relations]
            ),
        }
    )


def instant():
    time.sleep(0.01)
    stamp = datetime.now(timezone.utc)
    time.sleep(0.01)
    return stamp

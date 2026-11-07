from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from typing import Any

import pytest

from selfgraph import Neo4jStore, SelfGraph


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
skip_on_hydradb = pytest.mark.skipif(HYDRADB, reason="raw Cypher is Neo4j dialect")
CYPHER = TEST_STORE in ("cypher", "memgraph")
FALKORDB = TEST_STORE == "falkordb"
NEO4J_URI = _env("SG_NEO4J_URI", "NEO4J_URI", default="bolt://127.0.0.1:7687")
CYPHER_URI = _env("SG_MEMGRAPH_URI", "CYPHER_URI", default="bolt://127.0.0.1:7688")
FALKOR_HOST = _env("FALKOR_HOST", default="localhost")
FALKOR_PORT = int(_env("SG_FALKOR_PORT", "FALKOR_PORT", default="6380"))
KUZU = TEST_STORE == "kuzu"
KUZU_PATH = _env("KUZU_PATH", default="/tmp/selfgraph_kuzu_test")
skip_on_falkordb = pytest.mark.skipif(FALKORDB, reason="raw Cypher delete semantics are Neo4j dialect")
RAW_CYPHER = not (HYDRADB or KUZU)
skip_on_generic = pytest.mark.skipif(HYDRADB or KUZU, reason="raw Cypher is the Neo4j dialect, not a generic backend")
HYDRADB_URI = _env("SG_HYDRADB_URI", "HYDRADB_URI", default="bolt://127.0.0.1:17687")
HYDRADB_TOKEN = _env("SG_HYDRADB_TOKEN", "HYDRADB_TOKEN", default="local-dev-auth-token-32-characters-long")


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


def _neo4j_auth():
    password = os.environ.get("SG_NEO4J_PASSWORD")
    if password:
        return ("neo4j", password)
    raw = os.environ.get("NEO4J_AUTH")
    if not raw:
        return None
    user, _, password = raw.partition(":")
    return (user, password)


def _auth_str():
    auth = _neo4j_auth()
    return f"{auth[0]}:{auth[1]}" if auth else None


def make_store():
    if TEST_STORE == "hydradb":
        from selfgraph import HydraDBStore

        return HydraDBStore(HYDRADB_URI, auth=("neo4j", HYDRADB_TOKEN), database="default")
    if CYPHER:
        from selfgraph import CypherStore

        return CypherStore(CYPHER_URI, auth=_neo4j_auth())
    if FALKORDB:
        from selfgraph import FalkorDBStore

        return FalkorDBStore(host=FALKOR_HOST, port=FALKOR_PORT, graph="selfgraph_test")
    if KUZU:
        from selfgraph import KuzuStore

        return KuzuStore(KUZU_PATH)
    return Neo4jStore(NEO4J_URI, auth=_neo4j_auth())


def store_settings(**over):
    from selfgraph.runtime import GraphSettings

    if TEST_STORE == "hydradb":
        return GraphSettings(store="hydradb", uri=HYDRADB_URI, auth=f"neo4j:{HYDRADB_TOKEN}", **over)
    if CYPHER:
        return GraphSettings(store="cypher", uri=CYPHER_URI, auth=_auth_str(), **over)
    if FALKORDB:
        return GraphSettings(store="falkordb", uri=f"{FALKOR_HOST}:{FALKOR_PORT}", **over)
    if KUZU:
        return GraphSettings(store="kuzu", uri=KUZU_PATH, **over)
    return GraphSettings(store="neo4j", uri=NEO4J_URI, auth=_auth_str(), **over)


def new_graph(**kwargs) -> SelfGraph:
    store = kwargs.pop("store", None) or make_store()
    namespace = kwargs.pop("namespace", None) or "default"
    graph = SelfGraph(store=store, namespace=namespace, **kwargs)
    run(graph.initialize())
    return graph


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

from __future__ import annotations

import asyncio
import inspect
import threading
from typing import Any

from .client import SelfGraph

__all__ = ["SyncSelfGraph"]


class _SyncProxy:
    def __init__(self, target: Any, run) -> None:
        self._target = target
        self._run = run

    def __getattr__(self, name: str):
        attr = getattr(self._target, name)
        if not callable(attr):
            return attr

        def call(*args, **kwargs):
            result = attr(*args, **kwargs)
            if inspect.iscoroutine(result):
                return self._run(result)
            if inspect.isasyncgen(result):
                return self._drain(result)
            return result

        return call

    def _drain(self, agen):
        while True:
            try:
                yield self._run(agen.__anext__())
            except StopAsyncIteration:
                return


class SyncSelfGraph:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._bind(SelfGraph(*args, **kwargs))

    @classmethod
    def from_env(cls, **overrides: Any) -> SyncSelfGraph:
        """Build a graph from SELFGRAPH_* environment variables.

        @param overrides (Any): GraphSettings fields that take precedence over the environment.
        @return (SyncSelfGraph): the constructed graph.
        """
        return cls._of(SelfGraph.from_env(**overrides))

    @classmethod
    def connect(cls, **settings: Any) -> SyncSelfGraph:
        """Build a graph from store and LLM settings without importing a store class.

        @param settings (Any): GraphSettings fields such as store, uri, auth, namespace, llm_provider, llm_model.
        @return (SyncSelfGraph): the constructed graph.
        """
        return cls._of(SelfGraph.connect(**settings))

    @classmethod
    def _of(cls, graph: SelfGraph) -> SyncSelfGraph:
        obj = cls.__new__(cls)
        obj._bind(graph)
        return obj

    def _bind(self, graph: SelfGraph) -> None:
        self._loop = asyncio.new_event_loop()
        self._async = graph
        self.store = graph.store
        self.namespace = graph.namespace
        self.entities = _SyncProxy(graph.entities, self._run)
        self.relations = _SyncProxy(graph.relations, self._run)
        self.preferences = _SyncProxy(graph.preferences, self._run)
        self.decisions = _SyncProxy(graph.decisions, self._run)
        self.insert = _SyncProxy(graph.insert, self._run)

    def _run(self, coro):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return self._loop.run_until_complete(coro)

        out: dict[str, Any] = {}

        def worker() -> None:
            try:
                out["value"] = self._loop.run_until_complete(coro)
            except BaseException as exc:  # noqa: BLE001
                out["error"] = exc

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()
        if "error" in out:
            raise out["error"]
        return out["value"]

    def initialize(self) -> None:
        """Create the store's ID constraints and indexes.

        @return (None): nothing.
        """
        return self._run(self._async.initialize())

    def close(self) -> None:
        """Close the underlying store connection and the private event loop; safe to call twice.

        @return (None): nothing.
        """
        if self._loop.is_closed():
            return
        try:
            self._run(self._async.close())
        finally:
            if not self._loop.is_closed():
                self._loop.close()

    def run_cypher(self, *args: Any, **kwargs: Any):
        """Run one raw Cypher statement.

        @return (CypherResult): the resulting rows.
        """
        return self._run(self._async.run_cypher(*args, **kwargs))

    def retrieve(self, *args: Any, **kwargs: Any):
        """Retrieve graph context for a query.

        @return (RetrievalResult): the seeds, subgraph, and assembled context.
        """
        return self._run(self._async.retrieve(*args, **kwargs))

    def __enter__(self) -> SyncSelfGraph:
        """Initialize the store and return the graph for use in a with block.

        @return (SyncSelfGraph): this graph.
        """
        self.initialize()
        return self

    def __exit__(self, *exc: object) -> None:
        """Close the store on exit from a with block.

        @return (None): nothing.
        """
        self.close()

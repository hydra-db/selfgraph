from __future__ import annotations

import asyncio
import inspect
import threading
from typing import Any

from .client import SelfGraph
from .errors import CLOSED_MESSAGE, StoreError
from .schema import Schema

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
        self.maintenance = _SyncProxy(graph.maintenance, self._run)
        self.insert = _SyncProxy(graph.insert, self._run)

    @property
    def schema(self) -> Schema | None:
        """The graph-level schema, read-only.

        @return (Schema | None): the schema, or None when none is set.
        """
        return self._async.schema

    def _run(self, coro):
        if self._loop.is_closed():
            coro.close()
            raise StoreError(CLOSED_MESSAGE)
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
        return self._run(self._async.run_cypher(*args, **kwargs))

    def retrieve(self, *args: Any, **kwargs: Any):
        return self._run(self._async.retrieve(*args, **kwargs))

    def coverage(self, *args: Any, **kwargs: Any):
        return self._run(self._async.coverage(*args, **kwargs))

    @property
    def tiers(self) -> dict[str, str]:
        """The level and the tier each capability runs at by default.

        @return (dict[str, str]): the level, the cap, and each capability's default tier.
        """
        return self._async.tiers

    def __enter__(self) -> SyncSelfGraph:
        """Initialize the store and return the graph for use in a with block.

        @return (SyncSelfGraph): this graph.
        """
        self.initialize()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

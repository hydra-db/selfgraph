from __future__ import annotations

import inspect
from collections.abc import Mapping
from typing import Any

from ..errors import StoreError, TransientError, error_reason
from ..models import CypherResult, check_options
from ._cypher import WRITE_COUNTERS, AutoCommitStore, CypherPrimitives, graph_properties

__all__ = ["FalkorDBStore"]

_TRANSIENT_MARKERS = (
    "max pending queries",
    "too many connections",
    "timeout",
    "timed out",
    "busy",
    "deadlock",
    "try again",
)


def _to_json(value: Any) -> Any:
    """Convert FalkorDB graph values to plain JSON.

    @param value (Any): the value to convert.
    @return (Any): the plain-JSON equivalent.
    """
    props = getattr(value, "properties", None)
    if props is not None:
        return graph_properties(props.items(), _to_json)
    if isinstance(value, dict):
        return {k: _to_json(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_to_json(v) for v in value]
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    iso = getattr(value, "isoformat", None)
    return iso() if callable(iso) else str(value)


class FalkorDBStore(AutoCommitStore, CypherPrimitives):
    def __init__(
        self,
        host: str = "localhost",
        port: int = 6379,
        *,
        graph: str = "selfgraph",
        **client_kwargs: Any,
    ) -> None:
        try:
            from falkordb.asyncio import FalkorDB
        except ImportError as exc:  # pragma: no cover
            raise StoreError(
                "the 'falkordb' package is required for FalkorDBStore; pip install \"selfgraph[falkordb]\""
            ) from exc
        client_options = [
            p for p in inspect.signature(FalkorDB.__init__).parameters if p not in {"self", "host", "port"}
        ]
        check_options("FalkorDBStore", client_kwargs, ["graph", *client_options])
        self._FalkorDB = FalkorDB
        self._host, self._port, self._graph_name, self._client_kwargs = host, port, graph, client_kwargs
        self._db: Any = None
        self._graph: Any = None

    def _ensure_connected(self) -> None:
        """Connect to FalkorDB on first use so construction stays lazy like the other stores.

        @return (None): nothing; raises StoreError when the server is unreachable.
        """
        if self._graph is None:
            try:
                self._db = self._FalkorDB(host=self._host, port=self._port, **self._client_kwargs)
                self._graph = self._db.select_graph(self._graph_name)
            except Exception as exc:  # noqa: BLE001
                raise StoreError(
                    f"failed connecting to FalkorDB at {self._host}:{self._port}: {error_reason(exc)}"
                ) from exc

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        self._require_open()
        self._ensure_connected()
        try:
            res = await self._graph.query(query, dict(params or {}))
        except Exception as exc:  # noqa: BLE001
            lowered = str(exc).lower()
            if any(k in lowered for k in _TRANSIENT_MARKERS):
                raise TransientError(f"FalkorDB transient error: {exc}") from exc
            raise StoreError(f"FalkorDB query failed: {exc}") from exc
        columns = [head[-1] for head in (res.header or [])]
        rows = [{col: _to_json(val) for col, val in zip(columns, row, strict=False)} for row in (res.result_set or [])]
        counters = {name: int(getattr(res, name, 0) or 0) for name in WRITE_COUNTERS}
        return CypherResult(columns=columns, rows=rows, counters={k: v for k, v in counters.items() if v})

    async def initialize(self) -> None:
        """Create the FalkorDB graph key up front so concurrent first writes do not race on its creation.

        @return (None): nothing.
        """
        await self._run("CREATE (n:_SgInit) DELETE n")

    async def close(self) -> None:
        """Close the underlying connection; later calls fail with StoreError."""
        self._closed = True
        if self._db is None:
            return
        close = getattr(self._db, "aclose", None) or getattr(getattr(self._db, "connection", None), "aclose", None)
        if close is not None:
            await close()

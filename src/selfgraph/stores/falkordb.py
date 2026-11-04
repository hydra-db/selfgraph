from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..errors import StoreError
from ..models import CypherResult
from ._cypher import AutoCommitStore, CypherPrimitives

__all__ = ["FalkorDBStore"]

_COUNTERS = (
    "nodes_created",
    "nodes_deleted",
    "relationships_created",
    "relationships_deleted",
    "properties_set",
)


def _to_json(value: Any) -> Any:
    """Convert FalkorDB graph values to plain JSON.

    @param value (Any): the value to convert.
    @return (Any): the plain-JSON equivalent.
    """
    props = getattr(value, "properties", None)
    if props is not None:
        return dict(props)
    if isinstance(value, dict):
        return {k: _to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_json(v) for v in value]
    return value


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
                "the 'falkordb' package is required for FalkorDBStore; install selfgraph[falkordb]"
            ) from exc
        self._db = FalkorDB(host=host, port=port, **client_kwargs)
        self._graph = self._db.select_graph(graph)

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        try:
            res = await self._graph.query(query, dict(params or {}))
        except Exception as exc:  # noqa: BLE001
            raise StoreError(f"FalkorDB query failed: {exc}") from exc
        columns = [head[-1] for head in (res.header or [])]
        rows = [{col: _to_json(val) for col, val in zip(columns, row, strict=False)} for row in (res.result_set or [])]
        counters = {name: int(getattr(res, name, 0) or 0) for name in _COUNTERS}
        return CypherResult(columns=columns, rows=rows, counters={k: v for k, v in counters.items() if v})

    async def initialize(self) -> None:
        """Ready the store; FalkorDB needs no setup since ids are deterministic and upserts idempotent."""
        return None

    async def close(self) -> None:
        """Close the underlying connection."""
        close = getattr(self._db, "aclose", None) or getattr(getattr(self._db, "connection", None), "aclose", None)
        if close is not None:
            await close()

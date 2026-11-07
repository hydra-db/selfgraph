from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Mapping
from typing import Any

from ..errors import StoreError, ValidationError
from ..ids import quote_label
from ..models import CypherResult
from ._cypher import AutoCommitStore, count_of
from ._docrows import delete_both_ways, docs, edge_row, first_doc, merged_current_edge, relation_ids_both_ways

__all__ = ["KuzuStore"]

_SAFE_COLUMN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _normalize(value: Any) -> Any:
    """Convert a Kuzu result value to a JSON-ready value, matching the Bolt store's serialization.

    @param value (Any): a raw value from a Kuzu result row.
    @return (Any): the JSON-ready equivalent (ISO strings for temporals, hex for blobs, str for the rest).
    """
    if isinstance(value, dict):
        return {k if isinstance(k, str) else str(k): _normalize(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_normalize(v) for v in value]
    if isinstance(value, bytes | bytearray):
        return value.hex()
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    iso = getattr(value, "isoformat", None)
    if callable(iso):
        return iso()
    return str(value)


def _safe_order_by(order_by: str) -> str:
    """Validate an order_by column is a plain identifier before interpolation.

    @param order_by (str): the column name to order by.
    @return (str): the validated column name.
    """
    if not _SAFE_COLUMN.match(order_by):
        raise ValidationError(f"invalid order_by column {order_by!r}")
    return order_by


_SCHEMA = (
    "CREATE NODE TABLE IF NOT EXISTS N(pk STRING, id STRING, ns STRING, label STRING, doc STRING, PRIMARY KEY(pk))",
    "CREATE REL TABLE IF NOT EXISTS R(FROM N TO N, sid STRING, ns STRING, etype STRING, "
    "is_current BOOLEAN, revision INT64, doc STRING)",
)
_DATABASES: dict[str, Any] = {}
_OPEN_STORES: dict[str, int] = {}
_MAX_SKIP = 10_000_000


def _pk(ns: str, id: str) -> str:
    return f"{ns}\x00{id}"


def _jv(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


class KuzuStore(AutoCommitStore):
    def __init__(self, path: str = "selfgraph_kuzu", **db_kwargs: Any) -> None:
        try:
            import kuzu
        except ImportError as exc:  # pragma: no cover
            raise StoreError("the 'kuzu' package is required for KuzuStore; install 'selfgraph[kuzu]'") from exc
        if path not in _DATABASES:
            _DATABASES[path] = kuzu.Database(path, **db_kwargs)
        self._path = path
        self._db = _DATABASES[path]
        self._conn = kuzu.Connection(self._db)
        _OPEN_STORES[path] = _OPEN_STORES.get(path, 0) + 1
        self._lock = asyncio.Lock()

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        def _exec():
            if self._conn is None:
                raise StoreError("KuzuStore is closed")
            qr = self._conn.execute(query, parameters=dict(params or {}))
            if isinstance(qr, list):
                raise StoreError("Kuzu runs one statement per query; pass one statement, not several joined by ';'")
            columns = qr.get_column_names()
            rows = []
            while qr.has_next():
                rows.append({k: _normalize(v) for k, v in zip(columns, qr.get_next(), strict=False)})
            return columns, rows

        async with self._lock:
            try:
                columns, rows = await asyncio.to_thread(_exec)
                return CypherResult(columns=columns, rows=rows)
            except StoreError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise StoreError(f"Kuzu query failed: {exc}") from exc

    async def initialize(self) -> None:
        """Create the node and relationship tables if they do not exist."""
        for stmt in _SCHEMA:
            await self._run(stmt)

    async def close(self) -> None:
        """Close the connection, and the database once no other store in this process holds it.

        @return (None): nothing.
        """
        if self._conn is None:
            return
        async with self._lock:
            self._conn.close()
            self._conn = None
            _OPEN_STORES[self._path] -= 1
            if _OPEN_STORES[self._path] == 0:
                del _OPEN_STORES[self._path]
                _DATABASES.pop(self._path).close()

    @staticmethod
    def _where_equals(prefix: str, equals: dict | None, where: list[str], params: dict, start: int = 0) -> None:
        for i, (key, value) in enumerate(sorted((equals or {}).items()), start=start):
            where.append(f"json_extract({prefix}.doc, $k{i}) = $v{i}")
            params[f"k{i}"] = key
            params[f"v{i}"] = _jv(value)

    async def get_node(self, ns: str, label: str, id: str) -> dict | None:
        res = await self._run(
            "MATCH (n:N {pk:$pk}) WHERE n.label = $label RETURN n.doc AS doc",
            {"pk": _pk(ns, id), "label": label},
        )
        return first_doc(res.rows)

    async def node_exists(self, ns: str, label: str, id: str) -> bool:
        res = await self._run(
            "MATCH (n:N {pk:$pk}) WHERE n.label = $label RETURN n.pk AS pk",
            {"pk": _pk(ns, id), "label": label},
        )
        return bool(res.rows)

    async def upsert_node(self, ns: str, label: str, id: str, props: dict, *, extra_label: str | None = None) -> None:
        if extra_label is not None:
            quote_label(extra_label)
        await self._run(
            "MERGE (n:N {pk:$pk}) SET n.id = $id, n.ns = $ns, n.label = $label, n.doc = $doc",
            {"pk": _pk(ns, id), "id": id, "ns": ns, "label": label, "doc": _jv(props)},
        )

    async def remove_node_label(self, ns: str, label: str, id: str, drop_label: str) -> None:
        return None

    async def match_nodes(
        self,
        ns: str,
        label: str,
        *,
        equals: dict | None = None,
        order_by: str = "id",
        skip: int = 0,
        limit: int = 1000,
    ) -> list[dict]:
        if skip > _MAX_SKIP:
            return []
        where = ["n.ns = $ns", "n.label = $label"]
        params: dict[str, Any] = {"ns": ns, "label": label}
        self._where_equals("n", equals, where, params)
        ob = "n.id" if order_by == "id" else f"json_extract(n.doc, '{_safe_order_by(order_by)}')"
        res = await self._run(
            f"MATCH (n:N) WHERE {' AND '.join(where)} "
            f"RETURN n.doc AS doc ORDER BY {ob} SKIP {int(skip)} LIMIT {int(limit)}",
            params,
        )
        return docs(res.rows)

    async def delete_node(self, ns: str, label: str, id: str) -> None:
        await self._run("MATCH (n:N {pk:$pk}) DETACH DELETE n", {"pk": _pk(ns, id)})

    async def delete_nodes_by(self, ns: str, label: str, *, equals: dict) -> int:
        where = ["n.ns = $ns", "n.label = $label"]
        params: dict[str, Any] = {"ns": ns, "label": label}
        self._where_equals("n", equals, where, params)
        res = await self._run(f"MATCH (n:N) WHERE {' AND '.join(where)} RETURN n.pk AS pk", params)
        pks = [r["pk"] for r in res.rows]
        for pk in pks:
            await self._run("MATCH (n:N {pk:$pk}) DETACH DELETE n", {"pk": pk})
        return len(pks)

    async def create_edge(
        self, ns: str, type: str, from_label: str, from_id: str, to_label: str, to_id: str, props: dict
    ) -> bool:
        if not await self.node_exists(ns, from_label, from_id):
            return False
        if not await self.node_exists(ns, to_label, to_id):
            return False
        sid = props.get("id")
        rev = props.get("revision")
        params = {
            "f": _pk(ns, from_id),
            "t": _pk(ns, to_id),
            "sid": sid,
            "ns": ns,
            "et": type,
            "isc": props.get("is_current"),
            "rev": rev,
            "doc": _jv(props),
        }
        if sid is not None and rev is not None:
            query = (
                "MATCH (a:N {pk:$f}), (b:N {pk:$t}) "
                "MERGE (a)-[r:R {sid:$sid, ns:$ns, revision:$rev}]->(b) "
                "SET r.etype=$et, r.is_current=$isc, r.doc=$doc"
            )
        else:
            query = (
                "MATCH (a:N {pk:$f}), (b:N {pk:$t}) "
                "CREATE (a)-[r:R {sid:$sid, ns:$ns, etype:$et, is_current:$isc, revision:$rev, doc:$doc}]->(b)"
            )
        await self._run(query, params)
        return True

    async def get_current_edge(self, ns: str, id: str) -> dict | None:
        res = await self._run(
            "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid AND r.is_current = true "
            "RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et",
            {"ns": ns, "sid": id},
        )
        return edge_row(res.rows[0]) if res.rows else None

    async def list_edge_versions(self, ns: str, id: str) -> list[dict]:
        res = await self._run(
            "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid "
            "RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et, r.revision AS rev ORDER BY rev",
            {"ns": ns, "sid": id},
        )
        return [edge_row(r) for r in res.rows]

    async def update_current_edge(self, ns: str, id: str, props: dict) -> None:
        merged = await merged_current_edge(self, ns, id, props)
        if merged is None:
            return
        await self._run(
            "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid AND r.is_current = true "
            "SET r.doc = $doc, r.is_current = $isc, r.revision = $rev",
            {"ns": ns, "sid": id, "doc": _jv(merged), "isc": merged.get("is_current"), "rev": merged.get("revision")},
        )

    async def count_edges(self, ns: str, id: str) -> int:
        res = await self._run(
            "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid RETURN count(*) AS n",
            {"ns": ns, "sid": id},
        )
        return count_of(res.rows)

    async def delete_edges(self, ns: str, id: str) -> int:
        n = await self.count_edges(ns, id)
        if n:
            await self._run(
                "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid DELETE r",
                {"ns": ns, "sid": id},
            )
        return n

    async def match_edges(
        self,
        ns: str,
        *,
        from_label: str,
        to_label: str | None = None,
        type: str | None = None,
        from_id: str | None = None,
        to_id: str | None = None,
        from_in: list[str] | None = None,
        to_in: list[str] | None = None,
        current_only: bool = False,
        equals: dict | None = None,
        order_by: str = "id",
        skip: int = 0,
        limit: int = 1000,
    ) -> list[dict]:
        if skip > _MAX_SKIP:
            return []
        where = ["r.ns = $ns", "a.label = $fl"]
        params: dict[str, Any] = {"ns": ns, "fl": from_label}
        if to_label is not None:
            where.append("b.label = $tl")
            params["tl"] = to_label
        if current_only:
            where.append("r.is_current = true")
        if type is not None:
            where.append("r.etype = $etype")
            params["etype"] = type
        if from_id is not None:
            where.append("a.pk = $fpk")
            params["fpk"] = _pk(ns, from_id)
        if to_id is not None:
            where.append("b.pk = $tpk")
            params["tpk"] = _pk(ns, to_id)
        if from_in is not None:
            where.append("a.pk IN $fpks")
            params["fpks"] = [_pk(ns, i) for i in from_in]
        if to_in is not None:
            where.append("b.pk IN $tpks")
            params["tpks"] = [_pk(ns, i) for i in to_in]
        self._where_equals("r", equals, where, params)
        if order_by == "id":
            ob = "r.sid"
        elif order_by == "revision":
            ob = "r.revision"
        else:
            ob = f"json_extract(r.doc, '{_safe_order_by(order_by)}')"
        res = await self._run(
            f"MATCH (a:N)-[r:R]->(b:N) WHERE {' AND '.join(where)} "
            f"RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et "
            f"ORDER BY {ob} SKIP {int(skip)} LIMIT {int(limit)}",
            params,
        )
        return [edge_row(r) for r in res.rows]

    async def versioned_relation_ids(self, ns: str, label: str, id: str, *, exclude_types: list[str]) -> list[str]:
        where = ["r.ns = $ns", "x.label = $label", "r.revision IS NOT NULL"]
        params: dict[str, Any] = {"pk": _pk(ns, id), "ns": ns, "label": label}
        for i, t in enumerate(exclude_types):
            where.append(f"r.etype <> $ex{i}")
            params[f"ex{i}"] = t
        return await relation_ids_both_ways(self._run, "x:N {pk:$pk}", "r:R", "o:N", where, params)

    async def child_nodes(
        self,
        ns: str,
        parent_label: str,
        parent_id: str,
        edge_type: str,
        child_label: str,
        *,
        order_by: str | None = None,
    ) -> list[dict]:
        order = "" if order_by is None else f" ORDER BY json_extract(c.doc, '{_safe_order_by(order_by)}')"
        res = await self._run(
            "MATCH (p:N {pk:$pk})-[r:R]->(c:N) "
            f"WHERE r.ns = $ns AND r.etype = $et AND c.label = $cl RETURN c.doc AS doc{order}",
            {"pk": _pk(ns, parent_id), "ns": ns, "et": edge_type, "cl": child_label},
        )
        return docs(res.rows)

    async def count_out_edges(self, ns: str, label: str, id: str) -> int:
        res = await self._run(
            "MATCH (p:N {pk:$pk})-[r:R]->(o:N) WHERE r.ns = $ns RETURN count(*) AS n",
            {"pk": _pk(ns, id), "ns": ns},
        )
        return count_of(res.rows)

    async def count_in_edges_typed(self, ns: str, label: str, id: str, types: list[str]) -> int:
        params: dict[str, Any] = {"pk": _pk(ns, id), "ns": ns}
        ors = []
        for i, t in enumerate(types):
            ors.append(f"r.etype = $t{i}")
            params[f"t{i}"] = t
        res = await self._run(
            f"MATCH (p:N)-[r:R]->(x:N {{pk:$pk}}) WHERE r.ns = $ns AND ({' OR '.join(ors)}) RETURN count(*) AS n",
            params,
        )
        return count_of(res.rows)

    async def delete_edges_touching_by_type(self, ns: str, label: str, id: str, type: str) -> None:
        params = {"pk": _pk(ns, id), "ns": ns, "et": type}
        await delete_both_ways(self._run, "t:N {pk:$pk}", "r:R", "o:N", params)

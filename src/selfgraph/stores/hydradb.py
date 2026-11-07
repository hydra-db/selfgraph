from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from ..errors import StoreError, TransientError
from ..ids import quote_label
from ..models import CypherResult
from ._cypher import AutoCommitStore, count_of, records_to_result, where_equals
from ._docrows import delete_both_ways, docs, edge_row, first_doc, merged_current_edge, relation_ids_both_ways

__all__ = ["HydraDBStore"]

_EDGE = "RELATES"
_SCALARS = (str, int, float, bool)
_MAX_STRING_BYTES = 32000


def _guard_sizes(row: Mapping[str, Any]) -> None:
    """Reject a write whose stored strings exceed the engine's per-string size limit.

    @param row (Mapping[str, Any]): the column names and values about to be written.
    @return (None): nothing; raises when a stored string is too large.
    """
    for key, value in row.items():
        if isinstance(value, str) and len(value.encode("utf-8")) > _MAX_STRING_BYTES:
            size = len(value.encode("utf-8"))
            field = (
                "the serialized node or edge document (HydraDB stores each node or edge as one JSON document, "
                "so its properties share this budget)"
                if key == "doc"
                else f"the string column {key!r}"
            )
            raise StoreError(
                f"HydraDB rejects {field} at {size} bytes; the engine limit is "
                f"{_MAX_STRING_BYTES} bytes per stored string"
            )


def _sk(ns: str, sid: str) -> int:
    """Derive a stable non-negative integer surrogate key for a string node id.

    @param ns (str): namespace.
    @param sid (str): the string id.
    @return (int): the surrogate integer id.
    """
    digest = hashlib.blake2b(f"{ns}\x00{sid}".encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") >> 1


def _scalars(props: dict) -> dict:
    return {k: v for k, v in props.items() if k not in ("id", "ns") and isinstance(v, _SCALARS)}


def _doc(props: Mapping[str, Any]) -> str:
    return json.dumps(dict(props), default=str)


class HydraDBStore(AutoCommitStore):
    def __init__(
        self,
        uri: str,
        *,
        auth: tuple[str, str] | None = None,
        database: str | None = None,
        **driver_kwargs: Any,
    ) -> None:
        try:
            from neo4j import AsyncGraphDatabase
        except ImportError as exc:  # pragma: no cover
            raise StoreError("the 'neo4j' package is required for HydraDBStore; install selfgraph[neo4j]") from exc
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth, **driver_kwargs)
        self._database = database or "default"

    def _session(self):
        return self._driver.session(database=self._database)

    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        async with self._session() as session:
            try:
                result = await session.run(query, dict(params or {}))
                return await records_to_result(result)
            except Exception as exc:  # noqa: BLE001
                lowered = f"{getattr(exc, 'code', '') or ''} {exc}".lower()
                if any(k in lowered for k in ("snapshot", "epoch", "transient", "serializ", "conflict", "lock")):
                    raise TransientError(f"HydraDB transaction conflict: {exc}") from exc
                raise StoreError(f"HydraDB query failed: {exc}") from exc

    async def initialize(self) -> None:
        """Set up the store. HydraDB manages identity natively, so nothing is created."""
        return None

    async def close(self) -> None:
        """Close the driver and its connection pool."""
        await self._driver.close()

    async def get_node(self, ns: str, label: str, id: str) -> dict | None:
        res = await self._run(f"MATCH (n:{label} {{id: $iid}}) RETURN n.doc AS doc", {"iid": _sk(ns, id)})
        return first_doc(res.rows)

    async def node_exists(self, ns: str, label: str, id: str) -> bool:
        res = await self._run(f"MATCH (n:{label} {{id: $iid}}) RETURN n.sid AS sid", {"iid": _sk(ns, id)})
        return bool(res.rows)

    def check_doc_size(self, props: Mapping[str, Any]) -> None:
        """Reject an encoded write whose serialized document exceeds the engine's per-string limit, before any write.

        @param props (Mapping[str, Any]): the encoded node or edge properties about to be written.
        @return (None): nothing; raises StoreError when the document is too large.
        """
        row: dict[str, Any] = {"doc": _doc(props)}
        row.update(_scalars(dict(props)))
        _guard_sizes(row)

    async def upsert_node(self, ns: str, label: str, id: str, props: dict, *, extra_label: str | None = None) -> None:
        if extra_label is not None:
            quote_label(extra_label)
        row: dict[str, Any] = {
            "id": _sk(ns, id),
            "sid": id,
            "ns": ns,
            "doc": _doc(props),
        }
        row.update(_scalars(props))
        _guard_sizes(row)
        sets = ", ".join(f"n.{k} = row.{k}" for k in row if k != "id")
        await self._run(f"UNWIND $rows AS row MERGE (n {{id: row.id}}) SET n:{label}, {sets}", {"rows": [row]})

    async def remove_node_label(self, ns: str, label: str, id: str, drop_label: str) -> None:
        await self._run(
            f"MATCH (n:{label} {{id: $iid}}) REMOVE n:{quote_label(drop_label)}",
            {"iid": _sk(ns, id)},
        )

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
        where = ["n.ns = $ns"]
        params: dict[str, Any] = {"ns": ns, "skip": skip, "limit": limit}
        where_equals("n", equals, where, params)
        ob = "sid" if order_by == "id" else order_by
        res = await self._run(
            f"MATCH (n:{label}) WHERE {' AND '.join(where)} "
            f"RETURN n.doc AS doc, n.`{ob}` AS __ob ORDER BY __ob SKIP $skip LIMIT $limit",
            params,
        )
        return docs(res.rows)

    async def delete_node(self, ns: str, label: str, id: str) -> None:
        await self._run(f"MATCH (n:{label} {{id: $iid}}) DETACH DELETE n", {"iid": _sk(ns, id)})

    async def delete_nodes_by(self, ns: str, label: str, *, equals: dict) -> int:
        where = ["n.ns = $ns"]
        params: dict[str, Any] = {"ns": ns}
        where_equals("n", equals, where, params)
        res = await self._run(f"MATCH (n:{label}) WHERE {' AND '.join(where)} RETURN n.id AS iid", params)
        ids = [r["iid"] for r in res.rows]
        for iid in ids:
            await self._run(f"MATCH (n:{label} {{id: $iid}}) DETACH DELETE n", {"iid": iid})
        return len(ids)

    async def create_edge(
        self, ns: str, type: str, from_label: str, from_id: str, to_label: str, to_id: str, props: dict
    ) -> bool:
        both = await self._run(
            f"MATCH (a:{from_label} {{id: $f}}), (b:{to_label} {{id: $t}}) RETURN a.sid AS sid",
            {"f": _sk(ns, from_id), "t": _sk(ns, to_id)},
        )
        if not both.rows:
            return False
        sid = props.get("id")
        rev = props.get("revision")
        row: dict[str, Any] = {
            "f": _sk(ns, from_id),
            "t": _sk(ns, to_id),
            "id": _sk(ns, f"{from_id}|{type}|{to_id}|{sid}|{rev}"),
            "ns": ns,
            "etype": type,
            "doc": _doc(props),
        }
        if sid is not None:
            row["sid"] = sid
        row.update(_scalars(props))
        _guard_sizes(row)
        set_props = ", ".join(f"r.{k} = row.{k}" for k in row if k not in ("f", "t", "id"))
        await self._run(
            f"UNWIND $rows AS row MATCH (a:{from_label} {{id: row.f}}), (b:{to_label} {{id: row.t}}) "
            f"MERGE (a)-[r:{_EDGE} {{id: row.id}}]->(b) "
            f"SET {set_props}",
            {"rows": [row]},
        )
        return True

    async def get_current_edge(self, ns: str, id: str) -> dict | None:
        res = await self._run(
            f"MATCH (a)-[r:{_EDGE}]->(b) WHERE r.ns = $ns AND r.sid = $sid AND r.is_current = true "
            "RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et",
            {"ns": ns, "sid": id},
        )
        return edge_row(res.rows[0]) if res.rows else None

    async def list_edge_versions(self, ns: str, id: str) -> list[dict]:
        res = await self._run(
            f"MATCH (a)-[r:{_EDGE}]->(b) WHERE r.ns = $ns AND r.sid = $sid "
            "RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et, r.revision AS rev "
            "ORDER BY rev",
            {"ns": ns, "sid": id},
        )
        return [edge_row(r) for r in res.rows]

    async def update_current_edge(self, ns: str, id: str, props: dict) -> None:
        merged = await merged_current_edge(self, ns, id, props)
        if merged is None:
            return
        sets = ["r.doc = $doc"]
        params: dict[str, Any] = {"ns": ns, "sid": id, "doc": _doc(merged)}
        for k, v in _scalars(merged).items():
            sets.append(f"r.{k} = $s_{k}")
            params[f"s_{k}"] = v
        _guard_sizes(params)
        await self._run(
            f"MATCH (a)-[r:{_EDGE}]->(b) WHERE r.ns = $ns AND r.sid = $sid AND r.is_current = true "
            f"SET {', '.join(sets)}",
            params,
        )

    async def count_edges(self, ns: str, id: str) -> int:
        res = await self._run(
            f"MATCH (a)-[r:{_EDGE}]->(b) WHERE r.ns = $ns AND r.sid = $sid RETURN count(*) AS n",
            {"ns": ns, "sid": id},
        )
        return count_of(res.rows)

    async def delete_edges(self, ns: str, id: str) -> int:
        n = await self.count_edges(ns, id)
        if n:
            await self._run(
                f"MATCH (a)-[r:{_EDGE}]->(b) WHERE r.ns = $ns AND r.sid = $sid DELETE r",
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
        blabel = f":{to_label}" if to_label else ""
        where = ["r.ns = $ns"]
        params: dict[str, Any] = {"ns": ns, "skip": skip, "limit": limit}
        if current_only:
            where.append("r.is_current = true")
        if type is not None:
            where.append("r.etype = $etype")
            params["etype"] = type
        if from_id is not None:
            where.append("a.id = $fiid")
            params["fiid"] = _sk(ns, from_id)
        if to_id is not None:
            where.append("b.id = $tiid")
            params["tiid"] = _sk(ns, to_id)
        if from_in is not None:
            where.append("a.id IN $fiids_in")
            params["fiids_in"] = [_sk(ns, i) for i in from_in]
        if to_in is not None:
            where.append("b.id IN $tiids_in")
            params["tiids_in"] = [_sk(ns, i) for i in to_in]
        where_equals("r", equals, where, params)
        ob = "sid" if order_by == "id" else order_by
        res = await self._run(
            f"MATCH (a:{from_label})-[r:{_EDGE}]->(b{blabel}) WHERE {' AND '.join(where)} "
            f"RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et, r.`{ob}` AS __ob "
            f"ORDER BY __ob SKIP $skip LIMIT $limit",
            params,
        )
        return [edge_row(r) for r in res.rows]

    async def versioned_relation_ids(self, ns: str, label: str, id: str, *, exclude_types: list[str]) -> list[str]:
        where = ["r.ns = $ns", "r.revision IS NOT NULL"]
        params: dict[str, Any] = {"iid": _sk(ns, id), "ns": ns}
        for i, t in enumerate(exclude_types):
            where.append(f"r.etype <> $ex{i}")
            params[f"ex{i}"] = t
        return await relation_ids_both_ways(self._run, f"x:{label} {{id: $iid}}", f"r:{_EDGE}", "o", where, params)

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
        ob = "" if order_by is None else f", c.`{order_by}` AS __ob"
        order = "" if order_by is None else " ORDER BY __ob"
        res = await self._run(
            f"MATCH (p:{parent_label} {{id: $iid}})-[r:{_EDGE}]->(c:{child_label}) "
            f"WHERE r.ns = $ns AND r.etype = $et RETURN c.doc AS doc{ob}{order}",
            {"iid": _sk(ns, parent_id), "ns": ns, "et": edge_type},
        )
        return docs(res.rows)

    async def count_out_edges(self, ns: str, label: str, id: str) -> int:
        res = await self._run(
            f"MATCH (p:{label} {{id: $iid}})-[r:{_EDGE}]->(o) WHERE r.ns = $ns RETURN count(*) AS n",
            {"iid": _sk(ns, id), "ns": ns},
        )
        return count_of(res.rows)

    async def count_in_edges_typed(self, ns: str, label: str, id: str, types: list[str]) -> int:
        params: dict[str, Any] = {"iid": _sk(ns, id), "ns": ns}
        ors = []
        for i, t in enumerate(types):
            ors.append(f"r.etype = $t{i}")
            params[f"t{i}"] = t
        res = await self._run(
            f"MATCH (p)-[r:{_EDGE}]->(x:{label} {{id: $iid}}) WHERE r.ns = $ns AND ({' OR '.join(ors)}) "
            "RETURN count(*) AS n",
            params,
        )
        return count_of(res.rows)

    async def delete_edges_touching_by_type(self, ns: str, label: str, id: str, type: str) -> None:
        params = {"iid": _sk(ns, id), "ns": ns, "et": type}
        await delete_both_ways(self._run, f"t:{label} {{id: $iid}}", f"r:{_EDGE}", "o", params)

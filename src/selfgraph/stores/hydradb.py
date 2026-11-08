from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from ..errors import StoreError, TransientError
from ..ids import quote_label
from ..models import CypherResult
from ._cypher import AutoCommitStore, bind_list, bolt_driver, count_of, records_to_result
from ._docrows import docs, edge_row, first_doc, merged_current_edge

__all__ = ["HydraDBStore"]

_EDGE = "RELATES"
_SCALARS = (str, int, float, bool)
_MAX_STRING_BYTES = 32000
_WRITE_BATCH = 1000
_DELETE_BATCH = 1024


def _guard_sizes(row: Mapping[str, Any]) -> None:
    """Reject a write whose stored strings exceed the engine's per-string size limit.

    @param row (Mapping[str, Any]): the column names and values about to be written.
    @return (None): nothing; raises when a stored string is too large.
    """
    for key, value in row.items():
        if not isinstance(value, str):
            continue
        size = len(value.encode("utf-8"))
        if size > _MAX_STRING_BYTES:
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


def _same(alias: str, key: str, param: str) -> str:
    """An equality the engine applies as a filter rather than an index seek, for broad keys such as the namespace.

    @param alias (str): the node or relationship variable.
    @param key (str): the property.
    @param param (str): the parameter name.
    @return (str): the predicate.
    """
    return f"NOT {alias}.`{key}` <> ${param}"


_BY_SID = f"MATCH (a)-[r:{_EDGE} {{sid: $sid}}]->(b) WHERE {_same('r', 'ns', 'ns')}"


def _keyed(alias: str, label: str, equals: dict | None, params: dict) -> str:
    """A node pattern carrying the equality filters in its property map, so the engine seeks on them.

    @param alias (str): the node variable.
    @param label (str): the node label.
    @param equals (dict | None): property name to required value.
    @param params (dict): the parameters to extend.
    @return (str): the pattern body, for example "n:Entity {`type`: $eq0}".
    """
    entries = []
    for i, (key, value) in enumerate(sorted((equals or {}).items())):
        entries.append(f"`{key}`: $eq{i}")
        params[f"eq{i}"] = value
    return f"{alias}:{label} {{{', '.join(entries)}}}" if entries else f"{alias}:{label}"


def _by_columns(rows: list[dict]) -> list[list[dict]]:
    """Group write rows by column set into batches, since an UNWIND write needs every row to carry the same fields.

    @param rows (list[dict]): the rows to group.
    @return (list[list[dict]]): batches of at most _WRITE_BATCH rows sharing one column set, in first-seen order.
    """
    groups: dict[tuple[str, ...], list[dict]] = {}
    for row in rows:
        groups.setdefault(tuple(sorted(row)), []).append(row)
    return [group[i : i + _WRITE_BATCH] for group in groups.values() for i in range(0, len(group), _WRITE_BATCH)]


def _sets(alias: str, row: dict, skip: tuple[str, ...]) -> str:
    return ", ".join(f"{alias}.`{k}` = row.`{k}`" for k in sorted(row) if k not in skip)


class HydraDBStore(AutoCommitStore):
    def __init__(
        self,
        uri: str,
        *,
        auth: tuple[str, str] | None = None,
        database: str | None = None,
        **driver_kwargs: Any,
    ) -> None:
        self._driver = bolt_driver(uri, auth, **driver_kwargs)
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
        _guard_sizes({"doc": _doc(props), **_scalars(dict(props))})

    async def upsert_node(self, ns: str, label: str, id: str, props: dict, *, extra_label: str | None = None) -> None:
        await self.upsert_nodes(ns, label, [(id, props)], extra_label=extra_label)

    async def upsert_nodes(
        self, ns: str, label: str, rows: list[tuple[str, dict]], *, extra_label: str | None = None
    ) -> None:
        if extra_label is not None:
            quote_label(extra_label)
        out = []
        for id, props in rows:
            row = {"id": _sk(ns, id), "sid": id, "ns": ns, "label": label, "doc": _doc(props), **_scalars(props)}
            _guard_sizes(row)
            out.append(row)
        for batch in _by_columns(out):
            await self._run(
                f"UNWIND $rows AS row MERGE (n {{id: row.id}}) SET n:{label}, {_sets('n', batch[0], ('id',))}",
                {"rows": batch},
            )

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
        any_of: dict | None = None,
        order_by: str = "id",
        skip: int = 0,
        limit: int = 1000,
    ) -> list[dict]:
        params: dict[str, Any] = {"ns": ns, "label": label, "skip": skip, "limit": limit}
        ids = (any_of or {}).get("id")
        if ids is not None:
            pattern = "n"
            where = ["n.id IN $iids", _same("n", "label", "label"), _same("n", "ns", "ns")]
            params["iids"] = [_sk(ns, i) for i in ids]
            for i, (key, value) in enumerate(sorted((equals or {}).items())):
                where.append(_same("n", key, f"eq{i}"))
                params[f"eq{i}"] = value
        else:
            pattern = _keyed("n", label, equals, params)
            where = [_same("n", "ns", "ns") if equals else "n.ns = $ns"]
        for i, (key, values) in enumerate(sorted((any_of or {}).items())):
            if key != "id":
                where.append(f"n.`{key}` IN $in{i}")
                params[f"in{i}"] = list(values)
        ob = "sid" if order_by == "id" else order_by
        res = await self._run(
            f"MATCH ({pattern}) WHERE {' AND '.join(where)} "
            f"RETURN n.doc AS doc, n.`{ob}` AS __ob ORDER BY __ob SKIP $skip LIMIT $limit",
            params,
        )
        return docs(res.rows)

    async def delete_node(self, ns: str, label: str, id: str) -> None:
        await self._run(f"MATCH (n:{label} {{id: $iid}}) DETACH DELETE n", {"iid": _sk(ns, id)})

    async def delete_nodes_by(self, ns: str, label: str, *, equals: dict) -> int:
        params: dict[str, Any] = {"ns": ns, "batch": _DELETE_BATCH}
        pattern = _keyed("n", label, equals, params)
        where = _same("n", "ns", "ns") if equals else "n.ns = $ns"
        deleted = 0
        while True:
            res = await self._run(f"MATCH ({pattern}) WHERE {where} RETURN n.id AS iid LIMIT $batch", params)
            ids = [r["iid"] for r in res.rows]
            if ids:
                await self._run("MATCH (n) WHERE n.id IN $iids DETACH DELETE n", {"iids": ids})
            deleted += len(ids)
            if len(ids) < _DELETE_BATCH:
                return deleted

    async def create_edge(
        self, ns: str, type: str, from_label: str, from_id: str, to_label: str, to_id: str, props: dict
    ) -> bool:
        both = await self._run(
            f"MATCH (a:{from_label} {{id: $f}}), (b:{to_label} {{id: $t}}) RETURN a.sid AS sid",
            {"f": _sk(ns, from_id), "t": _sk(ns, to_id)},
        )
        if not both.rows:
            return False
        await self.create_edges(ns, from_label, to_label, [(type, from_id, to_id, props)])
        return True

    async def create_edges(
        self, ns: str, from_label: str, to_label: str, rows: list[tuple[str, str, str, dict]]
    ) -> None:
        out = []
        for type, from_id, to_id, props in rows:
            sid = props.get("id")
            row: dict[str, Any] = {
                "f": _sk(ns, from_id),
                "t": _sk(ns, to_id),
                "id": _sk(ns, f"{from_id}|{type}|{to_id}|{sid}|{props.get('revision')}"),
                "ns": ns,
                "etype": type,
                "doc": _doc(props),
            }
            if sid is not None:
                row["sid"] = sid
            row.update(_scalars(props))
            _guard_sizes(row)
            out.append(row)
        for batch in _by_columns(out):
            await self._run(
                f"UNWIND $rows AS row MATCH (a:{from_label} {{id: row.f}}), (b:{to_label} {{id: row.t}}) "
                f"MERGE (a)-[r:{_EDGE} {{id: row.id}}]->(b) SET {_sets('r', batch[0], ('f', 't', 'id'))}",
                {"rows": batch},
            )

    async def get_current_edge(self, ns: str, id: str) -> dict | None:
        res = await self._run(
            f"{_BY_SID} AND r.is_current = true RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et",
            {"ns": ns, "sid": id},
        )
        return edge_row(res.rows[0]) if res.rows else None

    async def list_edge_versions(self, ns: str, id: str) -> list[dict]:
        res = await self._run(
            f"{_BY_SID} RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et, r.revision AS rev ORDER BY rev",
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
            sets.append(f"r.`{k}` = $s_{k}")
            params[f"s_{k}"] = v
        _guard_sizes(params)
        await self._run(
            f"{_BY_SID} AND r.is_current = true SET {', '.join(sets)}",
            params,
        )

    async def count_edges(self, ns: str, id: str) -> int:
        res = await self._run(f"{_BY_SID} RETURN count(*) AS n", {"ns": ns, "sid": id})
        return count_of(res.rows)

    async def delete_edges(self, ns: str, id: str) -> int:
        n = await self.count_edges(ns, id)
        if n:
            await self._run(f"{_BY_SID} DELETE r", {"ns": ns, "sid": id})
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
        params: dict[str, Any] = {"ns": ns, "skip": skip, "limit": limit}
        apat = f"a:{from_label}"
        bpat = f"b:{to_label}" if to_label else "b"
        where = []
        if from_id is not None:
            apat += " {id: $fiid}"
            params["fiid"] = _sk(ns, from_id)
        if to_id is not None:
            bpat += " {id: $tiid}"
            params["tiid"] = _sk(ns, to_id)
        if from_in is not None:
            where.append("a.id IN $fiids_in")
            params["fiids_in"] = [_sk(ns, i) for i in from_in]
        if to_in is not None:
            where.append("b.id IN $tiids_in")
            params["tiids_in"] = [_sk(ns, i) for i in to_in]
        anchored = bool(where) or from_id is not None or to_id is not None
        filters = {"ns": ns, **({"etype": type} if type is not None else {}), **dict(sorted((equals or {}).items()))}
        for i, (key, value) in enumerate(filters.items()):
            where.append(_same("r", key, f"eq{i}") if anchored else f"r.`{key}` = $eq{i}")
            params[f"eq{i}"] = value
        if current_only:
            where.append("r.is_current = true")
        ob = "sid" if order_by == "id" else order_by
        res = await self._run(
            f"MATCH ({apat})-[r:{_EDGE}]->({bpat}) WHERE {' AND '.join(where)} "
            f"RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et, r.`{ob}` AS __ob "
            f"ORDER BY __ob SKIP $skip LIMIT $limit",
            params,
        )
        return [edge_row(r) for r in res.rows]

    async def versioned_relation_ids(self, ns: str, label: str, id: str, *, exclude_types: list[str]) -> list[str]:
        params: dict[str, Any] = {"iid": _sk(ns, id), "ns": ns}
        where = [
            _same("r", "ns", "ns"),
            "r.revision IS NOT NULL",
            *bind_list(exclude_types, "ex", params, lambda p: f"r.etype <> {p}"),
        ]
        res = await self._run(
            f"MATCH (x:{label} {{id: $iid}})-[r:{_EDGE}]-(o) WHERE {' AND '.join(where)} RETURN DISTINCT r.sid AS rid",
            params,
        )
        return list(dict.fromkeys(r["rid"] for r in res.rows))

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
            f"WHERE {_same('r', 'ns', 'ns')} AND r.etype = $et RETURN c.doc AS doc{ob}{order}",
            {"iid": _sk(ns, parent_id), "ns": ns, "et": edge_type},
        )
        return docs(res.rows)

    async def count_out_edges(self, ns: str, label: str, id: str) -> int:
        res = await self._run(
            f"MATCH (p:{label} {{id: $iid}})-[r:{_EDGE}]->(o) WHERE {_same('r', 'ns', 'ns')} RETURN count(*) AS n",
            {"iid": _sk(ns, id), "ns": ns},
        )
        return count_of(res.rows)

    async def count_in_edges_typed(self, ns: str, label: str, id: str, types: list[str]) -> int:
        params: dict[str, Any] = {"iid": _sk(ns, id), "ns": ns}
        ors = bind_list(types, "t", params, lambda p: f"r.etype = {p}")
        res = await self._run(
            f"MATCH (p)-[r:{_EDGE}]->(x:{label} {{id: $iid}}) WHERE {_same('r', 'ns', 'ns')} AND ({' OR '.join(ors)}) "
            "RETURN count(*) AS n",
            params,
        )
        return count_of(res.rows)

    async def delete_edges_touching_by_type(self, ns: str, label: str, id: str, type: str) -> None:
        await self._run(
            f"MATCH (t:{label} {{id: $iid}})-[r:{_EDGE}]-(o) WHERE {_same('r', 'ns', 'ns')} AND r.etype = $et DELETE r",
            {"iid": _sk(ns, id), "ns": ns, "et": type},
        )

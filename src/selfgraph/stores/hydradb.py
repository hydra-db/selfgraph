from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Iterable, Mapping
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

from .._ops import _batches
from .._serde import L_ENTITY, L_EVIDENCE, L_MERGE, decode_entity
from ..errors import OTHER_ENGINE_HINT, TOKEN_HINT, StoreError
from ..ids import quote_label
from ..models import CypherResult
from ..resolution import match_keys
from ._cypher import (
    AutoCommitStore,
    bolt_auth,
    bolt_driver,
    bolt_failure,
    count_of,
    query_error,
    records_to_result,
    where_after,
)
from ._docrows import docs, edge_row, first_doc, merged_current_edge

__all__ = ["HydraDBStore"]

_EDGE = "RELATES"
_KEY = "_SgEntityKey"
_SEEK_BATCH = 256
_PARALLEL = 32
_QUEUING: ContextVar[HydraDBStore | None] = ContextVar("selfgraph_hydradb_queuing", default=None)
_SCALARS = (str, int, float, bool)
_MAX_STRING_BYTES = 32000
_WRITE_BATCH = 1000
_DELETE_BATCH = 1024
_TRANSIENT_MARKERS = ("snapshot", "epoch", "transient", "serializ", "conflict", "lock")
_PROTOCOL_MARKERS = ("protocol version", "unsupported protocol")
_OTHER_ENGINE_MARKERS = (*_PROTOCOL_MARKERS, "neo.clienterror.database.databasenotfound", "memgraph")
_OTHER_ENGINE_HINT = f"; if this is Neo4j or Memgraph, {OTHER_ENGINE_HINT}"
_NO_TOKEN = f"HydraDB needs a token: {TOKEN_HINT}"


def _transient(lowered: str) -> bool:
    return any(k in lowered for k in _TRANSIENT_MARKERS)


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


def _sort_key(ns: str, label: str) -> str:
    """The string property holding a node's id for one label in one namespace, which id-ordered reads walk.

    The engine walks a property's index in value order and stops once the page is full, not at the end of a
    prefix, so a property shared by every namespace would make a namespace's last page read the nodes of every
    namespace sorting after it.

    @param ns (str): namespace.
    @param label (str): the node label.
    @return (str): the property name.
    """
    return f"k_{label}_{_sk(ns, label)}"


def _scalars(props: dict) -> dict:
    return {k: v for k, v in props.items() if k not in ("id", "ns") and isinstance(v, _SCALARS)}


def _unset(props: Mapping[str, Any]) -> tuple[str, ...]:
    """The properties set to None, whose stored columns must be removed since the engine cannot write a null.

    @param props (Mapping[str, Any]): the encoded properties about to be written.
    @return (tuple[str, ...]): the cleared property names, sorted.
    """
    return tuple(sorted(k for k, v in props.items() if v is None and k not in ("id", "ns")))


def _removes(alias: str, keys: tuple[str, ...]) -> str:
    return ", ".join(f"{alias}.`{k}`" for k in keys)


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


_BY_SID = f"MATCH ()-[r:{_EDGE} {{sid: $sid}}]->() WHERE {_same('r', 'ns', 'ns')}"


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


def _keys_of(props: Mapping[str, Any]) -> frozenset[str]:
    """The match keys of a stored entity.

    @param props (Mapping[str, Any]): the encoded entity properties.
    @return (frozenset[str]): its keys, as resolution.match_keys derives them.
    """
    ent = decode_entity(dict(props))
    return match_keys(ent.name, ent.aliases, ent.external_ids)


def _key_rows(ns: str, rows: Iterable[tuple[str, Mapping[str, Any]]]) -> list[dict]:
    """The key index rows of some entities, one per entity and match key, keyed so a rewrite merges in place.

    @param ns (str): namespace.
    @param rows (Iterable[tuple[str, Mapping[str, Any]]]): (entity id, encoded entity properties) pairs.
    @return (list[dict]): the key rows, each with its own id, the hashed key, the entity's surrogate id, and ns.
    """
    return [
        {"id": _sk(ns, f"\x00key\x00{key}\x00{id}"), "key": _sk(ns, key), "eid": _sk(ns, id), "ns": ns}
        for id, props in rows
        for key in sorted(_keys_of(props))
    ]


def _sid_key(ns: str, sid: str) -> int:
    """The key an edge id's versions are tracked under, so they are written in order and reads by edge id wait.

    @param ns (str): namespace.
    @param sid (str): the edge id.
    @return (int): the key.
    """
    return _sk(ns, f"\x00sid\x00{sid}")


def _label_key(label: str) -> int:
    """The key a queued node write is tracked under for reads of every node of its label.

    @param label (str): the node label.
    @return (int): the key.
    """
    return _sk("", f"\x00label\x00{label}")


class HydraDBStore(AutoCommitStore):
    def __init__(
        self,
        uri: str,
        *,
        auth: str | tuple[str, str] | None = None,
        database: str | None = None,
        **driver_kwargs: Any,
    ) -> None:
        auth = bolt_auth(auth)
        self._driver = bolt_driver(uri, auth, **driver_kwargs)
        self._uri = uri
        self._has_auth = auth is not None
        self._database = database or "default"
        self._queued: list[tuple[str, dict, frozenset[int], frozenset[int]]] = []
        self._dirty: set[int] = set()
        self._pending_nodes: set[tuple[str, int]] = set()
        self._failure: BaseException | None = None
        self._draining = asyncio.Lock()

    def _session(self):
        self._require_open()
        return self._driver.session(database=self._database)

    async def _run(
        self, query: str, params: Mapping[str, Any] | None = None, *, reads: Iterable[int] | None = None
    ) -> CypherResult:
        """Run one statement, inside the write transaction once the queued writes it can see have run.

        Only the transaction that queued the writes runs them, so another task reads what is committed.

        @param query (str): the statement.
        @param params (Mapping[str, Any] | None): the parameters.
        @param reads (Iterable[int] | None): the only ids the statement reads, so it waits only for queued writes
            to them, or None to wait for every queued write.
        @return (CypherResult): the rows.
        """
        if _QUEUING.get() is self and (
            self._draining.locked() or (self._queued and (reads is None or not self._dirty.isdisjoint(reads)))
        ):
            await self._drain()
        return await self._exec(query, params)

    async def _exec(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        """Run one statement now, bypassing the write queue.

        @param query (str): the Cypher statement.
        @param params (Mapping[str, Any] | None): its parameters.
        @return (CypherResult): the rows.
        """
        async with self._session() as session:
            try:
                result = await session.run(query, dict(params or {}))
                return await records_to_result(result)
            except Exception as exc:  # noqa: BLE001
                raise self._error(exc) from exc

    def _error(self, exc: BaseException) -> StoreError:
        """Map a driver error to a library error, saying when a token is missing or the server is another engine.

        A missing database on HydraDB itself gets no engine hint; only a protocol mismatch or a Neo4j or Memgraph
        error code does.

        @param exc (BaseException): the driver exception.
        @return (StoreError): the error to raise.
        """
        failure = bolt_failure(exc)
        if failure == "auth" and not self._has_auth:
            return StoreError(_NO_TOKEN)
        err = query_error(exc, self._uri, self._database, "HydraDB", _transient)
        lowered = f"{getattr(exc, 'code', '') or ''} {exc}".lower()
        if any(k in lowered for k in _OTHER_ENGINE_MARKERS):
            return StoreError(f"{err}{_OTHER_ENGINE_HINT}")
        return err

    async def _write(
        self,
        query: str,
        params: dict,
        writes: Iterable[int],
        needs: Iterable[int] = (),
        marks: Iterable[int] = (),
        *,
        after_all: bool = False,
    ) -> None:
        """Run a write, or queue it inside a write transaction so it runs concurrently with the writes around it.

        Every write waits for a WAL flush, and writes in flight together share one, so queued writes run in waves:
        a write runs in the wave after the last one that writes an id it writes or needs, or needs an id it writes.

        @param query (str): the statement.
        @param params (dict): the parameters.
        @param writes (Iterable[int]): the surrogate ids of the nodes or edges it writes.
        @param needs (Iterable[int]): the surrogate ids of the nodes it reads, such as an edge's endpoints.
        @param marks (Iterable[int]): further keys reads wait on, such as its label.
        @param after_all (bool): run after every write queued before it, for a write that records that they are
            done (evidence, a merge record, a retirement), so a failure never leaves it without them.
        @return (None): nothing.
        """
        if _QUEUING.get() is not self:
            await self._exec(query, params)
            return
        writes = frozenset(writes)
        before = (w for _, _, w, _ in self._queued) if after_all else ()
        self._queued.append((query, params, writes, frozenset(needs).union(*before)))
        self._dirty.update(writes, marks)

    async def _drain(self) -> None:
        """Run the queued writes in waves, up to _PARALLEL writes at a time, one wave after another.

        A failure is also kept for the transaction to raise, so it is never lost to a caller that drops it.

        @return (None): nothing; raises the first error of the first wave that fails, skipping later waves.
        """
        async with self._draining:
            queued, self._queued = self._queued, []
            self._dirty.clear()
            self._pending_nodes.clear()
            waves: list[tuple[list[tuple[str, dict]], set[int], set[int]]] = []
            for query, params, writes, needs in queued:
                after = max(
                    (i for i, (_, w, n) in enumerate(waves) if writes & (w | n) or needs & w),
                    default=-1,
                )
                if after + 1 == len(waves):
                    waves.append(([], set(), set()))
                waves[after + 1][0].append((query, params))
                waves[after + 1][1].update(writes)
                waves[after + 1][2].update(needs)
            for statements, _, _ in waves:
                for batch in _batches(statements, _PARALLEL):
                    results = await asyncio.gather(*(self._exec(q, p) for q, p in batch), return_exceptions=True)
                    for res in results:
                        if isinstance(res, BaseException):
                            self._failure = self._failure or res
                            raise res

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[HydraDBStore]:
        """Run one write at a time on this store, running its queued writes before it ends, even when it fails.

        @return (AsyncIterator[HydraDBStore]): this store, held until the write and its queued writes finish.
        """
        if _QUEUING.get() is self:
            yield self
            return
        async with super().transaction() as tx:
            token = _QUEUING.set(self)
            try:
                yield tx
            finally:
                try:
                    await self._drain()
                finally:
                    _QUEUING.reset(token)
                    failure, self._failure = self._failure, None
            if failure is not None:
                raise failure

    async def initialize(self) -> None:
        """Check the server is reachable and accepts the credentials with one cheap read; nothing is created.

        @return (None): nothing; raises StoreError when the server cannot be reached or rejects the login.
        """
        await self._run("MATCH (n:_SgInit) RETURN count(*) AS n")

    async def close(self) -> None:
        """Close the driver and its connection pool; later calls fail with StoreError."""
        self._closed = True
        await self._driver.close()

    async def get_node(self, ns: str, label: str, id: str) -> dict | None:
        iid = _sk(ns, id)
        res = await self._run(f"MATCH (n:{label} {{id: $iid}}) RETURN n.doc AS doc", {"iid": iid}, reads=[iid])
        return first_doc(res.rows)

    async def node_exists(self, ns: str, label: str, id: str) -> bool:
        iid = _sk(ns, id)
        res = await self._run(f"MATCH (n:{label} {{id: $iid}}) RETURN n.sid AS sid", {"iid": iid}, reads=[iid])
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
        cleared: dict[tuple[str, ...], list[int]] = {}
        key = _sort_key(ns, label)
        for id, props in rows:
            row = {
                "id": _sk(ns, id),
                "sid": id,
                "ns": ns,
                "label": label,
                key: id,
                "doc": _doc(props),
                **_scalars(props),
            }
            _guard_sizes(row)
            out.append(row)
            if keys := _unset(props):
                cleared.setdefault(keys, []).append(row["id"])
        held = []
        for keys, iids in cleared.items():
            for batch in _batches(iids, _DELETE_BATCH):
                params = {"iids": batch}
                found = await self._run(
                    f"MATCH (n:{label}) WHERE n.id IN $iids AND ({' OR '.join(f'n.`{k}` IS NOT NULL' for k in keys)}) "
                    "RETURN n.sid AS sid",
                    params,
                    reads=batch,
                )
                members = set(batch)
                if found.rows or any(r["id"] in members and not r.keys().isdisjoint(keys) for r in out):
                    held.append((keys, params))
        index_rows = _key_rows(ns, rows) if label == L_ENTITY else []
        await self._merge_rows(_KEY, index_rows)
        await self._merge_rows(label, out, [r["id"] for r in index_rows])
        for keys, params in held:
            await self._run(f"MATCH (n:{label}) WHERE n.id IN $iids REMOVE {_removes('n', keys)}", params)

    async def _merge_rows(self, label: str, rows: list[dict], needs: list[int] | None = None) -> None:
        """Upsert node rows by surrogate id with one UNWIND statement per batch of rows sharing a column set.

        @param label (str): the node label.
        @param rows (list[dict]): the rows, each with its surrogate id and the columns to set.
        @param needs (list[int] | None): ids that must be written first, such as the entities' key rows, so a
            failed write never leaves an entity stored without them.
        @return (None): nothing.
        """
        for batch in _by_columns(rows):
            await self._write(
                f"UNWIND $rows AS row MERGE (n {{id: row.id}}) SET n:{label}, {_sets('n', batch[0], ('id',))}",
                {"rows": batch},
                [r["id"] for r in batch],
                needs or (),
                [_label_key(label)],
                after_all=label in (L_EVIDENCE, L_MERGE),
            )
            if _QUEUING.get() is self:
                self._pending_nodes.update((label, r["id"]) for r in batch)

    async def entities_matching(self, ns: str, keys: Iterable[str]) -> list[dict]:
        """Read the entities sharing a match key with some keys, through the key index instead of a scan.

        A key row whose entity is gone or no longer has that key, after an alias or external id was removed, is
        deleted on the way, so the index never grows stale.

        @param ns (str): namespace.
        @param keys (Iterable[str]): the match keys, as resolution.match_keys derives them.
        @return (list[dict]): the matching entities' properties.
        """
        wanted = {_sk(ns, k): k for k in keys}
        hits: list[tuple[int, str, int]] = []
        for batch in _batches(sorted(wanted), _SEEK_BATCH):
            res = await self._run(
                f"MATCH (k:{_KEY}) WHERE k.key IN $keys RETURN k.id AS id, k.key AS key, k.eid AS eid", {"keys": batch}
            )
            hits += [(r["id"], wanted[r["key"]], r["eid"]) for r in res.rows]
        found: dict[int, dict] = {}
        for batch in _batches(sorted({eid for _, _, eid in hits}), _SEEK_BATCH):
            res = await self._run(
                f"MATCH (n:{L_ENTITY}) WHERE n.id IN $iids AND {_same('n', 'ns', 'ns')} "
                "RETURN n.id AS iid, n.doc AS doc",
                {"iids": batch, "ns": ns},
            )
            found.update((r["iid"], json.loads(r["doc"])) for r in res.rows if r["doc"] is not None)
        stale = sorted(rid for rid, key, eid in hits if eid not in found or key not in _keys_of(found[eid]))
        for batch in _batches(stale, _SEEK_BATCH):
            await self._write(f"MATCH (k:{_KEY}) WHERE k.id IN $ids DETACH DELETE k", {"ids": batch}, batch)
        return list(found.values())

    async def _drop_keys(self, label: str, iids: list[int]) -> None:
        """Delete the key index rows of deleted entities, so the index only holds stored entities' keys.

        @param label (str): the label of the deleted nodes; only entities have key rows.
        @param iids (list[int]): the deleted nodes' surrogate ids.
        @return (None): nothing.
        """
        if label != L_ENTITY:
            return
        for batch in _batches(iids, _SEEK_BATCH):
            await self._run(f"MATCH (k:{_KEY}) WHERE k.eid IN $iids DETACH DELETE k", {"iids": batch})

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
        id_gt: str | None = None,
    ) -> list[dict]:
        if order_by == "id" and not equals and not any_of:
            key = _sort_key(ns, label)
            params: dict[str, Any] = {"skip": skip, "limit": limit}
            where = [f"n.`{key}` STARTS WITH ''"]
            where_after(f"n.`{key}`", id_gt, where, params)
            res = await self._run(
                f"MATCH (n:{label}) WHERE {' AND '.join(where)} "
                f"RETURN n.doc AS doc ORDER BY n.`{key}` SKIP $skip LIMIT $limit",
                params,
                reads=[_label_key(label)],
            )
            return docs(res.rows)
        params = {"ns": ns, "label": label, "skip": skip, "limit": limit}
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
            where = [_same("n", "ns", "ns")]
        for i, (key, values) in enumerate(sorted((any_of or {}).items())):
            if key != "id":
                where.append(f"n.`{key}` IN $in{i}")
                params[f"in{i}"] = list(values)
        where_after("n.sid", id_gt, where, params)
        ob = "sid" if order_by == "id" else order_by
        res = await self._run(
            f"MATCH ({pattern}) WHERE {' AND '.join(where)} "
            f"RETURN n.doc AS doc, n.`{ob}` AS __ob ORDER BY __ob SKIP $skip LIMIT $limit",
            params,
            reads=params.get("iids", [_label_key(label)]),
        )
        return docs(res.rows)

    async def delete_node(self, ns: str, label: str, id: str) -> None:
        await self._run(f"MATCH (n:{label} {{id: $iid}}) DETACH DELETE n", {"iid": _sk(ns, id)})
        await self._drop_keys(label, [_sk(ns, id)])

    async def delete_nodes(self, ns: str, label: str, ids: list[str]) -> None:
        for batch in _batches(ids, _DELETE_BATCH):
            iids = [_sk(ns, i) for i in batch]
            await self._run("MATCH (n) WHERE n.id IN $iids DETACH DELETE n", {"iids": iids})
            await self._drop_keys(label, iids)

    async def delete_nodes_by(self, ns: str, label: str, *, equals: dict) -> int:
        params: dict[str, Any] = {"ns": ns, "batch": _DELETE_BATCH}
        pattern = _keyed("n", label, equals, params)
        where = _same("n", "ns", "ns")
        deleted = 0
        while True:
            res = await self._run(f"MATCH ({pattern}) WHERE {where} RETURN n.id AS iid LIMIT $batch", params)
            ids = [r["iid"] for r in res.rows]
            if ids:
                await self._run("MATCH (n) WHERE n.id IN $iids DETACH DELETE n", {"iids": ids})
                await self._drop_keys(label, ids)
            deleted += len(ids)
            if len(ids) < _DELETE_BATCH:
                return deleted

    async def create_edge(
        self, ns: str, type: str, from_label: str, from_id: str, to_label: str, to_id: str, props: dict
    ) -> bool:
        pending = self._pending_nodes
        ends = {
            k: iid
            for k, label, iid in (("f", from_label, _sk(ns, from_id)), ("t", to_label, _sk(ns, to_id)))
            if (label, iid) not in pending
        }
        if ends:
            nodes = {"f": f"(a:{from_label} {{id: $f}})", "t": f"(b:{to_label} {{id: $t}})"}
            found = await self._run(
                f"MATCH {', '.join(nodes[k] for k in ends)} RETURN {'a' if 'f' in ends else 'b'}.sid AS sid",
                ends,
                reads=ends.values(),
            )
            if not found.rows:
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
                "fa": from_id,
                "tb": to_id,
                "fl": from_label,
                "tl": to_label,
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
            await self._write(
                f"UNWIND $rows AS row MATCH (a:{from_label} {{id: row.f}}), (b:{to_label} {{id: row.t}}) "
                f"MERGE (a)-[r:{_EDGE} {{id: row.id}}]->(b) SET {_sets('r', batch[0], ('f', 't', 'id'))}",
                {"rows": batch},
                [*(r["id"] for r in batch), *(_sid_key(ns, r["sid"]) for r in batch if "sid" in r)],
                [i for r in batch for i in (r["f"], r["t"])],
                after_all=any(r.get("is_current") is False and r.get("invalidated_by") for r in batch),
            )

    async def get_current_edge(self, ns: str, id: str) -> dict | None:
        res = await self._run(
            f"{_BY_SID} AND r.is_current = true RETURN r.doc AS doc, r.fa AS fa, r.tb AS tb, r.etype AS et",
            {"ns": ns, "sid": id},
            reads=[_sid_key(ns, id)],
        )
        return edge_row(res.rows[0]) if res.rows else None

    async def list_edge_versions(self, ns: str, id: str) -> list[dict]:
        res = await self._run(
            f"{_BY_SID} RETURN r.doc AS doc, r.fa AS fa, r.tb AS tb, r.etype AS et, r.revision AS rev ORDER BY rev",
            {"ns": ns, "sid": id},
            reads=[_sid_key(ns, id)],
        )
        return [edge_row(r) for r in res.rows]

    async def edge_versions(
        self, ns: str, from_label: str | None, to_label: str | None, ids: list[str]
    ) -> list[dict] | None:
        """Read every version of some edges by edge id, a point seek per id, run concurrently, when there are few.

        More than _SEEK_BATCH ids cost more seeks than reading them by endpoint, so the caller reads them that way.

        @param ns (str): namespace.
        @param from_label (str | None): the source node label the edges must have, or None for any.
        @param to_label (str | None): the destination node label the edges must have, or None for any.
        @param ids (list[str]): the edge ids.
        @return (list[dict] | None): the edge rows, grouped by id in the order given, or None for too many ids.
        """
        if len(ids) > _SEEK_BATCH:
            return None
        labels = {k: v for k, v in (("fl", from_label), ("tl", to_label)) if v is not None}
        where = "".join(f" AND {_same('r', k, k)}" for k in labels)
        query = f"{_BY_SID}{where} RETURN r.doc AS doc, r.fa AS fa, r.tb AS tb, r.etype AS et"
        out: list[dict] = []
        for batch in _batches(ids, _PARALLEL):
            params = [{"ns": ns, "sid": i, **labels} for i in batch]
            reads = (self._run(query, p, reads=[_sid_key(ns, p["sid"])]) for p in params)
            for res in await asyncio.gather(*reads):
                out += [edge_row(r) for r in res.rows]
        return out

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
        if keys := _unset(merged):
            await self._run(f"{_BY_SID} AND r.is_current = true REMOVE {_removes('r', keys)}", {"ns": ns, "sid": id})

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
        id_gt: str | None = None,
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
        from_anchored = from_id is not None or from_in is not None
        to_anchored = to_id is not None or to_in is not None
        anchored = from_anchored or to_anchored
        filters = {"ns": ns, **({"etype": type} if type is not None else {}), **dict(sorted((equals or {}).items()))}
        if from_anchored and not to_anchored:
            bpat = ""
            if to_label:
                filters["tl"] = to_label
        elif to_anchored and not from_anchored:
            apat = ""
            filters["fl"] = from_label
        for i, (key, value) in enumerate(filters.items()):
            where.append(_same("r", key, f"eq{i}") if anchored else f"r.`{key}` = $eq{i}")
            params[f"eq{i}"] = value
        if current_only:
            where.append("NOT r.is_current <> true" if anchored else "r.is_current = true")
        where_after("r.sid", id_gt, where, params)
        ob = "sid" if order_by == "id" else order_by
        res = await self._run(
            f"MATCH ({apat})-[r:{_EDGE}]->({bpat}) WHERE {' AND '.join(where)} "
            f"RETURN r.doc AS doc, r.fa AS fa, r.tb AS tb, r.etype AS et, r.`{ob}` AS __ob "
            f"ORDER BY __ob SKIP $skip LIMIT $limit",
            params,
        )
        return [edge_row(r) for r in res.rows]

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
            f"WHERE {_same('r', 'ns', 'ns')} AND {_same('r', 'etype', 'et')} RETURN c.doc AS doc{ob}{order}",
            {"iid": _sk(ns, parent_id), "ns": ns, "et": edge_type},
        )
        return docs(res.rows)

    async def children_of(
        self, ns: str, parent_label: str, parent_ids: list[str], edge_type: str, child_label: str
    ) -> dict[str, list[dict]]:
        """Read the child nodes of many parents along one edge type, a batch of parents per read.

        @param ns (str): namespace.
        @param parent_label (str): the parents' label.
        @param parent_ids (list[str]): the parent ids.
        @param edge_type (str): the edge type from parent to child.
        @param child_label (str): the children's label.
        @return (dict[str, list[dict]]): each parent's children's properties, by parent id, for parents with any.
        """
        out: dict[str, list[dict]] = {}
        for batch in _batches(parent_ids, _SEEK_BATCH):
            res = await self._run(
                f"MATCH (p:{parent_label})-[r:{_EDGE}]->(c:{child_label}) WHERE p.id IN $iids "
                f"AND {_same('r', 'ns', 'ns')} AND {_same('r', 'etype', 'et')} RETURN p.sid AS parent, c.doc AS doc",
                {"iids": [_sk(ns, i) for i in batch], "ns": ns, "et": edge_type},
            )
            for row in res.rows:
                if row["doc"] is not None:
                    out.setdefault(row["parent"], []).append(json.loads(row["doc"]))
        return out

    async def delete_edges_touching_by_type(self, ns: str, label: str, id: str, type: str) -> None:
        await self._run(
            f"MATCH (t:{label} {{id: $iid}})-[r:{_EDGE}]-(o) "
            f"WHERE {_same('r', 'ns', 'ns')} AND {_same('r', 'etype', 'et')} DELETE r",
            {"iid": _sk(ns, id), "ns": ns, "et": type},
        )

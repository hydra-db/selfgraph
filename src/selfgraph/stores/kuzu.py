from __future__ import annotations

import asyncio
import inspect
import json
import os
import threading
import time
from collections.abc import Mapping
from concurrent.futures import Future
from contextvars import ContextVar
from functools import partial
from typing import Any

from ..errors import SelfGraphError, StoreError, ValidationError, mask_uri, split_scheme
from ..ids import quote_label, require_identifier
from ..models import CypherResult, JsonValue
from ._cypher import AutoCommitStore, count_of, require_keys, where_after, write_batches
from ._docrows import docs, edge_row, first_doc, merged_current_edge

__all__ = ["KuzuStore"]

_SCHEME_STORES = {
    "bolt": "Neo4jStore",
    "neo4j": "Neo4jStore",
    "memgraph": "Neo4jStore",
    "redis": "FalkorDBStore",
    "falkor": "FalkorDBStore",
    "falkors": "FalkorDBStore",
    "hydradb": "HydraDBStore",
}


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


_SCHEMA = (
    "CREATE NODE TABLE IF NOT EXISTS N(pk STRING, id STRING, ns STRING, label STRING, doc STRING, PRIMARY KEY(pk))",
    "CREATE REL TABLE IF NOT EXISTS R(FROM N TO N, sid STRING, ns STRING, etype STRING, "
    "is_current BOOLEAN, revision INT64, doc STRING)",
)
_DATABASES: dict[object, Any] = {}
_DATABASE_OPTIONS: dict[object, dict[str, Any]] = {}


_PENDING: ContextVar[tuple[Future[None], ...]] = ContextVar("selfgraph_kuzu_locks", default=())


class _PathLock:
    def __init__(self) -> None:
        released: Future[None] = Future()
        released.set_result(None)
        self._tail = released
        self._claim = threading.Lock()

    def _join(self) -> tuple[Future[None], Future[None]]:
        """Take the next place in the queue.

        @return (tuple[Future[None], Future[None]]): the future to wait on, and this waiter's own token.
        """
        with self._claim:
            previous = self._tail
            mine: Future[None] = Future()
            self._tail = mine
        return previous, mine

    async def __aenter__(self) -> None:
        """Wait for the store ahead in the queue to release.

        @return (None): nothing.
        """
        previous, mine = self._join()
        _PENDING.set((*_PENDING.get(), mine))
        try:
            await asyncio.shield(asyncio.wrap_future(previous))
        except BaseException:
            _PENDING.set(_PENDING.get()[:-1])
            previous.add_done_callback(lambda _done, _mine=mine: _mine.set_result(None))
            raise

    async def __aexit__(self, *exc_info: object) -> None:
        """Release the lock and hand the queue to the next waiter.

        @param exc_info (object): the exception triple, ignored.
        @return (None): nothing.
        """
        pending = _PENDING.get()
        token = pending[-1]
        _PENDING.set(pending[:-1])
        token.set_result(None)


_CACHE_LOCK = threading.Lock()
_LOCKS: dict[object, _PathLock] = {}
_WRITE_LOCKS: dict[object, _PathLock] = {}
_OPEN_STORES: dict[object, int] = {}
_MAX_SKIP = 10_000_000
_RECONNECT_EVERY = 500
_DEFAULT_CHECKPOINT_THRESHOLD = 16 * 1024**2
_CHECKPOINT_POOL_DIVISOR = 1024
_NOW = "RETURN current_timestamp()"
_CLOCK_TICK = 0.02


def _kuzu_error(exc: BaseException, prefix: str) -> StoreError:
    """Map a Kuzu error to a StoreError, adding what to do for the lock and mmap failures.

    @param exc (BaseException): the Kuzu exception.
    @param prefix (str): what failed, for the message.
    @return (StoreError): the error to raise.
    """
    if "Could not set lock on file" in str(exc):
        return StoreError(
            f"{prefix}: another process (an MCP server or script) has this Kuzu database open; Kuzu allows one "
            "process at a time",
            code="store_locked",
        )
    message = f"{prefix}: {' '.join(str(exc).split())}"
    if "Buffer manager exception: Mmap for size" in str(exc):
        message += "; too many Kuzu databases open in this process or max_db_size too large; pass a smaller max_db_size"
    return StoreError(message)


def _release_store(key: object) -> None:
    """Release one open-store reference, closing the cached database once the last store lets it go.

    @param key (object): the cache key the store was opened under.
    @return (None): nothing.
    """
    with _CACHE_LOCK:
        _OPEN_STORES[key] -= 1
        if _OPEN_STORES[key] == 0:
            del _OPEN_STORES[key]
            _DATABASES.pop(key).close()
            _DATABASE_OPTIONS.pop(key, None)
            _LOCKS.pop(key, None)
            _WRITE_LOCKS.pop(key, None)


def _db_options(kuzu: Any, db_kwargs: dict[str, Any]) -> dict[str, Any]:
    """Resolve Kuzu database kwargs against the kuzu.Database defaults.

    @param kuzu (Any): the lazily imported kuzu module.
    @param db_kwargs (dict[str, Any]): options a store was constructed with.
    @return (dict[str, Any]): every kuzu.Database option resolved to its effective value.
    """
    params = inspect.signature(kuzu.Database.__init__).parameters
    defaults = {n: p.default for n, p in params.items() if p.default is not inspect.Parameter.empty}
    return {**defaults, **db_kwargs}


def _pk(ns: str, id: str) -> str:
    return f"{ns}\x00{id}"


def _jv(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


_BY_SID = "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid"
_UPSERT_NODES = (
    "UNWIND $rows AS row WITH row, row.pk AS k MERGE (n:N {pk: k}) "
    "SET n.id = row.id, n.ns = $ns, n.label = $label, n.doc = row.doc"
)
_EDGE_ROWS = (
    "UNWIND $rows AS row WITH row, row.f AS f MATCH (a:N {pk: f}) WITH a, row, row.t AS t MATCH (b:N {pk: t}) "
    "WHERE a.label = $fl AND b.label = $tl "
)
_MERGE_EDGES = (
    "MERGE (a)-[r:R {sid: row.sid, ns: $ns, revision: CAST(row.rev AS INT64)}]->(b) "
    "SET r.etype = row.et, r.is_current = CAST(row.isc AS BOOL), r.doc = row.doc"
)
_CREATE_EDGES = (
    "CREATE (a)-[r:R {sid: CAST(row.sid AS STRING), ns: $ns, etype: row.et, is_current: CAST(row.isc AS BOOL), "
    "revision: CAST(row.rev AS INT64), doc: row.doc}]->(b)"
)
_BOTH_WAYS = ("(x:N {pk:$pk})-[r:R]->(o:N)", "(o:N)-[r:R]->(x:N {pk:$pk})")


def _where_doc_equals(alias: str, equals: dict | None, where: list[str], params: dict) -> None:
    """Add one json_extract equality clause per filter entry, in sorted key order, binding the key and JSON value.

    @param alias (str): the node or relationship variable.
    @param equals (dict | None): the property filter.
    @param where (list[str]): the clauses to extend.
    @param params (dict): the parameters to extend.
    @return (None): nothing.
    """
    for i, (key, value) in enumerate(sorted((equals or {}).items())):
        where.append(f"json_extract({alias}.doc, $k{i}) = json($v{i})")
        params[f"k{i}"] = require_identifier(key)
        params[f"v{i}"] = _jv(value)


def _where_doc_any_of(ns: str, any_of: dict | None, where: list[str], params: dict) -> None:
    """Add one membership clause per any_of entry, matching id on the primary key and other keys inside the document.

    @param ns (str): the namespace the primary keys are scoped to.
    @param any_of (dict | None): property name to the list of accepted values.
    @param where (list[str]): the clauses to extend.
    @param params (dict): the parameters to extend.
    @return (None): nothing.
    """
    for i, (key, values) in enumerate(sorted((any_of or {}).items())):
        key = require_identifier(key)
        if not values:
            where.append("false")
        elif key == "id":
            where.append(f"n.pk IN $in{i}")
            params[f"in{i}"] = [_pk(ns, v) for v in values]
        else:
            where.append(f"CAST(json_extract(n.doc, $ik{i}) AS STRING) IN list_transform($in{i}, x -> json(x))")
            params[f"ik{i}"] = key
            params[f"in{i}"] = [_jv(v) for v in values]


class KuzuStore(AutoCommitStore):
    query_labels = ("N", "R")

    def __init__(self, path: str = "selfgraph_kuzu", **db_kwargs: Any) -> None:
        """Open a Kuzu store on a path, sharing one cached database per path in this process.

        @param path (str): the database directory or file.
        @param db_kwargs (Any): kuzu.Database options, applied when this process first opens the path;
            a second store on the path must not pass different values.
        @return (None): nothing.
        """
        try:
            import kuzu
        except ImportError as exc:  # pragma: no cover
            raise StoreError(
                "the 'kuzu' package is required for KuzuStore; pip install \"selfgraph[kuzu]\"", code="missing_package"
            ) from exc
        max_db_size = db_kwargs.get("max_db_size")
        if max_db_size is not None and (type(max_db_size) is not int or max_db_size < 1):
            raise ValidationError(f"max_db_size must be a positive integer of bytes, got {max_db_size!r}")
        scheme = split_scheme(path)[0]
        if scheme:
            store = _SCHEME_STORES.get(scheme.lower(), "a server store")
            raise StoreError(
                f"KuzuStore takes a local path, not the server URI {mask_uri(path)!r}; use {store} for that scheme, "
                "or pass a file path for Kuzu",
                code="invalid_setting",
                field="uri",
            )
        path = os.path.expanduser(path)
        if path in ("", ":memory:"):
            key: object = object()
        else:
            path = key = os.path.abspath(path)
        with _CACHE_LOCK:
            db = _DATABASES.get(key)
            if db is None:
                os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
                options = dict(db_kwargs)
                pool_size = options.get("buffer_pool_size", 0)
                if path not in ("", ":memory:") and type(pool_size) is int and pool_size > 0:
                    options.setdefault(
                        "checkpoint_threshold",
                        min(_DEFAULT_CHECKPOINT_THRESHOLD, max(1, pool_size // _CHECKPOINT_POOL_DIVISOR)),
                    )
                try:
                    db = _DATABASES[key] = kuzu.Database(path, **options)
                except Exception as exc:  # noqa: BLE001
                    raise _kuzu_error(exc, f"could not open Kuzu database {path!r}") from exc
                _DATABASE_OPTIONS[key] = _db_options(kuzu, options)
            else:
                open_options = _DATABASE_OPTIONS[key]
                diffs = ", ".join(
                    f"{k} {open_options.get(k)!r} vs {v!r}"
                    for k, v in sorted(db_kwargs.items())
                    if v != open_options.get(k)
                )
                if diffs:
                    raise ValidationError(f"KuzuStore({path!r}) is already open with different options: {diffs}")
            _OPEN_STORES[key] = _OPEN_STORES.get(key, 0) + 1
            self._lock = _LOCKS.setdefault(key, _PathLock())
            self._write_lock = _WRITE_LOCKS.setdefault(key, _PathLock())
        self._cache_key = key
        self._db = db
        self._connect = partial(kuzu.Connection, db)
        try:
            self._conn = self._connect()
        except Exception:
            _release_store(key)
            raise
        self._statements = 0
        self._raw = False

    async def _run(self, query: str, params: Mapping[str, Any] | None = None, *, raw: bool = False) -> CypherResult:
        def _exec():
            qr = self._conn.execute(query, parameters=dict(params or {}))
            if isinstance(qr, list):
                raise StoreError("Kuzu runs one statement per query; pass one statement, not several joined by ';'")
            columns = qr.get_column_names()
            rows = []
            while qr.has_next():
                rows.append({k: _normalize(v) for k, v in zip(columns, qr.get_next(), strict=False)})
            return columns, rows

        async with self._lock:
            self._require_open()
            self._statements += 1
            try:
                if self._statements > _RECONNECT_EVERY:
                    self._statements = 1
                    if not (self._raw and await asyncio.to_thread(self._in_transaction)):
                        self._conn = self._connect()
                        self._raw = False
                self._raw = self._raw or raw
                columns, rows = await asyncio.to_thread(_exec)
                return CypherResult(columns=columns, rows=rows)
            except SelfGraphError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise _kuzu_error(exc, "Kuzu query failed") from exc

    def _in_transaction(self) -> bool:
        """Report whether a raw statement left a transaction open, as two current_timestamp() reads a tick apart match.

        @return (bool): True when a transaction is open.
        """
        first = self._conn.execute(_NOW).get_next()
        time.sleep(_CLOCK_TICK)
        return self._conn.execute(_NOW).get_next() == first

    async def run_cypher(self, query: str, params: Mapping[str, JsonValue] | None = None) -> CypherResult:
        return await self._run(query, params, raw=True)

    async def initialize(self) -> None:
        """Create the node and relationship tables if they do not exist."""
        for stmt in _SCHEMA:
            await self._run(stmt)

    async def close(self) -> None:
        """Close the connection, and the database once no other store in this process holds it.

        @return (None): nothing.
        """
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            self._conn.close()
            _release_store(self._cache_key)

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
        await self.upsert_nodes(ns, label, [(id, props)], extra_label=extra_label)

    async def upsert_nodes(
        self, ns: str, label: str, rows: list[tuple[str, dict]], *, extra_label: str | None = None
    ) -> None:
        """Merge many nodes by id, a batch per statement, since each Kuzu statement commits on its own.

        @param ns (str): namespace.
        @param label (str): the node label.
        @param rows (list[tuple[str, dict]]): (node id, properties) pairs.
        @param extra_label (str | None): validated only; the generic node table has no second label.
        @return (None): nothing.
        """
        if extra_label is not None:
            quote_label(extra_label)
        for _, props in rows:
            require_keys(props)
        for _, batch in write_batches((None, {"pk": _pk(ns, id), "id": id, "doc": _jv(props)}) for id, props in rows):
            await self._run(_UPSERT_NODES, {"rows": batch, "ns": ns, "label": label})

    async def create_edges(
        self, ns: str, from_label: str, to_label: str, rows: list[tuple[str, str, str, dict]]
    ) -> None:
        """Create or update many edges, a batch per statement, skipping rows with a missing endpoint.

        Rows are batched in order by which of id, revision, and is_current are null, so every batch binds one type
        per column; rows with an id and a revision merge on them, the rest are created.

        @param ns (str): namespace.
        @param from_label (str): source node label.
        @param to_label (str): destination node label.
        @param rows (list[tuple[str, str, str, dict]]): (edge type, source id, destination id, properties) rows.
        @return (None): nothing.
        """
        for *_, props in rows:
            require_keys(props)
        edge_rows = [
            {
                "f": _pk(ns, from_id),
                "t": _pk(ns, to_id),
                "sid": props.get("id"),
                "et": type,
                "isc": props.get("is_current"),
                "rev": props.get("revision"),
                "doc": _jv(props),
            }
            for type, from_id, to_id, props in rows
        ]
        keyed = (((r["sid"] is None, r["rev"] is None, r["isc"] is None), r) for r in edge_rows)
        for (no_sid, no_rev, _), batch in write_batches(keyed):
            write = _CREATE_EDGES if no_sid or no_rev else _MERGE_EDGES
            await self._run(_EDGE_ROWS + write, {"rows": batch, "ns": ns, "fl": from_label, "tl": to_label})

    async def remove_node_label(self, ns: str, label: str, id: str, drop_label: str) -> None:
        return None

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
        if skip > _MAX_SKIP:
            return []
        where = ["n.ns = $ns", "n.label = $label"]
        params: dict[str, Any] = {"ns": ns, "label": label}
        _where_doc_equals("n", equals, where, params)
        _where_doc_any_of(ns, any_of, where, params)
        where_after("n.id", id_gt, where, params)
        ob = "n.id" if order_by == "id" else f"json_extract(n.doc, '{require_identifier(order_by, 'order_by')}')"
        res = await self._run(
            f"MATCH (n:N) WHERE {' AND '.join(where)} "
            f"RETURN n.doc AS doc ORDER BY {ob} SKIP {int(skip)} LIMIT {int(limit)}",
            params,
        )
        return docs(res.rows)

    async def delete_node(self, ns: str, label: str, id: str) -> None:
        await self._run("MATCH (n:N {pk:$pk}) DETACH DELETE n", {"pk": _pk(ns, id)})

    async def delete_nodes(self, ns: str, label: str, ids: list[str]) -> None:
        if ids:
            await self._run("MATCH (n:N) WHERE n.pk IN $pks DETACH DELETE n", {"pks": [_pk(ns, i) for i in ids]})

    async def delete_nodes_by(self, ns: str, label: str, *, equals: dict) -> int:
        where = ["n.ns = $ns", "n.label = $label"]
        params: dict[str, Any] = {"ns": ns, "label": label}
        _where_doc_equals("n", equals, where, params)
        res = await self._run(f"MATCH (n:N) WHERE {' AND '.join(where)} RETURN n.pk AS pk", params)
        pks = [r["pk"] for r in res.rows]
        if pks:
            await self._run("MATCH (n:N) WHERE n.pk IN $pks DETACH DELETE n", {"pks": pks})
        return len(pks)

    async def create_edge(
        self, ns: str, type: str, from_label: str, from_id: str, to_label: str, to_id: str, props: dict
    ) -> bool:
        if not await self.node_exists(ns, from_label, from_id) or not await self.node_exists(ns, to_label, to_id):
            return False
        await self.create_edges(ns, from_label, to_label, [(type, from_id, to_id, props)])
        return True

    async def get_current_edge(self, ns: str, id: str) -> dict | None:
        res = await self._run(
            f"{_BY_SID} AND r.is_current = true RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et",
            {"ns": ns, "sid": id},
        )
        return edge_row(res.rows[0]) if res.rows else None

    async def list_edge_versions(self, ns: str, id: str) -> list[dict]:
        res = await self._run(
            f"{_BY_SID} RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et, r.revision AS rev ORDER BY rev",
            {"ns": ns, "sid": id},
        )
        return [edge_row(r) for r in res.rows]

    async def edge_versions(
        self, ns: str, from_label: str | None, to_label: str | None, ids: list[str]
    ) -> list[dict] | None:
        """Read edge versions for a bounded list of ids in one query.

        @param ns (str): namespace.
        @param from_label (str | None): source label, or None for any.
        @param to_label (str | None): target label, or None for any.
        @param ids (list[str]): edge ids.
        @return (list[dict] | None): rows grouped by requested id, or None for more than 256 ids.
        """
        if len(ids) > 256:
            return None
        if not ids:
            return []
        where = ["r.ns = $ns", "r.sid IN $ids"]
        params: dict[str, Any] = {"ns": ns, "ids": ids}
        for alias, label in (("a", from_label), ("b", to_label)):
            if label is not None:
                where.append(f"{alias}.label = ${alias}_label")
                params[f"{alias}_label"] = label
        result = await self._run(
            f"MATCH (a:N)-[r:R]->(b:N) WHERE {' AND '.join(where)} "
            "RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et",
            params,
        )
        rows = [edge_row(row) for row in result.rows]
        order = {rid: i for i, rid in enumerate(ids)}
        return sorted(rows, key=lambda row: order[row["props"]["id"]])

    async def update_current_edge(self, ns: str, id: str, props: dict) -> None:
        require_keys(props)
        merged = await merged_current_edge(self, ns, id, props)
        if merged is None:
            return
        assignments = ["r.doc = $doc"]
        params: dict[str, Any] = {"ns": ns, "sid": id, "doc": _jv(merged)}
        for field in ("is_current", "revision"):
            if field in props:
                assignments.append(f"r.{field} = ${field}")
                params[field] = merged.get(field)
        await self._run(f"{_BY_SID} AND r.is_current = true SET {', '.join(assignments)}", params)

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
        _where_doc_equals("r", equals, where, params)
        where_after("r.sid", id_gt, where, params)
        if order_by == "id":
            ob = "r.sid, r.revision"
        elif order_by == "revision":
            ob = "r.revision"
        else:
            ob = f"json_extract(r.doc, '{require_identifier(order_by, 'order_by')}')"
        res = await self._run(
            f"MATCH (a:N)-[r:R]->(b:N) WHERE {' AND '.join(where)} "
            f"RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et "
            f"ORDER BY {ob}, a.id, b.id, r.etype SKIP {int(skip)} LIMIT {int(limit)}",
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
        order = (
            "" if order_by is None else f" ORDER BY json_extract(c.doc, '{require_identifier(order_by, 'order_by')}')"
        )
        res = await self._run(
            "MATCH (p:N {pk:$pk})-[r:R]->(c:N) "
            f"WHERE r.ns = $ns AND r.etype = $et AND c.label = $cl RETURN c.doc AS doc{order}",
            {"pk": _pk(ns, parent_id), "ns": ns, "et": edge_type, "cl": child_label},
        )
        return docs(res.rows)

    async def delete_edges_touching_by_type(self, ns: str, label: str, id: str, type: str) -> None:
        for pattern in _BOTH_WAYS:
            await self._run(
                f"MATCH {pattern} WHERE r.ns = $ns AND r.etype = $et DELETE r",
                {"pk": _pk(ns, id), "ns": ns, "et": type},
            )

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Iterable, Mapping
from concurrent.futures import Future
from contextvars import ContextVar
from decimal import InvalidOperation
from functools import partial
from typing import Any

from .._ops import _batches
from .._serde import L_ENTITY, decode_entity
from ..errors import SelfGraphError, StoreError, ValidationError, escape_controls, mask_uri, split_scheme
from ..ids import quote_label, require_identifier
from ..models import CypherResult, JsonValue, check_options
from ..resolution import match_keys
from ._cypher import AutoCommitStore, count_of, require_keys, where_after, write_batches
from ._docrows import docs, edge_row, first_doc, merged_current_edge, parse_doc
from ._kuzu_values import UNREADABLE_DECIMAL, normalize

__all__ = ["KuzuStore"]


_SCHEMA = (
    "CREATE NODE TABLE IF NOT EXISTS N(pk STRING, id STRING, ns STRING, label STRING, doc STRING, PRIMARY KEY(pk))",
    "CREATE REL TABLE IF NOT EXISTS R(FROM N TO N, sid STRING, ns STRING, etype STRING, "
    "is_current BOOLEAN, revision INT64, doc STRING)",
    "CREATE NODE TABLE IF NOT EXISTS K(pk STRING, ns STRING, key STRING, eid STRING, PRIMARY KEY(pk))",
)
_SEEK_BATCH = 256
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
            if not previous.done():
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
_SCHEMA_GEN: dict[object, int] = {}
_MAX_SKIP = 10_000_000
_RECONNECT_EVERY = 500
_PLAN_CACHE_MAX = 64
_DEFAULT_CHECKPOINT_THRESHOLD = 16 * 1024**2
_CHECKPOINT_POOL_DIVISOR = 512
_NOW = "RETURN current_timestamp()"
_CLOCK_TICK = 0.02
_MULTI_STATEMENT = "Kuzu runs one statement per query; pass one statement, not several joined by ';'"


def _non_empty_statements(query: str) -> int:
    """Count the ';'-separated statements in a query, ignoring semicolons inside string literals and comments.

    @param query (str): the raw Cypher query.
    @return (int): the number of statements that hold a non-whitespace token outside literals and comments.
    """
    from .._cypher_guard import blank_lexical_tokens

    return sum(1 for part in blank_lexical_tokens(query).split(";") if part.replace("\x00", "").split())


def _require_typed_params(params: Mapping[str, Any] | None) -> None:
    """Reject empty lists and maps in Kuzu parameters, which it cannot give a type.

    @param params (Mapping[str, Any] | None): the query parameters.
    @return (None): nothing; raises ValidationError naming the parameter.
    """
    for name, value in (params or {}).items():
        found = _empty_container(value, name)
        if found is not None:
            kind, path = found
            raise ValidationError(
                f"parameter {path!r} is an empty {kind}, which Kuzu cannot type; pass a non-empty {kind}",
                field=name,
            )


def _empty_container(value: Any, path: str) -> tuple[str, str] | None:
    """Find the first empty list or map in a parameter value, depth first.

    Map keys are sorted before the walk so both SDKs report the same first empty
    container: Python keeps insertion order while a JS object puts integer-like
    keys first.

    @param value (Any): the parameter value or a nested value.
    @param path (str): where the value sits in the parameter.
    @return (tuple[str, str] | None): the kind, "list" or "map", and its path, or None when every container has a value.
    """
    if isinstance(value, list | tuple):
        if not value:
            return "list", path
        for i, item in enumerate(value):
            found = _empty_container(item, f"{path}[{i}]")
            if found is not None:
                return found
    elif isinstance(value, Mapping):
        if not value:
            return "map", path
        for key in sorted(value, key=str):
            item = value[key]
            found = _empty_container(item, f"{path}.{key}")
            if found is not None:
                return found
    return None


_WS_RUN = re.compile("[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


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
    message = f"{prefix}: {_WS_RUN.sub(' ', escape_controls(str(exc))).strip()}"
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
            _SCHEMA_GEN.pop(key, None)


def _schema_gen(key: object) -> int:
    """Read the schema generation for a path, bumped whenever a raw statement may have changed its schema.

    @param key (object): the cache key the store was opened under.
    @return (int): the current generation, zero before any raw statement has run.
    """
    with _CACHE_LOCK:
        return _SCHEMA_GEN.get(key, 0)


def _bump_schema_gen(key: object) -> None:
    """Advance the schema generation for a path so every store on it rebuilds its prepared plans.

    @param key (object): the cache key the store was opened under.
    @return (None): nothing.
    """
    with _CACHE_LOCK:
        _SCHEMA_GEN[key] = _SCHEMA_GEN.get(key, 0) + 1


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


def _keys_of(props: Mapping[str, Any]) -> frozenset[str]:
    """The match keys of a stored entity, none for a document that is not a readable entity.

    @param props (Mapping[str, Any]): the encoded entity properties.
    @return (frozenset[str]): its keys, as resolution.match_keys derives them.
    """
    try:
        ent = decode_entity(dict(props))
    except Exception:  # noqa: BLE001
        return frozenset()
    return match_keys(ent.name, ent.aliases, ent.external_ids)


def _readable(rows: Iterable[dict]) -> list[tuple[str, dict]]:
    """The (id, properties) pairs of stored rows whose document is valid JSON, so a corrupt row never blocks a
    backfill.

    @param rows (Iterable[dict]): the rows, each with doc, stored_id, and stored_ns columns.
    @return (list[tuple[str, dict]]): the readable entities.
    """
    out = []
    for row in rows:
        try:
            props = parse_doc(row)
        except SelfGraphError:
            continue
        out.append((row["stored_id"], props))
    return out


def _jv(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


_BY_SID = "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid"
_UPSERT_NODES = (
    "UNWIND $rows AS row WITH row, row.pk AS k MERGE (n:N {pk: k}) "
    "SET n.id = row.id, n.ns = $ns, n.label = $label, n.doc = row.doc"
)
_MERGE_KEYS = (
    "UNWIND $rows AS row WITH row, row.pk AS k MERGE (n:K {pk: k}) SET n.ns = $ns, n.key = row.key, n.eid = row.eid"
)
_UPSERT_NEW_NODES = (
    "UNWIND $keys AS key WITH key, key.pk AS kp MERGE (k:K {pk: kp}) "
    "SET k.ns = $ns, k.key = key.key, k.eid = key.eid "
    "WITH count(*) AS key_count " + _UPSERT_NODES
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


_SCHEME_STORES = {
    "bolt": "Neo4jStore",
    "neo4j": "Neo4jStore",
    "memgraph": "Neo4jStore",
    "redis": "FalkorDBStore",
    "falkor": "FalkorDBStore",
    "falkors": "FalkorDBStore",
    "hydradb": "HydraDBStore",
}


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
        check_options(
            "KuzuStore",
            (key for key in db_kwargs if key not in inspect.signature(kuzu.Database).parameters),
            ("buffer_pool_size", "max_db_size", "compression", "read_only"),
        )
        max_db_size = db_kwargs.get("max_db_size")
        if max_db_size is not None and (type(max_db_size) is not int or max_db_size < 1):
            raise ValidationError(f"max_db_size must be a positive integer of bytes, got {max_db_size!r}")
        scheme = split_scheme(path)[0]
        if scheme:
            store = _SCHEME_STORES.get(scheme.lower(), "a server store")
            raise StoreError(
                f"KuzuStore takes a local path, not the server URI {mask_uri(path)!r}; use {store} for that "
                "scheme, or pass a file path for Kuzu",
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
        self._read_only = _DATABASE_OPTIONS[key]["read_only"]
        self._db = db
        self._connect = partial(kuzu.Connection, db)
        try:
            self._conn = self._connect()
        except Exception:
            _release_store(key)
            raise
        self._statements = 0
        self._raw = False
        self._plans: OrderedDict[str, Any] = OrderedDict()
        self._plans_conn = self._conn
        self._plans_gen = _schema_gen(key)

    async def _in_thread(self, fn: Any, conn: Any, token: Future[None], state: dict[str, bool]) -> Any:
        """Run a Kuzu call in a worker thread, holding the path lock until the thread leaves the native call.

        Cancelling the await returns at once, but releasing the path lock while the worker is still inside the
        native call would let close() or a reconnect free the connection under it and crash the process. So on
        cancellation the lock token's release is handed to the worker's done callback and the caller re-raises
        immediately; close() and a reconnect wait on the token and never free a live connection. interrupt() is a
        best effort, since on some platforms it does not stop an in-flight statement; there the worker runs on.

        @param fn (Any): the no-argument callable to run on conn.
        @param conn (Any): the connection fn runs on, interrupted on cancellation.
        @param token (Future[None]): the path-lock token, released by the worker when the caller is cancelled.
        @param state (dict[str, bool]): set state["deferred"] so the caller leaves the token to the worker.
        @return (Any): the callable's result.
        """
        work = asyncio.get_running_loop().run_in_executor(None, fn)
        try:
            return await asyncio.shield(work)
        except asyncio.CancelledError:
            try:
                conn.interrupt()
            except Exception:  # noqa: BLE001
                pass
            state["deferred"] = True

            def _release(done: Any, _t: Future[None] = token) -> None:
                """Consume the finished worker's result, then release the path lock to the next waiter.

                @param done (Any): the finished worker future.
                @param _t (Future[None]): the path-lock token to release.
                @return (None): nothing.
                """
                if not done.cancelled():
                    done.exception()
                _t.set_result(None)

            work.add_done_callback(_release)
            raise

    def _plan(self, conn: Any, query: str) -> Any:
        """Return a prepared statement to reuse for a parameterized SDK query, or the query string on failure.

        @param conn (Any): the connection the plan is prepared on and executed with.
        @param query (str): the SDK-generated parameterized query.
        @return (Any): a Kuzu PreparedStatement bound to conn, or the query string if preparing did not succeed.
        """
        gen = _schema_gen(self._cache_key)
        if self._plans_conn is not conn or self._plans_gen != gen:
            self._plans.clear()
            self._plans_conn = conn
            self._plans_gen = gen
        cached = self._plans.get(query)
        if cached is not None:
            self._plans.move_to_end(query)
            return cached
        prepare = getattr(conn, "_prepare", None)
        if prepare is None:
            return query
        prepared = prepare(query)
        if not prepared.is_success():
            return query
        self._plans[query] = prepared
        if len(self._plans) > _PLAN_CACHE_MAX:
            self._plans.popitem(last=False)
        return prepared

    async def _run(self, query: str, params: Mapping[str, Any] | None = None, *, raw: bool = False) -> CypherResult:
        def _exec(conn: Any) -> tuple[list[str], list[dict]]:
            if raw:
                _bump_schema_gen(self._cache_key)
                self._plans.clear()
                target: Any = query
            elif params:
                target = self._plan(conn, query)
            else:
                target = query
            try:
                qr = conn.execute(target, parameters=dict(params or {}))
                if isinstance(qr, list):
                    raise StoreError(_MULTI_STATEMENT)
                columns = qr.get_column_names()
                rows = []
                while qr.has_next():
                    try:
                        values = qr.get_next()
                    except InvalidOperation as exc:
                        raise StoreError(UNREADABLE_DECIMAL, code="inexact_value") from exc
                    rows.append({k: normalize(v) for k, v in zip(columns, values, strict=False)})
                return columns, rows
            finally:
                if raw:
                    _bump_schema_gen(self._cache_key)
                    self._plans.clear()

        previous, token = self._lock._join()
        try:
            if not previous.done():
                await asyncio.shield(asyncio.wrap_future(previous))
        except BaseException:
            previous.add_done_callback(lambda _done, _t=token: _t.set_result(None))
            raise
        state = {"deferred": False}
        try:
            self._require_open()
            self._statements += 1
            if self._statements > _RECONNECT_EVERY:
                self._statements = 1
                old = self._conn
                if not (self._raw and await self._in_thread(lambda: self._in_transaction(old), old, token, state)):
                    self._conn = self._connect()
                    self._raw = False
                    self._plans.clear()
                    self._plans_conn = self._conn
            self._raw = self._raw or raw
            conn = self._conn
            columns, rows = await self._in_thread(lambda: _exec(conn), conn, token, state)
            return CypherResult(columns=columns, rows=rows)
        except SelfGraphError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _kuzu_error(exc, "Kuzu query failed") from exc
        finally:
            if not state["deferred"]:
                token.set_result(None)

    def _in_transaction(self, conn: Any) -> bool:
        """Report whether a raw statement left a transaction open, as two current_timestamp() reads a tick apart match.

        @param conn (Any): the connection to probe.
        @return (bool): True when a transaction is open.
        """
        first = conn.execute(_NOW).get_next()
        time.sleep(_CLOCK_TICK)
        return conn.execute(_NOW).get_next() == first

    async def run_cypher(self, query: str, params: Mapping[str, JsonValue] | None = None) -> CypherResult:
        if _non_empty_statements(query) > 1:
            raise StoreError(_MULTI_STATEMENT)
        _require_typed_params(params)
        return await self._run(query, params, raw=True)

    async def initialize(self) -> None:
        """Create the node, relationship, and entity key tables if they do not exist, and index entities stored
        before the key table; a read-only store writes nothing, so it does neither.
        """
        if self._read_only:
            return
        for stmt in _SCHEMA:
            await self._run(stmt)
        if count_of((await self._run("MATCH (k:K) RETURN count(*) AS n")).rows):
            return
        after = ""
        while True:
            page = await self._run(
                "MATCH (n:N) WHERE n.label = $label AND n.pk > $after RETURN n.pk AS pk, n.ns AS ns, "
                "n.id AS stored_id, n.ns AS stored_ns, n.doc AS doc ORDER BY n.pk LIMIT 1000",
                {"label": L_ENTITY, "after": after},
            )
            if not page.rows:
                return
            after = page.rows[-1]["pk"]
            for ns in sorted({r["ns"] for r in page.rows}):
                await self._merge_keys(ns, _readable(r for r in page.rows if r["ns"] == ns))

    async def _merge_keys(self, ns: str, rows: list[tuple[str, dict]]) -> None:
        """Write the key rows of some entities, one per entity and match key, so a rewrite merges in place.

        @param ns (str): namespace.
        @param rows (list[tuple[str, dict]]): (entity id, encoded entity properties) pairs.
        @return (None): nothing.
        """
        keyed = (
            (None, {"pk": f"{ns}\x00{key}\x00{id}", "key": key, "eid": id})
            for id, props in rows
            for key in sorted(_keys_of(props))
        )
        for _, batch in write_batches(keyed):
            await self._run(_MERGE_KEYS, {"rows": batch, "ns": ns})

    async def _drop_keys(self, ns: str, ids: list[str]) -> None:
        """Delete the key rows of deleted entities, so the index only holds stored entities' keys.

        @param ns (str): namespace.
        @param ids (list[str]): the deleted entity ids.
        @return (None): nothing.
        """
        for batch in _batches(ids, _SEEK_BATCH):
            await self._run("MATCH (k:K) WHERE k.ns = $ns AND k.eid IN $ids DELETE k", {"ns": ns, "ids": batch})

    async def entities_matching(self, ns: str, keys: Iterable[str]) -> list[dict]:
        """Read the entities sharing a match key with some keys, through the key table instead of a scan.

        A key row whose entity is gone or no longer has that key, after an alias or external id was removed, is
        deleted on the way, so the index never grows stale.

        @param ns (str): namespace.
        @param keys (Iterable[str]): the match keys, as resolution.match_keys derives them.
        @return (list[dict]): the matching entities' properties.
        """
        hits: list[tuple[str, str, str]] = []
        for batch in _batches(sorted(set(keys)), _SEEK_BATCH):
            res = await self._run(
                "MATCH (k:K) WHERE k.ns = $ns AND k.key IN $keys RETURN k.pk AS pk, k.key AS key, k.eid AS eid",
                {"ns": ns, "keys": batch},
            )
            hits += [(r["pk"], r["key"], r["eid"]) for r in res.rows]
        found: dict[str, dict] = {}
        for batch in _batches(sorted({eid for _, _, eid in hits}), _SEEK_BATCH):
            res = await self._run(
                "MATCH (n:N) WHERE n.pk IN $pks AND n.label = $label "
                "RETURN n.doc AS doc, n.id AS stored_id, n.ns AS stored_ns",
                {"pks": [_pk(ns, eid) for eid in batch], "label": L_ENTITY},
            )
            found.update((props["id"], props) for props in docs(res.rows))
        held = {eid: _keys_of(props) for eid, props in found.items()}
        stale = [pk for pk, key, eid in hits if eid not in found or key not in held[eid]]
        for batch in _batches(stale, _SEEK_BATCH):
            await self._run("MATCH (k:K) WHERE k.pk IN $pks DELETE k", {"pks": batch})
        return list(found.values())

    def _discard(self) -> None:
        """Close a store no query has run on, without waiting for the path lock, which only queries hold.

        @return (None): nothing.
        """
        if self._closed:
            return
        self._closed = True
        self._conn.close()
        _release_store(self._cache_key)

    async def close(self) -> None:
        """Close the connection, and the database once no other store in this process holds it.

        @return (None): nothing.
        """
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            self._plans.clear()
            self._plans_conn = None
            self._conn.close()
            _release_store(self._cache_key)

    async def get_node(self, ns: str, label: str, id: str) -> dict | None:
        res = await self._run(
            "MATCH (n:N {pk:$pk}) WHERE n.label = $label RETURN n.doc AS doc, n.id AS stored_id, n.ns AS stored_ns",
            {"pk": _pk(ns, id), "label": label},
        )
        return first_doc(res.rows)

    async def node_exists(self, ns: str, label: str, id: str) -> bool:
        res = await self._run(
            "MATCH (n:N {pk:$pk}) WHERE n.label = $label RETURN n.pk AS pk",
            {"pk": _pk(ns, id), "label": label},
        )
        return bool(res.rows)

    async def nodes_exist(self, ns: str, label: str, ids: list[str]) -> set[str]:
        found: set[str] = set()
        for batch in _batches(list(dict.fromkeys(ids)), _SEEK_BATCH):
            params = {"label": label}
            for i, id in enumerate(batch):
                params[f"pk{i}"] = _pk(ns, id)
                params[f"id{i}"] = id
            query = " UNION ALL ".join(
                f"MATCH (n:N {{pk:$pk{i}}}) WHERE n.label = $label RETURN $id{i} AS id" for i in range(len(batch))
            )
            res = await self._run(query, params)
            found.update(row["id"] for row in res.rows)
        return found

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
        if await self._upsert_bounded_entities(ns, label, rows):
            return
        if label == L_ENTITY:
            await self._merge_keys(ns, rows)
        for _, batch in write_batches((None, {"pk": _pk(ns, id), "id": id, "doc": _jv(props)}) for id, props in rows):
            await self._run(_UPSERT_NODES, {"rows": batch, "ns": ns, "label": label})

    async def _upsert_bounded_entities(self, ns: str, label: str, rows: list[tuple[str, dict]]) -> bool:
        """Merge eligible entities and their keys atomically.

        @param ns (str): namespace.
        @param label (str): node label.
        @param rows (list[tuple[str, dict]]): validated node rows.
        @return (bool): whether the atomic write ran.
        """
        if label != L_ENTITY or not rows or len(rows) > 50:
            return False
        keys = []
        for id, props in rows:
            derived = _keys_of(props)
            if len(keys) + len(derived) > 256:
                return False
            keys.extend({"pk": f"{ns}\x00{key}\x00{id}", "key": key, "eid": id} for key in sorted(derived))
        if not keys:
            return False
        params = {
            "keys": keys,
            "rows": [{"pk": _pk(ns, id), "id": id, "doc": _jv(props)} for id, props in rows],
            "ns": ns,
            "label": label,
        }
        if len(_jv(params).encode("utf-8")) > 64 * 1024:
            return False
        await self._run(_UPSERT_NEW_NODES, params)
        return True

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
            f"RETURN n.doc AS doc, n.id AS stored_id, n.ns AS stored_ns"
            f" ORDER BY {ob} SKIP {int(skip)} LIMIT {int(limit)}",
            params,
        )
        return docs(res.rows)

    async def delete_node(self, ns: str, label: str, id: str) -> None:
        await self.delete_nodes(ns, label, [id])

    async def delete_nodes(self, ns: str, label: str, ids: list[str]) -> None:
        if ids:
            await self._run("MATCH (n:N) WHERE n.pk IN $pks DETACH DELETE n", {"pks": [_pk(ns, i) for i in ids]})
            if label == L_ENTITY:
                await self._drop_keys(ns, ids)

    async def delete_nodes_by(self, ns: str, label: str, *, equals: dict) -> int:
        where = ["n.ns = $ns", "n.label = $label"]
        params: dict[str, Any] = {"ns": ns, "label": label}
        _where_doc_equals("n", equals, where, params)
        res = await self._run(f"MATCH (n:N) WHERE {' AND '.join(where)} RETURN n.pk AS pk, n.id AS id", params)
        pks = [r["pk"] for r in res.rows]
        if pks:
            await self._run("MATCH (n:N) WHERE n.pk IN $pks DETACH DELETE n", {"pks": pks})
            if label == L_ENTITY:
                await self._drop_keys(ns, [r["id"] for r in res.rows])
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
            f"{_BY_SID} AND r.is_current = true "
            f"RETURN r.doc AS doc, r.sid AS stored_id, r.ns AS stored_ns, a.id AS fa, b.id AS tb, r.etype AS et",
            {"ns": ns, "sid": id},
        )
        return edge_row(res.rows[0]) if res.rows else None

    async def list_edge_versions(self, ns: str, id: str) -> list[dict]:
        res = await self._run(
            f"{_BY_SID} RETURN r.doc AS doc, r.sid AS stored_id, r.ns AS stored_ns, "
            "a.id AS fa, b.id AS tb, r.etype AS et, r.revision AS rev ORDER BY rev",
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
            "RETURN r.doc AS doc, r.sid AS stored_id, r.ns AS stored_ns, a.id AS fa, b.id AS tb, r.etype AS et",
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
            f"RETURN r.doc AS doc, r.sid AS stored_id, r.ns AS stored_ns, a.id AS fa, b.id AS tb, r.etype AS et "
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
            f"WHERE r.ns = $ns AND r.etype = $et AND c.label = $cl "
            f"RETURN c.doc AS doc, c.id AS stored_id, c.ns AS stored_ns{order}",
            {"pk": _pk(ns, parent_id), "ns": ns, "et": edge_type, "cl": child_label},
        )
        return docs(res.rows)

    async def delete_edges_touching_by_type(self, ns: str, label: str, id: str, type: str) -> None:
        for pattern in _BOTH_WAYS:
            await self._run(
                f"MATCH {pattern} WHERE r.ns = $ns AND r.etype = $et DELETE r",
                {"pk": _pk(ns, id), "ns": ns, "et": type},
            )

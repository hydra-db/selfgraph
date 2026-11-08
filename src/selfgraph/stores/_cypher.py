from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

from ..errors import StoreError
from ..ids import quote_label, quote_reltype
from ..models import CypherResult, JsonValue


def bolt_driver(uri: str, auth: Any, **kwargs: Any) -> Any:
    """Open an async Bolt driver, turning a malformed URI or driver config into a StoreError.

    @param uri (str): the Bolt URI.
    @param auth (Any): the auth pair or token, or None.
    @param kwargs (Any): extra driver config.
    @return (Any): the driver.
    """
    try:
        from neo4j import AsyncGraphDatabase
    except ImportError as exc:  # pragma: no cover
        raise StoreError("the 'neo4j' Bolt driver is required; pip install neo4j") from exc
    try:
        return AsyncGraphDatabase.driver(uri, auth=auth, **kwargs)
    except Exception as exc:  # noqa: BLE001
        raise StoreError(f"cannot open a Bolt driver for {uri!r}: {exc}") from exc


_IN_WRITE: ContextVar[bool] = ContextVar("selfgraph_in_write", default=False)


WRITE_COUNTERS = (
    "nodes_created",
    "nodes_deleted",
    "relationships_created",
    "relationships_deleted",
    "properties_set",
)
_COUNTER_NAMES = (*WRITE_COUNTERS, "labels_added", "labels_removed")


def _to_json(value: Any) -> Any:
    """Convert Bolt graph types to plain JSON.

    @param value (Any): the value to convert.
    @return (Any): the plain-JSON equivalent.
    """
    from neo4j.graph import Node, Path, Relationship

    if isinstance(value, Node | Relationship):
        return {k: _to_json(v) for k, v in value.items()}
    if isinstance(value, Path):
        return {
            "nodes": [_to_json(n) for n in value.nodes],
            "relationships": [_to_json(r) for r in value.relationships],
        }
    if isinstance(value, bytes | bytearray):
        return value.hex()
    iso = getattr(value, "isoformat", None)
    if callable(iso):
        return iso()
    if type(value).__name__ in ("Duration", "Point"):
        return str(value)
    if isinstance(value, dict):
        return {k: _to_json(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_to_json(v) for v in value]
    return value


def _edge_row(row: dict) -> dict:
    """An edge from an r, from_e (from id), to_e (to id) and t (edge type) row.

    @param row (dict): the row.
    @return (dict): the edge's props, from_id, to_id and type.
    """
    return {"props": row["r"], "from_id": row["from_e"], "to_id": row["to_e"], "type": row["t"]}


def where_equals(alias: str, equals: dict | None, where: list[str], params: dict) -> None:
    """Add one alias.key = $eqN clause per equality-filter entry, in sorted key order, and bind its parameter.

    @param alias (str): the node or relationship variable.
    @param equals (dict | None): the property filter.
    @param where (list[str]): the clauses to extend.
    @param params (dict): the parameters to extend.
    @return (None): nothing.
    """
    for i, (key, value) in enumerate(sorted((equals or {}).items())):
        where.append(f"{alias}.{key} = $eq{i}")
        params[f"eq{i}"] = value


def where_any_of(alias: str, any_of: dict | None, where: list[str], params: dict) -> None:
    """Add one alias.key IN $inN clause per membership-filter entry, in sorted key order, and bind its parameter.

    @param alias (str): the node or relationship variable.
    @param any_of (dict | None): property name to the list of accepted values.
    @param where (list[str]): the clauses to extend.
    @param params (dict): the parameters to extend.
    @return (None): nothing.
    """
    for i, (key, values) in enumerate(sorted((any_of or {}).items())):
        where.append(f"{alias}.{key} IN $in{i}")
        params[f"in{i}"] = list(values)


def bind_list(values: list[str], prefix: str, params: dict, clause: Callable[[str], str]) -> list[str]:
    """Bind each value as $<prefix><i> and build one clause per value.

    @param values (list[str]): the values to bind.
    @param prefix (str): the parameter name prefix.
    @param params (dict): the parameters to extend.
    @param clause (Callable[[str], str]): builds the clause for one parameter reference.
    @return (list[str]): the clauses, in value order.
    """
    out = []
    for i, value in enumerate(values):
        params[f"{prefix}{i}"] = value
        out.append(clause(f"${prefix}{i}"))
    return out


class CypherRunner:
    async def _run(self, query: str, params: Mapping[str, Any] | None = None) -> CypherResult:
        raise NotImplementedError

    async def run_cypher(self, query: str, params: Mapping[str, JsonValue] | None = None) -> CypherResult:
        """Run one raw Cypher statement (backend-specific escape hatch).

        @param query (str): the statement.
        @param params (Mapping[str, JsonValue] | None): query parameters.
        @return (CypherResult): the rows.
        """
        return await self._run(query, params)

    async def upsert_nodes(
        self, ns: str, label: str, rows: list[tuple[str, dict]], *, extra_label: str | None = None
    ) -> None:
        """Merge many nodes of one label by id and set their properties, optionally adding a second label.

        @param ns (str): namespace.
        @param label (str): the primary label matched on.
        @param rows (list[tuple[str, dict]]): (node id, properties) pairs.
        @param extra_label (str | None): an additional label to add to every node.
        @return (None): nothing.
        """
        for id, props in rows:
            await self.upsert_node(ns, label, id, props, extra_label=extra_label)

    async def create_edges(
        self, ns: str, from_label: str, to_label: str, rows: list[tuple[str, str, str, dict]]
    ) -> None:
        """Create or update many directed typed edges between existing nodes, skipping rows with a missing endpoint.

        @param ns (str): namespace.
        @param from_label (str): source node label.
        @param to_label (str): destination node label.
        @param rows (list[tuple[str, str, str, dict]]): (edge type, source id, destination id, properties) rows.
        @return (None): nothing.
        """
        for type, from_id, to_id, props in rows:
            await self.create_edge(ns, type, from_label, from_id, to_label, to_id, props)


class AutoCommitStore(CypherRunner):
    async def lock_node(self, ns: str, label: str, id: str) -> None:
        """No-op: writes are already serialized per store by transaction.

        @param ns (str): namespace.
        @param label (str): node label.
        @param id (str): node id.
        @return (None): nothing.
        """
        return None

    @asynccontextmanager
    async def transaction(self):
        """Run one write at a time on this store, since an auto-commit backend cannot isolate a read-modify-write.

        @return (AsyncIterator[AutoCommitStore]): this store, held until the write finishes.
        """
        if _IN_WRITE.get():
            yield self
            return
        if "_write_lock" not in self.__dict__:
            self._write_lock = asyncio.Lock()
        async with self._write_lock:
            token = _IN_WRITE.set(True)
            try:
                yield self
            finally:
                _IN_WRITE.reset(token)


def count_of(rows: list[dict]) -> int:
    """The n column of the first row as an int, or 0 when there is no row.

    @param rows (list[dict]): the rows of a count query.
    @return (int): the count.
    """
    return int(rows[0]["n"]) if rows else 0


async def records_to_result(result) -> CypherResult:
    """Drain an async Bolt result into a CypherResult, with write counters when present.

    @param result (Any): the driver result.
    @return (CypherResult): the materialised rows and counters.
    """
    keys = list(result.keys())
    rows = [{k: _to_json(record[k]) for k in keys} async for record in result]
    summary = await result.consume()
    counters = {name: getattr(summary.counters, name, 0) for name in _COUNTER_NAMES}
    return CypherResult(columns=keys, rows=rows, counters={k: v for k, v in counters.items() if v})


class CypherPrimitives(CypherRunner):
    async def get_node(self, ns: str, label: str, id: str) -> dict | None:
        """Fetch a node's properties by label and id.

        @param ns (str): namespace.
        @param label (str): node label.
        @param id (str): node id.
        @return (dict | None): the node property map, or None.
        """
        res = await self._run(f"MATCH (n:{label} {{id:$id, ns:$ns}}) RETURN n", {"id": id, "ns": ns})
        return res.rows[0]["n"] if res.rows else None

    async def node_exists(self, ns: str, label: str, id: str) -> bool:
        """Report whether a node exists.

        @param ns (str): namespace.
        @param label (str): node label.
        @param id (str): node id.
        @return (bool): True when it exists.
        """
        res = await self._run(f"MATCH (n:{label} {{id:$id, ns:$ns}}) RETURN n.id AS id", {"id": id, "ns": ns})
        return bool(res.rows)

    async def lock_node(self, ns: str, label: str, id: str) -> None:
        """Take a write lock on a node to serialize concurrent read-modify-write updates.

        Bumping a dedicated counter forces a write lock on Neo4j and a write-write conflict
        on Memgraph, so concurrent updates that lock the same node run one at a time or retry.
        The counter lives outside the entity's properties_json, so it never decodes into data.

        @param ns (str): namespace.
        @param label (str): node label.
        @param id (str): node id.
        @return (None): nothing.
        """
        await self._run(
            f"MATCH (n:{label} {{id:$id, ns:$ns}}) SET n._lock = coalesce(n._lock, 0) + 1",
            {"id": id, "ns": ns},
        )

    async def upsert_node(self, ns: str, label: str, id: str, props: dict, *, extra_label: str | None = None) -> None:
        """Merge a node by id and set its properties, optionally adding a second label.

        @param ns (str): namespace.
        @param label (str): the primary label matched on.
        @param id (str): node id.
        @param props (dict): properties to set.
        @param extra_label (str | None): an additional label to add.
        """
        extra = f", n:{quote_label(extra_label)}" if extra_label is not None else ""
        await self._run(
            f"MERGE (n:{label} {{id:$id, ns:$ns}}) SET n += $props{extra}",
            {"id": id, "ns": ns, "props": props},
        )

    async def remove_node_label(self, ns: str, label: str, id: str, drop_label: str) -> None:
        """Remove a label from a node.

        @param ns (str): namespace.
        @param label (str): the label matched on.
        @param id (str): node id.
        @param drop_label (str): the label to remove.
        """
        await self._run(
            f"MATCH (n:{label} {{id:$id, ns:$ns}}) REMOVE n:{quote_label(drop_label)}",
            {"id": id, "ns": ns},
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
        """Return node property maps for a label, filtered by exact property matches and membership.

        @param ns (str): namespace.
        @param label (str): node label.
        @param equals (dict | None): property name to required value.
        @param any_of (dict | None): property name to the list of accepted values.
        @param order_by (str): node property to order by.
        @param skip (int): rows to skip.
        @param limit (int): maximum rows.
        @return (list[dict]): node property maps.
        """
        where = ["n.ns = $ns"]
        params: dict[str, Any] = {"ns": ns, "skip": skip, "limit": limit}
        where_equals("n", equals, where, params)
        where_any_of("n", any_of, where, params)
        query = f"MATCH (n:{label}) WHERE {' AND '.join(where)} RETURN n ORDER BY n.{order_by} SKIP $skip LIMIT $limit"
        res = await self._run(query, params)
        return [r["n"] for r in res.rows]

    async def delete_node(self, ns: str, label: str, id: str) -> None:
        """Detach-delete a node and its edges.

        @param ns (str): namespace.
        @param label (str): node label.
        @param id (str): node id.
        """
        await self._run(f"MATCH (n:{label} {{id:$id, ns:$ns}}) DETACH DELETE n", {"id": id, "ns": ns})

    async def delete_nodes_by(self, ns: str, label: str, *, equals: dict) -> int:
        """Detach-delete nodes matching exact property values.

        @param ns (str): namespace.
        @param label (str): node label.
        @param equals (dict): property name to required value.
        @return (int): number of nodes deleted.
        """
        where = ["n.ns = $ns"]
        params: dict[str, Any] = {"ns": ns}
        where_equals("n", equals, where, params)
        count = await self._run(f"MATCH (n:{label}) WHERE {' AND '.join(where)} RETURN count(n) AS n", params)
        n = count_of(count.rows)
        if n:
            await self._run(f"MATCH (n:{label}) WHERE {' AND '.join(where)} DETACH DELETE n", params)
        return n

    async def create_edge(
        self,
        ns: str,
        type: str,
        from_label: str,
        from_id: str,
        to_label: str,
        to_id: str,
        props: dict,
    ) -> bool:
        """Create a directed typed edge between two existing nodes.

        @param ns (str): namespace.
        @param type (str): edge type.
        @param from_label (str): source node label.
        @param from_id (str): source node id.
        @param to_label (str): destination node label.
        @param to_id (str): destination node id.
        @param props (dict): edge properties.
        @return (bool): True when both endpoints were found and the edge created.
        """
        match = f"MATCH (a:{from_label} {{id:$from, ns:$ns}}), (b:{to_label} {{id:$to, ns:$ns}}) "
        params: dict[str, Any] = {"from": from_id, "to": to_id, "ns": ns, "props": props}
        if "id" in props and "revision" in props:
            write = (
                f"MERGE (a)-[r:{quote_reltype(type)} {{id:$rid, ns:$ns, revision:$rev}}]->(b) "
                "SET r += $props RETURN r.id AS id"
            )
            params["rid"] = props["id"]
            params["rev"] = props["revision"]
        else:
            write = f"CREATE (a)-[r:{quote_reltype(type)}]->(b) SET r += $props RETURN r.id AS id"
        res = await self._run(match + write, params)
        return bool(res.rows)

    async def get_current_edge(self, ns: str, id: str) -> dict | None:
        """Fetch the current version of an edge by id.

        @param ns (str): namespace.
        @param id (str): edge id.
        @return (dict | None): a map with props, from_id, to_id, type, or None.
        """
        res = await self._run(
            "MATCH (a)-[r {id:$id, ns:$ns}]->(b) WHERE r.is_current = true "
            "RETURN r, a.id AS from_e, b.id AS to_e, type(r) AS t",
            {"id": id, "ns": ns},
        )
        return _edge_row(res.rows[0]) if res.rows else None

    async def list_edge_versions(self, ns: str, id: str) -> list[dict]:
        """Return every version of an edge by id, oldest first.

        @param ns (str): namespace.
        @param id (str): edge id.
        @return (list[dict]): maps with props, from_id, to_id, type.
        """
        res = await self._run(
            "MATCH (a)-[r {id:$id, ns:$ns}]->(b) "
            "RETURN r, a.id AS from_e, b.id AS to_e, type(r) AS t ORDER BY r.revision",
            {"id": id, "ns": ns},
        )
        return [_edge_row(r) for r in res.rows]

    async def update_current_edge(self, ns: str, id: str, props: dict) -> None:
        """Set properties on the current version of an edge.

        @param ns (str): namespace.
        @param id (str): edge id.
        @param props (dict): properties to set.
        """
        await self._run(
            "MATCH ()-[r {id:$id, ns:$ns}]->() WHERE r.is_current = true SET r += $props",
            {"id": id, "ns": ns, "props": props},
        )

    async def count_edges(self, ns: str, id: str) -> int:
        """Count the versions of an edge by id.

        @param ns (str): namespace.
        @param id (str): edge id.
        @return (int): the number of versions.
        """
        res = await self._run("MATCH ()-[r {id:$id, ns:$ns}]->() RETURN count(r) AS n", {"id": id, "ns": ns})
        return count_of(res.rows)

    async def delete_edges(self, ns: str, id: str) -> int:
        """Delete every version of an edge by id.

        @param ns (str): namespace.
        @param id (str): edge id.
        @return (int): the number deleted.
        """
        n = await self.count_edges(ns, id)
        if n:
            await self._run("MATCH ()-[r {id:$id, ns:$ns}]->() DELETE r", {"id": id, "ns": ns})
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
        """Return current or historical edges matching endpoint labels and filters.

        @param ns (str): namespace.
        @param from_label (str): source node label.
        @param to_label (str | None): destination node label, or None for any.
        @param type (str | None): required edge type.
        @param from_id (str | None): required source id.
        @param to_id (str | None): required destination id.
        @param from_in (list[str] | None): keep only edges whose source id is in this list.
        @param to_in (list[str] | None): keep only edges whose destination id is in this list.
        @param current_only (bool): restrict to current versions.
        @param equals (dict | None): required edge property values.
        @param order_by (str): edge property to order by.
        @param skip (int): rows to skip.
        @param limit (int): maximum rows.
        @return (list[dict]): maps with props, from_id, to_id, type.
        """
        blabel = f":{to_label}" if to_label else ""
        where = ["r.ns = $ns"]
        params: dict[str, Any] = {"ns": ns, "skip": skip, "limit": limit}
        if current_only:
            where.append("r.is_current = true")
        if from_id is not None:
            where.append("a.id = $from_e")
            params["from_e"] = from_id
        if to_id is not None:
            where.append("b.id = $to_e")
            params["to_e"] = to_id
        if from_in is not None:
            where.append("a.id IN $from_in")
            params["from_in"] = list(from_in)
        if to_in is not None:
            where.append("b.id IN $to_in")
            params["to_in"] = list(to_in)
        if type is not None:
            where.append("type(r) = $etype")
            params["etype"] = type
        where_equals("r", equals, where, params)
        query = (
            f"MATCH (a:{from_label})-[r]->(b{blabel}) WHERE {' AND '.join(where)} "
            f"RETURN r, a.id AS from_e, b.id AS to_e, type(r) AS t "
            f"ORDER BY r.{order_by} SKIP $skip LIMIT $limit"
        )
        res = await self._run(query, params)
        return [_edge_row(r) for r in res.rows]

    async def versioned_relation_ids(self, ns: str, label: str, id: str, *, exclude_types: list[str]) -> list[str]:
        """Return distinct ids of versioned edges touching a node, excluding some types.

        @param ns (str): namespace.
        @param label (str): the node's label.
        @param id (str): the node's id.
        @param exclude_types (list[str]): edge types to skip.
        @return (list[str]): the edge ids.
        """
        params: dict[str, Any] = {"id": id, "ns": ns}
        clauses = [
            "r.id IS NOT NULL",
            "r.revision IS NOT NULL",
            *bind_list(exclude_types, "ex", params, lambda p: f"type(r) <> {p}"),
        ]
        res = await self._run(
            f"MATCH (x:{label} {{id:$id, ns:$ns}})-[r]-(o) WHERE {' AND '.join(clauses)} RETURN DISTINCT r.id AS rid",
            params,
        )
        return [r["rid"] for r in res.rows]

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
        """Return property maps of child nodes reached by a typed edge.

        @param ns (str): namespace.
        @param parent_label (str): parent node label.
        @param parent_id (str): parent node id.
        @param edge_type (str): connecting edge type.
        @param child_label (str): child node label.
        @param order_by (str | None): child property to order by.
        @return (list[dict]): child property maps.
        """
        order = f" ORDER BY c.{order_by}" if order_by else ""
        res = await self._run(
            f"MATCH (p:{parent_label} {{id:$id, ns:$ns}})-[:{edge_type}]->(c:{child_label}) RETURN c{order}",
            {"id": parent_id, "ns": ns},
        )
        return [r["c"] for r in res.rows]

    async def count_out_edges(self, ns: str, label: str, id: str) -> int:
        """Count outgoing edges from a node.

        @param ns (str): namespace.
        @param label (str): node label.
        @param id (str): node id.
        @return (int): the count.
        """
        res = await self._run(
            f"MATCH (p:{label} {{id:$id, ns:$ns}})-[r]->() RETURN count(r) AS n", {"id": id, "ns": ns}
        )
        return count_of(res.rows)

    async def count_in_edges_typed(self, ns: str, label: str, id: str, types: list[str]) -> int:
        """Count incoming edges of given types into a node.

        @param ns (str): namespace.
        @param label (str): node label.
        @param id (str): node id.
        @param types (list[str]): edge types to count.
        @return (int): the count.
        """
        params: dict[str, Any] = {"id": id, "ns": ns}
        ors = bind_list(types, "t", params, lambda p: f"type(r) = {p}")
        res = await self._run(
            f"MATCH (p)-[r]->(x:{label} {{id:$id, ns:$ns}}) WHERE {' OR '.join(ors)} RETURN count(r) AS n",
            params,
        )
        return count_of(res.rows)

    async def delete_edges_touching_by_type(self, ns: str, label: str, id: str, type: str) -> None:
        """Delete all edges of a type incident to a node.

        @param ns (str): namespace.
        @param label (str): node label.
        @param id (str): node id.
        @param type (str): edge type to delete.
        """
        await self._run(
            f"MATCH (t:{label} {{id:$id, ns:$ns}}) MATCH (x)-[e:{type}]-(t) DELETE e",
            {"id": id, "ns": ns},
        )

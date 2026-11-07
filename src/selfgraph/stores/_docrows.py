from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from ..models import CypherResult

Run = Callable[[str, dict[str, Any]], Awaitable[CypherResult]]


def first_doc(rows: list[dict]) -> dict | None:
    """The parsed document of the first row, or None when there is no row or its document is null.

    @param rows (list[dict]): the rows, each with a doc column.
    @return (dict | None): the document.
    """
    doc = rows[0]["doc"] if rows else None
    return None if doc is None else json.loads(doc)


def docs(rows: list[dict]) -> list[dict]:
    """The parsed documents of the rows, skipping rows whose document is null.

    @param rows (list[dict]): the rows, each with a doc column.
    @return (list[dict]): the documents.
    """
    return [json.loads(r["doc"]) for r in rows if r["doc"] is not None]


def edge_row(row: dict) -> dict:
    """An edge from a doc, fa (from id), tb (to id) and et (edge type) row.

    @param row (dict): the row.
    @return (dict): the edge's props, from_id, to_id and type.
    """
    return {
        "props": json.loads(row["doc"]) if row["doc"] is not None else {},
        "from_id": row["fa"],
        "to_id": row["tb"],
        "type": row["et"],
    }


def _both_ways(node: str, rel: str, other: str) -> tuple[str, str]:
    """The outgoing and incoming relationship patterns between a node and its neighbour, in that order.

    @param node (str): the anchored node pattern body.
    @param rel (str): the relationship pattern body.
    @param other (str): the neighbour pattern body.
    @return (tuple[str, str]): the two patterns.
    """
    return f"({node})-[{rel}]->({other})", f"({other})-[{rel}]->({node})"


async def relation_ids_both_ways(
    run: Run, node: str, rel: str, other: str, where: list[str], params: dict[str, Any]
) -> list[str]:
    """The distinct r.sid values of the relationships matching in either direction, in first-seen order.

    @param run (Run): runs one statement.
    @param node (str): the anchored node pattern body.
    @param rel (str): the relationship pattern body, binding r.
    @param other (str): the neighbour pattern body.
    @param where (list[str]): the WHERE clauses.
    @param params (dict[str, Any]): the query parameters.
    @return (list[str]): the relationship ids.
    """
    out: list[str] = []
    for pattern in _both_ways(node, rel, other):
        res = await run(f"MATCH {pattern} WHERE {' AND '.join(where)} RETURN DISTINCT r.sid AS rid", params)
        out.extend(r["rid"] for r in res.rows)
    return list(dict.fromkeys(out))


async def delete_both_ways(run: Run, node: str, rel: str, other: str, params: dict[str, Any]) -> None:
    """Delete the relationships with r.ns = $ns and r.etype = $et in either direction.

    @param run (Run): runs one statement.
    @param node (str): the anchored node pattern body.
    @param rel (str): the relationship pattern body, binding r.
    @param other (str): the neighbour pattern body.
    @param params (dict[str, Any]): the query parameters, with ns and et.
    @return (None): nothing.
    """
    for pattern in _both_ways(node, rel, other):
        await run(f"MATCH {pattern} WHERE r.ns = $ns AND r.etype = $et DELETE r", params)


async def merged_current_edge(store: Any, ns: str, id: str, props: dict) -> dict | None:
    """The current edge's properties with the update applied, or None when there is no current edge.

    @param store (Any): the store.
    @param ns (str): the namespace.
    @param id (str): the edge id.
    @param props (dict): the properties to apply.
    @return (dict | None): the merged properties.
    """
    current = await store.get_current_edge(ns, id)
    return None if current is None else {**current["props"], **props}

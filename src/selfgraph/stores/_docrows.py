from __future__ import annotations

import json
from typing import Any


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

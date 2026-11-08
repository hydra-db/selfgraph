from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from . import ids as _ids
from ._serde import (
    L_CHUNK,
    L_SOURCE,
    L_SOURCE_VERSION,
    R_HAS_CHUNK,
    R_HAS_VERSION,
    child_edge_id,
    to_iso,
)
from .extraction.chunking import chunk_text
from .models import Evidence


async def record_source(
    runner: Any,
    ns: str,
    *,
    source_id: str,
    parsed_text: str,
    media_type: str,
    metadata: dict[str, Any] | None,
    created_at: datetime,
) -> tuple[str, list[Evidence]]:
    """Write the source, content-addressed version, and chunks; return the version id and its base evidence.

    @param runner (Any): the graph runner used to write nodes and relationships.
    @param ns (str): the namespace the source belongs to.
    @param source_id (str): the stable id of the source.
    @param parsed_text (str): the parsed document text to chunk and record.
    @param media_type (str): the media type of the source content.
    @param metadata (dict[str, Any] | None): optional metadata stored on the version.
    @param created_at (datetime): the insert timestamp stored on the version node.
    @return (tuple[str, list[Evidence]]): the source version id and one source-level evidence (chunk_id None).
    """
    sv = _ids.source_version_id(source_id, _ids.content_hash(parsed_text.encode("utf-8")))
    source_node = _ids.source_node_id(source_id)

    await runner.upsert_node(ns, L_SOURCE, source_node, {"id": source_node, "ns": ns, "source_id": source_id})
    await runner.upsert_node(
        ns,
        L_SOURCE_VERSION,
        sv,
        {
            "id": sv,
            "ns": ns,
            "source_id": source_id,
            "media_type": media_type,
            "created_at": to_iso(created_at),
            "metadata_json": json.dumps(metadata or {}, sort_keys=True, default=str),
        },
    )
    await runner.create_edge(
        ns,
        R_HAS_VERSION,
        L_SOURCE,
        source_node,
        L_SOURCE_VERSION,
        sv,
        {"ns": ns, "id": child_edge_id(R_HAS_VERSION, sv), "revision": 1},
    )

    chunks = []
    for chunk in chunk_text(parsed_text):
        cid = _ids.chunk_id(sv, chunk.index)
        chunks.append(
            (
                cid,
                {
                    "id": cid,
                    "ns": ns,
                    "index": chunk.index,
                    "text": chunk.text,
                    "start_offset": chunk.start_offset,
                    "end_offset": chunk.end_offset,
                },
            )
        )
    await runner.upsert_nodes(ns, L_CHUNK, chunks)
    await runner.create_edges(
        ns,
        L_SOURCE_VERSION,
        L_CHUNK,
        [(R_HAS_CHUNK, sv, cid, {"ns": ns, "id": child_edge_id(R_HAS_CHUNK, cid), "revision": 1}) for cid, _ in chunks],
    )

    return sv, [Evidence(source_id=source_id, source_version=sv, chunk_id=None)]

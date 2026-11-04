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
    """Write the source/version/chunk structure and return the source version with base evidence.

    ``base_evidence`` is a single source-level :class:`Evidence` that extracted
    objects link to by default. The default extractor links objects at source
    granularity (chunk_id=None); chunk nodes are stored for traversal, and
    chunk-level Evidence is produced when a custom extractor supplies offsets on a
    relation's EvidenceInput.

    @param runner (Any): the Cypher runner used to write nodes and relationships.
    @param ns (str): the namespace the source belongs to.
    @param source_id (str): the stable id of the source.
    @param parsed_text (str): the parsed document text to chunk and record.
    @param media_type (str): the media type of the source content.
    @param metadata (dict[str, Any] | None): optional metadata stored on the version.
    @param created_at (datetime): the insert timestamp, part of the version id.
    @return (tuple[str, list[Evidence]]): the source version id and base evidence.
    """
    sv = _ids.source_version_id(source_id, to_iso(created_at) or "", _ids.content_hash(parsed_text.encode("utf-8")))

    await runner.upsert_node(ns, L_SOURCE, source_id, {"id": source_id, "ns": ns})
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
    await runner.create_edge(ns, R_HAS_VERSION, L_SOURCE, source_id, L_SOURCE_VERSION, sv, {"ns": ns})

    for chunk in chunk_text(parsed_text):
        cid = _ids.chunk_id(sv, chunk.index)
        await runner.upsert_node(
            ns,
            L_CHUNK,
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
        await runner.create_edge(ns, R_HAS_CHUNK, L_SOURCE_VERSION, sv, L_CHUNK, cid, {"ns": ns})

    base = [Evidence(source_id=source_id, source_version=sv, chunk_id=None)]
    return sv, base

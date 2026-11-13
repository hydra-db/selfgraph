from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Any

from ._ops import _require_json_mapping, _require_optional_text, parse_time
from .errors import ExtractionError, SelfGraphError, ValidationError
from .extraction.extractor import LLMExtractor
from .ids import _unstorable
from .models import (
    Extraction,
    ExtractionInstructions,
    ExtractionPrompts,
    InsertResult,
    InsertWarning,
    JsonValue,
    ParsedDocument,
    as_input,
)
from .resolution import EntityResolver, ResolverMode
from .schema import ContradictionMode, Schema, SchemaMode, as_schema, require_schema_for_mode

if TYPE_CHECKING:
    from .client import SelfGraph

__all__ = ["Insert"]


class Insert:
    def __init__(self, client: SelfGraph) -> None:
        self._c = client

    async def _extract(self, extractor, document: ParsedDocument) -> Extraction:
        try:
            return await extractor.extract(document)
        except SelfGraphError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ExtractionError(f"extraction failed: {exc}") from exc

    async def text(
        self,
        text: str,
        *,
        source_id: str | None = None,
        event_time: datetime | str | None = None,
        metadata: dict[str, JsonValue] | None = None,
        instructions: ExtractionInstructions | Mapping[str, Any] | None = None,
        prompts: ExtractionPrompts | Mapping[str, Any] | None = None,
        schema: Schema | Mapping[str, Any] | None = None,
        schema_mode: SchemaMode | None = None,
        resolver: EntityResolver | ResolverMode | None = None,
        contradiction: ContradictionMode | None = None,
    ) -> InsertResult:
        if resolver is not None:
            self._c._resolver_for(resolver)
        if not isinstance(text, str):
            raise ValidationError(f"text must be a string, got {type(text).__name__}")
        if _unstorable(text):
            raise ValidationError("text cannot contain NUL or unpaired surrogate characters")
        _require_optional_text("source_id", source_id)
        _require_json_mapping("metadata", metadata)
        event_time = parse_time(event_time, "event_time")
        if not text.strip():
            raise ValidationError("text cannot be empty or whitespace")
        active_schema = as_schema(schema)
        require_schema_for_mode(
            self._c._schema_mode if schema_mode is None else schema_mode,
            self._c.schema if active_schema is None else active_schema,
        )
        instructions = as_input(ExtractionInstructions, instructions, "instructions")
        prompts = as_input(ExtractionPrompts, prompts, "prompts")
        extractor = self._c._build_extractor(instructions, prompts, schema=active_schema, source_id=source_id)
        document = ParsedDocument(text=text, media_type="text/plain", metadata=dict(metadata or {}))
        facts = await self._extract(extractor, document)
        drain = getattr(extractor, "pop_warnings", None)
        warnings = drain() if callable(drain) else []
        customized = instructions or prompts or self._c._instructions or self._c._prompts
        if customized and not isinstance(extractor, LLMExtractor):
            warnings.append(
                InsertWarning(
                    code="prompts_ignored",
                    message="instructions and prompts apply only to LLM extraction, and no LLM is configured",
                )
            )
        return await self._c._apply_facts(
            facts,
            source_id=source_id,
            parsed_text=text,
            media_type="text/plain",
            metadata=metadata,
            default_event_time=event_time,
            warnings=warnings,
            schema=active_schema,
            schema_mode=schema_mode,
            resolver=resolver,
            contradiction=contradiction,
            extracted=True,
            extraction="llm" if isinstance(extractor, DefaultExtractor) else getattr(extractor, "tier", "custom"),
        )

    async def facts(
        self,
        facts: Extraction | Mapping[str, Any],
        *,
        source_id: str | None = None,
        event_time: datetime | str | None = None,
        schema: Schema | Mapping[str, Any] | None = None,
        schema_mode: SchemaMode | None = None,
        resolver: EntityResolver | ResolverMode | None = None,
        contradiction: ContradictionMode | None = None,
    ) -> InsertResult:
        """Merge ready facts into the graph as idempotent upserts.

        References are validated before any write. The batch is atomic on transactional
        backends (Neo4j, Memgraph); auto-commit backends (HydraDB, Kuzu, FalkorDB) apply
        writes incrementally, so a mid-batch failure can leave earlier writes in place.
        Re-running the same facts reconciles a partial write rather than duplicating it.

        @param facts (Extraction | Mapping[str, Any]): the facts to merge.
        @param source_id (str | None): optional source id to attach as provenance.
        @param event_time (datetime | str | None): the default event time (a datetime or ISO 8601 text) for
            relations, preferences, and decisions that carry none of their own.
        @param resolver (EntityResolver | ResolverMode | None): entity resolution for this call, else the graph's.
        @param contradiction (ContradictionMode | None): how to handle a relation that breaks a schema max_count,
            or None for the graph's mode.
        @return (InsertResult): the inserted entities, relations, preferences, decisions, and merges.
        """
        _require_optional_text("source_id", source_id)
        return await self._c._apply_facts(
            as_input(Extraction, facts, "facts"),
            source_id=source_id,
            parsed_text=None,
            media_type=None,
            metadata=None,
            default_event_time=parse_time(event_time, "event_time"),
            schema=as_schema(schema),
            schema_mode=schema_mode,
            resolver=resolver,
            contradiction=contradiction,
        )

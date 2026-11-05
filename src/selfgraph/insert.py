from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError as PydanticValidationError

from ._ops import _require_json_mapping, _require_optional_text
from ._serde import now
from .errors import ExtractionError, SelfGraphError, ValidationError
from .ids import _has_surrogate
from .models import (
    ExtractionInstructions,
    ExtractionPrompts,
    InsertResult,
    InsertWarning,
    JsonValue,
    Ontology,
    ParsedDocument,
)

if TYPE_CHECKING:
    from .client import SelfGraph

__all__ = ["Insert"]


def _drain_warnings(extractor):
    """Collect per-chunk extraction warnings from an extractor that reports them.

    @param extractor: the extractor to drain warnings from.
    """
    drain = getattr(extractor, "pop_warnings", None)
    return drain() if callable(drain) else []


class Insert:
    def __init__(self, client: SelfGraph) -> None:
        self._c = client

    async def _extract(self, extractor, document: ParsedDocument) -> Ontology:
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
        event_time: datetime | None = None,
        metadata: dict[str, JsonValue] | None = None,
        instructions: ExtractionInstructions | None = None,
        prompts: ExtractionPrompts | None = None,
    ) -> InsertResult:
        if not isinstance(text, str):
            raise ValidationError(f"text must be a string, got {type(text).__name__}")
        if _has_surrogate(text) or "\x00" in text:
            raise ValidationError("text cannot contain NUL or unpaired surrogate characters")
        _require_optional_text("source_id", source_id)
        _require_json_mapping("metadata", metadata)
        if not text.strip():
            return InsertResult(
                source_id=source_id,
                created_at=now(),
                warnings=[InsertWarning(code="empty_text", message="text was empty; nothing was ingested")],
            )
        extractor = self._c._build_extractor(instructions, prompts)
        document = ParsedDocument(text=text, media_type="text/plain")
        ontology = await self._extract(extractor, document)
        return await self._c._apply_ontology(
            ontology,
            source_id=source_id,
            parsed_text=text,
            media_type="text/plain",
            metadata=metadata,
            default_event_time=event_time,
            warnings=_drain_warnings(extractor),
        )

    async def ontology(
        self,
        ontology: Ontology | Mapping[str, Any],
        *,
        source_id: str | None = None,
    ) -> InsertResult:
        """Merge a ready ontology into the graph as idempotent upserts.

        References are validated before any write. The batch is atomic on transactional
        backends (Neo4j, Memgraph); auto-commit backends (HydraDB, Kuzu, FalkorDB) apply
        writes incrementally, so a mid-batch failure can leave earlier writes in place.
        Re-running the same ontology reconciles a partial write rather than duplicating it.

        @param ontology (Ontology | Mapping[str, Any]): the ontology to merge.
        @param source_id (str | None): optional source id to attach as provenance.
        @return (InsertResult): the inserted entities, relations, preferences, and decisions.
        """
        _require_optional_text("source_id", source_id)
        if isinstance(ontology, Ontology):
            ont = ontology
        else:
            try:
                ont = Ontology.model_validate(ontology)
            except PydanticValidationError as exc:
                raise ValidationError(f"invalid ontology: {exc}") from exc
        return await self._c._apply_ontology(
            ont,
            source_id=source_id,
            parsed_text=None,
            media_type=None,
            metadata=None,
            default_event_time=None,
        )

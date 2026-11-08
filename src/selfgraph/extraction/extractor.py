from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from pydantic import BaseModel, Field

from .. import ids as _ids
from .._ops import (
    _reject_reserved_rel_type,
    _require_optional_text,
    _validate_entity_identity,
    _validate_strength,
)
from ..errors import ExtractionError, ValidationError
from ..models import (
    DecisionTraceInput,
    EntityInput,
    ExtractionInstructions,
    ExtractionPrompts,
    InsertWarning,
    JsonValue,
    Kind,
    Ontology,
    ParsedDocument,
    PreferenceInput,
    RelationInput,
    Status,
)
from ..protocols import LLMClient
from ..schema import Schema, render_schema_catalog
from .chunking import chunk_text
from .prompts import effective_instruction, effective_prompt, render

__all__ = ["DefaultExtractor"]


class _EntitiesOut(BaseModel):
    entities: list[EntityInput] = Field(default_factory=list)


class _RelOut(BaseModel):
    from_name: str
    type: str
    to_name: str
    properties: dict[str, JsonValue] = Field(default_factory=dict)
    event_time: datetime | None = None


class _RelationsOut(BaseModel):
    relations: list[_RelOut] = Field(default_factory=list)


class _PrefOut(BaseModel):
    subject_name: str
    kind: Kind = "preference"
    key: str
    value_name: str
    about_name: str | None = None
    strength: float | None = None


class _PreferencesOut(BaseModel):
    preferences: list[_PrefOut] = Field(default_factory=list)


class _StepOut(BaseModel):
    from_name: str
    type: str
    to_name: str


class _DecOut(BaseModel):
    title: str
    actor_name: str | None = None
    summary: str | None = None
    rationale: str | None = None
    outcome_name: str | None = None
    alternative_names: list[str] = Field(default_factory=list)
    status: Status = "completed"
    steps: list[_StepOut] = Field(default_factory=list)


class _DecisionsOut(BaseModel):
    decisions: list[_DecOut] = Field(default_factory=list)


_log = logging.getLogger("selfgraph")
_MAX_CONCURRENT_CALLS = 8
_FALLBACK_TYPE = "Thing"


def _norm(name: str) -> str:
    return name.strip().lower()


def _is_noise_name(name: str) -> bool:
    """Report whether a name is a bare quantity or phrase fragment rather than an entity.

    @param name (str): the candidate entity name.
    @return (bool): True when the name should not become an entity.
    """
    text = name.strip()
    if not text:
        return True
    if len(text.split()) > 6:
        return True
    return not any(c.isalpha() for c in text)


def _dropped(warnings: list[InsertWarning], kind: str, exc: ValidationError) -> None:
    """Record that one invalid extracted item was dropped instead of failing the whole insert.

    @param warnings (list[InsertWarning]): the warning list to append to.
    @param kind (str): the kind of item dropped.
    @param exc (ValidationError): why the item was invalid.
    @return (None): nothing.
    """
    warnings.append(InsertWarning(code="extraction_partial_failure", message=f"dropped an extracted {kind}: {exc}"))


class _WarningSink:
    def pop_warnings(self) -> list[InsertWarning]:
        """Return and clear warnings accumulated during the last ``extract`` call.

        @return (list[InsertWarning]): the warnings.
        """
        out = self._warnings
        self._warnings = []
        return out


class DefaultExtractor(_WarningSink):
    def __init__(
        self,
        llm: LLMClient,
        *,
        prompts: ExtractionPrompts | None = None,
        instructions: ExtractionInstructions | None = None,
        call_prompts: ExtractionPrompts | None = None,
        call_instructions: ExtractionInstructions | None = None,
        schema: Schema | None = None,
    ) -> None:
        self._llm = llm
        self._client_prompts = prompts
        self._client_instructions = instructions
        self._call_prompts = call_prompts
        self._call_instructions = call_instructions
        self._warnings: list[InsertWarning] = []
        entity_catalog, relation_catalog = render_schema_catalog(schema) if schema is not None else ("", "")
        self._catalogs = {"entities": entity_catalog, "relations": relation_catalog}

    def _messages(self, object_type: str, text: str) -> tuple[str, str]:
        template = effective_prompt(object_type, client_prompts=self._client_prompts, call_prompts=self._call_prompts)
        instruction = effective_instruction(
            object_type, client_instructions=self._client_instructions, call_instructions=self._call_instructions
        )
        catalog = self._catalogs.get(object_type, "")
        if catalog:
            instruction = f"{instruction}\n\n{catalog}" if instruction else catalog
        return render(template, text=text, instructions=instruction)

    async def extract(self, document: ParsedDocument) -> Ontology:
        self._warnings = []
        chunks = chunk_text(document.text)
        if not chunks:
            return Ontology()

        raw_entities: list[EntityInput] = []
        raw_relations: list[_RelOut] = []
        raw_preferences: list[_PrefOut] = []
        raw_decisions: list[_DecOut] = []

        kinds = [
            ("entities", _EntitiesOut, raw_entities),
            ("relations", _RelationsOut, raw_relations),
            ("preferences", _PreferencesOut, raw_preferences),
            ("decisions", _DecisionsOut, raw_decisions),
        ]

        for kind, *_ in kinds:
            self._messages(kind, "")
        gate = asyncio.Semaphore(_MAX_CONCURRENT_CALLS)

        async def run(chunk, kind: str, schema: type) -> list | InsertWarning:
            async with gate:
                try:
                    system, user = self._messages(kind, chunk.text)
                    return getattr(await self._llm.generate(system=system, user=user, output=schema), kind)
                except Exception as exc:  # noqa: BLE001
                    return InsertWarning(
                        code="extraction_partial_failure",
                        message=f"{kind} extraction failed on chunk {chunk.index}: {exc}",
                    )

        outcomes = iter(
            await asyncio.gather(*(run(chunk, kind, schema) for chunk in chunks for kind, schema, _ in kinds))
        )
        succeeded = 0
        for _chunk in chunks:
            chunk_ok = False
            for _kind, _schema, sink in kinds:
                outcome = next(outcomes)
                if isinstance(outcome, InsertWarning):
                    self._warnings.append(outcome)
                else:
                    sink.extend(outcome)
                    chunk_ok = True
            if chunk_ok:
                succeeded += 1

        if succeeded == 0 and self._warnings:
            raise ExtractionError(
                f"extraction failed for the whole input ({len(self._warnings)} errors); "
                f"first: {self._warnings[0].message}"
            )

        ontology = self._assemble(raw_entities, raw_relations, raw_preferences, raw_decisions, self._warnings)
        _log.debug(
            "LLM extraction: %d entities, %d relations from %d chunks (%d warnings)",
            len(ontology.entities),
            len(ontology.relations),
            len(chunks),
            len(self._warnings),
        )
        return ontology

    @staticmethod
    def _assemble(
        raw_entities: list[EntityInput],
        raw_relations: list[_RelOut],
        raw_preferences: list[_PrefOut],
        raw_decisions: list[_DecOut],
        warnings: list[InsertWarning] | None = None,
    ) -> Ontology:
        """Resolve extracted names to ids and assemble a deduplicated ontology, dropping invalid items.

        @param raw_entities (list[EntityInput]): the extracted entities.
        @param raw_relations (list[_RelOut]): the extracted relations, by name.
        @param raw_preferences (list[_PrefOut]): the extracted preferences, by name.
        @param raw_decisions (list[_DecOut]): the extracted decisions, by name.
        @param warnings (list[InsertWarning] | None): receives one warning per dropped invalid item.
        @return (Ontology): the assembled ontology.
        """
        sink = warnings if warnings is not None else []
        registry: dict[str, EntityInput] = {}
        rejected: set[str] = set()

        def admit(ent: EntityInput) -> bool:
            try:
                _validate_entity_identity(_ids.entity_id(ent.type, ent.name), ent.type, ent.name)
            except ValidationError as exc:
                _dropped(sink, "entity", exc)
                return False
            return True

        for ent in raw_entities:
            key = _norm(ent.name)
            if key not in registry and not _is_noise_name(ent.name) and admit(ent):
                registry[key] = ent

        def resolve(name: str | None) -> str | None:
            if name is None or not name.strip():
                return None
            key = _norm(name)
            ent = registry.get(key) or next(
                (e for e in registry.values() if _ids.entity_id(e.type, name) == _ids.entity_id(e.type, e.name)), None
            )
            if ent is None:
                if _is_noise_name(name) or key in rejected:
                    return None
                ent = EntityInput(type=_FALLBACK_TYPE, name=name.strip())
                if not admit(ent):
                    rejected.add(key)
                    return None
                registry[key] = ent
            return _ids.entity_id(ent.type, ent.name)

        relations: dict[str, RelationInput] = {}

        def add_relation(from_id: str, rtype: str, to_id: str, props=None, event_time=None) -> str:
            rid = _ids.relation_id(from_id, rtype, to_id)
            _reject_reserved_rel_type(_ids.normalize_rel_type(rtype), rtype)
            if rid not in relations:
                relations[rid] = RelationInput(
                    from_entity=from_id,
                    type=rtype,
                    to_entity=to_id,
                    properties=dict(props or {}),
                    event_time=event_time,
                )
            return rid

        for rel in raw_relations:
            from_id = resolve(rel.from_name)
            to_id = resolve(rel.to_name)
            if from_id and to_id:
                try:
                    add_relation(from_id, rel.type, to_id, rel.properties, rel.event_time)
                except ValidationError as exc:
                    _dropped(sink, "relation", exc)

        preferences: dict[str, PreferenceInput] = {}
        for pref in raw_preferences:
            subject_id = resolve(pref.subject_name)
            value_id = resolve(pref.value_name)
            if not (subject_id and value_id):
                continue
            try:
                _validate_strength(pref.strength)
                pid = _ids.preference_id(subject_id, pref.kind, pref.key, value_id)
            except ValidationError as exc:
                _dropped(sink, "preference", exc)
                continue
            if pid not in preferences:
                preferences[pid] = PreferenceInput(
                    subject_entity=subject_id,
                    kind=pref.kind,
                    key=pref.key,
                    value_entity=value_id,
                    about_entity=resolve(pref.about_name),
                    strength=pref.strength,
                )

        decisions: dict[str, DecisionTraceInput] = {}
        for dec in raw_decisions:
            actor_id = resolve(dec.actor_name)
            step_ids: list[str] = []
            for step in dec.steps:
                from_id = resolve(step.from_name)
                to_id = resolve(step.to_name)
                if from_id and to_id:
                    try:
                        step_ids.append(add_relation(from_id, step.type, to_id))
                    except ValidationError as exc:
                        _dropped(sink, "decision step", exc)
            try:
                _require_optional_text("decision summary", dec.summary)
                _require_optional_text("decision rationale", dec.rationale)
                tid = _ids.decision_id(actor_id, dec.title)
            except ValidationError as exc:
                _dropped(sink, "decision", exc)
                continue
            if tid not in decisions:
                decisions[tid] = DecisionTraceInput(
                    title=dec.title,
                    steps=step_ids,
                    actor_entity=actor_id,
                    summary=dec.summary,
                    rationale=dec.rationale,
                    outcome_entity=resolve(dec.outcome_name),
                    alternative_entities=[a for a in (resolve(n) for n in dec.alternative_names) if a],
                    status=dec.status,
                )

        return Ontology(
            entities=list(registry.values()),
            relations=list(relations.values()),
            preferences=list(preferences.values()),
            decisions=list(decisions.values()),
        )

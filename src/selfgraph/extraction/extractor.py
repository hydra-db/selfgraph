from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from datetime import datetime

from pydantic import BaseModel, Field, PrivateAttr
from pydantic import ValidationError as PydanticValidationError

from .. import ids as _ids
from .._ops import (
    _reject_reserved_rel_type,
    _require_optional_text,
    _validate_entity_identity,
    _validate_strength,
)
from .._serde import EDGE_TYPES, preference_stance_of
from ..errors import ExtractionError, ValidationError
from ..llm.base import summarize_error
from ..models import (
    LLM_CONCURRENCY,
    DecisionTraceInput,
    EntityInput,
    EvidenceInput,
    Extraction,
    ExtractionInstructions,
    ExtractionPrompts,
    InsertWarning,
    JsonValue,
    ParsedDocument,
    PreferenceInput,
    RelationInput,
    Stance,
    Status,
    issue_line,
)
from ..protocols import LLMClient
from ..schema import Schema, render_schema_catalog
from .chunking import chunk_text
from .prompts import check_prompts, effective_instruction, effective_prompt, render

__all__ = ["LLMExtractor"]


class _EntitiesOut(BaseModel):
    entities: list[EntityInput] = Field(default_factory=list)


class _RelOut(BaseModel):
    from_name: str
    type: str
    to_name: str
    properties: dict[str, JsonValue] = Field(default_factory=dict)
    event_time: datetime | None = None
    _evidence: EvidenceInput | None = PrivateAttr(default=None)


class _RelationsOut(BaseModel):
    relations: list[_RelOut] = Field(default_factory=list)


class _PrefOut(BaseModel):
    subject_name: str
    stance: Stance = "preference"
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
    _evidence: EvidenceInput | None = PrivateAttr(default=None)


class _DecisionsOut(BaseModel):
    decisions: list[_DecOut] = Field(default_factory=list)


_log = logging.getLogger("selfgraph")
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


def _dropped(warnings: list[InsertWarning], kind: str, exc: ValidationError, rtype: str | None = None) -> None:
    """Record that one invalid extracted item was dropped instead of failing the whole insert.

    @param warnings (list[InsertWarning]): the warning list to append to.
    @param kind (str): the kind of item dropped.
    @param exc (ValidationError): why the item was invalid.
    @param rtype (str | None): the relation type of a dropped relation or decision step, so a reserved one gets
        the dropped_reserved_relation code.
    @return (None): nothing.
    """
    code = "dropped_reserved_relation" if rtype is not None and _is_reserved(rtype) else "extraction_partial_failure"
    warnings.append(InsertWarning(code=code, message=f"dropped an extracted {kind}: {exc}"))


def _is_reserved(rtype: str) -> bool:
    """Report whether an extracted relation type names one of SelfGraph's internal edge types.

    @param rtype (str): the type as the model wrote it.
    @return (bool): True for a reserved type such as CONSIDERED.
    """
    try:
        return _ids.normalize_rel_type(rtype) in EDGE_TYPES
    except ValidationError:
        return False


def _checked_output(result: object, schema: type[BaseModel], kind: str) -> BaseModel:
    """Validate an LLM client's reply for one extraction pass against that pass's output model.

    @param result (object): what the client returned.
    @param schema (type[BaseModel]): the expected output model.
    @param kind (str): the extraction pass, such as "relations", for the message.
    @return (BaseModel): the validated output.
    """
    if isinstance(result, schema):
        return result
    head = f"LLM client returned an invalid result for the {kind} pass"
    if (isinstance(result, Mapping) and kind not in result) or (
        hasattr(result, "__dict__") and not hasattr(result, kind)
    ):
        raise ExtractionError(f"{head}: {kind}: field required")
    try:
        return schema.model_validate(result, from_attributes=True)
    except PydanticValidationError as exc:
        raise ExtractionError(f"{head}: {issue_line(exc.errors()[0])}") from exc


class _WarningSink:
    def pop_warnings(self) -> list[InsertWarning]:
        """Return and clear warnings accumulated during the last ``extract`` call.

        @return (list[InsertWarning]): the warnings.
        """
        out = self._warnings
        self._warnings = []
        return out


class LLMExtractor(_WarningSink):
    def __init__(
        self,
        llm: LLMClient,
        *,
        prompts: ExtractionPrompts | None = None,
        instructions: ExtractionInstructions | None = None,
        call_prompts: ExtractionPrompts | None = None,
        call_instructions: ExtractionInstructions | None = None,
        schema: Schema | None = None,
        source_id: str | None = None,
    ) -> None:
        check_prompts(prompts)
        check_prompts(call_prompts)
        self._llm = llm
        self._source_id = source_id
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
        return render(template, text=text, instructions=instruction, name=object_type)

    async def extract(self, document: ParsedDocument) -> Extraction:
        self._warnings = []
        chunks = chunk_text(document.text)
        if not chunks:
            return Extraction()

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
        concurrency = getattr(self._llm, "concurrency", None)
        chunks_at_once = concurrency if type(concurrency) is int and concurrency > 0 else LLM_CONCURRENCY
        gate = asyncio.Semaphore(chunks_at_once * len(kinds))
        version = (
            None
            if self._source_id is None
            else _ids.source_version_id(self._source_id, _ids.content_hash(document.text.encode("utf-8")))
        )

        def chunk_id(chunk) -> str | None:
            return None if version is None else _ids.chunk_id(version, chunk.index)

        async def run(chunk, kind: str, schema: type[BaseModel]) -> list | InsertWarning:
            async with gate:
                if len(chunks) > 1 and kind == kinds[0][0]:
                    _log.info("extracting chunk %d/%d", chunk.index + 1, len(chunks))
                try:
                    system, user = self._messages(kind, chunk.text)
                    result = await self._llm.generate(system=system, user=user, output=schema)
                    return getattr(_checked_output(result, schema, kind), kind)
                except ExtractionError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    return InsertWarning(
                        code="extraction_partial_failure",
                        message=f"{kind} extraction failed on chunk {chunk.index}: {summarize_error(exc)}",
                        source_id=self._source_id,
                        chunk_id=chunk_id(chunk),
                    )

        tasks = [asyncio.ensure_future(run(chunk, kind, schema)) for chunk in chunks for kind, schema, _ in kinds]
        try:
            outcomes = iter(await asyncio.gather(*tasks))
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        for chunk in chunks:
            cid = chunk_id(chunk)
            for kind, _schema, sink in kinds:
                outcome = next(outcomes)
                if isinstance(outcome, InsertWarning):
                    self._warnings.append(outcome)
                    continue
                if cid is not None and kind in ("relations", "decisions"):
                    outcome = [item.model_copy() for item in outcome]
                    for item in outcome:
                        item._evidence = EvidenceInput(source_id=self._source_id, chunk_id=cid)
                sink.extend(outcome)

        failed = len(self._warnings)
        facts = self._assemble(raw_entities, raw_relations, raw_preferences, raw_decisions, self._warnings)
        if failed and not (facts.entities or facts.relations or facts.preferences or facts.decisions):
            raise ExtractionError(
                f"extraction failed for the whole input ({failed} of {len(tasks)} LLM calls failed); "
                f"first: {self._warnings[0].message}"
            )
        _log.debug(
            "LLM extraction: %d entities, %d relations from %d chunks (%d warnings)",
            len(facts.entities),
            len(facts.relations),
            len(chunks),
            len(self._warnings),
        )
        return facts

    @staticmethod
    def _assemble(
        raw_entities: list[EntityInput],
        raw_relations: list[_RelOut],
        raw_preferences: list[_PrefOut],
        raw_decisions: list[_DecOut],
        warnings: list[InsertWarning] | None = None,
    ) -> Extraction:
        """Resolve extracted names to ids and assemble deduplicated facts, dropping invalid items.

        @param raw_entities (list[EntityInput]): the extracted entities.
        @param raw_relations (list[_RelOut]): the extracted relations, by name.
        @param raw_preferences (list[_PrefOut]): the extracted preferences, by name.
        @param raw_decisions (list[_DecOut]): the extracted decisions, by name.
        @param warnings (list[InsertWarning] | None): receives one warning per dropped invalid item.
        @return (Extraction): the assembled facts.
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

        def add_relation(from_id: str, rtype: str, to_id: str, props=None, event_time=None, evidence=None) -> str:
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
            if evidence is not None and evidence not in relations[rid].evidence:
                relations[rid].evidence.append(evidence)
            return rid

        promoted: list[_PrefOut] = []
        for rel in raw_relations:
            from_id = resolve(rel.from_name)
            to_id = resolve(rel.to_name)
            if from_id and to_id:
                try:
                    stance = preference_stance_of(_ids.normalize_rel_type(rel.type))
                    value = registry.get(_norm(rel.to_name))
                    if stance is not None and value is not None and value.type != _FALLBACK_TYPE:
                        key = value.type.lower()
                        promoted.append(
                            _PrefOut(subject_name=rel.from_name, stance=stance, key=key, value_name=rel.to_name)
                        )
                        continue
                    add_relation(from_id, rel.type, to_id, rel.properties, rel.event_time, rel._evidence)
                except ValidationError as exc:
                    _dropped(sink, "relation", exc, rel.type)

        preferences: dict[str, PreferenceInput] = {}
        stated: set[tuple[str, str, str]] = set()
        for index, pref in enumerate([*raw_preferences, *promoted]):
            subject_id = resolve(pref.subject_name)
            value_id = resolve(pref.value_name)
            if not (subject_id and value_id):
                continue
            if index >= len(raw_preferences) and (subject_id, pref.stance, value_id) in stated:
                continue
            stated.add((subject_id, pref.stance, value_id))
            try:
                _validate_strength(pref.strength)
                pid = _ids.preference_id(subject_id, pref.stance, pref.key, value_id)
            except ValidationError as exc:
                _dropped(sink, "preference", exc)
                continue
            if pid not in preferences:
                preferences[pid] = PreferenceInput(
                    subject_entity=subject_id,
                    stance=pref.stance,
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
                        step_ids.append(add_relation(from_id, step.type, to_id, evidence=dec._evidence))
                    except ValidationError as exc:
                        _dropped(sink, "decision step", exc, step.type)
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

        return Extraction(
            entities=list(registry.values()),
            relations=list(relations.values()),
            preferences=list(preferences.values()),
            decisions=list(decisions.values()),
        )

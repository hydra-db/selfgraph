from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field, PrivateAttr
from pydantic import ValidationError as PydanticValidationError

from .. import ids as _ids
from .._ops import (
    _reject_reserved_rel_type,
    _require_json_mapping,
    _require_optional_text,
    _validate_entity_identity,
    _validate_strength,
    parse_time,
)
from .._serde import EDGE_TYPES, preference_stance_of
from .._unicode import LETTER_CLASS, lower
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
    ParsedDocument,
    PreferenceInput,
    RelationInput,
    Stance,
    Status,
    issue_line,
)
from ..protocols import LLMClient
from ..schema import Schema, canonical_entity_type, render_schema_catalog
from .chunking import chunk_text
from .prompts import check_prompts, effective_instruction, effective_prompt, render

__all__ = ["LLMExtractor"]


class _EntityOut(BaseModel):
    type: str
    name: str
    aliases: list[str] | None = None


class _EntitiesOut(BaseModel):
    entities: list[_EntityOut] = Field(default_factory=list)


class _RelOut(BaseModel):
    from_name: str
    type: str
    to_name: str
    properties: dict[str, Any] = Field(default_factory=dict)
    event_time: str | None = None
    _evidence: EvidenceInput | None = PrivateAttr(default=None)


def _lenient_event_time(value: str | None) -> datetime | None:
    """Parse an extracted event_time; a bare year 0001-9999 becomes Jan 1 UTC, and unparseable values become None.

    @param value (str | None): ISO text, a four-digit year, or None.
    @return (datetime | None): the time, or None when absent or not parseable.
    """
    text = (value or "").strip()
    if not text:
        return None
    if len(text) == 4 and text.isascii() and text.isdigit():
        year = int(text)
        return datetime(year, 1, 1, tzinfo=timezone.utc) if year >= 1 else None
    try:
        return parse_time(text, "event_time")
    except ValidationError:
        return None


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
    status: Status | None = None
    steps: list[_StepOut] = Field(default_factory=list)
    _evidence: EvidenceInput | None = PrivateAttr(default=None)


class _DecisionsOut(BaseModel):
    decisions: list[_DecOut] = Field(default_factory=list)


_log = logging.getLogger("selfgraph")
_FALLBACK_TYPE = "Thing"
_LETTER = re.compile(f"[{LETTER_CLASS}]")


def _norm(name: str) -> str:
    return lower(name.strip())


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
    return _LETTER.search(text) is None


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
        result = result.model_dump(warnings=False)
    head = f"LLM client returned an invalid result for the {kind} pass"
    if (isinstance(result, Mapping) and kind not in result) or (
        hasattr(result, "__dict__") and not hasattr(result, kind)
    ):
        raise ExtractionError(f"{head}: {kind}: field required", code="invalid_llm_output")
    try:
        return schema.model_validate(result, from_attributes=True)
    except PydanticValidationError as exc:
        raise ExtractionError(f"{head}: {issue_line(exc.errors()[0])}", code="invalid_llm_output") from exc


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
        self._schema = schema
        self._source_id = source_id
        self._schema = schema
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

        raw_entities: list[_EntityOut] = []
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
                        message=(
                            f"{kind} extraction failed on chunk {chunk.index}: "
                            f"{summarize_error(exc, getattr(self._llm, 'base_url', None))}"
                        ),
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
        facts = self._assemble(
            raw_entities, raw_relations, raw_preferences, raw_decisions, self._warnings, self._schema
        )
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
        raw_entities: list[_EntityOut],
        raw_relations: list[_RelOut],
        raw_preferences: list[_PrefOut],
        raw_decisions: list[_DecOut],
        warnings: list[InsertWarning] | None = None,
        schema: Schema | None = None,
    ) -> Extraction:
        """Resolve extracted names to ids and assemble deduplicated facts, dropping invalid items.

        @param raw_entities (list[_EntityOut]): the extracted entities.
        @param raw_relations (list[_RelOut]): the extracted relations, by name.
        @param raw_preferences (list[_PrefOut]): the extracted preferences, by name.
        @param raw_decisions (list[_DecOut]): the extracted decisions, by name.
        @param warnings (list[InsertWarning] | None): receives one warning per dropped invalid item.
        @param schema (Schema | None): endpoint types for resolving ambiguous names.
        @return (Extraction): the assembled facts.
        """
        sink = warnings if warnings is not None else []
        registry: dict[str, EntityInput] = {}
        canonical: dict[bool, tuple[str, dict[str, list[EntityInput]]]] = {}
        rejected: set[str] = set()
        journal: list[tuple[str, EntityInput]] = []

        def admit(ent: EntityInput) -> bool:
            try:
                _validate_entity_identity(_ids.entity_id(ent.type, ent.name), ent.type, ent.name)
            except ValidationError as exc:
                _dropped(sink, "entity", exc)
                return False
            return True

        def register(key: str, ent: EntityInput) -> None:
            """Add an entity to the registry and to the index of canonical names.

            @param key (str): the entity id the registry stores it under.
            @param ent (EntityInput): the entity to register.
            @return (None): nothing.
            """
            _, names = canonical.setdefault(_ids._is_org_type(ent.type), (ent.type, {}))
            names.setdefault(_ids._canonical_name(ent.type, ent.name), []).append(ent)
            registry[key] = ent
            journal.append((key, ent))

        def rollback(mark: int) -> None:
            """Unregister the entities added since a journal position, so a dropped item leaves none behind.

            @param mark (int): the journal length taken before the item resolved its names.
            @return (None): nothing.
            """
            while len(journal) > mark:
                key, ent = journal.pop()
                del registry[key]
                org = _ids._is_org_type(ent.type)
                names = canonical[org][1]
                name = _ids._canonical_name(ent.type, ent.name)
                names[name].pop()
                if not names[name]:
                    del names[name]
                if not names:
                    del canonical[org]

        def matching(name: str) -> list[EntityInput]:
            """List the registered entities whose canonical name equals the canonical form of ``name``.

            @param name (str): the extracted name to look up.
            @return (list[EntityInput]): every registered entity that matches, across entity types.
            """
            if not registry:
                return []
            _ids._require_str("entity name", name)
            return [e for type_, names in canonical.values() for e in names.get(_ids._canonical_name(type_, name), [])]

        for ent in raw_entities:
            if not admit(ent) or _is_noise_name(ent.name):
                continue
            key = _ids.entity_id(ent.type, ent.name)
            clean_aliases = []
            for alias in ent.aliases or []:
                try:
                    _ids._require_no_control("entity alias", alias)
                    clean_aliases.append(alias)
                except ValidationError as exc:
                    _dropped(sink, "alias", exc)
            if key not in registry:
                register(key, EntityInput(type=ent.type, name=ent.name, aliases=[]))
            registry[key].aliases = list(dict.fromkeys([*registry[key].aliases, *clean_aliases]))

        def resolve(name: str | None, types: list[str] | None = None) -> str | None:
            """Resolve an extracted name to one registered entity id, registering a fallback entity when none match.

            @param name (str | None): the extracted name.
            @param types (list[str] | None): the endpoint types that narrow several matches to one.
            @return (str | None): the entity id, or None when the name is blank, invalid, or matches several types.
            """
            if name is None or not name.strip():
                return None
            key = _norm(name)
            try:
                matches = matching(name)
                if len(matches) > 1 and types:
                    matches = [e for e in matches if _norm(e.type) in {_norm(t) for t in types}] or matches
            except ValidationError as exc:
                if key not in rejected:
                    rejected.add(key)
                    _dropped(sink, "entity", exc)
                return None
            if len(matches) > 1:
                sink.append(
                    InsertWarning(
                        code="extraction_partial_failure",
                        message=f"unresolved extracted entity reference {name!r}: multiple entity types match",
                    )
                )
                return None
            ent = matches[0] if matches else None
            if ent is None:
                if _is_noise_name(name) or key in rejected:
                    return None
                ent = EntityInput(type=_FALLBACK_TYPE, name=name.strip())
                if not admit(ent):
                    rejected.add(key)
                    return None
                register(_ids.entity_id(ent.type, ent.name), ent)
            return _ids.entity_id(ent.type, ent.name)

        def endpoint_types(rtype: str, side: str) -> list[str]:
            for rel in schema.relations if schema else []:
                if _norm(rtype) in {_norm(rel.type), *(_norm(a) for a in rel.aliases)}:
                    return (rel.from_ if side == "from" else rel.to).types
            return []

        relations: dict[str, RelationInput] = {}

        def add_relation(from_id: str, rtype: str, to_id: str, props=None, event_time=None, evidence=None) -> str:
            rid = _ids.relation_id(from_id, rtype, to_id)
            _reject_reserved_rel_type(_ids.normalize_rel_type(rtype), rtype)
            props = dict(props or {})
            for key in list(props):
                if not key.strip():
                    try:
                        _require_json_mapping("properties", {key: props[key]})
                    except ValidationError as exc:
                        _dropped(sink, "relation property", exc)
                    del props[key]
            _ids._reject_proto_keys(props)
            _ids._require_clean_json("relation property", props)
            if rid not in relations:
                relations[rid] = RelationInput(from_entity=from_id, type=rtype, to_entity=to_id)
            relation = relations[rid]
            relation.properties.update(props or {})
            if event_time is not None:
                relation.event_time = event_time
            if evidence is not None and evidence not in relation.evidence:
                relation.evidence.append(evidence)
            return rid

        promoted: list[_PrefOut] = []
        for rel in raw_relations:
            from_id = resolve(rel.from_name, endpoint_types(rel.type, "from"))
            to_id = resolve(rel.to_name, endpoint_types(rel.type, "to"))
            if from_id and to_id:
                try:
                    stance = preference_stance_of(_ids.normalize_rel_type(rel.type))
                    value = registry.get(to_id)
                    if stance is not None and value is not None and value.type != _FALLBACK_TYPE:
                        key = lower(canonical_entity_type(value.type, schema))
                        promoted.append(
                            _PrefOut(subject_name=rel.from_name, stance=stance, key=key, value_name=rel.to_name)
                        )
                        continue
                    add_relation(
                        from_id, rel.type, to_id, rel.properties, _lenient_event_time(rel.event_time), rel._evidence
                    )
                except ValidationError as exc:
                    _dropped(sink, "relation", exc, rel.type)

        preferences: dict[str, PreferenceInput] = {}
        stated: set[tuple[str, str, str]] = set()
        for index, pref in enumerate([*raw_preferences, *promoted]):
            mark = len(journal)
            subject_id = resolve(pref.subject_name)
            value_id = resolve(pref.value_name)
            if not (subject_id and value_id):
                rollback(mark)
                continue
            if index >= len(raw_preferences) and (subject_id, pref.stance, value_id) in stated:
                continue
            try:
                _validate_strength(pref.strength)
                pid = _ids.preference_id(subject_id, pref.stance, pref.key, value_id)
            except ValidationError as exc:
                rollback(mark)
                _dropped(sink, "preference", exc)
                continue
            stated.add((subject_id, pref.stance, value_id))
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
            mark = len(journal)
            actor_id = resolve(dec.actor_name)
            try:
                _require_optional_text("decision summary", dec.summary)
                _require_optional_text("decision rationale", dec.rationale)
                tid = _ids.decision_id(actor_id, dec.title)
            except ValidationError as exc:
                rollback(mark)
                _dropped(sink, "decision", exc)
                continue
            step_ids: list[str] = []
            for step in dec.steps:
                from_id = resolve(step.from_name, endpoint_types(step.type, "from"))
                to_id = resolve(step.to_name, endpoint_types(step.type, "to"))
                if from_id and to_id:
                    try:
                        step_ids.append(add_relation(from_id, step.type, to_id, evidence=dec._evidence))
                    except ValidationError as exc:
                        _dropped(sink, "decision step", exc, step.type)
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

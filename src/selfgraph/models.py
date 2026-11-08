import math
from collections.abc import Callable, Mapping
from datetime import datetime
from types import UnionType
from typing import Any, ClassVar, Generic, Literal, TypeVar, Union, get_args, get_origin

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator
from pydantic import ValidationError as PydanticValidationError

from .errors import ValidationError
from .ids import _has_surrogate, _require_clean_json, _require_no_control, normalize_rel_type

__all__ = [
    "JsonValue",
    "Evidence",
    "Entity",
    "Relation",
    "Preference",
    "DecisionStep",
    "DecisionTrace",
    "InsertResult",
    "InsertWarning",
    "Page",
    "DeleteResult",
    "CypherResult",
    "EntityInput",
    "EvidenceInput",
    "RelationInput",
    "PreferenceInput",
    "DecisionTraceInput",
    "Ontology",
    "LLMConfig",
    "PromptTemplate",
    "ExtractionInstructions",
    "ExtractionPrompts",
    "ParsedDocument",
    "RetrievalSeed",
    "Subgraph",
    "RetrievalResult",
    "Kind",
    "Status",
]


def _edit_distance(a: str, b: str) -> int:
    """Count the single-character insertions, deletions, and substitutions that turn one string into another.

    @param a (str): the first string.
    @param b (str): the second string.
    @return (int): the Levenshtein distance.
    """
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def suggest_key(key: str, valid: list[str]) -> str | None:
    """Pick the valid key closest to an unknown one: edit distance at most 2 and below the key's length, ties by order.

    @param key (str): the unknown key.
    @param valid (list[str]): the accepted keys in declared order.
    @return (str | None): the suggestion, or None when nothing is close.
    """
    best: str | None = None
    limit = min(2, len(key) - 1)
    for candidate in valid:
        distance = _edit_distance(key, candidate)
        if distance <= limit:
            best, limit = candidate, distance - 1
    return best


def _nested_input(annotation: Any) -> "tuple[type[InputModel] | None, bool]":
    """Find the input model a field holds, directly or as a list, through optional unions.

    @param annotation (Any): the field annotation.
    @return (tuple[type[InputModel] | None, bool]): the model, or None, and whether the field is a list of it.
    """
    origin = get_origin(annotation)
    if origin in (Union, UnionType):
        for arg in get_args(annotation):
            model, many = _nested_input(arg)
            if model is not None:
                return model, many
        return None, False
    if origin is list:
        model, _ = _nested_input(get_args(annotation)[0])
        return model, model is not None
    if isinstance(annotation, type) and issubclass(annotation, InputModel):
        return annotation, False
    return None, False


def _unknown_key(model: "type[InputModel]", value: Any, where: str) -> str | None:
    """Walk raw input against an input model and describe the first unknown key, depth first in declared order.

    @param model (type[InputModel]): the model the value should match.
    @param value (Any): the raw input.
    @param where (str): the location of the value, for the message.
    @return (str | None): the error message, or None when every key is known.
    """
    if not isinstance(value, Mapping):
        return None
    keys = [field.alias or name for name, field in model.model_fields.items()]
    accepted = set(keys) | set(model.model_fields)
    unknown = sorted(str(k) for k in value if k not in accepted)
    if unknown:
        suggestion = suggest_key(unknown[0], keys)
        hint = f"; did you mean {suggestion!r}?" if suggestion else ""
        return f"unknown key {unknown[0]!r} in {where}{hint}"
    for name, field in model.model_fields.items():
        key = field.alias or name
        nested, many = _nested_input(field.annotation)
        if nested is None or key not in value:
            continue
        items = value[key] if many else [value[key]]
        if many and not isinstance(items, list | tuple):
            continue
        for i, item in enumerate(items):
            found = _unknown_key(nested, item, f"{where}.{key}[{i}]" if many else f"{where}.{key}")
            if found:
                return found
    return None


def _check(check: Callable[[str, Any], None], label: str, *fields: str) -> Any:
    """Build a pydantic field validator that runs a label-taking check and passes the value through.

    @param check (Callable[[str, Any], None]): the check, raising ValidationError on a bad value.
    @param label (str): the field label for the error message.
    @param fields (str): the fields to validate.
    @return (Any): the field validator.
    """

    def run(cls: type, value: Any) -> Any:
        check(label, value)
        return value

    return field_validator(*fields)(run)


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input_label: ClassVar[str] = "input"

    @model_validator(mode="before")
    @classmethod
    def _reject_unknown_keys(cls, data: Any) -> Any:
        found = _unknown_key(cls, data, cls.input_label)
        if found:
            raise ValidationError(found)
        return data


M = TypeVar("M", bound=BaseModel)


def as_input(model: type[M], value: Any, what: str) -> M | None:
    """Coerce an input argument: a model instance passes through, a mapping is validated, None stays None.

    @param model (type[M]): the input model.
    @param value (Any): the argument.
    @param what (str): a label for the error message.
    @return (M | None): the model instance, or None.
    """
    if value is None or isinstance(value, model):
        return value
    try:
        return model.model_validate(value)
    except PydanticValidationError as exc:
        raise ValidationError(f"invalid {what}: {exc}") from exc


T = TypeVar("T")

Kind = Literal["preference", "disinterest"]
Status = Literal["active", "completed", "reversed"]


class Evidence(BaseModel):
    source_id: str
    source_version: str
    chunk_id: str | None = None
    quote: str | None = None
    start_offset: int | None = None
    end_offset: int | None = None
    confidence: float | None = None


class Entity(BaseModel):
    id: str
    type: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    external_ids: dict[str, str] = Field(default_factory=dict)
    properties: dict[str, JsonValue] = Field(default_factory=dict)
    source_count: int = 0
    created_at: datetime
    updated_at: datetime


class Relation(BaseModel):
    id: str
    revision: int
    from_entity: str
    type: str
    to_entity: str
    properties: dict[str, JsonValue] = Field(default_factory=dict)
    event_time: datetime | None = None
    created_at: datetime
    is_current: bool
    source_count: int = 0


class Preference(BaseModel):
    id: str
    revision: int
    profile_id: str
    subject_entity: str
    kind: Kind
    key: str
    value_entity: str
    about_entity: str | None = None
    strength: float | None = None
    properties: dict[str, JsonValue] = Field(default_factory=dict)
    event_time: datetime | None = None
    created_at: datetime
    is_current: bool


class DecisionStep(BaseModel):
    order: int
    relation_id: str
    from_entity: str
    to_entity: str


class DecisionTrace(BaseModel):
    id: str
    actor_entity: str | None = None
    title: str
    summary: str | None = None
    rationale: str | None = None
    status: Status
    outcome_entity: str | None = None
    alternative_entities: list[str] = Field(default_factory=list)
    steps: list[DecisionStep] = Field(default_factory=list)
    event_time: datetime | None = None
    created_at: datetime
    updated_at: datetime


class InsertWarning(BaseModel):
    code: str
    message: str
    source_id: str | None = None
    chunk_id: str | None = None


class InsertResult(BaseModel):
    source_id: str | None = None
    source_version: str | None = None
    created_at: datetime
    entities: list[Entity] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)
    preferences: list[Preference] = Field(default_factory=list)
    decisions: list[DecisionTrace] = Field(default_factory=list)
    warnings: list[InsertWarning] = Field(default_factory=list)


class Page(BaseModel, Generic[T]):
    items: list[T] = Field(default_factory=list)
    next_cursor: str | None = None


class DeleteResult(BaseModel):
    deleted_entities: int = 0
    deleted_relation_versions: int = 0
    deleted_decisions: int = 0
    deleted_preference_versions: int = 0


class CypherResult(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, JsonValue]] = Field(default_factory=list)
    counters: dict[str, int] = Field(default_factory=dict)


class EntityInput(InputModel):
    input_label: ClassVar[str] = "entity"

    id: str | None = None
    type: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    external_ids: dict[str, str] = Field(default_factory=dict)
    properties: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("type", "name")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValidationError(
                "entity type and name cannot be empty; an entity needs both, e.g. type='Person', name='Jane Doe'"
            )
        return value.strip()

    @field_validator("aliases")
    @classmethod
    def _clean_aliases(cls, value: list[str]) -> list[str]:
        for alias in value:
            if not isinstance(alias, str):
                raise ValidationError(f"entity alias must be a string, got {type(alias).__name__}")
            _require_no_control("entity alias", alias)
        return value

    _clean_json = _check(_require_clean_json, "entity property and external id", "external_ids", "properties")


class EvidenceInput(InputModel):
    input_label: ClassVar[str] = "evidence"

    source_id: str
    quote: str | None = None
    start_offset: int | None = None
    end_offset: int | None = None
    confidence: float | None = None

    _clean_source_id = _check(_require_no_control, "evidence source_id", "source_id")

    @field_validator("quote")
    @classmethod
    def _clean_quote(cls, value: str | None) -> str | None:
        if value is not None and _has_surrogate(value):
            raise ValidationError("evidence quote cannot contain unpaired surrogate characters")
        return value

    @field_validator("confidence")
    @classmethod
    def _finite_confidence(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValidationError("evidence confidence must be a finite number")
        return value


class RelationInput(InputModel):
    input_label: ClassVar[str] = "relation"

    id: str | None = None
    from_entity: str
    type: str
    to_entity: str
    properties: dict[str, JsonValue] = Field(default_factory=dict)
    event_time: datetime | None = None
    evidence: list[EvidenceInput] = Field(default_factory=list)

    @field_validator("type")
    @classmethod
    def _normalize_type(cls, value: str) -> str:
        return normalize_rel_type(value)

    _clean_json = _check(_require_clean_json, "relation property", "properties")


class PreferenceInput(InputModel):
    input_label: ClassVar[str] = "preference"

    id: str | None = None
    subject_entity: str
    kind: Kind = "preference"
    key: str
    value_entity: str
    about_entity: str | None = None
    strength: float | None = None
    properties: dict[str, JsonValue] = Field(default_factory=dict)
    event_time: datetime | None = None

    _clean_key = _check(_require_no_control, "preference key", "key")
    _clean_json = _check(_require_clean_json, "preference property", "properties")


class DecisionTraceInput(InputModel):
    input_label: ClassVar[str] = "decision"

    id: str | None = None
    title: str
    steps: list[str]
    actor_entity: str | None = None
    summary: str | None = None
    rationale: str | None = None
    outcome_entity: str | None = None
    alternative_entities: list[str] = Field(default_factory=list)
    status: Status = "completed"
    event_time: datetime | None = None


class Ontology(InputModel):
    input_label: ClassVar[str] = "ontology"

    entities: list[EntityInput] = Field(default_factory=list)
    relations: list[RelationInput] = Field(default_factory=list)
    preferences: list[PreferenceInput] = Field(default_factory=list)
    decisions: list[DecisionTraceInput] = Field(default_factory=list)


class LLMConfig(BaseModel):
    provider: str
    model: str
    api_key: str | None = None
    base_url: str | None = None
    temperature: float = 0.0
    max_retries: int = 3


class PromptTemplate(InputModel):
    input_label: ClassVar[str] = "prompt"

    system: str
    user: str
    version: str


class ExtractionInstructions(InputModel):
    input_label: ClassVar[str] = "instructions"

    entities: str | None = None
    relations: str | None = None
    preferences: str | None = None
    decisions: str | None = None


class ExtractionPrompts(InputModel):
    input_label: ClassVar[str] = "prompts"

    entities: PromptTemplate | None = None
    relations: PromptTemplate | None = None
    preferences: PromptTemplate | None = None
    decisions: PromptTemplate | None = None


class ParsedDocument(BaseModel):
    text: str
    media_type: str
    metadata: dict[str, JsonValue] = Field(default_factory=dict)


class RetrievalSeed(BaseModel):
    id: str
    score: float


class Subgraph(BaseModel):
    entities: list[Entity] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)
    preferences: list[Preference] = Field(default_factory=list)
    decisions: list[DecisionTrace] = Field(default_factory=list)


class RetrievalResult(BaseModel):
    query: str
    strategy: str
    seeds: list[RetrievalSeed] = Field(default_factory=list)
    subgraph: Subgraph = Field(default_factory=Subgraph)
    context: str = ""

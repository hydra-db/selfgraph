from collections.abc import Callable, Iterable, Mapping
from datetime import datetime
from types import UnionType
from typing import Any, ClassVar, Generic, Literal, TypeVar, Union, get_args, get_origin

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    SerializerFunctionWrapHandler,
    field_validator,
    model_serializer,
    model_validator,
)
from pydantic import ValidationError as PydanticValidationError

from .errors import ValidationError
from .ids import _has_surrogate, _require_clean_json, _require_no_control, _require_unit, normalize_rel_type

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
    "DecayResult",
    "PruneResult",
    "DedupeGroup",
    "DedupeResult",
    "CypherResult",
    "EntityInput",
    "EvidenceInput",
    "RelationInput",
    "PreferenceInput",
    "DecisionTraceInput",
    "Extraction",
    "LLMConfig",
    "PromptTemplate",
    "ExtractionInstructions",
    "ExtractionPrompts",
    "ParsedDocument",
    "RetrievalSeed",
    "Subgraph",
    "RetrievalResult",
    "Stance",
    "Status",
    "MergeRewrite",
    "MergeRecord",
    "UnmergeResult",
    "validation_message",
]

_KEY_SYNONYMS = {
    "entity_types": "entities",
    "node_types": "entities",
    "nodes": "entities",
    "relation_types": "relations",
    "relationship_types": "relations",
    "edge_types": "relations",
    "edges": "relations",
    "graph_name": "graph",
    "graphName": "graph",
}


_LISTED_KEYS = 8
_JSON_TYPES = {
    "string": "string",
    "int": "integer",
    "float": "number",
    "bool": "boolean",
    "list": "array",
    "tuple": "array",
    "dict": "object",
    "model": "object",
    "model_attributes": "object",
}
_BOUNDS = {
    "greater_than": ("gt", ">"),
    "greater_than_equal": ("ge", ">="),
    "less_than": ("lt", "<"),
    "less_than_equal": ("le", "<="),
}


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


def suggest_key(key: str, valid: list[str], max_edits: int = 2) -> str | None:
    """Pick the valid key closest to an unknown one: a synonym, else the nearest within max_edits, else one ending _key.

    @param key (str): the unknown key.
    @param valid (list[str]): the accepted keys in declared order.
    @param max_edits (int): the most edits a suggestion may be away.
    @return (str | None): the suggestion, or None when nothing is close.
    """
    synonym = _KEY_SYNONYMS.get(key)
    if synonym is not None and synonym in valid:
        return synonym
    best: str | None = None
    limit = min(max_edits, len(key) - 1)
    for candidate in valid:
        distance = _edit_distance(key, candidate)
        if distance <= limit:
            best, limit = candidate, distance - 1
    if best is None:
        best = next((candidate for candidate in valid if candidate.endswith(f"_{key}")), None)
    return best


def did_you_mean(suggestion: str | None) -> str:
    """The suffix that offers a suggested name, or "" without one.

    @param suggestion (str | None): the suggested name.
    @return (str): the suffix, such as "; did you mean 'name'?".
    """
    return f"; did you mean {suggestion!r}?" if suggestion else ""


def key_hint(key: str, valid: list[str], noun: str = "keys") -> str:
    """The suffix of an unknown-key error: the closest valid key, and every valid key when there are few.

    @param key (str): the unknown key.
    @param valid (list[str]): the accepted keys in declared order.
    @param noun (str): what the keys are called in the list, such as "keys" or "options".
    @return (str): the suffix, such as "; did you mean 'name'? (valid keys: id, type, name)", or "".
    """
    hint = did_you_mean(suggest_key(key, valid))
    if 0 < len(valid) <= _LISTED_KEYS:
        hint += f" (valid {noun}: {', '.join(valid)})"
    return hint


def check_options(method: str, given: Iterable[str], allowed: Iterable[str]) -> None:
    """Reject option names a method does not accept, naming the first unknown one and the closest accepted one.

    @param method (str): the method the options belong to, for the message.
    @param given (Iterable[str]): the option names the caller passed.
    @param allowed (Iterable[str]): the accepted names in declared order.
    @return (None): nothing; raises ValidationError on an unknown name.
    """
    accepted = list(allowed)
    unknown = sorted(str(k) for k in given if k not in accepted)
    if unknown:
        raise ValidationError(f"unknown option {unknown[0]!r} for {method}{key_hint(unknown[0], accepted, 'options')}")


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
        return f"unknown key {unknown[0]!r} in {where}{key_hint(unknown[0], keys)}"
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


class TopInputModel(InputModel):
    def __init__(self, /, **data: Any) -> None:
        """Validate keyword fields, raising SelfGraph's ValidationError with one "path: message" line per issue.

        Only top-level inputs override __init__: pydantic calls a custom __init__ for nested models too, which
        would cut the path of an error inside them.

        @param data (Any): the model fields.
        """
        try:
            super().__init__(**data)
        except PydanticValidationError as exc:
            raise ValidationError(validation_message(f"invalid {self.input_label}", exc)) from exc


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
        raise ValidationError(validation_message(f"invalid {what}", exc)) from exc


def _issue_message(err: Mapping[str, Any]) -> str:
    """Describe one pydantic error in the wording the TypeScript port uses for the same zod issue.

    @param err (Mapping[str, Any]): one entry of a pydantic ValidationError's errors().
    @return (str): the message, such as "field required" or "expected string".
    """
    kind, ctx = err["type"], err.get("ctx") or {}
    if kind == "missing":
        return "field required"
    base = kind.removesuffix("_type").removesuffix("_parsing")
    if base != kind and base in _JSON_TYPES:
        return f"expected {_JSON_TYPES[base]}"
    if kind == "literal_error" and "expected" in ctx:
        return f"expected {ctx['expected']}"
    key, op = _BOUNDS.get(kind, ("", ""))
    if key in ctx:
        bound = ctx[key]
        return f"must be {op} {int(bound) if isinstance(bound, float) and bound.is_integer() else bound}"
    msg = str(err["msg"]).removeprefix("Value error, ")
    return msg[:1].lower() + msg[1:]


def issue_line(err: Mapping[str, Any]) -> str:
    """Format one pydantic error as an "entities[0].name: message" line, or the message alone at the root.

    @param err (Mapping[str, Any]): one entry of a pydantic ValidationError's errors().
    @return (str): the line.
    """
    path = ""
    for part in err["loc"]:
        if isinstance(part, int) and not isinstance(part, bool):
            path += f"[{part}]"
        else:
            path += f".{part}" if path else str(part)
    message = _issue_message(err)
    return f"{path}: {message}" if path else message


def validation_message(head: str, exc: PydanticValidationError) -> str:
    """Format a pydantic ValidationError as one "path: message" line per issue, with entities[0].name paths.

    One issue stays inline after the heading; several go on indented lines.

    @param head (str): what failed, such as "invalid facts".
    @param exc (PydanticValidationError): the error.
    @return (str): the message.
    """
    lines = [issue_line(err) for err in exc.errors()]
    return f"{head}: {lines[0]}" if len(lines) == 1 else head + ":" + "".join(f"\n  {line}" for line in lines)


T = TypeVar("T")

Stance = Literal["preference", "disinterest"]
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
    relevance: float | None = None
    relevance_at: datetime | None = None


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
    invalidated_at: datetime | None = None
    invalidated_by: str | None = None
    relevance: float | None = None
    relevance_at: datetime | None = None


class Preference(BaseModel):
    id: str
    revision: int
    profile_id: str
    subject_entity: str
    stance: Stance
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
    merge_id: str | None = None


class MergeRewrite(BaseModel):
    kind: Literal["relation", "preference", "decision"]
    id: str
    original: dict[str, JsonValue] = Field(default_factory=dict)
    rewritten: dict[str, JsonValue] = Field(default_factory=dict)
    existed: bool = False
    dropped: bool = False


class MergeRecord(BaseModel):
    id: str
    survivor_id: str
    absorbed_id: str
    absorbed: dict[str, JsonValue] = Field(default_factory=dict)
    reason: str
    confidence: float
    source_id: str | None = None
    source_ids: list[str] = Field(default_factory=list)
    added_aliases: list[str] = Field(default_factory=list)
    added_external_ids: list[str] = Field(default_factory=list)
    added_properties: list[str] = Field(default_factory=list)
    rewrites: list[MergeRewrite] = Field(default_factory=list)
    created_at: datetime
    reverted_at: datetime | None = None


class InsertResult(BaseModel):
    source_id: str | None = None
    source_version: str | None = None
    created_at: datetime
    entities: list[Entity] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)
    preferences: list[Preference] = Field(default_factory=list)
    decisions: list[DecisionTrace] = Field(default_factory=list)
    warnings: list[InsertWarning] = Field(default_factory=list)
    merges: list[MergeRecord] = Field(default_factory=list)


class UnmergeResult(BaseModel):
    merge: MergeRecord
    entity: Entity
    survivor: Entity | None = None
    relations: list[Relation] = Field(default_factory=list)
    preferences: list[Preference] = Field(default_factory=list)
    decisions: list[DecisionTrace] = Field(default_factory=list)


class Page(BaseModel, Generic[T]):
    items: list[T] = Field(default_factory=list)
    next_cursor: str | None = None


class DeleteResult(BaseModel):
    deleted_entities: int = 0
    deleted_relation_versions: int = 0
    deleted_decisions: int = 0
    deleted_preference_versions: int = 0


class DecayResult(BaseModel):
    dry_run: bool
    half_life_days: float
    now: datetime
    entities: dict[str, float] = Field(default_factory=dict)
    relations: dict[str, float] = Field(default_factory=dict)
    updated_entities: int = 0
    updated_relations: int = 0


class _PlanResult(BaseModel):
    @model_serializer(mode="wrap")
    def _omit_plan_deletes(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        """Serialize the result, leaving out the deleted block a dry run never fills.

        @param handler (SerializerFunctionWrapHandler): pydantic's default serializer.
        @return (dict[str, Any]): the serialized result.
        """
        data = handler(self)
        if getattr(self, "deleted", None) is None:
            data.pop("deleted", None)
        return data


class PruneResult(_PlanResult):
    dry_run: bool
    entity_ids: list[str] = Field(default_factory=list)
    relation_ids: list[str] = Field(default_factory=list)
    deleted: DeleteResult | None = None
    note: str | None = None


class DedupeGroup(BaseModel):
    from_entity: str
    type: str
    to_entity: str
    survivor: str
    duplicates: list[str] = Field(default_factory=list)
    conflicts: dict[str, list[str]] = Field(default_factory=dict)
    versions_lost: dict[str, int] = Field(default_factory=dict)


class DedupeResult(_PlanResult):
    dry_run: bool
    groups: list[DedupeGroup] = Field(default_factory=list)
    deleted: DeleteResult | None = None
    note: str | None = None


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
    chunk_id: str | None = None
    quote: str | None = None
    start_offset: int | None = None
    end_offset: int | None = None
    confidence: float | None = None

    _clean_source_id = _check(_require_no_control, "evidence source_id", "source_id")

    @field_validator("chunk_id")
    @classmethod
    def _clean_chunk_id(cls, value: str | None) -> str | None:
        if value is not None:
            _require_no_control("evidence chunk_id", value)
        return value

    @field_validator("quote")
    @classmethod
    def _clean_quote(cls, value: str | None) -> str | None:
        if value is not None and _has_surrogate(value):
            raise ValidationError("evidence quote cannot contain unpaired surrogate characters")
        return value

    @field_validator("confidence")
    @classmethod
    def _finite_confidence(cls, value: float | None) -> float | None:
        if value is not None:
            _require_unit("evidence confidence", value, finite=True)
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
    stance: Stance = "preference"
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
    steps: list[str] = Field(default_factory=list)
    actor_entity: str | None = None
    summary: str | None = None
    rationale: str | None = None
    outcome_entity: str | None = None
    alternative_entities: list[str] = Field(default_factory=list)
    status: Status = "completed"
    event_time: datetime | None = None


class Extraction(TopInputModel):
    input_label: ClassVar[str] = "facts"

    entities: list[EntityInput] = Field(default_factory=list)
    relations: list[RelationInput] = Field(default_factory=list)
    preferences: list[PreferenceInput] = Field(default_factory=list)
    decisions: list[DecisionTraceInput] = Field(default_factory=list)


LLM_TIMEOUT = 120.0
LLM_CONCURRENCY = 4
_DIRECT_PROVIDERS = frozenset(
    ("anthropic", "openai", "gemini", "google", "mistral", "xai", "deepseek", "cohere", "perplexity")
)
_KNOWN_PROVIDERS = _DIRECT_PROVIDERS | {
    "azure",
    "bedrock",
    "cerebras",
    "fireworks",
    "fireworks_ai",
    "gateway",
    "groq",
    "ollama",
    "openrouter",
    "together_ai",
    "togetherai",
    "vertex",
    "vertex_ai",
}
_SAME_PROVIDER = {"google": "gemini"}


class LLMConfig(TopInputModel):
    input_label: ClassVar[str] = "llm config"

    provider: str
    model: str
    api_key: str | None = None
    base_url: str | None = None
    temperature: float = 0.0
    max_retries: int = Field(default=3, ge=0)
    timeout: float | None = Field(default=LLM_TIMEOUT, gt=0)
    concurrency: int = Field(default=LLM_CONCURRENCY, ge=1)

    @model_validator(mode="after")
    def _matching_prefix(self) -> "LLMConfig":
        """Reject a first-party provider's model prefixed with another provider, such as anthropic with gemini/x.

        Routers (openrouter, groq, together, and the like) and any provider with a base_url take vendor-prefixed
        models, so only a first-party provider without a base_url is checked, and only against a known prefix.

        @return (LLMConfig): the config; raises ValidationError on a conflict.
        """
        prefix, sep, _ = self.model.partition("/")
        own, other = self.provider.lower(), prefix.lower()
        known = sep and not self.base_url and own in _DIRECT_PROVIDERS and other in _KNOWN_PROVIDERS
        if known and _SAME_PROVIDER.get(own, own) != _SAME_PROVIDER.get(other, other):
            raise ValidationError(f"provider {self.provider!r} conflicts with model prefix {prefix!r}")
        return self


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

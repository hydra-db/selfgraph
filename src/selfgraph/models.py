from datetime import datetime
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, Field, JsonValue, field_validator

from .ids import normalize_rel_type

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
    evidence: list[Evidence] = Field(default_factory=list)
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
    evidence: list[Evidence] = Field(default_factory=list)


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


class CypherResult(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, JsonValue]] = Field(default_factory=list)
    counters: dict[str, int] = Field(default_factory=dict)


class EntityInput(BaseModel):
    id: str | None = None
    type: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    external_ids: dict[str, str] = Field(default_factory=dict)
    properties: dict[str, JsonValue] = Field(default_factory=dict)


class EvidenceInput(BaseModel):
    source_id: str
    quote: str | None = None
    start_offset: int | None = None
    end_offset: int | None = None
    confidence: float | None = None


class RelationInput(BaseModel):
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


class PreferenceInput(BaseModel):
    id: str | None = None
    subject_entity: str
    kind: Kind = "preference"
    key: str
    value_entity: str
    about_entity: str | None = None
    strength: float | None = None
    properties: dict[str, JsonValue] = Field(default_factory=dict)
    event_time: datetime | None = None


class DecisionTraceInput(BaseModel):
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


class Ontology(BaseModel):
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


class PromptTemplate(BaseModel):
    system: str
    user: str
    version: str


class ExtractionInstructions(BaseModel):
    entities: str | None = None
    relations: str | None = None
    preferences: str | None = None
    decisions: str | None = None


class ExtractionPrompts(BaseModel):
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

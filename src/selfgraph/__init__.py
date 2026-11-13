from __future__ import annotations

from typing import TYPE_CHECKING

from .client import SelfGraph
from .errors import (
    ConflictError,
    ExtractionError,
    NotFoundError,
    PromptTemplateError,
    SelfGraphError,
    StoreError,
    TransientError,
    ValidationError,
)
from .extraction import DEFAULT_PROMPTS, LLMExtractor, NERExtractor
from .ids import decision_id, entity_id, normalize_rel_type, preference_id, profile_id, relation_id
from .llm import build_llm_client
from .models import (
    CypherResult,
    DecayResult,
    DecisionStep,
    DecisionTrace,
    DecisionTraceInput,
    DedupeGroup,
    DedupeResult,
    DeleteResult,
    Entity,
    EntityInput,
    Evidence,
    EvidenceInput,
    Extraction,
    ExtractionInstructions,
    ExtractionPrompts,
    InsertResult,
    InsertWarning,
    LLMConfig,
    MergeRecord,
    MergeRewrite,
    Page,
    ParsedDocument,
    Preference,
    PreferenceInput,
    PromptTemplate,
    PruneResult,
    Relation,
    RelationInput,
    RetrievalResult,
    RetrievalSeed,
    Subgraph,
    UnmergeResult,
)
from .protocols import Extractor, GraphStore, LLMClient
from .resolution import DefaultResolver, EntityResolver, LLMResolver, ResolutionDecision, ResolverMode
from .schema import EntityType, PropertySpec, RelationEndpoint, RelationType, Schema
from .sync import SyncSelfGraph

__version__ = "0.2.0"

if TYPE_CHECKING:
    from .stores.cypher import CypherStore, Neo4jStore
    from .stores.falkordb import FalkorDBStore
    from .stores.hydradb import HydraDBStore
    from .stores.kuzu import KuzuStore

_LAZY = {
    "CypherStore": ("selfgraph.stores.cypher", "CypherStore"),
    "Neo4jStore": ("selfgraph.stores.cypher", "Neo4jStore"),
    "FalkorDBStore": ("selfgraph.stores.falkordb", "FalkorDBStore"),
    "HydraDBStore": ("selfgraph.stores.hydradb", "HydraDBStore"),
    "KuzuStore": ("selfgraph.stores.kuzu", "KuzuStore"),
}


def __getattr__(name: str):
    if name in _LAZY:
        import importlib

        module_name, attr = _LAZY[name]
        module = importlib.import_module(module_name)
        return getattr(module, attr)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(__all__)


__all__ = [
    "SelfGraph",
    "SyncSelfGraph",
    "CypherStore",
    "Neo4jStore",
    "FalkorDBStore",
    "HydraDBStore",
    "KuzuStore",
    "GraphStore",
    "LLMClient",
    "Extractor",
    "Entity",
    "Relation",
    "Preference",
    "DecisionStep",
    "DecisionTrace",
    "Evidence",
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
    "Schema",
    "EntityType",
    "RelationType",
    "RelationEndpoint",
    "PropertySpec",
    "LLMConfig",
    "PromptTemplate",
    "ExtractionInstructions",
    "ExtractionPrompts",
    "ParsedDocument",
    "RetrievalResult",
    "RetrievalSeed",
    "Subgraph",
    "EntityResolver",
    "ResolutionDecision",
    "DefaultResolver",
    "LLMResolver",
    "ResolverMode",
    "MergeRecord",
    "MergeRewrite",
    "UnmergeResult",
    "LLMExtractor",
    "NERExtractor",
    "DEFAULT_PROMPTS",
    "build_llm_client",
    "entity_id",
    "relation_id",
    "preference_id",
    "decision_id",
    "profile_id",
    "normalize_rel_type",
    "SelfGraphError",
    "ValidationError",
    "NotFoundError",
    "ConflictError",
    "ExtractionError",
    "PromptTemplateError",
    "StoreError",
    "TransientError",
    "__version__",
]

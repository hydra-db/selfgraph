from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

from . import _ops
from ._serde import now
from .errors import TransientError, ValidationError
from .extraction.extractor import DefaultExtractor
from .insert import Insert
from .llm.base import resolve_llm
from .models import (
    CypherResult,
    ExtractionInstructions,
    ExtractionPrompts,
    InsertResult,
    InsertWarning,
    JsonValue,
    LLMConfig,
    Ontology,
    RetrievalResult,
)
from .protocols import Extractor, GraphStore, LLMClient
from .provenance import record_source
from .resources import Decisions, Entities, Preferences, Relations
from .retrieval import retrieve as _retrieve

__all__ = ["SelfGraph"]

_MAX_TX_RETRIES = 12
_TX_RETRY_BASE_DELAY = 0.02
_TX_RETRY_MAX_DELAY = 1.0

_log = logging.getLogger("selfgraph")


class SelfGraph:
    def __init__(
        self,
        store: GraphStore,
        *,
        llm: LLMConfig | LLMClient | None = None,
        instructions: ExtractionInstructions | None = None,
        prompts: ExtractionPrompts | None = None,
        extractor: Extractor | None = None,
        namespace: str = "default",
    ) -> None:
        _ops._require_text("namespace", namespace)
        self.store = store
        self.namespace = namespace
        self._llm = resolve_llm(llm)
        self._instructions = instructions
        self._prompts = prompts
        self._extractor = extractor
        self._ready = False

        self.entities = Entities(self)
        self.relations = Relations(self)
        self.preferences = Preferences(self)
        self.decisions = Decisions(self)
        self.insert = Insert(self)

    @classmethod
    def from_env(cls, **overrides: Any) -> SelfGraph:
        """Build a graph from SELFGRAPH_* environment variables.

        @param overrides (Any): GraphSettings fields that take precedence over the environment.
        @return (SelfGraph): the constructed graph.
        """
        from .runtime import build_graph, settings_from_env

        return build_graph(settings_from_env(**overrides))

    @classmethod
    def connect(cls, **settings: Any) -> SelfGraph:
        """Build a graph from store and LLM settings without importing a store class.

        @param settings (Any): GraphSettings fields such as store, uri, auth, namespace, llm_provider, llm_model.
        @return (SelfGraph): the constructed graph.
        """
        from .runtime import GraphSettings, build_graph

        return build_graph(GraphSettings(**settings))

    async def initialize(self) -> None:
        """Create the store's ID constraints and indexes."""
        await self.store.initialize()
        self._ready = True

    async def _ensure_ready(self) -> None:
        """Initialize the store once on first use so callers need not call initialize.

        @return (None): nothing.
        """
        if not self._ready:
            await self.initialize()

    async def _reader(self) -> GraphStore:
        """Return the store after ensuring it is initialized, for read operations.

        @return (GraphStore): the initialized store.
        """
        await self._ensure_ready()
        return self.store

    async def close(self) -> None:
        """Close the underlying store connection if it has one."""
        close = getattr(self.store, "close", None)
        if close is not None:
            await close()

    async def __aenter__(self) -> SelfGraph:
        """Initialize the store and return the graph for use in an async with block."""
        await self.initialize()
        return self

    async def __aexit__(self, *exc: object) -> None:
        """Close the store on exit from an async with block."""
        await self.close()

    async def run_cypher(self, query: str, params: Mapping[str, JsonValue] | None = None) -> CypherResult:
        """Run one raw Cypher statement directly against the store, as an unguarded escape hatch.

        This runs the query verbatim: it can write, it is not scoped to the namespace, and it
        bypasses id derivation, versioning, and provenance. Prefer the typed resources for managed
        writes. The MCP run_cypher tool, by contrast, rejects write clauses.

        @param query (str): the Cypher statement.
        @param params (Mapping[str, JsonValue] | None): query parameters.
        @return (CypherResult): the resulting rows and counters.
        """
        if not isinstance(query, str):
            raise ValidationError(f"query must be a string, got {type(query).__name__}")
        if not query.strip():
            raise ValidationError("query cannot be empty")
        _ops._require_json_mapping("params", params)
        await self._ensure_ready()
        return await self.store.run_cypher(query, params)

    async def retrieve(
        self,
        query: str,
        *,
        strategy: str = "bfs",
        depth: int = 3,
        k: int = 20,
        max_nodes: int = 200,
        budget_tokens: int = 3000,
    ) -> RetrievalResult:
        """Retrieve graph context for a query via keyword seeds and bounded traversal.

        @param query (str): the natural-language query to seed from.
        @param strategy (str): "bfs" or "dfs" traversal order.
        @param depth (int): the maximum number of hops from a seed.
        @param k (int): the maximum number of seed entities.
        @param max_nodes (int): the maximum number of entities to collect.
        @param budget_tokens (int): the assembled-context token budget.
        @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
        """
        if not isinstance(query, str):
            raise ValidationError(f"query must be a string, got {type(query).__name__}")
        if not isinstance(strategy, str):
            raise ValidationError(f"strategy must be a string, got {type(strategy).__name__}")
        for _name, _value in (("depth", depth), ("k", k), ("max_nodes", max_nodes), ("budget_tokens", budget_tokens)):
            _ops._require_int(_name, _value)
        await self._ensure_ready()
        return await _retrieve(
            self,
            query,
            strategy=strategy,
            depth=depth,
            k=k,
            max_nodes=max_nodes,
            budget_tokens=budget_tokens,
        )

    async def _in_tx(self, fn: Callable[[Any], Awaitable[Any]]) -> Any:
        await self._ensure_ready()
        for attempt in range(_MAX_TX_RETRIES):
            try:
                async with self.store.transaction() as tx:
                    return await fn(tx)
            except TransientError as exc:
                if attempt == _MAX_TX_RETRIES - 1:
                    raise TransientError(
                        f"write contention: could not commit after {_MAX_TX_RETRIES} retries; "
                        "retry the write or serialize concurrent writers to this edge"
                    ) from exc
                backoff = min(_TX_RETRY_BASE_DELAY * 2**attempt, _TX_RETRY_MAX_DELAY)
                await asyncio.sleep(random.uniform(0, backoff))

    async def _write(self, op: Callable[..., Awaitable[Any]], *args: Any, **kwargs: Any) -> Any:
        """Run an _ops write inside a transaction with the namespace injected.

        @param op (Callable[..., Awaitable[Any]]): an _ops write taking (tx, namespace, ...).
        @return (Any): the op's result.
        """
        return await self._in_tx(lambda tx: op(tx, self.namespace, *args, **kwargs))

    def _build_extractor(
        self,
        call_instructions: ExtractionInstructions | None,
        call_prompts: ExtractionPrompts | None,
    ) -> Extractor:
        if self._extractor is not None:
            return self._extractor
        if self._llm is None:
            from .extraction.basic import BasicExtractor

            return BasicExtractor()
        return DefaultExtractor(
            self._llm,
            prompts=self._prompts,
            instructions=self._instructions,
            call_prompts=call_prompts,
            call_instructions=call_instructions,
        )

    async def _apply_ontology(
        self,
        ontology: Ontology,
        *,
        source_id: str | None,
        parsed_text: str | None,
        media_type: str | None,
        metadata: dict[str, JsonValue] | None,
        default_event_time: datetime | None,
        warnings: list[InsertWarning] | None = None,
    ) -> InsertResult:
        created_at = now()
        ns = self.namespace
        warnings = list(warnings or [])

        async def _apply(tx: Any) -> InsertResult:
            _ops._require_datetime("event_time", default_event_time)
            await _ops.validate_ontology(tx, ns, ontology)
            source_version: str | None = None
            base_evidence = []

            if source_id is not None:
                source_version, base_evidence = await record_source(
                    tx,
                    ns,
                    source_id=source_id,
                    parsed_text=parsed_text or "",
                    media_type=media_type or "application/octet-stream",
                    metadata=metadata,
                    created_at=created_at,
                )

            entities = [
                await _ops.upsert_entity(tx, ns, ent, evidence=list(base_evidence), created_at=created_at)
                for ent in ontology.entities
            ]

            relations = []
            for rel in ontology.relations:
                evidence = list(base_evidence) + _ops.evidence_from_inputs(rel.evidence, source_version=source_version)
                relations.append(
                    await _ops.upsert_relation(
                        tx,
                        ns,
                        rel,
                        evidence=evidence,
                        default_event_time=default_event_time,
                        created_at=created_at,
                    )
                )

            preferences = [
                await _ops.upsert_preference(tx, ns, pref, default_event_time=default_event_time, created_at=created_at)
                for pref in ontology.preferences
            ]

            decisions = []
            for dec in ontology.decisions:
                decisions.append(
                    await _ops.upsert_trace(
                        tx,
                        ns,
                        tid=dec.id,
                        title=dec.title,
                        step_rel_ids=list(dec.steps),
                        actor_entity=dec.actor_entity,
                        summary=dec.summary,
                        rationale=dec.rationale,
                        outcome_entity=dec.outcome_entity,
                        alternative_entities=list(dec.alternative_entities),
                        status=dec.status,
                        event_time=dec.event_time or default_event_time,
                        created_at=created_at,
                    )
                )

            _log.debug(
                "inserted %d entities, %d relations, %d preferences, %d decisions (source=%s)",
                len(entities),
                len(relations),
                len(preferences),
                len(decisions),
                source_id,
            )
            return InsertResult(
                source_id=source_id,
                source_version=source_version,
                created_at=created_at,
                entities=entities,
                relations=relations,
                preferences=preferences,
                decisions=decisions,
                warnings=warnings,
            )

        return await self._in_tx(_apply)

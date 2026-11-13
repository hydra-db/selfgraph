from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

from . import _ops
from ._serde import aware, now
from .errors import CLOSED_MESSAGE, StoreError, TransientError, ValidationError
from .extraction.extractor import LLMExtractor
from .extraction.prompts import check_prompts
from .ids import _require_namespace
from .insert import Insert
from .llm.base import resolve_llm
from .models import (
    CypherResult,
    Extraction,
    ExtractionInstructions,
    ExtractionPrompts,
    InsertResult,
    InsertWarning,
    JsonValue,
    LLMConfig,
    RetrievalResult,
    as_input,
    check_options,
)
from .protocols import Extractor, GraphStore, LLMClient
from .provenance import record_source
from .resolution import EntityResolver, ResolverMode, as_resolver, merge_warnings, plan_resolution, save_merges
from .resources import Decisions, Entities, Maintenance, Preferences, Relations
from .retrieval import retrieve as _retrieve
from .schema import (
    ContradictionMode,
    Schema,
    SchemaMode,
    as_schema,
    canonicalize_types,
    contradiction_caps,
    drop_off_schema,
    enforce_schema,
    log_schema_warnings,
    require_contradiction_mode,
    require_schema_for_mode,
    require_schema_mode,
)

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
        instructions: ExtractionInstructions | Mapping[str, Any] | None = None,
        prompts: ExtractionPrompts | Mapping[str, Any] | None = None,
        extractor: Extractor | None = None,
        namespace: str = "default",
        schema: Schema | Mapping[str, Any] | None = None,
        schema_mode: SchemaMode = "warn",
        resolver: EntityResolver | ResolverMode = "exact",
        contradiction: ContradictionMode = "warn",
    ) -> None:
        _require_namespace(namespace)
        require_schema_mode(schema_mode)
        require_contradiction_mode(contradiction)
        self.store = store
        self.namespace = namespace
        self._llm = resolve_llm(llm)
        self._resolver = as_resolver(resolver, self._llm)
        self._instructions = as_input(ExtractionInstructions, instructions, "instructions")
        self._prompts = as_input(ExtractionPrompts, prompts, "prompts")
        check_prompts(self._prompts)
        self._extractor = extractor
        self._schema = as_schema(schema)
        require_schema_for_mode(schema_mode, self._schema)
        self._schema_mode: SchemaMode = schema_mode
        self._contradiction: ContradictionMode = contradiction
        self._ready = False
        self._closed = False

        self.entities = Entities(self)
        self.relations = Relations(self)
        self.preferences = Preferences(self)
        self.decisions = Decisions(self)
        self.maintenance = Maintenance(self)
        self.insert = Insert(self)

    @property
    def schema(self) -> Schema | None:
        """The graph-level schema, read-only.

        @return (Schema | None): the schema, or None when none is set.
        """
        return self._schema

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

        @param settings (Any): GraphSettings fields such as store, uri, namespace, llm_model, and schema.
        @return (SelfGraph): the constructed graph.
        """
        from .runtime import SETTING_KEYS, GraphSettings, build_graph

        check_options("connect", settings, SETTING_KEYS)
        return build_graph(GraphSettings(**settings))

    async def initialize(self) -> None:
        """Create the store's ID constraints and indexes."""
        if self._closed:
            raise StoreError(CLOSED_MESSAGE)
        await self.store.initialize()
        self._ready = True

    async def _ensure_ready(self) -> None:
        """Initialize the store once on first use so callers need not call initialize.

        @return (None): nothing.
        """
        if self._closed:
            raise StoreError(CLOSED_MESSAGE)
        if not self._ready:
            await self.initialize()

    async def _reader(self) -> GraphStore:
        """Return the store after ensuring it is initialized, for read operations.

        @return (GraphStore): the initialized store.
        """
        await self._ensure_ready()
        return self.store

    async def close(self) -> None:
        """Close the underlying store connection if it has one; later calls raise StoreError."""
        if self._closed:
            return
        self._closed = True
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
        writes. The MCP run_cypher tool, by contrast, rejects write clauses. The query sees each
        backend's physical storage, including internal fields, and what it accepts differs per
        backend; see docs/backends.md.

        @param query (str): the Cypher statement.
        @param params (Mapping[str, JsonValue] | None): query parameters.
        @return (CypherResult): the resulting rows and counters.
        """
        if not isinstance(query, str):
            raise ValidationError(f"query must be a string, got {type(query).__name__}")
        if not query.strip():
            raise ValidationError("query cannot be empty")
        _ops._require_json_mapping("params", params, safe_ints=False)
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
        as_of: datetime | str | None = None,
    ) -> RetrievalResult:
        """Retrieve graph context for a query via keyword seeds and bounded traversal.

        @param query (str): the natural-language query to seed from.
        @param strategy (str): "bfs" or "dfs" traversal order, or "ppr" for personalized PageRank ranking.
        @param depth (int): the maximum number of hops from a seed.
        @param k (int): the maximum number of seed entities.
        @param max_nodes (int): the maximum number of entities to collect.
        @param budget_tokens (int): the assembled-context token budget.
        @param as_of (datetime | str | None): a point in time to read the graph at on the valid-time axis (relations and
            preferences valid then, with their entities; naive means UTC), or None for now.
        @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
        """
        if not isinstance(query, str):
            raise ValidationError(f"query must be a string, got {type(query).__name__}")
        if not query.strip():
            raise ValidationError("query cannot be empty")
        if not isinstance(strategy, str):
            raise ValidationError(f"strategy must be a string, got {type(strategy).__name__}")
        for name, value in (("depth", depth), ("k", k), ("max_nodes", max_nodes), ("budget_tokens", budget_tokens)):
            _ops._require_int(name, value)
        as_of = _ops.parse_time(as_of, "as_of")
        if as_of is not None:
            as_of = aware(as_of)
        await self._ensure_ready()
        return await _retrieve(
            self,
            query,
            strategy=strategy,
            depth=depth,
            k=k,
            max_nodes=max_nodes,
            budget_tokens=budget_tokens,
            as_of=as_of,
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

    async def _schema_check(self, runner: Any, facts: Extraction, before: Extraction | None = None) -> None:
        """Check a single entity or relation write against the graph schema, logging warnings in warn mode.

        @param runner (Any): graph runner.
        @param facts (Extraction): the one entity or relation about to be written.
        @param before (Extraction | None): its stored state for an update, so only new violations count.
        """
        log_schema_warnings(
            await enforce_schema(
                runner, self.namespace, facts, self._schema, self._schema_mode, cardinality=False, before=before
            )
        )

    def _contradiction_for(
        self, contradiction: ContradictionMode | None, schema: Schema | None
    ) -> tuple[ContradictionMode, dict[str, Any]]:
        """Resolve a per-call contradiction mode against the graph's and collect the schema's max_count limits.

        @param contradiction (ContradictionMode | None): the per-call mode, or None for the graph's.
        @param schema (Schema | None): the schema the write is checked against.
        @return (tuple[ContradictionMode, dict[str, Any]]): the mode and the limits by relation type.
        """
        mode = self._contradiction if contradiction is None else contradiction
        require_contradiction_mode(mode)
        return mode, contradiction_caps(schema)

    async def _create_relation(self, contradiction: ContradictionMode | None, **fields: Any) -> Any:
        """Create one relation under the contradiction mode, logging contradiction warnings like schema warnings.

        In strict schema mode a max_count conflict with the stored graph raises ValidationError, unless the mode is
        supersede, which retires the older relation instead, or off, which skips max_count checks.

        @param contradiction (ContradictionMode | None): the per-call mode, or None for the graph's.
        @param fields (Any): the create_relation keyword arguments.
        @return (Relation): the created relation.
        """
        mode, caps = self._contradiction_for(contradiction, self._schema)
        if self._schema_mode == "strict" and mode == "warn":
            mode = "strict"
        found: list[InsertWarning] = []

        async def create(tx: Any) -> Any:
            found.clear()
            check = self._schema_check
            return await _ops.create_relation(
                tx, self.namespace, **fields, schema_check=check, contradiction=mode, caps=caps, warnings=found
            )

        rel = await self._in_tx(create)
        log_schema_warnings(found)
        return rel

    def _build_extractor(
        self,
        call_instructions: ExtractionInstructions | None,
        call_prompts: ExtractionPrompts | None,
        schema: Schema | None = None,
        source_id: str | None = None,
    ) -> Extractor:
        if self._extractor is not None:
            return self._extractor
        if self._llm is None:
            from .extraction.basic import NERExtractor

            return NERExtractor()
        return LLMExtractor(
            self._llm,
            prompts=self._prompts,
            instructions=self._instructions,
            call_prompts=call_prompts,
            call_instructions=call_instructions,
            schema=schema if schema is not None else self._schema,
            source_id=source_id,
        )

    async def _apply_facts(
        self,
        facts: Extraction,
        *,
        source_id: str | None,
        parsed_text: str | None,
        media_type: str | None,
        metadata: dict[str, JsonValue] | None,
        default_event_time: datetime | None,
        warnings: list[InsertWarning] | None = None,
        schema: Schema | None = None,
        schema_mode: SchemaMode | None = None,
        resolver: EntityResolver | ResolverMode | None = None,
        contradiction: ContradictionMode | None = None,
        extracted: bool = False,
    ) -> InsertResult:
        created_at = now()
        ns = self.namespace
        warnings = list(warnings or [])
        active_schema = schema if schema is not None else self._schema
        mode = schema_mode if schema_mode is not None else self._schema_mode
        require_schema_mode(mode)
        require_schema_for_mode(mode, active_schema)
        active_resolver = self._resolver if resolver is None else as_resolver(resolver, self._llm)
        conflicts, caps = self._contradiction_for(contradiction, active_schema)

        async def _apply(tx: Any) -> InsertResult:
            _ops._require_datetime("event_time", default_event_time)
            canonical = await _ops.validate_facts(tx, ns, facts, rewrite=lambda o: canonicalize_types(o, active_schema))
            dropped: list[InsertWarning] = []
            if extracted and mode == "strict":
                canonical, dropped = await drop_off_schema(tx, ns, canonical, active_schema)
            max_count = mode == "strict" and conflicts != "off"
            checked = await enforce_schema(tx, ns, canonical, active_schema, mode, max_count=max_count)
            found: list[InsertWarning] = []
            resolution = None
            if active_resolver is not None:
                resolution = await plan_resolution(tx, ns, canonical, active_resolver, active_schema, created_at)
            resolved = resolution.facts if resolution is not None else canonical
            if mode == "strict" and conflicts == "warn":
                await _ops.require_max_count(tx, ns, caps, resolved.relations)
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
                    event_time=default_event_time,
                )

            entities = await _ops.upsert_entities(
                tx, ns, list(resolved.entities), evidence=list(base_evidence), created_at=created_at
            )
            relations = await _ops.upsert_relations(
                tx,
                ns,
                [
                    (
                        rel,
                        _ops.relation_evidence(
                            rel.evidence, base_evidence, source_id=source_id, source_version=source_version
                        ),
                    )
                    for rel in resolved.relations
                ],
                default_event_time=default_event_time,
                created_at=created_at,
                contradiction=conflicts,
                caps=caps,
                warnings=found,
            )

            preferences = [
                await _ops.upsert_preference(tx, ns, pref, default_event_time=default_event_time, created_at=created_at)
                for pref in resolved.preferences
            ]

            decisions = []
            for dec in resolved.decisions:
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

            merges = []
            if resolution is not None:
                merges = await save_merges(tx, ns, resolution, source_id=source_id, created_at=created_at)
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
                entities=_ops.unique_by_id(entities),
                relations=_ops.unique_by_id(relations),
                preferences=_ops.unique_by_id(preferences),
                decisions=_ops.unique_by_id(decisions),
                warnings=[
                    w if w.source_id is not None else w.model_copy(update={"source_id": source_id})
                    for w in (
                        *warnings,
                        *dropped,
                        *checked,
                        *merge_warnings(merges),
                        *(resolution.warnings if resolution is not None else []),
                        *found,
                    )
                ],
                merges=merges,
            )

        return await self._in_tx(_apply)

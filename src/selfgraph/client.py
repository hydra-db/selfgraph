from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

from . import _ops, tiers
from ._serde import aware, now
from .contradiction import judge_contradictions
from .errors import CLOSED_MESSAGE, LLM_HINT, StoreError, TransientError, ValidationError
from .extraction.extractor import DefaultExtractor
from .extraction.prompts import check_prompts
from .ids import _require_namespace
from .insert import Insert
from .llm.base import resolve_llm
from .models import (
    Coverage,
    CypherResult,
    ExtractionInstructions,
    ExtractionPrompts,
    InsertResult,
    InsertWarning,
    JsonValue,
    LLMConfig,
    Ontology,
    RetrievalResult,
    as_input,
    check_options,
)
from .protocols import Embedder, Extractor, GraphStore, LLMClient
from .provenance import record_source
from .resolution import (
    EntityResolver,
    ResolverMode,
    as_resolver,
    merge_warnings,
    plan_resolution,
    require_resolver,
    save_merges,
)
from .resources import Decisions, Entities, Maintenance, Preferences, Relations
from .retrieval import coverage as _coverage
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
        resolver: EntityResolver | ResolverMode | None = None,
        contradiction: ContradictionMode | None = None,
        level: tiers.Level = "balanced",
        max_tier: tiers.Level = "max",
        extraction: tiers.ExtractionTier | None = None,
        seeds: tiers.SeedTier | None = None,
        embedder: Embedder | None = None,
    ) -> None:
        _require_namespace(namespace)
        require_schema_mode(schema_mode)
        tiers.require_level("level", level)
        tiers.require_level("max_tier", max_tier)
        self.store = store
        self.namespace = namespace
        self._llm = resolve_llm(llm)
        if level == "max" and max_tier == "max" and self._llm is None:
            raise ValidationError(f"level 'max' needs an LLM: {LLM_HINT}")
        if embedder is not None and not callable(getattr(embedder, "embed", None)):
            raise ValidationError(f"embedder must have an embed method, got {type(embedder).__name__}")
        self._level: tiers.Level = level
        self._max_tier: tiers.Level = max_tier
        self._embedder = embedder
        self._embeddings: dict[tuple[str, str], tuple[str, list[float]]] = {}
        preset = tiers.PRESETS[level]
        if extraction is not None:
            tiers.require_tier("extraction", extraction)
        elif extractor is None:
            extraction = "llm" if self._llm is not None else preset["extraction"]
        self._extraction = None if extraction is None else tiers.clamp("extraction", extraction, max_tier)
        if self._extraction == "llm" and self._llm is None:
            raise ValidationError(f"extraction 'llm' needs an LLM: {LLM_HINT}")
        if seeds is None:
            seeds = preset["seeds"] if embedder is not None or preset["seeds"] != "embeddings" else "synonyms"
        self._seeds = self._seed_tier(seeds)
        self._strategy = preset["traversal"]
        self._resolver_tier, self._resolver = self._resolver_for(preset["resolution"] if resolver is None else resolver)
        self._contradiction: ContradictionMode = self._contradiction_tier(
            preset["contradiction"] if contradiction is None else contradiction
        )
        self._instructions = as_input(ExtractionInstructions, instructions, "instructions")
        self._prompts = as_input(ExtractionPrompts, prompts, "prompts")
        check_prompts(self._prompts)
        self._extractor = extractor
        self._schema = as_schema(schema)
        require_schema_for_mode(schema_mode, self._schema)
        self._schema_mode: SchemaMode = schema_mode
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

    @property
    def tiers(self) -> dict[str, str]:
        """The level and the tier each capability runs at by default, after the max_tier cap.

        @return (dict[str, str]): the level, the cap, and each capability's default tier.
        """
        return {
            "level": self._level,
            "max_tier": self._max_tier,
            "extraction": self._extraction or "custom",
            "resolution": self._resolver_tier,
            "contradiction": self._contradiction,
            "seeds": self._seeds,
            "traversal": self._strategy,
        }

    def _seed_tier(self, seeds: object) -> str:
        """Validate a seeding tier and lower it to the cost cap.

        @param seeds (object): "bm25", "synonyms", or "embeddings".
        @return (str): the tier to seed with; raises ValidationError for embeddings without an embedder.
        """
        tiers.require_tier("seeds", seeds)
        tier = tiers.clamp("seeds", str(seeds), self._max_tier)
        if tier == "embeddings" and self._embedder is None:
            raise ValidationError("seeds 'embeddings' needs an embedder: pass embedder= to SelfGraph")
        return tier

    def _resolver_for(self, resolver: EntityResolver | ResolverMode) -> tuple[str, EntityResolver | None]:
        """Build a resolver from a mode or an object, lowering a mode to the cost cap.

        @param resolver (EntityResolver | ResolverMode): the mode name or a resolver object.
        @return (tuple[str, EntityResolver | None]): the tier name, "custom" for an object, and the resolver.
        """
        if isinstance(resolver, str):
            require_resolver(resolver)
            tier = tiers.clamp("resolution", resolver, self._max_tier)
            return tier, as_resolver(tier, self._llm)
        return "custom", as_resolver(resolver, self._llm)

    def _contradiction_tier(self, mode: object) -> ContradictionMode:
        """Validate a contradiction mode and lower it to the cost cap.

        @param mode (object): "off", "warn", "supersede", or "llm".
        @return (ContradictionMode): the mode to apply; raises ValidationError for llm without an LLM.
        """
        require_contradiction_mode(mode)
        tier = tiers.clamp("contradiction", str(mode), self._max_tier)
        if tier == "llm" and self._llm is None:
            raise ValidationError(f"contradiction 'llm' needs an LLM: {LLM_HINT}")
        return tier  # type: ignore[return-value]

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
        strategy: str | None = None,
        depth: int = 3,
        k: int = 20,
        max_nodes: int = 200,
        budget_tokens: int = 3000,
        as_of: datetime | str | None = None,
        seeds: tiers.SeedTier | None = None,
    ) -> RetrievalResult:
        """Retrieve graph context for a query via keyword seeds and bounded traversal.

        @param query (str): the natural-language query to seed from.
        @param strategy (str | None): "bfs" or "dfs" traversal order, "ppr" for personalized PageRank ranking, or
            None for the level's default.
        @param depth (int): the maximum number of hops from a seed.
        @param k (int): the maximum number of seed entities.
        @param max_nodes (int): the maximum number of entities to collect.
        @param budget_tokens (int): the assembled-context token budget.
        @param as_of (datetime | str | None): a point in time to read the graph at on the valid-time axis (relations and
            preferences valid then, with their entities; naive means UTC), or None for now.
        @param seeds (SeedTier | None): how to seed: "bm25", "synonyms" to also expand schema synonyms, "embeddings"
            to fuse embedder similarity with BM25, or None for the graph's tier.
        @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
        """
        if not isinstance(query, str):
            raise ValidationError(f"query must be a string, got {type(query).__name__}")
        if not query.strip():
            raise ValidationError("query cannot be empty")
        if strategy is None:
            strategy = self._strategy
        seed_tier = self._seeds if seeds is None else self._seed_tier(seeds)
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
            seeds=seed_tier,
        )

    async def coverage(self, question: str) -> Coverage:
        """Report which words of a question the graph can ground, without an LLM.

        A content word is covered when a schema term names it (an entity type, relation type, or definition, by
        name, alias, or synonym) or when a stored entity's text holds it. Uncovered words mark what the graph
        cannot answer about.

        @param question (str): the natural-language question.
        @return (Coverage): the matched terms, the covered and uncovered words, and the covered share.
        """
        if not isinstance(question, str):
            raise ValidationError(f"question must be a string, got {type(question).__name__}")
        if not question.strip():
            raise ValidationError("question cannot be empty")
        await self._ensure_ready()
        return await _coverage(self, question)

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

    async def _schema_check(self, runner: Any, ontology: Ontology, before: Ontology | None = None) -> None:
        """Check a single entity or relation write against the graph schema, logging warnings in warn mode.

        @param runner (Any): graph runner.
        @param ontology (Ontology): the one entity or relation about to be written.
        @param before (Ontology | None): its stored state for an update, so only new violations count.
        """
        log_schema_warnings(
            await enforce_schema(
                runner, self.namespace, ontology, self._schema, self._schema_mode, cardinality=False, before=before
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
        mode = self._contradiction if contradiction is None else self._contradiction_tier(contradiction)
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
        judged = mode == "llm"
        if judged:
            mode = "supersede"
        if self._schema_mode == "strict" and mode == "warn":
            mode = "strict"
        found: list[InsertWarning] = []

        async def create(tx: Any) -> Any:
            found.clear()
            check = self._schema_check
            rel = await _ops.create_relation(
                tx, self.namespace, **fields, schema_check=check, contradiction=mode, caps=caps, warnings=found
            )
            if judged and self._llm is not None:
                found.extend(await judge_contradictions(tx, self.namespace, self._llm, [rel], caps))
            return rel

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
        if self._extraction != "llm" or self._llm is None:
            from .extraction.basic import BasicExtractor

            return BasicExtractor(engine=self._extraction or "spacy")
        return DefaultExtractor(
            self._llm,
            prompts=self._prompts,
            instructions=self._instructions,
            call_prompts=call_prompts,
            call_instructions=call_instructions,
            schema=schema if schema is not None else self._schema,
            source_id=source_id,
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
        schema: Schema | None = None,
        schema_mode: SchemaMode | None = None,
        resolver: EntityResolver | ResolverMode | None = None,
        contradiction: ContradictionMode | None = None,
        extracted: bool = False,
        extraction: str | None = None,
    ) -> InsertResult:
        created_at = now()
        ns = self.namespace
        warnings = list(warnings or [])
        active_schema = schema if schema is not None else self._schema
        mode = schema_mode if schema_mode is not None else self._schema_mode
        require_schema_mode(mode)
        require_schema_for_mode(mode, active_schema)
        resolver_tier, active_resolver = (
            (self._resolver_tier, self._resolver) if resolver is None else self._resolver_for(resolver)
        )
        conflicts, caps = self._contradiction_for(contradiction, active_schema)
        judged = conflicts == "llm"
        if judged:
            conflicts = "supersede"
        used = {"resolution": resolver_tier, "contradiction": "llm" if judged else conflicts}
        if extraction is not None:
            used = {"extraction": extraction, **used}

        async def _apply(tx: Any) -> InsertResult:
            _ops._require_datetime("event_time", default_event_time)
            canonical = await _ops.validate_ontology(
                tx, ns, ontology, rewrite=lambda o: canonicalize_types(o, active_schema)
            )
            dropped: list[InsertWarning] = []
            if extracted and mode == "strict":
                canonical, dropped = await drop_off_schema(tx, ns, canonical, active_schema)
            max_count = mode == "strict" and conflicts != "off"
            checked = await enforce_schema(tx, ns, canonical, active_schema, mode, max_count=max_count)
            found: list[InsertWarning] = []
            resolution = None
            if active_resolver is not None:
                resolution = await plan_resolution(tx, ns, canonical, active_resolver, active_schema, created_at)
            resolved = resolution.ontology if resolution is not None else canonical
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
            if judged and self._llm is not None:
                fresh = [r for r in relations if r.created_at == created_at]
                found.extend(await judge_contradictions(tx, ns, self._llm, fresh, caps))

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
                tiers=used,
            )

        return await self._in_tx(_apply)

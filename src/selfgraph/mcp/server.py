from __future__ import annotations

import functools
import inspect
import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any, Literal

from pydantic import NonNegativeInt, PositiveInt, StrictBool, create_model
from pydantic import ValidationError as PydanticValidationError
from pydantic_core import core_schema

from ..client import SelfGraph
from ..errors import SelfGraphError, ValidationError, surface_hint
from ..models import Stance, Status, check_options, validation_message
from ..resources._common import DEFAULT_PAGE_LIMIT
from ..runtime import (
    _BLANK,
    _PARAM_REF,
    DECISION_CLEARABLE,
    PREFERENCE_CLEARABLE,
    GraphSettings,
    bind_params,
    blank_lexical_tokens,
    build_graph,
    check_settings,
    current_relation,
    parse_time,
    present,
    require_changes,
    settings_from_env,
    surfaced,
    to_jsonable,
)
from ..schema import ContradictionMode, SchemaMode

__all__ = ["configure", "close", "build_server", "run_stdio", "TOOLS"]

_settings: GraphSettings | None = None
_graph: SelfGraph | None = None

_WRITE_CLAUSE = re.compile(
    r"\b(CREATE|INSERT|MERGE|DELETE|DETACH|SET|REMOVE|DROP|ALTER|RENAME|TRUNCATE|FOREACH|COPY|LOAD|IMPORT|"
    r"EXPORT|INSTALL|UNINSTALL|ATTACH|USE|CALL|COMMENT|BEGIN|COMMIT|ROLLBACK|CHECKPOINT|GRANT|REVOKE|DENY|"
    r"TERMINATE)\b",
    re.IGNORECASE,
)
_UNICODE_ESCAPE = re.compile(r"(?<!\\)(?:\\\\)*\\[uU]")
_MAP_KEY = re.compile(r"([{,]\s*)[A-Za-z_]\w*(\s*:)")
_PROP_OR_LABEL = re.compile(r"[.:]\s*\w+")
_READ_OPENERS = re.compile(r"(MATCH|OPTIONAL|WITH|UNWIND|RETURN|SHOW|EXPLAIN|PROFILE)\b", re.IGNORECASE)
_LEADING_BLANK = re.compile(r"^[\s\x00]+")


def _is_blocked_query(query: str) -> bool:
    """Report whether a raw Cypher query is a write, schema, transaction, or admin statement run_cypher must reject.

    Literals, comments, params, map keys, and property or label accesses are blanked first, so a bare reserved
    word in those positions does not read as a clause. Aliases are not blanked: the word after AS can be a
    variable named 'as' followed by a real clause, so a write keyword used as an alias must be backtick-quoted.
    Blanking can only hide a keyword that was never executable, so it over-blocks an exotic read at worst.

    A query is blocked when it holds a unicode escape anywhere (Neo4j decodes them before lexing, so one can
    spell a keyword or close a literal or comment the guard blanked), when a backslash or a write or schema
    clause appears outside literals, or when any ';'-separated statement does not begin with a known read
    opener. The opener check rejects every statement-initial admin, transaction, or DDL command (ANALYZE, FREE,
    STORAGE, and so on) without enumerating each engine's admin vocabulary.

    @param query (str): the raw Cypher statement.
    @return (bool): True when the query must be rejected as not read-only.
    """
    if _UNICODE_ESCAPE.search(query):
        return True
    stripped = _PARAM_REF.sub(_BLANK, blank_lexical_tokens(query))
    stripped = _PROP_OR_LABEL.sub(" ", _MAP_KEY.sub(r"\1\2", stripped))
    if "\\" in stripped or _WRITE_CLAUSE.search(stripped):
        return True
    heads = (_LEADING_BLANK.sub("", statement) for statement in stripped.split(";"))
    return any(head and _READ_OPENERS.match(head) is None for head in heads)


def _tool(fn: Callable[..., Awaitable[Any]], tool_error: type[Exception]) -> Callable[..., Awaitable[Any]]:
    """Wrap a tool so any error fails the call with the error type and message, flagged as an MCP error, and a
    null or list result is sent as one JSON text content alongside the structured result.

    @param fn (Callable[..., Awaitable[Any]]): the tool coroutine to wrap.
    @param tool_error (type[Exception]): the SDK's ToolError, which the server reports with the error flag set.
    @return (Callable[..., Awaitable[Any]]): the wrapped tool.
    """

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            result = await fn(*args, **kwargs)
        except SelfGraphError as exc:
            raise tool_error(f"{type(exc).__name__}: {surface_hint(str(exc))}") from exc
        except Exception as exc:  # noqa: BLE001
            raise tool_error(f"InternalError: {type(exc).__name__}: {exc}") from exc
        if result is None or isinstance(result, list):
            from mcp.types import CallToolResult

            text = json.dumps(result, indent=2, ensure_ascii=False)
            return CallToolResult.model_validate(
                {"content": [{"type": "text", "text": text}], "structuredContent": {"result": result}}
            )
        return result

    return wrapper


class _Unset:
    @classmethod
    def __get_pydantic_core_schema__(cls, source: Any, handler: Any) -> core_schema.CoreSchema:
        """Describe the sentinel as null, so a tool schema advertises the same null default as a None default.

        @param source (Any): the annotated source type.
        @param handler (Any): pydantic's schema handler.
        @return (core_schema.CoreSchema): a null schema that serializes the sentinel as null.
        """
        return core_schema.none_schema(serialization=core_schema.plain_serializer_function_ser_schema(lambda _: None))


_UNSET: Any = _Unset()


def configure(settings: GraphSettings | None = None) -> None:
    """Set the backend for the tools and drop any cached graph.

    @param settings (GraphSettings | None): the backend settings, or None to read the environment.
    """
    global _settings, _graph
    _settings = settings or settings_from_env()
    _graph = None


async def close() -> None:
    """Close the cached graph, if one is open; the next tool call reopens it.

    @return (None): nothing.
    """
    global _graph
    graph, _graph = _graph, None
    if graph is not None:
        await graph.close()


async def _graph_handle() -> SelfGraph:
    """Return the shared graph, opening and initialising it on first use.

    No lock is taken: an MCP server runs one event loop, so at worst a rare
    concurrent first call builds a second graph and the first assignment wins.

    @return (SelfGraph): the shared, initialised graph.
    """
    global _graph
    if _graph is None:
        if _settings is None:
            configure()
        graph = build_graph(_settings)  # type: ignore[arg-type]
        await graph.initialize()
        if _graph is None:
            _graph = graph
    return _graph


async def get_schema(format: Literal["selfgraph", "neo4j"] = "selfgraph") -> dict[str, Any] | None:
    """Return the schema inserts are checked against (entity and relation types), or null when none is set.
    format "neo4j" renders it as a Neo4j graph schema (node_types, relationship_types, patterns, constraints)."""
    g = await _graph_handle()
    if format == "neo4j" and g.schema is not None:
        return g.schema.to_neo4j_ontology()
    return to_jsonable(g.schema)


async def insert_text(
    text: str,
    source_id: str | None = None,
    event_time: str | None = None,
    metadata: dict | None = None,
    resolver: str | None = None,
    contradiction: ContradictionMode | None = None,
    schema: dict | None = None,
    schema_mode: SchemaMode | None = None,
    instructions: dict | None = None,
    prompts: dict | None = None,
) -> dict[str, Any]:
    """Extract facts from text and merge them into the graph. Uses the configured LLM, or with none
    configured falls back to a built-in LLM-free extractor (coarser). event_time (ISO 8601) is the default
    valid time for what is extracted; metadata is stored on the source.

    Idempotent: ids are derived deterministically from content, so re-inserting the
    same text converges on the same graph instead of duplicating it. Safe to retry. resolver (exact, default,
    fuzzy, or llm) overrides the server's entity resolution for this call. contradiction (off, warn, supersede)
    overrides how a relation that breaks a schema max_count is handled. schema (a SelfGraph schema object) and
    schema_mode (off, warn, strict) override the server's for this call. instructions and prompts override the
    extraction instructions and prompt templates for this call.
    """
    g = await _graph_handle()
    return to_jsonable(
        surfaced(
            await g.insert.text(
                text,
                source_id=source_id,
                event_time=parse_time(event_time, "event_time"),
                metadata=metadata,
                resolver=resolver,
                contradiction=contradiction,
                schema=schema,
                schema_mode=schema_mode,
                instructions=instructions,
                prompts=prompts,
            )
        )
    )


async def insert_facts(
    facts: dict,
    source_id: str | None = None,
    event_time: str | None = None,
    resolver: str | None = None,
    contradiction: ContradictionMode | None = None,
    schema: dict | None = None,
    schema_mode: SchemaMode | None = None,
) -> dict[str, Any]:
    """Merge ready facts (entities/relations/preferences/decisions) in one call.

    Every write is an idempotent upsert keyed by deterministic id, so re-sending the
    same facts never duplicates data. Entity ids are 'type:name' (e.g. 'person:jane');
    omit an id to have it derived. Prefer this over the create_* tools for bulk writes
    and for anything you may retry. References are validated before any write; the batch
    is atomic on transactional backends (Neo4j, Memgraph), while auto-commit backends
    (HydraDB, Kuzu, FalkorDB) apply writes incrementally, so a mid-batch failure can
    leave earlier writes in place. Re-sending the same facts reconciles the graph. event_time (ISO 8601) is the
    default valid time for relations, preferences, and decisions that carry none of their own. resolver (exact, default,
    fuzzy, or llm) overrides the server's entity resolution for this call; each merge is in the result's merges.
    contradiction (off, warn, supersede) overrides how a relation that breaks a schema max_count is handled:
    warn keeps both and reports it, supersede retires the older relation. schema (a SelfGraph schema object) and
    schema_mode (off, warn, strict) override the server's for this call.
    """
    at = parse_time(event_time, "event_time")
    g = await _graph_handle()
    return to_jsonable(
        surfaced(
            await g.insert.facts(
                facts,
                source_id=source_id,
                event_time=at,
                resolver=resolver,
                contradiction=contradiction,
                schema=schema,
                schema_mode=schema_mode,
            )
        )
    )


async def create_entity(
    name: str,
    type: str,
    id: str | None = None,
    aliases: list[str] | None = None,
    external_ids: dict | None = None,
    properties: dict | None = None,
) -> dict[str, Any]:
    """Create an entity (node). Ids are deterministic 'type:name' (e.g. 'person:jane');
    omit id to derive one from type and name. This is a strict create and conflicts if
    the id already exists; use insert_facts to upsert idempotently instead."""
    g = await _graph_handle()
    return to_jsonable(
        await g.entities.create(name, type, id=id, aliases=aliases, external_ids=external_ids, properties=properties)
    )


async def get_entity(id: str) -> dict[str, Any] | None:
    """Fetch one entity by id, or null if it does not exist."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.get(id))


async def list_entities(
    type: str | None = None, name: str | None = None, limit: int = DEFAULT_PAGE_LIMIT, cursor: str | None = None
) -> dict[str, Any]:
    """List entities, optionally filtered by type and/or name (an exact, case-sensitive match on the current name).
    Paged via next_cursor."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.list(type=type, name=name, limit=limit, cursor=cursor))


async def entity_evidence(id: str, limit: int = DEFAULT_PAGE_LIMIT, cursor: str | None = None) -> dict[str, Any]:
    """List the evidence (source, version, chunk, quote, offsets, confidence) supporting an entity. Paged via
    next_cursor."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.evidence(id, limit=limit, cursor=cursor))


async def entity_merges(id: str, limit: int = DEFAULT_PAGE_LIMIT, cursor: str | None = None) -> dict[str, Any]:
    """List the merge records of entities that entity resolution folded into this entity: the absorbed input,
    reason, confidence, added aliases, and rewritten references. Paged via next_cursor."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.merges(id, limit=limit, cursor=cursor))


async def unmerge_entity(merge_id: str) -> dict[str, Any]:
    """Reverse one merge by merge id: recreate the absorbed entity, drop the aliases it added to the survivor,
    and move its relations, preferences, and decisions back."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.unmerge(merge_id))


async def update_entity(
    id: str,
    name: str | None = None,
    type: str | None = None,
    aliases: list[str] | None = None,
    external_ids: dict | None = None,
    properties: dict | None = None,
    remove_aliases: list[str] | None = None,
    remove_properties: list[str] | None = None,
) -> dict[str, Any]:
    """Update an entity. aliases/properties/external_ids merge in; remove_aliases/remove_properties drop keys.
    type can change only its case or spacing (the type is part of the id)."""
    g = await _graph_handle()
    fields = present(
        name=name,
        type=type,
        aliases=aliases,
        external_ids=external_ids,
        properties=properties,
        remove_aliases=remove_aliases,
        remove_properties=remove_properties,
    )
    return to_jsonable(await g.entities.update(id, **fields))


async def delete_entity(id: str) -> dict[str, Any]:
    """Delete an entity, its relations, and any decision trace that references it."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.delete(id))


async def create_relation(
    from_entity: str,
    type: str,
    to_entity: str,
    id: str | None = None,
    properties: dict | None = None,
    event_time: str | None = None,
    contradiction: ContradictionMode | None = None,
    evidence: list[dict] | None = None,
) -> dict[str, Any]:
    """Create a directed, versioned relationship between two entities. from_entity and
    to_entity are existing entity ids ('type:name'); create the entities first. The type
    normalizes to UPPER_SNAKE, so 'works at' and 'WORKS_AT' are the same relation.
    event_time (ISO 8601) is when the fact became true. Creating a relation a contradiction
    invalidated reasserts it. contradiction (off, warn, supersede) overrides how a schema
    max_count conflict is handled. evidence lists records {source_id, chunk_id?, quote?, start_offset?,
    end_offset?, confidence?} supporting it."""
    g = await _graph_handle()
    return to_jsonable(
        await g.relations.create(
            from_entity,
            type,
            to_entity,
            id=id,
            properties=properties,
            event_time=parse_time(event_time, "event_time"),
            contradiction=contradiction,
            evidence=evidence or (),
        )
    )


async def get_relation(id: str) -> dict[str, Any] | None:
    """Fetch the current version of a relationship by id, or null for an unknown id. A relationship a
    contradiction retired fails with the relation that retired it; read it with relation_versions."""
    g = await _graph_handle()
    hint = "use relation_versions or list_relations with include_invalidated"
    return to_jsonable(await current_relation(g, id, hint))


async def list_relations(
    from_entity: str | None = None,
    type: str | None = None,
    to_entity: str | None = None,
    limit: int = DEFAULT_PAGE_LIMIT,
    cursor: str | None = None,
    include_invalidated: StrictBool = False,
) -> dict[str, Any]:
    """List current relationships, optionally filtered by endpoints and/or type. include_invalidated also lists
    relationships a contradiction retired, with invalidated_at and invalidated_by set."""
    g = await _graph_handle()
    return to_jsonable(
        await g.relations.list(
            from_entity=from_entity,
            type=type,
            to_entity=to_entity,
            limit=limit,
            cursor=cursor,
            include_invalidated=include_invalidated,
        )
    )


async def update_relation(
    id: str,
    set_properties: dict | None = None,
    remove_properties: list[str] | None = None,
    event_time: str | None = None,
    evidence: list[dict] | None = None,
) -> dict[str, Any]:
    """Create a new version of a relationship with changed properties; remove_properties ignores keys that are
    absent. event_time (ISO 8601) is when the new version became true; omit it to keep the current one. evidence
    lists records {source_id, chunk_id?, quote?, start_offset?, end_offset?, confidence?} to add; existing evidence
    is kept."""
    changes = require_changes(
        present(
            set_properties=set_properties,
            remove_properties=remove_properties,
            event_time=parse_time(event_time, "event_time"),
            evidence=evidence,
        )
    )
    g = await _graph_handle()
    return to_jsonable(await g.relations.update(id, **changes))


async def relation_versions(id: str, newest_first: StrictBool = True) -> list[dict[str, Any]]:
    """Return every version of a relationship, newest first by default."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.versions(id, newest_first=newest_first))


async def relation_evidence(id: str, limit: int = DEFAULT_PAGE_LIMIT, cursor: str | None = None) -> dict[str, Any]:
    """List the evidence (source, version, chunk, quote, offsets, confidence) supporting a relationship across all
    its versions. Paged via next_cursor."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.evidence(id, limit=limit, cursor=cursor))


async def delete_relation(id: str) -> dict[str, Any]:
    """Delete a relationship, all of its versions, and any decision trace that uses it as a step."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.delete(id))


async def create_preference(
    subject_entity: str,
    key: str,
    value_entity: str,
    stance: Stance = "preference",
    id: str | None = None,
    about_entity: str | None = None,
    strength: float | None = None,
    properties: dict | None = None,
    event_time: str | None = None,
) -> dict[str, Any]:
    """Record that an entity prefers or avoids a value (stance: preference|disinterest).
    Omit id to derive one; a manual id must start with 'preference:'. event_time (ISO 8601)
    is when the preference became true."""
    g = await _graph_handle()
    return to_jsonable(
        await g.preferences.create(
            subject_entity,
            key,
            value_entity,
            id=id,
            stance=stance,
            about_entity=about_entity,
            strength=strength,
            properties=properties,
            event_time=parse_time(event_time, "event_time"),
        )
    )


async def list_preferences(
    subject_entity: str | None = None,
    key: str | None = None,
    stance: Stance | None = None,
    limit: int = DEFAULT_PAGE_LIMIT,
    cursor: str | None = None,
) -> dict[str, Any]:
    """List current preferences, optionally scoped to one subject entity. Paged via next_cursor."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.list(subject_entity, key=key, stance=stance, limit=limit, cursor=cursor))


async def preference_versions(id: str, newest_first: StrictBool = True) -> list[dict[str, Any]]:
    """Return every version of a preference, newest first by default."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.versions(id, newest_first=newest_first))


async def update_preference(
    id: str,
    strength: float | None = None,
    properties: dict | None = None,
    remove_properties: list[str] | None = None,
    event_time: str | None = None,
    clear: list[Literal[PREFERENCE_CLEARABLE]] | None = None,  # type: ignore[valid-type]
) -> dict[str, Any]:
    """Update a preference (new version). properties merge in; remove_properties drop keys. event_time
    (ISO 8601) is when the new version became true; omit it to keep the current one. clear lists fields to
    clear: strength, about_entity, event_time."""
    changes = require_changes(
        present(
            strength=strength,
            properties=properties,
            remove_properties=remove_properties,
            event_time=parse_time(event_time, "event_time"),
            clear=clear or None,
        )
    )
    g = await _graph_handle()
    return to_jsonable(await g.preferences.update(id, **changes))


async def get_preference(id: str) -> dict[str, Any] | None:
    """Fetch the current version of a preference by id, or null."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.get(id))


async def delete_preference(id: str) -> dict[str, Any]:
    """Delete a preference and all of its versions."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.delete(id))


async def create_decision(
    title: str,
    steps: list[str] | None = None,
    id: str | None = None,
    actor_entity: str | None = None,
    summary: str | None = None,
    rationale: str | None = None,
    outcome_entity: str | None = None,
    alternative_entities: list[str] | None = None,
    status: Status = "completed",
    event_time: str | None = None,
) -> dict[str, Any]:
    """Record a decision trace. steps (optional, default empty) are ids of relations that already exist (relation:...,
    from create_relation or list_relations), in order; they are the path that led to the outcome.
    event_time (ISO 8601) is when the decision was made."""
    g = await _graph_handle()
    return to_jsonable(
        await g.decisions.create(
            title,
            steps=steps or [],
            id=id,
            actor_entity=actor_entity,
            summary=summary,
            rationale=rationale,
            outcome_entity=outcome_entity,
            alternative_entities=alternative_entities or (),
            status=status,
            event_time=parse_time(event_time, "event_time"),
        )
    )


async def update_decision(
    id: str,
    title: str | None = None,
    steps: list[str] | None = None,
    actor_entity: str | None = _UNSET,
    summary: str | None = _UNSET,
    rationale: str | None = _UNSET,
    outcome_entity: str | None = _UNSET,
    alternative_entities: list[str] | None = None,
    status: Status | None = None,
    event_time: str | None = _UNSET,
    clear: list[Literal[DECISION_CLEARABLE]] | None = None,  # type: ignore[valid-type]
) -> dict[str, Any]:
    """Update fields of a decision trace in place; it keeps no version history. An omitted field keeps its
    value; an explicit null clears actor_entity, summary, rationale, outcome_entity, or event_time (ISO 8601),
    and steps [] empties the steps. clear lists fields to clear the same way, alternative_entities and steps
    to []."""
    g = await _graph_handle()
    nullable = {
        "actor_entity": actor_entity,
        "summary": summary,
        "rationale": rationale,
        "outcome_entity": outcome_entity,
        "event_time": event_time if event_time is _UNSET else parse_time(event_time, "event_time"),
    }
    fields = present(
        title=title, steps=steps, alternative_entities=alternative_entities, status=status, clear=clear or None
    )
    fields.update({k: v for k, v in nullable.items() if v is not _UNSET})
    return to_jsonable(await g.decisions.update(id, **require_changes(fields)))


async def delete_decision(id: str) -> dict[str, Any]:
    """Delete a decision trace and its steps."""
    g = await _graph_handle()
    return to_jsonable(await g.decisions.delete(id))


async def get_decision(id: str) -> dict[str, Any] | None:
    """Fetch one decision trace by id, or null."""
    g = await _graph_handle()
    return to_jsonable(await g.decisions.get(id))


async def list_decisions(
    actor_entity: str | None = None,
    status: Status | None = None,
    limit: int = DEFAULT_PAGE_LIMIT,
    cursor: str | None = None,
) -> dict[str, Any]:
    """List decision traces, optionally filtered by actor and/or status."""
    g = await _graph_handle()
    return to_jsonable(await g.decisions.list(actor_entity=actor_entity, status=status, limit=limit, cursor=cursor))


async def run_cypher(query: str, params: dict | None = None) -> dict[str, Any]:
    """Run a read Cypher statement and return its rows; a keyword scan rejects writes but is a guard, not a sandbox.
    Not scoped to the namespace: it sees every namespace on the server, so filter on the ns property yourself."""
    if not isinstance(query, str):
        raise ValidationError(f"query must be a string, got {type(query).__name__}")
    if _is_blocked_query(query):
        raise ValidationError(
            "run_cypher is read-only: it runs a single read that begins with MATCH, OPTIONAL MATCH, WITH, "
            "UNWIND, RETURN, SHOW, EXPLAIN, or PROFILE and contains no write, schema, transaction, or I/O "
            "clause (CREATE, INSERT, MERGE, SET, DELETE, DETACH, REMOVE, DROP, ALTER, RENAME, TRUNCATE, FOREACH, "
            "CALL, LOAD, COPY, IMPORT, EXPORT, INSTALL, UNINSTALL, ATTACH, USE, COMMENT, GRANT, REVOKE, DENY, and "
            "transaction or admin commands such as BEGIN, COMMIT, TERMINATE), even as a bare alias or variable "
            "name (backtick-quote it), and no unicode escape (pass such text as a parameter). Use the typed "
            "resources or insert for writes."
        )
    bound = bind_params(query, params)
    g = await _graph_handle()
    return to_jsonable(await g.run_cypher(query, bound))


async def retrieve(
    query: str,
    strategy: str = "bfs",
    depth: NonNegativeInt = 3,
    k: PositiveInt = 20,
    max_nodes: PositiveInt = 200,
    budget_tokens: PositiveInt = 3000,
    as_of: str | None = None,
) -> dict[str, Any]:
    """Retrieve graph context for a query by keyword seeds and bounded BFS, DFS, or PageRank ("ppr") ranking.
    as_of (ISO 8601; no offset means UTC) reads the graph as it stood at that time."""
    g = await _graph_handle()
    return to_jsonable(
        await g.retrieve(
            query,
            strategy=strategy,
            depth=depth,
            k=k,
            max_nodes=max_nodes,
            budget_tokens=budget_tokens,
            as_of=parse_time(as_of, "as_of"),
        )
    )


async def maintenance_decay(
    half_life_days: float = 30, now: str | None = None, dry_run: StrictBool = True
) -> dict[str, Any]:
    """Score every entity and current relation by recency (half-life decay from its latest timestamp) and
    frequency (sources, plus degree for entities) and store it as relevance, without a new version. Never
    deletes. now (ISO 8601) defaults to the current time. Dry run by default: returns the scores; pass
    dry_run false to write them."""
    g = await _graph_handle()
    at = parse_time(now, "now")
    return to_jsonable(await g.maintenance.decay(half_life_days=half_life_days, now=at, dry_run=dry_run))


async def maintenance_prune(
    min_relevance: float | None = None,
    older_than: str | None = None,
    types: list[str] | None = None,
    relation_types: list[str] | None = None,
    dry_run: StrictBool = True,
) -> dict[str, Any]:
    """Remove entities and relations below min_relevance (set by maintenance_decay) and/or last touched
    before older_than (ISO 8601); types narrows entities and relation_types relations (given only one, the other
    kind is not matched). Needs min_relevance or older_than. Dry run by default: returns the plan; pass dry_run
    false to delete, which cascades like delete_entity."""
    g = await _graph_handle()
    cutoff = parse_time(older_than, "older_than")
    result = await g.maintenance.prune(
        min_relevance=min_relevance,
        older_than=cutoff,
        types=types,
        relation_types=relation_types,
        dry_run=dry_run,
    )
    return to_jsonable(surfaced(result))


async def maintenance_dedupe_relations(dry_run: StrictBool = True) -> dict[str, Any]:
    """Merge parallel current relations with the same endpoints and type but different ids into the lowest
    id: properties merge (survivor wins), evidence and decision steps move over, duplicates are deleted.
    Dry run by default: returns the groups; pass dry_run false to merge."""
    g = await _graph_handle()
    return to_jsonable(await g.maintenance.dedupe_relations(dry_run=dry_run))


TOOLS = [
    get_schema,
    insert_text,
    insert_facts,
    create_entity,
    get_entity,
    list_entities,
    entity_evidence,
    entity_merges,
    unmerge_entity,
    update_entity,
    delete_entity,
    create_relation,
    get_relation,
    list_relations,
    update_relation,
    relation_versions,
    relation_evidence,
    delete_relation,
    create_preference,
    list_preferences,
    preference_versions,
    update_preference,
    get_preference,
    delete_preference,
    create_decision,
    update_decision,
    delete_decision,
    get_decision,
    list_decisions,
    run_cypher,
    retrieve,
    maintenance_decay,
    maintenance_prune,
    maintenance_dedupe_relations,
]


_READ_ONLY = frozenset(
    {"get_schema", "retrieve", "run_cypher", "entity_evidence", "entity_merges", "relation_evidence"}
)
_DESTRUCTIVE = frozenset({"maintenance_prune", "maintenance_dedupe_relations"})
_IDEMPOTENT = frozenset({"insert_facts", "maintenance_prune", "maintenance_dedupe_relations"})


def _annotations(name: str) -> dict[str, bool]:
    """The MCP behavior hints for a tool: read-only, destructive, and idempotent.

    @param name (str): the tool name.
    @return (dict[str, bool]): readOnlyHint for a read, else destructiveHint and idempotentHint.
    """
    if name in _READ_ONLY or name.startswith(("get_", "list_")) or name.endswith("_versions"):
        return {"readOnlyHint": True}
    destructive = name.startswith("delete_") or name in _DESTRUCTIVE
    return {"destructiveHint": destructive, "idempotentHint": name.startswith("delete_") or name in _IDEMPOTENT}


def _server_class():
    """The MCP server and tool-error classes across SDK versions: MCPServer (mcp >= 2) or FastMCP (mcp 1.x).

    @return (tuple[type, type[Exception]]): the server class and its ToolError.
    """
    try:
        from mcp.server.mcpserver import MCPServer
        from mcp.server.mcpserver.exceptions import ToolError

        return MCPServer, ToolError
    except ImportError:
        pass
    try:
        from mcp.server.fastmcp import FastMCP
        from mcp.server.fastmcp.exceptions import ToolError

        return FastMCP, ToolError
    except ImportError as exc:  # pragma: no cover - optional dep
        raise RuntimeError(
            "the 'mcp' package is required to run the MCP server; pip install \"selfgraph[mcp]\""
        ) from exc


class _ArgumentError(PydanticValidationError):
    def __str__(self) -> str:
        return self.title


def _check_arguments(server: Any, name: str) -> None:
    """Make a registered tool reject undeclared argument names and report bad arguments as "path: message" lines.

    The replacement still raises a pydantic ValidationError, which the SDK reports as a tool error with its text.

    @param server (Any): the MCP server holding the tool.
    @param name (str): the tool name.
    @return (None): nothing; the tool's argument model is replaced in place.
    """
    tool = server._tool_manager.get_tool(name)
    model = tool.fn_metadata.arg_model
    allowed = [field.alias or key for key, field in model.model_fields.items()]

    def validate(cls: Any, obj: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            if isinstance(obj, dict):
                check_options(name, obj, allowed)
            return super(checked, cls).model_validate(obj, *args, **kwargs)
        except ValidationError as exc:
            message = str(exc)
        except PydanticValidationError as exc:
            message = validation_message("invalid arguments", exc)
        raise _ArgumentError.from_exception_data(f"ValidationError: {message}", [])

    checked = create_model(model.__name__, __base__=model)
    checked.model_validate = classmethod(validate)  # type: ignore[method-assign]
    tool.fn_metadata.arg_model = checked


def build_server(name: str = "selfgraph"):
    """Create an MCP server with every tool registered. Requires selfgraph[mcp].

    @param name (str): the server name.
    @return (MCPServer | FastMCP): the server.
    """
    from .. import __version__

    server_class, tool_error = _server_class()
    if "version" in inspect.signature(server_class).parameters:
        server = server_class(name, version=__version__, log_level="WARNING")
    else:
        server = server_class(name, log_level="WARNING")
        server._mcp_server.version = __version__
    logging.getLogger("mcp").setLevel(logging.WARNING)
    options = inspect.signature(server.tool).parameters
    for fn in TOOLS:
        kwargs: dict[str, Any] = {"structured_output": True} if "structured_output" in options else {}
        if "annotations" in options:
            from mcp.types import ToolAnnotations

            kwargs["annotations"] = ToolAnnotations(**_annotations(fn.__name__))
        server.tool(**kwargs)(_tool(fn, tool_error))
        _check_arguments(server, fn.__name__)
    return server


def run_stdio(settings: GraphSettings | None = None) -> None:
    """Configure the backend and serve the tools over stdio (blocks).

    @param settings (GraphSettings | None): the backend settings, or None to read the environment.
    """
    configure(check_settings(settings or settings_from_env()))
    build_server().run()

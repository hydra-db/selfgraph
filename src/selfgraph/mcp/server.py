from __future__ import annotations

import functools
import inspect
import re
from collections.abc import Awaitable, Callable
from typing import Any

from ..client import SelfGraph
from ..errors import SelfGraphError, ValidationError
from ..runtime import GraphSettings, build_graph, settings_from_env, to_jsonable

__all__ = ["configure", "build_server", "run_stdio", "TOOLS"]

_settings: GraphSettings | None = None
_graph: SelfGraph | None = None

_WRITE_CLAUSE = re.compile(
    r"\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|ALTER|RENAME|TRUNCATE|FOREACH|COPY|LOAD|IMPORT|EXPORT|"
    r"INSTALL|UNINSTALL|ATTACH|USE|CALL|COMMENT|BEGIN|COMMIT|ROLLBACK|CHECKPOINT|GRANT|REVOKE|DENY)\b",
    re.IGNORECASE,
)
_ALIAS = re.compile(r"\bAS\s+\w+", re.IGNORECASE)
_MAP_KEY = re.compile(r"([{,]\s*)[A-Za-z_]\w*(\s*:)")
_PROP_OR_LABEL = re.compile(r"[.:]\s*\w+")
_PARAM = re.compile(r"\$\w+")
_READ_OPENERS = re.compile(r"(MATCH|OPTIONAL|WITH|UNWIND|RETURN|SHOW|EXPLAIN|PROFILE)\b", re.IGNORECASE)
_LEADING_BLANK = re.compile(r"^[\s\x00]+")
_LINE_TERMINATORS = frozenset("\n\r\x0b\x0c\x1c\x1d\x1e\x85  ")
_BLANK = "\x00"


def _blank_lexical_tokens(query: str) -> str:
    """Blank string literals, backtick identifiers, and comments with one char scan that matches engine lexing.

    Quoted strings use backslash escaping; a backtick identifier escapes a backtick by doubling it; a line
    comment ends at any engine line terminator (not only newline); a block comment ends at the first '*/'. An
    unterminated token leaves the rest of the query visible so a hidden write keyword is still scanned, which
    makes the guard fail closed rather than desynchronise on a mis-modelled token boundary.

    @param query (str): the raw Cypher statement.
    @return (str): the query with lexical tokens replaced by spaces.
    """
    out: list[str] = []
    i, n = 0, len(query)
    while i < n:
        ch = query[i]
        if ch in "'\"":
            j = i + 1
            while j < n:
                if query[j] == "\\":
                    j += 2
                    continue
                if query[j] == ch:
                    j += 1
                    break
                j += 1
            else:
                break
            out.append(_BLANK)
            i = j
        elif ch == "`":
            j = i + 1
            while j < n:
                if query[j] == "`":
                    if j + 1 < n and query[j + 1] == "`":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            else:
                break
            out.append(_BLANK)
            i = j
        elif ch == "/" and i + 1 < n and query[i + 1] == "*":
            end = query.find("*/", i + 2)
            if end == -1:
                break
            out.append(_BLANK)
            i = end + 2
        elif ch == "/" and i + 1 < n and query[i + 1] == "/":
            j = i + 2
            while j < n and query[j] not in _LINE_TERMINATORS:
                j += 1
            out.append(_BLANK)
            i = j
        else:
            out.append(ch)
            i += 1
    if i < n:
        out.append(query[i:])
    return "".join(out)


def _strip_safe_tokens(query: str) -> str:
    """Blank keyword-safe tokens (literals, comments, aliases, map keys, properties, labels) before the write scan.

    Lexical tokens are blanked by a char scan that matches engine lexing exactly; aliases, map keys, and
    property or label accesses are then blanked so a bare reserved word in those positions does not read as a
    clause. Blanking can only hide a keyword that was never executable, so it over-blocks an exotic read at
    worst and never lets a real write slip through.

    @param query (str): the raw Cypher statement.
    @return (str): the query with keyword-safe tokens blanked so the write scan sees only clause keywords.
    """
    q = _blank_lexical_tokens(query)
    q = _PARAM.sub(_BLANK, q)
    q = _ALIAS.sub(" ", q)
    q = _MAP_KEY.sub(r"\1\2", q)
    return _PROP_OR_LABEL.sub(" ", q)


def _is_blocked_query(query: str) -> bool:
    """Report whether a raw Cypher query is a write, schema, transaction, or admin statement run_cypher must reject.

    A query is blocked when a write or schema clause appears anywhere, or when its first significant token is
    not a known read opener. The opener check rejects every statement-initial admin, transaction, or DDL command
    (TERMINATE, ANALYZE, FREE, STORAGE, BEGIN, and so on) without enumerating each engine's admin vocabulary.

    @param query (str): the raw Cypher statement.
    @return (bool): True when the query must be rejected as not read-only.
    """
    stripped = _strip_safe_tokens(query)
    if _WRITE_CLAUSE.search(stripped):
        return True
    head = _LEADING_BLANK.sub("", stripped)
    return bool(head) and _READ_OPENERS.match(head) is None


def _tool(fn: Callable[..., Awaitable[Any]], tool_error: type[Exception]) -> Callable[..., Awaitable[Any]]:
    """Wrap a tool so any error fails the call with the error type and message, flagged as an MCP error.

    @param fn (Callable[..., Awaitable[Any]]): the tool coroutine to wrap.
    @param tool_error (type[Exception]): the SDK's ToolError, which the server reports with the error flag set.
    @return (Callable[..., Awaitable[Any]]): the wrapped tool.
    """

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return await fn(*args, **kwargs)
        except SelfGraphError as exc:
            raise tool_error(f"{type(exc).__name__}: {exc}") from exc
        except Exception as exc:  # noqa: BLE001
            raise tool_error(f"InternalError: {type(exc).__name__}: {exc}") from exc

    return wrapper


def configure(settings: GraphSettings | None = None) -> None:
    """Set the backend for the tools and drop any cached graph.

    @param settings (GraphSettings | None): the backend settings, or None to read the environment.
    """
    global _settings, _graph
    _settings = settings or settings_from_env()
    _graph = None


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


async def insert_text(text: str, source_id: str | None = None) -> dict[str, Any]:
    """Extract an ontology from text and merge it into the graph. Needs an LLM.

    Idempotent: ids are derived deterministically from content, so re-inserting the
    same text converges on the same graph instead of duplicating it. Safe to retry.
    """
    g = await _graph_handle()
    return to_jsonable(await g.insert.text(text, source_id=source_id))


async def insert_ontology(ontology: dict, source_id: str | None = None) -> dict[str, Any]:
    """Merge a ready ontology (entities/relations/preferences/decisions) in one call.

    Every write is an idempotent upsert keyed by deterministic id, so re-sending the
    same ontology never duplicates data. Entity ids are 'type:name' (e.g. 'person:jane');
    omit an id to have it derived. Prefer this over the create_* tools for bulk writes
    and for anything you may retry. References are validated before any write; the batch
    is atomic on transactional backends (Neo4j, Memgraph), while auto-commit backends
    (HydraDB, Kuzu, FalkorDB) apply writes incrementally, so a mid-batch failure can
    leave earlier writes in place. Re-running the same ontology reconciles it.
    """
    g = await _graph_handle()
    return to_jsonable(await g.insert.ontology(ontology, source_id=source_id))


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
    the id already exists; use insert_ontology to upsert idempotently instead."""
    g = await _graph_handle()
    return to_jsonable(
        await g.entities.create(name, type, id=id, aliases=aliases, external_ids=external_ids, properties=properties)
    )


async def get_entity(id: str) -> dict[str, Any] | None:
    """Fetch one entity by id, or null if it does not exist."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.get(id))


async def list_entities(
    type: str | None = None, name: str | None = None, limit: int = 50, cursor: str | None = None
) -> dict[str, Any]:
    """List entities, optionally filtered by type and/or name. Paged via next_cursor."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.list(type=type, name=name, limit=limit, cursor=cursor))


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
    """Update an entity. aliases/properties/external_ids merge in; remove_aliases/remove_properties drop keys."""
    g = await _graph_handle()
    fields: dict[str, Any] = {}
    if name is not None:
        fields["name"] = name
    if type is not None:
        fields["type"] = type
    if aliases is not None:
        fields["aliases"] = aliases
    if external_ids is not None:
        fields["external_ids"] = external_ids
    if properties is not None:
        fields["properties"] = properties
    if remove_aliases is not None:
        fields["remove_aliases"] = remove_aliases
    if remove_properties is not None:
        fields["remove_properties"] = remove_properties
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
) -> dict[str, Any]:
    """Create a directed, versioned relationship between two entities. from_entity and
    to_entity are existing entity ids ('type:name'); create the entities first. The type
    normalizes to UPPER_SNAKE, so 'works at' and 'WORKS_AT' are the same relation."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.create(from_entity, type, to_entity, id=id, properties=properties))


async def get_relation(id: str) -> dict[str, Any] | None:
    """Fetch the current version of a relationship by id, or null."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.get(id))


async def list_relations(
    from_entity: str | None = None,
    type: str | None = None,
    to_entity: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> dict[str, Any]:
    """List current relationships, optionally filtered by endpoints and/or type."""
    g = await _graph_handle()
    return to_jsonable(
        await g.relations.list(from_entity=from_entity, type=type, to_entity=to_entity, limit=limit, cursor=cursor)
    )


async def update_relation(
    id: str, set_properties: dict | None = None, remove_properties: list[str] | None = None
) -> dict[str, Any]:
    """Create a new version of a relationship with changed properties."""
    g = await _graph_handle()
    return to_jsonable(
        await g.relations.update(id, set_properties=set_properties, remove_properties=remove_properties or ())
    )


async def relation_versions(id: str, newest_first: bool = True) -> list[dict[str, Any]]:
    """Return every version of a relationship, newest first by default."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.versions(id, newest_first=newest_first))


async def delete_relation(id: str) -> dict[str, Any]:
    """Delete a relationship, all of its versions, and any decision trace that uses it as a step."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.delete(id))


async def create_preference(
    subject_entity: str,
    key: str,
    value_entity: str,
    kind: str = "preference",
    id: str | None = None,
    about_entity: str | None = None,
    strength: float | None = None,
    properties: dict | None = None,
) -> dict[str, Any]:
    """Record that an entity prefers or avoids a value (kind: preference|disinterest).
    Omit id to derive one; a manual id must start with 'preference:'."""
    g = await _graph_handle()
    return to_jsonable(
        await g.preferences.create(
            subject_entity,
            key,
            value_entity,
            id=id,
            kind=kind,  # type: ignore[arg-type]
            about_entity=about_entity,
            strength=strength,
            properties=properties,
        )
    )


async def list_preferences(
    subject_entity: str | None = None,
    key: str | None = None,
    kind: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> dict[str, Any]:
    """List current preferences, optionally scoped to one subject entity. Paged via next_cursor."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.list(subject_entity, key=key, kind=kind, limit=limit, cursor=cursor))


async def preference_versions(id: str, newest_first: bool = True) -> list[dict[str, Any]]:
    """Return every version of a preference, newest first by default."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.versions(id, newest_first=newest_first))


async def update_preference(
    id: str,
    strength: float | None = None,
    properties: dict | None = None,
    remove_properties: list[str] | None = None,
) -> dict[str, Any]:
    """Update a preference (new version). properties merge in; remove_properties drop keys."""
    g = await _graph_handle()
    return to_jsonable(
        await g.preferences.update(
            id, strength=strength, properties=properties, remove_properties=remove_properties or ()
        )
    )


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
    steps: list[str],
    id: str | None = None,
    actor_entity: str | None = None,
    summary: str | None = None,
    rationale: str | None = None,
    outcome_entity: str | None = None,
    alternative_entities: list[str] | None = None,
    status: str = "completed",
) -> dict[str, Any]:
    """Record a decision trace. steps are ids of relations that already exist (relation:..., from
    create_relation or list_relations), in order; they are the path that led to the outcome."""
    g = await _graph_handle()
    return to_jsonable(
        await g.decisions.create(
            title,
            steps=steps,
            id=id,
            actor_entity=actor_entity,
            summary=summary,
            rationale=rationale,
            outcome_entity=outcome_entity,
            alternative_entities=alternative_entities or (),
            status=status,  # type: ignore[arg-type]
        )
    )


async def update_decision(
    id: str,
    title: str | None = None,
    steps: list[str] | None = None,
    actor_entity: str | None = None,
    summary: str | None = None,
    rationale: str | None = None,
    outcome_entity: str | None = None,
    alternative_entities: list[str] | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    """Update fields of a decision trace, creating a new version."""
    g = await _graph_handle()
    fields: dict[str, Any] = {}
    if title is not None:
        fields["title"] = title
    if steps is not None:
        fields["steps"] = steps
    if actor_entity is not None:
        fields["actor_entity"] = actor_entity
    if summary is not None:
        fields["summary"] = summary
    if rationale is not None:
        fields["rationale"] = rationale
    if outcome_entity is not None:
        fields["outcome_entity"] = outcome_entity
    if alternative_entities is not None:
        fields["alternative_entities"] = alternative_entities
    if status is not None:
        fields["status"] = status
    return to_jsonable(await g.decisions.update(id, **fields))


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
    status: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> dict[str, Any]:
    """List decision traces, optionally filtered by actor and/or status."""
    g = await _graph_handle()
    return to_jsonable(await g.decisions.list(actor_entity=actor_entity, status=status, limit=limit, cursor=cursor))


async def run_cypher(query: str, params: dict | None = None) -> dict[str, Any]:
    """Run a read Cypher statement and return its rows; a keyword scan rejects writes but is a guard, not a sandbox."""
    if not isinstance(query, str):
        raise ValidationError(f"query must be a string, got {type(query).__name__}")
    if _is_blocked_query(query):
        raise ValidationError(
            "run_cypher is read-only: it runs a single read that begins with MATCH, OPTIONAL MATCH, WITH, "
            "UNWIND, RETURN, SHOW, EXPLAIN, or PROFILE and contains no write, schema, transaction, or I/O "
            "clause (CREATE, MERGE, SET, DELETE, DETACH, REMOVE, DROP, ALTER, RENAME, TRUNCATE, FOREACH, CALL, "
            "LOAD, COPY, IMPORT, EXPORT, INSTALL, UNINSTALL, ATTACH, USE, COMMENT, GRANT, REVOKE, DENY, and "
            "transaction or admin commands such as BEGIN, COMMIT, TERMINATE). Use the typed resources or insert "
            "for writes."
        )
    g = await _graph_handle()
    return to_jsonable(await g.run_cypher(query, params))


async def retrieve(
    query: str,
    strategy: str = "bfs",
    depth: int = 3,
    k: int = 20,
    max_nodes: int = 200,
    budget_tokens: int = 3000,
) -> dict[str, Any]:
    """Retrieve graph context for a query by keyword seeds and bounded BFS, DFS, or PageRank ("ppr") ranking."""
    g = await _graph_handle()
    return to_jsonable(
        await g.retrieve(query, strategy=strategy, depth=depth, k=k, max_nodes=max_nodes, budget_tokens=budget_tokens)
    )


TOOLS = [
    insert_text,
    insert_ontology,
    create_entity,
    get_entity,
    list_entities,
    update_entity,
    delete_entity,
    create_relation,
    get_relation,
    list_relations,
    update_relation,
    relation_versions,
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
]


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
        raise RuntimeError("the 'mcp' package is required to run the MCP server; install selfgraph[mcp]") from exc


def build_server(name: str = "selfgraph"):
    """Create an MCP server with every tool registered. Requires selfgraph[mcp].

    Both the MCPServer (mcp >= 2) and legacy FastMCP (mcp 1.x) classes expose
    the same .tool() decorator and stdio .run().

    @param name (str): the server name.
    """
    server_class, tool_error = _server_class()
    server = server_class(name)
    structured = "structured_output" in inspect.signature(server.tool).parameters
    for fn in TOOLS:
        decorate = server.tool(structured_output=True) if structured else server.tool()
        decorate(_tool(fn, tool_error))
    return server


def run_stdio(settings: GraphSettings | None = None) -> None:
    """Configure the backend and serve the tools over stdio (blocks).

    @param settings (GraphSettings | None): the backend settings, or None to read the environment.
    """
    configure(settings)
    build_server().run()

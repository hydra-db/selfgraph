from __future__ import annotations

from typing import Any

from ..client import SelfGraph
from ..runtime import GraphSettings, build_graph, settings_from_env, to_jsonable

__all__ = ["configure", "build_server", "run_stdio", "TOOLS"]

_settings: GraphSettings | None = None
_graph: SelfGraph | None = None


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


async def insert_text(text: str, source_id: str | None = None) -> dict:
    """Extract an ontology from text and merge it into the graph. Needs an LLM."""
    g = await _graph_handle()
    return to_jsonable(await g.insert.text(text, source_id=source_id))


async def insert_ontology(ontology: dict, source_id: str | None = None) -> dict:
    """Merge a ready ontology (entities/relations/preferences/decisions) in one transaction."""
    g = await _graph_handle()
    return to_jsonable(await g.insert.ontology(ontology, source_id=source_id))


async def create_entity(
    name: str,
    type: str,
    id: str | None = None,
    aliases: list[str] | None = None,
    properties: dict | None = None,
) -> dict:
    """Create or update a single entity (node)."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.create(name, type, id=id, aliases=aliases, properties=properties))


async def get_entity(id: str) -> Any:
    """Fetch one entity by id, or null if it does not exist."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.get(id))


async def list_entities(
    type: str | None = None, name: str | None = None, limit: int = 50, cursor: str | None = None
) -> dict:
    """List entities, optionally filtered by type and/or name. Paged via next_cursor."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.list(type=type, name=name, limit=limit, cursor=cursor))


async def update_entity(
    id: str,
    name: str | None = None,
    type: str | None = None,
    aliases: list[str] | None = None,
    properties: dict | None = None,
) -> dict:
    """Update an entity's name, type, aliases, or properties."""
    g = await _graph_handle()
    fields: dict[str, Any] = {}
    if name is not None:
        fields["name"] = name
    if type is not None:
        fields["type"] = type
    if aliases is not None:
        fields["aliases"] = aliases
    if properties is not None:
        fields["properties"] = properties
    return to_jsonable(await g.entities.update(id, **fields))


async def delete_entity(id: str) -> dict:
    """Delete an entity and the edges attached to it."""
    g = await _graph_handle()
    return to_jsonable(await g.entities.delete(id))


async def create_relation(
    from_entity: str,
    type: str,
    to_entity: str,
    id: str | None = None,
    properties: dict | None = None,
) -> dict:
    """Create a directed, versioned relationship between two entities."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.create(from_entity, type, to_entity, id=id, properties=properties))


async def get_relation(id: str) -> Any:
    """Fetch the current version of a relationship by id, or null."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.get(id))


async def list_relations(
    from_entity: str | None = None,
    type: str | None = None,
    to_entity: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> dict:
    """List current relationships, optionally filtered by endpoints and/or type."""
    g = await _graph_handle()
    return to_jsonable(
        await g.relations.list(from_entity=from_entity, type=type, to_entity=to_entity, limit=limit, cursor=cursor)
    )


async def update_relation(
    id: str, set_properties: dict | None = None, remove_properties: list[str] | None = None
) -> dict:
    """Create a new version of a relationship with changed properties."""
    g = await _graph_handle()
    return to_jsonable(
        await g.relations.update(id, set_properties=set_properties, remove_properties=remove_properties or ())
    )


async def relation_versions(id: str) -> list:
    """Return every version of a relationship, newest first."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.versions(id))


async def delete_relation(id: str) -> dict:
    """Delete a relationship and all of its versions."""
    g = await _graph_handle()
    return to_jsonable(await g.relations.delete(id))


async def create_preference(
    subject_entity: str,
    key: str,
    value_entity: str,
    kind: str = "preference",
    strength: float | None = None,
) -> dict:
    """Record that an entity prefers or avoids a value (kind: preference|disinterest)."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.create(subject_entity, key, value_entity, kind=kind, strength=strength))


async def list_preferences(
    subject_entity: str,
    key: str | None = None,
    kind: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> dict:
    """List an entity's current preferences."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.list(subject_entity, key=key, kind=kind, limit=limit, cursor=cursor))


async def update_preference(id: str, strength: float | None = None, properties: dict | None = None) -> dict:
    """Update a preference's strength or properties (new version)."""
    g = await _graph_handle()
    return to_jsonable(await g.preferences.update(id, strength=strength, properties=properties))


async def get_decision(id: str) -> Any:
    """Fetch one decision trace by id, or null."""
    g = await _graph_handle()
    return to_jsonable(await g.decisions.get(id))


async def list_decisions(
    actor_entity: str | None = None,
    status: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> dict:
    """List decision traces, optionally filtered by actor and/or status."""
    g = await _graph_handle()
    return to_jsonable(await g.decisions.list(actor_entity=actor_entity, status=status, limit=limit, cursor=cursor))


async def run_cypher(query: str, params: dict | None = None) -> dict:
    """Run one read Cypher statement and return its rows (projections/aggregates only)."""
    g = await _graph_handle()
    return to_jsonable(await g.run_cypher(query, params))


async def retrieve(
    query: str,
    strategy: str = "bfs",
    depth: int = 3,
    k: int = 20,
    max_nodes: int = 200,
    budget_tokens: int = 3000,
) -> dict:
    """Retrieve graph context for a query by keyword seeds and bounded BFS or DFS traversal."""
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
    update_preference,
    get_decision,
    list_decisions,
    run_cypher,
    retrieve,
]


def _server_class():
    """The MCP server class across SDK versions: MCPServer (mcp >= 2) or FastMCP (mcp 1.x)."""
    try:
        from mcp.server.mcpserver import MCPServer

        return MCPServer
    except ImportError:
        pass
    try:
        from mcp.server.fastmcp import FastMCP

        return FastMCP
    except ImportError as exc:  # pragma: no cover - optional dep
        raise RuntimeError("the 'mcp' package is required to run the MCP server; install selfgraph[mcp]") from exc


def build_server(name: str = "selfgraph"):
    """Create an MCP server with every tool registered. Requires selfgraph[mcp].

    Both the MCPServer (mcp >= 2) and legacy FastMCP (mcp 1.x) classes expose
    the same .tool() decorator and stdio .run().

    @param name (str): the server name.
    """
    server = _server_class()(name)
    for fn in TOOLS:
        server.tool()(fn)
    return server


def run_stdio(settings: GraphSettings | None = None) -> None:
    """Configure the backend and serve the tools over stdio (blocks).

    @param settings (GraphSettings | None): the backend settings, or None to read the environment.
    """
    configure(settings)
    build_server().run()

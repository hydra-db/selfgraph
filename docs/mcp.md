# MCP

SelfGraph ships a Model Context Protocol server that exposes the graph to an MCP
client such as Claude Desktop, Cursor, or Codex. It serves the same API as the
library.

Install the extra:

```bash
pip install "selfgraph[mcp]"
```

## Running it

The server runs over stdio. Pick a backend with the connection flags, then the
`mcp` command:

```bash
selfgraph --store kuzu --uri graph.kuzu mcp
```

You rarely run this by hand. An MCP client launches it for you from its config
and talks to it over stdio.

## Client config

Register the command with your client. For an embedded Kuzu graph:

```json
{
  "mcpServers": {
    "selfgraph": {
      "command": "selfgraph",
      "args": ["--store", "kuzu", "--uri", "graph.kuzu", "mcp"]
    }
  }
}
```

For a Bolt backend, pass its connection flags instead:

```json
{
  "mcpServers": {
    "selfgraph": {
      "command": "selfgraph",
      "args": [
        "--store", "neo4j",
        "--uri", "bolt://localhost:7687",
        "--auth", "neo4j:password",
        "mcp"
      ]
    }
  }
}
```

The backend you name must be reachable when the client starts the server. A Kuzu
file needs nothing running.

## Schema

Pass `--schema` before `mcp` to check every insert tool against a
[schema](schema.md#cli-and-mcp). The `get_schema` tool returns it, so an agent can
read the expected types before it writes.

## Tools

The tools mirror the library. Write tools for relations, preferences, and decisions
take an optional `event_time` (ISO 8601 text, such as `2024-05-01T09:00:00+00:00`)
for when the fact became true, and `insert_text` takes `event_time` and `metadata`
for the source. `insert_text` uses the configured LLM and falls back to a built-in
LLM-free extractor when none is set. In `update_decision`, an omitted field keeps
its value and an explicit `null` clears `actor_entity`, `summary`, `rationale`,
`outcome_entity`, or `event_time`; decisions are updated in place, with no version
history. `entity_evidence` and `relation_evidence` page through the evidence records
behind an entity or relation.

`run_cypher` runs read-only Cypher. A keyword guard, not a sandbox, rejects any
statement that writes, changes schema, or runs a transaction or admin command,
including `INSERT`, a write keyword used as a bare alias or variable name
(backtick-quote it instead), and any `\u` unicode escape, since Neo4j decodes those
before parsing (pass such text as a parameter). It is not scoped to the server's
namespace: it sees every namespace in the database, so filter on the `ns` property.

## Embedding

`selfgraph.mcp.server.build_server()` returns the server for your own process. The
tools share one graph; `await close()` from the same module closes it when you are
done, and the next tool call reopens it.

## Errors

A tool that fails returns an MCP error result, with the error flag set and the
SelfGraph error type and message as its text, such as
`NotFoundError: Entity 'person:nobody' does not exist`.

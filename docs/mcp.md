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
file needs nothing running, which is why it is the simplest target.

## Embedding

`selfgraph.mcp.server.build_server()` returns the server for your own process. The
tools share one graph; `await close()` from the same module closes it when you are
done, and the next tool call reopens it.

## Errors

A tool that fails returns an MCP error result, with the error flag set and the
SelfGraph error type and message as its text, such as
`NotFoundError: Entity 'person:nobody' does not exist`.

# TypeScript

`@hydradb/selfgraph` on npm is a pure TypeScript port of the Python SDK (Node 20+, ESM
and CommonJS). It derives the same ids, stores the same properties in the same encoding,
and versions the same way, so either SDK can read and extend a graph the other wrote; the
test suite checks this byte for byte on every backend. The [package
README](https://github.com/hydra-db/selfgraph/blob/main/typescript/README.md) has the
quickstart and configuration.

## Install

`npm install @hydradb/selfgraph` covers Neo4j, the openCypher family, and HydraDB with no
native addon. Each optional feature is a peer package:

| Package | Adds |
|---------|------|
| `kuzu` | The embedded Kuzu backend (a native addon). |
| `falkordb` | The FalkorDB backend. |
| `ai` (6 or newer) plus a provider such as `@ai-sdk/anthropic` | LLM text extraction. |
| `js-tiktoken` | Token-aware chunking and budgets. |
| `@modelcontextprotocol/sdk` | The MCP server. |

## Naming

Method names are camelCase and options go in a trailing object. Model fields and option
keys keep their Python names (`from_entity`, `event_time`, `next_cursor`,
`budget_tokens`), so ontology JSON, MCP payloads, and these docs carry over unchanged.

| Python | TypeScript |
|--------|------------|
| `SelfGraph(store=..., llm=..., namespace=...)` | `new SelfGraph(store, { llm, namespace })` |
| `SelfGraph.from_env()` / `SelfGraph.connect(...)` | `SelfGraph.fromEnv()` / `SelfGraph.connect({...})` |
| `graph.run_cypher(q, params)` | `graph.runCypher(q, params)` |
| `graph.entities.create(name, type, id=..., properties=...)` | `graph.entities.create(name, type, { id, properties })` |
| `graph.relations.versions(id, newest_first=False)` | `graph.relations.versions(id, { newest_first: false })` |
| `graph.retrieve(q, max_nodes=100)` | `graph.retrieve(q, { max_nodes: 100 })` |
| `async for e in graph.entities.iterate()` | `for await (const e of graph.entities.iterate())` |
| `async with SelfGraph(...) as graph` | `await using graph = new SelfGraph(...)` |
| `entity_id(type, name)` | `entityId(type, name)` (also `relationId`, `preferenceId`, `decisionId`, `profileId`, `normalizeRelType`; other helpers under `ids`) |
| `Schema.from_neo4j_ontology(data)`, `schema.to_neo4j_ontology()` | `fromNeo4jOntology(data)`, `toNeo4jOntology(schema)` |

Timestamps are `Date` objects; inputs also accept ISO text. In an update an omitted field
keeps its value. On a decision `null` clears a field, as an explicit `None` does in
Python; on a relation or preference `null` keeps the value, as `None` does in Python,
and a preference field is removed by naming it in `clear`. A `null` inside `properties`
removes that key.

`await using` needs TypeScript 5.2+ or Node 24+; in plain JavaScript on Node 20 to 22,
call `await graph.close()` in a `finally` block.

## Differences

- `llm` takes an `LLMConfig`, any AI SDK model object such as
  `anthropic("claude-sonnet-5-5")`, or an `LLMClient`; Python goes through litellm.
  Provider names and packages are listed in the package README.
- There is no spaCy path: without an LLM, `insert.text` uses the regex fallback.
- There is no `SyncSelfGraph`.
- Warnings go through `setLogger` rather than Python's `logging`
  ([logging](errors.md#warnings-and-logging)).
- `FalkorDBStore(host, port, options)` accepts only `graph`, `username`, `password`,
  `socket`, `name`, `pingInterval`, `disableClientInfo`, `clientInfoTag`, and
  `retryWritesOnConnectionLoss`; Python passes any FalkorDB client keyword through.
- An unclosed graph on a server store (Neo4j, Memgraph, HydraDB, FalkorDB) keeps the
  Node process alive through its open connections; an unclosed Kuzu graph does not.
- `runCypher` returns an integer beyond `Number.MAX_SAFE_INTEGER` as a `bigint`; pass rows
  through `toJsonable()` before `JSON.stringify`.
- MCP tool errors carry `{error, error_type}` rather than text ([MCP](mcp.md#errors)), and
  `callTool` runs a tool without a server.

## CLI and MCP

`npx @hydradb/selfgraph` (installed: `selfgraph`) takes the same flags, commands, and
`SELFGRAPH_*` variables as the Python [CLI](cli.md) and prints the same JSON;
`npx @hydradb/selfgraph mcp` serves the same 34 [MCP](mcp.md) tools.

## Development

The [package README](https://github.com/hydra-db/selfgraph/blob/main/typescript/README.md#development)
lists the build and test commands. `npm run format` applies the
Biome fixes `npm run lint` checks. A `ts-vX.Y.Z` GitHub release whose version matches
`package.json` publishes to npm.

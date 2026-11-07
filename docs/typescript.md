# TypeScript

`@hydradb/selfgraph` on npm is a pure TypeScript port of the Python SDK. It needs no
Python, no native addon, and no service. It derives the same ids, stores the
same properties in the same encoding, and versions the same way, so a Python
service and a Node service can share one graph.

## Install

Node 20 or newer. ESM and CommonJS both work.

```bash
npm install @hydradb/selfgraph
```

The core covers Neo4j, the openCypher family, and HydraDB. Each optional
feature is a peer package you install next to it:

| Package | Adds |
|---------|------|
| `kuzu` | The embedded Kuzu backend. |
| `falkordb` | The FalkorDB backend. |
| `ai` plus a provider such as `@ai-sdk/anthropic` | LLM text extraction. |
| `js-tiktoken` | Token-aware chunking and budgets. |
| `@modelcontextprotocol/sdk` | The MCP server. |

## Quickstart

```ts
import { KuzuStore, SelfGraph } from "@hydradb/selfgraph";

const graph = new SelfGraph(new KuzuStore("graph.kuzu"));

await graph.insert.ontology({
  entities: [
    { id: "person:jane", type: "Person", name: "Jane Doe" },
    { id: "company:acme", type: "Company", name: "Acme" },
  ],
  relations: [{ from_entity: "person:jane", type: "WORKS_AT", to_entity: "company:acme" }],
});

const result = await graph.retrieve("who works at Acme", { strategy: "ppr" });
console.log(result.context);
await graph.close();
```

`await using graph = new SelfGraph(...)` closes the graph at the end of the
scope on TypeScript 5.2+ or Node 24+.

## Naming

Method names are camelCase. Model fields and option keys keep their Python
names, so ontology JSON, MCP payloads, and these docs carry over unchanged.

| Python | TypeScript |
|--------|------------|
| `SelfGraph(store=s, llm=l, namespace=n)` | `new SelfGraph(s, { llm: l, namespace: n })` |
| `graph.run_cypher(q, params)` | `graph.runCypher(q, params)` |
| `graph.retrieve(q, max_nodes=100)` | `graph.retrieve(q, { max_nodes: 100 })` |
| `async for e in graph.entities.iterate()` | `for await (const e of graph.entities.iterate())` |
| `selfgraph.entity_id(type, name)` | `entityId(type, name)` |
| `SelfGraph.from_env()` | `SelfGraph.fromEnv()` |

Timestamps are `Date` objects, and inputs also accept ISO text. In an update an
omitted field keeps its value and `null` clears it, as `None` does in Python.

## Differences

- `llm` takes an `LLMConfig`, any AI SDK model object such as
  `anthropic("claude-sonnet-5-5")`, or your own `LLMClient`. Python goes through
  litellm instead. Set `provider: "gateway"` with `model: "openai/gpt-4o"` to
  reach any vendor through the Vercel AI Gateway (`@ai-sdk/gateway`,
  `AI_GATEWAY_API_KEY` or `api_key`), or point `base_url` at any
  OpenAI-compatible endpoint.
- There is no spaCy path. Without an LLM, `insert.text` uses the regex
  fallback.
- There is no `SyncSelfGraph`.
- HydraDB sends its Bolt handshake reply in pieces that the JavaScript driver
  does not reassemble. `HydraDBStore` retries a failed handshake with jitter,
  which is safe because no query has run yet.

## CLI and MCP

`npx @hydradb/selfgraph` takes the same flags, commands, and `SELFGRAPH_*`
variables as the Python CLI and prints the same JSON. `npx @hydradb/selfgraph mcp`
serves the same 26 tools. Installed, the command is `selfgraph`. To embed the
server in your own process, use
`import { buildServer, TOOLS } from "@hydradb/selfgraph/mcp"`.

## Development

The package lives in `typescript/` in this repository.

```bash
cd typescript
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

Integration tests run on whichever backends are reachable; narrow them with
`SELFGRAPH_TEST_STORES=neo4j,kuzu`. Set `SELFGRAPH_PY` to a Python that has
`selfgraph` installed to run the cross-language conformance test, which writes a
graph from each side and checks the other reads it back byte for byte.

`npm run format` applies the Biome lint fixes and formatting that `npm run lint`
checks. Releases are cut from a `ts-vX.Y.Z` GitHub release whose version matches
`package.json`; CI publishes it to npm.

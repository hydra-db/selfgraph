# TypeScript

`@hydradb/selfgraph` on npm is a pure TypeScript port of the Python SDK. It needs
Node 20+ and ships ESM and CommonJS.

Both SDKs derive the same ids, store the same properties in the same encoding,
and version the same way. Either SDK can read and extend a graph the other wrote.
The test suite checks this byte for byte on every backend. The [package
README](https://github.com/hydra-db/selfgraph/blob/main/typescript/README.md) has
the quickstart.

## Install

```bash
npm install @hydradb/selfgraph
```

This covers Neo4j, the openCypher family, and HydraDB, with no native addon. Each
optional feature is a peer package:

| Package | Adds |
|---------|------|
| `kuzu` | The embedded Kuzu backend (a native addon). |
| `falkordb` | The FalkorDB backend. |
| `ai` (6 or newer) plus a provider such as `@ai-sdk/anthropic` | LLM text extraction. |
| `js-tiktoken` | Token-aware chunking and budgets. |
| `@modelcontextprotocol/sdk` | The MCP server. |

LLM extraction needs `ai` plus the package for your `provider`:

| `provider` | Package |
|------------|---------|
| `anthropic` | `@ai-sdk/anthropic` |
| `openai`, `azure` | `@ai-sdk/openai`, `@ai-sdk/azure` |
| `google`, `gemini` | `@ai-sdk/google` |
| `vertex`, `vertex_ai` | `@ai-sdk/google-vertex` |
| `bedrock` | `@ai-sdk/amazon-bedrock` |
| `mistral`, `groq`, `xai`, `deepseek`, `cohere`, `cerebras`, `perplexity` | `@ai-sdk/<provider>` |
| `togetherai`, `together_ai`; `fireworks`, `fireworks_ai` | `@ai-sdk/togetherai`; `@ai-sdk/fireworks` |
| `openrouter` | `@openrouter/ai-sdk-provider` |
| `gateway` | `@ai-sdk/gateway` |
| `ollama`, or any other name with `base_url` | `@ai-sdk/openai-compatible` |

The type declarations reference `Symbol.asyncDispose`. With `skipLibCheck: false`,
or to use `await using` in your code, use `@types/node` 20 or newer, or add
`"esnext.disposable"` to `lib` in `tsconfig.json`.

## Naming

Method names are camelCase, and options go in a trailing object. Model fields and
option keys keep their Python names (`from_entity`, `event_time`, `next_cursor`,
`budget_tokens`). So facts JSON, MCP payloads, and these docs carry over
unchanged.

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
| `Schema.from_tables(tables, name="sales")` | `fromTables(tables, { name: "sales" })` |
| `SelfGraph(store, level="light", max_tier="balanced", embedder=e)`, `graph.tiers` | `new SelfGraph(store, { level: "light", max_tier: "balanced", embedder: e })`, `graph.tiers` |
| `schema.to_ossie()` | `toOssie(schema)` |
| `graph.check_answerable(q, terms=[...])`, `graph.readiness()`, `graph.export_obsidian()` | `graph.checkAnswerable(q, { terms: [...] })`, `graph.readiness()`, `graph.exportObsidian()` |
| `graph.relations.certify(id, by="hr")` | `graph.relations.certify(id, { by: "hr" })` |

`await using` needs TypeScript 5.2+ or Node 24+. In plain JavaScript on Node 20
to 22, call `await graph.close()` in a `finally` block.

**Values.** Timestamps are `Date` objects. Inputs also accept ISO text. A `null`
inside `properties` removes that key.

**Updates.** An omitted field keeps its value. `null` behaves as `None` does in
Python:

- On a decision, `null` clears a field.
- On a relation or preference, `null` keeps the value. Remove a preference field
  by naming it in `clear`.

## Differences

**LLM.**

- `llm` takes an `LLMConfig`, any AI SDK model object such as
  `anthropic("claude-sonnet-5-5")`, or an `LLMClient`. Python goes through
  litellm.
- `provider: "gateway"` with `model: "openai/gpt-4o"` routes any vendor through
  the Vercel AI Gateway (`AI_GATEWAY_API_KEY` or `api_key`).
- `provider: "openai"` with `base_url` targets any OpenAI-compatible endpoint.
- The `google` provider reads `api_key`, then `GOOGLE_GENERATIVE_AI_API_KEY`,
  `GEMINI_API_KEY`, or `GOOGLE_API_KEY`. A prebuilt `google(...)` model reads only
  `GOOGLE_GENERATIVE_AI_API_KEY`.
- A custom `LLMClient` gets a different zod `output` schema per pass, and must
  answer the one it is given.

**Extraction.**

- There is no spaCy path. Without an LLM, `insert.text` uses the regex fallback.
  `extraction: "spacy"` is accepted and runs as `"regex"`, and `graph.tiers.extraction`
  reads `"regex"` wherever Python reads `"spacy"` (the balanced level, for one).
- Token counting uses js-tiktoken once `loadTokenizer()` has loaded it. It
  returns `{ countTokens, chunkText }`. `setTokenizer(encoder)` uses your encoder,
  or `null` for the character estimate.

**Lifecycle.**

- There is no `SyncSelfGraph`. `new SelfGraph(...)`, `SelfGraph.connect(...)`,
  and `SelfGraph.fromEnv()` are synchronous. The first call connects.
- An unclosed graph on a server store (Neo4j, Memgraph, HydraDB, FalkorDB) keeps
  the Node process alive through its open connections. An unclosed Kuzu graph
  does not.

**Other.**

- Warnings go through `setLogger`, not Python's `logging`
  ([logging](errors.md#warnings-and-logging)).
- `FalkorDBStore(host, port, options)` accepts only `graph`, `username`,
  `password`, `socket`, `name`, `pingInterval`, `disableClientInfo`,
  `clientInfoTag`, and `retryWritesOnConnectionLoss`. Python passes any FalkorDB
  client keyword through.
- `runCypher` returns an integer beyond `Number.MAX_SAFE_INTEGER` as a `bigint`.
  Pass rows through `toJsonable()` before `JSON.stringify`.
- MCP tool errors carry `{error, error_type}` rather than text
  ([MCP](mcp.md#errors)). `callTool` runs a tool without a server.

## CLI and MCP

`npx @hydradb/selfgraph` (installed: `selfgraph`) takes the same flags, commands,
and `SELFGRAPH_*` variables as the Python [CLI](cli.md), and prints the same
JSON. `npx @hydradb/selfgraph mcp` serves the same 35 [MCP](mcp.md) tools.

## Known issues

- HydraDB writes its Bolt handshake reply in more than one packet, and
  neo4j-driver for JavaScript does not reassemble it. `HydraDBStore.initialize()`
  opens a first pooled connection, and every query retries a failed handshake
  with jitter. This is safe because nothing has run yet.
- Entity id canonicalization follows Python's `\w`, which excludes combining
  marks. Names in scripts that use them (Devanagari, for example) are split at
  those marks. Both SDKs derive the same ids.
- The `kuzu` npm package is deprecated upstream. The Python SDK depends on the
  same release.

## Development

```bash
cd typescript
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

- Integration tests run against whichever backends are reachable.
  `SELFGRAPH_TEST_STORES=neo4j,kuzu` selects some.
- The cross-language conformance test runs when `SELFGRAPH_PY` points at a Python
  that has `selfgraph` installed. `test/fixtures/generate_parity.py` regenerates
  the parity fixture.
- `npm run format` applies the Biome fixes that `npm run lint` checks.
- A `ts-vX.Y.Z` GitHub release whose version matches `package.json` publishes to
  npm.

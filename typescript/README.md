<p align="center">
  <img src="https://raw.githubusercontent.com/hydra-db/selfgraph/main/assets/logo.png" alt="SelfGraph" width="92" />
</p>

<h1 align="center">SelfGraph for TypeScript</h1>

<p align="center">
  <b>Turn unstructured text into a queryable, versioned knowledge graph.</b><br/>
  One graph API over any graph backend. A native TypeScript port of the Python SDK.
</p>

## What's included

- Text-to-graph extraction with any LLM through the AI SDK, or a zero-dependency fallback without one.
- Typed CRUD over entities, relations, preferences, and decision traces, with bitemporal versioning, source provenance, and per-namespace isolation.
- An optional [schema](https://github.com/hydra-db/selfgraph/blob/main/docs/schema.md) that guides extraction and validates every write, with [contradiction handling](https://github.com/hydra-db/selfgraph/blob/main/docs/schema.md#contradictions) on `max_count`.
- Optional [entity resolution](https://github.com/hydra-db/selfgraph/blob/main/docs/resolution.md) that merges duplicates on insert, with a reversible record of every merge.
- [Retrieval](https://github.com/hydra-db/selfgraph/blob/main/docs/retrieval.md) from keyword seeds and bounded BFS, DFS, or personalized PageRank, no vector store, optionally as of a past time.
- Explicit [maintenance](https://github.com/hydra-db/selfgraph/blob/main/docs/maintenance.md): relevance decay, pruning, and merging duplicate relations, dry runs by default.
- A CLI and an MCP server, and one storage interface across Neo4j, Memgraph, FalkorDB, embedded Kuzu, HydraDB, or a custom store.
- The same ids, encoding, and versioning as the Python SDK, so both read and write one graph.

## Install

```bash
npm install @hydradb/selfgraph                            # core: Neo4j, the openCypher family, and HydraDB
npm install @hydradb/selfgraph kuzu                       # the embedded Kuzu backend (a native addon)
npm install @hydradb/selfgraph falkordb                   # the FalkorDB backend
npm install @hydradb/selfgraph ai @ai-sdk/anthropic       # LLM extraction (ai 6 or newer, any AI SDK provider)
npm install @hydradb/selfgraph js-tiktoken                # token-aware chunking and budgets
npm install @hydradb/selfgraph @modelcontextprotocol/sdk  # the MCP server
```

Node 20 or newer; ESM and CommonJS are both supported. The type declarations reference
`Symbol.asyncDispose`: with `skipLibCheck: false` (or for `await using` in your code)
use `@types/node` 20 or newer, or add `"esnext.disposable"` to `lib` in `tsconfig.json`.

LLM extraction needs `ai` plus the package for your `provider`:

| `provider` | Package |
| --- | --- |
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

## Quickstart

No server and no LLM, with `npm install @hydradb/selfgraph kuzu`:

```ts
import { KuzuStore, SelfGraph } from "@hydradb/selfgraph";

await using graph = new SelfGraph(new KuzuStore("graph.kuzu"));

await graph.insert.ontology({
  entities: [
    { id: "person:jane", type: "Person", name: "Jane Doe" },
    { id: "company:acme", type: "Company", name: "Acme" },
  ],
  relations: [{ from_entity: "person:jane", type: "WORKS_AT", to_entity: "company:acme" }],
});

const result = await graph.retrieve("who works at Acme");
console.log(result.context);
```

With an LLM and a server:

```ts
import { Neo4jStore, SelfGraph } from "@hydradb/selfgraph";

const graph = new SelfGraph(new Neo4jStore("bolt://localhost:7687", { auth: ["neo4j", "password"] }), {
  llm: { provider: "anthropic", model: "claude-sonnet-5-5" },
});
try {
  await graph.insert.text("Soham prefers HydraDB. The team picked it for temporal history.");
  const result = await graph.retrieve("which database and why", { strategy: "bfs", depth: 3 });
  console.log(result.context);
} finally {
  await graph.close();
}
```

The store initializes lazily on first use. `await using` (TypeScript 5.2+, or Node 24+)
closes the graph at the end of the scope; otherwise close it in a `finally`, since an
unclosed server store keeps the Node process alive. Closing a graph closes the store you
passed in, so build a new store for each `SelfGraph`.

Without `llm`, `insert.text` uses a regex fallback that types every entity `Thing` and
links neighbours with `RELATED_TO`; there is no spaCy path. Use an LLM for graphs that
matter, or skip extraction with `insert.ontology(...)` or your own `extractor`. The
ontology JSON format is in [inserting](https://github.com/hydra-db/selfgraph/blob/main/docs/inserting.md#from-an-ontology).

## Configuration

`new SelfGraph(store, {...})` takes `llm`, `instructions`, `prompts`, `extractor`,
`namespace`, `schema`, `schema_mode`, `resolver` (a mode or an `EntityResolver`), and
`contradiction`. `SelfGraph.connect({...})` and `SelfGraph.fromEnv({...})` take flat
settings instead, the same ones the CLI flags and `SELFGRAPH_*` variables set: `store`,
`uri`, `auth`, `database`, `namespace`, `llm_provider`, `llm_model`, `llm_api_key`,
`llm_base_url`, `llm_timeout`, `llm_concurrency`, `schema`, `instructions`, `prompts`
(each an object, inline JSON, or a file path), `schema_mode`, `resolver`, and
`contradiction`. Any other key raises `ValidationError`. All three are synchronous: the
first call connects.

```ts
// LLMConfig: { provider, model, api_key?, base_url?, temperature = 0, max_retries = 3,
//              timeout = 120 (seconds per call, null for none), concurrency = 4 (chunks at once) }

interface LLMClient {   // used for extraction and resolver: "llm"
  generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T>;
}

interface EntityResolver {   // return target_id null to keep the candidate separate
  resolve(candidate: ParsedEntityInput, existing: readonly Entity[]): Promise<ResolutionDecision>;
}

interface Extractor {   // replaces LLM and regex extraction; one call per insert.text with the whole text
  extract(document: { text: string; media_type: string; metadata: JsonObject }): Promise<Ontology>;
}

const instructions = { entities: "...", relations: "...", preferences: "...", decisions: "..." }; // any subset
const prompts = { entities: { system: "...", user: "... {text} ...", version: "v1" } };          // per pass
```

`llm` also takes any AI SDK model object, such as `anthropic("claude-sonnet-5-5")`; any
other value, an unknown provider without `base_url`, or an unknown `LLMConfig` key raises
`ValidationError` when the graph is built. `provider: "gateway"` with
`model: "openai/gpt-4o"` routes any vendor through the Vercel AI Gateway
(`AI_GATEWAY_API_KEY` or `api_key`); `provider: "openai"` with `base_url` targets any
OpenAI-compatible endpoint through chat completions. The `google` provider reads
`api_key`, then `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`; a
prebuilt `google(...)` model reads only `GOOGLE_GENERATIVE_AI_API_KEY`.

Extraction calls `generate()` once per pass (entities, relations, preferences, decisions)
for each chunk, each with a different `output` schema, so a custom client must answer the
schema it is given. A prompt override needs `system`, `user`, and `version`, and its
`user` must contain `{text}` ([custom prompts](https://github.com/hydra-db/selfgraph/blob/main/docs/inserting.md#custom-prompts)).

Warnings and progress go through one logger, by default warnings to stderr as
`selfgraph: <message>`: `setLogger(fn)` routes them, `setLogger(null)` silences them,
and `setLogger(undefined)` restores the default.

## Helpers

| Helper | Returns |
|--------|---------|
| `entityId(type, name)`, `relationId(fromEntity, type, toEntity)`, `preferenceId(subjectEntity, kind, key, valueEntity)`, `decisionId(actorEntity, title)`, `profileId(subjectEntity)` | The id an insert derives. |
| `normalizeRelType(type)` | The stored UPPER_SNAKE relation type. |
| `chunkText(text, { max_tokens, overlap_tokens })` | The `Chunk`s extraction would read. |
| `countTokens(text)` | Tokens through the loaded tokenizer, or an estimate. |
| `loadTokenizer()` | Loads js-tiktoken once (async); returns `{ countTokens, chunkText }`. |
| `setTokenizer(encoder)` | Uses your encoder, or `null` for the character estimate. |
| `setLogger(fn)` | Routes warnings (see above); returns the previous logger. |

All are exported from `@hydradb/selfgraph`; `ids` holds the full id module.

## Backends

```ts
import { CypherStore, FalkorDBStore, HydraDBStore, KuzuStore, Neo4jStore } from "@hydradb/selfgraph";

new Neo4jStore("bolt://localhost:7687", { auth: ["neo4j", "password"] });
new CypherStore("bolt://localhost:7687", { auth: ["user", "password"] }); // Memgraph and other Bolt engines
new FalkorDBStore("db.example.com", 6380, { graph: "crm" });              // graph defaults to "selfgraph"
new KuzuStore("graph.kuzu", { max_db_size: 2 ** 30 });                    // no path: ./selfgraph_kuzu
new HydraDBStore("bolt://127.0.0.1:17687", { auth: ["neo4j", "<token>"] }); // HydraDB 0.4.0 or newer
```

Bolt stores take `auth` as `"user:password"`, a bare token (user `neo4j`), a
`[user, password]` pair, or a driver auth token, and reject any other shape. With no
store configured, `connect()`, `fromEnv()`, the CLI, and MCP use embedded Kuzu at
`~/.selfgraph/default.kuzu` without a URI and HydraDB with one, so a `.kuzu` path also
needs `store: "kuzu"`. Kuzu allows one process at a time per database, and each open
database reserves 8 TB of virtual memory unless you pass `max_db_size` (a positive
integer of bytes). To add a database, extend `CypherPrimitives` and implement `_run`, or
implement `GraphStore`. See [backends](https://github.com/hydra-db/selfgraph/blob/main/docs/backends.md)
for concurrency and each backend's [raw Cypher](https://github.com/hydra-db/selfgraph/blob/main/docs/backends.md#raw-cypher)
layout, and [TypeScript](https://github.com/hydra-db/selfgraph/blob/main/docs/typescript.md)
for the Python-to-TypeScript names and the differences between the SDKs.

## CLI and MCP

```bash
npx @hydradb/selfgraph --store neo4j --uri bolt://localhost:7687 insert text "..." --source-id notes
npx @hydradb/selfgraph --store neo4j --uri bolt://localhost:7687 mcp
```

The CLI and the MCP server match the Python ones: same flags, `SELFGRAPH_*` variables,
JSON output, exit codes, and 34 tools ([CLI](https://github.com/hydra-db/selfgraph/blob/main/docs/cli.md),
[MCP](https://github.com/hydra-db/selfgraph/blob/main/docs/mcp.md)). Pass secrets as
`SELFGRAPH_AUTH` and `SELFGRAPH_LLM_API_KEY` rather than flags, which `ps` shows. Stdio
MCP clients do not pass your shell environment, so set the connection in the `env` block:

```json
{
  "mcpServers": {
    "selfgraph": {
      "command": "npx",
      "args": ["-y", "-p", "@hydradb/selfgraph", "-p", "@modelcontextprotocol/sdk", "selfgraph", "mcp"],
      "env": {
        "SELFGRAPH_STORE": "neo4j",
        "SELFGRAPH_URI": "bolt://localhost:7687",
        "SELFGRAPH_AUTH": "neo4j:password"
      }
    }
  }
}
```

To embed the server in your own process:

```ts
import { DEFAULT_SETTINGS } from "@hydradb/selfgraph";
import { buildServer, close, configure } from "@hydradb/selfgraph/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

await configure({ ...DEFAULT_SETTINGS, store: "kuzu", uri: "graph.kuzu" }); // no argument: read SELFGRAPH_*
const server = await buildServer();
await server.connect(new StdioServerTransport());
// on shutdown
await server.close();
await close(); // close the tools' shared graph so the process can exit
```

## Known issues

- HydraDB writes its Bolt handshake reply in more than one packet, which neo4j-driver for JavaScript does not reassemble. `HydraDBStore.initialize()` opens a first pooled connection and every query retries a failed handshake with jitter, which is safe because nothing has run yet.
- Entity id canonicalization follows Python's `\w`, which excludes combining marks, so names in scripts that use them (Devanagari, for example) are split at those marks. Both SDKs derive the same ids.
- The `kuzu` npm package is deprecated upstream; the Python SDK depends on the same release.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

Integration tests run against whichever backends are reachable (`SELFGRAPH_TEST_STORES=neo4j,kuzu` selects some). The cross-language conformance test runs when `SELFGRAPH_PY` points at a Python that has `selfgraph` installed; `test/fixtures/generate_parity.py` regenerates the Python parity fixture.

## License

Apache-2.0.

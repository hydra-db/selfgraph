<p align="center">
  <img src="https://raw.githubusercontent.com/hydra-db/selfgraph/main/assets/logo.png" alt="SelfGraph" width="92" />
</p>

<h1 align="center">SelfGraph for TypeScript</h1>

<p align="center">
  <b>Turn unstructured text into a queryable, versioned knowledge graph.</b><br/>
  One graph API over any graph backend. A native TypeScript port of the Python SDK.
</p>

## What's included

- Text-to-graph extraction with any LLM through the AI SDK, or without an LLM via a zero-dependency fallback.
- Typed CRUD over entities, relations, preferences, and decision traces.
- Bitemporal versioning, source provenance, and per-namespace isolation.
- An optional schema that guides extraction and validates every write (inserts and entity and relation `create` and `update`), with warn, strict, or off modes; in warn mode a `create` or `update` violation is written to stderr as `selfgraph: schema warning [<code>]: <message>` ([docs](https://github.com/hydra-db/selfgraph/blob/main/docs/schema.md)).
- Inputs (ontologies, schemas, `instructions`, `prompts`) reject unknown keys with a `ValidationError` that names the key and suggests the closest one, e.g. `unknown key 'entites' in ontology; did you mean 'entities'?`.
- Retrieval from keyword seeds and bounded BFS, DFS, or personalized PageRank, returning source passages and relationships, no vector store.
- A CLI and an MCP server over the same API.
- One storage interface across backends: Neo4j, Memgraph, FalkorDB, embedded Kuzu, HydraDB, or a custom store.

It is pure TypeScript: no Python, no native addon, no service to run.

## Install

```bash
npm install @hydradb/selfgraph                            # core: Neo4j, the openCypher family, and HydraDB
npm install @hydradb/selfgraph kuzu                       # the embedded Kuzu backend
npm install @hydradb/selfgraph falkordb                   # the FalkorDB backend
npm install @hydradb/selfgraph ai @ai-sdk/anthropic       # LLM extraction (any AI SDK provider)
npm install @hydradb/selfgraph js-tiktoken                # token-aware chunking and budgets
npm install @hydradb/selfgraph @modelcontextprotocol/sdk  # the MCP server
```

Node 20 or newer. ESM and CommonJS are both supported.

## Quickstart

No server and no LLM. `npm install @hydradb/selfgraph kuzu` and run:

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

const result = await graph.retrieve("who works at Acme");
console.log(result.context);
await graph.close();
```

The store initializes lazily on first use. In TypeScript 5.2+ (or JavaScript on Node 24+), `await using graph = new SelfGraph(...)` closes it automatically at the end of the scope.

With an LLM and a server:

```ts
import { Neo4jStore, SelfGraph } from "@hydradb/selfgraph";

const graph = new SelfGraph(new Neo4jStore("bolt://localhost:7687", { auth: ["neo4j", "password"] }), {
  llm: { provider: "anthropic", model: "claude-sonnet-5-5" },
});

await graph.insert.text("Soham prefers HydraDB. The team picked it for temporal history.");
const result = await graph.retrieve("which database and why", { strategy: "bfs", depth: 3 });
console.log(result.context);
await graph.close();
```

`llm` accepts an `LLMConfig` (`provider`, `model`, `api_key`, `base_url`), any AI SDK model object such as `anthropic("claude-sonnet-5-5")`, or your own `LLMClient`. Set `provider: "gateway"` with `model: "openai/gpt-4o"` to route any vendor through the Vercel AI Gateway (`npm install @ai-sdk/gateway`, `AI_GATEWAY_API_KEY` or `api_key`); point `base_url` at any OpenAI-compatible endpoint for the rest. Without it, `insert.text` extracts with the regex fallback; there is no spaCy path. Skip extraction entirely with `insert.ontology(...)` or pass your own `extractor`.

## Backends

All logic lives in the SDK; a store only implements a small set of graph primitives, so the same graph runs on any backend.

```ts
import { CypherStore, FalkorDBStore, HydraDBStore, KuzuStore, Neo4jStore } from "@hydradb/selfgraph";

new Neo4jStore("bolt://localhost:7687", { auth: ["neo4j", "password"] });
new CypherStore("bolt://localhost:7687", { auth: ["user", "password"] });
new FalkorDBStore("localhost", 6379);
new KuzuStore("selfgraph.kuzu");
new HydraDBStore("bolt://127.0.0.1:17687", { auth: ["neo4j", "<token>"] });
```

With no store configured (`SelfGraph.connect()`, `fromEnv()`, the CLI, MCP), SelfGraph uses embedded Kuzu at `~/.selfgraph/default.kuzu` when there is no URI, and HydraDB when there is one. `memgraph` is accepted as a store name and uses `CypherStore`.

`KuzuStore` creates the file's folder if needed. Each open Kuzu database reserves 8 TB of virtual memory by default, so a process that keeps many open at once can run out of address space; pass `max_db_size` in bytes, as in `new KuzuStore("graph.kuzu", { max_db_size: 2 ** 30 })`, or close each graph when done. `HydraDBStore` authenticates with the token in the second slot of `auth`; the first slot can be any non-empty name. HydraDB 0.4.0 or newer is required.

`graph.runCypher()` sees each backend's physical storage, and what it accepts differs: Neo4j, Memgraph, and FalkorDB store nodes under their labels with the SelfGraph id in `n.id`; Kuzu keeps every node in table `N` and every edge in table `R`, with the record as JSON in `doc`, and rejects unused parameters; HydraDB runs a narrow openCypher subset (reliably `MATCH (n:Label) ... RETURN n.prop` with a predicate), where `n.id` is HydraDB's internal integer key and the SelfGraph id is `n.sid`. An integer beyond `Number.MAX_SAFE_INTEGER` in a row comes back as a `bigint`, so pass rows through `toJsonable()` before `JSON.stringify`.

To add another database, extend `CypherPrimitives` and implement `_run`, or implement the `GraphStore` interface directly, then pass the store to `new SelfGraph(store)`.

## Retrieval

`graph.retrieve(query, { strategy, depth, k, max_nodes, budget_tokens })` seeds from the entities that best match the query, then walks the graph. Queries are matched as NFC-normalized, casefolded Unicode words, so `HAUPTSTRASSE` finds `Hauptstraße` and `東京` finds `東京タワー`. Seeds score by BM25 plus substring hits, divided by the log of how many sources mention the entity, so a generic entity does not crowd out a specific one. `strategy: "bfs"` or `"dfs"` keeps the nearest `max_nodes` entities; `"ppr"` collects a wider BFS neighborhood and keeps the `max_nodes` entities ranked highest by personalized PageRank from the seeds, so an entity reachable through many well-sourced paths outranks one that is merely close.

## Writes, ids, and concurrency

Ids are deterministic: an entity is `type:name` with the name canonicalized and NFC-normalized, so `Acme`, `Acme, Inc.` and `The Acme Corporation` share `company:acme` (article and suffix stripping applies to organization-like types only; a Work "The Trial" stays `work:the-trial`). `entityId(type, name)` computes the id a name resolves to. Inserts are idempotent upserts, so re-running an insert never duplicates data, and an insert that reaches an existing entity under another surface form keeps the stored name and adds the new form to its aliases. `create` with an id that already exists raises `ConflictError`.

Updates merge: properties, aliases, and external ids merge into what is stored, and `remove_properties` / `remove_aliases` drop entries. Relations and preferences keep every version (`relations.versions(id)`, `preferences.versions(id)`); an update that changes nothing is a no-op. Decisions are updated in place. Deleting an entity removes its relations, its preferences, and any decision trace that references it.

Concurrency differs by backend. On Neo4j and Memgraph each write serializes on its subject node and a whole insert commits or rolls back as one unit; a lost race raises `TransientError`, which the SDK retries with backoff. HydraDB, Kuzu, and FalkorDB auto-commit, so a batch applies incrementally. They run one write at a time per store object, so concurrent writers in one process behave as on Neo4j; writers in separate processes are not serialized, and concurrent writes there to one entity or edge are last-writer-wins.

## Coming from the Python SDK

The API is the same shape, with TypeScript naming where it matters:

| Python | TypeScript |
| --- | --- |
| `SelfGraph(store=..., llm=..., namespace=...)` | `new SelfGraph(store, { llm, namespace })` |
| `graph.run_cypher(q, params)` | `graph.runCypher(q, params)` |
| `graph.entities.create(name, type, id=..., properties=...)` | `graph.entities.create(name, type, { id, properties })` |
| `graph.relations.versions(id, newest_first=False)` | `graph.relations.versions(id, { newest_first: false })` |
| `graph.preferences.list()` (every subject) | `graph.preferences.list()` or `graph.preferences.list({ key })` |
| `selfgraph.entity_id(type, name)` | `entityId(type, name)` |
| `graph.retrieve(q, max_nodes=100)` | `graph.retrieve(q, { max_nodes: 100 })` |
| `async for e in graph.entities.iterate()` | `for await (const e of graph.entities.iterate())` |
| `SelfGraph.from_env()` / `SelfGraph.connect(...)` | `SelfGraph.fromEnv()` / `SelfGraph.connect({...})` |
| `async with SelfGraph(...)` | `await using graph = new SelfGraph(...)` |
| `SyncSelfGraph` | not needed; JavaScript is async-native |

Method names are camelCase. Every model field and option key keeps its Python name (`from_entity`, `event_time`, `next_cursor`, `budget_tokens`), so ontology JSON files, MCP payloads, and docs carry over unchanged. Timestamps are `Date` objects; inputs also accept ISO text. In an update, an omitted field keeps its value. On a decision, `null` clears a field, as an explicit `None` does in Python; on a relation or preference, `null` keeps the value like an omitted field, as `None` does in Python, so `event_time` and `strength` cannot be cleared there. Evidence is only ever added to: each item is its own record, listed with `graph.entities.evidence(id, { cursor, limit })` or `graph.relations.evidence(id, { cursor, limit })` as a `Page` like `list`, and an entity or relation carries `source_count`, the number of distinct sources behind it. `entityId`, `relationId`, `preferenceId`, `decisionId`, `profileId`, and `normalizeRelType` are exported from the root, like the Python package; the other id helpers live under the `ids` namespace. Error messages name types the way Python does (`str`, `NoneType`), so both SDKs report identical text.

`create` raises `ConflictError` when the id exists and `delete` raises `NotFoundError` when it does not. The relation types `PREFERS`, `AVOIDS`, `HAS_PROFILE`, `MADE_DECISION`, `HAS_STEP`, `FROM`, `TO`, `RESULTED_IN`, `CONSIDERED`, `HAS_VERSION`, and `HAS_CHUNK` are reserved for edges SelfGraph writes itself. A new decision's `status` defaults to `"completed"`.

## Interoperability with Python

Both SDKs derive the same ids, store the same properties in the same encoding, and version the same way, so either one can read and extend a graph the other wrote. The test suite checks this on every backend: each side writes a graph and the other reads it back byte for byte.

## CLI and MCP

```bash
npx @hydradb/selfgraph --store neo4j --uri bolt://localhost:7687 --auth neo4j:password insert text "..." --source-id notes
npx @hydradb/selfgraph --store neo4j --uri bolt://localhost:7687 --auth neo4j:password mcp
```

The CLI and the MCP server expose the same commands and 29 tools as the Python ones, read the same `SELFGRAPH_*` environment variables, and print the same JSON. A failing tool returns an MCP error result (`isError` set) whose content is `{error, error_type}`. The MCP `run_cypher` tool is read-only: it rejects any write, schema, transaction, or admin statement, including `INSERT`, a write keyword used as a bare alias, and any `\u` unicode escape (a keyword guard, not a sandbox), while `graph.runCypher()` in code runs anything. It is not scoped to the namespace and sees every namespace in the database. The relation, preference, and decision write tools take an optional ISO 8601 `event_time`, `insert_text` also takes `metadata`, and `update_decision` clears a nullable field on an explicit `null`. `import { buildServer, TOOLS, close } from "@hydradb/selfgraph/mcp"` embeds the server in your own process; `await close()` closes the tools' shared graph so the process can exit.

## Known issues

- HydraDB writes its Bolt handshake reply in more than one packet, which neo4j-driver for JavaScript does not reassemble, so many new connections fail before any query is sent. `HydraDBStore.initialize()` opens a first pooled connection and every query retries a failed handshake with jitter; both are safe because nothing has run yet. The Python driver is unaffected.
- Entity id canonicalization follows Python's `\w`, which excludes combining marks, so names in scripts that use them (Devanagari, for example) are split at those marks. Both SDKs derive the same ids.
- The `kuzu` npm package is deprecated upstream; the Python SDK depends on the same release.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

Integration tests run against whichever backends are reachable (see `test/helpers.ts`; select some with `SELFGRAPH_TEST_STORES=neo4j,kuzu`). The cross-language conformance test runs when `SELFGRAPH_PY` points at a Python that has `selfgraph` installed. `test/fixtures/generate_parity.py` regenerates the Python parity fixture.

## License

Apache-2.0.

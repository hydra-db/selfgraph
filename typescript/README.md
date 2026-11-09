<p align="center">
  <img src="https://raw.githubusercontent.com/hydra-db/selfgraph/main/assets/logo.png" alt="SelfGraph" width="92" />
</p>

<h1 align="center">SelfGraph for TypeScript</h1>

<p align="center">
  <b>Turn unstructured text into a queryable, versioned knowledge graph.</b><br/>
  One graph API over any graph database. A native TypeScript port of the Python SDK.
</p>

## Why SelfGraph

- **Text in, graph out.** Extract entities and relations with any LLM through the AI SDK, or without one.
- **Any graph database.** Neo4j, Memgraph, FalkorDB, HydraDB, or embedded Kuzu, behind one API.
- **History built in.** Every change is versioned, newer facts can retire older ones, and you can read the graph as of any past time.
- **No vector store.** Retrieval walks the graph from keyword matches and returns the source passages.
- **Same graph as Python.** Both SDKs derive the same ids and storage, so either can read what the other wrote.

## Install

```bash
npm install @hydradb/selfgraph                        # Neo4j, Memgraph, and HydraDB
npm install @hydradb/selfgraph kuzu                   # plus embedded Kuzu
npm install @hydradb/selfgraph ai @ai-sdk/anthropic   # plus LLM extraction (any AI SDK provider)
```

Node 20 or newer, ESM and CommonJS. Other optional packages (FalkorDB, js-tiktoken, the MCP SDK) and the provider list are in [TypeScript](https://github.com/hydra-db/selfgraph/blob/main/docs/typescript.md#install).

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
  const result = await graph.retrieve("which database and why");
  console.log(result.context);
} finally {
  await graph.close();
}
```

Close the graph when you are done: an open server connection keeps Node running. `await using` does it for you (TypeScript 5.2+ or Node 24+).

## Backends

```ts
import { CypherStore, FalkorDBStore, HydraDBStore, KuzuStore, Neo4jStore } from "@hydradb/selfgraph";

new Neo4jStore("bolt://localhost:7687", { auth: ["neo4j", "password"] });
new CypherStore("bolt://localhost:7687", { auth: ["user", "password"] }); // Memgraph and other Bolt engines
new FalkorDBStore("localhost", 6379);
new KuzuStore("graph.kuzu");                                              // embedded
new HydraDBStore("bolt://127.0.0.1:17687", { auth: ["neo4j", "<token>"] }); // HydraDB 0.4.0 or newer
```

See [backends](https://github.com/hydra-db/selfgraph/blob/main/docs/backends.md) to configure from settings or add your own store.

## CLI and MCP

```bash
npx @hydradb/selfgraph --store neo4j --uri bolt://localhost:7687 insert text "Jane runs Acme." --source-id notes
npx @hydradb/selfgraph --store neo4j --uri bolt://localhost:7687 mcp
```

The CLI and MCP server match the Python ones. Stdio MCP clients do not pass your shell environment, so set the connection in `env`:

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

## Documentation

The [docs](https://github.com/hydra-db/selfgraph/tree/main/docs) cover both SDKs. [TypeScript](https://github.com/hydra-db/selfgraph/blob/main/docs/typescript.md) maps Python names to TypeScript, lists the differences and known issues, and has the development commands.

## License

Apache-2.0.

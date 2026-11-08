<p align="center">
  <img src="https://raw.githubusercontent.com/hydra-db/selfgraph/main/assets/logo.png" alt="SelfGraph" width="92" />
</p>

<h1 align="center">SelfGraph</h1>

<p align="center">
  <b>Turn unstructured text into a queryable, versioned knowledge graph.</b><br/>
  One graph API over any graph backend, in Python and TypeScript.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/node-20%2B-3178C6?logo=typescript&logoColor=white" alt="TypeScript, Node 20+" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3DA639" alt="License Apache-2.0" />
  <img src="https://img.shields.io/badge/backends-any%20graph%20DB-FF5719" alt="Any graph backend" />
  <img src="https://img.shields.io/badge/interfaces-SDK%20%7C%20CLI%20%7C%20MCP-6E56CF" alt="Interfaces SDK, CLI, MCP" />
  <img src="https://img.shields.io/badge/built%20by-HydraDB-FF5719" alt="Built by HydraDB" />
  <a href="https://discord.gg/HcBKJHXmnu"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

## What's included

- Text-to-graph extraction with any LLM provider, or without an LLM via spaCy NER or a zero-dependency fallback.
- Typed CRUD over entities, relations, preferences, and decision traces.
- An optional schema that guides extraction and validates inserts, with warn, strict, or off modes.
- Bitemporal versioning, source provenance, and per-namespace isolation.
- Retrieval from keyword seeds and bounded BFS, DFS, or personalized PageRank, returning source passages and relationships, no vector store.
- A CLI and an MCP server over the same API.
- One storage interface across backends: Neo4j, Memgraph, FalkorDB, embedded Kuzu, HydraDB, or a custom store.
- A pure TypeScript SDK in [typescript/](typescript/) that reads and writes the same graph as the Python one.

## Install

```bash
pip install selfgraph                 # core: Neo4j, the openCypher family, and HydraDB
pip install "selfgraph[llm]"          # LLM text extraction for any provider
pip install "selfgraph[ner]"          # LLM-free extraction via spaCy NER
pip install "selfgraph[falkordb]"     # the FalkorDB backend
pip install "selfgraph[kuzu]"         # the embedded Kuzu backend
pip install "selfgraph[all]"          # llm, tokenizer, ner, falkordb, kuzu, mcp
```

spaCy NER also needs its English model: `python -m spacy download en_core_web_sm`.
Without it, extraction falls back to a built-in regex pass.

For TypeScript, `npm install @hydradb/selfgraph`. See [typescript/README.md](typescript/README.md).

## Quickstart

No server and no LLM. `pip install "selfgraph[kuzu]"` and run:

```python
import asyncio

from selfgraph import KuzuStore, SelfGraph


async def main() -> None:
    async with SelfGraph(store=KuzuStore("graph.kuzu")) as graph:
        await graph.insert.ontology(
            {
                "entities": [
                    {"id": "person:jane", "type": "Person", "name": "Jane Doe"},
                    {"id": "company:acme", "type": "Company", "name": "Acme"},
                ],
                "relations": [
                    {"from_entity": "person:jane", "type": "WORKS_AT", "to_entity": "company:acme"},
                ],
            }
        )
        result = await graph.retrieve("who works at Acme")
        print(result.context)


asyncio.run(main())
```

`async with` initializes the store on entry and closes it on exit; it also initializes lazily on first use, so a bare `SelfGraph(...)` works too. Prefer synchronous code? `SyncSelfGraph` has the same API without `await`.

With an LLM and a server:

```python
from selfgraph import LLMConfig, Neo4jStore, SelfGraph

async with SelfGraph(
    store=Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password")),
    llm=LLMConfig(provider="anthropic", model="claude-sonnet-5-5"),
) as graph:
    await graph.insert.text("Soham prefers HydraDB. The team picked it for temporal history.")
    result = await graph.retrieve("which database and why", strategy="bfs", depth=3)
    print(result.context)
```

`llm=` is optional. Without it, `insert.text` extracts with spaCy NER (the `ner` extra) or a built-in regex fallback. Skip extraction entirely with `insert.ontology(...)` or by passing your own `extractor=`.

## Backends

All logic lives in the SDK; a store only implements a small set of graph primitives, so the same graph runs on any backend.

```python
from selfgraph import Neo4jStore, CypherStore, FalkorDBStore, KuzuStore, HydraDBStore

Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password"))
CypherStore("bolt://localhost:7687", auth=("user", "password"))
FalkorDBStore(host="localhost", port=6379)
KuzuStore("selfgraph.kuzu")
HydraDBStore("bolt://127.0.0.1:17687", auth=("neo4j", "<token>"))
```

`CypherStore` covers the Bolt and openCypher family (Neo4j and Memgraph are tested); `FalkorDBStore` runs over FalkorDB's Redis protocol; `KuzuStore` is an embedded, in-process graph; `HydraDBStore` targets HydraDB 0.4.0 or newer. To add another database, implement the `GraphStore` primitives and pass your store to `SelfGraph(store=...)`.

The CLI and the MCP server wrap the same API:

```bash
selfgraph --store neo4j --uri bolt://localhost:7687 --auth neo4j:password insert text "..." --source-id notes
selfgraph --store neo4j --uri bolt://localhost:7687 --auth neo4j:password mcp
```

## Documentation

Full docs are in [docs/](https://github.com/hydra-db/selfgraph/tree/main/docs): [install](https://github.com/hydra-db/selfgraph/blob/main/docs/install.md), [quickstart](https://github.com/hydra-db/selfgraph/blob/main/docs/quickstart.md), [inserting](https://github.com/hydra-db/selfgraph/blob/main/docs/inserting.md), [schema](https://github.com/hydra-db/selfgraph/blob/main/docs/schema.md), [resources](https://github.com/hydra-db/selfgraph/blob/main/docs/resources.md), [retrieval](https://github.com/hydra-db/selfgraph/blob/main/docs/retrieval.md), [backends](https://github.com/hydra-db/selfgraph/blob/main/docs/backends.md), [CLI](https://github.com/hydra-db/selfgraph/blob/main/docs/cli.md), [MCP](https://github.com/hydra-db/selfgraph/blob/main/docs/mcp.md), [errors](https://github.com/hydra-db/selfgraph/blob/main/docs/errors.md), and [TypeScript](https://github.com/hydra-db/selfgraph/blob/main/docs/typescript.md).

## Contributing

Issues and pull requests are welcome. Contributions start with an approved issue; see [CONTRIBUTING.md](CONTRIBUTING.md). Join the community on [Discord](https://discord.gg/HcBKJHXmnu).

## License

Apache-2.0.

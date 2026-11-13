<p align="center">
  <img src="https://raw.githubusercontent.com/hydra-db/selfgraph/main/assets/logo.png" alt="SelfGraph" width="92" />
</p>

<h1 align="center">SelfGraph</h1>

<p align="center">
  <b>Turn unstructured text into a queryable, versioned knowledge graph.</b><br/>
  One SDK for graphs and ontologies, over any graph database, in Python and TypeScript.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/node-20%2B-3178C6?logo=typescript&logoColor=white" alt="TypeScript, Node 20+" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3DA639" alt="License Apache-2.0" />
  <a href="https://discord.gg/HcBKJHXmnu"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

## Why SelfGraph

- **Text in, graph out.** Extract entities and relations with any LLM, or without one.
- **Any graph database.** Neo4j, Memgraph, FalkorDB, HydraDB, or embedded Kuzu, behind one API.
- **Facts that change.** Every change is versioned, newer facts retire older ones, and you can read the graph as of any past time.
- **An ontology, not just a graph.** Types, synonyms, and definitions ground a question, and a coverage check says what the graph cannot answer.
- **Light by default, powerful on request.** One `level` option moves every capability from free and deterministic to LLM-backed.
- **No vector store.** Retrieval walks the graph from keyword matches and returns the source passages. Embeddings are optional.
- **SDK, CLI, and MCP server** over the same graph.

## Install

```bash
pip install selfgraph            # Neo4j, Memgraph, and HydraDB
pip install "selfgraph[all]"     # plus LLM extraction, Kuzu, FalkorDB, spaCy, tiktoken, and MCP
```

Every extra is listed in [install](https://github.com/hydra-db/selfgraph/blob/main/docs/install.md). For TypeScript, see [typescript/README.md](https://github.com/hydra-db/selfgraph/blob/main/typescript/README.md).

## Quickstart

No server and no LLM, with `pip install "selfgraph[kuzu]"`:

```python
import asyncio

from selfgraph import KuzuStore, SelfGraph


async def main() -> None:
    async with SelfGraph(store=KuzuStore("graph.kuzu")) as graph:
        await graph.insert.facts(
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

With an LLM and a server:

```python
from selfgraph import LLMConfig, Neo4jStore, SelfGraph

async with SelfGraph(
    store=Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password")),
    llm=LLMConfig(provider="anthropic", model="claude-sonnet-5-5"),
) as graph:
    await graph.insert.text("Soham prefers HydraDB. The team picked it for temporal history.")
    result = await graph.retrieve("which database and why")
    print(result.context)
```

`SyncSelfGraph` has the same API without `await`. Without an LLM, `insert.text` falls back to spaCy or a simple regex pass; see [inserting](https://github.com/hydra-db/selfgraph/blob/main/docs/inserting.md).

## Levels

Every capability is a ladder of tiers, and `level` sets them all. The default, `balanced`, is the strongest tier that is free and deterministic.

| Capability | `light` | `balanced` (default) | `max` |
|------------|---------|----------------------|-------|
| Extraction | regex | spaCy, else regex | LLM |
| Entity resolution | derived ids | name and alias match | LLM-confirmed |
| Contradictions | warn on schema limits | warn on schema limits | LLM-judged, no schema needed |
| Retrieval seeds | BM25 | BM25 plus schema synonyms | plus embeddings, with your embedder |
| Traversal | BFS | BFS | PageRank |

```python
graph = SelfGraph(store=store, llm=llm, level="max")  # everything on
graph = SelfGraph(store=store, llm=llm, contradiction="llm")  # one capability
graph = SelfGraph(store=store, llm=llm, level="max", max_tier="balanced")  # cap: no LLM calls
print(graph.tiers)
```

- Passing `llm=` turns on LLM extraction only. Every other LLM tier is opt-in.
- A higher tier runs the lower ones first and sends only the undecided cases up, so cost follows the hard cases.
- Every tier writes the same ids and encoding. Changing a tier needs no migration.
- Each result reports the tiers that produced it in `result.tiers`.

See [tiers](https://github.com/hydra-db/selfgraph/blob/main/docs/tiers.md).

## Facts that change

A newer fact can retire an older one. Declare the rule in a schema, or let an LLM judge it with no schema:

```python
graph = SelfGraph(store=store, llm=llm, contradiction="llm")
await graph.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2020-01-01")
await graph.relations.create("person:ann", "WORKS_AT", "company:globex", event_time="2022-01-01")

await graph.retrieve("where does Ann work")  # Globex
await graph.retrieve("where does Ann work", as_of="2021-06-01")  # Acme
```

Nothing is deleted. The retired relation keeps its history and records what replaced it. See [contradictions](https://github.com/hydra-db/selfgraph/blob/main/docs/schema.md#contradictions).

## Ontology and coverage

A schema can carry synonyms, certified definitions, and where each term's data lives. `coverage` then tells an agent what the graph can ground before it answers:

```python
schema = {
    "entities": [
        {
            "name": "Company",
            "synonyms": ["employer", "firm"],
            "definitions": [{"name": "headcount", "expression": "count(Person)", "synonyms": ["staff size"]}],
        }
    ]
}
graph = SelfGraph(store=store, schema=schema)

cov = await graph.coverage("What is the staff size of the firm Acme by ad spend?")
cov.uncovered  # ["ad", "spend"]
await graph.retrieve("which employers")  # seeds Company entities through the synonym
```

`Schema.from_tables` drafts a schema from table and column metadata, with no database connection. See [ontology](https://github.com/hydra-db/selfgraph/blob/main/docs/ontology.md).

## Backends

```python
from selfgraph import CypherStore, FalkorDBStore, HydraDBStore, KuzuStore, Neo4jStore

Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password"))
CypherStore("bolt://localhost:7687", auth=("user", "password"))  # Memgraph and other Bolt engines
FalkorDBStore(host="localhost", port=6379)
KuzuStore("graph.kuzu")  # embedded
HydraDBStore("bolt://127.0.0.1:17687", auth=("neo4j", "<token>"))  # HydraDB 0.4.0 or newer
```

See [backends](https://github.com/hydra-db/selfgraph/blob/main/docs/backends.md) to configure from settings or add your own store.

## CLI and MCP

```bash
export SELFGRAPH_AUTH=neo4j:password
selfgraph --store neo4j --uri bolt://localhost:7687 insert text "Jane runs Acme." --source-id notes
selfgraph --store neo4j --uri bolt://localhost:7687 retrieve "who runs Acme" --context-only
```

`selfgraph mcp` serves the same API as MCP tools. Stdio clients do not pass your shell environment, so set the connection in `env`:

```json
{
  "mcpServers": {
    "selfgraph": {
      "command": "selfgraph",
      "args": ["mcp"],
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

- [Install](https://github.com/hydra-db/selfgraph/blob/main/docs/install.md) and [quickstart](https://github.com/hydra-db/selfgraph/blob/main/docs/quickstart.md)
- [Inserting](https://github.com/hydra-db/selfgraph/blob/main/docs/inserting.md): text, facts, LLM setup, custom prompts
- [Tiers](https://github.com/hydra-db/selfgraph/blob/main/docs/tiers.md): the `level` preset and the cost cap
- [Schema](https://github.com/hydra-db/selfgraph/blob/main/docs/schema.md): types, validation, contradictions, Neo4j interop
- [Ontology](https://github.com/hydra-db/selfgraph/blob/main/docs/ontology.md): terms, synonyms, coverage checks, drafts from table metadata
- [Entity resolution](https://github.com/hydra-db/selfgraph/blob/main/docs/resolution.md): merging duplicates
- [Resources](https://github.com/hydra-db/selfgraph/blob/main/docs/resources.md): entities, relations, preferences, decisions, ids
- [Retrieval](https://github.com/hydra-db/selfgraph/blob/main/docs/retrieval.md) and [maintenance](https://github.com/hydra-db/selfgraph/blob/main/docs/maintenance.md)
- [Backends](https://github.com/hydra-db/selfgraph/blob/main/docs/backends.md), [CLI](https://github.com/hydra-db/selfgraph/blob/main/docs/cli.md), [MCP](https://github.com/hydra-db/selfgraph/blob/main/docs/mcp.md), [errors](https://github.com/hydra-db/selfgraph/blob/main/docs/errors.md), [TypeScript](https://github.com/hydra-db/selfgraph/blob/main/docs/typescript.md)

## Contributing

Contributions start with an approved issue; see [CONTRIBUTING.md](https://github.com/hydra-db/selfgraph/blob/main/CONTRIBUTING.md). Join us on [Discord](https://discord.gg/HcBKJHXmnu).

## License

Apache-2.0.

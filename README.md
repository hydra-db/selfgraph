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
- Typed CRUD over entities, relations, preferences, and decision traces, with bitemporal versioning, source provenance, and per-namespace isolation.
- An optional schema that guides extraction and validates every write (warn, strict, or off), with contradiction handling on `max_count`: warn, or let the newer fact supersede the older one.
- Optional entity resolution that merges duplicates on insert by external id, alias, or name similarity, with a reversible record of every merge.
- Retrieval from keyword seeds and bounded BFS, DFS, or personalized PageRank, returning source passages and relationships with no vector store, optionally as of a past time.
- Explicit maintenance: relevance decay, pruning, and merging duplicate relations, dry runs by default.
- Schema import and export in the Neo4j graph schema JSON that neo4j-graphrag uses.
- A CLI and an MCP server over the same API, and one storage interface across Neo4j, Memgraph, FalkorDB, embedded Kuzu, HydraDB, or a custom store.
- A pure TypeScript SDK in [typescript/](https://github.com/hydra-db/selfgraph/tree/main/typescript) that reads and writes the same graph.

## Install

```bash
pip install selfgraph                 # core: Neo4j, the openCypher family, and HydraDB
pip install "selfgraph[llm]"          # LLM text extraction for any provider
pip install "selfgraph[ner]"          # LLM-free extraction via spaCy NER (then: python -m spacy download en_core_web_sm)
pip install "selfgraph[falkordb]"     # the FalkorDB backend
pip install "selfgraph[kuzu]"         # the embedded Kuzu backend
pip install "selfgraph[mcp]"          # the MCP server
pip install "selfgraph[all]"          # llm, tokenizer, ner, falkordb, kuzu, mcp
```

For TypeScript, `npm install @hydradb/selfgraph`; see [typescript/README.md](https://github.com/hydra-db/selfgraph/blob/main/typescript/README.md).

## Quickstart

No server and no LLM, with `pip install "selfgraph[kuzu]"`:

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

`async with` initializes the store on entry and closes it on exit; a bare `SelfGraph(...)` also initializes lazily on first use. Closing a graph closes the store you passed in, so build a new store for each `SelfGraph`. `SyncSelfGraph` has the same API without `await`.

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

Without `llm=`, `insert.text` extracts with spaCy NER (the `ner` extra and its model), which gives NER types such as `Person` and verb-lemma relation types, or else a regex fallback that types every entity `Thing` and links neighbours with `RELATED_TO`. Use an LLM for graphs that matter, or skip extraction with `insert.ontology(...)` or your own `extractor=`.

## Ontology input

`insert.ontology(...)` and `selfgraph insert ontology FILE` take this JSON; unknown keys are rejected. Only `type` and `name` on an entity, and `from_entity`, `type`, and `to_entity` on a relation, are required. An omitted entity `id` is derived as `type:name` with the name canonicalized, so `Acme Corp` and `Acme, Inc.` both become `company:acme`; explicit ids follow the [id rules](https://github.com/hydra-db/selfgraph/blob/main/docs/resources.md#ids). Decision `steps` are relation ids and default to `[]`; `relation_id("person:jane", "WORKS_AT", "company:acme")` returns the one shown.

```json
{
  "entities": [
    {"id": "person:jane", "type": "Person", "name": "Jane Doe", "aliases": ["Jane"],
     "external_ids": {"crm": "c-42"}, "properties": {"role": "CEO"}},
    {"type": "Company", "name": "Acme"}
  ],
  "relations": [
    {"from_entity": "person:jane", "type": "WORKS_AT", "to_entity": "company:acme",
     "properties": {"title": "CEO"}, "event_time": "2024-01-15T00:00:00Z",
     "evidence": [{"source_id": "notes", "quote": "Jane runs Acme."}]}
  ],
  "preferences": [
    {"subject_entity": "person:jane", "key": "database", "value_entity": "company:acme",
     "kind": "preference", "strength": 0.9}
  ],
  "decisions": [
    {"title": "Joined Acme", "steps": ["relation:ec6ca7724d4851341629a9b9"], "actor_entity": "person:jane",
     "rationale": "best offer", "outcome_entity": "company:acme"}
  ]
}
```

See [inserting](https://github.com/hydra-db/selfgraph/blob/main/docs/inserting.md) for inserts and [schema](https://github.com/hydra-db/selfgraph/blob/main/docs/schema.md) for the schema format.

## Helpers

| Helper | Import from | Returns |
|--------|-------------|---------|
| `entity_id(type, name)`, `relation_id(from_entity, type, to_entity)`, `preference_id(subject_entity, kind, key, value_entity)`, `decision_id(actor_entity, title)`, `profile_id(subject_entity)` | `selfgraph` | The id an insert derives. |
| `normalize_rel_type(type)` | `selfgraph` | The stored UPPER_SNAKE relation type. |
| `chunk_text(text, max_tokens=, overlap_tokens=)` | `selfgraph.extraction` | The `Chunk`s extraction would read. |
| `count_tokens(text)` | `selfgraph.extraction.chunking` | Tokens through tiktoken, or an estimate without it. |

Warnings go to the standard `selfgraph` logger (`logging.getLogger("selfgraph")`).

## Configuration

The constructor `SelfGraph(store, ...)` takes objects: `llm` (an `LLMConfig` or an `LLMClient`), `instructions`, `prompts`, `extractor`, `namespace`, `schema`, `schema_mode`, `resolver` (a mode or an `EntityResolver`), and `contradiction`. `SelfGraph.connect(...)` and `SelfGraph.from_env(...)` take flat settings instead, the same ones the CLI flags and `SELFGRAPH_*` variables set: `store`, `uri`, `auth`, `database`, `namespace`, `llm_provider`, `llm_model`, `llm_api_key`, `llm_base_url`, `llm_timeout`, `llm_concurrency`, `schema`, `instructions`, `prompts` (each a dict, inline JSON, or a file path), `schema_mode`, `resolver`, and `contradiction`. Any other key raises `ValidationError`.

```python
LLMConfig(
    provider,
    model,
    api_key=None,
    base_url=None,
    temperature=0.0,
    max_retries=3,
    timeout=120,  # seconds per LLM call, None waits forever
    concurrency=4,  # chunks extracted at once
)


class LLMClient(Protocol):  # used for extraction and resolver="llm"
    async def generate(self, *, system: str, user: str, output: type[T]) -> T: ...  # output is a pydantic model


class EntityResolver(Protocol):  # target_id None keeps the candidate separate
    async def resolve(self, candidate: EntityInput, existing: Sequence[Entity]) -> ResolutionDecision: ...


class Extractor(Protocol):  # replaces LLM, spaCy, and regex extraction
    async def extract(self, document: ParsedDocument) -> Ontology: ...  # whole text, "text/plain", call metadata


instructions = {"entities": "...", "relations": "...", "preferences": "...", "decisions": "..."}  # any subset
prompts = {"entities": {"system": "...", "user": "... {text} ...", "version": "v1"}}  # per pass
```

A prompt override needs `system`, `user`, and `version`, and its `user` must contain `{text}`. `instructions` and `prompts` also apply per call on `insert.text` ([custom prompts](https://github.com/hydra-db/selfgraph/blob/main/docs/inserting.md#custom-prompts)).

## Backends

```python
from selfgraph import CypherStore, FalkorDBStore, HydraDBStore, KuzuStore, Neo4jStore

Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password"))
CypherStore("bolt://localhost:7687", auth=("user", "password"))  # Memgraph and other Bolt engines
FalkorDBStore(host="localhost", port=6379, graph="selfgraph")
KuzuStore("graph.kuzu")  # embedded; no path opens ./selfgraph_kuzu
HydraDBStore("bolt://127.0.0.1:17687", auth=("neo4j", "<token>"))  # HydraDB 0.4.0 or newer
```

All logic lives in the SDK and a store only implements graph primitives, so the same graph runs on any backend; implement `GraphStore` to add one. With no store and no URI, `connect()`, `from_env()`, the CLI, and MCP use `~/.selfgraph/default.kuzu`; with a URI and no store they use HydraDB, so a `.kuzu` path also needs `store="kuzu"`. Kuzu allows one process at a time per database. See [backends](https://github.com/hydra-db/selfgraph/blob/main/docs/backends.md) for auth shapes, concurrency, and what `run_cypher()` sees on each backend.

## CLI and MCP

```bash
export SELFGRAPH_AUTH=neo4j:password    # secrets in the environment, not flags, which ps shows
selfgraph --store neo4j --uri bolt://localhost:7687 insert text "..." --source-id notes
selfgraph --store neo4j --uri bolt://localhost:7687 retrieve "who works at Acme" --context-only
```

The CLI covers the library and adds `init`, `version`, `mcp`, `schema import` and `export`, and a `query` that can write. The MCP server has 34 tools that mirror the library; its `run_cypher` is read-only. Neither raw Cypher path is scoped to the namespace. Stdio MCP clients do not pass your shell environment, so set the connection in the client's `env` block:

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

Full docs are in [docs/](https://github.com/hydra-db/selfgraph/tree/main/docs): [install](https://github.com/hydra-db/selfgraph/blob/main/docs/install.md), [quickstart](https://github.com/hydra-db/selfgraph/blob/main/docs/quickstart.md), [inserting](https://github.com/hydra-db/selfgraph/blob/main/docs/inserting.md), [schema](https://github.com/hydra-db/selfgraph/blob/main/docs/schema.md), [entity resolution](https://github.com/hydra-db/selfgraph/blob/main/docs/resolution.md), [resources](https://github.com/hydra-db/selfgraph/blob/main/docs/resources.md), [retrieval](https://github.com/hydra-db/selfgraph/blob/main/docs/retrieval.md), [maintenance](https://github.com/hydra-db/selfgraph/blob/main/docs/maintenance.md), [backends](https://github.com/hydra-db/selfgraph/blob/main/docs/backends.md), [CLI](https://github.com/hydra-db/selfgraph/blob/main/docs/cli.md), [MCP](https://github.com/hydra-db/selfgraph/blob/main/docs/mcp.md), [errors](https://github.com/hydra-db/selfgraph/blob/main/docs/errors.md), and [TypeScript](https://github.com/hydra-db/selfgraph/blob/main/docs/typescript.md).

## Contributing

Issues and pull requests are welcome. Contributions start with an approved issue; see [CONTRIBUTING.md](https://github.com/hydra-db/selfgraph/blob/main/CONTRIBUTING.md). Join the community on [Discord](https://discord.gg/HcBKJHXmnu).

## License

Apache-2.0.

---
name: selfgraph
description: Use the SelfGraph Python SDK to build and query a knowledge graph from text. Use this when a task needs to turn documents or notes into a graph of entities and relationships, extract structured facts with an LLM, give an agent persistent memory (entity preferences and bitemporal decision traces), version facts as they change over time, or retrieve graph-grounded context (source passages plus relationships) for RAG and question answering. Covers ingestion (insert.text and insert.ontology), typed CRUD over entities, relations, preferences, and decisions, keyword plus graph retrieval, and running against any graph backend (Neo4j, Memgraph, FalkorDB, Kuzu, HydraDB). Reach for this whenever the task mentions a knowledge graph, graph memory, entity or relationship extraction, or graph RAG with SelfGraph.
---

# SelfGraph

## Overview

SelfGraph is a Python SDK that turns unstructured text into a queryable, versioned knowledge graph. Python owns all the logic (merge, versioning, id derivation, validation); a pluggable store backend holds the graph (Neo4j, Memgraph, FalkorDB, embedded Kuzu, or HydraDB).

Use it to ingest text, read and write typed facts, and retrieve LLM-ready context grounded in the source.

Properties to rely on:

- Every method is async, so always `await` SDK calls.
- Ids are deterministic and every insert is an idempotent upsert, so re-inserting the same fact does not duplicate it or bump a version.
- Versioning is bitemporal: changing a relation's or preference's properties creates a new revision and history is preserved.
- Every graph has a `namespace` (default `"default"`) for multi-tenant isolation.
- Core dependencies are only `pydantic` and `neo4j`; everything else is an optional extra.

## Install

```bash
pip install selfgraph
pip install "selfgraph[llm]"
pip install "selfgraph[ner,tokenizer]"
pip install "selfgraph[falkordb,kuzu]"
pip install "selfgraph[all]"
```

Base install gives the Neo4j and openCypher backends, HydraDB, CRUD, ontology insert, and BM25 seeding (built in, no extra). Extras: `[llm]` adds LLM extraction for `insert.text`; `[ner]` adds LLM-free spaCy extraction; `[tokenizer]` adds token budgeting; `[falkordb]` and `[kuzu]` add those backends; `[all]` bundles llm, tokenizer, falkordb, kuzu, and mcp. A backend is required: a Bolt server (Neo4j, Memgraph), FalkorDB, HydraDB, or embedded Kuzu (no server).

## Quick Start

```python
import asyncio
from selfgraph import SelfGraph, Neo4jStore, LLMConfig


async def main():
    async with SelfGraph(
        store=Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password")),
        llm=LLMConfig(provider="openai", model="gpt-4o-mini"),
        namespace="default",
    ) as graph:
        await graph.insert.text(
            "Acme acquired Beta Corp in 2021. Jane Doe led the deal.",
            source_id="doc1",
        )
        acme = await graph.entities.get("company:acme")
        result = await graph.retrieve("who led the Acme acquisition")
        print(result.context)


asyncio.run(main())
```

Use `async with` to initialize on entry and close on exit; the store also initializes lazily on first use, so `await graph.initialize()` is optional. The `llm=` argument is only needed for `insert.text`. `result.context` is ready to feed into an LLM prompt.

## Ingesting data

### From text (needs an LLM)

```python
res = await graph.insert.text(
    text,
    source_id="doc1",
    metadata={"url": "..."},
    event_time=None,
)
```

The result exposes `res.entities`, `res.relations`, `res.preferences`, `res.decisions`, and `res.warnings`. Extraction is non-deterministic and chunks the text, writing Source, Version, and Chunk provenance so `retrieve()` can ground answers in real passages. `source_id` is optional but enables provenance and retrievable passages.

Without an LLM, `insert.text` falls back to `BasicExtractor`: spaCy NER plus subject-verb-object relations when the `ner` extra is installed, otherwise a zero-dependency regex heuristic. It is lower quality than LLM extraction and flags itself in `res.warnings`. For full control with no LLM, build the graph with `insert.ontology` or pass your own `extractor`.

### From a ready-made ontology (no LLM, deterministic)

```python
await graph.insert.ontology(
    {
        "entities": [
            {"id": "company:acme", "type": "Company", "name": "Acme"},
            {"id": "company:beta", "type": "Company", "name": "Beta Corp"},
        ],
        "relations": [
            {
                "from_entity": "company:acme",
                "type": "ACQUIRED",
                "to_entity": "company:beta",
                "properties": {"year": 2021},
            },
        ],
    },
    source_id="import-1",
)
```

The payload may also carry `preferences` and `decisions`. Use this when you already have structured facts (another system produced them, or in tests). No passages are created, so retrieval over these facts is relationships-only.

## Entities

```python
e = await graph.entities.create(
    "Acme",
    "Company",
    id=None,
    aliases=["Acme Inc"],
    external_ids={"crunchbase": "acme"},
    properties={"stage": "seed"},
)
await graph.entities.get("company:acme")
await graph.entities.list(type="Company", name=None, limit=50, cursor=None)
await graph.entities.update("company:acme", properties={"stage": "series-a"})
await graph.entities.delete("company:acme")
```

`create` takes `name` then `type`. If you omit `id` it is derived as `type:canonical-name`. `list` returns a `Page` with `items` and `next_cursor`. `delete` cascades to the entity's relations, preferences, and decision steps.

## Relations (versioned)

```python
r = await graph.relations.create(
    "person:jane",
    "WORKS_AT",
    "company:acme",
    id=None,
    properties={"title": "CEO"},
)
await graph.relations.get(r.id)
await graph.relations.list(from_entity="person:jane", type=None, to_entity=None)
await graph.relations.update(r.id, set_properties={"title": "Chair"})
await graph.relations.versions(r.id)
await graph.relations.delete(r.id)
```

`update` makes a new revision; `versions` returns the full history, newest first. Endpoints and type are immutable; to change them, create a new relation.

## Preferences (agent memory, via profile nodes)

```python
await graph.preferences.create(
    "person:jane",
    "database",
    "company:acme",
    kind="preference",
    strength=0.9,
)
await graph.preferences.list("person:jane", key=None, kind=None)
await graph.preferences.update(pref_id, strength=1.0)
await graph.preferences.delete(pref_id)
```

`create` takes `subject_entity`, `key`, then `value_entity`. `kind` is `"preference"` or `"disinterest"`.

## Decision traces (bitemporal rationale)

```python
await graph.decisions.create(
    "Pick the database",
    steps=[r1.id, r2.id],
    actor_entity="person:jane",
    outcome_entity="company:acme",
    alternative_entities=["company:other"],
    rationale="Needs temporal history.",
    id="decision:db",
)
await graph.decisions.get("decision:db")
await graph.decisions.list(actor_entity="person:jane", status=None)
await graph.decisions.update("decision:db", status="reversed")
await graph.decisions.delete("decision:db")
```

`steps` are the relation ids that justify the decision.

## Retrieval (keyword plus graph to context)

```python
result = await graph.retrieve(
    "who led the Acme acquisition",
    strategy="bfs",
    depth=2,
    k=20,
    max_nodes=200,
    budget_tokens=3000,
)
result.context
result.seeds
result.subgraph
```

`strategy` is `"bfs"` or `"dfs"`. `depth` is hops from each seed, `k` is the max seed entities, `max_nodes` caps the traversal, and `budget_tokens` caps the assembled context. `result.context` holds source passages, relationships, preferences, and decisions, nearest-first, ready for an LLM prompt. `result.seeds` are the entities matched from the query and `result.subgraph` holds everything collected. Passages come from the provenance of `insert.text`, so text-ingested facts retrieve best.

## Backends

```python
from selfgraph import Neo4jStore, CypherStore, FalkorDBStore, KuzuStore, HydraDBStore

Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password"), database=None)
CypherStore("bolt://localhost:7687", auth=("user", "password"))
FalkorDBStore(host="localhost", port=6379)
KuzuStore("selfgraph.kuzu")
HydraDBStore("bolt://127.0.0.1:17687", auth=("neo4j", "<token>"), database="default")
```

`CypherStore` works with any Bolt and openCypher database (Memgraph, Amazon Neptune, and others); `Neo4jStore` is a `CypherStore` that also creates Neo4j uniqueness constraints; `FalkorDBStore` runs over FalkorDB's Redis protocol (needs the `falkordb` extra); `KuzuStore` is an embedded in-process graph (needs the `kuzu` extra). All SDK logic is identical across backends. To target a store that is not Bolt or Cypher, implement the `GraphStore` primitives and pass your store to `SelfGraph(store=...)`. Raw Cypher via `await graph.run_cypher(query, params)` is a backend-specific escape hatch and is not portable across dialects.

## CLI and MCP

The same API is available as a CLI and an MCP server with no Python needed:

```bash
selfgraph init
selfgraph insert text "Acme acquired Beta."
selfgraph entity get company:acme
selfgraph retrieve "who led the acquisition"
selfgraph mcp
```

`selfgraph mcp` runs the MCP server over stdio with 20 tools. Configure via flags or `SELFGRAPH_*` environment variables (`SELFGRAPH_STORE`, `SELFGRAPH_URI`, `SELFGRAPH_AUTH`, `SELFGRAPH_LLM_PROVIDER`, `SELFGRAPH_LLM_MODEL`).

## Rules and gotchas

- Await every call. `async with SelfGraph(...)` manages setup and teardown; a bare `SelfGraph(...)` still initializes lazily. `SyncSelfGraph` is the same API without `await`.
- `insert.text` needs an LLM (the `[llm]` extra plus `LLMConfig` or a custom extractor); `insert.ontology` does not.
- Ids are derived when omitted (`type:canonical-name` for entities, a hash for relations). Pass explicit ids when you need to reference a fact later, such as decision `steps`.
- Re-inserting unchanged facts is a no-op; changing relation or preference properties makes a new revision, readable via `relations.versions(id)`.
- Keep one `namespace` per tenant; reads and writes never cross namespaces.
- Out of scope by design: embeddings, vector or semantic search, and GraphRAG. Retrieval is lexical (keyword and BM25) plus graph traversal only.

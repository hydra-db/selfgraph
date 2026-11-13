# Landscape

How SelfGraph compares with three nearby projects. The other projects are
described from their READMEs as read on 2026-11-12, not from running them, so
check their current state before quoting this.

## At a glance

| | SelfGraph | Graphiti | Auto Ontology | Graphify |
|---|-----------|----------|---------------|----------|
| What it is | SDK: text to versioned graph | SDK: temporal graphs for agents | App: semantic layer for text-to-SQL | Coding-assistant skill that maps a codebase |
| Input | Text, ontologies | Text and JSON episodes | Database schemas and query history | Code, docs, media |
| LLM | Optional | Required, plus an embedder | Required, plus an embedder | Not for code |
| Storage | Neo4j, Memgraph, FalkorDB, HydraDB, Kuzu | Neo4j, FalkorDB, Neptune | Postgres with pgvector | A JSON file |
| Time | Versions, `event_time`, `as_of` | Validity windows | Certification workflow | None |
| Retrieval | BM25, then graph traversal | Embeddings, BM25, and graph | Embedding search, then SQL | Query, path, explain |
| Languages | Python and TypeScript | Python | Python service, web UI | CLI |

## Graphiti

The direct competitor.

| SelfGraph is ahead on | Graphiti is ahead on |
|-----------------------|----------------------|
| Cost: inserts can run with no LLM. | Contradictions with no schema declared. |
| Determinism: idempotent upserts, stable ids. | Recall: embeddings find paraphrases. |
| Reach: more backends, a TypeScript port, a CLI. | Entity summaries and communities. |
| Reversible merges, no telemetry. | Published benchmarks and adoption. |

Phase 2 closes the right-hand column.

## Auto Ontology

A different problem: it builds a semantic layer over relational databases so
agents write correct SQL. It is a deployed application with a UI, auth, and ten
database connectors. It has no text-to-Cypher.

SelfGraph takes its primitives (terms, mappings, certified definitions, coverage
checks) in phase 3 and leaves the application to others.

## Graphify

An end-user tool for navigating code, not an SDK. The overlap is "a graph, no
embeddings". It is not a target, but it publishes LOCOMO and LongMemEval numbers,
which sets the bar for proof.

## Positioning

Graphiti's temporal graph, without an LLM bill per insert, on any graph
database, in two languages, with an ontology layer that also covers structured
data.

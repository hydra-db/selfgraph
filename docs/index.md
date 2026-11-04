# SelfGraph

SelfGraph builds a knowledge graph from text and reads it back through typed
methods, graph traversal, and raw Cypher. It runs on any graph backend and needs
no vector store.

The graph holds four kinds of records: entities, relations between them,
preferences a subject holds, and decision traces. Every write is an idempotent
upsert with a deterministic id, and relations keep their version history.

## Pages

| Page | Covers |
|------|--------|
| [Install](install.md) | The package and its optional extras. |
| [Quickstart](quickstart.md) | A first graph with no server and no LLM. |
| [Inserting](inserting.md) | `insert.text` extraction and `insert.ontology`. |
| [Resources](resources.md) | Typed CRUD over entities, relations, preferences, and decisions. |
| [Retrieval](retrieval.md) | `retrieve` and how it seeds and traverses. |
| [Backends](backends.md) | The built-in stores and how to add your own. |
| [CLI](cli.md) | The `selfgraph` command. |
| [MCP](mcp.md) | The Model Context Protocol server. |
| [Errors](errors.md) | The exception hierarchy. |

## Scope

SelfGraph builds and reads graphs. Embeddings, vector search, GraphRAG,
text-to-Cypher, and file parsing are out of scope. Point it at a backend that
provides those if you need them.

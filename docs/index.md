# SelfGraph

SelfGraph builds a knowledge graph from text and reads it back through typed
methods, graph traversal, and raw Cypher. It runs on any supported graph backend
and needs no vector store. The Python and TypeScript SDKs share one graph format.

The graph holds entities, relations between them, preferences a subject holds,
and decision traces. Every write is an idempotent upsert with a deterministic id,
and relations and preferences keep their version history.

| Page | Covers |
|------|--------|
| [Install](install.md) | The package and its optional extras. |
| [Quickstart](quickstart.md) | A first graph with no server and no LLM. |
| [Inserting](inserting.md) | `insert.text` extraction and `insert.ontology`. |
| [Schema](schema.md) | An optional type layer that guides extraction and validates writes. |
| [Entity resolution](resolution.md) | Merging duplicate entities on insert, and reversing a merge. |
| [Resources](resources.md) | Typed CRUD over entities, relations, preferences, and decisions. |
| [Retrieval](retrieval.md) | `retrieve`, how it seeds and traverses, and raw Cypher. |
| [Maintenance](maintenance.md) | Relevance decay, pruning, and merging duplicate relations. |
| [Backends](backends.md) | The built-in stores and how to add your own. |
| [CLI](cli.md) | The `selfgraph` command. |
| [MCP](mcp.md) | The Model Context Protocol server. |
| [Errors](errors.md) | The exception hierarchy. |
| [TypeScript](typescript.md) | The npm package and how it differs from Python. |

Embeddings, vector search, GraphRAG, text-to-Cypher, and file parsing are out of
scope.

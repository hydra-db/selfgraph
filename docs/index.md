# SelfGraph

SelfGraph builds a knowledge graph from text. You read it back through typed
methods, graph traversal, or raw Cypher. It runs on any supported graph backend
and needs no vector store. The Python and TypeScript SDKs share one graph format.

The graph holds entities, relations between them, preferences a subject holds,
and decision traces. Every write is an idempotent upsert with a deterministic id.
Relations and preferences keep their version history.

| Page | Covers |
|------|--------|
| [Install](install.md) | The package and its optional extras. |
| [Quickstart](quickstart.md) | A first graph with no server and no LLM. |
| [Inserting](inserting.md) | Extracting from text, and writing ready facts. |
| [Tiers](tiers.md) | The `level` preset, what each level picks, and the cost cap. |
| [Schema](schema.md) | Optional types that guide extraction and check writes. |
| [Ontology](ontology.md) | Terms, synonyms, definitions, grounding a question, and drafts from table metadata. |
| [Entity resolution](resolution.md) | Merging duplicate entities on insert, and undoing a merge. |
| [Resources](resources.md) | Typed CRUD over entities, relations, preferences, and decisions. |
| [Retrieval](retrieval.md) | `retrieve`, how it seeds and traverses, raw Cypher, and Obsidian export. |
| [Answering safely](trust.md) | Readiness, answerability, hubs, and certified facts, for agents. |
| [Maintenance](maintenance.md) | Relevance decay, pruning, and merging duplicate relations. |
| [Backends](backends.md) | The built-in stores and how to add your own. |
| [CLI](cli.md) | The `selfgraph` command. |
| [MCP](mcp.md) | The Model Context Protocol server. |
| [Errors](errors.md) | Exceptions, messages, and logging. |
| [TypeScript](typescript.md) | The npm package and how it differs from Python. |

Out of scope for the core: a vector store, GraphRAG, text-to-Cypher, file
parsing, and row-level database ingestion. Embeddings are an optional
[seeding tier](retrieval.md#seeding-tiers) you supply the embedder for.

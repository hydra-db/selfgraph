# AGENTS.md

Guidance for AI coding agents working in this repository. SelfGraph is a Python
SDK that builds a knowledge graph from unstructured text. Keep changes small,
match the surrounding code, and respect the invariants below.

## Setup and commands

- Python 3.10+. The core depends on `pydantic` and the `neo4j` Bolt driver.
- Install for development: `pip install -e ".[dev]"`. Add `[llm]` to run extraction, `[tokenizer]` for token-aware chunking and budgets. BM25 seeding is built in, no extra needed.
- Build the package: `python -m build`.
- Lint and format before pushing: `ruff check .` and `ruff format .` (config lives in `pyproject.toml`; CI runs `ruff check` and `ruff format --check`).
- The test suite is not committed to this repo and needs a graph backend: a Bolt server (Neo4j by default, or Memgraph), FalkorDB, HydraDB, or embedded Kuzu, selected with `SELFGRAPH_TEST_STORE`. If you add tests, drive async code with `asyncio.run(...)` and do not add `pytest-asyncio`.

## Architecture invariant

Python owns all logic. Merge, versioning, ID derivation, and validation live in
`_ops.py` and the resource classes. A `GraphStore` implements graph primitives
(`upsert_node`, `create_edge`, `get_node`, `match_nodes`, `match_edges`,
`update_current_edge`, and so on); `_ops.py` calls only those and never writes
dialect. Each backend translates the primitives to its own engine: `CypherStore`
to standard openCypher over Bolt (with `Neo4jStore` adding Neo4j constraints),
`FalkorDBStore` reusing the Cypher primitives over FalkorDB's Redis protocol,
`KuzuStore` to embedded Kuzu over a generic single-table schema with json_extract
filtering, `HydraDBStore` to HydraDB's dialect with integer surrogate keys and
auto-commit. Never put business logic in a store, and never make `_ops` backend-aware.

Where things live: `client.py` is the `SelfGraph` entry point. `insert.py` is the
insert namespace, `resources/` holds the typed CRUD, `extraction/` runs LLM
extraction, `retrieval.py` does keyword-seeded BFS/DFS/PageRank retrieval, `llm/` wraps the
LLM through litellm, `stores/` holds the backends (`_cypher.py` is the Cypher
primitive base, `cypher.py` holds `CypherStore` and `Neo4jStore`, `falkordb.py`, `kuzu.py`, `hydradb.py`),
and `runtime.py` is the shared factory
behind `cli.py` and `mcp/server.py`.

## Conventions

- Put docstrings only on functions and methods, in doxygen form: a one-line summary, then `@param <name> (<type>)` and `@return (<type>)`. Do not write module-level or class-level docstrings. Thin pass-through methods take no docstring.
- Do not write narration comments. Keep only functional pragmas such as `# type:`, `# noqa`, and `# pragma`.
- Do not use em dashes anywhere, in code or prose.
- Models are pydantic. IDs are deterministic and every insert is an idempotent upsert; preserve both properties.
- Keep the public surface listed in each module's `__all__` and exposed through the typed resource classes.

## Scope

SelfGraph builds and reads graphs through typed lookups, traversal, and raw
Cypher. Embeddings, vector or semantic search, GraphRAG, English-to-Cypher, file
parsing, and structured input are out of scope for the SDK. Do not add them or
their dependencies to the core.

## Commits

Use short, one-line commit messages.

## Do not

- Do not add a runtime dependency to the core beyond `pydantic` and the `neo4j` driver.
- Do not put logic in a `GraphStore`; keep backend dialects inside the store, not in `_ops`.
- Do not reintroduce file or structured-data ingestion, or an embedding or vector search layer.
- Do not add em dashes, module or class docstrings, or narration comments.

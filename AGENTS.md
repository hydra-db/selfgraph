# AGENTS.md

Guidance for AI coding agents working in this repository. SelfGraph is a Python
SDK that builds a knowledge graph from unstructured text. Keep changes small,
match the surrounding code, and respect the invariants below.

## Setup and commands

- Python 3.10+. The core depends on `pydantic` and the `neo4j` Bolt driver.
- Install for development: `pip install -e ".[dev]"`. Add `[llm]` to run extraction, `[tokenizer]` for token-aware chunking and budgets. BM25 seeding is built in, no extra needed.
- Build the package: `python -m build`.
- `typescript/` is a pure TypeScript port that derives the same ids, stores the same encoding, and versions, validates, and retrieves the same way (it has no spaCy path and no sync client). When you change ids, encoding, validation, or retrieval in Python, port the change there and run `npm test` in `typescript/` with `SELFGRAPH_PY` set to a Python that has this checkout installed; the conformance test compares both sides byte for byte.
- Lint and format before pushing: `ruff check .` and `ruff format .` (config lives in `pyproject.toml`; CI runs `ruff check` and `ruff format --check`).
- In `typescript/`, lint and format with Biome before pushing: `npm run lint` checks and `npm run format` fixes (config lives in `typescript/biome.json`; CI runs `npm run lint`, `typecheck`, `build`, and `test`).
- The test suite lives in `tests/` and needs a graph backend: a Bolt server (Neo4j by default, or Memgraph), FalkorDB, HydraDB, or embedded Kuzu, selected with `SELFGRAPH_TEST_STORE` (or the first entry of `SELFGRAPH_TEST_STORES`, the TypeScript suite's plural selector). Backend connection details accept the TypeScript `SG_*` names first (`SG_NEO4J_URI`, `SG_NEO4J_PASSWORD`, `SG_MEMGRAPH_URI`, `SG_FALKOR_PORT`, `SG_HYDRADB_URI`, `SG_HYDRADB_TOKEN`), then the bare names (`NEO4J_URI`, `NEO4J_AUTH`, `CYPHER_URI`, `FALKOR_PORT`, `HYDRADB_URI`, `HYDRADB_TOKEN`), so one set of variables drives both suites. If you add tests, drive async code with `asyncio.run(...)` and do not add `pytest-asyncio`.

## Architecture invariant

The SDK owns all logic. Merge, versioning, ID derivation, and validation live in
`_ops.py` and the resource classes. A `GraphStore` implements graph primitives
(`upsert_node`, `create_edge`, `get_node`, `match_nodes`, `match_edges`,
`update_current_edge`, and so on); `_ops.py` calls only those and never writes
dialect. Each backend translates the primitives to its own engine: `CypherStore`
to standard openCypher over Bolt (`Neo4jStore` is the same store under the Neo4j name),
`FalkorDBStore` reusing the Cypher primitives over FalkorDB's Redis protocol,
`KuzuStore` to embedded Kuzu over one generic node table and one rel table with
json_extract filtering, `HydraDBStore` to HydraDB's dialect with integer surrogate keys and
auto-commit. Never put business logic in a store, and never make `_ops` backend-aware.

Where things live: `client.py` is the `SelfGraph` entry point. `insert.py` is the
insert namespace, `schema.py` is the optional TBox that guides extraction and
validates inserts (`_neo4j_schema.py` converts it to and from the Neo4j graph
schema), `resolution.py` merges duplicate entities on insert, `resources/` holds the
typed CRUD and `graph.maintenance` (with `_maintenance.py`), `extraction/` runs LLM
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

## Releases

Publishing a GitHub release runs `.github/workflows/publish.yml`, which picks the
registry from the tag. A `vX.Y.Z` tag publishes the Python package to PyPI; bump
`__version__` in `src/selfgraph/__init__.py` first. A `ts-vX.Y.Z` tag publishes
`typescript/` to npm; bump `version` in `typescript/package.json` and
`typescript/package-lock.json` first. Both jobs fail when the tag and the version
differ. Never publish by hand.

## Do not

- Do not add a runtime dependency to the core beyond `pydantic` and the `neo4j` driver.
- Do not put logic in a `GraphStore`; keep backend dialects inside the store, not in `_ops`.
- Do not reintroduce file or structured-data ingestion, or an embedding or vector search layer.
- Do not add em dashes, module or class docstrings, or narration comments.

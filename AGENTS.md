# AGENTS.md

Guidance for AI coding agents working in this repository. SelfGraph is an SDK,
in Python with a TypeScript port, that builds a versioned knowledge graph from
unstructured text and reads it back through typed lookups, traversal, and raw
Cypher. A schema can carry an ontology (terms, synonyms, definitions) that
grounds questions. Every capability is a ladder of tiers set by one `level`
option. Keep changes small, match the surrounding code, and respect the
invariants below.

## Setup and commands

- Python 3.10+. The core depends on `pydantic` and the `neo4j` Bolt driver.
- Install for development: `pip install -e ".[dev]"`. Add `[llm]` to run extraction, `[tokenizer]` for token-aware chunking and budgets. BM25 seeding is built in, no extra needed.
- Build the package: `python -m build`.
- `typescript/` is a pure TypeScript port that derives the same ids, stores the same encoding, and versions, validates, and retrieves the same way (it has no spaCy path and no sync client). When you change ids, encoding, validation, retrieval, tiers, schema fields, or term matching in Python, port the change there and run `npm test` in `typescript/` with `SELFGRAPH_PY` set to a Python that has this checkout installed; the conformance test compares both sides byte for byte.
- Wire formats match across the two SDKs: result and schema keys, CLI flags, `SELFGRAPH_*` variables, MCP tool names and arguments, warning codes, error text, and LLM prompts. The conformance pair (`typescript/test/conformance/py_side.py` and `ts_side.ts`) covers the deterministic paths, including `from_tables`, term matching, coverage, synonym seeding, and `graph.tiers`. Extend both sides when you add a deterministic behaviour. LLM tiers are covered by mirrored tests with a fake client, not by conformance.
- Run `pre-commit install` once; the hook runs ruff, Biome, and `tsc` on each commit. Lint and format before pushing: `ruff check .` and `ruff format .` (config lives in `pyproject.toml`; CI runs `ruff check` and `ruff format --check`).
- In `typescript/`, lint and format with Biome before pushing: `npm run lint` checks and `npm run format` fixes (config lives in `typescript/biome.json`; CI runs `npm run lint`, `typecheck`, `build`, and `test`).
- The test suite lives in `tests/` and needs a graph backend: a Bolt server (Neo4j by default, or Memgraph), FalkorDB, HydraDB, or embedded Kuzu, selected with `SELFGRAPH_TEST_STORE` (or the first entry of `SELFGRAPH_TEST_STORES`, the TypeScript suite's plural selector). Backend connection details accept the TypeScript `SG_*` names first (`SG_NEO4J_URI`, `SG_NEO4J_PASSWORD`, `SG_MEMGRAPH_URI`, `SG_FALKOR_PORT`, `SG_HYDRADB_URI`, `SG_HYDRADB_TOKEN`), then the bare names (`NEO4J_URI`, `NEO4J_AUTH`, `CYPHER_URI`, `FALKOR_PORT`, `HYDRADB_URI`, `HYDRADB_TOKEN`), so one set of variables drives both suites. If you add tests, drive async code with `asyncio.run(...)` and do not add `pytest-asyncio`. Test an LLM or embedder tier with a small fake object that implements `generate` or `embed`, as `tests/test_tiers.py` does; never call a real model. CI runs both suites on embedded Kuzu with the `tokenizer` extra installed.

## Architecture invariant

The SDK owns all logic. Merge, versioning, ID derivation, validation, and the
relation reads and retirements behind contradiction handling live in `_ops.py`
and the resource classes. A `GraphStore` implements graph primitives
(`upsert_node`, `create_edge`, `get_node`, `match_nodes`, `match_edges`,
`update_current_edge`, and so on); `_ops.py` calls only those and never writes
dialect. Each backend translates the primitives to its own engine: `CypherStore`
to standard openCypher over Bolt (`Neo4jStore` is the same store under the Neo4j name),
`FalkorDBStore` reusing the Cypher primitives over FalkorDB's Redis protocol,
`KuzuStore` to embedded Kuzu over one generic node table and one rel table with
json_extract filtering, `HydraDBStore` to HydraDB's dialect with integer surrogate keys and
auto-commit. Never put business logic in a store, and never make `_ops` backend-aware.

Where things live: `client.py` is the `SelfGraph` entry point. `tiers.py` holds the
capability ladders, the `level` presets, and the `max_tier` ceilings. `insert.py` is the
insert namespace, `schema.py` is the optional TBox that guides extraction and
validates inserts (`_neo4j_schema.py` converts it to and from the Neo4j graph
schema, `_tables.py` drafts one from table metadata), `terms.py` matches question words
to schema terms, `resolution.py` merges duplicate entities on insert, `contradiction.py`
is the LLM judge behind `contradiction="llm"`, `resources/` holds the
typed CRUD and `graph.maintenance` (with `_maintenance.py`), `extraction/` runs LLM
extraction, `retrieval.py` does seeded BFS/DFS/PageRank retrieval (BM25, schema synonym,
and embedder seeding) and the `coverage` check, `llm/` wraps the
LLM through litellm, `stores/` holds the backends (`_cypher.py` is the Cypher
primitive base, `cypher.py` holds `CypherStore` and `Neo4jStore`, `falkordb.py`, `kuzu.py`, `hydradb.py`),
and `runtime.py` is the shared factory
behind `cli.py` and `mcp/server.py`. The TypeScript port mirrors these as
`typescript/src/tiers.ts`, `terms.ts`, `tables.ts`, `contradiction.ts`, and so on.

A module that calls an LLM (`resolution.py`, `contradiction.py`) keeps the prompt and the
decision there and asks `_ops` for the reads and writes. `_ops` never calls an LLM or an
embedder.

## Conventions

- Put docstrings only on functions and methods, in doxygen form: a one-line summary, then `@param <name> (<type>)` and `@return (<type>)`. Do not write module-level or class-level docstrings. Thin pass-through methods take no docstring.
- Do not write narration comments. Keep only functional pragmas such as `# type:`, `# noqa`, and `# pragma`.
- Do not use em dashes anywhere, in code or prose.
- Models are pydantic. IDs are deterministic and every insert is an idempotent upsert; preserve both properties.
- Keep the public surface listed in each module's `__all__` and exposed through the typed resource classes.
- A graph option that users set also goes through `runtime.py` (`GraphSettings`, so `SELFGRAPH_*` reads it), the CLI flags, the MCP server, `SyncSelfGraph`, and the matching docs page. `level` and `max_tier` are the model to follow.
- Schema fields have two roles. An alias is rewritten to the schema name on write, so it changes ids. A synonym only matches question words and never changes what is stored. `certified`, `mappings`, and `definitions` are stored and returned, never executed.

## Tiers

Every capability is a ladder of tiers from light to powerful (`tiers.py`, `docs/tiers.md`).
When you add a tier:

- The `balanced` default stays free and deterministic. A tier that calls an LLM or an
  embedder is opt-in and sits above the `balanced` ceiling, so `max_tier` can cap it.
- Passing `llm=` turns on LLM extraction only. No other capability escalates because an
  LLM or an embedder is configured.
- A higher tier runs the lower ones first and takes only what they left undecided.
- Every tier writes the same ids and encoding. A tier never needs a migration.
- Add the tier to `LADDERS`, `PRESETS`, and `CEILINGS` in `tiers.py` and `tiers.ts`.
  Lower a requested tier to the cap first, then check its dependency, so a capped tier
  never raises for a missing LLM or embedder.
- Results report the tier that ran in `tiers` (`InsertResult`, `RetrievalResult`,
  `graph.tiers`): the engine that actually ran, and `custom` for a caller's own object.
- Bound an LLM tier's cost and document the bound. The contradiction judge makes one
  call per new relation that has a rival, and none for unchanged relations.

`docs/tiers.md` lists the rungs that are not built yet. Do not describe them as existing.

## Scope

SelfGraph builds and reads graphs through typed lookups, traversal, and raw
Cypher. A vector store, GraphRAG, English-to-Cypher, file parsing, and row-level
structured input are out of scope for the core. Do not add them or their
dependencies to the core. Embeddings are allowed only as a seeding tier over a
caller-supplied `Embedder`: the SDK ships no embedding model and stores no vectors.
Schema drafts read table metadata the caller passes, never rows or a database.

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
- Do not reintroduce file or row-level structured-data ingestion, a vector store, or a bundled embedding model.
- Do not add em dashes, module or class docstrings, or narration comments.
- Do not make an LLM or embedder tier a default, or let a tier change ids or the stored encoding.
- Do not change one SDK without the other where the two must agree.

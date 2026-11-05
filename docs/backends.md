# Backends

All logic lives in Python. A store implements a small set of graph primitives, so
the same graph runs on any backend. Pass a store to `SelfGraph(store=...)`.

```python
from selfgraph import CypherStore, FalkorDBStore, HydraDBStore, KuzuStore, Neo4jStore

Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password"))
CypherStore("bolt://localhost:7687", auth=("user", "password"))
FalkorDBStore(host="localhost", port=6379)
KuzuStore("graph.kuzu")
HydraDBStore("bolt://127.0.0.1:17687", auth=("neo4j", "<token>"))
```

| Store | Target | Extra |
|-------|--------|-------|
| `Neo4jStore` | Neo4j over Bolt, with Neo4j constraints. | core |
| `CypherStore` | Any Bolt and openCypher database, Memgraph included. | core |
| `FalkorDBStore` | FalkorDB over its Redis protocol. | `falkordb` |
| `KuzuStore` | Embedded Kuzu, in process, no server. | `kuzu` |
| `HydraDBStore` | HydraDB. | core |

Neo4j and Memgraph are tested on Bolt. `KuzuStore` writes to a file path and
needs no server, which makes it the simplest choice for local work and tests.

## From settings

`SelfGraph.connect` and `SelfGraph.from_env` build the store for you from a store
name and connection settings. The environment variables are `SELFGRAPH_STORE`,
`SELFGRAPH_URI`, `SELFGRAPH_AUTH`, `SELFGRAPH_DATABASE`, and `SELFGRAPH_NAMESPACE`.
With no store set, SelfGraph uses embedded Kuzu when you give no URI (zero setup,
needs the `kuzu` extra) and HydraDB when you do, so set `store=` for any other
backend.

```python
SelfGraph.connect(store="hydradb", uri="bolt://127.0.0.1:17687", auth="neo4j:<token>")
SelfGraph.connect(store="kuzu", uri="graph.kuzu")
SelfGraph.connect(store="neo4j", uri="bolt://localhost:7687", auth="neo4j:password")
```

For `kuzu`, `uri` is the file path.

## Concurrency

IDs are deterministic and writes are idempotent upserts, so re-running the same
insert never duplicates data. Under concurrent writers the guarantees differ by
backend. Entities and nodes dedupe safely everywhere.

Creating and versioning the same relation or preference is a read-modify-write. On
the transactional backends (Neo4j, Memgraph) each write serializes on its subject
node (the relation's from-entity, the preference's profile), so concurrent writers
each keep their own version, concurrent first-time creation of the same edge resolves
to one current version, and a loser under heavy contention raises `TransientError` to
retry rather than losing data; the single current-version invariant always holds. The
auto-commit backends (HydraDB, Kuzu, FalkorDB) cannot serialize, so concurrent writes
to one edge collapse to a single last-writer-wins version and the other writes' data
is lost silently (final state is still consistent with exactly one current version).
Serialize writes in your application for strict multi-writer workloads against one
edge on those backends.

A multi-item insert validates every reference before writing anything. On the
transactional Bolt backends (Neo4j, Memgraph) the whole batch then commits or rolls
back as one unit. The auto-commit backends (HydraDB, Kuzu, FalkorDB) apply writes
incrementally, so a failure partway through a batch can leave earlier writes in
place. IDs are deterministic, so re-running the same insert reconciles a partial
write rather than duplicating it.

Decision traces are mutated in place (no revision history), unlike relations and
preferences which keep every version.

On HydraDB an entity's type is stored as the `type` property rather than a second
node label (its upsert accepts only one label), so a raw `MATCH (:Person)` matches
nothing there; filter on the property instead, for example `MATCH (n {type:
'Person'})`. The typed `entities.list(type=...)` works on every backend.

## A custom backend

Implement the `GraphStore` primitives (`upsert_node`, `create_edge`, `get_node`,
`match_nodes`, `match_edges`, `update_current_edge`, and the rest) and pass your
store to `SelfGraph`. Keep backend dialect inside the store; the shared logic
never writes it.

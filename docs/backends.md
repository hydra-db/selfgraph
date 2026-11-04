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
The store defaults to `hydradb`, so set `store=` for any other backend.

```python
SelfGraph.connect(store="hydradb", uri="bolt://127.0.0.1:17687", auth="neo4j:<token>")
SelfGraph.connect(store="kuzu", uri="graph.kuzu")
SelfGraph.connect(store="neo4j", uri="bolt://localhost:7687", auth="neo4j:password")
```

For `kuzu`, `uri` is the file path.

## A custom backend

Implement the `GraphStore` primitives (`upsert_node`, `create_edge`, `get_node`,
`match_nodes`, `match_edges`, `update_current_edge`, and the rest) and pass your
store to `SelfGraph`. Keep backend dialect inside the store; the shared logic
never writes it.

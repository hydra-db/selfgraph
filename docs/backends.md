# Backends

Pass a store to `SelfGraph(store=...)`. All logic lives in the SDK, and a store
only implements a small set of graph primitives, so the same graph runs on any
backend.

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
| `Neo4jStore` | Neo4j over Bolt. The same store as `CypherStore`. | core |
| `CypherStore` | Any Bolt and openCypher database, Memgraph included. Creates the id uniqueness constraints on `initialize()`. | core |
| `FalkorDBStore` | FalkorDB over its Redis protocol. | `falkordb` |
| `KuzuStore` | Embedded Kuzu, in process, no server. | `kuzu` |
| `HydraDBStore` | HydraDB 0.4.0 or newer. | core |

Neo4j and Memgraph are tested on Bolt.

`SelfGraph.close()`, or leaving `async with`, closes the store you passed in.
Build a new store for each `SelfGraph` ([errors](errors.md#messages)). In
TypeScript, an unclosed graph on a server store keeps the Node process alive
([differences](typescript.md#differences)).

## Store options

**Bolt stores** take `auth` as any of:

- `"user:password"`;
- a bare token (user `neo4j`);
- a `(user, password)` pair;
- a driver auth object.

Any other shape raises `ValidationError` when the store is built.
`connection_timeout` and `connection_acquisition_timeout` default to 10 seconds
(`connectionTimeout` and `connectionAcquisitionTimeout` in TypeScript). Pass your
own driver settings to change them.

**`HydraDBStore`** takes its token bare or in the second slot of a pair.

**`FalkorDBStore`** passes extra keyword arguments to the FalkorDB client and
rejects unknown ones. The TypeScript store accepts a
[fixed option set](typescript.md#differences). It omits `readonly`, a
cluster-only option that a standalone server rejects.

**`KuzuStore`** needs no server.

- It expands a leading `~` and creates the file's folder if needed.
- With no path, it opens `selfgraph_kuzu` in the current directory.
- Each open Kuzu database reserves 8 TB of virtual memory by default, so a
  process holding many can run out of address space. Pass `max_db_size` (a
  positive integer of bytes), as in `KuzuStore("graph.kuzu", max_db_size=1 << 30)`,
  or close each graph when done.
- Kuzu allows one process per database. While an MCP server or script holds the
  file, another process fails with a lock error. Route access through one
  long-lived process, or use a server backend.

## From settings

`SelfGraph.connect(...)` and `SelfGraph.from_env()` build the store and LLM
config from settings. They take the same settings as the
[CLI](cli.md#connection-flags). `from_env` reads `SELFGRAPH_STORE`,
`SELFGRAPH_URI`, `SELFGRAPH_AUTH`, `SELFGRAPH_DATABASE`, `SELFGRAPH_NAMESPACE`,
and the other `SELFGRAPH_*` variables. Every setting is validated when the graph
is built.

```python
SelfGraph.connect(store="hydradb", uri="bolt://127.0.0.1:17687", auth="neo4j:<token>")
SelfGraph.connect(store="kuzu", uri="graph.kuzu")
SelfGraph.connect(store="neo4j", uri="bolt://localhost:7687", auth="neo4j:password")
```

| Setting | Rules |
|---------|-------|
| `store` | `hydradb`, `neo4j`, `cypher`, `memgraph` (uses `CypherStore`), `falkordb`, or `kuzu`. Unset: embedded Kuzu at `~/.selfgraph/default.kuzu` when there is no URI (needs the `kuzu` extra), and HydraDB when there is one. |
| `uri` | Kuzu: the file path. A path-like URI such as `graph.kuzu` without `store="kuzu"` fails with a hint to pass it. FalkorDB: see below. An empty URI is a `ValidationError`. |
| `auth` | FalkorDB: `user:password`, or a bare password for the default user. FalkorDB takes no tokens. It wins over credentials in the URI. |
| `database` | FalkorDB: the graph name, default `selfgraph` (the `graph=` argument of `FalkorDBStore`). The graph is created on first use. |
| `namespace` | Unset means `default`. An empty or blank one is a `ValidationError`, as for `SelfGraph(namespace="")`. |

A FalkorDB `uri` is `host:port`, or a `redis://`, `rediss://`, `falkor://`, or
`falkors://` URL such as `redis://user:password@host:port`. `rediss://` and
`falkors://` connect over TLS. Any other scheme, such as `bolt://`, is a
`ValidationError`.

## Concurrency

Inserts are idempotent upserts. Re-running one never duplicates data and
reconciles a partial earlier write. A multi-item insert validates every reference
before writing anything.

| | Transactional (Neo4j, Memgraph) | Auto-commit (HydraDB, Kuzu, FalkorDB) |
|---|---|---|
| A failed batch | Rolls back as one unit. | Can leave earlier writes in place. |
| Writers in one process | Serialized per subject node. | One write at a time per graph object. |
| Writers in separate processes | Each keeps its own version. A loser under heavy contention raises `TransientError` to retry. | Not serialized. Concurrent creates of one id can all report success with one write kept, and concurrent updates collapse to last-writer-wins. |

Within one process, one concurrent `create` of an id wins and the rest raise
`ConflictError`. Every backend keeps exactly one current version per relation or
preference. For strict multi-writer workloads on the auto-commit backends, route
writes through one process.

## A custom backend

Implement the `GraphStore` primitives (`upsert_node`, `create_edge`, `get_node`,
`match_nodes`, `match_edges`, `update_current_edge`, and the rest) and pass your
store to `SelfGraph`. Keep the dialect inside the store. In TypeScript, a Cypher
engine can instead extend `CypherPrimitives` and implement `_run`.

## Raw Cypher

`graph.run_cypher()` sends a statement straight to the backend. It sees the
physical storage rather than the typed model, so it is not portable across
backends.

- It is not scoped to the namespace. Filter on `ns` yourself.
- It can write, as can `selfgraph query`. Only the MCP `run_cypher` tool is
  read-only.
- `result.counters` is always empty on Kuzu.

Every SelfGraph node carries a kind label: `Entity`, `Profile`, `DecisionTrace`,
`DecisionStep`, `Source`, `SourceVersion`, `Chunk`, `Evidence`, `EntityMerge`, or
`EntityMergeEntry` (one source or rewrite of a merge record, so a record stays small when a merge repeats).
The entity type is the `type` property. Only Neo4j, Memgraph, and FalkorDB also
add it as a second label.

| | Neo4j, Memgraph, FalkorDB | Kuzu | HydraDB |
|---|---|---|---|
| Node label | `Entity` and the type, e.g. `Person` | table `N`; kind in `n.label` | `Entity` only |
| SelfGraph id | `n.id` | `n.id` | `n.sid` (`n.id` is an internal integer) |
| Namespace | `n.ns` | `n.ns` | `n.ns` |
| Other fields | properties such as `n.type`, `n.name`, `n.properties_json` | JSON in `n.doc`, read with `json_extract(n.doc, 'name')` | scalar properties such as `n.type`, `n.name`; the full record as JSON in `n.doc` |
| Relation | the relation type, e.g. `[r:WORKS_AT]` | table `R`; type in `r.etype` | `[r:RELATES]`; type in `r.etype` |
| `MATCH (n:Person)` | matches | error, no such table | returns nothing |

- Relations keep every version. Add `r.is_current = true` to read only the
  current one.
- Returned nodes and relationships omit SelfGraph's internal `_lock` counter,
  which Neo4j, Memgraph, and FalkorDB keep on locked nodes. `RETURN n._lock`
  still reads it.
- Kuzu rejects a parameter the statement does not use. Its `json_extract` returns
  JSON text, so a string compares against its quoted form (`'"Person"'`).
- HydraDB runs a narrow openCypher subset. `RETURN` accepts only `alias.property`
  items and `count(*)`, so write `RETURN n.sid`, not `RETURN n`, and `count(*)`,
  not `count(n)`. Match edges by `RELATES` and `r.etype`, not by relation type.

These list current `WORKS_AT` edges in the graph's namespace, one per backend
family:

```python
# Neo4j, Memgraph, FalkorDB
await graph.run_cypher(
    "MATCH (a:Person)-[r:WORKS_AT]->(b:Entity) WHERE a.ns = $ns AND r.is_current = true "
    "RETURN a.id AS person, b.id AS company",
    {"ns": graph.namespace},
)

# Kuzu
await graph.run_cypher(
    "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.etype = 'WORKS_AT' AND r.is_current "
    "RETURN a.id AS person, b.id AS company",
    {"ns": graph.namespace},
)

# HydraDB
await graph.run_cypher(
    "MATCH (a:Entity)-[r:RELATES]->(b:Entity) WHERE r.ns = $ns AND r.etype = 'WORKS_AT' "
    "AND r.is_current = true RETURN a.sid AS person, b.sid AS company",
    {"ns": graph.namespace},
)
```

## Errors

Store failures raise `StoreError`. Common setup mistakes get a plain message:

| Cause | Message |
|-------|---------|
| Wrong token or password on a Bolt store | `authentication failed for <uri>: check the token/password` |
| Unknown database name | `database '<name>' not found` |
| Nothing speaks Bolt at the URI | `could not connect to <uri>: ...`, after at most 10 s |
| `store="neo4j"` or `cypher` pointed at a HydraDB server | the parse error from `initialize`, ending `if this is a HydraDB server use store 'hydradb'` |
| Another process has the Kuzu database open | the Kuzu lock error, ending `Kuzu allows one process at a time` |
| Kuzu cannot reserve memory for another database | the Kuzu mmap error, ending `pass a smaller max_db_size` |

More connection messages are in [Errors](errors.md#connections).

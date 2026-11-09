# Backends

All logic lives in the SDK. A store implements a small set of graph primitives, so
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
| `Neo4jStore` | Neo4j over Bolt; the same store as `CypherStore`. | core |
| `CypherStore` | Any Bolt and openCypher database, Memgraph included. Creates the id uniqueness constraints on `initialize()`. | core |
| `FalkorDBStore` | FalkorDB over its Redis protocol. | `falkordb` |
| `KuzuStore` | Embedded Kuzu, in process, no server. | `kuzu` |
| `HydraDBStore` | HydraDB. | core |

Neo4j and Memgraph are tested on Bolt. The Bolt stores take `auth` as
`"user:password"`, a bare token (user `neo4j`), a `(user, password)` pair, or a
driver auth object; any other shape raises `ValidationError` when the store is
built. `HydraDBStore` takes its token bare or in the second slot of a pair, and
needs HydraDB 0.4.0 or newer.

`FalkorDBStore` passes extra keyword arguments to the FalkorDB client and rejects
unknown ones. The TypeScript store accepts a fixed option set without `readonly`,
a cluster-only option that a standalone server rejects.

`KuzuStore` needs no server. It expands a leading `~`, creates the file's folder if needed, and with
no path opens `selfgraph_kuzu` in the current directory. Each open Kuzu database
reserves 8 TB of virtual memory by default, so a process holding many can run out
of address space; pass `max_db_size` (a positive integer of bytes), as in
`KuzuStore("graph.kuzu", max_db_size=1 << 30)`, or close each graph when done.
Kuzu allows one process per database: while an MCP server or script holds the
file, another process fails with a lock error, so route access through one
long-lived process or use a server backend.

`SelfGraph.close()` (or leaving `async with`) closes the store you passed in, so
build a new store for each `SelfGraph` ([errors](errors.md#messages)). In TypeScript
an unclosed graph on a server store keeps the Node process alive
([differences](typescript.md#differences)).

## From settings

`SelfGraph.connect(...)` and `SelfGraph.from_env()` (reading `SELFGRAPH_STORE`,
`SELFGRAPH_URI`, `SELFGRAPH_AUTH`, `SELFGRAPH_DATABASE`, `SELFGRAPH_NAMESPACE`, and
the other `SELFGRAPH_*` variables) build the store and LLM config from settings,
the same ones the [CLI](cli.md#connection-flags) takes. Every setting is
validated when the graph is built. With no store, SelfGraph uses embedded Kuzu at
`~/.selfgraph/default.kuzu` when there is no URI (needs the `kuzu` extra) and
HydraDB when there is one. A path-like URI such as `graph.kuzu` without
`store="kuzu"` fails with a hint to pass it, and an empty URI is a
`ValidationError`. `memgraph` is accepted as a store name and uses `CypherStore`.

```python
SelfGraph.connect(store="hydradb", uri="bolt://127.0.0.1:17687", auth="neo4j:<token>")
SelfGraph.connect(store="kuzu", uri="graph.kuzu")
SelfGraph.connect(store="neo4j", uri="bolt://localhost:7687", auth="neo4j:password")
```

For `kuzu`, `uri` is the file path. For `falkordb`, `uri` is `host:port` or a
`redis://`, `rediss://`, `falkor://`, or `falkors://` URL such as
`redis://user:password@host:port` (`rediss://` and `falkors://` connect over TLS); any
other scheme, such as `bolt://`, is a `ValidationError`. `auth` (`user:password`, or a bare password for the default user; FalkorDB takes no tokens)
wins over credentials in the URI, and `database` names the FalkorDB graph, default
`selfgraph` (the `graph=` argument of `FalkorDBStore`). The graph is
created on first use. An unset `namespace` means `default`; an empty or blank one
is a `ValidationError`, as for `SelfGraph(namespace="")`.

## Concurrency

Inserts are idempotent upserts, so re-running one never duplicates data and
reconciles a partial earlier write. A multi-item insert validates every reference
before writing anything.

| | Transactional (Neo4j, Memgraph) | Auto-commit (HydraDB, Kuzu, FalkorDB) |
|---|---|---|
| A failed batch | Rolls back as one unit. | Can leave earlier writes in place. |
| Writers in one process | Serialized per subject node. | One write at a time per graph object. |
| Writers in separate processes | Each keeps its own version; a loser under heavy contention raises `TransientError` to retry. | Not serialized: concurrent creates of one id can all report success with one write kept, and concurrent updates collapse to last-writer-wins. |

Within one process, one concurrent `create` of an id wins and the rest raise
`ConflictError`. Every backend keeps exactly one current version per relation or
preference. Route writes through one process for strict multi-writer workloads
on the auto-commit backends.

## A custom backend

Implement the `GraphStore` primitives (`upsert_node`, `create_edge`, `get_node`,
`match_nodes`, `match_edges`, `update_current_edge`, and the rest) and pass your
store to `SelfGraph`. Keep the dialect inside the store.

## Raw Cypher

`graph.run_cypher()` sends a statement straight to the backend, so it sees the
physical storage rather than the typed model and is not portable across backends.
It is not scoped to the namespace (filter on `ns` yourself) and it can write, as
can `selfgraph query`; only the MCP `run_cypher` tool is read-only.
`result.counters` is always empty on Kuzu.

Every SelfGraph node carries a kind label: `Entity`, `Profile`, `DecisionTrace`,
`DecisionStep`, `Source`, `SourceVersion`, `Chunk`, `Evidence`, or `EntityMerge`.
The entity type is the `type` property, and only Neo4j, Memgraph, and FalkorDB also
add it as a second label.

| | Neo4j, Memgraph, FalkorDB | Kuzu | HydraDB |
|---|---|---|---|
| Node label | `Entity` and the type, e.g. `Person` | table `N`; kind in `n.label` | `Entity` only |
| SelfGraph id | `n.id` | `n.id` | `n.sid` (`n.id` is an internal integer) |
| Namespace | `n.ns` | `n.ns` | `n.ns` |
| Other fields | properties such as `n.type`, `n.name`, `n.properties_json` | JSON in `n.doc`, read with `json_extract(n.doc, 'name')` | scalar properties such as `n.type`, `n.name`; the full record as JSON in `n.doc` |
| Relation | the relation type, e.g. `[r:WORKS_AT]` | table `R`; type in `r.etype` | `[r:RELATES]`; type in `r.etype` |
| `MATCH (n:Person)` | matches | error, no such table | returns nothing |

Relations keep every version, so add `r.is_current = true` to read only the current
one. Returned nodes and relationships omit SelfGraph's internal `_lock` counter, which
Neo4j, Memgraph, and FalkorDB keep on locked nodes; `RETURN n._lock` still reads it.
Kuzu rejects a parameter the statement does not use, and `json_extract` returns
JSON text, so a string compares against its quoted form (`'"Person"'`).

HydraDB runs a narrow openCypher subset. `RETURN` accepts only `alias.property`
items and `count(*)`, so write `RETURN n.sid` rather than `RETURN n`, and
`count(*)` rather than `count(n)`. Match edges by `RELATES` and `r.etype`, not by
relation type.

One namespace-scoped example per backend family, listing current `WORKS_AT` edges:

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

Store failures raise `StoreError` with a plain message for the common setup
mistakes:

| Cause | Message |
|-------|---------|
| Wrong token or password on a Bolt store | `authentication failed for <uri>: check the token/password` |
| Unknown database name | `database '<name>' not found` |
| Nothing speaks Bolt at the URI | `could not connect to <uri>: ...`, after at most 10 s |
| `store="neo4j"` or `cypher` pointed at a HydraDB server | the parse error from `initialize`, ending `if this is a HydraDB server use store 'hydradb'` |
| Another process has the Kuzu database open | the Kuzu lock error, ending `Kuzu allows one process at a time` |
| Kuzu cannot reserve memory for another database | the Kuzu mmap error, ending `pass a smaller max_db_size` |

Bolt stores default `connection_timeout` and `connection_acquisition_timeout` to 10
seconds (`connectionTimeout` and `connectionAcquisitionTimeout` in TypeScript); pass
your own driver settings to change them.

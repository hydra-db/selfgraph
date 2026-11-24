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

**`HydraDBStore`** takes its token bare or in the second slot of a pair. Each
node or edge row goes in one Bolt message, which HydraDB caps at 2 MiB, so a row
may take at most 2 MiB minus 64 KiB. A larger row raises `StoreError` before
it is written. Batches are split to stay under the cap.

**`FalkorDBStore`** passes extra keyword arguments to the FalkorDB client and
rejects unknown ones. The TypeScript store accepts a
[fixed option set](typescript.md#differences). It omits `readonly`, a
cluster-only option that a standalone server rejects.

**`KuzuStore`** needs no server.

- It expands a leading `~` and creates the file's folder if needed.
- With no path, it opens `selfgraph_kuzu` in the current directory.
- An empty path or `:memory:` opens a separate in-memory database for each store.
  Stores opened on the same file path share that file's database instead.
  A store that passes different database options (such as `max_db_size` or
  `buffer_pool_size`) than the database already open on that path raises
  `ValidationError`; omitted options join the open database.
- For a file-backed database with an explicit `buffer_pool_size`, SelfGraph
  lowers Kuzu's automatic write-ahead log checkpoint threshold to at most
  one 1,024th of the pool. This frees committed write buffers sooner during
  repeated updates without dropping historical versions. In-memory databases
  cannot reclaim those buffers through disk checkpoints. The Python store
  honors an explicit `checkpoint_threshold` or `auto_checkpoint` override.
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
`ValidationError`. The URL's user and password are percent-decoded, so write a
literal `%` as `%25`; `auth` takes precedence over them.

## Concurrency

Inserts are idempotent upserts. Re-running one never duplicates data and
reconciles a partial earlier write. A multi-item insert validates every reference
before writing anything.

| | Transactional (Neo4j, Memgraph) | Auto-commit (HydraDB, Kuzu, FalkorDB) |
|---|---|---|
| A failed batch | Rolls back as one unit. | Can leave some of its writes in place. HydraDB runs writes that do not depend on each other concurrently, so they need not be the earlier ones. An update cut off between retiring a relation's or preference's current version and writing the next leaves no current version, and the next update or insert of it completes the write. One that finds a write of it still running in the same process, in a task that shares its outer transaction, raises `TransientError` instead. |
| Writers in one process | Serialized per subject node. | One write at a time per graph object. |
| Writers in separate processes | Each keeps its own version. A loser under heavy contention raises `TransientError` to retry. | Not serialized. Concurrent creates of one id can all report success with one write kept, and concurrent updates collapse to last-writer-wins, as when one completes an update another process is still writing. |

Within one process, one concurrent `create` of an id wins and the rest raise
`ConflictError`. Every backend keeps exactly one current version per relation or
preference. For strict multi-writer workloads on the auto-commit backends, route
writes through one process.

## A custom backend

Implement the `GraphStore` primitives (`upsert_node`, `create_edge`, `get_node`,
`match_nodes`, `match_edges`, `update_current_edge`, and the rest) and pass your
store to `SelfGraph`. Keep the dialect inside the store. In TypeScript, a Cypher
engine can instead extend `CypherPrimitives` and implement `_run`.

Property keys and `order_by` columns reach the primitives as plain identifiers
(letters, digits, and underscores); the built-in stores reject anything else with
`ValidationError`. A store with a write limit can implement the optional
`check_node_writes(ns, label, rows)` and `check_edge_writes(ns, from_label, to_label, rows)`
(`checkNodeWrites` and `checkEdgeWrites` in TypeScript). SelfGraph calls them
before each write, so a raise leaves that write undone.

## Raw Cypher

The SDK, CLI, and MCP reject queries over 65,536 UTF-8 bytes or 32 levels of
parentheses, brackets, and braces before dispatching to a backend. Delimiters
inside strings, quoted identifiers, and comments do not count toward depth.

`graph.run_cypher()` sends a statement straight to the backend. It sees the
physical storage rather than the typed model, so it is not portable across
backends.

- It is not scoped to the namespace. Filter on `ns` yourself.
- It can write, as can `selfgraph query`. Only the MCP `run_cypher` tool is
  read-only.
- `result.counters` is always empty on Kuzu.
- On Kuzu, both SDKs return a result value in one form, read from its column type. An
  integer, or a `DECIMAL` of at most 15 digits, is a number while a double holds it exactly,
  and is its decimal text beyond that (Python: `INT64`, `UINT64`, `INT128`, and wider
  `DECIMAL` values). A `DATE` is `YYYY-MM-DD`, a timestamp is `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`
  in UTC, an interval is an ISO 8601 duration such as `P1DT2H3M4.5S` (a month counts as 30
  days), a `BLOB` is hex, and a `UNION` is the value it holds.
- The Kuzu Node driver rounds an `INT64` or `UINT64` beyond 2^53, a `DECIMAL` of more than
  15 digits, and a timestamp or interval to milliseconds before the SDK sees it. The
  TypeScript SDK raises [`inexact_value`](errors.md#inexact_value) for the first two,
  naming the column, so `cast(x AS STRING)` it in the query. Timestamps and intervals
  keep only milliseconds there, and a timestamp before 1970 rounds toward 1970. The driver
  does not say which member a `UNION` value holds, so TypeScript raises the same code when
  two members share a driver type, such as `INT64` and `DOUBLE`. A node, relationship, or
  path reads each property with the type its table declares. A `MAP` key keeps Kuzu's text
  in TypeScript, which Python matches except for `INTERVAL` and `BLOB` keys.
- The Kuzu store reopens its connection every 500 statements to free the memory
  Kuzu keeps per statement, so a `CALL` setting or `USE` may not last until a
  later statement. It does not reopen while a raw transaction is open.

Every SelfGraph node carries a kind label: `Entity`, `Profile`, `DecisionTrace`,
`DecisionStep`, `Source`, `SourceVersion`, `Chunk`, `Evidence`, `EntityMerge`, or
`EntityMergeEntry` (one source or rewrite of a merge record, so a record stays small when a merge repeats).
The entity type is the `type` property. Neo4j, Memgraph, and FalkorDB also add it
as a second label. HydraDB adds it only when HydraDB accepts it as a label, that is
when it uses ASCII letters, digits, `_`, `.`, or `-`.

| | Neo4j, Memgraph, FalkorDB | Kuzu | HydraDB |
|---|---|---|---|
| Node label | `Entity` and the type, e.g. `Person` | table `N`; kind in `n.label` | `Entity`, and the type when it is a valid HydraDB label |
| SelfGraph id | `n.id` | `n.id` | `n.sid` (`n.id` is an internal integer) |
| Namespace | `n.ns` | `n.ns` | `n.ns` |
| Other fields | properties such as `n.type`, `n.name`, `n.properties_json` | JSON in `n.doc`, read with `json_extract(n.doc, 'name')` | scalar properties such as `n.type`, `n.name`; the full record as JSON in `n.doc` |
| Relation | the relation type, e.g. `[r:WORKS_AT]` | table `R`; type in `r.etype` | `[r:RELATES]`; type in `r.etype` |
| `MATCH (n:Person)` | matches | error, no such table | matches; a type that is not a valid HydraDB label, such as `Big Co`, is rejected as a label, so filter on `n.type` |

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
- HydraDB also stores `_SgEntityKey` nodes: an index of every entity's folded
  name, aliases, and external ids, which entity resolution looks up instead of
  reading every entity. They are not SelfGraph records, but carry the entity's
  `ns`. An entity written with raw Cypher is not indexed, so resolution does
  not see it.

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
| A second `KuzuStore` on an open path with other options | `KuzuStore('<path>') is already open with different options: <option> <open> vs <new>` (`ValidationError`) |
| A HydraDB row over the write cap | `HydraDB rejects this write at <n> bytes; ...` |
| A store URI whose user or password has an unencoded `/`, `?`, `#`, `@`, `[` or `]` (brackets around an IPv6 host are fine), or whose user, password or host has a lookalike such as fullwidth `＠` that NFKC turns into one of `/ ? # @ : [ ]` | `the store URI has an unencoded character in its user or password; percent-encode it (/ as %2F, ? as %3F, # as %23, @ as %40, [ as %5B, ] as %5D)` (`ValidationError`, raised before any driver reads the URI) |
| A FalkorDB URL whose user or password has a `%` not followed by two hex digits, or escapes that are not UTF-8 | `the store URI has a malformed percent escape in its user or password; write a literal % as %25 and percent-encode other characters as UTF-8` (`ValidationError`, code `invalid_setting`, field `uri`) |

A URI in these messages, and in the address errors raised before connecting, shows `***` in place of its user and password, as in `redis://***@host:6379`.

More connection messages are in [Errors](errors.md#connections).

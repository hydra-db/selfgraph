# Retrieval

`retrieve` answers a query with a block of context assembled from the graph. It
returns a `RetrievalResult` whose `context` is text ready to pass to a model.

```python
result = await graph.retrieve("who runs Acme and what did they acquire")
print(result.context)
```

## Parameters

```python
await graph.retrieve(
    query,
    strategy="bfs",      # "bfs" or "dfs" from the seeds
    depth=3,             # hops from each seed
    k=20,                # seed entities to start from
    max_nodes=200,       # entities to collect while traversing
    budget_tokens=3000,  # size cap on the assembled context
)
```

## How it works

1. **Seed.** The query is tokenized. Every entity is scored against those tokens
   with BM25 plus a grep boost: a term that appears as a substring of an entity's
   text adds to its score. The top `k` entities become seeds.
2. **Traverse.** Starting from the seeds, the current relations are walked in BFS
   or DFS order up to `depth` hops, collecting up to `max_nodes` entities.
3. **Assemble.** The entities, relations, decisions, preferences, and source
   passages are formatted into one context, trimmed to `budget_tokens`.

BM25 ranks by term relevance; the grep boost adds recall for substring matches
that tokenization alone would miss, such as a query for `acme` matching an entity
named `Acmecorp`. There is no vector store and no embeddings.

## Raw Cypher

For queries the typed API does not cover, run Cypher directly:

```python
result = await graph.run_cypher(
    "MATCH (n:Entity {ns: $ns}) RETURN count(n) AS n",
    {"ns": graph.namespace},
)
print(result.rows)
```

`run_cypher` is a backend-specific escape hatch, not a portable one: it speaks
the dialect of the store you are on. The embedded backends do not expose label or
relationship-typed Cypher. `KuzuStore` keeps everything in generic `N` and `R`
tables with a JSON `doc` property, so you filter with `json_extract` rather than
`MATCH (n:Person)`; `HydraDBStore` on HydraDB 0.2.0 supports only `MATCH ... RETURN`.
Cypher written for Neo4j will not run unchanged on Kuzu or HydraDB, so prefer the
typed methods for code that must work across backends. See [Backends](backends.md).

`result.counters` reports write counts only on the Bolt backends (Neo4j, Memgraph,
FalkorDB, HydraDB), which return a query summary. The embedded Kuzu driver exposes
no mutation counts, so `counters` is always empty there; use `result.rows` instead.

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
    strategy="bfs",      # "bfs" or "dfs" from the seeds, or "ppr" for PageRank ranking
    depth=3,             # hops from each seed
    k=20,                # seed entities to start from
    max_nodes=200,       # entities to collect while traversing
    budget_tokens=3000,  # size cap on the assembled context
)
```

## How it works

1. **Seed.** The query is tokenized into Unicode words, NFC-normalized and
   casefolded, so `Café`, `café`, and `世界` all match. Every entity is scored
   against those tokens with BM25 plus a grep boost: a term that appears as a
   substring of an entity's text adds to its score (ASCII terms need three or
   more characters, so a stray `n` does not match everything; terms in other
   scripts count at any length). The score is then divided by
   the log of how many distinct sources mention the entity, so a generic entity
   that shows up everywhere does not crowd out a specific one. The top `k`
   entities become seeds.
2. **Traverse.** Starting from the seeds, the current relations are walked in BFS
   or DFS order up to `depth` hops, collecting up to `max_nodes` entities and
   the relations among them. With `strategy="ppr"` up to four times `max_nodes`
   candidates are collected by BFS, ranked by personalized PageRank instead of
   hop count, and the top `max_nodes` are kept: walks restart at the seeds in
   proportion to their scores, and edges backed by more sources carry more
   weight, so an entity reachable through many paths outranks one that is
   merely close.
3. **Assemble.** The entities, relations, decisions, preferences, and source
   passages are formatted into one context, nearest or highest-ranked first,
   trimmed to `budget_tokens`.

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

`run_cypher` speaks the dialect of the store you are on and sees its physical
layout, not the typed model; see [Raw Cypher in Backends](backends.md#raw-cypher)
for what each backend accepts.

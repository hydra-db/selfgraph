# Retrieval

`retrieve` answers a query with context assembled from the graph, ready to pass
to a model. There are no embeddings: seeding is lexical.

```python
result = await graph.retrieve("who runs Acme and what did they acquire")
print(result.context)
```

| Field | Holds |
|-------|-------|
| `query`, `strategy` | The query and strategy used. |
| `seeds` | The seed entities as `{id, score}`, best first. |
| `subgraph` | The collected `entities`, `relations`, `preferences`, and `decisions`. |
| `context` | Source passages, then relation lines (`Jane Doe -[WORKS_AT]-> Acme`), preferences, decisions, and entity lines (`Acme [Company]`). Passages appear only here. |

Passages come only from `insert.text` calls made with a `source_id`. A graph
built with `insert.ontology` returns relation and entity lines but no passages.

The CLI is `selfgraph retrieve QUERY` (`--context-only` prints just the context)
and the MCP tool is `retrieve`.

## Parameters

```python
await graph.retrieve(
    query,
    strategy="bfs",      # "bfs" or "dfs" from the seeds, or "ppr" for PageRank ranking
    depth=3,             # hops from each seed
    k=20,                # seed entities
    max_nodes=200,       # entities to collect
    budget_tokens=3000,  # size cap on the context
    as_of=None,          # read the graph at this time
)
```

An empty `query` raises `ValidationError` (`query cannot be empty`), and so does
a negative `depth` or a `k`, `max_nodes`, or `budget_tokens` below 1.

## As of a point in time

`as_of` (a datetime or ISO 8601 text; no offset means UTC; CLI `--as-of`) reads
the graph on the valid-time axis. Each record's effective time is its
`event_time` if set, else its `created_at`.

- Relations and preferences: among the versions with an effective time at or
  before T, the highest revision wins, so a later write overrides earlier ones
  from its effective time on, even when backdated before them. It is valid at T
  unless the first invalidation recorded on it or a later revision happened at or
  before T. With no version by T, the record is left out.
- An update without a new `event_time` keeps the old effective time, so an
  `as_of` at that time already shows the new values. Pass `event_time` to start
  them later.
- Decisions: visible when the trace's effective time is at or before T, unless
  they name an entity not visible at T. A preference whose subject or value
  entity no longer exists is left out.
- Entities: visible when first stored by T, or when they are an endpoint,
  subject, value, or about entity of a relation or preference version valid at T.
  So a fact inserted today with a 2020 `event_time` shows, with its entities,
  from 2020 on.
- Passages: shown when their source version's effective time, the insert's
  `event_time` or else when it was stored, is at or before T.

## How it works

1. **Seed.** The query is split into Unicode words, NFC-normalized and
   casefolded, with stopwords dropped. Every entity is scored with BM25 plus a
   grep boost: a term that is a substring of the entity's text adds to its score
   (ASCII terms need three or more characters; other scripts count at any
   length). The score is divided by the log of the entity's distinct sources, so
   a generic entity does not crowd out a specific one. Ties go to the higher
   [decay](maintenance.md#decay) `relevance`, then the lower id. A one-character
   word, stopwords included, also seeds an entity whose whole name equals it,
   ignoring case. The top `k` entities become seeds. Every entity is scored,
   with no cap: the scan reads entities in id-ordered pages twice, once for the
   BM25 corpus statistics and once to score, keeping only the best `k` in
   memory. Its cost grows linearly with the graph (two full reads per query).
2. **Traverse.** Current relations are walked in BFS or DFS order up to `depth`
   hops, collecting up to `max_nodes` entities and the relations among them.
   With `ppr`, up to four times `max_nodes` candidates (at most 5000) are
   collected by BFS and ranked by personalized PageRank, restarting at the seeds
   in proportion to their scores and weighting edges by their sources; the top
   `max_nodes` are kept.
3. **Assemble.** Passages, relations, preferences, decisions, and entities are
   written nearest or highest-ranked first. Passages take at most 60% of the
   budget and at most six. The context never exceeds `budget_tokens`: when even
   the first line does not fit, it is cut to the longest prefix that fits. The
   budget trims only the context; the subgraph is bounded by `max_nodes`.

Seeding does not fold diacritics (`Zoe` misses `Zoë`), a query of
only stopwords finds no seeds, and any query word of three or more letters that
is a substring of a name seeds it (`Dan works` seeds `Carol Danvers`).

## Raw Cypher

For queries the typed API does not cover, run Cypher directly:

```python
result = await graph.run_cypher(
    "MATCH (n:Entity {ns: $ns}) RETURN count(n) AS n",
    {"ns": graph.namespace},
)
print(result.rows)
```

`run_cypher` speaks the store's dialect and sees its physical layout, so the
query above differs per backend; see [Raw Cypher in Backends](backends.md#raw-cypher).

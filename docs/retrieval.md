# Retrieval

`retrieve` answers a query with context from the graph, ready to pass to a model.
Seeding is lexical by default; a caller-supplied `embedder=` adds an optional embeddings seed tier.

```python
result = await graph.retrieve("who runs Acme and what did they acquire")
print(result.context)
```

| Field | Holds |
|-------|-------|
| `query`, `strategy` | The query and strategy used. |
| `seeds` | The seed entities as `{id, score}`, best first. |
| `subgraph` | The collected `entities`, `relations`, `preferences`, and `decisions`. |
| `context` | Source passages (`SOURCE \| ...`), then graph records: relations, preferences, decisions, and entities (`GRAPH \| Acme [Company]`). Passages appear only here. SDK-built graph headers carry [certification](trust.md#certification) and [hub](trust.md#hubs) metadata; see the format below. |
| `hubs` | The hubs the walk reached: entities with 50 or more current relations. |

Passages come only from `insert.text` calls made with a `source_id`. A graph
built with `insert.facts` returns relation and entity lines but no passages.
Before answering, an agent can ask whether the graph holds the answer at all with
[`check_answerable`](trust.md#check_answerable).

From the CLI, run `selfgraph retrieve QUERY` (`--context-only` prints just the
context). The MCP tool is `retrieve`.

## Context format

Every source passage line, including blank lines, starts with `SOURCE | `.
Every graph record starts with `GRAPH`, optionally followed by `[certified]`
and `(via hub)` in that order, then ` | ` and the record's content:

```text
SOURCE | GRAPH [certified] | Ann -[CEO_OF]-> Acme
GRAPH | Ann -[WORKS_AT]-> Acme {note=[certified]}
GRAPH [certified] (via hub) | Ann -[WORKS_AT]-> Acme
GRAPH | Acme [Company]
```

Only metadata in a complete SDK-built `GRAPH` header, before the first ` | `,
is authoritative. The first example is quoted source data, not a certified
relation; the second contains a literal mark in a property. Do not infer
certification from marker substrings in the content or from a truncated header.
A graph record is not automatically certified simply because its header says
`GRAPH`. Literal marks and Unicode bracket lookalikes remain readable as data.

Passage line endings are normalized while retaining line layout. Embedded line
separators in graph records become visible `\n` text so a stored field cannot
start a new header. Terminal control characters and bidirectional formatting
controls are displayed as `\uNNNN` escapes, preventing cursor commands or text
direction overrides from disguising a header in raw CLI output. Tabs and normal
Unicode text remain readable.

This rendering applies only to `context`. Stored text, retrieval matching,
structured `subgraph` values, IDs, and certification state are unchanged. It is
a separation of data from SDK trust labels, not a general prompt-injection
defense. Headers, escaping, and line separators count toward `budget_tokens`.
Records are counted incrementally, including their joining newlines. Without
the optional tokenizer, conservative rounding can leave part of the budget
unused. A tiny budget may return only an incomplete prefix, which carries no
metadata.

## Parameters

```python
await graph.retrieve(
    query,
    strategy=None,       # "bfs" or "dfs" from the seeds, or "ppr" for PageRank ranking; default by level
    depth=3,             # hops from each seed
    k=20,                # seed entities
    max_nodes=200,       # entities to collect
    budget_tokens=3000,  # size cap on the context
    as_of=None,          # read the graph at this time
    known_at=None,       # read only what the graph held at this time
    seeds=None,          # "bm25", "synonyms", or "embeddings"; default by level
    skip_hubs=False,     # do not walk through hubs other than the seeds
)
```

These raise `ValidationError`: an empty `query` (`query cannot be empty`), a
negative `depth`, or a `k`, `max_nodes`, or `budget_tokens` below 1.

## Seeding tiers

| Tier | Seeds from |
|------|------------|
| `bm25` | Lexical scoring only, as described under [how it works](#how-it-works). |
| `synonyms` (default) | `bm25`, after adding the name of each schema entity type the query names by alias or synonym. A query for `employers` then seeds `Company` entities. A definition's name adds its entity type. |
| `embeddings` | `synonyms`, fused with a ranking by your embedder. Needs `embedder=`. |

`result.tiers["seeds"]` names the tier that ran. With no schema, `synonyms` has
nothing to add and reports `bm25`.

**Embeddings.** Pass any object with an async `embed(texts)` that returns one
vector per text. SelfGraph ships no embedder and stores no vectors.

```python
class MyEmbedder:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        ...

graph = SelfGraph(store=store, embedder=MyEmbedder(), seeds="embeddings")
```

- Each entity's text is embedded once per process and reused until the text
  changes. The cache lives in memory on the graph object.
- Every entity is scored by cosine similarity to the query, and the top `k`
  join the BM25 seeds by reciprocal rank fusion.
- The first query embeds the whole namespace, so cost grows with the graph.

## As of a point in time

`as_of` reads the graph as it was valid at time T. It takes a datetime or ISO
8601 text (no offset means UTC; CLI `--as-of`). A record's effective time is its
`event_time` if set, else its `created_at`.

| Record | Visible at T when |
|--------|-------------------|
| Relations and preferences | Among the versions with an effective time at or before T, the highest revision wins. It is valid unless the first invalidation recorded on it, or a later revision, happened at or before T. With no version by T, it is left out. |
| Preferences (also) | Left out when the subject or value entity no longer exists. |
| Decisions | The trace's effective time is at or before T, and every entity it names is visible at T. |
| Entities | First stored by T, or an endpoint, subject, value, or about entity of a relation or preference version valid at T. |
| Passages | Their source version's effective time (the insert's `event_time`, else when it was stored) is at or before T, and no [replacing version](inserting.md#replacing-a-source) took effect by T. |

What follows from these rules:

- A later write overrides earlier ones from its effective time on, even when
  backdated before them.
- An update without a new `event_time` keeps the old effective time. An `as_of`
  at that time already shows the new values. Pass `event_time` to start them
  later.
- A fact inserted today with a 2020 `event_time` shows, with its entities, from
  2020 on.

## As the graph knew it

`as_of` answers what was true at a time, using everything stored since. A
correction learned today and backdated to last week changes what `as_of` last
week returns. `known_at` answers what the graph held at a time instead, so you
can see what an agent would have read then:

```python
await graph.retrieve("where does Ann work", as_of="2025-06-01")                         # Globex, the correction
await graph.retrieve("where does Ann work", as_of="2025-06-01", known_at="2025-06-10")  # Acme, before the correction
await graph.retrieve("where does Ann work", known_at="2025-06-10")                      # the same, as_of defaults to known_at
```

With `known_at`, the `as_of` rules apply only to what was written by then:

| Record | Counts when |
|--------|-------------|
| Relation and preference versions | Their `created_at` is at or before `known_at`. |
| A retirement | Its `invalidated_known_at`, when the retirement was written, is at or before `known_at`. A retirement written later is not applied, and the version reads as current. |
| A certification | The one in force at `known_at`, from the relation's `certifications`; one made later reads as uncertified, and one removed later as still certified. |
| `source_count` | Counts the sources whose evidence was recorded by `known_at`. |
| Entities and decisions | Their `created_at` is at or before `known_at`. |
| Passages | Their source version was stored by `known_at`, the evidence linking it to the entity was recorded by then, and a [replacement](inserting.md#replacing-a-source) counts only while it was in force then. |

`check_answerable` takes `known_at` too. Changes that keep no record are not
undone: a delete, a merge or unmerge, a decay score, a decision update, or an
entity's changed properties read as they are now.

## The change log

`diff` reads what changed in the namespace between two times, oldest first:

```python
out = await graph.diff(since, until=None, kinds=None, limit=None)
for change in out.changes:
    print(change.at, change.kind, change.action, change.id, change.summary)
print(out.counts)  # {"entity": 3, "relation": 2} over the whole window
```

`since` is required and `until` defaults to now. Beside `total`, `counts`, and
`changes`, the result is a `GraphDiff` with `relations_added`,
`relations_revised`, `relations_retired`, and `entities_created`. `SyncSelfGraph`
has the same method. The window is `(since, until]`, using `created_at` and
`invalidated_known_at`, not `event_time`. Retired relations include
`invalidated_by`. Each new relation revision is listed. Reassertions count as
revisions. A relation created, revised, and retired in the same window appears
in all three lists.

A change is one write. `kind` and `action` say what happened:

| Kind | Actions |
|------|---------|
| `entity` | `created` when first stored. Per-field entity edits are not changes. |
| `relation` | `created` or `updated` per version write, `retired` by a supersede or schema conflict, `certified` and `uncertified` per certification. A retirement's summary names what retired it. |
| `preference` | `created` or `updated` per version write. |
| `decision` | `created` or `updated`. |
| `merge` | `merged` when an insert absorbed a duplicate, `unmerged` when undone. |
| `source` | `created` once per source version stored. |

Times take a datetime or ISO 8601 text (no offset means UTC; CLI `--since`,
`--until`). A change exactly at `since` is left out, so re-reading from the last
change's time never repeats it, and one at `until` is included. Counts per kind
cover the whole window, even when `kinds` filters the list or `limit` keeps only
the newest `limit` changes. Certifications are read from every relation version,
so a certification survives a later version of its relation.

Everything scans the namespace's stored records, not an isolated snapshot or an
audit log, and the log is read back from the stored records too, so deleting an
object also drops its writes from the log. Deletes and merges are not visible in
the four lists: the result includes `limitations: ["Deletes are not
visible."]`, deleted records and overwritten retirement history cannot be
recovered, and a delete-triggered restoration appears as a new relation
revision, but the deleted record and the deletion event do not. Returned entity
fields and relation metadata reflect stored values, not their historical values.
Entity edits are visible only as the change log's `created` events.

TypeScript uses `await graph.diff(since, until, { kinds, limit })`. Both SDKs
return the same fields. `selfgraph diff` prints the same result, and the
`graph_diff` [MCP tool](mcp.md#tools) exposes it to agents. For the
point-in-time reads behind a change, see [as of](#as-of-a-point-in-time).

## How it works

1. **Seed.** The query is split into Unicode words, NFC-normalized and
   casefolded, with stopwords dropped. Every entity is scored with BM25 plus a
   grep boost: a term that is a substring of the entity's text adds to its score.
   ASCII terms need three or more characters for the boost; other scripts count
   at any length. The score is divided by the log of the entity's distinct
   sources, so a generic entity does not crowd out a specific one. Ties go to the
   higher [decay](maintenance.md#decay) `relevance`, then the lower id. A
   one-character word, stopwords included, also seeds an entity whose whole name
   equals it, ignoring case. The top `k` entities become seeds.
2. **Traverse.** Current relations are walked in BFS or DFS order up to `depth`
   hops. This collects up to `max_nodes` entities and the relations among them.
   With `ppr`, BFS collects up to four times `max_nodes` candidates (at most
   5000). Personalized PageRank then ranks them, restarting at the seeds in
   proportion to their scores and weighting edges by their sources. The top
   `max_nodes` are kept.
3. **Assemble.** Passages, relations, preferences, decisions, and entities are
   written nearest or highest-ranked first. Passages take at most 60% of the
   budget, and at most six of them. The context never exceeds `budget_tokens`.
   The first relation, preference, decision, or entity line that does not fit
   ends the context, so a farther line never takes the place of a nearer one.
   When even the first line does not fit, it is cut to the longest prefix that
   fits. The budget trims only the context. The subgraph is bounded by
   `max_nodes`. Among relations equally close to the query, certified ones come
   first.

**Cost.** Seeding scores every entity, with no cap. It reads entities in
id-ordered pages twice per query, once for the BM25 corpus statistics and once to
score, and keeps only the best `k` in memory. Cost grows linearly with the graph.

**Seeding limits.**

- It does not fold diacritics: `Zoe` misses `Zoë`.
- A query of only stopwords finds no seeds.
- Any query word of three or more letters that is a substring of a name seeds it:
  `Dan works` seeds `Carol Danvers`.

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
query above differs per backend. See [Raw Cypher in Backends](backends.md#raw-cypher).

## Export to Obsidian

```python
notes = await graph.export_obsidian()  # {"Jane Doe.md": "...", "decisions/Pick a database.md": "..."}
```

`export_obsidian` renders the namespace as an [Obsidian](https://obsidian.md)
vault, one Markdown note per entity and one per decision, and returns each
note's path and text. It writes nothing; `selfgraph export obsidian DIR` writes
the notes into a folder you can open as a vault.

- An entity note is named after the entity. When two names collide, ignoring
  case, the later one in id order is named `Name (Type)`. Characters a file name
  or wiki link cannot hold become `-`.
- It holds the id, type, and aliases as front matter, then the properties, the
  current outgoing relations and preferences as `[[wiki links]]`, and links to the
  decisions the entity made. Obsidian derives backlinks, so incoming links are
  not repeated.
- A decision note, in `decisions/`, links its actor, outcome, alternatives, and
  steps in order.

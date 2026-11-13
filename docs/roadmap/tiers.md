# Tiers

Every capability is a ladder of tiers. A tier is one way of doing the job, and
each one up the ladder is more capable and more expensive. Extraction and
[entity resolution](../resolution.md) already work this way. The plan makes it
the rule everywhere.

The API on this page is a sketch, not a shipped interface.

## Choosing tiers

```python
graph = SelfGraph(store=store)                              # level="balanced"
graph = SelfGraph(store=store, level="light")
graph = SelfGraph(store=store, llm=llm, level="max")
graph = SelfGraph(store=store, llm=llm, resolver="llm")     # one capability
await graph.insert.text(text, contradiction="llm")          # one call
```

| Control | Effect |
|---------|--------|
| `level` | Sets every ladder at once: `light`, `balanced` (default), or `max`. |
| Per-capability option | Overrides the level for one capability, on the graph or on one call. |
| `max_tier` | A cost cap. No ladder climbs past it, whatever else is set. |

## What each level picks

| Capability | `light` | `balanced` | `max` |
|------------|---------|------------|-------|
| Extraction | regex | spaCy if installed, else regex | ontology-guided LLM |
| Resolution | derived ids | name and alias | LLM |
| Contradictions | warn | warn | LLM-judged |
| Retrieval seeds | BM25 | BM25 plus synonyms | embeddings plus reranking |
| Traversal | BFS | BFS | PageRank |

`max` needs an LLM, and an embedder for semantic seeding. A tier whose dependency
is missing raises `ValidationError` when the graph is built, as `resolver="llm"`
does today.

## Rules

**No silent escalation.** Passing `llm=` makes the LLM tiers available. It does
not switch them on. The one exception is extraction, which uses the LLM when one
is passed, as it does today (see [decisions](decisions.md)).

**Cascade.** A higher tier runs the lower ones first and takes only what they
could not decide. The `llm` resolver already does this: it merges everything
`fuzzy` merges and sends only the ambiguous similarity band to the model. This
keeps the cost of a high tier proportional to the hard cases.

**One data model.** Every tier writes the same ids and encoding. Moving up or
down a ladder needs no migration and no re-ingest.

**Tier labels.** Each fact records the tier that produced it, so a reader can
filter to deterministic facts or audit what a model decided.

**Determinism.** Inserts are idempotent and reproducible at every tier below the
LLM tiers. An LLM tier can return different output for the same input.

## Packaging

| Tier needs | Ships as |
|------------|----------|
| Nothing beyond the core | The base install. |
| spaCy, an LLM, a tokenizer | Existing extras. |
| An embedder, a reranker | A new extra behind a retriever hook. |
| Query generation | New extras, one per module (see [querying](querying.md)). |

Extras import from the core. The core never imports from an extra.

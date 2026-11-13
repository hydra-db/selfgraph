# Tiers

Every capability is a ladder of tiers, from light to powerful. One option,
`level`, sets them all. You can still set any one capability yourself.

The default is the strongest tier that is free and deterministic. Anything that
calls an LLM or an embedder is opt-in.

```python
graph = SelfGraph(store=store)                                # level="balanced"
graph = SelfGraph(store=store, level="light")
graph = SelfGraph(store=store, llm=llm, level="max")
graph = SelfGraph(store=store, llm=llm, contradiction="llm")  # one capability
await graph.insert.text(text, resolver="fuzzy")               # one call
print(graph.tiers)
```

## Ladders

Tiers run light to powerful.

| Capability | Tiers | Set with |
|------------|-------|----------|
| Extraction | `regex`, `spacy`, `llm` | `extraction=` on the graph |
| [Resolution](resolution.md) | `exact`, `default`, `fuzzy`, `llm` | `resolver=` on the graph or an insert |
| [Contradictions](schema.md#contradictions) | `off`, `warn`, `supersede`, `llm` | `contradiction=` on the graph or a write |
| [Retrieval seeds](retrieval.md#seeding-tiers) | `bm25`, `synonyms`, `embeddings` | `seeds=` on the graph or a `retrieve` |
| [Traversal](retrieval.md) | `bfs`, `dfs`, `ppr` | `strategy=` on a `retrieve` |

## What each level picks

| Capability | `light` | `balanced` (default) | `max` |
|------------|---------|----------------------|-------|
| Extraction | `regex` | `spacy` if installed, else `regex` | `llm` |
| Resolution | `exact` | `default` | `llm` |
| Contradictions | `warn` | `warn` | `llm` |
| Retrieval seeds | `bm25` | `synonyms` | `embeddings` with an `embedder=`, else `synonyms` |
| Traversal | `bfs` | `bfs` | `ppr` |

`level="max"` needs an LLM and raises `ValidationError` without one. So do
`resolver="llm"`, `contradiction="llm"`, and `extraction="llm"`.
`seeds="embeddings"` needs an `embedder=`.

## Rules

**No silent escalation.** Passing `llm=` makes the LLM tiers available. It does
not switch them on. The one exception is extraction: `insert.text` uses the LLM
when one is passed, at any level. Pass `extraction="regex"` or `"spacy"` to keep
it off.

**Cascade.** A higher tier runs the lower ones first and takes only what they
could not decide. The `llm` resolver asks the model only about names in a middle
similarity band. The `llm` contradiction tier judges only relations that no
`max_count` rule covers.

**One data model.** Every tier writes the same ids and encoding. Changing a tier
needs no migration and no re-insert.

**Determinism.** Inserts are idempotent and reproducible at every tier below the
LLM tiers. An LLM tier can decide differently on a rerun.

## Cost cap

`max_tier` is a ceiling no capability climbs past, whatever the level or a
per-call option asks for. A tier above the ceiling is lowered to it, not
rejected.

```python
graph = SelfGraph(store=store, llm=llm, level="max", max_tier="balanced")
```

| `max_tier` | Extraction | Resolution | Contradictions | Seeds |
|------------|------------|------------|----------------|-------|
| `light` | `regex` | `exact` | `supersede` | `bm25` |
| `balanced` | `spacy` | `fuzzy` | `supersede` | `synonyms` |
| `max` (default) | `llm` | `llm` | `llm` | `embeddings` |

`max_tier="balanced"` guarantees no LLM or embedder call from the built-in
tiers. A custom `extractor=` or resolver object is yours and is not capped.

## Which tier ran

`graph.tiers` holds the level, the cap, and each capability's default tier.
Every result names the tiers that produced it:

```python
result = await graph.insert.text("Ann works at Acme.")
result.tiers   # {"extraction": "regex", "resolution": "default", "contradiction": "warn"}
found = await graph.retrieve("Ann")
found.tiers    # {"seeds": "bm25", "traversal": "bfs"}
```

`extraction` reports the engine that ran, so it is `regex` when spaCy is not
installed. `seeds` is `bm25` when the graph has no schema to take synonyms
from. A custom extractor or resolver reports `custom`. A merge also records its
own signal in `MergeRecord.reason`, and a retired relation records what retired
it in `invalidated_by`.

## CLI and MCP

| | CLI | Environment |
|---|-----|-------------|
| Level | `--level` | `SELFGRAPH_LEVEL` |
| Cost cap | `--max-tier` | `SELFGRAPH_MAX_TIER` |

The MCP server reads the same settings. The CLI and MCP server take no
`embedder`, so `embeddings` seeding is SDK-only.

## Not built yet

These rungs are planned and do not exist: ontology-guided extraction, a
reranking tier, community traversal, evolving entity summaries, text-to-Cypher
and text-to-SQL modules, OWL and RDF interop, and resolving text mentions to
database records.

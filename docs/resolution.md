# Entity resolution

Entity resolution merges a new entity into a stored one that names the same
thing differently, such as "Big Blue" with the same ticker as "International
Business Machines". It runs on insert. Every merge is recorded and can be
reversed. It is off by default.

You may not need it. [Id derivation](resources.md#ids) already collapses "Acme
Inc", "Acme Corp", and "ACME" into one `company:acme`, with no merge record.

## Modes

Set the mode on the graph, or override it on one insert:

```python
graph = SelfGraph(store, resolver="default")
result = await graph.insert.ontology(ontology)
await graph.insert.text(text, resolver="exact")
```

| Mode | What merges |
|------|-------------|
| `exact` (default) | Nothing beyond derived ids. Runs no extra queries. |
| `default` | An id match, a shared external id, or a name or alias match. LLM-free and deterministic. Same as `DefaultResolver()`. |
| `fuzzy` | Everything `default` merges, plus same-type names whose lexical similarity reaches 0.92, also within one insert. LLM-free. Same as `DefaultResolver(fuzzy=True)`. |
| `llm` | Everything `fuzzy` merges, plus pairs in a similarity band that the configured LLM confirms. Needs `llm=`. |

`resolver` also takes a configured `DefaultResolver`, `LLMResolver`, or a
[custom resolver](#custom-resolvers). `resolver="llm"` without an LLM raises
`ValidationError` when the graph is built.

## Which entities are resolved

Resolution runs inside the insert, after validation and the schema check and
before anything is written.

An entity is a candidate when both hold:

- It has no explicit `id`. An entity you give an id is never merged, so omit `id`
  in ontologies you want resolved.
- Its derived id is not already stored. A known id is a plain upsert.

The resolver, built in or custom, is offered exactly these entities for each
candidate:

1. Every stored entity of a compatible type, ordered by id.
2. Then the compatible entities earlier in the same insert, unless the resolver
   sets `within_batch` to false.
3. For a candidate of type `Thing` (the extraction fallback), also entities of
   other types, stored or in the same insert, whose name or an alias matches its
   name or an alias, ignoring case. So `thing:robert-johnson` folds into
   `person:robert-johnson`. A typed candidate is never offered a `Thing`.

It never sees the rest of the namespace.

Types are compatible when they match case-sensitively after NFC normalization and
whitespace stripping. With a [schema](schema.md), a type is also compatible with
its `parent` ancestors and descendants. A `Manager` and a `Person` can merge, but
siblings never do.

Stored entities are read once per type per insert, in id-ordered pages, with no
cap. The `Thing` case adds one more listing. Memory grows with the number of
compatible entities, since the resolver is handed all of them.

## DefaultResolver

`DefaultResolver(fuzzy=False, threshold=0.92)` scores each compatible entity by
the first signal that fires:

| Signal | Confidence | Reason |
|--------|------------|--------|
| The candidate's id equals the entity's id. | 1.0 | `id` |
| The candidate and the entity share an external id key with the same value. | 1.0 | `external_id` |
| Any of the candidate's name and aliases matches the entity's name or one of its aliases, after NFC normalization and case folding. | 0.95 | `alias` |
| Same type, and the lexical similarity of the names reaches `threshold`. Only with `fuzzy=True`. | the score | `similarity` |

The highest confidence wins. A tie goes to the lexicographically smallest id. A
name match and an alias match score the same. So a candidate with alias `Jane`,
facing `person:jane` (alias `Jane`) and `person:jane3` (named `Jane`), merges
into `person:jane`.

Lexical similarity is the higher of two scores: Jaro-Winkler over the
case-folded names, and the Jaccard overlap of their content tokens.

With `fuzzy=True` an entity can also merge into one earlier in the same insert
(`within_batch`). Without it, only stored entities are targets.

### Names that never merge by similarity

A similarity merge, and an `LLMResolver` question, also needs the names to carry
the same distinguishing tokens (`distinct_names`). Id derivation is unaffected.

| Rule | Kept apart |
|------|------------|
| Digit runs of the case-folded names must be identical as multisets. | `Employee1` and `Employee2`, `Project 12` and `Project 13`, `Server00` and `Server0` |
| When both names have single-letter words, those must match. | `Model A` and `Model B` (but `John F Kennedy` and `John Kennedy` can merge) |
| Generational suffixes `Jr`, `Sr`, `II`, `III`, and `IV` must match. | `Bobby Tables Jr` and `Bobby Tables`, `Henry Ford II` and `Henry Ford III` |
| When both names have several words, every word of the shorter one (of both, at equal length) needs a counterpart in the other. | `Katherine Zorkfuzzy` and `Katherine Zorkdefault` |

A counterpart is a word it starts with or that starts with it, such as `Jon` and
`Jonathan` or the initial `J`. It can also be a word whose Jaro-Winkler
similarity reaches the threshold: `threshold` for `DefaultResolver`, the band's
bottom for `LLMResolver`.

Examples:

- `Jonathan Smithers` and `Jonathon Smithers` (similarity 0.976) merge under
  `fuzzy`.
- `Jon Smithers` and `Jonathan Smithers` pass the word check but score 0.873,
  below the default 0.92. They merge only with a lower threshold, such as
  `DefaultResolver(fuzzy=True, threshold=0.85)`, or when an `LLMResolver`
  confirms them.

## LLMResolver

`LLMResolver(llm, band=(0.8, 0.92), max_questions=3)` decides lexically first.
The `default` signals, and similarity at or above the band's top, merge without
asking.

For same-type names whose similarity falls in `[low, high)`, it asks the LLM a
strict yes/no question, highest similarity first, at most `max_questions` times
per candidate. It merges on the first yes, with reason `llm` and the similarity
as confidence. It also merges within one insert.

Below the band nothing is asked, so the LLM never merges an entity without a
lexical candidate. Pairs that fail the [word check](#names-that-never-merge-by-similarity)
are never asked either. `Bill Gates` and `William Gates` score 0.81, inside the
band, but `Bill` has no counterpart in `William`, so they stay apart. Link such
names with an alias or a shared external id.

## Custom resolvers

Any object with an async `resolve(candidate, existing)` method works as
`resolver`.

```python
from collections.abc import Sequence

from selfgraph import Entity, EntityInput, ResolutionDecision, SelfGraph


class TickerResolver:
    async def resolve(self, candidate: EntityInput, existing: Sequence[Entity]) -> ResolutionDecision:
        ticker = candidate.properties.get("ticker")
        for ent in existing:
            if ticker and ent.properties.get("ticker") == ticker:
                return ResolutionDecision(target_id=ent.id, confidence=1.0, reason="ticker")
        return ResolutionDecision()


graph = SelfGraph(store, resolver=TickerResolver())
```

- `candidate` is the `EntityInput`.
- `existing` holds the compatible stored entities as `Entity` models, plus the
  same-insert ones unless the resolver sets `within_batch = False`.
- It returns `ResolutionDecision(target_id, confidence, reason)`. `target_id` is
  the id of one offered entity to merge into, or `None` to keep the candidate.
- A merge needs `confidence` and `reason`, which go into the merge record. With
  no `target_id` both are optional.

These raise `ValidationError`: returning anything else, a merge missing either
field (the error names it), or an id that was not offered.

In TypeScript the method is `resolve(candidate: ParsedEntityInput, existing:
readonly Entity[]): Promise<ResolutionDecision>`. It returns `{ target_id,
confidence, reason }`, or `{ target_id: null }` for no merge.

## What a merge does

- The survivor keeps its id, name, and type.
- The candidate's name and aliases become survivor aliases.
- The candidate's external ids and properties fill only keys the survivor lacks.
- Every reference to the candidate in the same insert is rewritten to the
  survivor: relation endpoints, preference entities, and the decision actor,
  outcome, and alternatives. Derived relation, preference, and decision ids, and
  decision steps, follow.
- `result.entities` lists each stored entity once, at its first input's
  position.

Each merge adds a record to `result.merges` and an `entity_merged` warning with
the id in its `merge_id`:

```text
entity person:jd merged into person:jane-doe (alias, confidence 0.95, merge id entitymerge:...); undo with unmerge
```

A merge can turn a relation into a self-loop, such as `jane LIKES j` when `j`
merges into `jane`. That relation is dropped with a `merge_self_loop` warning,
along with decision steps naming it. The merge record keeps it, so unmerging
restores it.

## Merge records and unmerge

```python
page = await graph.entities.merges("company:international-business-machines")
result = await graph.entities.unmerge(page.items[0].id)
```

A merge record holds:

- the survivor and absorbed ids, and the absorbed input;
- the reason and confidence;
- `source_id` (the first source) and `source_ids`;
- exactly what the merge added to the survivor (`added_aliases`,
  `added_external_ids`, `added_properties`);
- each rewritten relation, preference, and decision, in its original and
  rewritten form.

Inserting the same merge again updates the one record.

`unmerge` does the following:

- Recreates the absorbed entity, with the survivor's evidence from the merge's
  sources (restoring its `source_count`) and the merge's `created_at`.
- Removes from the survivor only what the merge added. Its aliases, external ids,
  and properties end up exactly as they were before.
- Moves each rewritten object back between its original endpoints, with the
  current properties, event time, and evidence, and deletes the redirected one.
  An object that existed before the merge stays, and the original is added beside
  it. Decision steps follow moved relations.
- Where another live merge rewrote the same object, updates that merge's record
  to undo from the new place. Unmerging every merge of an insert, in any order,
  leaves exactly what the insert would have written without them.

The record stays, marked with `reverted_at`. `entities.merges` still lists it, so
a record with `reverted_at` set is no longer live. Unmerging it twice raises
`ValidationError`.

Deleting the survivor, or an entity whose id a merge absorbed, deletes those merge
records. A later merge of the same pair starts fresh.

## CLI and MCP

| Task | CLI | MCP |
|------|-----|-----|
| Set the mode | global `--resolver`, or `SELFGRAPH_RESOLVER` | server setting |
| Override for one insert | `insert text --resolver`, `insert ontology --resolver` | `resolver` argument of `insert_text` and `insert_ontology` |
| List merge records | `selfgraph entity merges ID` | `entity_merges` |
| Reverse a merge | `selfgraph entity unmerge MERGE_ID` | `unmerge_entity` |

## TypeScript

The options and fields keep their Python names. Both SDKs score names and make
decisions identically, and a parity fixture checks it.

```ts
import { DefaultResolver, SelfGraph } from "@hydradb/selfgraph";

const graph = new SelfGraph(store, { resolver: "default" });
await graph.insert.ontology(ontology, { resolver: new DefaultResolver({ fuzzy: true }) });
const page = await graph.entities.merges("company:international-business-machines");
await graph.entities.unmerge(page.items[0]!.id);
```

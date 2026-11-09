# Entity resolution

[Id derivation](resources.md#ids) already collapses "Acme Inc", "Acme Corp", and
"ACME" into one `company:acme`, with no merge record. Entity resolution goes
further: on insert it can fold a new entity into a stored one that names the same
thing differently, such as "Big Blue" with the same ticker as "International
Business Machines". Every merge is recorded and can be reversed. Resolution is off
by default.

## Modes

| Mode | What merges |
|------|-------------|
| `exact` (default) | Nothing beyond derived ids. Runs no extra queries. |
| `default` | An id match, a shared external id, or a name or alias match. LLM-free and deterministic. Same as `DefaultResolver()`. |
| `fuzzy` | Everything `default` merges, plus same-type names whose lexical similarity reaches 0.92, also within one insert. LLM-free. Same as `DefaultResolver(fuzzy=True)`. |
| `llm` | Everything `fuzzy` merges, plus pairs in a similarity band that the configured LLM confirms. Needs `llm=`. |

Set the mode on the graph, or override it on one insert:

```python
graph = SelfGraph(store, resolver="default")
result = await graph.insert.ontology(ontology)
await graph.insert.text(text, resolver="exact")
```

`resolver` also takes a configured `DefaultResolver`, `LLMResolver`, or a
[custom resolver](#custom-resolvers). `resolver="llm"` without an LLM raises
`ValidationError` when the graph is built.

## Which entities are resolved

Resolution runs inside the insert, after validation and the schema check and
before anything is written. An entity is a candidate when it has no explicit `id`
(an entity you give an id is never merged, so omit `id` in ontologies you want
resolved) and its derived id is not already stored (a known id is a plain upsert).

A resolver, built in or custom, is offered for each candidate exactly:

- every stored entity of compatible types, ordered by id, read once per type per
  insert in id-ordered pages with no cap (memory grows with the compatible
  entities, since the resolver is handed all of them). Types match case-sensitively after NFC
  normalization and whitespace stripping; with a [schema](schema.md), a type is
  also compatible with its `parent` ancestors and descendants, so a `Manager`
  and a `Person` can merge, but siblings never do.
- then the compatible entities earlier in the same insert, unless the resolver
  sets `within_batch` to false.
- for a candidate of type `Thing` (the extraction fallback), also entities of
  other types, stored (one more listing, no cap) or in the same insert,
  whose name or an alias matches its name or an alias ignoring case. So
  `thing:robert-johnson` folds into `person:robert-johnson`. A typed candidate is
  never offered a `Thing`.

It never sees the rest of the namespace.

## DefaultResolver

`DefaultResolver(fuzzy=False, threshold=0.92)` scores each compatible entity by the
first signal that fires:

| Signal | Confidence | Reason |
|--------|------------|--------|
| The candidate's id equals the entity's id. | 1.0 | `id` |
| The candidate and the entity share an external id key with the same value. | 1.0 | `external_id` |
| Any of the candidate's name and aliases matches the entity's name or one of its aliases, after NFC normalization and case folding. | 0.95 | `alias` |
| Same type, and the lexical similarity of the names reaches `threshold`. Only with `fuzzy=True`. | the score | `similarity` |

Lexical similarity is the higher of Jaro-Winkler over the case-folded names and
the Jaccard overlap of their content tokens. The highest confidence wins; a tie
goes to the lexicographically smallest id. A name match and an alias match score
the same, so a candidate with alias `Jane` facing `person:jane` (alias `Jane`) and
`person:jane3` (named `Jane`) merges into `person:jane`.

A similarity merge, and an `LLMResolver` question or band merge, also needs the
names to carry the same distinguishing tokens (`distinct_names`): the digit runs
of the two case-folded names must be identical as multisets, so `Employee1` and
`Employee2`, `Project 12` and `Project 13`, or `Server00` and `Server0` never
merge, and when both names have single-letter words those must match, so `Model A`
and `Model B` stay apart while `John F Kennedy` and `John Kennedy` can merge. The
generational suffixes `Jr`, `Sr`, `II`, `III`, and `IV` must match too, so `Bobby
Tables Jr` never merges into `Bobby Tables`, nor `Henry Ford II` into `Henry Ford
III`; id derivation is unaffected.
When both names have several words, every word of the shorter one (of both, at
equal length) needs a counterpart in the other: a word it starts with or that starts
with it, such as `Jon` and `Jonathan` or the initial `J`, or a word whose
Jaro-Winkler similarity reaches the threshold (`threshold` for `DefaultResolver`,
the band's bottom for `LLMResolver`). So `Katherine Zorkfuzzy` never merges into
`Katherine Zorkdefault`. `Jonathan Smithers` and `Jonathon Smithers` (similarity
0.976) merge under `fuzzy`; `Jon Smithers` and `Jonathan Smithers` pass the word
check but score 0.873, below the default 0.92, so they merge only with a lower
threshold, such as `DefaultResolver(fuzzy=True, threshold=0.85)`, or when an
`LLMResolver` confirms them.

With `fuzzy=True` an entity can also merge into one earlier in the same insert
(`within_batch`); without it, only stored entities are targets.

## LLMResolver

`LLMResolver(llm, band=(0.8, 0.92), max_questions=3)` decides lexically first: the
`default` signals and similarity at or above the band's top merge without asking.
For same-type names whose similarity falls in `[low, high)`, it asks the LLM a
strict yes/no question, highest similarity first, and merges on the first yes with
reason `llm` and the similarity as confidence. Below the band nothing is asked, so
the LLM never merges an entity without a lexical candidate. Pairs that fail the word
check above are never asked either: `Bill Gates` and `William Gates` score 0.81,
inside the band, but `Bill` has no counterpart in `William`, so they stay apart;
link such names with an alias or a shared external id. It also merges within one
insert.

## Custom resolvers

Any object with an async `resolve(candidate, existing)` method works as `resolver`.
It receives the candidate `EntityInput` and the compatible stored (and, unless it
sets `within_batch = False`, same-insert) entities as `Entity` models, and returns a
`ResolutionDecision(target_id, confidence, reason)`: `target_id` is the id of one of
the offered entities to merge into, or `None` to keep the candidate. A merge
needs `confidence` and `reason`, which go into the merge record; with no
`target_id` both are optional. Returning anything else, a merge missing either
field (the error names it), or an id that was not offered raises
`ValidationError`.

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

In TypeScript the method is `resolve(candidate: ParsedEntityInput, existing:
readonly Entity[]): Promise<ResolutionDecision>`, returning `{ target_id, confidence,
reason }`, or just `{ target_id: null }` for no merge.

## What a merge does

The survivor keeps its id, name, and type. The candidate's name and aliases
become its aliases, and the candidate's external ids and properties fill only
keys the survivor lacks. Every reference to the candidate in the same insert
(relation endpoints, preference entities, decision actor, outcome, and
alternatives) is rewritten to the survivor, and derived relation, preference, and
decision ids and decision steps follow.

Each merge adds an `entity_merged` warning, such as `entity person:jd merged into
person:jane-doe (alias, confidence 0.95, merge id entitymerge:...); undo with
unmerge`, with the id also in its `merge_id`, and a record to `result.merges`.
`result.entities` lists each stored entity once, at its first input's position. A
relation the merges would turn into a self-loop, such as `jane LIKES j` when `j`
merges into `jane`, is dropped with a `merge_self_loop` warning, along with
decision steps naming it; the merge record keeps it, so unmerging restores it.

## Merge records and unmerge

A merge record holds the survivor and absorbed ids, the absorbed input, the
reason and confidence, `source_id` (the first source) and `source_ids`, exactly
what the merge added to the survivor (`added_aliases`, `added_external_ids`,
`added_properties`), and each rewritten relation, preference, and decision in its
original and rewritten form. Inserting the same merge again updates the one
record.

```python
page = await graph.entities.merges("company:international-business-machines")
result = await graph.entities.unmerge(page.items[0].id)
```

`unmerge`:

- recreates the absorbed entity, with the survivor's evidence from the merge's
  sources (restoring its `source_count`) and the merge's `created_at`;
- removes from the survivor only what the merge added, so its aliases, external
  ids, and properties are exactly what they were before;
- moves each rewritten object back between its original endpoints with the
  current properties, event time, and evidence, deleting the redirected one. An
  object that existed before the merge stays, with the original added beside it,
  and decision steps follow moved relations. Where another live merge rewrote the
  same object, that merge's record is updated to undo from the new place, so
  unmerging every merge of an insert, in any order, leaves exactly what the
  insert would have written without them.

The record stays, marked with `reverted_at`; unmerging it twice raises
`ValidationError`. `entities.merges` still lists reverted records, so a record
with `reverted_at` set is no longer live. Deleting the survivor, or an entity whose id a merge absorbed,
deletes those merge records, so a later merge of the same pair starts fresh.

## CLI and MCP

The global `--resolver` flag or `SELFGRAPH_RESOLVER` sets the mode, and `insert
text` and `insert ontology` take `--resolver` for one call. `selfgraph entity
merges ID` lists records and `selfgraph entity unmerge MERGE_ID` reverses one.
In MCP, use the `resolver` argument of `insert_text` and `insert_ontology`,
`entity_merges`, and `unmerge_entity`.

## TypeScript

The options and fields keep their Python names.

```ts
import { DefaultResolver, SelfGraph } from "@hydradb/selfgraph";

const graph = new SelfGraph(store, { resolver: "default" });
await graph.insert.ontology(ontology, { resolver: new DefaultResolver({ fuzzy: true }) });
const page = await graph.entities.merges("company:international-business-machines");
await graph.entities.unmerge(page.items[0]!.id);
```

Both SDKs score names and make decisions identically; a parity fixture checks it.

# Answering safely

An agent that answers from a graph needs to know when the graph has no answer.
`retrieve` always returns whatever its keywords reach, even when that is
unrelated to the question. The checks on this page tell an agent what the graph
holds before it answers. None of them calls an LLM.

| Check | Answers |
|-------|---------|
| [`readiness`](#readiness) | Is the store reachable, and does the namespace hold data? |
| [`check_answerable`](#check_answerable) | Does the graph hold what this question asks about? |
| [Hubs](#hubs) | Is a connection real, or does it run through an entity linked to everything? |
| [Certification](#certification) | Which facts did a person verify? |
| [Cypher notes](#cypher-notes) | Why did a raw query return nothing? |

The MCP server tells clients to use them in this order: `check_readiness`, then
`check_answerable`, then `retrieve`, and to say "not in the graph" on a
`not_answerable` verdict.

## readiness

```python
report = await graph.readiness()
```

| Field | Holds |
|-------|-------|
| `ready` | True when the store is reachable and the namespace has at least one entity. |
| `reachable`, `error` | Whether the store answered, and its error when it did not. An unreachable store is reported, not raised. |
| `store`, `namespace`, `has_schema` | The store class, the namespace, and whether a schema is set. |
| `counts` | Entities, current relations, current preferences, decisions, and sources. |
| `lint` | Each problem found, as `{code, count, sample}`, with up to five ids in id order. |

| Lint code | Means |
|-----------|-------|
| `orphan_entity` | No current relation, preference, decision, or live merge record references the entity. A merge survivor is never listed, since deleting it would lose its [unmerge](resolution.md). |
| `unsupported_fact` | A current relation has no evidence record. |
| `stale_decision_step` | A decision has a step whose relation is no longer current. |
| `type_off_schema` | With a schema, an entity or relation type it does not declare. |

`readiness` reads every item in the namespace and writes nothing. Act on what it
finds with [prune](maintenance.md#prune) or the typed deletes.

## check_answerable

```python
report = await graph.check_answerable("where does Ann work")
report = await graph.check_answerable("...", terms=["Ann", "churn rate"], as_of="2025-06-01", depth=3)
```

The question is split into terms. Each run of words that spells a stored
multi-word name or alias, or a multi-word schema term such as `staff size`, is
one term, and every other word is its own term.
Stopwords and filler such as "where", "tell", and "me" are dropped. An agent can
pass its own `terms` instead.

Each term is matched, in order, against entity names and aliases, then entity
types, then [definitions](ontology.md#terms), then relation types, then property
and preference keys. The first kind with a match the graph holds covers the
term. Schema types, definitions, and relation types match by name, alias, and
[synonym](ontology.md#terms), so `firm` covers `Company`, but only when the
graph holds something of that term: an entity of the type or a subtype, an
entity of a definition's type, or a relation of the type. A term that only an
unpopulated schema term matches is `schema_only` and counts as missing, so a
schema alone never makes a question answerable. Matching is lexical,
with the [retrieval seeding rules](retrieval.md#how-it-works): a word matches as
a word, ignoring a plain plural ending, or as a substring when it has three or
more letters.

| Verdict | When |
|---------|------|
| `answerable` | Every term is covered, and the entities matched by different terms connect within `depth` hops. |
| `partial` | Some terms are covered and some are not; `missing` lists them. |
| `uncertain` | Every term is covered, but matched entities do not connect, or connect only through a hub (`hub_only`). |
| `not_answerable` | No term is covered. |

Each entry of `terms` is `{term, status, matches, certified}`, where `status` is
`entity`, `type`, `definition`, `relation`, `property`, `schema_only`, or
`missing`, `matches` lists up to ten matched ids or term names, and `certified`
is true when a certified schema term matched: the schema term was reviewed,
which says nothing about the stored facts (see [Certification](#certification)
for facts). With [embedding seeds](retrieval.md#how-it-works), a report with
missing terms carries a `note` that the check is lexical, since `retrieve` may
still find them by meaning. `as_of` judges the graph as it stood then, with the
[as_of rules](retrieval.md#as-of-a-point-in-time). The check reads every entity
and relation in the namespace.

## Hubs

A hub is an entity with 50 or more current relations, such as a shared document
or a generic `Person`. Two entities linked only through a hub are weakly related.

- `retrieve` lists the hubs its walk reached in `hubs`, and marks each context
  line through a hub that is not a seed with `(via hub)`.
- `retrieve(..., skip_hubs=True)` keeps hubs it reaches but does not walk
  through them. With `strategy="ppr"`, a skipped hub also passes no PageRank
  on: its mass restarts at the seeds.
- `check_answerable` reports pairs of terms joined only through a hub in
  `hub_only` and returns `uncertain` for them.

## Certification

```python
await graph.relations.certify(rid, by="ops-team")
await graph.relations.uncertify(rid)
```

Certifying marks the current version of a relation as verified, with
`certified_at` and `certified_by`, in place and without a new version. This is a
fact a person checked, unlike a `certified` schema term, which is a definition a
person reviewed. A certified relation:

- stays current when a [supersede contradiction](schema.md#contradictions) or
  the `llm` contradiction tier would retire it, with a `certified_kept` warning
  instead of `relation_superseded`;
- stays current when a [replaced source](inserting.md#replacing-a-source) no
  longer states it, with a `certified_kept` warning;
- is kept by [prune](maintenance.md#prune), with the entities it connects,
  unless `include_certified` is set;
- holds its group back from [dedupe_relations](maintenance.md#dedupe-relations),
  which lists the group in `certified` and leaves it alone;
- blocks an [unmerge](resolution.md) that would move it to other endpoints
  until it is uncertified;
- comes first among equally close relations in `retrieve` context, marked
  `[certified]`.

The mark belongs to the version: a change to its properties or event time
writes a new revision that starts uncertified, and an insert that does so warns
`certified_dropped`. Restating the same fact, or adding evidence, keeps the
mark. Only a current relation can be certified.

## Cypher notes

The MCP `run_cypher` tool and the CLI `query` command explain a query that
returns no rows. `warnings` names:

- each label or relationship type the namespace never stored, with the stored
  ones;
- each `name` literal no entity has exactly, when one differs only by letter
  case or spacing.

When the backend rejects the query instead (Kuzu does for an unknown label), the
same notes are appended to the error. The notes read every entity and relation,
so they run only for an empty or failed query. `graph.run_cypher` in the SDK
does not add them.

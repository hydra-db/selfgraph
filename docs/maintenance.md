# Maintenance

`graph.maintenance` has three operations:

| Operation | Does |
|-----------|------|
| [`decay`](#decay) | Scores how relevant each entity and relation still is. |
| [`prune`](#prune) | Removes what falls below a bar. |
| [`consolidate`](#consolidate) | Merges duplicate relations. |

Nothing runs on its own. All three are dry runs by default. Pass `dry_run=False`
to write.

```python
scores = await graph.maintenance.decay(half_life_days=30)
stored = await graph.maintenance.decay(half_life_days=30, dry_run=False)
plan = await graph.maintenance.prune(min_relevance=0.05)
done = await graph.maintenance.prune(min_relevance=0.05, dry_run=False)
merged = await graph.maintenance.consolidate(dry_run=False)
```

## decay

`decay(half_life_days=30, now=None, dry_run=True)` scores every entity and
current relation. It returns a `DecayResult` with the score per id. With
`dry_run=False` it stores each score as `relevance`, and the time as
`relevance_at`, and counts what it wrote. Both fields are `None` until the first
applied decay.

Python and TypeScript compute the same value:

```
age_days   = max(0, now - latest timestamp), counted in whole milliseconds
recency    = 0.5 ** (age_days / half_life_days)
n          = source_count, plus degree for an entity
frequency  = n / (n + 1)
relevance  = round_half_up(recency * (1 + frequency) / 2, 6 decimals)
```

- The latest timestamp is the later of `created_at` and `updated_at` for an
  entity, and of `created_at` and `event_time` for a relation.
- Degree counts the current relations that touch the entity.
- A score lies in `[0, 1)`. A brand-new relation from one source scores `0.75`.
  A brand-new item with no sources and no relations scores `0.5`.

The score is written in place. It creates no new relation version, leaves
`updated_at` and user properties untouched, and survives later entity updates. A
new relation version starts unscored. Rerunning with the same `now` writes
nothing. A `now` more than one minute in the future raises `ValidationError`.

Retrieval uses `relevance` only to break ties between seeds with equal keyword
scores.

## prune

`prune(min_relevance=None, older_than=None, types=None, relation_types=None, dry_run=True)`
removes entities and current relations that match every criterion given. At
least one of `min_relevance` or `older_than` is required.

| Argument | Matches |
|----------|---------|
| `min_relevance` | Items whose `relevance` is below this, a number in `[0, 1]`. Items never scored do not match. |
| `older_than` | Items whose latest timestamp is before this time. A time more than one minute ahead raises `ValidationError`. |
| `types` | Narrows the entities to these entity types. Not a criterion on its own. |
| `relation_types` | Narrows the relations to these relation types, normalized like any relation type. Not a criterion on its own. |

Each narrowing filter applies only to its own kind:

| Given | Entities matched | Relations matched directly |
|-------|------------------|----------------------------|
| Neither | all that meet the criteria | all that meet the criteria |
| Only `types` | those types | none |
| Only `relation_types` | none | those types |
| Both | those entity types | those relation types |

The relations of a pruned entity always go with it. So `types=["Tool"],
relation_types=["NOPE"]` still lists the matching `Tool` entities and their
relations.

Removal goes through the normal deletes, so a pruned entity takes what
[`entities.delete`](resources.md#updating-and-deleting) takes. A relation a
[contradiction](schema.md#contradictions) retired is never matched or scored. It
stays as history until an endpoint is pruned.

The `PruneResult` lists `entity_ids` and `relation_ids`, including relations
removed with an endpoint. Once applied, it adds `deleted` counts, and one line is
logged at INFO on the `selfgraph` logger.

With `min_relevance` and nothing scored yet, the plan is empty and its `note`
says `no items have a relevance score yet; run maintenance.decay(dry_run=False) first`.
The CLI and MCP word it `run maintenance decay --apply first` and show it only in
the JSON.

## consolidate

`consolidate(dry_run=True)` finds current relations that share the same source,
normalized type, and target but have different ids. This happens when relations
are created with explicit ids. Each group collapses into its lowest id:

- **Properties** are unioned. The survivor wins a conflict, then each duplicate in
  id order. Every key whose value a duplicate loses is listed in the group's
  `conflicts`, by duplicate id. A property change makes a new survivor version.
- **Event time.** The survivor takes the earliest non-null `event_time` of the
  group.
- **Evidence** records move onto the survivor. Its `source_count` becomes the
  number of distinct sources across them.
- **Decision steps** on a duplicate are repointed to the survivor before it is
  deleted. A trace with steps on both then lists the survivor twice. No decision
  is deleted, so `deleted.deleted_decisions` is always 0.
- **Versions.** The duplicates are deleted with every version. Only the
  survivor's history is kept, even when a duplicate is newer or has more
  versions.

Relations a contradiction invalidated are never grouped.

The `ConsolidateResult` lists each group's `survivor`, `duplicates`, `conflicts`,
and `versions_lost` (each duplicate's version count, all deleted). It also has a
`note` stating the survivor rule. Once applied, it adds `deleted` counts and logs
one INFO line. Review `versions_lost` in the dry run before applying.

## Scale

Each operation reads a page at a time and writes in batches of up to 1000 ids.
`decay` and `prune` use one transaction per batch, and `consolidate` one per
group. The scan holds every id in memory, so maintain very large graphs from a
worker rather than a request path.

## CLI, MCP, and TypeScript

```bash
selfgraph maintenance decay --half-life-days 14 --apply
selfgraph maintenance prune --older-than 2025-01-01 --type Session
selfgraph maintenance prune --older-than 2025-01-01 --relation-type VISITED
selfgraph maintenance prune --min-relevance 0.05 --apply
selfgraph maintenance consolidate --apply
```

- The CLI writes only with `--apply`. `decay` also takes `--now`.
- The MCP tools `maintenance_decay`, `maintenance_prune`, and
  `maintenance_consolidate` take the same arguments, with `dry_run` defaulting to
  true.
- In TypeScript the options keep their Python names:

```ts
await graph.maintenance.decay({ half_life_days: 30, dry_run: false });
await graph.maintenance.prune({ older_than: "2025-01-01", dry_run: false });
await graph.maintenance.consolidate({ dry_run: false });
```

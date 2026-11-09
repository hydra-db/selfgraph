# Maintenance

`graph.maintenance` has three operations: `decay` scores how relevant each entity
and relation still is, `prune` removes what falls below a bar, and `consolidate`
merges duplicate relations. Nothing runs on its own, and all three are dry runs
by default: pass `dry_run=False` to write.

```python
scores = await graph.maintenance.decay(half_life_days=30)
stored = await graph.maintenance.decay(half_life_days=30, dry_run=False)
plan = await graph.maintenance.prune(min_relevance=0.05)
done = await graph.maintenance.prune(min_relevance=0.05, dry_run=False)
merged = await graph.maintenance.consolidate(dry_run=False)
```

## decay

`decay(half_life_days=30, now=None, dry_run=True)` scores every entity and
current relation, returning a `DecayResult` with the score per id. With
`dry_run=False` it stores each score as `relevance` and the time as
`relevance_at` (both `None` until the first decay) and counts what it wrote.
Python and TypeScript compute the same value:

```
age_days   = max(0, now - latest timestamp), counted in whole milliseconds
recency    = 0.5 ** (age_days / half_life_days)
n          = source_count, plus degree for an entity
frequency  = n / (n + 1)
relevance  = round_half_up(recency * (1 + frequency) / 2, 6 decimals)
```

The latest timestamp is the later of `created_at` and `updated_at` for an entity,
and of `created_at` and `event_time` for a relation. Degree counts the current
relations that touch the entity. A score lies in `[0, 1)`: a brand-new relation
from one source scores `0.75`, and a brand-new item with no sources and no
relations scores `0.5`.

The score is written in place: no new relation version, `updated_at` and user
properties untouched, and it survives later entity updates. A new relation
version starts unscored. Rerunning with the same `now` writes nothing. A `now`
more than one minute in the future raises `ValidationError`.

Retrieval uses `relevance` only to break ties between seeds with equal keyword
scores.

## prune

`prune(min_relevance=None, older_than=None, types=None, relation_types=None, dry_run=True)` removes
entities and current relations that match every criterion given:

| Argument | Matches |
|----------|---------|
| `min_relevance` | Items whose `relevance` is below this, a number in `[0, 1]`. Items never scored do not match. |
| `older_than` | Items whose latest timestamp is before this time. A time more than one minute ahead raises `ValidationError`, as `decay` does for `now`. |
| `types` | Narrows the entities to these entity types. It is not a criterion on its own. |
| `relation_types` | Narrows the relations to these relation types (normalized like any relation type). It is not a criterion on its own. |

Each filter applies only to its own kind. Given only `types`, no relation is
matched directly (only the relations of a pruned entity go with it); given only
`relation_types`, no entity is matched. Given both, entities are narrowed by
`types` and relations by `relation_types`, independently: `types=["Tool"],
relation_types=["NOPE"]` still lists the matching `Tool` entities (and their
relations) and matches no relation directly. With neither, both kinds are
matched.

At least one of `min_relevance` or `older_than` is required. Removal goes
through the normal deletes, so a pruned entity takes what
[`entities.delete`](resources.md#updating-and-deleting) takes. The `PruneResult`
lists `entity_ids` and `relation_ids` (including relations removed with an
endpoint) and, once applied, `deleted` counts. With `min_relevance` and nothing
scored yet, the plan is empty and its `note` says `no items have a relevance
score yet; run maintenance.decay(dry_run=False) first` (`run maintenance decay --apply
first` in the CLI and MCP, where the note appears only in the JSON). An applied prune logs one line
at INFO on the `selfgraph` logger. A relation a
[contradiction](schema.md#contradictions) retired is never matched or scored; it
stays as history until an endpoint is pruned.

## consolidate

`consolidate(dry_run=True)` finds current relations that share the same source,
normalized type, and target but have different ids, which happens when relations
are created with explicit ids. Each group collapses into its lowest id:

- Properties are unioned, and the survivor wins on a conflict, then each duplicate
  in id order. Every key whose value a duplicate loses is listed in the group's
  `conflicts`, by duplicate id, in the plan and in the result. A property change
  makes a new survivor version.
- The survivor takes the earliest non-null `event_time` of the group.
- Evidence records move onto the survivor, and its `source_count` becomes the
  number of distinct sources across them.
- Decision steps on a duplicate are repointed to the survivor before it is
  deleted (a trace with steps on both then lists the survivor twice).
  Consolidate never deletes a decision, so `deleted.deleted_decisions` is
  always 0.
- The duplicates are then deleted with every version. Only the survivor's version
  history is kept, even when a duplicate is newer or has more versions.

Relations a contradiction invalidated are never grouped.

The `ConsolidateResult` lists each group's `survivor`, `duplicates`,
`conflicts`, and `versions_lost` (each duplicate's version count, all deleted), a
`note` stating the survivor rule, and, once applied, `deleted` counts and one INFO
log line. Review `versions_lost` in the dry run before applying.

## Scale

Each operation reads a page at a time and writes in batches of up to 1000 ids,
one transaction per batch for `decay` and `prune` and per group for
`consolidate`. The scan holds every id in memory, so maintain very large graphs
from a worker rather than a request path.

## CLI, MCP, and TypeScript

```bash
selfgraph maintenance decay --half-life-days 14 --apply
selfgraph maintenance prune --older-than 2025-01-01 --type Session
selfgraph maintenance prune --older-than 2025-01-01 --relation-type VISITED
selfgraph maintenance prune --min-relevance 0.05 --apply
selfgraph maintenance consolidate --apply
```

The CLI writes only with `--apply`, and `decay` also takes `--now`. The MCP tools
`maintenance_decay`, `maintenance_prune`, and `maintenance_consolidate` take the
same arguments, with `dry_run` defaulting to true. In TypeScript the options keep
their Python names:

```ts
await graph.maintenance.decay({ half_life_days: 30, dry_run: false });
await graph.maintenance.prune({ older_than: "2025-01-01", dry_run: false });
await graph.maintenance.consolidate({ dry_run: false });
```

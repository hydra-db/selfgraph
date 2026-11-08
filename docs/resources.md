# Resources

The graph exposes four typed resources: `graph.entities`, `graph.relations`,
`graph.preferences`, and `graph.decisions`. Each offers `create`, `get`, `list`,
`iterate`, `update`, and `delete`. Ids are deterministic, so `create` with an id
that already exists raises `ConflictError`; change a record with `update`, or use
`insert.ontology`, which merges into an existing record. `delete` raises
`NotFoundError` for an id that does not exist, and `versions` returns an empty list
for one.

## Entities

An id defaults to `type:name` with the name canonicalized, so surface variants of
one entity (`Acme`, `Acme, Inc.`) share an id. Compute the id a name will resolve
to with `selfgraph.entity_id(type, name)`, which is useful when authoring relations
that reference an entity by id. Deleting an entity also removes its relations, its
preferences, its evidence, and any decision trace that references it. A decision that only
considered it as an alternative drops that alternative, and a preference that is
only about it gets a new version without `about_entity`.

```python
from selfgraph import entity_id

entity_id("Company", "Acme, Inc.")              # 'company:acme'

acme = await graph.entities.create("Acme", "Company", id="company:acme")
jane = await graph.entities.create(
    "Jane Doe",
    "Person",
    aliases=["Jane"],
    properties={"role": "CEO"},
)

await graph.entities.get("company:acme")
await graph.entities.evidence("company:acme", limit=50)   # Page of Evidence
await graph.entities.update("company:acme", name="Acme Inc")
await graph.entities.delete("company:acme")
```

## Evidence

Each piece of evidence is its own record: one per entity or relation, source,
source version, chunk, and quote, so re-inserting the same source adds nothing. An
entity or relation does not hold its evidence list; it carries `source_count`, the
number of distinct sources behind it, which retrieval uses to damp generic
entities. Page through the records with `entities.evidence(id, cursor=None,
limit=50)` or `relations.evidence(id, ...)`, which return a `Page` like `list`
(ordered by evidence id) and raise `NotFoundError` for an unknown id. Deleting an
entity or relation deletes its evidence. The CLI has `entity evidence ID` and
`relation evidence ID`, and the MCP server has `entity_evidence` and
`relation_evidence`.

## Relations

A relation connects two entities and carries properties. Updating a relation
writes a new version and keeps the old one. Evidence passed to `update` adds
evidence records to the relation; it never replaces or clears them.

Some relation types are reserved for the edges SelfGraph writes itself and are
rejected: `PREFERS`, `AVOIDS`, `HAS_PROFILE`, `MADE_DECISION`, `HAS_STEP`, `FROM`,
`TO`, `RESULTED_IN`, `CONSIDERED`, `HAS_VERSION`, and `HAS_CHUNK` (in any case).
Record preferences and decisions through their own resources, and pick another type,
such as `LIKES` or `MOVED_FROM`, for ordinary relations.

```python
rel = await graph.relations.create(
    "person:jane",
    "WORKS_AT",
    "company:acme",
    properties={"title": "CEO"},
)

await graph.relations.update("rel-id", set_properties={"title": "Chair"})
await graph.relations.versions("rel-id")        # newest first
await graph.relations.evidence("rel-id")        # Page of Evidence, all versions
await graph.relations.get("rel-id")             # current version
```

## Preferences

A preference records that a subject prefers or avoids a value along a key.
`strength` is optional and ranges from 0 to 1. Preferences are versioned like
relations, so `versions` returns their history.

```python
await graph.preferences.create(
    "person:jane",
    "database",
    "company:acme",
    kind="preference",
    strength=0.9,
)

await graph.preferences.list("person:jane")   # one subject
await graph.preferences.list()                 # every subject
await graph.preferences.versions("pref-id")    # newest first
```

## Decisions

A decision trace records a choice: its reasoning steps, rationale, outcome, and
alternatives. Each step is the id of a relation that already exists, kept in the
order given; the steps are not checked to form a connected path. A new decision's
`status` defaults to `"completed"`; pass `status="active"` for one still in
progress. A decision's derived id is its actor plus its title,
so two decisions by the same actor with the same title resolve to one; pass an
explicit `id` to keep distinct decisions that share both. Decisions are mutated in
place and are not versioned.

```python
step = await graph.relations.create("person:jane", "COMPARED", "company:acme")

await graph.decisions.create(
    "Picked the backend",
    steps=[step.id],
    rationale="best temporal support",
    outcome_entity="company:acme",
)
```

## Listing and iterating

`list` returns one `Page` with a `next_cursor`. Pass the cursor to read the next
page.

```python
page = await graph.entities.list(type="Company", limit=50)
for entity in page.items:
    print(entity.name)
next_page = await graph.entities.list(type="Company", cursor=page.next_cursor)
```

`iterate` follows the cursor for you and yields every match:

```python
async for entity in graph.entities.iterate(type="Company"):
    print(entity.name)
```

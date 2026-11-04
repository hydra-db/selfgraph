# Resources

The graph exposes four typed resources: `graph.entities`, `graph.relations`,
`graph.preferences`, and `graph.decisions`. Each offers `create`, `get`, `list`,
`iterate`, `update`, and `delete`. Ids are deterministic, so passing the same
`id` updates the existing record.

## Entities

```python
acme = await graph.entities.create("Acme", "Company", id="company:acme")
jane = await graph.entities.create(
    "Jane Doe",
    "Person",
    aliases=["Jane"],
    properties={"role": "CEO"},
)

await graph.entities.get("company:acme")
await graph.entities.update("company:acme", name="Acme Inc")
await graph.entities.delete("company:acme")
```

## Relations

A relation connects two entities and carries properties. Updating a relation
writes a new version and keeps the old one.

```python
rel = await graph.relations.create(
    "person:jane",
    "WORKS_AT",
    "company:acme",
    properties={"title": "CEO"},
)

await graph.relations.update("rel-id", set_properties={"title": "Chair"})
await graph.relations.versions("rel-id")        # newest first
await graph.relations.get("rel-id")             # current version
```

## Preferences

A preference records that a subject prefers or avoids a value along a key.

```python
await graph.preferences.create(
    "person:jane",
    "database",
    "company:acme",
    kind="preference",
    strength=0.9,
)

await graph.preferences.list("person:jane")
```

## Decisions

A decision trace records a choice: its reasoning steps, rationale, outcome, and
alternatives. Each step is the id of a relation that already exists, so the trace
links a sequence of relations.

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

# Resources

`graph.entities`, `graph.relations`, `graph.preferences`, and `graph.decisions`
each offer `create`, `get`, `list`, `iterate`, `update`, and `delete`.

- Ids are deterministic, so `create` with an id that exists, explicit or derived,
  raises `ConflictError` (`Relation '<id>' already exists`). Change a record with
  `update`, or with `insert.ontology`, which merges into it.
- `get` returns `None` (`null` in TypeScript, and from MCP `get_*` tools) for a
  missing id; CLI `get` exits 1 (see [exit codes](cli.md#exit-codes)). `update`,
  `delete`, and `versions` raise `NotFoundError`.
- An update that names no field raises `ValidationError` (`nothing to update`)
  on every resource (`entities`, `relations`, `preferences`, `decisions`), and so
  does an unknown field.
- Property keys follow the [property value rules](inserting.md#property-values).

The id helpers compute the id an insert derives:

| Python | TypeScript |
|--------|------------|
| `entity_id(type, name)` | `entityId(type, name)` |
| `relation_id(from_entity, type, to_entity)` | `relationId(fromEntity, type, toEntity)` |
| `preference_id(subject_entity, kind, key, value_entity)` | `preferenceId(subjectEntity, kind, key, valueEntity)` |
| `decision_id(actor_entity, title)` | `decisionId(actorEntity, title)` |

## Entities

```python
from selfgraph import entity_id

entity_id("Company", "Acme, Inc.")              # 'company:acme'

acme = await graph.entities.create("Acme", "Company", id="company:acme")
jane = await graph.entities.create("Jane Doe", "Person", aliases=["Jane"], properties={"role": "CEO"})
await graph.entities.get("company:acme")
await graph.entities.evidence("company:acme", limit=50)   # Page of Evidence
await graph.entities.update("company:acme", name="Acme Inc")
await graph.entities.delete("company:acme")
```

### Ids

A derived id is `type:name`, both slugged: NFC-normalized, lowercased, stripped,
whitespace runs turned into one hyphen, and punctuation, symbols, and emoji
dropped from the name. So `Acme` and `ACME` share an id, `Bob 😀` and `Bob` both
become `person:bob`, and type `Per son` gives `per-son:bob`. A name with nothing
else left keeps its symbols (`person:😀`).

For organization-like types (`Company`, `Organization`, `Organisation`, `Org`,
`Corporation`, `Corp`, `Business`, `Firm`, `Institution`, `Agency`, `Employer`,
`Vendor`, `Bank`, in any case) the name also drops a leading `The` and trailing
suffixes (`Inc`, `Incorporated`, `Corp`, `Corporation`, `Co`, `Company`, `Ltd`,
`Limited`, `LLC`, `LLP`, `LP`, `PLC`, `Group`, `Holdings`, `GmbH`, `AG`, `SA`,
`NV`, `The`) until one word is left. Other words, such as `Labs`, stay
(`company:acme-labs`). So `Acme Group` and `Acme Holdings` both
become `company:acme` and merge; pass an explicit `id` to keep them apart. Other
types keep every word (`work:the-trial`).

An explicit entity id is canonicalized wherever an entity id is accepted: split
at the first colon, each part is NFC-normalized, lowercased, stripped, and has
whitespace runs turned into one hyphen, so `Person:Jane Doe` names
`person:jane-doe`. Punctuation is kept (`doc:v1.2`).
`ids.canonical_entity_id(id)` (`ids.canonicalEntityId`) returns that form. An id
without a colon or with an empty part (`jane`, `person:`) raises
`ValidationError` (`entity id must be 'type:name'`).

An explicit id must carry the entity's type, in id form, as its prefix:
`{"id": "company:x", "type": "Person"}` raises `ValidationError` (`id
'company:x' does not match type 'Person' (expected prefix 'person:')`). With a
[schema](schema.md), a prefix naming another name or alias of the entity's own
type is rewritten: `{"id": "org:acme", "type": "org"}` is stored as
`company:acme` when `org` is an alias of `Company`, and references to `org:acme`
in the same insert follow it.

An explicit id is never re-derived from the name: `person:jane` named `Jane Doe`
and a later `Jane Doe` without an id (`person:jane-doe`) are two entities unless
you reference the explicit id or set `resolver="default"` (see
[Entity resolution](resolution.md)).

An entity type may contain only letters (any script), digits, spaces, `_`, `-`,
and `.`. These are reserved, in any case, and raise `ValidationError`: the
entity types `Entity`, `Profile`, `DecisionTrace`, `DecisionStep`, `Source`,
`SourceVersion`, `Chunk`, `Evidence`, and `EntityMerge`, and the entity id
prefixes `relation:`, `preference:`, `decision:`, `profile:`, `source:`, `sv:`,
`evidence:`, and `entitymerge:`.

### Updating and deleting

`entities.update(id, ...)` takes these keyword fields and no others; any other
raises `ValidationError`.

| Field | Effect |
|-------|--------|
| `name` | Replaces the stored name. The id does not change. |
| `type` | May change only case or spacing, since the type is part of the id; any other type raises `ValidationError`. The stored type is kept, so `type="person"` on a `Person` is a no-op, unless the new type is a schema type name or alias, which stores the schema's type name. |
| `aliases`, `remove_aliases` | Add or remove aliases. |
| `properties`, `remove_properties` | Merge into or remove from the stored properties. |
| `external_ids` | Merges into the stored external ids. |

Aliases are cleaned like names (surrounding spaces trimmed, NFC-normalized)
before they are stored or compared, so `" Other"` is stored as `Other`; a blank
alias, or one equal to the entity's name ignoring case, is dropped silently by
inserts, `create`, and `update` (including a rename to one of its aliases).
`remove_aliases` is cleaned the same way.

Deleting an entity removes its relations, preferences, evidence, merge records,
and any decision trace that references it. A decision that only considered it as
an alternative drops that alternative, and a preference only about it gets a new
version without `about_entity`.

`entities.list(name=...)` is an exact, case-sensitive match on the current name;
to find an entity from a variant, use `entities.get(entity_id(type, name))`. The
`type` filter ignores case and, with a schema, follows aliases.

## Evidence

Each piece of evidence is its own record per entity or relation, source, source
version, chunk, and quote, so re-inserting a source adds nothing. An entity or
relation carries `source_count`, the number of distinct sources behind it. Page
through the records with `entities.evidence(id, cursor=None, limit=50)` or
`relations.evidence(id, ...)`, which return a `Page` ordered by evidence id and
raise `NotFoundError` for an unknown id. Evidence passed to `update` adds
records; it never replaces them. An evidence `confidence` must be from 0 to 1.

## Relations

```python
rel = await graph.relations.create("person:jane", "WORKS_AT", "company:acme", properties={"title": "CEO"})
await graph.relations.update(rel.id, set_properties={"title": "Chair"})
await graph.relations.versions(rel.id)        # newest first
await graph.relations.evidence(rel.id)        # Page of Evidence, all versions
```

A relation type is normalized to UPPER_SNAKE, splitting camelCase, so `works at`,
`worksAt`, and `WORKS_AT` are one type and `HTTPServer` is `HTTP_SERVER`. The
types `PREFERS`, `AVOIDS`, `HAS_PROFILE`, `MADE_DECISION`, `HAS_STEP`, `FROM`,
`TO`, `RESULTED_IN`, `CONSIDERED`, `HAS_VERSION`, and `HAS_CHUNK` are reserved
in any case; use the preference and decision resources, or another type.

A custom `id` for a relation, preference, or decision must be its kind, a colon,
and a non-empty name, as in `relation:jane-acme`.

`update` writes a new version and keeps the old ones. `create` asserts the fact
now with exactly the given properties. `get` returns `None` for a relation a
[contradiction](schema.md#contradictions) retired, while `versions` and
`list(include_invalidated=True)` still return it; the CLI `relation get` and MCP
`get_relation` fail instead, naming the retiring relation. Creating a retired
relation again reasserts it as the next revision, carrying nothing over, with a
`relation_reasserted` warning on the `selfgraph` logger.

## Preferences

A preference records that a subject prefers or avoids a value entity along a key,
with an optional `strength` from 0 to 1. Preferences are versioned like
relations.

```python
await graph.preferences.create("person:jane", "database", "company:acme", kind="preference", strength=0.9)
await graph.preferences.list("person:jane")   # one subject; no argument lists every subject
await graph.preferences.update("pref-id", strength=0.5)
await graph.preferences.update("pref-id", clear=["strength", "about_entity"])
```

In `preferences.update` and `relations.update`, `None` keeps a field. To remove a
preference value, name it in `clear` (`strength`, `about_entity`, or `event_time`).
`decisions.update` also takes `clear` (`actor_entity`, `summary`, `rationale`,
`outcome_entity`, `event_time` to `None`; `alternative_entities` and `steps` to
an empty list), and there `None` clears too. Clearing a field that is not
clearable, or setting and clearing one field, raises `ValidationError`.

## Decisions

A decision trace records a choice: its steps, rationale, outcome, and
alternatives. It is updated in place, not versioned.

```python
step = await graph.relations.create("person:jane", "COMPARED", "company:acme")
await graph.decisions.create(
    "Picked the backend",
    steps=[step.id],
    rationale="best temporal support",
    outcome_entity="company:acme",
)
```

In Python every field after `title` is keyword-only. `steps` is optional and
defaults to `[]`; each is the id of an existing relation, possibly retired, kept
in order and not checked to form a path. `status` defaults to `"completed"`. The
derived id hashes the actor and title, so a second `create` with both equal
raises `ConflictError`, while `insert.ontology` updates the stored decision; use
distinct titles or an explicit `id` for distinct decisions.

## Listing and iterating

`list` returns one `Page`; pass its `next_cursor` to read the next. `iterate`
follows the cursor for you. Cursors are opaque. For entities, relations,
preferences, and decisions a cursor marks the last id returned (keyset paging in
id order), so deleting or adding items while you iterate never skips or repeats
one; offset cursors from earlier releases are no longer accepted. `evidence` and
`merges` still page by offset. An empty or malformed cursor raises
`ValidationError: invalid cursor '...'`, and so does a relation, preference, or
decision list cursor whose id has another kind's prefix; pass `None` to start.
List filters are validated like writes: `decisions.list(status="zzz")` and
`preferences.list(kind="zzz")` raise `ValidationError`.

```python
page = await graph.entities.list(type="Company", limit=50)
next_page = await graph.entities.list(type="Company", cursor=page.next_cursor)

async for entity in graph.entities.iterate(type="Company"):
    print(entity.name)
```

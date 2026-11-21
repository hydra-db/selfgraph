# Resources

`graph.entities`, `graph.relations`, `graph.preferences`, and `graph.decisions`
each offer `create`, `get`, `list`, `iterate`, `update`, and `delete`.

Rules shared by all four:

| Call | Behaviour |
|------|-----------|
| `create` with an id that exists, explicit or derived | Raises `ConflictError` (`Relation '<id>' already exists`). Use `update`, or `insert.facts`, which merges into it. |
| `get` on a missing id | Returns `None` (`null` in TypeScript and from MCP `get_*` tools). CLI `get` exits 1 (see [exit codes](cli.md#exit-codes)). |
| `update`, `delete`, `versions` on a missing id | Raise `NotFoundError`. |
| `update` that names no field | Raises `ValidationError` (`nothing to update`). So does an unknown field. |

Property keys and values follow the [property value rules](inserting.md#property-values).

The id helpers compute the id an insert derives:

| Python | TypeScript |
|--------|------------|
| `entity_id(type, name)` | `entityId(type, name)` |
| `relation_id(from_entity, type, to_entity)` | `relationId(fromEntity, type, toEntity)` |
| `preference_id(subject_entity, stance, key, value_entity)` | `preferenceId(subjectEntity, stance, key, valueEntity)` |
| `decision_id(actor_entity, title)` | `decisionId(actorEntity, title)` |
| `profile_id(subject_entity)` | `profileId(subjectEntity)` |
| `normalize_rel_type(type)`, the stored UPPER_SNAKE relation type | `normalizeRelType(type)` |

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

`entities.list(name=...)` is an exact, case-sensitive match on the current name.
To find an entity from a variant, use `entities.get(entity_id(type, name))`. The
`type` filter ignores case and, with a schema, follows aliases.

### Ids

A derived id is `type:name`, both slugged:

- lowercased and stripped, then NFC-normalized, since lowercasing `İ` gives
  `i` and a combining dot that can land out of order;
- whitespace runs turned into one hyphen;
- punctuation, symbols, and emoji dropped from the name. Combining marks, such
  as the vowel signs of Devanagari or Thai, are part of the word and stay. Both
  SDKs take them from one fixed list, the marks of Unicode 15.0, so an id does
  not depend on the Python or Node version.

So `Acme` and `ACME` share an id, `Bob 😀` and `Bob` both become `person:bob`,
type `Per son` gives `per-son:bob`, and `राम` and `रीमा` stay apart as
`person:राम` and `person:रीमा`. A name with nothing else left keeps its
symbols (`person:😀`).

**Organization names.** For organization-like types, the name also drops a
leading `The` and trailing suffixes until one word is left. Other words, such as
`Labs`, stay (`company:acme-labs`). Other types keep every word
(`work:the-trial`).

| | Values (any case) |
|---|---|
| Organization-like types | `Company`, `Organization`, `Organisation`, `Org`, `Corporation`, `Corp`, `Business`, `Firm`, `Institution`, `Agency`, `Employer`, `Vendor`, `Bank` |
| Dropped suffixes | `Inc`, `Incorporated`, `Corp`, `Corporation`, `Co`, `Company`, `Ltd`, `Limited`, `LLC`, `LLP`, `LP`, `PLC`, `Group`, `Holdings`, `GmbH`, `AG`, `SA`, `NV`, `The` |

So `Acme Group` and `Acme Holdings` both become `company:acme` and merge. Pass an
explicit `id` to keep them apart.

**Explicit ids.** An explicit entity id is canonicalized wherever one is
accepted. It is split at the first colon, and each part is NFC-normalized,
lowercased, stripped, and has whitespace runs turned into one hyphen. So
`Person:Jane Doe` names `person:jane-doe`. Punctuation is kept (`doc:v1.2`).
`ids.canonical_entity_id(id)` (`ids.canonicalEntityId`) returns that form.

| Explicit id | Result |
|-------------|--------|
| No colon or an empty part (`jane`, `person:`) | `ValidationError` (`entity id must be 'type:name'`) |
| Prefix does not match the type (`{"id": "company:x", "type": "Person"}`) | `ValidationError` (`id 'company:x' does not match type 'Person' (expected prefix 'person:')`) |
| With a [schema](schema.md), prefix is another name or alias of the entity's type (`{"id": "org:acme", "type": "org"}`, `org` an alias of `Company`) | Stored as `company:acme`. References to `org:acme` in the same insert follow it. |

An explicit id is never re-derived from the name. `person:jane` named `Jane Doe`
and a later `Jane Doe` without an id (`person:jane-doe`) are two entities. To
join them, reference the explicit id or set `resolver="default"` (see
[Entity resolution](resolution.md)).

**Allowed and reserved types.** An entity type may contain only letters (any
script, with their combining marks), digits, spaces, `_`, `-`, and `.`. These
are reserved in any case and raise `ValidationError`:

- entity types `Entity`, `Profile`, `DecisionTrace`, `DecisionStep`, `Source`,
  `SourceVersion`, `Chunk`, `Evidence`, `EntityMerge`, and `EntityMergeEntry`;
- entity id prefixes `relation:`, `preference:`, `decision:`, `decisionstep:`, `profile:`,
  `source:`, `sv:`, `evidence:`, and `entitymerge:`.

### Updating and deleting

`entities.update(id, ...)` takes these keyword fields and no others. Any other
raises `ValidationError`.

| Field | Effect |
|-------|--------|
| `name` | Replaces the stored name. The id does not change. |
| `type` | May change only case or spacing, since the type is part of the id. Any other type raises `ValidationError`. The stored type is kept, so `type="person"` on a `Person` is a no-op, unless the new type is a schema type name or alias, which stores the schema's type name. |
| `aliases`, `remove_aliases` | Add or remove aliases. |
| `properties`, `remove_properties` | Merge into or remove from the stored properties. |
| `external_ids` | Merges into the stored external ids. |

Aliases are cleaned like names (trimmed, NFC-normalized) before they are stored
or compared, so `" Other"` is stored as `Other`. `remove_aliases` is cleaned the
same way. Inserts, `create`, and `update` silently drop a blank alias, or one
equal to the entity's name ignoring case. That includes a rename to one of its
aliases.

Deleting an entity removes its relations, preferences, evidence, merge records,
and any decision trace that references it. Two exceptions:

- A decision that only considered it as an alternative drops that alternative.
- A preference only about it gets a new version without `about_entity`.

Deleting a relation at an endpoint the schema's `max_count` constrains settles
that endpoint again, as [`supersede`](schema.md#contradictions) would have
settled it without the deleted relation. This covers `relations.delete`, a
relation removed with an entity, and `maintenance.prune`.

- Every relation `supersede` retired there is ranked again with the current ones,
  and the newest `max_count` stay current. Each one is settled at both of its
  endpoints, with retired relations counted, as an insert settles it, so a
  relation still displaced at its other endpoint stays retired.
- A retired relation that makes the cut comes back as a new current revision
  with its old properties and its original effective time, so `as_of` reads show
  it valid from its start. `restored_relations` in the delete result counts them.
- A retired relation that does not make the cut stays retired. It takes a new
  revision whose `invalidated_by` and `invalidated_at` name the relation that now
  displaces it, so they never name a deleted relation.
- A retirement by the [LLM judge](schema.md#llm-judged-contradictions) or by
  [`replace_source`](inserting.md#replacing-a-source) is left as it is.
- Older versions are not changed. A `known_at` read from before the delete still
  shows the relation retired.

## Evidence

Page through evidence with `entities.evidence(id, cursor=None, limit=50)` or
`relations.evidence(id, ...)`.

- Each piece of evidence is its own record per entity or relation, source,
  source version, chunk, and quote. Re-inserting a source adds nothing.
- An entity or relation carries `source_count`, the number of distinct sources
  behind it.
- `evidence` returns a `Page` ordered by evidence id and raises `NotFoundError`
  for an unknown id.
- Evidence passed to `update` adds records. It never replaces them.
- An evidence `confidence` must be from 0 to 1.

## Relations

```python
rel = await graph.relations.create("person:jane", "WORKS_AT", "company:acme", properties={"title": "CEO"})
await graph.relations.update(rel.id, set_properties={"title": "Chair"})
await graph.relations.versions(rel.id)        # newest first
await graph.relations.evidence(rel.id)        # Page of Evidence, all versions
```

- `create` asserts the fact now, with exactly the given properties.
- `update` writes a new version and keeps the old ones.
- A relation type is normalized to UPPER_SNAKE, splitting camelCase. `works at`,
  `worksAt`, and `WORKS_AT` are one type, and `HTTPServer` is `HTTP_SERVER`. A
  digit and the letter after it split too, so `uses k8s` and `USES_K8S` are both
  `USES_K8_S`. Normalizing a stored type again returns it unchanged.
- The types `PREFERS`, `AVOIDS`, `HAS_PROFILE`, `MADE_DECISION`, `HAS_STEP`,
  `FROM`, `TO`, `RESULTED_IN`, `CONSIDERED`, `HAS_VERSION`, and `HAS_CHUNK` are
  reserved in any case. Use the preference and decision resources, or another
  type.
- A custom `id` for a relation, preference, or decision must be its kind, a
  colon, and a non-empty name, as in `relation:jane-acme`.
- `certify(id, by=...)` marks the current version as verified (`certified_at`,
  `certified_by`) and `uncertify(id)` clears it. Past marks stay in
  `certifications`. See
  [Certification](trust.md#certification).

**Retired relations.** A [contradiction](schema.md#contradictions) can retire a
relation.

| Read | Result |
|------|--------|
| `get` | `None` |
| `versions`, `list(include_invalidated=True)` | Still return it. |
| CLI `relation get`, MCP `get_relation` | Fail, naming the retiring relation. |

Creating a retired relation again reasserts it as the next revision, carrying
nothing over, with a `relation_reasserted` warning on the `selfgraph` logger.

## Preferences

A preference records that a subject prefers or avoids a value entity along a key.
It has an optional `strength` from 0 to 1. Preferences are versioned like
relations.

```python
await graph.preferences.create("person:jane", "database", "company:acme", stance="preference", strength=0.9)
await graph.preferences.list("person:jane")   # one subject; no argument lists every subject
await graph.preferences.update("pref-id", strength=0.5)
await graph.preferences.update("pref-id", clear=["strength", "about_entity"])
```

### Clearing fields

| Method | `None` | `clear` accepts |
|--------|--------|-----------------|
| `preferences.update` | Keeps the field. | `strength`, `about_entity`, `event_time` |
| `relations.update` | Keeps the field. | No `clear`. Remove properties with `remove_properties`. |
| `decisions.update` | Clears the field. | `actor_entity`, `summary`, `rationale`, `outcome_entity`, `event_time` (set to `None`); `alternative_entities`, `steps` (set to an empty list) |

Clearing a field that is not clearable, or setting and clearing one field, raises
`ValidationError`.

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

- In Python every field after `title` is keyword-only.
- `steps` defaults to `[]`. Each is the id of an existing relation, possibly
  retired. They are kept in order and not checked to form a path.
- `status` defaults to `"completed"`.
- The derived id hashes the actor and title. A second `create` with both equal
  raises `ConflictError`, while `insert.facts` and `insert.text` update the
  stored decision. Use distinct titles or an explicit `id` for distinct decisions.
- An insert that restates a stored decision keeps every field it leaves out. A
  missing field or an empty `steps` or `alternative_entities` keeps the stored
  value, and a given one replaces it. A new decision without a `status` is
  `"completed"`. `DecisionTraceInput.status` is therefore `None` until the insert
  fills it. To clear a field, use `decisions.update(clear=[...])`.

## Listing and iterating

```python
page = await graph.entities.list(type="Company", limit=50)
next_page = await graph.entities.list(type="Company", cursor=page.next_cursor)

async for entity in graph.entities.iterate(type="Company"):
    print(entity.name)
```

`list` returns one `Page`. Pass its `next_cursor` to read the next. `iterate`
follows the cursor for you. Pass `None` as the cursor to start.

Cursors are opaque:

- For entities, relations, preferences, and decisions, a cursor marks the last id
  returned (keyset paging in id order). Deleting or adding items while you
  iterate never skips or repeats one. Offset cursors from earlier releases are no
  longer accepted.
- `evidence` and `merges` page by offset.

An empty or malformed cursor raises `ValidationError: invalid cursor '...'`. So
does a relation, preference, or decision list cursor whose id has another kind's
prefix.

List filters are validated like writes: `decisions.list(status="zzz")` and
`preferences.list(stance="zzz")` raise `ValidationError`.

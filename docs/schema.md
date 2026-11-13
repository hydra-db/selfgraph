# Schema

A schema describes the entity and relation types you expect. It is optional. It
does two things:

- Its catalogs go into the LLM prompt, so `insert.text` prefers your types.
- Every write is checked against it: `insert.text`, `insert.facts`, and entity
  and relation `create` and `update`, from the library, CLI, or MCP.

By default it only reports violations. It lives in the SDK and writes nothing to
the store.

The schema defines types; stored items only name them. `EntityType` and
`RelationType` are schema definitions, while `Entity.type` and `Relation.type`
are the plain type names on stored items, such as `"Person"` or `"WORKS_AT"`.
Without a schema, any name is accepted.

## Defining one

Pass a `Schema`, or a dict with the same shape, to the graph or to one insert.

```python
from selfgraph import Schema, SelfGraph

schema = Schema(
    entities=[
        {"name": "Person", "aliases": ["user"],
         "properties": [{"name": "age", "type": "integer", "required": True}]},
        {"name": "Manager", "parent": "Person"},
        {"name": "Company", "aliases": ["org"]},
    ],
    relations=[
        {"type": "WORKS_AT", "from": {"types": ["Person"], "max_count": 1},
         "to": {"types": ["Company"], "min_count": 1}},
    ],
)

graph = SelfGraph(store=store, schema=schema)
```

`graph.schema` returns the graph-level schema, or `None`.

**Properties.** Property types are `string`, `integer`, `float`, `boolean`,
`datetime`, or `json`. A `datetime` is ISO 8601 text, parsed like the CLI time
flags.

**Parents.** An entity type may name a `parent`. A child inherits its parent's
properties, including required ones. Endpoint checks follow the parent chain, so
a `Manager` satisfies an endpoint that wants a `Person`.

**Aliases.** A type or relation alias is rewritten to the schema name before the
id is derived. This applies on insert and in `entities.create` and
`relations.create`.

- An entity typed `org` is stored as `Company` with a `company:` id.
- A relation typed `employed by`, an alias of `WORKS_AT`, is stored as
  `WORKS_AT`.
- References in the same insert may use `org:acme` or `company:acme`. An
  explicit id in alias form is rewritten the same way (see
  [Ids](resources.md#ids)).
- Entity types match names and aliases ignoring case, and an exact match wins, so
  `person` becomes `Person`. Relation types match after UPPER_SNAKE
  normalization.
- Entity aliases are listed in the extraction prompt. Relation aliases are not.

**Endpoints.** A schema relation names its endpoints `from` and `to`. A stored
relation uses `from_entity` and `to_entity`. In Python the field is `from_`, so
serialize with `schema.model_dump(by_alias=True)` (or
`model_dump_json(by_alias=True)`) to get the `from` key. A plain `model_dump()`
writes `from_`.

### Invalid schemas

An unknown key is rejected ([Unknown keys](inserting.md#unknown-keys)). Names
from other tools, such as `node_types` or `edges`, suggest `entities` or
`relations`.

An inconsistent schema raises `ValidationError` (`invalid schema: ...`) naming the
first problem by its path:

| Problem | Message |
|---------|---------|
| Two entity types with the same name, ignoring case | `entities[1].name: duplicate entity type 'Person'` |
| A `parent` that is no entity type name or alias | `entities[1].parent: unknown type 'X'` |
| A `parent` chain that loops back | `entities[0].parent: parent cycle 'A' -> 'B' -> 'A'` |
| Two relation types equal after normalization | `relations[1].type: duplicate relation type 'works at'` |
| `max_count` below 1 | `relations[0].from.max_count: must be >= 1` |
| `min_count` below 0 | `relations[0].to.min_count: must be >= 0` |
| `min_count` above `max_count` | `relations[0].from.min_count: min_count 2 is greater than max_count 1` |

Constructing `Schema(...)` or `Extraction(...)` directly raises the same
`ValidationError`, never a raw pydantic error.

## Modes

```python
result = await graph.insert.facts(facts, schema=schema)
for w in result.warnings:
    print(w.code, w.message)

await graph.insert.facts(facts, schema=schema, schema_mode="strict")
```

Set `schema_mode` on the graph or on one insert. A per-insert `schema` or
`schema_mode` overrides the graph's. Entity and relation `create` and `update`
use the graph-level schema and mode.

| Mode | Effect |
|------|--------|
| `warn` (default) | The write proceeds. An insert adds each violation to `result.warnings`. `create` and `update` log each one at WARNING on the `selfgraph` logger as `schema warning [<code>]: <message>` (TypeScript writes `selfgraph: schema warning [<code>]: <message>` to stderr). |
| `strict` | Any violation raises `ValidationError` before anything is written. `strict` without a schema is itself a `ValidationError` (CLI exit code 2; the MCP server does not start). |
| `off` | No schema checks run, cardinality included. The extraction catalog is still used. [Contradiction](#contradictions) checks still run under their own option. |

How checks are applied:

- An `update` is checked on the state it would produce. Only violations it
  introduces count. A violation the stored record already had, say from before
  the schema was set, neither raises nor is logged again.
- Endpoint types are checked against entities in the same insert and in the
  graph. When a relation type lists endpoint types, any other type is a
  violation.
- Schema checks run before existence checks. A strict `create` that breaks the
  schema reports the violation, not `ConflictError`.

**Strict mode and `insert.text`.** `insert.facts` raises on any violation.
`insert.text` instead drops each extracted item that breaks the schema, and
anything referencing it, with a `dropped_off_schema` warning, and writes the
rest. A cardinality violation still raises. The regex fallback types every entity
`Thing` and every relation `RELATED_TO`. Unless the schema declares both, a strict
`insert.text` without an LLM or spaCy drops everything and returns an empty
result full of `dropped_off_schema` warnings.

### Which option controls which warning

`schema_mode` owns the schema checks and `min_count`. `contradiction` owns
`max_count`. They are independent.

| Warning | `schema_mode` | `contradiction` |
|---------|---------------|-----------------|
| `unknown_entity_type`, `unknown_relation_type`, `endpoint_type_violation`, `missing_required_property`, `property_type_mismatch`, `dropped_off_schema` | `off` skips, `warn` reports, `strict` raises (`insert.text` drops) | no effect |
| `cardinality_violation` below `min_count` | `off` skips, `warn` reports, `strict` raises | no effect |
| Over `max_count`, within one insert or against the graph (`contradiction`, `contradiction_out_of_order`, `relation_superseded`) | no effect, except that `strict` turns a `warn` conflict, and an in-insert `supersede` conflict, into a `ValidationError` with nothing written | `off` skips every `max_count` check, `warn` reports, `supersede` retires the older relation |

## Warning codes

| Code | Raised when |
|------|-------------|
| `unknown_entity_type` | An entity's type is not in the schema, and the schema lists at least one entity type. |
| `missing_required_property` | A required property is absent. |
| `property_type_mismatch` | A property value does not match its declared type. |
| `unknown_relation_type` | A relation's type is not in the schema, and the schema lists at least one relation type. |
| `endpoint_type_violation` | A relation endpoint is not one of the allowed types. |
| `cardinality_violation` | An entity that is an endpoint of at least one relation of that type in this insert has fewer than `min_count` such relations in the insert. Over `max_count` is a [contradiction](#contradictions); in strict mode it raises as a cardinality violation unless `contradiction` is `off`. |
| `contradiction`, `contradiction_out_of_order` | A relation breaks `max_count` across the graph or within one insert. See [Contradictions](#contradictions). |
| `relation_superseded` | In `supersede` mode, a newer relation retired this one. The message names both ids. |
| `relation_reasserted` | `relations.create` recreated a relation a contradiction retired, as its next revision. Logged on the `selfgraph` logger. |
| `dropped_off_schema` | In strict mode, `insert.text` dropped an extracted item that breaks the schema or references a dropped one. |
| `entity_merged` | Entity resolution folded an entity into another. See [Entity resolution](resolution.md). |
| `merge_self_loop` | A merge would have joined both ends of a relation, so the relation was dropped. Unmerging restores it. |

Cardinality is counted per insert call, over that batch's relations only. So:

- a single `create` or `update` skips it;
- an entity with no relation of that type in the batch is never flagged;
- `min_count: 1` never fires.

An empty schema reports nothing.

## Contradictions

`max_count` is also checked against the whole graph. Say `WORKS_AT` has
`from.max_count` 1 and `person:ann WORKS_AT company:acme` is current. Writing
`person:ann WORKS_AT company:globex` is then a contradiction.

- `from.max_count` caps the relations of a type leaving one entity.
- `to.max_count` caps those arriving at one entity.
- Relation aliases count toward their canonical type.
- Conflicts within one insert are resolved in input order.
- Conflicts key on entity ids. `Acme Corp` and `Acme Inc` share `company:acme`.
  A `Manager` `Ann` beside a `Person` `Ann` is a different entity unless a
  resolver merges them.

The `contradiction` option decides what happens:

| Mode | Effect |
|------|--------|
| `warn` (default) | Both relations stay current. A `contradiction` warning names the conflicting ids. |
| `supersede` | The newer facts win. After the write, every current relation at that endpoint, including the ones just written, is ranked. All but the newest `max_count` are retired, each with one warning. |
| `off` | No `max_count` check at all, within one insert or against the graph, and no warning. |

`schema_mode="off"` does not stop these checks. `contradiction="off"` does (see
[which option controls which warning](#which-option-controls-which-warning)).

```python
graph = SelfGraph(store, schema=schema, contradiction="supersede")
await graph.insert.facts(facts, contradiction="warn")    # per insert
await graph.relations.create("person:ann", "WORKS_AT", "company:globex", contradiction="off")
```

### Ranking and retirement

Facts are ranked by effective time (`event_time`, else when the version was
written), then by higher revision, then by later `created_at`. So a `create`
without `event_time` takes effect now, and on equal times the later write wins.

A retired relation keeps its revision and gains three fields:

| Field | Value |
|-------|-------|
| `is_current` | `False` |
| `invalidated_by` | The fact that displaced it in time order: the `max_count`-th newer fact at that endpoint, retired history included. With `max_count` 1, that is the next newer one. |
| `invalidated_at` | That fact's effective time. |

Example: with facts from 2019, 2020, and 2022, the 2019 one is invalidated by the
2020 one at 2020. An `as_of` of 2020-06 shows only the 2020 fact.

- New versions are written before any retirement.
- The ranking covers every current relation at the endpoint, including one being
  restated, such as one of two that a `warn` insert left current.
- A relation just written that ranks among the oldest is written as history,
  already invalidated, with a `contradiction_out_of_order` warning. Any other
  retired relation gets a `relation_superseded` warning.
- Each endpoint is settled once per insert, so a batch warns once per retired
  relation.

### Reading and reasserting a retired relation

A retired relation reads as described in [Relations](resources.md#relations).
`relations.update` on it raises `ValidationError`.

`relations.create`, or an insert with an effective time at or after its
invalidation, reasserts it as the next revision. That revision is checked
against what is current now. An insert with an earlier effective time leaves it
retired, so replaying the same inputs is idempotent.

## CLI and MCP

| Setting | CLI flag | Environment variable |
|---------|----------|----------------------|
| Schema (a JSON file, or inline JSON starting with `{`) | `--schema` | `SELFGRAPH_SCHEMA` |
| Mode | `--schema-mode` | `SELFGRAPH_SCHEMA_MODE` |
| Contradiction mode | `--contradiction` | `SELFGRAPH_CONTRADICTION` |

These apply to the CLI and the MCP server. `SelfGraph.connect(schema=...)` and
`from_env` accept a file path or the schema itself. `selfgraph schema` prints the
active schema, and the MCP `get_schema` tool returns it.

## Neo4j graph schema interop

SelfGraph reads and writes the Neo4j graph schema JSON used by
[neo4j-graphrag](https://github.com/neo4j/neo4j-graphrag-python)'s
`SchemaBuilder` and `GraphSchema`.

```python
schema = Schema.from_neo4j_ontology(json.load(open("graph_schema.json")))
neo4j_json = schema.to_neo4j_ontology()
```

| Surface | Import | Export |
|---------|--------|--------|
| Python | `Schema.from_neo4j_ontology(data)` | `schema.to_neo4j_ontology()` |
| TypeScript | `fromNeo4jOntology(data)` | `toNeo4jOntology(schema)` |
| CLI | `selfgraph schema import --from neo4j FILE` (prints the SelfGraph schema) | `selfgraph --schema FILE schema export --to neo4j` |
| MCP | | `get_schema` with `format: "neo4j"` |

`toNeo4jOntology` also takes a raw schema object, and raises `ValidationError`
when it is not a valid schema.

The format it reads:

- `node_types` and `relationship_types`, each with a `label`, `description`, and
  `properties` (`name`, `type`, `description`, `required`). A node type may also
  be a bare label string.
- `patterns` as `[source, relationship, target]` lists, or objects with those
  keys.
- `constraints` with a `type`, `property_names`, and a `node_type` or
  `relationship_type`.
- Import also reads the camelCase keys (`nodeTypes`, `relationshipTypes`,
  `nodeType`, `relationshipType`, `propertyNames`, `propertyName`). The
  snake_case key wins when both are present.

| Neo4j | SelfGraph |
|-------|-----------|
| node type `label` | entity type `name` |
| relationship type `label` | relation `type`, kept as written |
| `description` (`""` when empty) | `description` (`None` when empty) |
| `aliases`, if present | `aliases` |
| `patterns` | `from.types` and `to.types` of the relation |
| `EXISTENCE` or `KEY` constraint, or legacy `required: true` | property `required` |
| `STRING`, `INTEGER`, `FLOAT`, `BOOLEAN` | `string`, `integer`, `float`, `boolean` |
| `DATE`, `LOCAL_DATETIME`, `ZONED_DATETIME` | `datetime` (exported as `ZONED_DATETIME`) |
| any other type, such as `POINT`, `LIST`, `DURATION` | `json`, with a warning (exported as `STRING`) |

SelfGraph endpoints are per relation type, not per pattern. Patterns
`(Person)-[R]->(Company)` and `(Company)-[R]->(City)` become `from: [Person,
Company]` and `to: [Company, City]`. Export writes every source and target pair.

### What a round trip loses

Within the mapped subset above, a round trip is lossless. Outside it:

- Import drops what SelfGraph does not model: `UNIQUENESS` constraints, the
  uniqueness half of `KEY`, the `additional_*` flags, indexes, and any other key.
- Export warns about `name`, `version`, `parent`, cardinality, `json`
  properties, and an endpoint constrained on one side only.
- Neo4j to SelfGraph to Neo4j turns `DATE` and `LOCAL_DATETIME` into
  `ZONED_DATETIME`.
- SelfGraph to Neo4j to SelfGraph loses `parent`, `min_count`, and `max_count`.

Each direction names every loss in one warning on the `selfgraph` logger. The
CLI and TypeScript print it on stderr.

## TypeScript

The options and fields keep their Python names. `schema` is a plain object with
the shape above, using `from` for the source endpoint. `graph.schema` is the
parsed graph-level schema, or `null`.

```ts
import { SelfGraph } from "@hydradb/selfgraph";

const graph = new SelfGraph(store, { schema, schema_mode: "warn" });
await graph.insert.facts(facts, { schema, schema_mode: "strict" });
await graph.insert.text(text, { schema });
```

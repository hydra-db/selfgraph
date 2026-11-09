# Schema

A schema is an optional description of the entity and relation types you expect.
Its catalogs are added to the LLM prompt so `insert.text` prefers your types, and
every write is checked against it: `insert.text`, `insert.ontology`, and entity
and relation `create` and `update`, from the library, CLI, or MCP. By default it
only reports violations. It lives in the SDK and writes nothing to the store.

## Defining one

Pass a `Schema` or a dict with the same shape to the graph, or to one insert.

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

An entity type may name a `parent`. A child inherits its parent's properties,
including required ones, and endpoint checks follow the parent chain, so a
`Manager` satisfies an endpoint that wants a `Person`. Property types are
`string`, `integer`, `float`, `boolean`, `datetime`, or `json`; a `datetime` is
ISO 8601 text, parsed like the CLI time flags.

A type or relation alias is rewritten to the schema name before the id is
derived, on insert and in `entities.create` and `relations.create`: an entity
typed `org` is stored as `Company` with a `company:` id, and a relation typed
`employed by` (an alias of `WORKS_AT`) as `WORKS_AT`. References in the same
insert may use either `org:acme` or `company:acme`; an explicit id in alias form
is rewritten the same way (see [Ids](resources.md#ids)). Entity types match names
and aliases ignoring case (an exact match wins), so `person` becomes `Person`;
relation types match after UPPER_SNAKE normalization. Entity aliases are listed in
the extraction prompt; relation aliases are not.

A schema relation names its endpoints `from` and `to` (an ontology relation uses
`from_entity` and `to_entity`). In Python the field is `from_`, so serialize with
`schema.model_dump(by_alias=True)` (or `model_dump_json(by_alias=True)`) to get the
`from` key of the schema format; a plain `model_dump()` writes `from_`. An unknown key is rejected
([Unknown keys](inserting.md#unknown-keys)), and names from other tools such as
`node_types` or `edges` suggest `entities` or `relations`. A schema must also be
consistent, or it raises `ValidationError` (`invalid schema: ...`) naming the
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

Constructing `Schema(...)` or `Ontology(...)` directly raises the same
`ValidationError`, never a raw pydantic error.

## Modes

Set `schema_mode` on the graph or on one insert; a per-insert `schema` or
`schema_mode` overrides the graph's. Entity and relation `create` and `update`
use the graph-level schema and mode.

| Mode | Effect |
|------|--------|
| `warn` (default) | The write proceeds. An insert adds each violation to `result.warnings`; `create` and `update` log each one as `schema warning [<code>]: <message>` on the `selfgraph` logger at WARNING (TypeScript writes `selfgraph: schema warning [<code>]: <message>` to stderr). |
| `strict` | Any violation raises `ValidationError` before anything is written. Without a schema, `strict` itself is a `ValidationError` (CLI exit code 2; the MCP server does not start). |
| `off` | No schema checks run, cardinality included. The extraction catalog is still used, and [contradiction](#contradictions) checks still run under their own option. |

An `update` is checked on the state it would produce, and only violations it
introduces count: a violation the stored record already had (written before the
schema was set, say) neither raises nor is logged again. Endpoint types are
checked against entities in the same insert and in the graph; when a relation
type lists endpoint types, any other type is a violation. Schema checks run
before existence checks, so a strict `create` that breaks the schema reports the
violation, not `ConflictError`.

In strict mode `insert.ontology` raises on any violation, while `insert.text`
drops each extracted item that breaks the schema, and anything referencing it,
with a `dropped_off_schema` warning, and writes the rest. A cardinality violation
still raises. The regex fallback used without an LLM or spaCy types every entity
`Thing` and every relation `RELATED_TO`, so unless the schema declares both, a
strict `insert.text` drops everything and returns an empty result full of
`dropped_off_schema` warnings.

### Which option controls which warning

`schema_mode` and `contradiction` are independent: `schema_mode` owns the schema
checks and `min_count`, `contradiction` owns `max_count`.

| Warning | `schema_mode` | `contradiction` |
|---------|---------------|-----------------|
| `unknown_entity_type`, `unknown_relation_type`, `endpoint_type_violation`, `missing_required_property`, `property_type_mismatch`, `dropped_off_schema` | `off` skips, `warn` reports, `strict` raises (`insert.text` drops) | no effect |
| `cardinality_violation` below `min_count` | `off` skips, `warn` reports, `strict` raises | no effect |
| Over `max_count` within one insert or against the graph (`contradiction`, `contradiction_out_of_order`, `relation_superseded`) | no effect, except that `strict` turns a `warn` conflict into a `ValidationError` with nothing written, and an in-insert one under `supersede` too | `off` skips every `max_count` check, `warn` reports, `supersede` retires the older relation |

```python
result = await graph.insert.ontology(ontology, schema=schema)
for w in result.warnings:
    print(w.code, w.message)

await graph.insert.ontology(ontology, schema=schema, schema_mode="strict")
```

## Warning codes

| Code | Raised when |
|------|-------------|
| `unknown_entity_type` | An entity's type is not in the schema, and the schema lists at least one entity type. |
| `missing_required_property` | A required property is absent. |
| `property_type_mismatch` | A property value does not match its declared type. |
| `unknown_relation_type` | A relation's type is not in the schema, and the schema lists at least one relation type. |
| `endpoint_type_violation` | A relation endpoint is not one of the allowed types. |
| `cardinality_violation` | An entity that is an endpoint of at least one relation of that type in this insert has fewer than `min_count` such relations in the insert. More than `max_count` is a [contradiction](#contradictions); in strict mode it raises as a cardinality violation unless `contradiction` is `off`. |
| `contradiction`, `contradiction_out_of_order` | A relation breaks `max_count` across the graph or within one insert; see [Contradictions](#contradictions). |
| `relation_superseded` | In `supersede` mode, a relation was retired by a newer one; the message names both ids. |
| `relation_reasserted` | `relations.create` recreated a relation a contradiction retired, as its next revision; logged on the `selfgraph` logger. |
| `dropped_off_schema` | In strict mode, `insert.text` dropped an extracted item that breaks the schema or references a dropped one. |
| `entity_merged` | Entity resolution folded an entity into another; see [Entity resolution](resolution.md). |
| `merge_self_loop` | A merge would have joined both ends of a relation into one entity, so the relation was dropped; unmerging restores it. |

Cardinality is counted per insert call over the batch's relations only, so a
single `create` or `update` skips it, an entity with none of that type in the
batch is never flagged, and `min_count: 1` never fires. An empty schema reports nothing.

## Contradictions

`max_count` is also checked against the whole graph. With `WORKS_AT`
`from.max_count` 1 and `person:ann WORKS_AT company:acme` current, writing
`person:ann WORKS_AT company:globex` is a contradiction. `from.max_count` caps the
relations of a type leaving one entity and `to.max_count` those arriving at one.
Relation aliases count toward their canonical type, and conflicts within one
insert are resolved in input order.

The `contradiction` option decides what happens:

| Mode | Effect |
|------|--------|
| `warn` (default) | Both relations stay current, and a `contradiction` warning names the conflicting ids. |
| `supersede` | The newer facts win. After the write, every current relation at that endpoint, the ones just written included, is ranked and all but the newest `max_count` are retired, each with one warning (see below). |
| `off` | No `max_count` check at all, within one insert or against the graph, and no warning. |

`schema_mode="off"` does not stop these checks; `contradiction="off"` does (see
[which option controls which warning](#which-option-controls-which-warning)).

Conflicts key on entity ids: `Acme Corp` and `Acme Inc` share `company:acme`,
while a `Manager` `Ann` beside a `Person` `Ann` is another entity unless a
resolver merges them.

```python
graph = SelfGraph(store, schema=schema, contradiction="supersede")
await graph.insert.ontology(ontology, contradiction="warn")    # per insert
await graph.relations.create("person:ann", "WORKS_AT", "company:globex", contradiction="off")
```

Facts are ranked by effective time (`event_time`, else when the version was
written), then by higher revision, then by later `created_at`, so a `create`
without `event_time` takes effect now and, on equal times, the later write wins.
A retired relation keeps its revision and gains `is_current=False`,
`invalidated_by`, and `invalidated_at`: the fact that displaced it in time order
(the `max_count`-th newer fact at that endpoint, so the next newer one when
`max_count` is 1, retired history included) and that fact's effective time. With facts from 2019, 2020, and 2022,
the 2019 one is invalidated by the 2020 one at 2020, so `as_of` 2020-06 shows
only the 2020 fact. New versions are written before any retirement.

The ranking covers every current relation at the endpoint, including one being
restated, such as one of two that a `warn` insert left current. A relation just
written that ranks among the oldest is written as history, already invalidated,
with a `contradiction_out_of_order` warning; any other retired relation gets a
`relation_superseded` warning. Each endpoint is settled once per insert, so a
batch warns once per retired relation.

A retired relation is read as described in [Relations](resources.md#relations);
`relations.update` on it raises `ValidationError`. `relations.create`, or an
insert with an effective time at or after its invalidation, reasserts it as the
next revision, checked against what is current now. An insert with an earlier
effective time leaves it retired, so replaying the same inputs is idempotent.

## CLI and MCP

`--schema` (a JSON file, or inline JSON starting with `{`), `--schema-mode`, and
`--contradiction`, or `SELFGRAPH_SCHEMA`, `SELFGRAPH_SCHEMA_MODE`, and
`SELFGRAPH_CONTRADICTION`, set them for the CLI and MCP server.
`SelfGraph.connect(schema=...)` and `from_env` accept a file path or the schema
itself. `selfgraph schema` prints the active schema and the MCP `get_schema` tool
returns it.

## Neo4j graph schema interop

`Schema.from_neo4j_ontology(data)` reads, and `schema.to_neo4j_ontology()` writes,
the Neo4j graph schema JSON that
[neo4j-graphrag](https://github.com/neo4j/neo4j-graphrag-python)'s `SchemaBuilder`
and `GraphSchema` use: `node_types` and
`relationship_types` with a `label`, `description`, and `properties` of `name`,
`type`, `description`, and `required`; `patterns` as `[source, relationship,
target]` lists or objects with those keys; and `constraints` with a `type`,
`property_names`, and a `node_type` or `relationship_type`. A node type may also be
a bare label string. Import also reads the camelCase forms of these keys
(`nodeTypes`, `relationshipTypes`, `nodeType`, `relationshipType`, `propertyNames`,
`propertyName`); the snake_case key wins when both are present.

```python
schema = Schema.from_neo4j_ontology(json.load(open("graph_schema.json")))
neo4j_json = schema.to_neo4j_ontology()
```

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

SelfGraph endpoints are per relation type, not per pattern, so patterns
`(Person)-[R]->(Company)` and `(Company)-[R]->(City)` become `from: [Person,
Company]` and `to: [Company, City]`, and export writes every source and target
pair. Import drops what SelfGraph does not model, such as `UNIQUENESS`
constraints, the uniqueness half of `KEY`, the `additional_*` flags, indexes, and
any other key, and lists every dropped key in one warning on the `selfgraph`
logger. Export likewise warns about `name`, `version`, `parent`, cardinality,
`json` properties, and an endpoint constrained on one side only. Within that
mapped subset a round trip is lossless. Outside it, a Neo4j to SelfGraph to Neo4j
round trip changes `DATE` and `LOCAL_DATETIME` to `ZONED_DATETIME` (all three import
as `datetime`), and a SelfGraph to Neo4j to SelfGraph round trip loses `parent`,
`min_count`, and `max_count`; each loss is named in the warning, which the CLI and
TypeScript print on stderr.

The CLI converts files with `selfgraph schema import --from neo4j FILE`, which
prints the SelfGraph schema, and `selfgraph --schema FILE schema export --to
neo4j`. The MCP `get_schema` tool takes `format: "neo4j"`. In TypeScript use
`fromNeo4jOntology(data)` and `toNeo4jOntology(schema)`; `toNeo4jOntology` also takes
a raw schema object and raises `ValidationError` when it is not a valid schema.

## TypeScript

The options and fields keep their Python names.

```ts
import { SelfGraph } from "@hydradb/selfgraph";

const graph = new SelfGraph(store, { schema, schema_mode: "warn" });
await graph.insert.ontology(ontology, { schema, schema_mode: "strict" });
await graph.insert.text(text, { schema });
```

`schema` is a plain object with the shape above, using `from` for the source
endpoint. `graph.schema` is the parsed graph-level schema, or `null`.

# Schema

A schema is an optional description of the entity and relation types you expect.
It is advisory by default: it reports violations and never blocks a write. It does
two things.

- Guides extraction. The entity and relation catalogs are added to the LLM
  prompt so `insert.text` prefers your types and names.
- Validates instances. Every write checks against the schema and reports what does
  not fit: `insert.text`, `insert.ontology`, and `entities` and `relations`
  `create` and `update`, so the CLI and MCP tools are checked too.

The schema lives in the SDK only. It adds no constraints to the backend and
writes nothing to the store.

## Defining one

Pass a `Schema` or a plain dict with the same shape to the graph, or to a single
insert.

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
any string, and its format is not checked.

An alias of a type or relation passes validation as that type, but the stored
type is not rewritten: an entity typed `org` counts as a `Company` and is still
stored as type `org` with an `org:` id. A relation alias counts toward its
canonical type for cardinality. Entity aliases are listed in the extraction
prompt; relation aliases are not.

A schema file or object with a key the schema does not define is rejected, so a
typo such as `entity_types` fails instead of loading an empty schema. See
[Unknown keys](inserting.md#unknown-keys).

## Modes

Set `schema_mode` on the graph or on a single insert. Entity and relation
`create` and `update` use the graph-level schema and mode.

| Mode | Effect |
|------|--------|
| `warn` (default) | The write proceeds. An insert adds each violation to `result.warnings`; `create` and `update` log each one as `schema warning [<code>]: <message>` on the `selfgraph` logger at WARNING (TypeScript writes `selfgraph: schema warning [<code>]: <message>` to stderr). |
| `strict` | Any violation raises `ValidationError` before anything is written, with the same message for an insert and a single write. |
| `off` | No schema checks run. The extraction catalog is still used. |

An `update` is checked on the state it would produce, so removing a required
property or changing an entity to a type whose required properties are missing
is a violation. Endpoint types are checked for entities in the same insert and
for entities already in the graph.

```python
result = await graph.insert.ontology(ontology, schema=schema)
for w in result.warnings:
    print(w.code, w.message)

await graph.insert.ontology(ontology, schema=schema, schema_mode="strict")
```

A per-insert `schema` or `schema_mode` overrides the graph-level one.

## Warning codes

| Code | Raised when |
|------|-------------|
| `unknown_entity_type` | An entity's type is not in the schema, and the schema lists at least one entity type. |
| `missing_required_property` | A required property is absent. |
| `property_type_mismatch` | A property value does not match its declared type. |
| `unknown_relation_type` | A relation's type is not in the schema, and the schema lists at least one relation type. |
| `endpoint_type_violation` | A relation endpoint is not one of the allowed types. |
| `cardinality_violation` | An endpoint's count in this insert is below `min_count` or above `max_count`. |

Cardinality is counted per insert call, not across the whole graph, so a single
relation `create` or `update` skips it. An empty schema, or one with no entities
and no relations, reports nothing.

## CLI and MCP

`--schema` names a JSON file with the shape above, and `--schema-mode` sets the
mode; `SELFGRAPH_SCHEMA` and `SELFGRAPH_SCHEMA_MODE` do the same from the
environment. `selfgraph schema` prints the active schema, and the MCP server's
`get_schema` tool returns it. `SelfGraph.connect(schema=...)` and `from_env`
accept either a file path or the schema itself.

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

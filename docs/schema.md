# Schema

A schema is an optional description of the entity and relation types you expect.
It is advisory: by default it adds warnings to the insert result and never blocks
a write. It does two things.

- Guides extraction. The entity and relation catalogs are added to the LLM
  prompt so `insert.text` prefers your types and names.
- Validates instances. Every `insert` checks the ontology against the schema and
  reports what does not fit.

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

An entity type may name a `parent`; endpoint checks follow the parent chain, so a
`Manager` satisfies an endpoint that wants a `Person`. Property types are
`string`, `integer`, `float`, `boolean`, `datetime`, or `json`; a `datetime` is
any string, and its format is not checked.

An alias of a type or relation passes validation as that type, but the stored
type is not rewritten: an entity typed `org` counts as a `Company` and is still
stored as type `org` with an `org:` id. Entity aliases are listed in the
extraction prompt; relation aliases are not.

## Modes

Set `schema_mode` on the graph or on a single insert.

| Mode | Effect |
|------|--------|
| `warn` (default) | Violations are added to `result.warnings`; the write proceeds. |
| `strict` | Any violation raises `ValidationError` before anything is written. |
| `off` | No schema checks run. The extraction catalog is still used. |

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

Cardinality is counted per insert call, not across the whole graph. An empty
schema, or one with no entities and no relations, reports nothing.

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

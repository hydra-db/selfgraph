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

An entity type may name a `parent`; endpoint checks follow the parent chain, so a
`Manager` satisfies an endpoint that wants a `Person`. Property types are
`string`, `integer`, `float`, `boolean`, `datetime`, or `json`. Aliases on a type
or relation resolve to the canonical name during both extraction and validation.

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
| `unknown_entity_type` | An entity's type is not in the schema. |
| `missing_required_property` | A required property is absent. |
| `property_type_mismatch` | A property value does not match its declared type. |
| `unknown_relation_type` | A relation's type is not in the schema. |
| `endpoint_type_violation` | A relation endpoint is not one of the allowed types. |
| `cardinality_violation` | An endpoint's count in this insert is below `min_count` or above `max_count`. |

Cardinality is counted per insert call, not across the whole graph. An empty
schema, or one with no entities and no relations, reports nothing.

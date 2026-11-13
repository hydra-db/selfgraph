# Querying

Phase 4 adds two optional modules that turn a question into a query. Both are
thin consumers of the [ontology](ontology.md): they write queries from terms,
mappings, and certified definitions. A generator with no ontology behind it is a
commodity.

Each module is its own extra and can be installed without the other.

## Shared pipeline

| Step | Does | Needs an LLM |
|------|------|--------------|
| 1. Resolve | Map question words to ontology terms. | No |
| 2. Cover | Check the ontology covers the question. Stop here if not. | No |
| 3. Generate | Write the query from the resolved terms. | Yes |
| 4. Validate | Parse it and check every label, property, table, and column against the ontology. | No |
| 5. Probe and repair | Check filter values and paths against live data, and rewrite on failure. | Yes, for the rewrite |

Steps 1, 2, and 4 are deterministic. Most of the reliability comes from steps 4
and 5, not from the generation prompt.

The result carries the query, the terms it resolved, whether each was certified,
and the steps taken.

## Text-to-Cypher

Ships first. SelfGraph owns the graph, the schema, and the store, so the whole
pipeline runs through the existing `GraphStore` and raw Cypher path with no new
connectors. Auto Ontology has no equivalent.

## Text-to-SQL

Returns validated SQL. It does not execute it and ships no database connectors.
Step 5 is exposed as hooks the caller wires to their own connection. Dialect
handling comes from a SQL parser in the extra.

## Safety

- Generated queries are read-only by default. A write is rejected unless the
  caller opts in.
- Text stored in the graph can reach the generation prompt, so treat it as a
  prompt-injection surface. Validation in step 4 is the backstop.

## TypeScript

LLM output cannot be conformance-tested byte for byte. The deterministic steps
(resolve, cover, validate) are ported and tested. Generation may be Python-only
at first (see [decisions](decisions.md)).

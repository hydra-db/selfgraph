# Ontology

Phase 3 extends the [schema](../schema.md) into a fuller ontology. Today a schema
holds entity types, relation types, properties, parents, aliases, and
cardinality. The additions below are the primitives NVIDIA Auto Ontology is
built on, kept as plain data with no new runtime dependency.

## Additions

| Primitive | What it is | Used for |
|-----------|------------|----------|
| Terms | A business concept with a description and synonyms. Extends today's type aliases. | Seeding retrieval and resolving question words. |
| Mappings | Where a term's data lives: a text source, or a table and column. | Query generation and provenance. |
| Derived definitions | A named, reusable expression under a term, such as a margin. | Every consumer computes a metric the same way. |
| Certification | A draft or certified state on each ontology element. | Trust. Builds on existing versioning. |
| Coverage check | Does the ontology have terms for this question? | Telling an agent a question cannot be answered. |

The coverage check is a lexical lookup and needs no LLM. An LLM tier can sit
above it for paraphrases.

## Ladder

| Tier | How the ontology is produced |
|------|------------------------------|
| None | No schema. Types come from extraction. |
| Prescribed | You pass a schema. This exists today. |
| Learned | A draft is generated from your data or from database metadata. |
| Certified | A person reviews the draft and certifies elements. |

## Generation from metadata

A draft ontology is inferred from a schema description you supply: tables,
columns, keys, and sample values. SelfGraph reads metadata only. It does not
ingest rows and does not ship database connectors.

## Import and export

| Format | Direction |
|--------|-----------|
| Neo4j graph schema | Both. Exists today. |
| OWL and RDF | Both. |
| Ossie YAML (the format Auto Ontology exchanges) | Both. |
| dbt and LookML semantic models | Import. |

Each format documents what a round trip loses, as the Neo4j interop page does.

## Limits

- No UI, no review workflow screens, no access control. Certification is a
  state and an API. The app on top decides who may set it.
- Derived definitions are stored and returned. Executing them against a
  database is the caller's job.

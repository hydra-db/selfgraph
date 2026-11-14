# Ontology

A [schema](schema.md) can carry more than types. These fields turn it into an
ontology that grounds questions: business terms, where their data lives, and
reusable definitions. They are plain data. Nothing here calls an LLM.

## Terms

```python
schema = Schema(
    entities=[
        {
            "name": "Company",
            "description": "an organization that employs people",
            "synonyms": ["employer", "firm"],
            "certified": True,
            "mappings": [{"table": "crm.accounts"}],
            "definitions": [
                {"name": "headcount", "expression": "count(Person)", "synonyms": ["staff size"]},
            ],
        },
    ],
    relations=[{"type": "WORKS_AT", "synonyms": ["employed by"]}],
)
```

| Field | On | Meaning |
|-------|----|---------|
| `synonyms` | entity types, relation types, definitions | Other words a question may use for the term. |
| `certified` | entity types, relation types, definitions | `True` once a person has reviewed it. Default `False`. |
| `mappings` | entity types | Where the term's data lives: a `source`, or a `table` and `column`. |
| `definitions` | entity types | A named, reusable `expression`, such as a metric, with a `description`. |

**Synonyms and aliases differ.** An [alias](schema.md#defining-one) is rewritten
to the schema name on write, so it changes ids. A synonym only matches question
words. It never changes what is stored.

Definitions and mappings are stored and returned. SelfGraph does not execute an
expression or connect to a mapped table.

## Grounding a question

[`check_answerable`](trust.md#check_answerable) matches a question against these
terms before an agent answers:

```python
await graph.insert.facts({"entities": [{"name": "Acme", "type": "Company"}]})
report = await graph.check_answerable("What is the staff size of the firm Acme by ad spend?")
report.terms    # staff size -> headcount (definition), firm -> Company (type, certified), acme -> company:acme
report.missing  # ["ad", "spend"]
report.verdict  # "partial"
```

Types, definitions, and relation types match by name, alias, and synonym,
ignoring case and a plain plural ending, so `employers` matches `Company`
through the synonym `employer`. A multi-word form such as `staff size` is one
term. A match through a certified term is marked `certified`. A term counts
only when the graph holds something of it, here the company Acme; a term only
the schema names is `schema_only` and counts as missing.

Schema synonyms also widen [retrieval seeding](retrieval.md#seeding-tiers).

## A draft from table metadata

`Schema.from_tables` drafts a schema from relational metadata. It reads no rows
and connects to nothing: you pass the table and column descriptions.

```python
schema = Schema.from_tables(
    [
        {
            "name": "sales.invoice_lines",
            "columns": [
                {"name": "invoice_id", "type": "bigint", "references": "sales.invoices"},
                {"name": "extended_price", "type": "numeric", "nullable": False},
            ],
        },
        {"name": "sales.invoices", "columns": [{"name": "invoice_date", "type": "date"}]},
    ]
)
```

| Input | Becomes |
|-------|---------|
| A table | An entity type in singular PascalCase (`InvoiceLine`), with the table name as a synonym and a mapping to the table. |
| A column | A property with the nearest type, `required` when `nullable` is `False`. |
| A column with `references` | A relation type `HAS_<COLUMN>` to the referenced table's type, with `from.max_count` 1. The `id` word is dropped from the name. |

Nothing in a draft is certified. Review it, then set `certified` on what is
right. A `references` to a table not in the list raises `ValidationError`.

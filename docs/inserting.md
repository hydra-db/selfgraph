# Inserting

There are two ways to add to the graph: extract it from text, or pass a ready
ontology. Both return an `InsertResult` with the created entities and relations
and any warnings.

## From text

`insert.text` runs an extractor over the text and writes what it finds.

```python
result = await graph.insert.text(
    "Acme acquired Beta Corp in 2021. Jane Doe led the deal.",
    source_id="press-release",
)
print(result.entities)
print(result.relations)
```

`source_id` records where the text came from. `event_time` sets the default time
for the facts. `metadata` attaches arbitrary fields to the source.

### With an LLM

Pass an `LLMConfig` to the graph. Any litellm provider works.

```python
from selfgraph import LLMConfig, SelfGraph

graph = SelfGraph(store=store, llm=LLMConfig(provider="openai", model="gpt-4o-mini"))
```

Install the extra:

```bash
pip install "selfgraph[llm]"
```

### Without an LLM

With no `llm`, `insert.text` extracts with spaCy when the `ner` extra is
installed, and with a built-in regex pass otherwise. The regex pass finds fewer
relations; `result.warnings` says which path ran. Both are fallbacks: they guess
entity types from capitalization and patterns and can mislabel them (a company
typed as a place) or link the wrong pair, so use an LLM when the graph matters.

```bash
pip install "selfgraph[ner]"
python -m spacy download en_core_web_sm
```

## From an ontology

`insert.ontology` writes entities and relations with no extraction. Pass an
`Ontology` or a plain dict with the same shape.

```python
await graph.insert.ontology({
    "entities": [
        {"id": "person:jane", "type": "Person", "name": "Jane Doe"},
        {"id": "company:acme", "type": "Company", "name": "Acme"},
    ],
    "relations": [
        {"from_entity": "person:jane", "type": "WORKS_AT", "to_entity": "company:acme",
         "properties": {"title": "CEO"}},
    ],
})
```

Use this when you already have structured data, or to seed a graph without an LLM
or any extraction dependency.

## Idempotence

Every insert is an upsert keyed on a deterministic id. Inserting the same text or
ontology twice produces the same graph, so reruns are safe. A later insert that
reaches an existing entity under another surface form, such as `Acme, Inc.` after
`Acme`, keeps the stored name and adds the new form to its aliases.

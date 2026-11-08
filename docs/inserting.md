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

The LLM can return an item that cannot be stored, such as a preference strength
above 1 or an empty or reserved relation type. That item is dropped with an
`extraction_partial_failure` warning and the rest of the text is still inserted.

### Without an LLM

With no `llm`, `insert.text` extracts with spaCy when the `ner` extra is
installed, and with a built-in regex pass otherwise; `result.warnings` says which
path ran. spaCy maps its labels to types such as `Person`, `Organization`, and
`Place`, and can mislabel them (a company typed as a place). The regex pass types
every entity `Thing`, so it does not merge with an entity you created under a
specific type, and finds fewer relations. Both can link the wrong pair, so use an
LLM when the graph matters. `instructions` and `prompts` apply only to LLM
extraction; without an LLM they are ignored and a `prompts_ignored` warning says so.
A prompt template missing `{text}` raises `PromptTemplateError` before any LLM call.

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

## Unknown keys

An ontology, its entities, relations, evidence, preferences, and decisions, a
schema, and `instructions` and `prompts` reject any key they do not define, so a
typo fails loudly instead of silently dropping data. The `ValidationError` names
the key and where it is, and suggests the closest valid key when one is within
two edits:

```text
unknown key 'entites' in ontology; did you mean 'entities'?
unknown key 'nmae' in ontology.entities[0]; did you mean 'name'?
```

When an object has several unknown keys, the first in sorted order is reported.

## Validating against a schema

Pass a `schema` to the graph or to a single insert to guide extraction and check
what you write. By default violations come back in `result.warnings` and the write
still happens; `schema_mode="strict"` rejects them instead. The graph-level schema
also checks entity and relation `create` and `update`. See [Schema](schema.md).

## Idempotence

Every insert is an upsert keyed on a deterministic id. Inserting the same text or
ontology twice produces the same graph, so reruns are safe. A later insert that
reaches an existing entity under another surface form, such as `Acme, Inc.` after
`Acme`, keeps the stored name and adds the new form to its aliases.

# Inserting

Extract a graph from text with `insert.text`, or write a ready one with
`insert.ontology`. Both return an `InsertResult` with the written entities and
relations and any warnings. Every insert is an upsert keyed on deterministic ids,
so inserting the same input twice produces the same graph. A later insert that
reaches a stored entity under another surface form, such as `Acme, Inc.` after
`Acme`, keeps the stored name and adds the new form to its aliases.

## From text

```python
result = await graph.insert.text(
    "Acme acquired Beta Corp in 2021. Jane Doe led the deal.",
    source_id="press-release",
)
```

`source_id` records where the text came from and stores it as chunks, which
[retrieval](retrieval.md) returns as passages. `event_time` sets the default time
for the facts. `metadata` attaches fields to the source. Empty or
whitespace-only text raises `ValidationError` before any LLM call.

A custom `extractor=` receives one `ParsedDocument` with `text` (the whole input;
chunking is up to the extractor), `media_type` (always `"text/plain"`), and
`metadata` (the call's `metadata`, empty when omitted), and returns an `Ontology`.

### With an LLM

```python
from selfgraph import LLMConfig, SelfGraph

graph = SelfGraph(store=store, llm=LLMConfig(provider="openai", model="gpt-4o-mini"))
```

This needs the `llm` extra. Any litellm provider works. The key comes from
`api_key`, from `SELFGRAPH_LLM_API_KEY` or `--llm-api-key` in the CLI and MCP
server, or from the provider's own variable such as `GEMINI_API_KEY`. For an
OpenAI-compatible server, set `base_url` with `provider="openai"`. Gemini models
extract in JSON mode and are sent no `temperature`.

`LLMConfig` also takes `timeout`, seconds per LLM call (default 120; `None` waits
indefinitely), and `concurrency`, how many chunks extract at once (default 4),
each running four calls. The CLI and MCP server read them from `--llm-timeout`
and `--llm-concurrency` or their `SELFGRAPH_*` variables. The config is checked
when it is built: an unknown provider or an unknown key such as `apikey` raises
`ValidationError` with a did-you-mean suggestion, and so do a missing model, a
non-positive `timeout` or `concurrency`, and a first-party provider with another
provider's model prefix (`provider="anthropic", model="gemini/x"`).

Text longer than one chunk logs `extracting chunk 3/12` at INFO on the
`selfgraph` logger; the CLI prints these lines on stderr.

A missing or rejected API key, denied access, or an unknown model raises
`ExtractionError` on the first failed call. When calls fail and nothing was
extracted, `insert.text` raises `ExtractionError` and records no source. When
only some fail, the rest is inserted and each failure becomes an
`extraction_partial_failure` warning with an `ErrorType: message` summary, the
`source_id`, and the `chunk_id`. An extracted item that cannot be stored, such as
a preference strength above 1, is dropped with the same warning. A relation or
decision step whose type is reserved for SelfGraph's own edges (`AVOIDS`,
`CONSIDERED`, `FROM`, `HAS_CHUNK`, `HAS_PROFILE`, `HAS_STEP`, `HAS_VERSION`,
`MADE_DECISION`, `PREFERS`, `RESULTED_IN`, `TO`) is dropped with one
`dropped_reserved_relation` warning per item. The relation and decision prompts list
these types, and the decision prompt asks for alternatives in `alternative_names` and
the outcome in `outcome_name` rather than as `CONSIDERED` or `RESULTED_IN` steps. A
`PREFERS` or `AVOIDS` relation to a typed entity becomes a preference (or
disinterest) keyed by that entity's type instead of being dropped.

With a `source_id`, each extracted relation records evidence naming the chunk it
came from (`chunk_id`), one record per chunk it was found in. Explicit evidence
that cites the inserted source, with or without a `chunk_id`, likewise replaces
the source-level record.

`llm` also takes your own client: any object with an async
`generate(system=, user=, output=)` method, called once per extraction pass
(entities, relations, preferences, decisions) per chunk. Anything else raises
`ValidationError`, and a reply that does not match `output` raises
`ExtractionError` naming the pass and the missing field.

### Custom prompts

`prompts` replaces the built-in prompt of any pass: `entities`, `relations`,
`preferences`, or `decisions`. Each template needs `system`, `user`, and
`version`, or raises `ValidationError`. `user` must contain `{text}`;
`{instructions}`, if present, is replaced by the matching `instructions` entry,
which is otherwise appended. Any other `{word}` placeholder raises
`PromptTemplateError` when the graph or extractor is built. A pass you leave out
keeps its default. Pass `prompts` and `instructions` to `SelfGraph(...)`, or to
one `insert.text` call, which wins.

```python
graph = SelfGraph(
    store=store,
    llm=llm,
    prompts={
        "entities": {
            "system": "Extract people and companies only.",
            "user": 'Text:\n"""\n{text}\n"""\n{instructions}',
            "version": "entities-custom-1",
        },
    },
    instructions={"entities": "Use full legal company names."},
)
```

### Without an LLM

With no `llm`, `insert.text` uses spaCy when the `ner` extra and a model are
[installed](install.md#extras) (Python only), else a built-in regex pass;
`result.warnings` says which ran. spaCy maps its labels to types such as
`Person`, `Organization`, and `Place`, can mislabel them, and types relations
with the uppercased lemma of the linking verb (`ACQUIRE`). The regex pass types
every entity `Thing` and links neighbouring names in a sentence with
`RELATED_TO`. Both can link the wrong pair, so use an LLM when the graph matters.
`instructions` and `prompts` are ignored, with a `prompts_ignored` warning.

## From an ontology

`insert.ontology` writes an `Ontology`, or a dict with the same shape, with no
extraction.

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

`event_time` (CLI `--event-time`) is the default for relations, preferences, and
decisions that carry none. Time arguments take a datetime or ISO 8601 text; no
offset means UTC.

A [schema](schema.md) passed to the graph or to one insert guides extraction and
checks what you write.

## Property values

Properties and metadata hold JSON values. Keys, in `properties`, `set_properties`,
and `metadata`, cannot be empty or whitespace (`properties keys cannot be empty or
whitespace`). An
integer outside +/-(2^53 - 1) raises `ValidationError` ("store it as a string"),
and a `datetime` (`Date` in TypeScript) is rejected; store ISO 8601 text. A
`None` (`null`) value removes that key from a stored entity, relation, or
preference, and is never stored on a new one.

## Chunking

Text is split into chunks of up to 512 tokens with a 64-token overlap (about four
characters per token without `tiktoken`, cut on whitespace). `chunk_text(text,
max_tokens=, overlap_tokens=)` from `selfgraph.extraction` (`chunkText` in
TypeScript) raises `ValidationError` unless `max_tokens` is at least 1 and
`overlap_tokens` is from 0 to `max_tokens - 1`. Without `overlap_tokens` the
overlap is `min(64, max_tokens // 4)`, so a small `max_tokens` works on its own.

## Unknown keys

An ontology and its items, a schema, and `instructions` and `prompts` reject any
key they do not define. The `ValidationError` names the key and where it is, and
suggests the closest valid key (see [Errors](errors.md#messages)):

```text
unknown key 'nmae' in ontology.entities[0]; did you mean 'name'?
```

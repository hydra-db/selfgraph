# Inserting

There are two ways to write to the graph:

- `insert.text` extracts entities and relations from text.
- `insert.ontology` writes a graph you already have.

Both return an `InsertResult` with the written entities and relations and any
warnings. Every insert is an upsert keyed on deterministic ids, so inserting the
same input twice gives the same graph. If a later insert names a stored entity
another way, such as `Acme, Inc.` after `Acme`, the stored name stays and the new
form becomes an alias.

## From text

```python
result = await graph.insert.text(
    "Acme acquired Beta Corp in 2021. Jane Doe led the deal.",
    source_id="press-release",
)
```

| Argument | Effect |
|----------|--------|
| `source_id` | Records where the text came from and stores it as chunks. [Retrieval](retrieval.md) returns these as passages. |
| `event_time` | The default time for the extracted facts. |
| `metadata` | Fields attached to the source. |

Empty or whitespace-only text raises `ValidationError` before any LLM call.

With a `source_id`, each extracted relation records evidence naming the chunk it
came from (`chunk_id`), one record per chunk it was found in. Explicit evidence
that cites the inserted source, with or without a `chunk_id`, replaces the
source-level record.

Which extractor runs depends on what you configure:

| Configured | Extractor |
|------------|-----------|
| `extractor=` | Yours. Nothing else runs. |
| `llm=` | The [LLM](#with-an-llm). |
| Neither, with spaCy and a model installed (Python only) | spaCy. See [Without an LLM](#without-an-llm). |
| Neither | The built-in regex pass. |

### With an LLM

```python
from selfgraph import LLMConfig, SelfGraph

graph = SelfGraph(store=store, llm=LLMConfig(provider="openai", model="gpt-4o-mini"))
```

This needs the `llm` extra. Any litellm provider works. For an OpenAI-compatible
server, set `base_url` with `provider="openai"`.

The API key comes from one of:

- `api_key` in `LLMConfig`;
- `SELFGRAPH_LLM_API_KEY`, which `from_env`, the CLI, and the MCP server read
  (`--llm-api-key` on the command line);
- the provider's own variable, such as `GEMINI_API_KEY`.

| `LLMConfig` option | Default | CLI and MCP |
|--------------------|---------|-------------|
| `temperature` | 0 | |
| `max_retries` | 3 | |
| `timeout` | 120 seconds per LLM call. `None` waits indefinitely. | `--llm-timeout` |
| `concurrency` | 4 chunks at once, each running four calls. | `--llm-concurrency` |

The CLI options also read their `SELFGRAPH_*` variables. Gemini models extract in
JSON mode and are sent no `temperature`.

The config is checked when it is built. These raise `ValidationError`:

- an unknown provider, or an unknown key such as `apikey` (with a did-you-mean
  suggestion);
- a missing model;
- a `timeout` or `concurrency` that is not positive;
- a first-party provider with another provider's model prefix
  (`provider="anthropic", model="gemini/x"`).

Text longer than one chunk logs `extracting chunk 3/12` at INFO on the
`selfgraph` logger. The CLI prints these lines on stderr.

#### When extraction fails

| Situation | Result |
|-----------|--------|
| Missing or rejected API key, denied access, or unknown model | `ExtractionError` on the first failed call. |
| Every call fails and nothing was extracted | `ExtractionError`. No source is recorded. |
| Some calls fail | The rest is inserted. Each failure becomes an `extraction_partial_failure` warning with an `ErrorType: message` summary, the `source_id`, and the `chunk_id`. |
| An extracted item cannot be stored, such as a preference strength above 1 | The item is dropped with an `extraction_partial_failure` warning. |
| A relation or decision step uses a reserved type | The item is dropped with one `dropped_reserved_relation` warning. |

The reserved types are SelfGraph's own edges: `AVOIDS`, `CONSIDERED`, `FROM`,
`HAS_CHUNK`, `HAS_PROFILE`, `HAS_STEP`, `HAS_VERSION`, `MADE_DECISION`,
`PREFERS`, `RESULTED_IN`, and `TO`. The built-in prompts list them. The decision
prompt asks for alternatives in `alternative_names` and the outcome in
`outcome_name` instead of `CONSIDERED` or `RESULTED_IN` steps. One exception: a
`PREFERS` or `AVOIDS` relation to a typed entity becomes a preference (or
disinterest) keyed by that entity's type.

#### Your own client or extractor

`llm` also takes your own client. It is any object with an async
`generate(system=, user=, output=)` method. It is called once per extraction pass
(entities, relations, preferences, decisions) per chunk.

- Any other object raises `ValidationError`.
- A reply that does not match `output` raises `ExtractionError` naming the pass
  and the missing field.

To replace LLM, spaCy, and regex extraction entirely, pass `extractor=`. It is
any object with an async `extract(document)` that returns an `Ontology`. It is
called once per `insert.text` with a `ParsedDocument`:

| Field | Value |
|-------|-------|
| `text` | The whole input. Chunking is up to the extractor. |
| `media_type` | Always `"text/plain"`. |
| `metadata` | The call's `metadata`, empty when omitted. |

### Custom prompts

`prompts` replaces the built-in prompt of any pass: `entities`, `relations`,
`preferences`, or `decisions`. A pass you leave out keeps its default.

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

- Each template needs `system`, `user`, and `version`, or raises
  `ValidationError`.
- `user` must contain `{text}`.
- `{instructions}` is replaced by the matching `instructions` entry. Without the
  placeholder, the entry is appended.
- Any other `{word}` placeholder raises `PromptTemplateError` when the graph or
  extractor is built.

Pass `prompts` and `instructions` to `SelfGraph(...)` or to one `insert.text`
call. The call wins.

### Without an LLM

With no `llm`, `insert.text` uses spaCy when the `ner` extra and a model are
[installed](install.md#extras) (Python only). Otherwise it uses a built-in regex
pass. `result.warnings` says which ran (`ner_extraction` or `basic_extraction`).

- spaCy maps its labels to types such as `Person`, `Organization`, and `Place`,
  and can mislabel them. It types relations with the uppercased lemma of the
  linking verb (`ACQUIRE`).
- The regex pass types every entity `Thing` and links neighbouring names in a
  sentence with `RELATED_TO`.

Both can link the wrong pair. Use an LLM when the graph matters. `instructions`
and `prompts` are ignored here, with a `prompts_ignored` warning.

## From an ontology

`insert.ontology` writes an `Ontology`, or a dict with the same shape. Nothing is
extracted.

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
decisions that carry none. Time arguments take a datetime or ISO 8601 text. No
offset means UTC.

A [schema](schema.md), passed to the graph or to one insert, guides extraction
and checks what you write.

## Property values

Properties and metadata hold JSON values.

- Keys in `properties`, `set_properties`, and `metadata` cannot be empty or
  whitespace (`properties keys cannot be empty or whitespace`).
- An integer outside +/-(2^53 - 1) raises `ValidationError` ("store it as a
  string").
- A `datetime` (`Date` in TypeScript) is rejected. Store ISO 8601 text.
- A `None` (`null`) value removes that key from a stored entity, relation, or
  preference. It is never stored on a new one.

## Chunking

Text is split into chunks of up to 512 tokens with a 64-token overlap. Without
`tiktoken`, a token is about four characters and chunks are cut on whitespace.

| Function | Python | TypeScript |
|----------|--------|------------|
| Split text | `chunk_text(text, max_tokens=, overlap_tokens=)` from `selfgraph.extraction` | `chunkText` |
| Count tokens | `count_tokens(text)` from `selfgraph.extraction.chunking` | `countTokens` |

`max_tokens` must be at least 1, and `overlap_tokens` from 0 to `max_tokens - 1`,
or `chunk_text` raises `ValidationError`. Without `overlap_tokens` the overlap is
`min(64, max_tokens // 4)`, so a small `max_tokens` works on its own.
`count_tokens` uses the tokenizer when installed and estimates otherwise.

## Unknown keys

An ontology and its items, a schema, `instructions`, and `prompts` reject any key
they do not define. The `ValidationError` names the key, where it is, and the
closest valid key (see [Errors](errors.md#messages)):

```text
unknown key 'nmae' in ontology.entities[0]; did you mean 'name'?
```

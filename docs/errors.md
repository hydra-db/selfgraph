# Errors

Every error SelfGraph raises is a `SelfGraphError`. Catch it to handle them all,
or catch a subclass to handle one case. TypeScript exports the same classes.

```python
from selfgraph import NotFoundError, SelfGraphError

try:
    await graph.relations.update("relation:abc", set_properties={"title": "Chair"})
except NotFoundError:
    ...
except SelfGraphError as exc:
    print(exc)
```

| Exception | Raised when |
|-----------|-------------|
| `SelfGraphError` | Base class for every error below. |
| `ValidationError` | An argument, setting, or input fails validation. |
| `NotFoundError` | A required record does not exist. |
| `ConflictError` | A write conflicts with the current state, such as `create` with an existing id. |
| `ExtractionError` | Text extraction fails (a missing or rejected API key, an unknown model, a call that failed with nothing extracted), or an LLM dependency is missing. |
| `PromptTemplateError` | An extraction prompt template is malformed. |
| `StoreError` | The backend rejects a query, a connection fails, or the graph or store is closed. |
| `TransientError` | A `StoreError` from a concurrent write conflict that still failed after the SDK's retries. Retry it. |

## Messages

Python and TypeScript produce the same message text, with the same paths. Both
name types the Python way (`str`, `NoneType`).

### Input

| Situation | Message |
|-----------|---------|
| Empty or whitespace-only text | `<field> cannot be empty` |
| Wrong value type | `<field> must be a string, got int` |
| A model fails validation (facts, instructions, prompts, LLM config, MCP tool arguments) | One `path: message` line per problem, such as `invalid facts: entities[0].name: field required` |
| Unknown key | `unknown key 'nmae' in facts.entities[0]; did you mean 'name'? (valid keys: id, type, name, ...)`. The valid keys are listed when there are at most eight. |
| Malformed list cursor ([paging](resources.md#listing-and-iterating)) | `invalid cursor '...'` |
| Evidence `confidence` outside 0 to 1 (a preference `strength` reports the same way) | `evidence confidence must be between 0 and 1, got 1.5` |

### LLM and prompts

| Situation | Message |
|-----------|---------|
| Bad `LLMConfig` value | `invalid llm config: timeout: must be > 0` |
| First-party provider with another provider's model prefix (`provider="anthropic", model="gemini/x"`) | `provider 'anthropic' conflicts with model prefix 'gemini'`, in the library, the CLI, and `connect` |
| Unknown provider | `unknown LLM provider 'x'`, when settings are checked, so every CLI command and MCP startup fails before any work. In Python this needs litellm installed; without it, building the client reports the missing package. |
| Prompt template `user` without `{text}`, or with a placeholder other than `{text}` and `{instructions}` | `PromptTemplateError` listing the allowed variables, when the graph or extractor is built |
| Custom `LLMClient` reply that does not match the pass's output model ([custom clients](inserting.md#with-an-llm)) | `ExtractionError: LLM client returned an invalid result for the relations pass: relations: field required` |
| Refused or reset LLM connection | The root cause, such as `connection refused 127.0.0.1:11434`, for every provider, even when the call timed out during a retry delay |
| LLM timeout with no connection error (TypeScript) | `LLM call timed out after Ns` |

**Missing API key.** The message names every way to pass one: `api_key` in the
LLM config or `SELFGRAPH_LLM_API_KEY` (`--llm-api-key` in the CLI and MCP), or
the provider's own variable. OpenAI's `Missing credentials` is reported the same
way. For Google it lists every variable SelfGraph reads:

| SDK | Google variables |
|-----|------------------|
| Python | `GEMINI_API_KEY or GOOGLE_API_KEY` |
| TypeScript | `GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY` |

A prebuilt AI SDK model in TypeScript cannot take a key from SelfGraph. Its
message names the variable its provider package reads, such as
`GOOGLE_GENERATIVE_AI_API_KEY`.

### Closed graphs and stores

| Situation | Message |
|-----------|---------|
| Using a closed graph | `StoreError: this SelfGraph is closed; create a new SelfGraph to keep using the store` |
| Passing a closed store to a new graph (closing a graph closes its store) | `StoreError: this store is closed; create a new store for each SelfGraph` |

### Wording by surface

Hints name the setting for the surface you use:

| Library (Python) | Library (TypeScript) | CLI and MCP |
|------------------|----------------------|-------------|
| `pass store="kuzu"` | `pass store: "kuzu"` | `pass --store kuzu` |
| `pass llm_model= (or SELFGRAPH_LLM_MODEL)` | `the llm_model option` | `pass --llm-model (or SELFGRAPH_LLM_MODEL)` |
| `run maintenance.decay(dry_run=False) first` | | `run maintenance decay --apply first` |

A missing optional package names an install command that works in every shell,
such as `pip install "selfgraph[falkordb]"`. Times in messages are UTC with a `Z`
suffix, as in JSON output.

## Connections

Store setup failures are listed in [Backends](backends.md#errors). In addition:

- A connection failure names the host, port, and reason, such as
  `failed connecting to FalkorDB at localhost:6379: connection refused`. The Neo4j
  driver's generic text about the encryption default changing in Neo4j 4.0 is
  dropped.
- A FalkorDB address with a bad port (`host:abc`) or an unsupported scheme (such
  as `bolt://`) is a `ValidationError`.
- A Cypher syntax error keeps the engine's first line, cut to 120 characters.

**HydraDB.** `initialize()` runs a cheap read, so a wrong token, an unreachable
port, or a non-Bolt URI such as `http://` fails there.

| Situation | Library | CLI and MCP |
|-----------|---------|-------------|
| No token | `HydraDB needs a token: pass auth=TOKEN to HydraDBStore (or set SELFGRAPH_AUTH)` | `pass --auth TOKEN (or SELFGRAPH_AUTH)` |
| Protocol mismatch, or a missing database reported by Neo4j or Memgraph | adds `if this is Neo4j or Memgraph, pass store="neo4j" (or store="memgraph")` | adds `pass --store neo4j (or memgraph)` |
| Missing database on HydraDB | `database 'foo' not found` | `database 'foo' not found` |

**Neo4j and Memgraph.** `initialize()` lists the existing constraints first and
skips the constraint DDL when they are all in place. Concurrent CLI calls do not
need exclusive access to the store.

## Warnings and logging

Warnings that are not errors go to a logger, never straight to stdout or stderr.
So does insert progress (`extracting chunk 2/5`). Warnings include schema
warnings in warn mode, maintenance summaries, and schema conversion notes.

| Surface | Warnings | Progress |
|---------|----------|----------|
| Library | shown | hidden |
| CLI | stderr | stderr |

- **Python:** the standard `selfgraph` logger. Configure or silence it with
  `logging.getLogger("selfgraph")`.
- **TypeScript:** `setLogger(fn)` receives each `(message, level)`, with level
  `"warning"` or `"info"`. `setLogger(null)` silences it. `setLogger(undefined)`
  restores the default, which writes warnings to stderr as
  `selfgraph: <message>` and drops info.

Inserting text without an LLM adds an insert warning and logs it:
`basic_extraction` for the built-in regex extractor, and `ner_extraction` (Python
only) when spaCy NER did the extraction.

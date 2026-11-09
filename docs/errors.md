# Errors

Every error SelfGraph raises is a `SelfGraphError`, so one except clause catches them
all; catch a subclass to handle one case. TypeScript exports the same classes.

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
| `TransientError` | A `StoreError` from a concurrent write conflict that still failed after the SDK's retries; retry it. |

## Messages

- A text argument that is empty or only whitespace reports `<field> cannot be empty`; a
  value of the wrong type reports `<field> must be a string, got int`. Both SDKs name
  types the Python way (`str`, `NoneType`), so the text is identical.
- An input that fails model validation (an ontology, instructions, prompts, an LLM
  config, MCP tool arguments) reports one `path: message` line per problem, with the
  same paths in Python and TypeScript: `invalid ontology: entities[0].name: field
  required`. An unknown key names the closest valid one and, when there are at most
  eight, lists them all: `unknown key 'nmae' in ontology.entities[0]; did you mean
  'name'? (valid keys: id, type, name, ...)`.
- A prompt template is checked when the graph or extractor is built: a `user` message
  without `{text}`, or with a placeholder other than `{text}` and `{instructions}`,
  raises `PromptTemplateError` listing the allowed variables.
- A custom `LLMClient` reply that does not match the pass's output model raises
  `ExtractionError: LLM client returned an invalid result for the relations pass:
  relations: field required` ([custom clients](inserting.md#with-an-llm)).
- An `LLMConfig` built directly raises the same one-line `ValidationError` as any other
  input (`invalid llm config: timeout: must be > 0`), and a first-party provider with
  another provider's model prefix (`provider="anthropic", model="gemini/x"`) raises
  `provider 'anthropic' conflicts with model prefix 'gemini'` in the library, the CLI,
  and `connect` alike. An unknown provider raises `unknown LLM provider 'x'` when the
  settings are checked, so every CLI command and MCP startup fail before any work; in
  Python this needs litellm installed, else building the client reports the missing
  package.
- A malformed list cursor raises `invalid cursor '...'`
  ([paging](resources.md#listing-and-iterating)). An evidence `confidence` outside 0
  to 1 raises `evidence confidence must be between 0 and 1, got 1.5`, like a
  preference `strength`.
- A missing API key names every way to pass one: `api_key` in the LLM config or
  `SELFGRAPH_LLM_API_KEY` (`--llm-api-key` in the CLI and MCP), or the provider's own
  variable. Google lists every variable SelfGraph reads: `GEMINI_API_KEY or
  GOOGLE_API_KEY` in Python, and `GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY, or
  GOOGLE_API_KEY` in TypeScript. OpenAI's `Missing credentials` is reported the same
  way. A prebuilt AI SDK model in TypeScript cannot take a key from SelfGraph, so the
  message names the variable its provider package reads, such as
  `GOOGLE_GENERATIVE_AI_API_KEY`.
- A refused or reset LLM connection reports its root cause, such as `connection refused
  127.0.0.1:11434`, for every provider, even when the call timed out during a retry
  delay; a timeout with no connection error reports `LLM call timed out after Ns`
  (TypeScript).
- Library messages name settings (`pass store="kuzu"`, `pass llm_model= (or
  SELFGRAPH_LLM_MODEL)`, `run maintenance.decay(dry_run=False) first`; in TypeScript
  `pass store: "kuzu"` and `the llm_model option`), and the CLI and MCP reword them to
  flags (`pass --store kuzu`, `pass --llm-model (or SELFGRAPH_LLM_MODEL)`, `run
  maintenance decay --apply first`).
- A missing optional package names an install command that works in every shell, such
  as `pip install "selfgraph[falkordb]"`.
- Using a closed graph raises `StoreError: this SelfGraph is closed; create a new
  SelfGraph to keep using the store`. Closing a graph closes its store, so passing that
  store to a new graph raises `StoreError: this store is closed; create a new store for
  each SelfGraph`.
- Times in messages are UTC with a `Z` suffix, as in JSON output.

## Connections

A connection failure names the host, port, and reason, such as `failed connecting to
FalkorDB at localhost:6379: connection refused`; the Neo4j driver's generic text about
the encryption default changing in Neo4j 4.0 is dropped. A FalkorDB address with a bad
port (`host:abc`) or an unsupported scheme (such as `bolt://`) is a `ValidationError`.
A Cypher syntax error keeps the engine's first line, cut to 120 characters.

`initialize()` runs a cheap read on HydraDB, so a wrong token, an unreachable port, or a
non-Bolt URI such as `http://` fails there. Without a token HydraDB reports `HydraDB
needs a token: pass auth=TOKEN to HydraDBStore (or set SELFGRAPH_AUTH)`, or `pass --auth
TOKEN (or SELFGRAPH_AUTH)` from the CLI and MCP. A protocol mismatch, or a missing
database reported by Neo4j or Memgraph, adds `if this is Neo4j or Memgraph, pass
store="neo4j" (or store="memgraph")`, worded `pass --store neo4j (or memgraph)` in the CLI
and MCP; a missing database on HydraDB reports only `database 'foo' not found`.

On Neo4j and Memgraph, `initialize()` lists the existing constraints first and skips the
constraint DDL when they are all in place, so concurrent CLI calls do not need exclusive
access to the store.

## Warnings and logging

Warnings that are not errors (schema warnings in warn mode, maintenance summaries,
schema conversion notes) and insert progress (`extracting chunk 2/5`) go to a logger,
never straight to stdout or stderr. Library use shows warnings and hides progress; the
CLI prints both on stderr.

- Python: the standard `selfgraph` logger; configure or silence it with
  `logging.getLogger("selfgraph")`.
- TypeScript: `setLogger(fn)` receives each `(message, level)` with level `"warning"`
  or `"info"`; `setLogger(null)` silences it and `setLogger(undefined)` restores the
  default, which writes warnings to stderr as `selfgraph: <message>` and drops info.

Inserting text without an LLM adds an insert warning and logs it: `basic_extraction`
for the built-in regex extractor, and `ner_extraction` (Python only) when spaCy NER did
the extraction.

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

| Exception | Default code | Raised when |
|-----------|--------------|-------------|
| `SelfGraphError` | | Base class for every error below. |
| `ValidationError` | `invalid_argument` | An argument, setting, or input fails validation. |
| `NotFoundError` | `not_found` | A required record does not exist. |
| `ConflictError` | `already_exists` | A write conflicts with the current state, such as `create` with an existing id. |
| `ExtractionError` | `extraction_failed` | Text extraction fails (a missing or rejected API key, an unknown model, a call that failed with nothing extracted), or an LLM dependency is missing. |
| `PromptTemplateError` | `invalid_prompt_template` | An extraction prompt template is malformed. |
| `StoreError` | `query_failed` | The backend rejects a query, a connection fails, or the graph or store is closed. |
| `TransientError` | `write_conflict` | A `StoreError` from a concurrent write conflict that still failed after the SDK's retries, or a busy server. Retry it. |

## Codes

Every error carries a stable `code` that names the failure and its repair, so
callers branch on it instead of parsing the message. A class has
a default code, and a raise site that knows more passes a narrower one, such as
`llm_required` on a `ValidationError`. Codes are a wire format: Python and
TypeScript raise the same code for the same failure, and renaming one is a
breaking change.

- `code`: one of the codes below (TypeScript type `ErrorCode`).
- `field`: the argument, input key, or setting at fault, such as
  `entities[0].name` or `uri`, when the error is about one; otherwise None
  (TypeScript `undefined`).
- `hint`: how to repair the code, the first paragraph of its section below.
- `retryable`: whether the same call can succeed when run again unchanged;
  true only for a `TransientError`.
- `docs`: a link to the code's section below, at the installed release (tag
  `v<version>` for Python, `ts-v<version>` for TypeScript).
- `agent_guide`: the same section in the copy of this page installed with the
  package, readable without a network:
  `site-packages/selfgraph/errors.md#<code>` for Python,
  `node_modules/@hydradb/selfgraph/errors.md#<code>` for TypeScript. The
  package also installs `SKILL.md` beside it, with the rules for agents.
- `to_dict()` (TypeScript `toJSON()`): the fields above with the message and
  class name, as the MCP server returns them. `field` is left out when there
  is none.

```python
from selfgraph import SelfGraphError

try:
    await graph.relations.certify("relation:abc", by="ops")
except SelfGraphError as exc:
    if exc.retryable:
        ...  # run the same call again
    elif exc.code == "relation_invalidated":
        ...  # act on the current version instead
```

The [CLI](cli.md#exit-codes) prints the code, the command, the hint, and both
links, and an [MCP error result](mcp.md#errors) carries them as fields.

### Arguments and settings

#### `invalid_argument`

An argument, input field, or option value is wrong. The message and `field` name
it and what it expected. Fix the value and call again.

#### `unknown_key`

A key or option name is not one the call accepts. Use the name the message
suggests after `did you mean`. Do not drop the value to make the call pass.

#### `invalid_setting`

A graph setting is missing or wrong: `uri`, `store`, `llm_provider`,
`llm_model`, `llm_timeout`, `llm_concurrency`, or the provider in the LLM
config. Fix the setting, flag, or `SELFGRAPH_*` variable the message names.

#### `llm_required`

The call needs an LLM and none is configured. Configure one: the `llm` option,
or `--llm-provider` and `--llm-model` in the CLI and MCP server. Do not lower
`level` or turn the feature off to avoid the LLM unless the user asks.

#### `embedder_required`

The `embeddings` seeds tier needs an embedder. Pass one with the SDK's
`embedder` option. Do not switch to another seeds tier unless the user asks.

#### `schema_required`

Strict schema mode, or exporting the schema, needs a schema. Pass one: the
`schema` option, or `--schema`. Do not switch to schema mode `warn` unless the
user asks.

#### `schema_violation`

A write breaks the schema in strict mode. Fix the facts so they match the
schema. Do not change the schema or the schema mode to let the write through;
that is the user's decision.

A relation over its `max_count` is a [contradiction](schema.md#contradictions).
When the newer fact replaces the older one, contradiction mode `supersede`
retires the older relation instead of failing.

#### `missing_package`

An optional package is not installed. Run the install command in the message, or
ask the user to.

#### `read_only_query`

`run_cypher` runs a single read. Write through the typed tools instead. Do not
reword the query to get a write past the guard.

#### `cypher_query_limit`

Shorten the Cypher statement or reduce its delimiter nesting before trying again.

Raw Cypher is limited to 65,536 UTF-8 bytes and 32 nested delimiters. The
error identifies which limit the `query` exceeded.

### Graph state

#### `not_found`

The object does not exist in the namespace the message names. Check the id and
the namespace, and use the `did you mean` suggestion when there is one. Do not
create a placeholder object just to make the call pass.

For an entity id, the message suggests a close existing id of the same type,
such as `did you mean 'person:ada'?`. To stay cheap, the lookup reads at most
500 ids from each of three places: ids that share all but the last two
characters of the missing id, ids that share the name's first character, and
the type's first ids. It suggests the closest id among those, so in a large
namespace a closer id elsewhere can be missed.

#### `already_exists`

An object with this id already exists. Update it, or insert it, which upserts.

#### `immutable_identity`

The change touches a field that is part of the object's id: an entity's type, a
relation's endpoints and type, or a preference's subject, stance, key, and
value. Create a new object instead of updating this one.

#### `unknown_reference`

The input references an entity or relation that does not exist. Fix the id, or
create the object first when the facts say it exists.

#### `relation_certified`

A certified relation blocks the change. Certification is a person's sign-off, so
ask the user before uncertifying it. Do not uncertify it yourself to make the
call pass.

See [certification](trust.md#certification) for what certification protects.

#### `relation_invalidated`

The relation was invalidated (superseded or retired). Act on its current
version. Create it again only when the facts say it holds again.

#### `merge_reverted`

The merge was already reverted. There is nothing left to undo.

#### `invalid_cursor`

The cursor did not come from this listing. Start the listing again without a
cursor.

#### `invalid_resolver_decision`

A custom entity resolver returned a bad decision. Return a `ResolutionDecision`
whose target is one of the offered entities, with a confidence and a reason.

### LLM

#### `extraction_failed`

LLM extraction failed. The message carries the first failure. Check the LLM
settings and the provider, then run the insert again.

#### `llm_auth_failed`

The LLM provider got no API key, or rejected it. Pass `api_key` in the LLM
config, or set `SELFGRAPH_LLM_API_KEY` or the provider's own variable. Do not
write the key into source code.

#### `llm_model_not_found`

The provider does not know the model. Check the model name and the provider.

#### `invalid_llm_output`

The model, or a custom LLM client, returned output that does not match the
pass's schema. Use another model, or fix the client.

#### `invalid_prompt_template`

A prompt template is malformed. Keep `{text}` in the user template and use no
placeholder other than `{text}` and `{instructions}`.

### Store

Raw Cypher result cells may contain at most 254 nested lists or maps. A deeper
result raises `invalid_argument` with field `rows` and message
`run_cypher result exceeds the maximum nesting depth of 254` in both SDKs.

#### `query_failed`

The backend rejected a query. The message keeps the engine's reason. Check any
Cypher you passed yourself.

#### `inexact_value`

The Kuzu driver cannot return a result value exactly. Cast the column in the
query to a type it returns exactly, such as `cast(x AS STRING)` for an integer
beyond 2^53 or a wide DECIMAL, or `cast(x AS DOUBLE)` for a negative DECIMAL
between -0.1 and 0. Do not drop the column to make the call pass.

The Kuzu Node driver rounds an `INT64` or `UINT64` beyond 2^53 and a `DECIMAL`
with more than 15 digits before the SDK sees the value, so TypeScript raises
this code for them instead of returning a rounded number, and for a `UNION`
whose members share a driver type. Python returns them exactly. Both SDKs raise
it for a negative `DECIMAL` between -0.1 and 0, which Kuzu 0.11.3 cannot return.

#### `write_conflict`

A concurrent write conflicted and the SDK's own retries ran out. Run the same
call again: ids are deterministic and inserts are upserts, so a retry does not
duplicate anything.

#### `store_busy`

The server timed out or was too busy to take the query. Run the same call again
after a moment.

#### `invalid_stored_data`

A stored node or edge is malformed. Repair the document identified by the message in its namespace before reading it again.

#### `graph_closed`

The SelfGraph was closed. Create a new SelfGraph.

#### `store_closed`

The store was closed, and closing a graph closes its store. Create a new store
for each SelfGraph.

#### `store_unreachable`

The SDK could not connect to the backend. Check that the server is running and
that the address is right. Running the call again unchanged does not help until
the server is up.

#### `store_locked`

Another process (an MCP server or a script) has the embedded Kuzu database open,
and Kuzu allows one process at a time. Close it, or point this one at another
path. Do not delete the database's files to free it.

#### `store_auth_failed`

The backend rejected the credentials, or HydraDB got no token. Pass the right
`auth` (CLI and MCP: `--auth`, or `SELFGRAPH_AUTH`).

#### `database_not_found`

The database named in the settings does not exist on the server. Fix the name,
or ask the user to create the database.

#### `wrong_engine`

The server at the address is another engine. Pass the store that matches it,
such as `neo4j`.

#### `write_too_large`

A single node or edge row is larger than HydraDB accepts in one message. Split
large property values or text. Do not cut data without asking the user.

#### `internal_error`

An unexpected error reached the CLI or MCP boundary and was not mapped to a
specific code. The message keeps the original error with any credentials masked.
Report it with the message if it persists.

## Messages

Python and TypeScript produce the same message text, with the same paths. Both
name a value's type as JSON does (`string`, `number`, `boolean`, `null`, `array`,
`object`), a datetime as `Date`, and any other value by its class name.

### Input

| Situation | Message |
|-----------|---------|
| Empty or whitespace-only text | `<field> cannot be empty` |
| Wrong value type | `<field> must be a string, got number` |
| A model fails validation (facts, instructions, prompts, LLM config, MCP tool arguments) | One `path: message` line per problem, such as `invalid facts: entities[0].name: field required` |
| Unknown key | `unknown key 'nmae' in facts.entities[0]; did you mean 'name'? (valid keys: id, type, name, ...)`. The valid keys are listed when there are at most eight. |
| Malformed list cursor ([paging](resources.md#listing-and-iterating)) | `invalid cursor '...'` |
| Evidence `confidence` outside 0 to 1 (a preference `strength` reports the same way) | `evidence confidence must be between 0 and 1, got 1.5` |
| A property or external id key named `__proto__` | `property and external id keys cannot be '__proto__'` |
| A value JSON cannot hold, such as an infinite float | `value is not JSON-serializable: Out of range float values are not JSON compliant` |
| A time outside years 1 to 9999 | `<field> is outside the representable datetime range` |

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
  `failed connecting to FalkorDB at localhost:6379: connection refused`. The
  reason is `connection refused`, `connection reset`, `host not found`,
  `host lookup failed`, `host unreachable`, or `connection timed out` when the
  driver says which, in both SDKs and for every server store. The Neo4j
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

## Warning codes

An insert reports a warning with a code instead of failing. The first paragraph
of each section is the hint the CLI and MCP server show with the warning.

#### `unknown_entity_type`

An entity's type is not in the schema. Use a type the schema lists, or ask the
user to add the type to the schema.

#### `unknown_relation_type`

A relation's type is not in the schema. Use a type the schema lists, or ask the
user to add the type to the schema.

#### `endpoint_type_violation`

A relation endpoint is not one of the types the schema allows. Check the
relation's direction and its endpoints.

#### `missing_required_property`

A required property is absent or null. Add the property to the facts.

#### `property_type_mismatch`

A property value does not match its declared type. Write the value as the
declared type.

#### `cardinality_violation`

An entity has fewer relations of a type in this insert than the schema's
`min_count`. Add the missing relations, or check the schema with the user.

#### `contradiction`

A relation breaks `max_count` against the graph, and both relations stay
current. Decide which fact holds; when the newer one replaces the older,
contradiction mode `supersede` retires the older.

#### `contradiction_out_of_order`

A relation just written ranks among the oldest at an endpoint, so it was stored
as history, already invalidated. Check its `event_time` if it should be current.

#### `relation_superseded`

In `supersede` mode, a newer relation retired this one. The message names both
ids. Nothing to fix unless the older fact still holds.

#### `relation_reasserted`

`relations.create` recreated a relation a contradiction retired, as its next
revision. Nothing to fix if the fact holds again.

#### `dropped_off_schema`

In strict mode, `insert.text` dropped an extracted item that breaks the schema
or references a dropped one. The item was not stored; insert it as facts that
match the schema if it matters.

#### `entity_merged`

Entity resolution folded an entity into another. Use the survivor's id. Unmerge
it if the two are different things.

#### `merge_self_loop`

A merge would have joined both ends of a relation, so the relation was dropped.
Unmerging restores it.

#### `certified_kept`

A certified relation stayed current where a contradiction or a replaced source
would have retired it. Ask the user whether the certification still holds.

#### `certified_dropped`

A write changed a certified relation, so its new revision is not certified. Ask
the user to certify it again if it should be.

#### `fact_retired_by_source`

A replaced source no longer states a relation, so the relation was retired.
Nothing to fix if the source changed on purpose.

#### `extraction_partial_failure`

Some extraction calls or items failed, and the rest was inserted. The message
names the failure, the source, and the chunk. Insert that chunk again once the
cause is fixed.

#### `dropped_reserved_relation`

A relation or decision step used a reserved type, so it was dropped. Use another
relation type.

#### `prompts_ignored`

`instructions` and `prompts` were ignored, because extraction ran without an
LLM. Configure an LLM for them to apply.

#### `basic_extraction`

Text was extracted with the built-in regex extractor, without an LLM. Configure
an LLM when the graph matters.

#### `ner_extraction`

Text was extracted with spaCy NER, without an LLM (Python only). Configure an
LLM when the graph matters.

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

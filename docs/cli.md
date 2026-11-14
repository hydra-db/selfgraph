# CLI

Installing the package puts a `selfgraph` command on your path. For TypeScript,
`npx @hydradb/selfgraph` takes the same flags and commands and prints the same
JSON. The CLI wraps the same API as the library.

```bash
selfgraph --store kuzu --uri graph.kuzu init
selfgraph --store kuzu --uri graph.kuzu insert facts graph.json
selfgraph --store kuzu --uri graph.kuzu retrieve "who works at Acme" --context-only
selfgraph --store kuzu --uri graph.kuzu entity list --type Company
selfgraph --version
```

With no `--store` and no `--uri`, it uses embedded Kuzu at
`~/.selfgraph/default.kuzu`, which needs `pip install "selfgraph[kuzu]"`. Run any
command with `--help` for its arguments.

## Connection flags

These flags go before or after the subcommand. Each falls back to its
`SELFGRAPH_*` environment variable, so `--llm-api-key` reads
`SELFGRAPH_LLM_API_KEY`. A subcommand's own flag of the same name (`--resolver`
or `--contradiction` on an insert or `relation create`) wins after it.

| Flag | Meaning |
|------|---------|
| `--store` | `hydradb`, `neo4j`, `cypher`, `memgraph`, `falkordb`, or `kuzu`. Default: embedded `kuzu` at `~/.selfgraph/default.kuzu`, or `hydradb` when `--uri` is given. So a Kuzu path needs `--store kuzu --uri graph.kuzu`. |
| `--uri` | Bolt URI for the Bolt stores. File path for `kuzu`. `host:port` or a `redis://`, `rediss://`, `falkor://`, or `falkors://` URL for `falkordb` ([details](backends.md#from-settings)). |
| `--auth` | `user:password`, or a bare token with user `neo4j`. For `falkordb`, `user:password` or a bare password for the default user; it wins over credentials in the URI. |
| `--database` | Bolt: database name (default: the server default). FalkorDB: graph name (default `selfgraph`). |
| `--namespace` | Graph namespace, default `default`. |
| `--llm-provider`, `--llm-model`, `--llm-api-key`, `--llm-base-url` | LLM settings for `insert text`. A provider-prefixed model such as `openai/gpt-4o-mini` needs no `--llm-provider`. Routers such as `openrouter`, and any `--llm-base-url`, take vendor-prefixed models. |
| `--llm-timeout` | Seconds to wait for each LLM call, default 120. Must be positive. |
| `--llm-concurrency` | Chunks `insert text` extracts at once, default 4, each running four LLM calls. Must be a positive integer. Results merge in chunk order. |
| `--schema` | A [schema](schema.md) JSON file applied to every insert, or inline JSON when the value starts with `{`. |
| `--instructions`, `--prompts` | Extraction instructions and prompt templates, as a JSON file or inline JSON ([custom prompts](inserting.md#custom-prompts)). |
| `--schema-mode` | `warn` (default), `strict`, or `off`. |
| `--level` | `light`, `balanced` (default), or `max`. Sets every capability's default [tier](tiers.md). |
| `--max-tier` | A cost cap no capability climbs past: `light`, `balanced`, or `max` (default). |
| `--resolver` | [Entity resolution](resolution.md) on insert: `exact`, `default`, `fuzzy`, or `llm`. Default: by level. |
| `--contradiction` | `warn`, `supersede`, `llm`, or `off`. Default: by level. See [contradictions](schema.md#contradictions). |

### Validation

Every setting is validated before any command runs, `version` and `mcp` included.
A bad setting fails with exit code 2 even when the command needs no graph.

| Bad input | Error |
|-----------|-------|
| `--uri` empty | An error, not the default store. |
| `--uri` scheme-less and ending in `.kuzu` or containing a path separator, with a store other than `kuzu` (`--uri graph.kuzu version`) | A hint to pass `--store kuzu`. |
| `--namespace` empty, with a control character, or with leading or trailing whitespace | An error. |
| `--llm-provider` without `--llm-model` | `pass --llm-model` |
| Unknown LLM provider, or a first-party provider with another provider's prefix (`--llm-provider anthropic --llm-model gemini/x`) | See [errors](errors.md#messages). Python checks the provider only when litellm is installed. |
| `--schema-mode strict` without a schema | `schema_mode 'strict' needs a schema` |
| `--schema`, `--instructions`, `--prompts`: missing file, invalid JSON, bad schema, or a prompt template without `{text}` | An error before the command runs. The `SELFGRAPH_*` variables are checked the same way. |
| Unknown store, mode, timeout, or concurrency | An error. |

`kuzu` ignores `--auth` and `--database`. Passing either flag prints a warning
such as `warning: --database is ignored by store kuzu` on stderr. The same
settings from the environment are ignored silently.

## Commands

| Command | Does |
|---------|------|
| `init` | Checks the connection, creates the store's indexes or constraints where the backend has them, and prints the store and namespace in use. |
| `version` | Prints the installed version as JSON. `--version` or `-V` prints it bare. |
| `mcp` | Runs the [MCP](mcp.md) server over stdio with the global flags. |
| `schema` | Prints the active schema, or `null` with a hint on stderr. `schema import FILE` and `schema export` convert from and to a [Neo4j graph schema](schema.md#neo4j-graph-schema-interop); `schema export --to ossie` prints an [Apache Ossie ontology](schema.md#apache-ossie-export). Importing a file that is already a SelfGraph schema fails with a hint to pass it as `--schema`. |
| `readiness` | Prints whether the store is reachable and the namespace holds data, with counts and lint ([readiness](trust.md#readiness)). |
| `check-answerable` | Judges whether the graph holds what a question asks about. Unquoted words join into one question; `--term` (repeatable) checks given phrases instead, with `--as-of` and `--depth` ([check_answerable](trust.md#check_answerable)). |
| `export obsidian DIR` | Writes the namespace into `DIR` as an Obsidian vault, overwriting notes of the same name ([Export to Obsidian](retrieval.md#export-to-obsidian)). |
| `query` | Runs one raw Cypher statement in the backend's own dialect. See [`query`](#query). |
| `retrieve` | Retrieves context for a query. See [`retrieve`](#retrieve). |
| `insert text` | Extracts from text, or `-` for stdin, with the configured LLM, else spaCy or the regex fallback ([inserting](inserting.md#from-text)). `--metadata` takes a JSON object or `KEY=VALUE` pairs, repeatable and merged in order. `--replace-source` makes the text [replace](inserting.md#replacing-a-source) the earlier versions of `--source-id`. |
| `insert facts` | Inserts facts from a JSON file, or `-` for stdin. |
| `entity` | `create`, `get`, `list`, `evidence`, `merges`, `unmerge`, `update`, `delete`. |
| `relation` | `create`, `get`, `list`, `versions`, `evidence`, `update`, `certify ID --by NAME`, `uncertify`, `delete`. |
| `preference` | `create`, `get`, `list`, `versions`, `update`, `delete`. |
| `decision` | `create`, `get`, `list`, `update`, `delete`. `create` without `--step` records no steps. |
| `maintenance` | `decay`, `prune`, `dedupe-relations`. Each prints the plan or scores, and writes only with `--apply`. A plan has no `deleted` counts. A prune `note` appears only in the JSON. See [Maintenance](maintenance.md). |

An unknown command fails with exit code 2.

**Insert output.** Both inserts print the result JSON on stdout. Each warning
also goes to stderr as `selfgraph: CODE: message`. An LLM insert of more than one
chunk prints `selfgraph: extracting chunk N/M` on stderr. Hints name CLI flags
rather than library settings ([errors](errors.md#messages)).

### `retrieve`

Unquoted words join into one query, so `retrieve who works at Acme` works. See
[Retrieval](retrieval.md).

| Flag | Default | Meaning |
|------|---------|---------|
| `--strategy` | by level | `bfs`, `dfs`, or `ppr`. |
| `--seeds` | by level | `bm25` or `synonyms`. See [seeding tiers](retrieval.md#seeding-tiers). |
| `--depth` | 3 | Hops from each seed. |
| `--k` | 20 | Seed entities. |
| `--max-nodes` | 200 | Entity cap. |
| `--budget-tokens` | 3000 | Context budget. |
| `--as-of` | | Read the graph at this time. |
| `--skip-hubs` | | Do not walk through [hubs](trust.md#hubs). |
| `--context-only` | | Print just the context text instead of the JSON result. |

### `query`

`query CYPHER --param KEY=VALUE` runs one statement.

- Unlike the MCP `run_cypher` tool, it can write. Neither is scoped to the
  namespace.
- `query --help` shows a namespace-scoped example per backend.
- Every `$name` the query references (outside literals and comments) needs a
  `--param`, else it fails with `missing parameter $name`. Unreferenced params
  are dropped.
- A query that returns no rows, or that the backend rejects, comes with
  [notes](trust.md#cypher-notes) on labels, relationship types, and names the
  namespace does not hold.

### Arguments

**Ids.** A relation, preference, or decision id must start with `relation:`,
`preference:`, or `decision:` for every command that takes one.

**`KEY=VALUE` flags** (`--prop`, `--set`, `--param`) parse VALUE as JSON when it
is valid JSON. So `zip=12345` stores the number. Write `zip='"12345"'` to keep
text. A pair without `=` fails naming the flag (`--prop expects KEY=VALUE`).

**Time flags** (`--event-time`, `--as-of`, `--now`, `--older-than`) take ISO 8601
text. No offset, or a bare date, means UTC. Times in output are UTC with a `Z`
suffix. `insert facts --event-time` is the default for items without their
own.

**Updates.**

- Repeatable flags merge into what is stored. `entity update --alias` and
  `--prop` add, `--remove-alias` and `--remove-prop` drop, and
  `--external-id SYSTEM=ID` sets.
- `relation update` takes `--set` and `--remove` (aliases `--prop` and
  `--remove-prop`). Removing an absent key is ignored.
- `entity update --type` cannot change the type, since it is part of the id. A
  spelling with the same id form (`person` for `Person`) is adopted only when it
  is a schema type name. Otherwise the stored type is kept.
- `decision update --step` and `--alternative` replace their lists.
- `--clear FIELD` (repeatable) clears a decision or preference field. The
  clearable fields are listed in [Clearing fields](resources.md#clearing-fields).

**Preferences.** `preference list` without a subject lists every subject and
filters by `--key` and `--stance`. `preference create --about` sets the entity a
preference is about. Its `VALUE` must be an existing entity id.

**Versions.** `relation versions` and `preference versions` list newest first.
`--oldest-first` reverses them.

**Evidence.** `relation create` and `relation update` take `--evidence JSON`
(repeatable). It is an object `{"source_id": ..., "quote": ...,
"start_offset": ..., "end_offset": ..., "confidence": ...}` or an array of them,
with `confidence` from 0 to 1. `update` adds to the existing evidence.

**Per-call overrides.** Both inserts take `--resolver` and `--contradiction`, and
`relation create` takes `--contradiction`, to override the global flag for one
call.

**Retired relations.** `relation list --include-invalidated` adds relations a
[contradiction](schema.md#contradictions) retired.

**Bad input.** A bad input file or setting fails with one `path: message` line per
problem, such as `invalid facts: entities[0].name: field required`. See
[errors](errors.md#messages).

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | A runtime failure: a missing id (`get`, `update`, `delete`, `NotFoundError`), a conflict (`ConflictError`), a backend or connection error (`StoreError`, `TransientError`), or an LLM error (`ExtractionError`). A `get` for a missing id prints the error on stderr and nothing on stdout. The library and MCP return `null` instead. |
| `2` | Invalid input or usage (`ValidationError`, `PromptTemplateError`): a bad flag or setting, a missing or unreadable file (`insert facts nofile.json`, `--instructions nofile.json`), invalid JSON or `--schema`, `--instructions`, or `--prompts` content, or a malformed prompt template. |
| `130` | Interrupted with Ctrl-C. |
| `141` | The reader of stdout closed early, as with `head`. |

## Secrets

Command-line arguments are visible to other users through `ps` and land in shell
history. Pass credentials through the environment:

```bash
export SELFGRAPH_AUTH=neo4j:password       # instead of --auth
export SELFGRAPH_LLM_API_KEY=sk-...        # instead of --llm-api-key
selfgraph --store neo4j --uri bolt://localhost:7687 \
  --llm-provider openai --llm-model gpt-4o-mini \
  insert text "Acme acquired Beta Corp." --source-id notes
```

## Names across surfaces

The CLI and MCP name some arguments differently from the library. MCP tools take
the library's keyword names. TypeScript uses the Python names, with camelCase
methods (`runCypher`) and options in a trailing object
(`entities.create(name, type, { id })`).

| Library | CLI | MCP |
|---------|-----|-----|
| `entities.create(name, type, aliases=[...])` | `entity create --name N --type T --alias A` | `create_entity` `name`, `type`, `aliases` |
| `external_ids={"crm": "42"}` | `--external-id crm=42` | `external_ids` |
| `properties={...}` | `--prop KEY=VALUE` | `properties` |
| `entities.update(id, properties=, remove_properties=, aliases=, remove_aliases=)` | `entity update ID --prop`, `--remove-prop`, `--alias`, `--remove-alias` | `update_entity` same names |
| `entities.evidence`, `merges`, `unmerge(merge_id)` | `entity evidence`, `merges`, `unmerge` | `entity_evidence`, `entity_merges`, `unmerge_entity` |
| `relations.create(from_entity, type, to_entity)` | `relation create FROM TYPE TO` | `create_relation` `from_entity`, `type`, `to_entity` |
| `relations.list(from_entity=, to_entity=)` | `relation list --from --to` | `list_relations` `from_entity`, `to_entity` |
| `relations.update(id, set_properties=, remove_properties=, event_time=, evidence=)` | `relation update ID --set KEY=VALUE --remove KEY --event-time T --evidence JSON` | `update_relation` `set_properties`, `remove_properties`, `event_time`, `evidence` |
| `evidence=[{...}]` on `relations.create` | `relation create --evidence JSON` | `create_relation` `evidence` |
| `relations.versions(id, newest_first=False)` | `relation versions ID --oldest-first` | `relation_versions` `newest_first: false` |
| `relations.evidence` | `relation evidence` | `relation_evidence` |
| `relations.certify(id, by=)`, `uncertify(id)` | `relation certify ID --by NAME`, `relation uncertify ID` | `certify_relation` `id`, `by`; `uncertify_relation` |
| `readiness()`, `check_answerable(question, terms=)` | `readiness`, `check-answerable QUESTION --term T` | `check_readiness`, `check_answerable` |
| `insert.text(..., schema=, schema_mode=, instructions=, prompts=)` | global `--schema`, `--schema-mode`, `--instructions`, `--prompts` | `insert_text` same names, per call |
| `preferences.create(subject_entity, key, value_entity)` | `preference create SUBJECT KEY VALUE` | `create_preference` `subject_entity`, `key`, `value_entity` |
| `about_entity=` | `preference create --about` | `about_entity` |
| `preferences.list(subject_entity)` (first positional) | `preference list [SUBJECT]` | `list_preferences` `subject_entity` |
| `preferences.update(id, properties=, remove_properties=, clear=[...])` | `preference update ID --prop`, `--remove-prop`, `--clear` | `update_preference` same names |
| `decisions.create(title, steps=[...])` | `decision create TITLE --step ID` (repeatable, in order) | `create_decision` `title`, `[steps]` |
| `actor_entity=`, `outcome_entity=`, `alternative_entities=[...]` | `--actor`, `--outcome`, `--alternative` (repeatable) | same names |
| `event_time=` | `--event-time` | `event_time` |
| `run_cypher(query, params)` | `query CYPHER --param KEY=VALUE` | `run_cypher` `query`, `params` (read-only) |
| `maintenance.decay`, `prune`, `dedupe_relations(dry_run=True)` | `maintenance decay`, `prune`, `dedupe-relations`, `--apply` to write | `maintenance_*` with `dry_run: false` to write |

Watch the property argument: `entities.update` and `preferences.update` take
`properties=` (CLI `--prop`), while `relations.update` takes `set_properties=`
(CLI `--set`).

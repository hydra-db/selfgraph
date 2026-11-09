# CLI

Installing the package puts a `selfgraph` command on your path (`npx @hydradb/selfgraph`
for TypeScript, with the same flags, commands, and JSON output). It wraps the same API as
the library. With no `--store` and no `--uri` it uses embedded Kuzu at
`~/.selfgraph/default.kuzu`, which needs `pip install "selfgraph[kuzu]"`.

## Connection flags

These go before or after the subcommand; a subcommand's own flag of the same name
(`--resolver` or `--contradiction` on an insert or `relation create`) wins after it.
Each falls back to its `SELFGRAPH_*` environment variable (`--llm-api-key` reads
`SELFGRAPH_LLM_API_KEY`).

| Flag | Meaning |
|------|---------|
| `--store` | `hydradb`, `neo4j`, `cypher`, `memgraph`, `falkordb`, or `kuzu`. Default: embedded `kuzu` at `~/.selfgraph/default.kuzu`, or `hydradb` when `--uri` is given, so a Kuzu path needs `--store kuzu --uri graph.kuzu`. A scheme-less `--uri` that ends in `.kuzu` or contains a path separator fails for any other store with a hint to pass `--store kuzu`. |
| `--uri` | Bolt URI for the Bolt stores; file path for `kuzu`; `host:port` or a `redis://`, `rediss://`, `falkor://`, or `falkors://` URL for `falkordb` ([details](backends.md#from-settings)). An empty value is an error, not the default store. |
| `--auth` | `user:password`, or a bare token with user `neo4j`. For `falkordb`, `user:password` or a bare password for the default user; it wins over credentials in the URI. |
| `--database` | Bolt: database name (default: the server default). FalkorDB: graph name (default `selfgraph`). |
| `--namespace` | Graph namespace, default `default`. An empty value, a control character, or leading or trailing whitespace is an error. |
| `--llm-provider`, `--llm-model`, `--llm-api-key`, `--llm-base-url` | LLM settings for `insert text`. A provider-prefixed model such as `openai/gpt-4o-mini` needs no `--llm-provider`; a provider alone fails with `pass --llm-model`. An unknown provider, or a first-party provider with another provider's prefix (`--llm-provider anthropic --llm-model gemini/x`), fails as described in [errors](errors.md#messages); routers such as `openrouter`, and any `--llm-base-url`, take vendor-prefixed models. |
| `--llm-timeout` | Seconds to wait for each LLM call, default 120; must be positive. |
| `--llm-concurrency` | Chunks `insert text` extracts at once, each running four LLM calls, default 4; must be a positive integer. Results merge in chunk order. |
| `--schema` | A [schema](schema.md) JSON file applied to every insert, or inline JSON when the value starts with `{`. |
| `--instructions`, `--prompts` | Extraction instructions and prompt templates, as a JSON file or inline JSON, like the library's `instructions` and `prompts` ([custom prompts](inserting.md#custom-prompts)). |
| `--schema-mode` | `warn` (default), `strict`, or `off`. `strict` without a schema fails (`schema_mode 'strict' needs a schema`). |
| `--resolver` | [Entity resolution](resolution.md) on insert: `exact` (default), `default`, `fuzzy`, or `llm`. |
| `--contradiction` | `warn` (default), `supersede`, or `off`; see [contradictions](schema.md#contradictions). |

Every setting is validated before any command runs, `version` and `mcp` included, so a
bad namespace, empty, missing, or path-like URI (`--uri graph.kuzu version`), unknown
store, mode, timeout, concurrency, or LLM provider fails with exit code 2 even when the
command needs no graph (Python checks the provider only when litellm is installed).
`--schema`, `--instructions`, and `--prompts` (and their `SELFGRAPH_*` variables) are
read and validated then too: a missing file, invalid JSON, a bad schema, or a prompt
template without `{text}` fails before the command runs. `kuzu` ignores `--auth` and
`--database`: passing either flag prints `warning: --database is ignored by store kuzu`
on stderr, while the same settings from the environment are ignored silently.

## Commands

```bash
selfgraph --store kuzu --uri graph.kuzu init
selfgraph --store kuzu --uri graph.kuzu insert ontology graph.json
selfgraph --store kuzu --uri graph.kuzu retrieve "who works at Acme" --context-only
selfgraph --store kuzu --uri graph.kuzu entity list --type Company
selfgraph --version
```

| Command | Does |
|---------|------|
| `init` | Check the connection, create the store's indexes or constraints where the backend has them, and print the store and namespace in use. |
| `version` | Print the installed version as JSON; `--version` or `-V` prints it bare. |
| `mcp` | Run the [MCP](mcp.md) server over stdio with the global flags. |
| `schema` | Print the active schema, or `null` with a hint on stderr. `schema import FILE` and `schema export` convert from and to a [Neo4j graph schema](schema.md#neo4j-graph-schema-interop). Importing a file that is already a SelfGraph schema fails with a hint to pass it as `--schema`. |
| `query` | Run one raw Cypher statement in the backend's own dialect. Unlike the MCP `run_cypher` tool it can write; neither is scoped to the namespace. `query --help` shows a namespace-scoped example per backend. Every `$name` the query references (outside literals and comments) needs a `--param`, else it fails with `missing parameter $name`; unreferenced params are dropped. |
| `retrieve` | Retrieve context for a query. Unquoted words join into one query, so `retrieve who works at Acme` works. Flags: `--strategy` (`bfs`, `dfs`, or `ppr`; default `bfs`), `--depth` (hops, default 3), `--k` (seeds, default 20), `--max-nodes` (entity cap, default 200), `--budget-tokens` (context budget, default 3000), `--as-of` (read the graph at this time), and `--context-only` (print just the context text instead of the JSON result). See [Retrieval](retrieval.md). |
| `insert text` | Extract from text, or `-` for stdin, with the configured LLM, else spaCy or the regex fallback. Rejects empty or whitespace-only text. `--metadata` takes a JSON object or `KEY=VALUE` pairs, repeatable and merged in order. |
| `insert ontology` | Insert an ontology from a JSON file, or `-` for stdin. |
| `entity` | `create`, `get`, `list`, `evidence`, `merges`, `unmerge`, `update`, `delete`. |
| `relation` | `create`, `get`, `list`, `versions`, `evidence`, `update`, `delete`. |
| `preference` | `create`, `get`, `list`, `versions`, `update`, `delete`. |
| `decision` | `create`, `get`, `list`, `update`, `delete`. `create` without `--step` records no steps. |
| `maintenance` | `decay`, `prune`, `consolidate`. Each prints the plan or scores and writes only with `--apply`. A plan has no `deleted` counts, and a prune `note` appears only in the JSON; see [Maintenance](maintenance.md). |

Both inserts print the result JSON on stdout and each warning on stderr as
`selfgraph: CODE: message` (the warnings stay in the JSON too). An LLM insert of more
than one chunk prints `selfgraph: extracting chunk N/M` on stderr. Hints name CLI flags
rather than library settings ([errors](errors.md#messages)).

Run any command with `--help` for its arguments. An unknown command fails with exit
code 2.

### Arguments

- A relation, preference, or decision id must start with `relation:`, `preference:`, or
  `decision:` for every command that takes one.
- `KEY=VALUE` flags (`--prop`, `--set`, `--param`) parse VALUE as JSON when it is valid
  JSON, so `zip=12345` stores the number; write `zip='"12345"'` to keep text. A pair
  without `=` fails naming the flag (`--prop expects KEY=VALUE`).
- Repeatable flags merge into what is stored: `entity update --alias` and `--prop` add,
  `--remove-alias` and `--remove-prop` drop, `--external-id SYSTEM=ID` sets.
  `relation update` takes `--set` and `--remove` (aliases `--prop` and `--remove-prop`);
  removing an absent key is ignored.
- `entity update --type` cannot change the type, since it is part of the id. A spelling
  with the same id form (`person` for `Person`) is adopted only when it is a schema type
  name; otherwise the stored type is kept.
- `decision update --step` and `--alternative` replace their lists. `--clear FIELD`
  (repeatable) clears `actor_entity`, `summary`, `rationale`, `outcome_entity`,
  `event_time`, `alternative_entities`, or `steps` on a decision, and `strength`,
  `about_entity`, or `event_time` on a preference. Setting and clearing the same field
  fails, and an `update` that names no field fails with `nothing to update`.
- `preference list` without a subject lists every subject and filters by `--key` and
  `--kind`; `preference create --about` sets the entity a preference is about, and its
  `VALUE` must be an existing entity id.
- `relation versions` and `preference versions` list newest first; `--oldest-first`
  reverses them.
- `relation create` and `relation update` take `--evidence JSON` (repeatable): an object
  `{"source_id": ..., "quote": ..., "start_offset": ..., "end_offset": ...,
  "confidence": ...}` or an array of them, with `confidence` from 0 to 1; `update` adds
  to the existing evidence.
- Both inserts take `--resolver` and `--contradiction`, and `relation create` takes
  `--contradiction`, to override the global flag for one call. `relation list
  --include-invalidated` adds relations a contradiction retired; `relation get` on one
  fails with the relation that retired it.
- Time flags (`--event-time`, `--as-of`, `--now`, `--older-than`) take ISO 8601 text;
  no offset, or a bare date, means UTC. Times in output are UTC with a `Z` suffix.
  `insert ontology --event-time` is the default for items without their own.
- A bad input file or setting fails with one `path: message` line per problem, such as
  `invalid ontology: entities[0].name: field required`; see [errors](errors.md#messages).

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | A runtime failure: a missing id (`get`, `update`, `delete`, `NotFoundError`), a conflict (`ConflictError`), a backend or connection error (`StoreError`, `TransientError`), or an LLM error (`ExtractionError`). A `get` for a missing id prints the error on stderr and nothing on stdout, where the library returns `None` (`null` in TypeScript) and MCP returns `null`. |
| `2` | Invalid input or usage (`ValidationError`, `PromptTemplateError`): a bad flag or setting, a missing or unreadable file (`insert ontology nofile.json`, `--instructions nofile.json`), invalid JSON or `--schema`, `--instructions`, or `--prompts` content, or a malformed prompt template. |
| `130` | Interrupted with Ctrl-C. |
| `141` | The reader of stdout closed early, as with `head`. |

## Secrets

Command-line arguments are visible to other users through `ps` and land in shell
history, so pass credentials through the environment:

```bash
export SELFGRAPH_AUTH=neo4j:password       # instead of --auth
export SELFGRAPH_LLM_API_KEY=sk-...        # instead of --llm-api-key
selfgraph --store neo4j --uri bolt://localhost:7687 \
  --llm-provider openai --llm-model gpt-4o-mini \
  insert text "Acme acquired Beta Corp." --source-id notes
```

## Names across surfaces

The CLI and MCP name some arguments differently from the library. MCP tools take the
library's keyword names. TypeScript uses the Python names with camelCase methods
(`runCypher`) and options in a trailing object (`entities.create(name, type, { id })`).

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
| `insert.text(..., schema=, schema_mode=, instructions=, prompts=)` | global `--schema`, `--schema-mode`, `--instructions`, `--prompts` | `insert_text` same names, per call |
| `preferences.create(subject_entity, key, value_entity)` | `preference create SUBJECT KEY VALUE` | `create_preference` `subject_entity`, `key`, `value_entity` |
| `about_entity=` | `preference create --about` | `about_entity` |
| `preferences.list(subject_entity)` (first positional) | `preference list [SUBJECT]` | `list_preferences` `subject_entity` |
| `preferences.update(id, properties=, remove_properties=, clear=[...])` | `preference update ID --prop`, `--remove-prop`, `--clear` | `update_preference` same names |
| `decisions.create(title, steps=[...])` | `decision create TITLE --step ID` (repeatable, in order) | `create_decision` `title`, `[steps]` |
| `actor_entity=`, `outcome_entity=`, `alternative_entities=[...]` | `--actor`, `--outcome`, `--alternative` (repeatable) | same names |
| `event_time=` | `--event-time` | `event_time` |
| `run_cypher(query, params)` | `query CYPHER --param KEY=VALUE` | `run_cypher` `query`, `params` (read-only) |
| `maintenance.decay`, `prune`, `consolidate(dry_run=True)` | `maintenance decay`, `prune`, `consolidate`, `--apply` to write | `maintenance_*` with `dry_run: false` to write |

`entities.update` and `preferences.update` take `properties=` (CLI `--prop`), while
`relations.update` takes `set_properties=` (CLI `--set`).

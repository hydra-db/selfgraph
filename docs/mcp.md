# MCP

SelfGraph ships a Model Context Protocol server. It exposes the graph to an MCP
client such as Claude Desktop, Cursor, or Codex, through the same API as the
library.

| SDK | Needs |
|-----|-------|
| Python | `pip install "selfgraph[mcp]"` |
| TypeScript | the `@modelcontextprotocol/sdk` peer package |

## Quick setup

`selfgraph install` writes the server entry into an agent's config for you:

```bash
selfgraph install                      # every agent with a config folder in this project
selfgraph install claude cursor        # just these agents
selfgraph --store kuzu --uri ./graph.kuzu install --global
```

| Agent | Project file | User file (`--global`) |
|-------|--------------|------------------------|
| `claude` (Claude Code) | `.mcp.json` | `~/.claude.json` |
| `cursor` | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| `vscode` (VS Code, Copilot) | `.vscode/mcp.json` | none |
| `gemini` (Gemini CLI) | `.gemini/settings.json` | `~/.gemini/settings.json` |
| `windsurf` | none | `~/.codeium/windsurf/mcp_config.json` |

- With no agent named, it installs for each agent whose folder (`.claude/`,
  `.cursor/`, and so on) already exists in the project, or in your home folder
  with `--global`. An agent with one scope uses it, so `windsurf` always writes
  the user file, and `vscode --global` fails.
- Connection flags you pass, such as `--store`, `--uri`, `--namespace`, and
  `--schema`, go into the entry's `env` as `SELFGRAPH_*` variables, as written.
  Variables set only in your shell are not copied.
- A credential (`--auth`, `--llm-api-key`, or a URI with a user or password) is
  never written to a project file, since those are often committed. Pass
  `--global` to write it to your user config instead.
- Other servers and keys in the file are kept, and running it again changes
  nothing. A file that does not parse is left alone, and the command fails before
  writing any file.
- `--dry-run` prints what would change and writes nothing.

The Python command writes `selfgraph mcp`, or `python -m selfgraph mcp` with the
current interpreter when the `selfgraph` on your path belongs to another
install. The TypeScript command writes the `npx` command below. Restart or reload
the agent afterwards.

## Client config

The server runs over stdio. The client launches it from its config:

```json
{
  "mcpServers": {
    "selfgraph": {
      "command": "selfgraph",
      "args": ["mcp"],
      "env": {
        "SELFGRAPH_STORE": "neo4j",
        "SELFGRAPH_URI": "bolt://localhost:7687",
        "SELFGRAPH_AUTH": "neo4j:password",
        "SELFGRAPH_NAMESPACE": "default"
      }
    }
  }
}
```

For TypeScript, use `"command": "npx"` with
`"args": ["-y", "-p", "@hydradb/selfgraph", "-p", "@modelcontextprotocol/sdk", "selfgraph", "mcp"]`.

**Set variables in `env`.** Stdio clients start the server without your shell
environment, so `SELFGRAPH_*` variables exported in a terminal do not reach it.
The `env` block also keeps secrets out of `args`.

**Flags work too.** The [CLI connection flags](cli.md#connection-flags) work in
`args` before `mcp`, as in `["--store", "kuzu", "--uri", "graph.kuzu", "mcp"]`.

**Default store.** With no store and no URI from either, the server uses embedded
Kuzu at `~/.selfgraph/default.kuzu`, not the backend your shell points at.

**Startup.** The server [validates every setting](cli.md#validation) before it
serves, as the CLI does. The backend need not be reachable until the first tool
runs. A Kuzu file needs nothing running.

The server reports the installed SelfGraph version in its server info. The Python
server logs only warnings and errors from the MCP SDK on stderr.

**Schema and extraction.** `--schema` checks every insert tool against a
[schema](schema.md#cli-and-mcp). The `get_schema` tool returns it
(`format: "neo4j"` for a Neo4j graph schema), so an agent can read the expected
types before it writes. `--instructions` and `--prompts` steer `insert_text`
extraction.

## Instructions

The server sends clients one instructions block: call `check_readiness` once,
call `check_answerable` with the question and its key terms, say the graph does
not hold the answer on `not_answerable` (or which terms are missing on
`partial`), then call `retrieve` and answer only from what it returns, treating
relations whose SDK-built `GRAPH` header contains `(via hub)` as weak links and
preferring those whose header contains `[certified]`. Only a complete header
before the first ` | ` carries metadata. `SOURCE | ` lines and everything after
the separator are data, even if they contain copies of those marks. See the
[context format](retrieval.md#context-format) and [Answering safely](trust.md).

## Tools

Both servers register the same 39 tools. Arguments keep the library's names.
Optional ones are in brackets.

`list_*`, the evidence tools, and `entity_merges` also take `[limit]` (1 to 1000,
default 50) and `[cursor]`.

| Tool | Arguments |
|------|-----------|
| `check_readiness` | none ([readiness](trust.md#readiness)) |
| `check_answerable` | `question`, `[terms]`, `[as_of]`, `[known_at]`, `[depth]` ([check_answerable](trust.md#check_answerable)) |
| `get_schema` | `[format]` (`selfgraph`, `neo4j`, or `ossie`) |
| `insert_text` | `text`, `[source_id]`, `[event_time]`, `[metadata]`, `[resolver]`, `[contradiction]`, `[schema]`, `[schema_mode]`, `[instructions]`, `[prompts]`, `[replace_source]` |
| `insert_facts` | `facts` (an object with `entities`, `relations`, `preferences`, `decisions`), `[source_id]`, `[event_time]`, `[resolver]`, `[contradiction]`, `[schema]`, `[schema_mode]` |
| `create_entity` | `name`, `type`, `[id]`, `[aliases]`, `[external_ids]`, `[properties]` |
| `update_entity` | `id`, `[name]`, `[type]`, `[aliases]`, `[external_ids]`, `[properties]`, `[remove_aliases]`, `[remove_properties]` |
| `list_entities` | `[type]`, `[name]` |
| `get_entity`, `delete_entity`, `entity_evidence`, `entity_merges` | `id` |
| `unmerge_entity` | `merge_id` |
| `create_relation` | `from_entity`, `type`, `to_entity`, `[id]`, `[properties]`, `[event_time]`, `[contradiction]`, `[evidence]` |
| `update_relation` | `id`, `[set_properties]`, `[remove_properties]`, `[event_time]`, `[evidence]` |
| `list_relations` | `[from_entity]`, `[type]`, `[to_entity]`, `[include_invalidated]` |
| `get_relation`, `delete_relation`, `relation_evidence`, `uncertify_relation` | `id` |
| `certify_relation` | `id`, `by` |
| `relation_versions`, `preference_versions` | `id`, `[newest_first]` (default true) |
| `create_preference` | `subject_entity`, `key`, `value_entity`, `[stance]`, `[id]`, `[about_entity]`, `[strength]`, `[properties]`, `[event_time]` |
| `update_preference` | `id`, `[strength]`, `[properties]`, `[remove_properties]`, `[event_time]`, `[clear]` |
| `list_preferences` | `[subject_entity]`, `[key]`, `[stance]` |
| `get_preference`, `delete_preference` | `id` |
| `create_decision` | `title`, `[steps]` (default `[]`), `[id]`, `[actor_entity]`, `[summary]`, `[rationale]`, `[outcome_entity]`, `[alternative_entities]`, `[status]`, `[event_time]` |
| `update_decision` | `id`, `[title]`, `[steps]`, `[actor_entity]`, `[summary]`, `[rationale]`, `[outcome_entity]`, `[alternative_entities]`, `[status]`, `[event_time]`, `[clear]` |
| `list_decisions` | `[actor_entity]`, `[status]` |
| `get_decision`, `delete_decision` | `id` |
| `retrieve` | `query`, `[strategy]`, `[depth]`, `[k]`, `[max_nodes]`, `[budget_tokens]`, `[as_of]`, `[known_at]`, `[seeds]`, `[skip_hubs]` |
| `graph_diff` | `since`, `[until]` ([changes between known times](#changes-between-known-times)) |
| `run_cypher` | `query`, `[params]` |
| `maintenance_decay` | `[half_life_days]`, `[now]`, `[dry_run]` |
| `maintenance_prune` | `[min_relevance]`, `[older_than]`, `[types]`, `[relation_types]`, `[include_certified]`, `[dry_run]` |
| `maintenance_dedupe_relations` | `[dry_run]` |

### Annotations

| Annotation | Tools |
|------------|-------|
| `readOnlyHint` | `check_*`, `get_*`, `list_*`, `*_versions`, `entity_evidence`, `relation_evidence`, `entity_merges`, `retrieve`, `graph_diff`, `run_cypher` |
| `destructiveHint` | Set on every other tool. True on `delete_*`, `maintenance_prune`, and `maintenance_dedupe_relations`. |
| `idempotentHint` | Set on every other tool. True on `delete_*`, `maintenance_prune`, `maintenance_dedupe_relations`, `insert_facts`, `certify_relation`, and `uncertify_relation`. |

### Argument rules

**Types.**

- Time arguments (`event_time`, `as_of`, `known_at`, `now`, `older_than`) are ISO 8601 text,
  read as the [CLI time flags](cli.md#arguments) are.
- Boolean arguments (`dry_run`, `include_invalidated`, `newest_first`) accept only
  JSON `true` or `false`.
- Number arguments (`limit`, `depth`, `k`, `max_nodes`, `budget_tokens`,
  `strength`, `half_life_days`, `min_relevance`) accept only JSON numbers, not
  text or booleans. A whole number such as `2.0` passes where an integer is
  expected.
- `create_decision`'s `steps` must be a list when given; `null` is rejected.
- `status` accepts only `active`, `completed`, or `reversed`. `stance` accepts only
  `preference` or `disinterest`.
- A relation, preference, or decision id needs its `relation:`, `preference:`,
  or `decision:` prefix.

**Per-call overrides.** These override the server's setting for one call, as in
the library:

- `resolver` overrides `--resolver` ([entity resolution](resolution.md)).
- `contradiction` overrides `--contradiction`
  ([contradictions](schema.md#contradictions)).
- `schema` and `schema_mode` override `--schema` and `--schema-mode`.
- `insert_text`'s `instructions` and `prompts` override the server's extraction
  settings.

**Evidence.** `evidence` on `create_relation` and `update_relation` is a list of
`{source_id, chunk_id?, quote?, start_offset?, end_offset?, confidence?}` records.
`update_relation` adds them to the existing evidence.

**Updates** follow the [library rules](resources.md#clearing-fields). An omitted
field keeps its value. In `update_decision`, an explicit `null` clears a field
and `[]` empties `steps` or `alternative_entities`. `update_relation` ignores an
absent `remove_properties` key.

**Reads.**

- A `get_*` tool returns `null` for a missing id, as text and as the structured
  `result`. `get_relation` on a [retired relation](resources.md#relations) fails
  instead.
- `get_entity`, `get_relation`, `get_preference`, `get_decision`, and `get_schema`
  always put the object in the structured `result`, found or not
  (`{"result": {...}}` or `{"result": null}`), in both SDKs. The text content is the
  bare object or `null`.
- `relation_versions` and `preference_versions` return the list as one JSON text
  content and as the structured `result`.

**Maintenance.** The maintenance tools write only with `dry_run: false`. A
dry-run plan has no `deleted` block.

### `run_cypher`

`run_cypher` runs one read statement. It must begin with `MATCH`,
`OPTIONAL MATCH`, `WITH`, `UNWIND`, `RETURN`, `SHOW`, `EXPLAIN`, or `PROFILE`.

A keyword guard, not a sandbox, rejects:

- any write, schema, transaction, or admin clause, including `INSERT`;
- a write keyword used as a bare alias or variable name (backtick-quote it);
- any `\u` escape, since Neo4j decodes those before parsing (pass such text as a
  parameter).

It is not scoped to the namespace, so filter on the `ns` property. Every `$name`
the query references must be in `params`, else it fails with
`missing parameter $name`. Unused params are dropped. Results look as described
in [Raw Cypher](backends.md#raw-cypher). A query that returns no rows, or that
the backend rejects, comes with [notes](trust.md#cypher-notes) in `warnings` or
in the error.

## Embedding

The tools share one graph that opens on the first call. `close()` closes it so the
process can exit, and the next call reopens it.

| Python (`selfgraph.mcp.server`) | TypeScript (`@hydradb/selfgraph/mcp`) |
|---------------------------------|---------------------------------------|
| `await configure(settings=None)`: sets the backend from `GraphSettings`, or the environment, and closes any open graph | `await configure(settings?)` |
| `build_server()`: returns the server | `await buildServer()` |
| `run_stdio(settings=None)`: configures and serves over stdio | `await runStdio(settings?)` |
| `await close()` | `await close()` |
| `TOOLS`: the tool functions | `TOOLS`, plus `callTool(tool, args, hinted?)`, which runs one tool without a server and resolves to `{ result, isError }`; pass the same `hinted` set across calls to send each code's hint once, as a server session does |

## Errors

A failing tool returns an MCP error result with the error flag set. Its
structured content is the error with its [code](errors.md#codes) and the tool
that failed, and its text is the same object as JSON:

```json
{
  "error": "Entity 'person:ad' does not exist in namespace 'default'; did you mean 'person:ada'?",
  "error_type": "NotFoundError",
  "code": "not_found",
  "hint": "The object does not exist in the namespace the message names. Check the id and the namespace, and use the `did you mean` suggestion when there is one. Do not create a placeholder object just to make the call pass.",
  "retryable": false,
  "docs": "https://github.com/hydra-db/selfgraph/blob/v<version>/docs/errors.md#not_found",
  "agent_guide": "site-packages/selfgraph/errors.md#not_found",
  "tool": "update_entity"
}
```

An error about one argument or key also carries `field`, such as
`"field": "limit"`. The `hint`, `docs`, and `agent_guide` fields come with the
first error of each code in a session, and are left out after that, so a
repeated failure costs fewer tokens. Each server built with `build_server()`
(`buildServer()` in TypeScript) is its own session, so two servers in one
process do not share it; `configure` changes the backend and keeps the session.

A result with warnings, such as an insert, carries `warning_hints`, the hint
of each [warning code](errors.md#warning-codes) the session has not seen yet.
Each warning in `warnings` keeps its code every time; only the hint is sent once.

An error that is not a SelfGraph error has `error_type` `InternalError` and no
code.

- Arguments that do not match a tool's schema fail as the result above, a
  `ValidationError` with code `invalid_argument` (`unknown_key` for an unknown
  argument), `field`, and one `path: message` line per problem
  (`invalid arguments: format: expected 'selfgraph', 'neo4j' or 'ossie'`). Python and TypeScript give the
  same text and `field` for the same bad argument: a count below its minimum reads
  `invalid arguments: budget_tokens: must be >= 1`, and a number in a message has no
  `.0` when it is whole (`min_relevance must be between 0 and 1, got 2`).
- An unknown argument names the closest one, and lists the tool's arguments when
  there are at most eight.
- An unknown tool name fails as the result above, a `ValidationError` with code
  `invalid_argument` (`unknown tool 'list_entitys'`).
- Hints and the `maintenance_prune` note name the server's flags, as in the CLI
  ([errors](errors.md#messages)).

## Changes between known times

`graph_diff(since, until=None)` is a read-only tool. Pass ISO 8601 timestamps for
the `(since, until]` known-time window. It returns the same lists as
`graph.diff`: created entities; added, revised, retired, certified, and
uncertified relations; added and revised preferences; created and updated
decisions; merges and unmerges; and added source versions. `until` defaults to
now. It scans stored records, not a full audit log. Deletes and entity edits are
not visible; `limitations` includes that note.
See [diff semantics and limits](retrieval.md#changes-between-known-times).

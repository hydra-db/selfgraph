# MCP

SelfGraph ships a Model Context Protocol server that exposes the graph to an MCP
client such as Claude Desktop, Cursor, or Codex. It serves the same API as the library.
Python needs `pip install "selfgraph[mcp]"`; TypeScript needs the
`@modelcontextprotocol/sdk` peer package.

## Client config

The server runs over stdio, and the client launches it from its config. Stdio clients
start it without your shell environment, so `SELFGRAPH_*` variables exported in a
terminal do not reach it: set them in the client's `env` block, which also keeps secrets
out of `args`.

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

For TypeScript, use `"command": "npx"` with `"args": ["-y", "-p", "@hydradb/selfgraph",
"-p", "@modelcontextprotocol/sdk", "selfgraph", "mcp"]`. The [CLI connection
flags](cli.md#connection-flags) also work in `args` before `mcp`, as in
`["--store", "kuzu", "--uri", "graph.kuzu", "mcp"]`. With no store and no URI from
either, the server uses the default embedded Kuzu store at `~/.selfgraph/default.kuzu`,
not the backend your shell points at.

The server validates every setting at startup, as the CLI does, including the schema,
instructions, and prompts, so a bad `SELFGRAPH_LLM_TIMEOUT`, a missing prompts file, or a
template without `{text}` fails before it serves. The backend must be reachable when the first tool runs; a Kuzu file needs nothing running. The server
reports the installed SelfGraph version in its server info, and the Python server logs
only warnings and errors from the MCP SDK on stderr.

`--schema` checks every insert tool against a [schema](schema.md#cli-and-mcp), and the
`get_schema` tool returns it (`format: "neo4j"` for a Neo4j graph schema), so an agent
can read the expected types before it writes. `--instructions` and `--prompts` steer
`insert_text` extraction.

## Tools

Both servers register the same 34 tools. Each carries annotations: `readOnlyHint` on
`get_*`, `list_*`, `*_versions`, `entity_evidence`, `relation_evidence`,
`entity_merges`, `retrieve`, and `run_cypher`; every other tool sets `destructiveHint`
(true on `delete_*`, `maintenance_prune`, and `maintenance_consolidate`) and
`idempotentHint` (true on those and `insert_ontology`).

Arguments keep the library's names; optional ones are in brackets. `list_*`, the
evidence tools, and `entity_merges` also take `[limit]` (1 to 1000, default 50) and
`[cursor]`.

| Tool | Arguments |
|------|-----------|
| `get_schema` | `[format]` (`selfgraph` or `neo4j`) |
| `insert_text` | `text`, `[source_id]`, `[event_time]`, `[metadata]`, `[resolver]`, `[contradiction]`, `[schema]`, `[schema_mode]`, `[instructions]`, `[prompts]` |
| `insert_ontology` | `ontology` (an object with `entities`, `relations`, `preferences`, `decisions`), `[source_id]`, `[event_time]`, `[resolver]`, `[contradiction]`, `[schema]`, `[schema_mode]` |
| `create_entity` | `name`, `type`, `[id]`, `[aliases]`, `[external_ids]`, `[properties]` |
| `update_entity` | `id`, `[name]`, `[type]`, `[aliases]`, `[external_ids]`, `[properties]`, `[remove_aliases]`, `[remove_properties]` |
| `list_entities` | `[type]`, `[name]` |
| `get_entity`, `delete_entity`, `entity_evidence`, `entity_merges` | `id` |
| `unmerge_entity` | `merge_id` |
| `create_relation` | `from_entity`, `type`, `to_entity`, `[id]`, `[properties]`, `[event_time]`, `[contradiction]`, `[evidence]` |
| `update_relation` | `id`, `[set_properties]`, `[remove_properties]`, `[event_time]`, `[evidence]` |
| `list_relations` | `[from_entity]`, `[type]`, `[to_entity]`, `[include_invalidated]` |
| `get_relation`, `delete_relation`, `relation_evidence` | `id` |
| `relation_versions`, `preference_versions` | `id`, `[newest_first]` (default true) |
| `create_preference` | `subject_entity`, `key`, `value_entity`, `[kind]`, `[id]`, `[about_entity]`, `[strength]`, `[properties]`, `[event_time]` |
| `update_preference` | `id`, `[strength]`, `[properties]`, `[remove_properties]`, `[event_time]`, `[clear]` |
| `list_preferences` | `[subject_entity]`, `[key]`, `[kind]` |
| `get_preference`, `delete_preference` | `id` |
| `create_decision` | `title`, `[steps]` (default `[]`), `[id]`, `[actor_entity]`, `[summary]`, `[rationale]`, `[outcome_entity]`, `[alternative_entities]`, `[status]`, `[event_time]` |
| `update_decision` | `id`, `[title]`, `[steps]`, `[actor_entity]`, `[summary]`, `[rationale]`, `[outcome_entity]`, `[alternative_entities]`, `[status]`, `[event_time]`, `[clear]` |
| `list_decisions` | `[actor_entity]`, `[status]` |
| `get_decision`, `delete_decision` | `id` |
| `retrieve` | `query`, `[strategy]`, `[depth]`, `[k]`, `[max_nodes]`, `[budget_tokens]`, `[as_of]` |
| `run_cypher` | `query`, `[params]` |
| `maintenance_decay` | `[half_life_days]`, `[now]`, `[dry_run]` |
| `maintenance_prune` | `[min_relevance]`, `[older_than]`, `[types]`, `[relation_types]`, `[dry_run]` |
| `maintenance_consolidate` | `[dry_run]` |

- Time arguments (`event_time`, `as_of`, `now`, `older_than`) are ISO 8601 text; no
  offset, or a bare date, means UTC. `insert_ontology`'s `event_time` is the default for
  items without their own.
- `insert_text` falls back to a built-in LLM-free extractor when no LLM is configured,
  and rejects empty or whitespace-only text.
- `resolver` overrides `--resolver` ([entity resolution](resolution.md)) and
  `contradiction` overrides `--contradiction` ([contradictions](schema.md#contradictions))
  for one call. `schema` and `schema_mode` override `--schema` and `--schema-mode` for
  one insert, and `insert_text`'s `instructions` and `prompts` override the server's
  extraction settings, as in the library.
- `evidence` on `create_relation` and `update_relation` is a list of
  `{source_id, chunk_id?, quote?, start_offset?, end_offset?, confidence?}` records;
  `update_relation` adds them to the existing evidence.
- Boolean arguments (`dry_run`, `include_invalidated`, `newest_first`) accept only JSON
  `true` or `false`. `status` (`active`, `completed`, `reversed`) and `kind`
  (`preference`, `disinterest`) accept only those values.
- The maintenance tools write only with `dry_run: false`; a dry-run plan has no
  `deleted` block.
- In `update_decision`, an omitted field keeps its value, an explicit `null` clears
  `actor_entity`, `summary`, `rationale`, `outcome_entity`, or `event_time`, and `[]`
  empties `steps` or `alternative_entities`. `clear` names fields to clear the same way;
  `update_preference` takes `clear` with `strength`, `about_entity`, or `event_time`.
- `update_entity` cannot change the type; see [CLI arguments](cli.md#arguments).
  `update_relation` ignores an absent `remove_properties` key. An `update_*` call that
  names no field fails with `nothing to update`.
- A `get_*` tool returns `null` for a missing id, as text and as the structured
  `result`, where CLI `get` exits 1. The exception is `get_relation` on a relation
  a contradiction retired, which fails naming the relation that retired it. A relation, preference, or decision id without
  its `relation:`, `preference:`, or `decision:` prefix fails as on create.
- `relation_versions` and `preference_versions` return the list as one JSON text content
  and as the structured `result`.

`run_cypher` runs one read statement that begins with `MATCH`, `OPTIONAL MATCH`, `WITH`,
`UNWIND`, `RETURN`, `SHOW`, `EXPLAIN`, or `PROFILE`. A keyword guard, not a sandbox,
rejects any write, schema, transaction, or admin clause, including `INSERT`, a write
keyword used as a bare alias or variable name (backtick-quote it), and any `\u` escape,
since Neo4j decodes those before parsing (pass such text as a parameter). It is not
scoped to the namespace, so filter on the `ns` property. Every `$name` the query
references must be in `params`, else it fails with `missing parameter $name`; unused
params are dropped. Results look as described in [Raw Cypher](backends.md#raw-cypher).

## Embedding

The tools share one graph that opens on the first call; `close()` closes it so the
process can exit, and the next call reopens it.

| Python (`selfgraph.mcp.server`) | TypeScript (`@hydradb/selfgraph/mcp`) |
|---------------------------------|---------------------------------------|
| `configure(settings=None)`: sets the backend from `GraphSettings`, or the environment | `await configure(settings?)` |
| `build_server()`: returns the server | `await buildServer()` |
| `run_stdio(settings=None)`: configures and serves over stdio | `await runStdio(settings?)` |
| `await close()` | `await close()` |
| `TOOLS`: the tool functions | `TOOLS`, plus `callTool(tool, args)`, which runs one tool without a server and resolves to `{ result, isError }` |

## Errors

A failing tool returns an MCP error result with the error flag set. In Python its text is
`ErrorType: message`, such as `NotFoundError: Entity 'person:nobody' does not exist`; in
TypeScript its content is `{error, error_type}`. Arguments that do not match a tool's
schema fail the same way, as a `ValidationError` with one `path: message` line per
problem (`invalid arguments: format: expected 'selfgraph' or 'neo4j'`); an unknown
argument names the closest one and lists the tool's arguments when there are at most
eight. An unknown tool name fails as a tool error. Hints and the `maintenance_prune`
note name the server's flags, as in the CLI ([errors](errors.md#messages)).

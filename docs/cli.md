# CLI

Installing the package puts a `selfgraph` command on your path. It wraps the same
API as the library.

## Connection flags

These come before the subcommand and pick the backend.

| Flag | Meaning |
|------|---------|
| `--store` | `hydradb`, `neo4j`, `cypher`, `memgraph`, `falkordb`, or `kuzu`. Defaults to embedded `kuzu` at `~/.selfgraph/default.kuzu`, or `hydradb` when `--uri` is given. |
| `--uri` | Bolt URI for the Bolt stores; the file path for `kuzu`; `host:port` or `redis://user:password@host:port` for `falkordb`. |
| `--auth` | `user:password`, or a bare token with user `neo4j`. For `falkordb`, a bare token is the password of the default user, and `--auth` wins over credentials in the URI. |
| `--database` | Database name for Bolt stores; the graph name for `falkordb` (default `selfgraph`). |
| `--namespace` | Graph namespace, default `default` when unset. An empty or blank value is an error. |
| `--llm-provider`, `--llm-model`, `--llm-api-key`, `--llm-base-url` | LLM settings for `insert text`. |
| `--schema` | A [schema](schema.md) JSON file applied to every insert. |
| `--schema-mode` | `warn` (default), `strict`, or `off`. |

Each flag falls back to its `SELFGRAPH_*` environment variable.

## Commands

```bash
selfgraph --store kuzu --uri graph.kuzu init
selfgraph --store kuzu --uri graph.kuzu insert ontology graph.json
selfgraph --store kuzu --uri graph.kuzu retrieve "who works at Acme"
selfgraph --store kuzu --uri graph.kuzu entity list --type Company
selfgraph version
```

| Command | Does |
|---------|------|
| `init` | Create the store's id constraints and print the store and namespace in use. |
| `version` | Print the installed version. |
| `mcp` | Run the MCP server over stdio. See [MCP](mcp.md). |
| `schema` | Print the active schema, or `null`. |
| `query` | Run one raw Cypher statement. Unlike the MCP `run_cypher` tool, it can write, and it is not scoped to the namespace. |
| `retrieve` | Retrieve context for a query. |
| `insert text` | Extract an ontology from text, or `-` for stdin, with an LLM if one is configured, else spaCy or the regex fallback. |
| `insert ontology` | Insert a ready ontology from a JSON file, or `-` for stdin. |
| `entity` | `create`, `get`, `list`, `evidence`, `update`, `delete`. |
| `relation` | `create`, `get`, `list`, `versions`, `evidence`, `update`, `delete`. |
| `preference` | `create`, `get`, `list`, `versions`, `update`, `delete`. |
| `decision` | `create`, `get`, `list`, `update`, `delete`. |

Run any command with `--help` for its arguments. Repeatable flags merge into what is
stored: `entity update --alias` and `--prop` add, while `--remove-alias` and
`--remove-prop` drop entries, and `--external-id SYSTEM=ID` sets an external id.
The `KEY=VALUE` flags (`--prop`, `--set`, `--param`) parse each value as JSON when it
is valid JSON, so `zip=12345` stores the number `12345`; quote it as `zip='"12345"'`
to keep text. `insert text`, `relation`, `preference`, and `decision` create and
update take `--event-time` as ISO 8601 text, and `decision update --alternative`
replaces the alternative entities. `preference list`
without a subject lists every subject, and `preference create` takes `--about` for
the entity a preference is about. Its `value` must be an existing entity id.

## Bolt example

`query` runs raw Cypher in the backend's own dialect, so the labels depend on the
store. Against a Bolt backend:

```bash
selfgraph --store neo4j --uri bolt://localhost:7687 --auth neo4j:password \
  query "MATCH (n:Entity) RETURN count(n)"

selfgraph --store neo4j --uri bolt://localhost:7687 --auth neo4j:password \
  --llm-provider openai --llm-model gpt-4o-mini \
  insert text "Acme acquired Beta Corp." --source-id notes
```

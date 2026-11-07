import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  type Command,
  CommanderError,
  Option,
  type OptionValues,
  Command as Program,
} from "@commander-js/extra-typings";

import { SelfGraph } from "./client.js";
import { SelfGraphError, ValidationError } from "./errors.js";
import { pyRepr } from "./internal/py.js";
import { runStdio } from "./mcp.js";
import { DEFAULT_KIND, DEFAULT_STATUS, type JsonObject, Kind, type Ontology, Status } from "./models.js";
import { dumps } from "./output.js";
import { DEFAULT_PAGE_LIMIT } from "./resources/common.js";
import { RETRIEVE_DEFAULTS, STRATEGIES } from "./retrieval.js";
import {
  DEFAULT_SETTINGS,
  type GraphSettings,
  parseJson,
  readJson,
  STORES,
  settingsFromEnv,
  version,
} from "./runtime.js";
import { SCHEMA_MODES } from "./schema.js";

type GlobalOptions = {
  store?: string;
  uri?: string;
  auth?: string;
  database?: string;
  namespace?: string;
  llmProvider?: string;
  llmModel?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  schema?: string;
  schemaMode?: string;
};

const collect = (value: string, prev: string[]): string[] => [...prev, value];

function intArg(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) throw new ValidationError(`invalid int value: ${pyRepr(value)}`);
  return Number.parseInt(value, 10);
}

function floatArg(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || Number.isNaN(n)) throw new ValidationError(`invalid float value: ${pyRepr(value)}`);
  return n;
}

/**
 * Parse repeated key=value flags; each value is JSON if it parses, else text.
 *
 * @param pairs (string[]): the key=value strings.
 * @param text (boolean): keep every value as text instead of parsing JSON.
 * @return (JsonObject): the parsed mapping.
 */
function kv(pairs: string[], text: true): Record<string, string>;
function kv(pairs: string[], text?: false): JsonObject;
function kv(pairs: string[], text = false): JsonObject {
  const out: JsonObject = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i < 0) throw new ValidationError(`expected key=value, got ${pyRepr(pair)}`);
    const value = pair.slice(i + 1);
    if (text) {
      out[pair.slice(0, i)] = value;
      continue;
    }
    try {
      out[pair.slice(0, i)] = JSON.parse(value);
    } catch {
      out[pair.slice(0, i)] = value;
    }
  }
  return out;
}

const kvOrNull = (pairs: string[]): JsonObject | null => (pairs.length ? kv(pairs) : null);

const listOrNull = (items: string[]): string[] | null => (items.length ? items : null);

function settingsOf(cmd: { optsWithGlobals(): GlobalOptions }): GraphSettings {
  const o = cmd.optsWithGlobals();
  return settingsFromEnv({
    store: o.store,
    uri: o.uri,
    auth: o.auth,
    database: o.database,
    namespace: o.namespace,
    llm_provider: o.llmProvider,
    llm_model: o.llmModel,
    llm_api_key: o.llmApiKey,
    llm_base_url: o.llmBaseUrl,
    schema: o.schema,
    schema_mode: o.schemaMode,
  });
}

/**
 * Open the graph from the command's settings, run one call, print its JSON, and close the graph.
 *
 * @param cmd (Command): the command being run.
 * @param call ((graph: SelfGraph) => Promise<unknown>): the graph call whose result is printed.
 */
async function emit(cmd: { optsWithGlobals(): GlobalOptions }, call: (graph: SelfGraph) => Promise<unknown>) {
  const graph = SelfGraph.connect(settingsOf(cmd));
  try {
    process.stdout.write(`${dumps(await call(graph))}\n`);
  } finally {
    await graph.close();
  }
}

function paging<A extends unknown[], O extends OptionValues, G extends OptionValues>(cmd: Command<A, O, G>) {
  return cmd
    .option("--cursor <cursor>", "opaque cursor from a previous page's next_cursor")
    .option("--limit <n>", `max items (default ${DEFAULT_PAGE_LIMIT})`, intArg, DEFAULT_PAGE_LIMIT);
}

function entityCommands(program: Command<[], GlobalOptions>): void {
  const ent = program.command("entity").description("create/get/list/delete entities");
  ent
    .command("create")
    .requiredOption("--name <name>")
    .requiredOption("--type <type>")
    .option("--id <id>")
    .option("--alias <alias>", "alias (repeatable)", collect, [])
    .option("--external-id <SYSTEM=ID>", "external id (repeatable)", collect, [])
    .option("--prop <KEY=VALUE>", "property (repeatable)", collect, [])
    .action((o, cmd) =>
      emit(cmd, (g) =>
        g.entities.create(o.name, o.type, {
          id: o.id,
          aliases: listOrNull(o.alias),
          external_ids: o.externalId.length ? kv(o.externalId, true) : null,
          properties: kvOrNull(o.prop),
        }),
      ),
    );
  ent.command("get <id>").action((id, _o, cmd) => emit(cmd, (g) => g.entities.get(id)));
  paging(ent.command("list").option("--type <type>").option("--name <name>")).action((o, cmd) =>
    emit(cmd, (g) => g.entities.list({ type: o.type, name: o.name, cursor: o.cursor, limit: o.limit })),
  );
  ent
    .command("update <id>")
    .option("--name <name>")
    .option("--type <type>")
    .option("--alias <alias>", "add an alias (repeatable)", collect, [])
    .option("--external-id <SYSTEM=ID>", "set an external id (repeatable)", collect, [])
    .option("--prop <KEY=VALUE>", "set property (repeatable)", collect, [])
    .option("--remove-alias <alias>", "remove an alias (repeatable)", collect, [])
    .option("--remove-prop <KEY>", "remove a property (repeatable)", collect, [])
    .action((id, o, cmd) =>
      emit(cmd, (g) =>
        g.entities.update(id, {
          ...(o.name !== undefined && { name: o.name }),
          ...(o.type !== undefined && { type: o.type }),
          ...(o.alias.length && { aliases: o.alias }),
          ...(o.externalId.length && { external_ids: kv(o.externalId, true) }),
          ...(o.prop.length && { properties: kv(o.prop) }),
          ...(o.removeAlias.length && { remove_aliases: o.removeAlias }),
          ...(o.removeProp.length && { remove_properties: o.removeProp }),
        }),
      ),
    );
  ent.command("delete <id>").action((id, _o, cmd) => emit(cmd, (g) => g.entities.delete(id)));
}

function relationCommands(program: Command<[], GlobalOptions>): void {
  const rel = program.command("relation").description("create/get/list/versions/delete relations");
  rel
    .command("create <FROM> <TYPE> <TO>")
    .option("--id <id>")
    .option("--prop <KEY=VALUE>", "property (repeatable)", collect, [])
    .option("--event-time <iso>", "when the fact became true (ISO 8601)")
    .action((from, type, to, o, cmd) =>
      emit(cmd, (g) =>
        g.relations.create(from, type, to, { id: o.id, properties: kvOrNull(o.prop), event_time: o.eventTime }),
      ),
    );
  rel.command("get <id>").action((id, _o, cmd) => emit(cmd, (g) => g.relations.get(id)));
  paging(rel.command("list").option("--from <id>").option("--type <type>").option("--to <id>")).action((o, cmd) =>
    emit(cmd, (g) =>
      g.relations.list({ from_entity: o.from, type: o.type, to_entity: o.to, cursor: o.cursor, limit: o.limit }),
    ),
  );
  rel.command("versions <id>").action((id, _o, cmd) => emit(cmd, (g) => g.relations.versions(id)));
  rel
    .command("update <id>")
    .description("make a new version with changed properties")
    .option("--set <KEY=VALUE>", "set property (repeatable)", collect, [])
    .option("--remove <KEY>", "remove property (repeatable)", collect, [])
    .option("--event-time <iso>", "when the new version became true (ISO 8601)")
    .action((id, o, cmd) =>
      emit(cmd, (g) =>
        g.relations.update(id, {
          set_properties: kvOrNull(o.set),
          remove_properties: o.remove,
          event_time: o.eventTime,
        }),
      ),
    );
  rel.command("delete <id>").action((id, _o, cmd) => emit(cmd, (g) => g.relations.delete(id)));
}

function preferenceCommands(program: Command<[], GlobalOptions>): void {
  const pref = program.command("preference").description("create/get/list/versions/update/delete preferences");
  pref
    .command("create <subject> <key> <value>")
    .description("value is an existing entity id, e.g. tool:hydradb")
    .option("--id <id>")
    .addOption(new Option("--kind <kind>").choices(Kind.options).default(DEFAULT_KIND))
    .option("--about <id>", "entity id the preference is about")
    .option("--strength <x>", "strength", floatArg)
    .option("--prop <KEY=VALUE>", "property (repeatable)", collect, [])
    .option("--event-time <iso>", "when the preference became true (ISO 8601)")
    .action((subject, key, value, o, cmd) =>
      emit(cmd, (g) =>
        g.preferences.create(subject, key, value, {
          id: o.id,
          kind: o.kind,
          about_entity: o.about,
          strength: o.strength,
          properties: kvOrNull(o.prop),
          event_time: o.eventTime,
        }),
      ),
    );
  pref.command("get <id>").action((id, _o, cmd) => emit(cmd, (g) => g.preferences.get(id)));
  paging(
    pref
      .command("list [subject]")
      .description("omit subject to list every subject")
      .option("--key <key>")
      .addOption(new Option("--kind <kind>").choices(Kind.options)),
  ).action((subject, o, cmd) =>
    emit(cmd, (g) =>
      g.preferences.list(subject ?? null, { key: o.key, kind: o.kind, cursor: o.cursor, limit: o.limit }),
    ),
  );
  pref
    .command("update <id>")
    .option("--strength <x>", "strength", floatArg)
    .option("--prop <KEY=VALUE>", "set property (repeatable)", collect, [])
    .option("--remove-prop <KEY>", "remove a property (repeatable)", collect, [])
    .option("--event-time <iso>", "when the new version became true (ISO 8601)")
    .action((id, o, cmd) =>
      emit(cmd, (g) =>
        g.preferences.update(id, {
          strength: o.strength,
          properties: kvOrNull(o.prop),
          remove_properties: o.removeProp,
          event_time: o.eventTime,
        }),
      ),
    );
  pref.command("versions <id>").action((id, _o, cmd) => emit(cmd, (g) => g.preferences.versions(id)));
  pref.command("delete <id>").action((id, _o, cmd) => emit(cmd, (g) => g.preferences.delete(id)));
}

function decisionCommands(program: Command<[], GlobalOptions>): void {
  const dec = program.command("decision").description("create/get/list/update/delete decision traces");
  dec
    .command("create <title>")
    .option("--step <relation-id>", "relation id, in order (repeatable)", collect, [])
    .option("--id <id>")
    .option("--actor <id>", "actor entity id")
    .option("--summary <text>")
    .option("--rationale <text>")
    .option("--outcome <id>", "outcome entity id")
    .option("--alternative <id>", "alternative entity id (repeatable)", collect, [])
    .addOption(new Option("--status <status>").choices(Status.options).default(DEFAULT_STATUS))
    .action((title, o, cmd) =>
      emit(cmd, (g) =>
        g.decisions.create(title, {
          steps: o.step,
          id: o.id,
          actor_entity: o.actor,
          summary: o.summary,
          rationale: o.rationale,
          outcome_entity: o.outcome,
          alternative_entities: o.alternative,
          status: o.status,
        }),
      ),
    );
  dec.command("get <id>").action((id, _o, cmd) => emit(cmd, (g) => g.decisions.get(id)));
  paging(
    dec
      .command("list")
      .option("--actor <id>", "actor entity id")
      .addOption(new Option("--status <status>").choices(Status.options)),
  ).action((o, cmd) =>
    emit(cmd, (g) => g.decisions.list({ actor_entity: o.actor, status: o.status, cursor: o.cursor, limit: o.limit })),
  );
  dec
    .command("update <id>")
    .option("--title <text>")
    .option("--summary <text>")
    .option("--rationale <text>")
    .addOption(new Option("--status <status>").choices(Status.options))
    .option("--step <relation-id>", "replace steps (repeatable, ordered)", collect, [])
    .option("--actor <id>", "actor entity id")
    .option("--outcome <id>", "outcome entity id")
    .action((id, o, cmd) =>
      emit(cmd, (g) =>
        g.decisions.update(id, {
          ...(o.title !== undefined && { title: o.title }),
          ...(o.summary !== undefined && { summary: o.summary }),
          ...(o.rationale !== undefined && { rationale: o.rationale }),
          ...(o.status !== undefined && { status: o.status }),
          ...(o.actor !== undefined && { actor_entity: o.actor }),
          ...(o.outcome !== undefined && { outcome_entity: o.outcome }),
          ...(o.step.length && { steps: o.step }),
        }),
      ),
    );
  dec.command("delete <id>").action((id, _o, cmd) => emit(cmd, (g) => g.decisions.delete(id)));
}

/**
 * Build the selfgraph command-line parser.
 *
 * @return (Command): the commander program.
 */
export function buildParser(): Command<[], GlobalOptions> {
  const program = new Program("selfgraph")
    .description("Build and read a SelfGraph knowledge graph.")
    .addOption(
      new Option(
        "--store <store>",
        "backend: hydradb, neo4j, cypher, memgraph, falkordb, or kuzu (default $SELFGRAPH_STORE, else embedded kuzu, or hydradb with --uri)",
      ).choices(STORES),
    )
    .option("--uri <uri>", "Bolt URI for neo4j/cypher/hydradb, host:port for falkordb")
    .option("--auth <auth>", "'user:password', or a bare token (user neo4j)")
    .option("--database <db>", "database name for Bolt stores")
    .option("--namespace <ns>", `graph namespace (default '${DEFAULT_SETTINGS.namespace}')`)
    .option("--llm-provider <provider>", "an AI SDK provider, e.g. anthropic, openai, google, ollama")
    .option("--llm-model <model>")
    .option("--llm-api-key <key>")
    .option("--llm-base-url <url>")
    .option("--schema <path>", "schema JSON file applied to every insert")
    .addOption(new Option("--schema-mode <mode>", "default warn").choices(SCHEMA_MODES));

  program
    .command("init")
    .description("create the store's ID constraints")
    .action((_o, cmd) =>
      emit(cmd, async (g) => {
        await g.initialize();
        const s = settingsOf(cmd);
        return { ok: true, store: s.store, namespace: s.namespace };
      }),
    );
  program
    .command("version")
    .description("print the installed version")
    .action(() => {
      process.stdout.write(`${dumps({ selfgraph: version })}\n`);
    });
  program
    .command("mcp")
    .description("run the MCP server over stdio")
    .action((_o, cmd) => runStdio(settingsOf(cmd)));
  program
    .command("schema")
    .description("print the active schema")
    .action((_o, cmd) => emit(cmd, async (g) => g.schema));
  program
    .command("query <cypher>")
    .description("run one Cypher statement")
    .option("--param <KEY=VALUE>", "query parameter (repeatable)", collect, [])
    .action((cypher, o, cmd) => emit(cmd, (g) => g.runCypher(cypher, kv(o.param))));
  program
    .command("retrieve <query>")
    .description("retrieve graph context for a query")
    .addOption(
      new Option("--strategy <s>", "traversal order, or ppr for PageRank ranking")
        .choices(STRATEGIES)
        .default(RETRIEVE_DEFAULTS.strategy),
    )
    .option("--depth <n>", `traversal hops (default ${RETRIEVE_DEFAULTS.depth})`, intArg, RETRIEVE_DEFAULTS.depth)
    .option("--k <n>", `seed count (default ${RETRIEVE_DEFAULTS.k})`, intArg, RETRIEVE_DEFAULTS.k)
    .option(
      "--max-nodes <n>",
      `entity cap (default ${RETRIEVE_DEFAULTS.max_nodes})`,
      intArg,
      RETRIEVE_DEFAULTS.max_nodes,
    )
    .option(
      "--budget-tokens <n>",
      `context budget (default ${RETRIEVE_DEFAULTS.budget_tokens})`,
      intArg,
      RETRIEVE_DEFAULTS.budget_tokens,
    )
    .action((query, o, cmd) =>
      emit(cmd, (g) =>
        g.retrieve(query, {
          strategy: o.strategy,
          depth: o.depth,
          k: o.k,
          max_nodes: o.maxNodes,
          budget_tokens: o.budgetTokens,
        }),
      ),
    );

  const insert = program.command("insert").description("insert text or an ontology");
  insert
    .command("text <text>")
    .description("extract an ontology from text (LLM if configured, else regex)")
    .option("--source-id <id>")
    .option("--metadata <json>", "JSON object of source metadata")
    .action((text, o, cmd) =>
      emit(cmd, (g) =>
        g.insert.text(text, {
          source_id: o.sourceId,
          metadata: o.metadata === undefined ? null : (parseJson(o.metadata, "") as JsonObject),
        }),
      ),
    );
  insert
    .command("ontology <path>")
    .description("insert a ready ontology (JSON file or '-' for stdin)")
    .option("--source-id <id>")
    .action((path, o, cmd) =>
      emit(cmd, (g) => g.insert.ontology(readJson(path) as Ontology, { source_id: o.sourceId })),
    );

  entityCommands(program);
  relationCommands(program);
  preferenceCommands(program);
  decisionCommands(program);
  return program;
}

function fail(message: string, code: number): number {
  process.stderr.write(`error: ${message}\n`);
  return code;
}

function exitOverride(cmd: Command<unknown[], OptionValues, OptionValues>): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) exitOverride(sub);
}

/**
 * Run the CLI.
 *
 * @param argv (string[]): the arguments, without the node binary and script path.
 * @return (number): the process exit code.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const program = buildParser();
  exitOverride(program);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (exc) {
    if (exc instanceof CommanderError) {
      return exc.code === "commander.helpDisplayed" || exc.code === "commander.version" || exc.exitCode === 0 ? 0 : 2;
    }
    if (exc instanceof ValidationError) return fail(exc.message, 2);
    if (exc instanceof SelfGraphError) return fail(exc.message, 1);
    if ((exc as NodeJS.ErrnoException).code === "EPIPE") return 130;
    return fail(exc instanceof Error ? exc.message : String(exc), 1);
  }
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(script);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((code) => process.exit(code));
}

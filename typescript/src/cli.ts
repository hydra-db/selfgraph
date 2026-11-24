import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Command,
  CommanderError,
  Option,
  type OptionValues,
  Command as Program,
} from "@commander-js/extra-typings";

import { SelfGraph } from "./client.js";
import { internalError, NotFoundError, SelfGraphError, surfaceHint, ValidationError, WARNING_HINTS } from "./errors.js";
import { toOssie } from "./export.js";
import { log, setLogger } from "./internal/log.js";
import { isPlainObject, pyRepr } from "./internal/py.js";
import { toIso } from "./internal/time.js";
import { runStdio } from "./mcp.js";
import {
  DEFAULT_STANCE,
  DEFAULT_STATUS,
  type EvidenceInput,
  type Extraction,
  type InsertResult,
  type JsonObject,
  Stance,
  Status,
} from "./models.js";
import { fromNeo4jOntology, toNeo4jOntology } from "./neo4jSchema.js";
import { DECISION_CLEARABLE, missingEntity, PREFERENCE_CLEARABLE, requireChanges } from "./ops.js";
import { dumps } from "./output.js";
import { RESOLVER_MODES, type ResolverMode } from "./resolution.js";
import { DEFAULT_PAGE_LIMIT } from "./resources/common.js";
import { RETRIEVE_DEFAULTS, STRATEGIES } from "./retrieval.js";
import {
  bindParams,
  checkedCypher,
  checkSettings,
  currentRelation,
  DEFAULT_SETTINGS,
  type GraphSettings,
  ignoredSettings,
  parseJson,
  readJson,
  readText,
  SETTING_KEYS,
  STORES,
  settingsFromEnv,
  storeKind,
  surfaced,
  version,
} from "./runtime.js";
import { CONTRADICTION_MODES, type ContradictionMode, SCHEMA_MODES } from "./schema.js";
import { LEVELS, SEED_TIERS } from "./tiers.js";
import { parseTime } from "./validate.js";

const JSON_VALUE = "; KEY=VALUE, VALUE parsed as JSON when valid (so 12345 is a number), else kept as text";
const ISO = "ISO 8601; no offset means UTC";
const NO_SCHEMA = "no schema set; pass --schema FILE or SELFGRAPH_SCHEMA";
const USAGE_CODES: ReadonlySet<string> = new Set([
  "invalid_argument",
  "unknown_key",
  "invalid_setting",
  "llm_required",
  "embedder_required",
  "schema_required",
  "schema_violation",
  "immutable_identity",
  "unknown_reference",
  "relation_certified",
  "relation_invalidated",
  "merge_reverted",
  "invalid_cursor",
  "invalid_resolver_decision",
  "read_only_query",
  "cypher_query_limit",
  "invalid_prompt_template",
]);
const NEO4J_KEYS = ["node_types", "relationship_types", "patterns", "constraints", "nodeTypes", "relationshipTypes"];
const LOGGED_WARNINGS = ["basic_extraction", "ner_extraction"];
const QUERY_EXAMPLES = `
examples, scoped to one namespace (stored property names differ per backend):
  Neo4j, Memgraph, FalkorDB:
    selfgraph query 'MATCH (n:Entity {ns: $ns}) RETURN n.id, n.name LIMIT 5' --param ns=default
  HydraDB (the SelfGraph id is n.sid):
    selfgraph query 'MATCH (n:Entity {ns: $ns}) RETURN n.sid, n.name LIMIT 5' --param ns=default
  Kuzu (one node table N, the record as JSON in doc):
    selfgraph query "MATCH (n:N {label: 'Entity', ns: \\$ns}) RETURN n.id, n.doc LIMIT 5" --param ns=default`;
const contradictionOption = () =>
  new Option(
    "--contradiction <mode>",
    "how to handle a contradicting relation; llm also judges with no max_count (default warn)",
  )
    .choices(CONTRADICTION_MODES)
    .argParser(choiceArg("--contradiction", CONTRADICTION_MODES));

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
  llmTimeout?: string;
  llmConcurrency?: string;
  schema?: string;
  instructions?: string;
  prompts?: string;
  schemaMode?: string;
  resolver?: string;
  contradiction?: string;
  level?: string;
  maxTier?: string;
};

const collect = (value: string, prev: string[]): string[] => [...prev, value];

class Text {
  constructor(readonly text: string) {}
}

/**
 * A commander parser for an integer flag, naming the flag when the value is not an integer.
 *
 * @param flag (string): the flag, for the error.
 * @return ((value: string) => number): the parser.
 */
const intArg = (flag: string) => (value: string) => {
  if (!/^[+-]?\d+$/.test(value.trim())) {
    throw new ValidationError(`${flag} expects an integer, got ${pyRepr(value)}`, {
      field: flag.replace(/^--/, "").replaceAll("-", "_"),
    });
  }
  return Number.parseInt(value, 10);
};

/**
 * A parser for a fixed-choice flag that raises SelfGraph's own error instead of
 * letting commander print a bare usage message.
 *
 * @param flag (string): the flag, for the message.
 * @param choices (readonly string[]): the accepted values.
 * @return ((value: string) => string): the parser.
 */
const choiceArg =
  <T extends string>(flag: string, choices: readonly T[]) =>
  (value: string): T => {
    if (!choices.includes(value as T)) {
      const setting = SETTING_CHOICES.has(flag);
      throw new ValidationError(`${flag} got ${pyRepr(value)}; choose from ${choices.join(", ")}`, {
        ...(setting ? { code: "invalid_setting" as const } : {}),
        field: flag.replace(/^--/, "").replaceAll("-", "_"),
      });
    }
    return value as T;
  };

const SETTING_CHOICES = new Set(["--store", "--schema-mode", "--resolver", "--contradiction", "--level", "--max-tier"]);

/**
 * A repeatable --clear option limited to the fields an update can clear.
 *
 * @param fields (readonly string[]): the clearable fields.
 * @return (Option): the option.
 */
function clearOption(fields: readonly string[]) {
  return new Option("--clear <FIELD>", `clear a field (repeatable): ${fields.join(", ")}`)
    .choices(fields)
    .argParser((value: string, prev: string[]) => {
      if (!fields.includes(value)) {
        throw new ValidationError(`--clear got ${pyRepr(value)}; choose from ${fields.join(", ")}`, {
          field: "clear",
        });
      }
      return [...prev, value];
    })
    .default([] as string[]);
}

const timeArg = (field: string) => (value: string) => parseTime(value, field);

/**
 * Write to stdout and wait until the text is handed to the OS, so exiting afterwards never truncates a pipe.
 *
 * @param text (string): the text to write.
 */
function writeOut(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Raise NotFoundError when a get found nothing, so it fails like delete instead of printing null.
 *
 * @param graph (SelfGraph): the graph that was read, for the namespace and an entity id suggestion.
 * @param objectType (string): the type named in the error.
 * @param id (string): the id that was looked up.
 * @return ((found: T | null) => Promise<T>): the check.
 */
const found =
  <T>(graph: SelfGraph, objectType: string, id: string) =>
  async (value: T | null): Promise<T> => {
    if (value !== null) return value;
    if (objectType === "Entity") throw await missingEntity(graph.store, graph.namespace, id);
    throw new NotFoundError(objectType, id, undefined, { namespace: graph.namespace });
  };

/**
 * A commander parser for a number flag, naming the flag when the value is not a number.
 *
 * @param flag (string): the flag, for the error.
 * @return ((value: string) => number): the parser.
 */
const floatArg = (flag: string) => (value: string) => {
  const n = Number(value);
  if (value.trim() === "" || Number.isNaN(n))
    throw new ValidationError(`${flag} expects a number, got ${pyRepr(value)}`, {
      field: flag.replace(/^--/, "").replaceAll("-", "_"),
    });
  return n;
};

/**
 * Parse repeated key=value flags; each value is JSON if it parses, else text.
 *
 * @param pairs (string[]): the key=value strings.
 * @param flag (string): the flag the pairs came from, for the error.
 * @param text (boolean): keep every value as text instead of parsing JSON.
 * @return (JsonObject): the parsed mapping.
 */
export function kv(pairs: string[], flag: string, text: true): Record<string, string>;
export function kv(pairs: string[], flag: string, text?: false): JsonObject;
export function kv(pairs: string[], flag: string, text = false): JsonObject {
  const out: JsonObject = Object.create(null);
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i < 0) throw new ValidationError(`${flag} expects ${text ? "SYSTEM=ID" : "KEY=VALUE"}, got ${pyRepr(pair)}`);
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

const kvOrNull = (pairs: string[]): JsonObject | null => (pairs.length ? kv(pairs, "--prop") : null);

/**
 * Parse repeated --metadata values: each a JSON object, or a KEY=VALUE pair, merged in order.
 *
 * @param items (string[]): the flag values.
 * @return (JsonObject | null): the metadata, or null when none was given.
 */
function metadataOf(items: string[]): JsonObject | null {
  if (!items.length) return null;
  const out: JsonObject = Object.create(null);
  for (const item of items) {
    Object.assign(out, item.trimStart().startsWith("{") ? parseJson(item, " in --metadata") : kv([item], "--metadata"));
  }
  return out;
}

/**
 * Parse repeated --evidence values: each a JSON evidence object, or a JSON array of them.
 *
 * @param items (string[]): the flag values.
 * @return (EvidenceInput[] | null): the evidence records, or null when none was given.
 */
function evidenceOf(items: string[]): EvidenceInput[] | null {
  if (!items.length) return null;
  return items.flatMap((item) => {
    const value = parseJson(item, " in --evidence");
    return (Array.isArray(value) ? value : [value]) as EvidenceInput[];
  });
}

const EVIDENCE_HELP =
  "evidence as JSON: {source_id, chunk_id?, quote?, start_offset?, end_offset?, confidence?} or an array of them (repeatable)";

const listOrNull = (items: string[]): string[] | null => (items.length ? items : null);

const checkedSettings = new WeakMap<object, GraphSettings>();

let lastSettings: GraphSettings | null = null;

function settingsOf(cmd: { optsWithGlobals(): GlobalOptions }): GraphSettings {
  const o: Record<string, string | undefined> = cmd.optsWithGlobals();
  const flag = (key: string) => key.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const settings = settingsFromEnv(Object.fromEntries(SETTING_KEYS.map((key) => [key, o[flag(key)]])));
  lastSettings = settings;
  return settings;
}

/**
 * Resolve the command's settings, dropping any the store ignores and warning on stderr about those given as flags.
 *
 * @param cmd (Command): the command being run.
 * @return (GraphSettings): the settings to connect with.
 */
function connectSettings(cmd: { optsWithGlobals(): GlobalOptions }): GraphSettings {
  const settings = checkedSettings.get(cmd) ?? checkSettings(settingsOf(cmd));
  const ignored = ignoredSettings(settings);
  const flags = cmd.optsWithGlobals();
  for (const key of ignored) {
    if (flags[key] !== undefined)
      process.stderr.write(`warning: --${key} is ignored by store ${storeKind(settings)}\n`);
  }
  return { ...settings, ...Object.fromEntries(ignored.map((key) => [key, null])) };
}

/**
 * Open the graph from the command's settings, run one call, print its JSON, and close the graph.
 *
 * @param cmd (Command): the command being run.
 * @param call ((graph: SelfGraph) => Promise<unknown>): the graph call whose result is printed.
 */
async function emit(cmd: { optsWithGlobals(): GlobalOptions }, call: (graph: SelfGraph) => Promise<unknown>) {
  const graph = SelfGraph.connect(connectSettings(cmd));
  try {
    const result = await call(graph);
    await writeOut(`${result instanceof Text ? result.text : dumps(result)}\n`);
  } finally {
    await graph.close();
  }
}

/**
 * Print each insert warning to stderr as one "code: message" line, except those the library already logged.
 *
 * @param result (InsertResult): the insert result.
 * @return (InsertResult): the same result, its warnings worded for the CLI.
 */
function inserted(result: InsertResult): InsertResult {
  for (const w of surfaced(result).warnings) {
    if (!LOGGED_WARNINGS.includes(w.code)) log(`${w.code}: ${w.message}`);
  }
  return result;
}

function paging<A extends unknown[], O extends OptionValues, G extends OptionValues>(cmd: Command<A, O, G>) {
  return cmd
    .option("--cursor <cursor>", "opaque cursor from a previous page's next_cursor")
    .option(
      "--limit <n>",
      "page size; pass the printed next_cursor as --cursor for the next page",
      intArg("--limit"),
      DEFAULT_PAGE_LIMIT,
    );
}

const callResolver = () =>
  new Option("--resolver <mode>", "entity resolution for this insert (default: the global --resolver)")
    .choices(RESOLVER_MODES)
    .argParser(choiceArg("--resolver", RESOLVER_MODES));

function entityCommands(program: Command<[], GlobalOptions>): void {
  const ent = program.command("entity").description("create/get/list/evidence/merges/unmerge/update/delete entities");
  ent
    .command("create")
    .description("create an entity")
    .requiredOption("--name <name>")
    .requiredOption("--type <type>")
    .option("--id <id>")
    .option("--alias <alias>", "alias (repeatable)", collect, [])
    .option("--external-id <SYSTEM=ID>", "external id (repeatable)", collect, [])
    .option("--prop <KEY=VALUE>", `property (repeatable)${JSON_VALUE}`, collect, [])
    .action((o, cmd) =>
      emit(cmd, (g) =>
        g.entities.create(o.name, o.type, {
          id: o.id,
          aliases: listOrNull(o.alias),
          external_ids: o.externalId.length ? kv(o.externalId, "--external-id", true) : null,
          properties: kvOrNull(o.prop),
        }),
      ),
    );
  ent
    .command("get <id>")
    .description("print one entity")
    .action((id, _o, cmd) => emit(cmd, (g) => g.entities.get(id).then(found(g, "Entity", id))));
  paging(
    ent
      .command("list")
      .description("list entities, filtered by type or name")
      .option("--type <type>")
      .option("--name <name>", "exact, case-sensitive match on the current name"),
  ).action((o, cmd) =>
    emit(cmd, (g) => g.entities.list({ type: o.type, name: o.name, cursor: o.cursor, limit: o.limit })),
  );
  paging(ent.command("evidence <id>").description("list the evidence supporting an entity")).action((id, o, cmd) =>
    emit(cmd, (g) => g.entities.evidence(id, { cursor: o.cursor, limit: o.limit })),
  );
  paging(ent.command("merges <id>").description("list the entities merged into an entity")).action((id, o, cmd) =>
    emit(cmd, (g) => g.entities.merges(id, { cursor: o.cursor, limit: o.limit })),
  );
  ent
    .command("unmerge <id>")
    .description("reverse a merge by merge id")
    .action((id, _o, cmd) => emit(cmd, (g) => g.entities.unmerge(id)));
  ent
    .command("update <id>")
    .description("change an entity's name, type, aliases, external ids, or properties")
    .option("--name <name>")
    .option("--type <type>", "change the type's case or spacing only (the type is part of the id)")
    .option("--alias <alias>", "add an alias (repeatable)", collect, [])
    .option("--external-id <SYSTEM=ID>", "set an external id (repeatable)", collect, [])
    .option("--prop <KEY=VALUE>", `set property (repeatable)${JSON_VALUE}`, collect, [])
    .option("--remove-alias <alias>", "remove an alias (repeatable)", collect, [])
    .option("--remove-prop <KEY>", "remove a property (repeatable)", collect, [])
    .action((id, o, cmd) =>
      emit(cmd, (g) =>
        g.entities.update(id, {
          ...(o.name !== undefined && { name: o.name }),
          ...(o.type !== undefined && { type: o.type }),
          ...(o.alias.length && { aliases: o.alias }),
          ...(o.externalId.length && { external_ids: kv(o.externalId, "--external-id", true) }),
          ...(o.prop.length && { properties: kv(o.prop, "--prop") }),
          ...(o.removeAlias.length && { remove_aliases: o.removeAlias }),
          ...(o.removeProp.length && { remove_properties: o.removeProp }),
        }),
      ),
    );
  ent
    .command("delete <id>")
    .description("delete an entity with its relations, preferences, and decisions")
    .action((id, _o, cmd) => emit(cmd, (g) => g.entities.delete(id)));
}

function relationCommands(program: Command<[], GlobalOptions>): void {
  const rel = program
    .command("relation")
    .description("create/get/list/versions/evidence/update/certify/delete relations");
  rel
    .command("create <FROM> <TYPE> <TO>")
    .description("create a relation between two entities")
    .option("--id <id>")
    .option("--prop <KEY=VALUE>", `property (repeatable)${JSON_VALUE}`, collect, [])
    .option("--event-time <iso>", `when the fact became true (${ISO})`, timeArg("event_time"))
    .option("--evidence <JSON>", EVIDENCE_HELP, collect, [])
    .addOption(contradictionOption())
    .action((from, type, to, o, cmd) =>
      emit(cmd, (g) =>
        g.relations.create(from, type, to, {
          id: o.id,
          properties: kvOrNull(o.prop),
          event_time: o.eventTime,
          evidence: evidenceOf(o.evidence) ?? [],
          contradiction: o.contradiction as ContradictionMode | undefined,
        }),
      ),
    );
  rel
    .command("get <id>")
    .description("print the current version of a relation")
    .action((id, _o, cmd) =>
      emit(cmd, (g) =>
        currentRelation(g, id, "use relation versions or relation list --include-invalidated").then(
          found(g, "Relation", id),
        ),
      ),
    );
  paging(
    rel
      .command("list")
      .description("list current relations, filtered by endpoint or type")
      .option("--from <id>")
      .option("--type <type>")
      .option("--to <id>")
      .option("--include-invalidated", "also list relations a contradiction retired"),
  ).action((o, cmd) =>
    emit(cmd, (g) =>
      g.relations.list({
        from_entity: o.from,
        type: o.type,
        to_entity: o.to,
        cursor: o.cursor,
        limit: o.limit,
        include_invalidated: o.includeInvalidated === true,
      }),
    ),
  );
  rel
    .command("versions <id>")
    .description("list every version of a relation, newest first")
    .option("--oldest-first", "list the oldest version first")
    .action((id, o, cmd) => emit(cmd, (g) => g.relations.versions(id, { newest_first: !o.oldestFirst })));
  paging(rel.command("evidence <id>").description("list the evidence supporting a relation")).action((id, o, cmd) =>
    emit(cmd, (g) => g.relations.evidence(id, { cursor: o.cursor, limit: o.limit })),
  );
  rel
    .command("update <id>")
    .description("make a new version with changed properties")
    .option("--set <KEY=VALUE>", `set property (repeatable)${JSON_VALUE}`, collect, [])
    .option("--prop <KEY=VALUE>", "alias of --set", collect, [])
    .option("--remove <KEY>", "remove property (repeatable; ignored if absent)", collect, [])
    .option("--remove-prop <KEY>", "alias of --remove", collect, [])
    .option("--event-time <iso>", `when the new version became true (${ISO})`, timeArg("event_time"))
    .option("--evidence <JSON>", `add ${EVIDENCE_HELP}`, collect, [])
    .action((id, o, cmd) =>
      emit(cmd, (g) =>
        g.relations.update(
          id,
          requireChanges({
            ...((o.set.length || o.prop.length) && { set_properties: kv([...o.set, ...o.prop], "--set") }),
            ...((o.remove.length || o.removeProp.length) && { remove_properties: [...o.remove, ...o.removeProp] }),
            ...(o.evidence.length && { evidence: evidenceOf(o.evidence) }),
            event_time: o.eventTime,
          }),
        ),
      ),
    );
  rel
    .command("certify <id>")
    .description("mark a current relation as verified, so nothing retires it automatically")
    .requiredOption("--by <name>", "who verified it")
    .action((id, o, cmd) => emit(cmd, (g) => g.relations.certify(id, { by: o.by })));
  rel
    .command("uncertify <id>")
    .description("remove a relation's certification")
    .action((id, _o, cmd) => emit(cmd, (g) => g.relations.uncertify(id)));
  rel
    .command("delete <id>")
    .description("delete a relation, its versions, and decision traces that use it as a step")
    .action((id, _o, cmd) => emit(cmd, (g) => g.relations.delete(id)));
}

function preferenceCommands(program: Command<[], GlobalOptions>): void {
  const pref = program.command("preference").description("create/get/list/versions/update/delete preferences");
  pref
    .command("create <subject> <key> <value>")
    .description("create a preference of a subject for a value entity (an existing entity id, e.g. tool:hydradb)")
    .option("--id <id>")
    .addOption(
      new Option("--stance <stance>")
        .choices(Stance.options)
        .argParser(choiceArg("--stance", Stance.options))
        .default(DEFAULT_STANCE),
    )
    .option("--about <id>", "entity id the preference is about")
    .option("--strength <x>", "strength", floatArg("--strength"))
    .option("--prop <KEY=VALUE>", `property (repeatable)${JSON_VALUE}`, collect, [])
    .option("--event-time <iso>", `when the preference became true (${ISO})`, timeArg("event_time"))
    .action((subject, key, value, o, cmd) =>
      emit(cmd, (g) =>
        g.preferences.create(subject, key, value, {
          id: o.id,
          stance: o.stance,
          about_entity: o.about,
          strength: o.strength,
          properties: kvOrNull(o.prop),
          event_time: o.eventTime,
        }),
      ),
    );
  pref
    .command("get <id>")
    .description("print the current version of a preference")
    .action((id, _o, cmd) => emit(cmd, (g) => g.preferences.get(id).then(found(g, "Preference", id))));
  paging(
    pref
      .command("list [subject]")
      .description("list current preferences, for one subject or all (omit subject)")
      .option("--key <key>")
      .addOption(
        new Option("--stance <stance>").choices(Stance.options).argParser(choiceArg("--stance", Stance.options)),
      ),
  ).action((subject, o, cmd) =>
    emit(cmd, (g) =>
      g.preferences.list(subject ?? null, { key: o.key, stance: o.stance, cursor: o.cursor, limit: o.limit }),
    ),
  );
  pref
    .command("update <id>")
    .description("make a new version with a changed strength or properties")
    .option("--strength <x>", "strength", floatArg("--strength"))
    .option("--prop <KEY=VALUE>", `set property (repeatable)${JSON_VALUE}`, collect, [])
    .option("--remove-prop <KEY>", "remove a property (repeatable)", collect, [])
    .option("--event-time <iso>", `when the new version became true (${ISO})`, timeArg("event_time"))
    .addOption(clearOption(PREFERENCE_CLEARABLE))
    .action((id, o, cmd) => {
      const changes = {
        ...(o.strength !== undefined && { strength: o.strength }),
        ...(o.prop.length && { properties: kv(o.prop, "--prop") }),
        ...(o.removeProp.length && { remove_properties: o.removeProp }),
        ...(o.eventTime !== undefined && { event_time: o.eventTime }),
        ...(o.clear.length && { clear: o.clear }),
      };
      return emit(cmd, (g) => g.preferences.update(id, requireChanges(changes)));
    });
  pref
    .command("versions <id>")
    .description("list every version of a preference, newest first")
    .option("--oldest-first", "list the oldest version first")
    .action((id, o, cmd) => emit(cmd, (g) => g.preferences.versions(id, { newest_first: !o.oldestFirst })));
  pref
    .command("delete <id>")
    .description("delete a preference and its versions")
    .action((id, _o, cmd) => emit(cmd, (g) => g.preferences.delete(id)));
}

function decisionCommands(program: Command<[], GlobalOptions>): void {
  const dec = program.command("decision").description("create/get/list/update/delete decision traces");
  dec
    .command("create <title>")
    .description("record a decision trace over ordered relation steps")
    .option("--step <relation-id>", "relation id, in order (repeatable; default no steps)", collect, [])
    .option("--id <id>")
    .option("--actor <id>", "actor entity id")
    .option("--summary <text>")
    .option("--rationale <text>")
    .option("--outcome <id>", "outcome entity id")
    .option("--alternative <id>", "alternative entity id (repeatable)", collect, [])
    .addOption(
      new Option("--status <status>")
        .choices(Status.options)
        .argParser(choiceArg("--status", Status.options))
        .default(DEFAULT_STATUS),
    )
    .option("--event-time <iso>", `when the decision was made (${ISO})`, timeArg("event_time"))
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
          event_time: o.eventTime,
        }),
      ),
    );
  dec
    .command("get <id>")
    .description("print one decision trace")
    .action((id, _o, cmd) => emit(cmd, (g) => g.decisions.get(id).then(found(g, "DecisionTrace", id))));
  paging(
    dec
      .command("list")
      .description("list decision traces, filtered by actor or status")
      .option("--actor <id>", "actor entity id")
      .addOption(
        new Option("--status <status>").choices(Status.options).argParser(choiceArg("--status", Status.options)),
      ),
  ).action((o, cmd) =>
    emit(cmd, (g) => g.decisions.list({ actor_entity: o.actor, status: o.status, cursor: o.cursor, limit: o.limit })),
  );
  dec
    .command("update <id>")
    .description("change a decision trace's fields or steps")
    .option("--title <text>")
    .option("--summary <text>")
    .option("--rationale <text>")
    .addOption(new Option("--status <status>").choices(Status.options).argParser(choiceArg("--status", Status.options)))
    .option("--step <relation-id>", "replace steps (repeatable, ordered; --clear steps empties them)", collect, [])
    .option("--actor <id>", "actor entity id")
    .option("--outcome <id>", "outcome entity id")
    .option("--alternative <id>", "replace alternative entity ids (repeatable)", collect, [])
    .option("--event-time <iso>", `when the decision was made (${ISO})`, timeArg("event_time"))
    .addOption(clearOption(DECISION_CLEARABLE))
    .action((id, o, cmd) => {
      const changes: Record<string, unknown> = {
        ...(o.title !== undefined && { title: o.title }),
        ...(o.summary !== undefined && { summary: o.summary }),
        ...(o.rationale !== undefined && { rationale: o.rationale }),
        ...(o.status !== undefined && { status: o.status }),
        ...(o.actor !== undefined && { actor_entity: o.actor }),
        ...(o.outcome !== undefined && { outcome_entity: o.outcome }),
        ...(o.step.length && { steps: o.step }),
        ...(o.alternative.length && { alternative_entities: o.alternative }),
        ...(o.eventTime !== undefined && { event_time: o.eventTime }),
        ...(o.clear.length && { clear: o.clear }),
      };
      return emit(cmd, (g) => g.decisions.update(id, requireChanges(changes)));
    });
  dec
    .command("delete <id>")
    .description("delete a decision trace")
    .action((id, _o, cmd) => emit(cmd, (g) => g.decisions.delete(id)));
}

function maintenanceCommands(program: Command<[], GlobalOptions>): void {
  const mt = program.command("maintenance").description("decay (score relevance), prune, or deduplicate relations");
  mt.command("decay")
    .description("score every entity and relation by recency and frequency; prints them unless --apply")
    .option("--half-life-days <days>", "days after which recency halves", floatArg("--half-life-days"), 30)
    .option("--now <iso>", `reference time (${ISO}; default now)`, timeArg("now"))
    .option("--apply", "write the scores", false)
    .action((o, cmd) =>
      emit(cmd, (g) => g.maintenance.decay({ half_life_days: o.halfLifeDays, now: o.now, dry_run: !o.apply })),
    );
  mt.command("prune")
    .description("remove low-relevance or old items; prints the plan unless --apply")
    .option("--min-relevance <n>", "remove items whose relevance is below this", floatArg("--min-relevance"))
    .option("--older-than <iso>", `remove items last touched before this (${ISO})`, timeArg("older_than"))
    .option("--type <type>", "only consider entities of this type (repeatable)", collect, [])
    .option("--relation-type <type>", "only consider relations of this type (repeatable)", collect, [])
    .option("--include-certified", "also remove certified relations and the entities they connect", false)
    .option("--apply", "remove what the plan lists", false)
    .action((o, cmd) =>
      emit(cmd, async (g) =>
        surfaced(
          await g.maintenance.prune({
            min_relevance: o.minRelevance,
            older_than: o.olderThan,
            types: listOrNull(o.type),
            relation_types: listOrNull(o.relationType),
            include_certified: o.includeCertified,
            dry_run: !o.apply,
          }),
        ),
      ),
    );
  mt.command("dedupe-relations")
    .description("merge duplicate parallel relations; prints the plan unless --apply")
    .option("--apply", "merge the groups the plan lists", false)
    .action((o, cmd) => emit(cmd, (g) => g.maintenance.dedupeRelations({ dry_run: !o.apply })));
}

/**
 * Build the selfgraph command-line parser.
 *
 * @return (Command): the commander program.
 */
export function buildParser(): Command<[], GlobalOptions> {
  const program = new Program("selfgraph")
    .description(
      "Build and read a SelfGraph knowledge graph. Connection flags may come before or after the subcommand.",
    )
    .version(version, "-V, --version", "print the installed version")
    .addOption(
      new Option(
        "--store <store>",
        "backend: hydradb, neo4j, cypher, memgraph, falkordb, or kuzu (default $SELFGRAPH_STORE, else embedded kuzu, or hydradb with --uri)",
      )
        .choices(STORES)
        .argParser(choiceArg("--store", STORES)),
    )
    .option("--uri <uri>", "Bolt URI for neo4j/cypher/hydradb, host:port for falkordb, file path for kuzu")
    .option(
      "--auth <auth>",
      "'user:password', or a bare token (user neo4j); falkordb takes 'user:password' or a bare password for the default user; ignored by kuzu",
    )
    .option(
      "--database <db>",
      "Bolt: database name (default: server default); FalkorDB: graph name (default selfgraph); ignored by kuzu",
    )
    .option("--namespace <ns>", `graph namespace (default '${DEFAULT_SETTINGS.namespace}')`)
    .option("--llm-provider <provider>", "an AI SDK provider, e.g. anthropic, openai, google, ollama")
    .option("--llm-model <model>", "the model; a provider-prefixed one such as openai/gpt-4o-mini sets the provider")
    .option("--llm-api-key <key>")
    .option("--llm-base-url <url>")
    .option("--llm-timeout <seconds>", "seconds to wait for each LLM call (default 120)")
    .option("--llm-concurrency <n>", "chunks to extract at once, each running four LLM calls (default 4)")
    .option("--schema <path>", "schema JSON file applied to every insert, or inline JSON when it starts with '{'")
    .option("--instructions <path>", "extraction instructions JSON file, or inline JSON when it starts with '{'")
    .option("--prompts <path>", "extraction prompt templates JSON file, or inline JSON when it starts with '{'")
    .addOption(
      new Option("--schema-mode <mode>", "default warn; strict needs --schema")
        .choices(SCHEMA_MODES)
        .argParser(choiceArg("--schema-mode", SCHEMA_MODES)),
    )
    .addOption(
      new Option("--resolver <mode>", "entity resolution on insert (default: by level)")
        .choices(RESOLVER_MODES)
        .argParser(choiceArg("--resolver", RESOLVER_MODES)),
    )
    .addOption(contradictionOption())
    .addOption(
      new Option("--level <level>", "sets every capability's default tier (default balanced)")
        .choices(LEVELS)
        .argParser(choiceArg("--level", LEVELS)),
    )
    .addOption(
      new Option("--max-tier <level>", "cost cap no capability climbs past (default max)")
        .choices(LEVELS)
        .argParser(choiceArg("--max-tier", LEVELS)),
    )
    .hook("preAction", (_program, action) => {
      checkedSettings.set(action, checkSettings(settingsOf(action)));
    });

  program
    .command("init")
    .description("check the connection and create the store's indexes or constraints where the backend has them")
    .action((_o, cmd) =>
      emit(cmd, async (g) => {
        await g.initialize();
        const s = settingsOf(cmd);
        return { ok: true, store: storeKind(s), namespace: s.namespace };
      }),
    );
  program
    .command("version")
    .description("print the installed version")
    .action(() => writeOut(`${dumps({ selfgraph: version })}\n`));
  program
    .command("mcp")
    .description("run the MCP server over stdio; it honours the global options listed below")
    .configureHelp({ showGlobalOptions: true })
    .action((_o, cmd) => runStdio(connectSettings(cmd)));
  const schema = program
    .command("schema")
    .summary("print the active schema, or import or export a Neo4j graph schema")
    .description(
      "schema: print the active schema (--schema FILE), or null\n" +
        "schema import [--from neo4j] FILE: convert a Neo4j graph schema\n" +
        "schema export [--to neo4j|ossie]: print the active schema as a Neo4j graph schema or an Apache Ossie ontology",
    )
    .action((_o, cmd) =>
      emit(cmd, async (g) => {
        if (g.schema === null) process.stderr.write(`note: ${NO_SCHEMA}\n`);
        return g.schema;
      }),
    );
  schema
    .command("import <path>")
    .description("convert a Neo4j graph schema JSON file, or '-' for stdin, and print it")
    .addOption(
      new Option("--from <format>", "the source format")
        .choices(["neo4j"])
        .argParser(choiceArg("--from", ["neo4j"]))
        .default("neo4j"),
    )
    .action((path, _o, cmd) =>
      emit(cmd, async () => {
        const data = readJson(path);
        if (
          isPlainObject(data) &&
          ("entities" in data || "relations" in data) &&
          !NEO4J_KEYS.some((key) => key in data)
        ) {
          throw new ValidationError(
            `${pyRepr(path)} looks like a SelfGraph schema, not a Neo4j one; pass it as --schema instead`,
          );
        }
        return fromNeo4jOntology(data);
      }),
    );
  schema
    .command("export")
    .description("print the active schema (--schema) as a Neo4j graph schema or Ossie ontology")
    .addOption(
      new Option("--to <format>", "the target format")
        .choices(["neo4j", "ossie"])
        .argParser(choiceArg("--to", ["neo4j", "ossie"]))
        .default("neo4j"),
    )
    .action((o, cmd) =>
      emit(cmd, async (g) => {
        if (g.schema === null)
          throw new ValidationError(`no schema to export; ${NO_SCHEMA}`, { code: "schema_required" });
        return o.to === "ossie" ? toOssie(g.schema) : toNeo4jOntology(g.schema);
      }),
    );
  program
    .command("readiness")
    .description("check the store is reachable and the namespace holds data, with counts and lint")
    .action((_o, cmd) => emit(cmd, (g) => g.readiness()));
  program
    .command("check-answerable <question...>")
    .description("judge whether the graph holds what a question asks about; words join into one")
    .option("--term <phrase>", "a key phrase to check instead of the question's words (repeatable)", collect, [])
    .option("--as-of <iso>", `judge the graph as of this time (${ISO})`, timeArg("as_of"))
    .option("--known-at <iso>", `judge only what the graph held at this time (${ISO})`, timeArg("known_at"))
    .option("--depth <n>", "most hops between matched entities", intArg("--depth"), 3)
    .action((words, o, cmd) =>
      emit(cmd, (g) =>
        g.checkAnswerable(words.join(" "), {
          terms: o.term.length ? o.term : null,
          as_of: o.asOf,
          known_at: o.knownAt,
          depth: o.depth,
        }),
      ),
    );
  program
    .command("export")
    .description("export the graph")
    .command("obsidian <directory>")
    .description("write the namespace as an Obsidian vault of Markdown notes into DIRECTORY")
    .action((directory, _o, cmd) =>
      emit(cmd, async (g) => {
        const notes = await g.exportObsidian();
        try {
          for (const [path, text] of Object.entries(notes)) {
            const target = join(directory, path);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, text, "utf8");
          }
        } catch (exc) {
          const kind =
            {
              EEXIST: "file exists",
              ENOTDIR: "not a directory",
              EACCES: "permission denied",
              EPERM: "permission denied",
              ENOENT: "no such directory",
            }[(exc as NodeJS.ErrnoException).code ?? ""] ?? (exc as Error).message;
          throw new ValidationError(`cannot write the vault to ${pyRepr(directory)}: ${kind}`, {
            field: "directory",
          });
        }
        return { directory: normalize(directory).replace(/(.)\/+$/, "$1"), notes: Object.keys(notes).length };
      }),
    );
  maintenanceCommands(program);
  program
    .command("query <cypher>")
    .description("run one raw Cypher statement; it can write and is not scoped to the namespace")
    .addHelpText("after", QUERY_EXAMPLES)
    .option("--param <KEY=VALUE>", `query parameter (repeatable)${JSON_VALUE}`, collect, [])
    .action((cypher, o, cmd) => emit(cmd, (g) => checkedCypher(g, cypher, bindParams(cypher, kv(o.param, "--param")))));
  program
    .command("diff")
    .description("list stored changes by known time, in (since, until]")
    .requiredOption("--since <iso>", "exclusive known-time lower bound (ISO 8601)", timeArg("since"))
    .option("--until <iso>", "inclusive known-time upper bound (ISO 8601; default now)", timeArg("until"))
    .option("--json", "print structured changes instead of a summary")
    .action((o, cmd) =>
      emit(cmd, async (g) => {
        const result = await g.diff(o.since, o.until);
        if (o.json) return result;
        const lines = [`Changes (${toIso(result.since)}, ${toIso(result.until)}]`];
        lines.push(...result.limitations.map((limitation) => `Note: ${limitation}`));
        for (const e of result.entities_created) lines.push(`+ entity ${e.id}`);
        for (const [mark, relations] of [
          ["+", result.relations_added],
          ["~", result.relations_revised],
        ] as const) {
          for (const r of relations)
            lines.push(
              `${mark} relation ${r.id} revision ${r.revision}: ${r.from_entity} -[${r.type}]-> ${r.to_entity}`,
            );
        }
        for (const r of result.relations_retired)
          lines.push(
            `- relation ${r.id}: ${r.from_entity} -[${r.type}]-> ${r.to_entity} invalidated_by=${r.invalidated_by ?? "None"}`,
          );
        for (const [action, relations] of [
          ["certified", result.relations_certified],
          ["uncertified", result.relations_uncertified],
        ] as const) {
          for (const r of relations) lines.push(`* ${action} relation ${r.id} revision ${r.revision}`);
        }
        for (const [mark, preferences] of [
          ["+", result.preferences_added],
          ["~", result.preferences_revised],
        ] as const) {
          for (const p of preferences)
            lines.push(
              `${mark} preference ${p.id} revision ${p.revision}: ${p.subject_entity} ${p.key} -> ${p.value_entity}`,
            );
        }
        for (const [mark, decisions] of [
          ["+", result.decisions_created],
          ["~", result.decisions_updated],
        ] as const) {
          for (const d of decisions) lines.push(`${mark} decision ${d.id}: ${d.title}`);
        }
        for (const m of result.entities_merged) lines.push(`+ merge ${m.id}: ${m.absorbed_id} into ${m.survivor_id}`);
        for (const m of result.entities_unmerged)
          lines.push(`- merge ${m.id}: ${m.absorbed_id} out of ${m.survivor_id}`);
        for (const v of result.source_versions_added) lines.push(`+ source ${v.source_id} version ${v.id}`);
        lines.push(
          `${result.entities_created.length} entities created, ${result.relations_added.length} relations added, ` +
            `${result.relations_revised.length} revised, ${result.relations_retired.length} retired, ` +
            `${result.relations_certified.length} certified, ${result.relations_uncertified.length} uncertified, ` +
            `${result.preferences_added.length} preferences added, ${result.preferences_revised.length} revised, ` +
            `${result.decisions_created.length} decisions created, ${result.decisions_updated.length} updated, ` +
            `${result.entities_merged.length} merges, ${result.entities_unmerged.length} unmerges, ` +
            `${result.source_versions_added.length} source versions added`,
        );
        return new Text(lines.join("\n"));
      }),
    );
  program
    .command("retrieve <query...>")
    .description("retrieve graph context for a query; unquoted words join into one query")
    .addOption(
      new Option("--strategy <s>", "traversal order, or ppr for PageRank ranking")
        .choices(STRATEGIES)
        .argParser(choiceArg("--strategy", STRATEGIES)),
    )
    .addOption(
      new Option("--seeds <tier>", "seeding tier (default: the level's)")
        .choices(SEED_TIERS)
        .argParser(choiceArg("--seeds", SEED_TIERS)),
    )
    .option("--depth <n>", "traversal hops", intArg("--depth"), RETRIEVE_DEFAULTS.depth)
    .option("--k <n>", "seed count", intArg("--k"), RETRIEVE_DEFAULTS.k)
    .option("--max-nodes <n>", "entity cap", intArg("--max-nodes"), RETRIEVE_DEFAULTS.max_nodes)
    .option("--budget-tokens <n>", "context budget", intArg("--budget-tokens"), RETRIEVE_DEFAULTS.budget_tokens)
    .option("--as-of <iso>", `read the graph as of this time (${ISO})`, timeArg("as_of"))
    .option("--known-at <iso>", `read only what the graph held at this time (${ISO})`, timeArg("known_at"))
    .option("--skip-hubs", "do not walk through entities with 50 or more relations")
    .option("--context-only", "print only the context text, not the JSON result")
    .action((words, o, cmd) =>
      emit(cmd, async (g) => {
        const result = await g.retrieve(words.join(" "), {
          strategy: o.strategy,
          depth: o.depth,
          k: o.k,
          max_nodes: o.maxNodes,
          budget_tokens: o.budgetTokens,
          as_of: o.asOf,
          known_at: o.knownAt,
          seeds: o.seeds,
          skip_hubs: o.skipHubs === true,
        });
        return o.contextOnly ? new Text(result.context) : result;
      }),
    );

  const insert = program.command("insert").description("insert text or facts");
  insert
    .command("text <text>")
    .description("extract facts from text (LLM if configured, else regex); text '-' reads stdin")
    .option("--source-id <id>")
    .option("--event-time <iso>", `when the text's facts became true (${ISO})`, timeArg("event_time"))
    .option(
      "--metadata <JSON|KEY=VALUE>",
      `source metadata: a JSON object, or KEY=VALUE pairs (repeatable)${JSON_VALUE}`,
      collect,
      [],
    )
    .option("--replace-source", "the text replaces --source-id's earlier versions: retire relations only they stated")
    .addOption(callResolver())
    .addOption(contradictionOption())
    .action((text, o, cmd) =>
      emit(cmd, (g) =>
        g.insert
          .text(text === "-" ? readText("-") : text, {
            source_id: o.sourceId,
            event_time: o.eventTime,
            metadata: metadataOf(o.metadata),
            resolver: (o.resolver as ResolverMode | undefined) ?? null,
            contradiction: o.contradiction as ContradictionMode | undefined,
            replace_source: o.replaceSource === true,
          })
          .then(inserted),
      ),
    );
  insert
    .command("facts")
    .description("insert ready facts (JSON file or '-' for stdin)")
    .argument("<path>", "the facts JSON file, or '-' to read it from stdin")
    .option("--source-id <id>")
    .option(
      "--event-time <iso>",
      `default event time for relations, preferences, and decisions without their own (${ISO})`,
      timeArg("event_time"),
    )
    .addOption(callResolver())
    .addOption(contradictionOption())
    .action((path, o, cmd) =>
      emit(cmd, (g) =>
        g.insert
          .facts(readJson(path) as Extraction, {
            source_id: o.sourceId,
            event_time: o.eventTime,
            resolver: (o.resolver as ResolverMode | undefined) ?? null,
            contradiction: o.contradiction as ContradictionMode | undefined,
          })
          .then(inserted),
      ),
    );

  entityCommands(program);
  relationCommands(program);
  preferenceCommands(program);
  decisionCommands(program);
  return program;
}

/**
 * Format an error for stderr: the code and message, the command, the field at fault, the hint, and both links.
 *
 * @param exc (SelfGraphError): the error.
 * @param command (string): the command that failed, such as "selfgraph relation certify".
 * @return (string): the lines.
 */
function errorText(exc: SelfGraphError, command: string): string {
  return [
    `error[${exc.code}]: ${surfaceHint(exc.message).trimEnd()}`,
    `command: ${command}`,
    ...(exc.field === undefined ? [] : [`field: ${exc.field}`]),
    `hint: ${exc.hint}`,
    `docs: ${exc.docs}`,
    `agent guide: ${exc.agentGuide}`,
  ].join("\n");
}

/**
 * Print a library diagnostic on stderr, with a warning code's hint the first time the code appears.
 *
 * @return ((message: string) => void): the logger.
 */
function stderrLogger(): (message: string) => void {
  const hinted = new Set<string>();
  return (message) => {
    const code = message.split(": ")[0]!;
    const hint = hinted.has(code) || WARNING_HINTS[code] === undefined ? "" : `\nhint: ${WARNING_HINTS[code]}`;
    hinted.add(code);
    process.stderr.write(`selfgraph: ${surfaceHint(message)}${hint}\n`);
  };
}

/**
 * Make a command and its subcommands throw instead of exiting, and record the subcommand path as it is dispatched.
 *
 * @param cmd (Command<unknown[], OptionValues, OptionValues>): the command.
 * @param words (string[]): the command path, such as ["selfgraph", "relation", "certify"], extended in place.
 */
function prepare(cmd: Command<unknown[], OptionValues, OptionValues>, words: string[]): void {
  cmd.exitOverride();
  cmd.showHelpAfterError(cmd.helpInformation().split("\n")[0]);
  cmd.hook("preSubcommand", (_cmd, sub) => {
    words.push(sub.name());
  });
  for (const sub of cmd.commands) prepare(sub, words);
}

/**
 * Run the CLI.
 *
 * @param argv (string[]): the arguments, without the node binary and script path.
 * @return (number): the process exit code.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const program = buildParser();
  const words = ["selfgraph"];
  prepare(program, words);
  const previous = setLogger(stderrLogger());
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (exc) {
    if (exc instanceof CommanderError) {
      return exc.code === "commander.helpDisplayed" || exc.code === "commander.version" || exc.exitCode === 0 ? 0 : 2;
    }
    if (exc instanceof SelfGraphError) {
      process.stderr.write(`${errorText(exc, words.join(" "))}\n`);
      return exitCodeFor(exc);
    }
    if ((exc as NodeJS.ErrnoException).code === "EPIPE") return 141;
    const settings = lastSettings ?? settingsFromEnv();
    const coded = internalError(exc, settings.uri, settings.llm_base_url);
    process.stderr.write(`${errorText(coded, words.join(" "))}\n`);
    return 1;
  } finally {
    setLogger(previous);
  }
}

/**
 * The exit code a SelfGraph error gives, decided by its code rather than its class.
 *
 * @param exc (SelfGraphError): the error that ended the command.
 * @return (number): 2 for invalid input or settings, 1 for a runtime failure.
 */
export function exitCodeFor(exc: SelfGraphError): number {
  return USAGE_CODES.has(exc.code) ? 2 : 1;
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
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(141);
    throw err;
  });
  main().then((code) => process.stdout.write("", () => process.exit(code)));
}

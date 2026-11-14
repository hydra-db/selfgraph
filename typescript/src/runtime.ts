import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import type { SelfGraph } from "./client.js";
import { NotFoundError, STORE_KUZU_HINT, StoreError, settingHint, surfaceHint, ValidationError } from "./errors.js";
import { checkPrompts } from "./extraction/prompts.js";
import { casefold } from "./internal/casefold.js";
import { log } from "./internal/log.js";
import { comparePy, PY_WORD_CLASS, PY_WS_CLASS, pyRepr, pySplit, pyStrip } from "./internal/py.js";
import { EDGE_TYPES, LABELS, PREFERENCE_EDGE_TYPES } from "./labels.js";
import { checkLlmConfig } from "./llm/index.js";
import { scanEntities, scanRelations } from "./maintenance.js";
import {
  asInput,
  type CypherResult,
  ExtractionInstructions,
  ExtractionPrompts,
  type InsertResult,
  type JsonValue,
  LLM_DEFAULTS,
  type LLMConfig,
  type PruneResult,
  type Relation,
  requireMatchingPrefix,
} from "./models.js";
import { invalidatedNote } from "./ops.js";
import type { GraphStore } from "./protocols.js";
import { requireResolver } from "./resolution.js";
import {
  asSchema,
  type ParsedSchema,
  requireContradictionMode,
  requireSchemaForMode,
  requireSchemaMode,
  type Schema,
} from "./schema.js";
import { parseAuth } from "./stores/bolt.js";
import { CypherStore, Neo4jStore } from "./stores/cypher.js";
import { FalkorDBStore } from "./stores/falkordb.js";
import { HydraDBStore } from "./stores/hydradb.js";
import { KuzuStore } from "./stores/kuzu.js";
import { requireLevel } from "./tiers.js";
import { checkOptions, requireNamespace } from "./validate.js";

export { version } from "../package.json";
export { parseTime } from "./validate.js";

export interface GraphSettings {
  store: string | null;
  uri: string | null;
  auth: string | readonly [string, string] | null;
  database: string | null;
  namespace: string;
  llm_provider: string | null;
  llm_model: string | null;
  llm_api_key: string | null;
  llm_base_url: string | null;
  llm_timeout: number | string | null;
  llm_concurrency: number | string | null;
  schema: string | Schema | ParsedSchema | null;
  instructions: string | ExtractionInstructions | null;
  prompts: string | ExtractionPrompts | null;
  schema_mode: string | null;
  resolver: string | null;
  contradiction: string | null;
  level: string | null;
  max_tier: string | null;
}

export const DEFAULT_SETTINGS: Readonly<GraphSettings> = Object.freeze({
  store: null,
  uri: null,
  auth: null,
  database: null,
  namespace: "default",
  llm_provider: null,
  llm_model: null,
  llm_api_key: null,
  llm_base_url: null,
  llm_timeout: null,
  llm_concurrency: null,
  schema: null,
  instructions: null,
  prompts: null,
  schema_mode: null,
  resolver: null,
  contradiction: null,
  level: null,
  max_tier: null,
});

const IGNORED_BY_STORE: Record<string, ReadonlyArray<"auth" | "database">> = { kuzu: ["auth", "database"] };
const FALKOR_SCHEMES = ["redis", "rediss", "falkor", "falkors"];
const FALKOR_ADDRESS = "host:port or a redis://, rediss://, falkor://, or falkors:// URL";
const PARAM_REF = new RegExp(`\\$([${PY_WORD_CLASS}]+)`, "gu");
const LINE_TERMINATORS = new Set(["\n", "\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]);
export const BLANK = "\x00";

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

/**
 * Fetch the current version of a relation, failing with who retired it when a contradiction did.
 *
 * @param graph (SelfGraph): the graph.
 * @param id (string): the relation id.
 * @param hint (string): how to read a retired relation on this surface, appended to the error.
 * @return (Relation | null): the current version, or null when the id has no version.
 */
export async function currentRelation(graph: SelfGraph, id: string, hint: string): Promise<Relation | null> {
  const rel = await graph.relations.get(id);
  if (rel !== null) return rel;
  let latest: Relation;
  try {
    [latest] = (await graph.relations.versions(id)) as [Relation];
  } catch (exc) {
    if (exc instanceof NotFoundError) return null;
    throw exc;
  }
  if (latest.invalidated_at === null) return null;
  throw new NotFoundError("Relation", id, `${invalidatedNote(latest)}; ${hint}`);
}

/**
 * Reword an insert result's warnings, or a prune result's note, for the CLI and MCP server, which take settings from flags or the environment.
 *
 * @param result (InsertResult | PruneResult): the insert or prune result.
 * @return (InsertResult | PruneResult): the same result.
 */
export function surfaced<T extends InsertResult | PruneResult>(result: T): T {
  if ("warnings" in result) {
    for (const warning of result.warnings) warning.message = surfaceHint(warning.message);
  } else if (result.note !== null) {
    result.note = surfaceHint(result.note);
  }
  return result;
}

/**
 * Read GraphSettings from SELFGRAPH_* environment variables; overrides win when set.
 *
 * @param overrides (Partial<GraphSettings>): field values that take precedence over the environment.
 * @param env (Record<string, string | undefined>): the environment to read, defaulting to process.env.
 * @return (GraphSettings): the resolved settings.
 */
export function settingsFromEnv(
  overrides: Partial<GraphSettings> = {},
  env: Record<string, string | undefined> = process.env,
): GraphSettings {
  checkOptions("settingsFromEnv", overrides, SETTING_KEYS);
  const out: GraphSettings = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS as Array<keyof GraphSettings>) {
    const value = overrides[key] ?? env[`SELFGRAPH_${key.toUpperCase()}`];
    if (value != null) Object.assign(out, { [key]: value });
  }
  return out;
}

/**
 * Parse JSON text, naming where it came from in the error.
 *
 * @param text (string): the JSON text.
 * @param where (string): appended to "invalid JSON" in the error, e.g. " in 'graph.json'".
 * @return (unknown): the parsed value.
 */
export function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (exc) {
    throw new ValidationError(`invalid JSON${where}: ${(exc as Error).message}`);
  }
}

/**
 * Read a UTF-8 text file, or stdin when the path is "-".
 *
 * @param path (string): the file path, or "-".
 * @return (string): the text.
 */
export function readText(path: string): string {
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch (exc) {
    throw new ValidationError(`cannot read ${pyRepr(path)}: ${(exc as Error).message}`);
  }
}

/**
 * Read and parse a JSON file, or stdin when the path is "-".
 *
 * @param path (string): the file path, or "-".
 * @return (unknown): the parsed JSON.
 */
export function readJson(path: string): unknown {
  return parseJson(readText(path), ` in ${pyRepr(path)}`);
}

/**
 * Read a JSON setting such as the schema: inline JSON when it starts with "{", else a file path ("-" for stdin).
 *
 * @param value (string | T | null): the inline JSON or the path, or an already parsed value, returned as is.
 * @param what (string): the setting name, for the error on bad inline JSON.
 * @return (T | null): the parsed value.
 */
function jsonSetting<T>(value: string | T | null, what: string): T | null {
  if (typeof value !== "string") return value;
  return (value.trimStart().startsWith("{") ? parseJson(value, ` in the inline ${what}`) : readJson(value)) as T;
}

/**
 * Blank string literals, backtick identifiers, and comments with a scan that matches engine lexing, leaving an unterminated token's tail visible so a hidden write keyword still scans (fail closed).
 *
 * @param query (string): the raw Cypher statement.
 * @return (string): the query with lexical tokens replaced.
 */
export function blankLexicalTokens(query: string): string {
  const out: string[] = [];
  const n = query.length;
  let i = 0;
  while (i < n) {
    const ch = query[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (query[j] === "\\") {
          j += 2;
          continue;
        }
        if (query[j] === ch) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) break;
      out.push(BLANK);
      i = j;
    } else if (ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (query[j] === "`") {
          if (j + 1 < n && query[j + 1] === "`") {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) break;
      out.push(BLANK);
      i = j;
    } else if (ch === "/" && i + 1 < n && query[i + 1] === "*") {
      const end = query.indexOf("*/", i + 2);
      if (end === -1) break;
      out.push(BLANK);
      i = end + 2;
    } else if (ch === "/" && i + 1 < n && query[i + 1] === "/") {
      let j = i + 2;
      while (j < n && !LINE_TERMINATORS.has(query[j]!)) j += 1;
      out.push(BLANK);
      i = j;
    } else {
      out.push(ch);
      i += 1;
    }
  }
  if (i < n) out.push(query.slice(i));
  return out.join("");
}

const W = `[${PY_WORD_CLASS}]`;
const S = `[${PY_WS_CLASS}]`;
const NAME = `(?:\`[^\`]+\`|${W}+)`;
const PATTERN_NAMES = new RegExp(
  `([(\\[])${S}*(?:[A-Za-z_]${W}*)?${S}*((?::${S}*${NAME}${S}*(?:\\|${S}*:?${S}*${NAME}${S}*)*)+)`,
  "gu",
);
const NAME_PART = new RegExp(`\`([^\`]+)\`|(${W}+)`, "gu");
const NAME_LITERAL = new RegExp(
  `(?:\\.${S}*name${S}*=|(?<!${W})name${S}*:)${S}*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`,
  "gu",
);
const LISTED_NAMES = 20;

/**
 * Read the node labels, relationship types, and entity name literals a Cypher query matches on.
 *
 * Labels come from node patterns, (n:Label), types from relationship patterns, [r:TYPE|OTHER], and names from n.name = 'x' or {name: 'x'}. This is a lexical read for advice, not a parse.
 *
 * @param query (string): the Cypher query.
 * @return ([string[], string[], string[]]): the distinct labels, relationship types, and names, in order.
 */
export function cypherNames(query: string): [string[], string[], string[]] {
  const labels = new Set<string>();
  const types = new Set<string>();
  for (const [, opener, names] of query.matchAll(PATTERN_NAMES)) {
    for (const [, quoted, bare] of names!.matchAll(NAME_PART)) (opener === "(" ? labels : types).add(quoted || bare!);
  }
  const literals = new Set<string>();
  for (const [, single, double] of query.matchAll(NAME_LITERAL)) literals.add(single ?? double ?? "");
  return [[...labels], [...types], [...literals]];
}

/**
 * Collapse whitespace and casefold, so a literal matches a stored name that differs only in case or spacing.
 *
 * @param text (string): the text.
 * @return (string): the squashed text.
 */
const squash = (text: string): string => casefold(pySplit(text).join(" "));

/**
 * Explain likely mistakes in a Cypher query that found nothing; see checkedCypher.
 *
 * @param graph (SelfGraph): the open graph.
 * @param query (string): the Cypher query.
 * @return (string[]): one note per suspect label, relationship type, or name literal.
 */
async function cypherNotes(graph: SelfGraph, query: string): Promise<string[]> {
  const [labels, types, literals] = cypherNames(query);
  if (!(labels.length || types.length || literals.length)) return [];
  const ns = graph.namespace;
  const entities = await scanEntities(graph.store, ns);
  const relations = await scanRelations(graph.store, ns);
  const physical = new Set([
    ...LABELS,
    ...EDGE_TYPES,
    ...PREFERENCE_EDGE_TYPES,
    ...((graph.store as { queryLabels?: readonly string[] }).queryLabels ?? []),
  ]);
  const notes: string[] = [];
  const kinds: Array<[string, string[], string[]]> = [
    ["label", labels, [...new Set(entities.map((e) => e.type))].sort(comparePy)],
    ["relationship type", types, [...new Set(relations.map((r) => r.type))].sort(comparePy)],
  ];
  for (const [kind, used, stored] of kinds) {
    const listed = stored.slice(0, LISTED_NAMES).join(", ") || "none";
    for (const name of used) {
      if (!physical.has(name) && !stored.includes(name)) {
        notes.push(`${kind} ${pyRepr(name)} is not stored in namespace ${pyRepr(ns)}; stored: ${listed}`);
      }
    }
  }
  const names = new Set(entities.map((e) => e.name));
  const squashed = new Map<string, string>();
  for (const name of [...names].sort(comparePy)) if (!squashed.has(squash(name))) squashed.set(squash(name), name);
  for (const literal of literals) {
    const near = squashed.get(squash(literal));
    if (!names.has(literal) && near !== undefined) {
      notes.push(`no entity in namespace ${pyRepr(ns)} is named ${pyRepr(literal)}, but one is named ${pyRepr(near)}`);
    }
  }
  return notes;
}

/**
 * Run a Cypher query and, when it returns no rows or fails, explain likely mistakes.
 *
 * A note names each label or relationship type the namespace never stored (internal ones and the store's own physical names count as stored) and each name literal no entity has exactly while one differs only by letter case or spacing. Notes go in the result's warnings, or are appended to the StoreError of a failed query. The checks read every entity and relation, so they run only then.
 *
 * @param graph (SelfGraph): the open graph.
 * @param query (string): the Cypher query.
 * @param params (Record<string, JsonValue> | null | undefined): the query parameters.
 * @return (CypherResult): the result, with warnings when it is empty.
 */
export async function checkedCypher(
  graph: SelfGraph,
  query: string,
  params?: Record<string, JsonValue> | null,
): Promise<CypherResult> {
  let result: CypherResult;
  try {
    result = await graph.runCypher(query, params);
  } catch (exc) {
    if (!(exc instanceof StoreError)) throw exc;
    const notes = await cypherNotes(graph, query);
    if (notes.length) throw new StoreError(`${exc.message}; ${notes.join("; ")}`, { cause: exc });
    throw exc;
  }
  if (!result.rows.length) result.warnings = await cypherNotes(graph, query);
  return result;
}

/**
 * Check a raw query's $name parameters are all supplied and drop the supplied ones it never references; references inside string literals, backtick identifiers, and comments are ignored.
 *
 * @param query (string): the raw Cypher statement.
 * @param params (Record<string, T> | null | undefined): the supplied parameters.
 * @return (Record<string, T>): the supplied parameters the query references.
 */
export function bindParams<T>(query: string, params: Record<string, T> | null | undefined): Record<string, T> {
  const given = params ?? {};
  const referenced = [...new Set(Array.from(blankLexicalTokens(query).matchAll(PARAM_REF), (m) => m[1]!))];
  const missing = referenced.filter((name) => !Object.hasOwn(given, name));
  if (missing.length) {
    const noun = missing.length === 1 ? "parameter" : "parameters";
    throw new ValidationError(`missing ${noun} ${missing.map((name) => `$${name}`).join(", ")}`);
  }
  return Object.fromEntries(Object.entries(given).filter(([key]) => referenced.includes(key)));
}

const boltOptions = (settings: GraphSettings) => ({ auth: settings.auth, database: settings.database });

/**
 * Parse a FalkorDB address: host:port, or a redis://, rediss://, falkor://, or falkors:// URL.
 *
 * @param uri (string): the address.
 * @return ({ url: URL; tls: boolean }): the parsed URL and whether it asks for TLS (rediss:// or falkors://).
 */
function falkorAddress(uri: string): { url: URL; tls: boolean } {
  const scheme = uri.includes("://") ? uri.slice(0, uri.indexOf("://")).toLowerCase() : "";
  if (scheme && !FALKOR_SCHEMES.includes(scheme)) {
    throw new ValidationError(
      `invalid FalkorDB address ${pyRepr(uri)}: the 'falkordb' store expects ${FALKOR_ADDRESS}`,
    );
  }
  let url: URL | null;
  try {
    url = new URL(scheme ? `redis${uri.slice(scheme.length)}` : `redis://${uri}`);
  } catch {
    url = null;
  }
  if (url === null || url.port === "0") {
    throw new ValidationError(
      `invalid FalkorDB address ${pyRepr(uri)}: expected host:port with a port from 1 to 65535`,
    );
  }
  return { url, tls: scheme === "rediss" || scheme === "falkors" };
}

/**
 * A FalkorDB store from "host:port" or a redis:// style URL; auth, else the URL credentials, logs in.
 *
 * @param uri (string): the address.
 * @param settings (GraphSettings): the resolved auth and database settings.
 * @return (GraphStore): the store.
 */
function falkorStore(uri: string, settings: GraphSettings): GraphStore {
  const { url, tls } = falkorAddress(uri);
  const host = url.hostname.replace(/^\[|\]$/g, "") || "localhost";
  const [username, password] = parseAuth(settings.auth, "") ?? [
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
  ];
  return new FalkorDBStore(host, url.port ? Number(url.port) : 6379, {
    graph: settings.database || "selfgraph",
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(tls ? { socket: { tls: true } } : {}),
  });
}

const SERVER_STORES: Record<string, { address: string; build: (uri: string, settings: GraphSettings) => GraphStore }> =
  {
    neo4j: { address: "a Bolt URI", build: (uri, s) => new Neo4jStore(uri, boltOptions(s)) },
    cypher: { address: "a Bolt URI", build: (uri, s) => new CypherStore(uri, boltOptions(s)) },
    memgraph: { address: "a Bolt URI", build: (uri, s) => new CypherStore(uri, boltOptions(s)) },
    hydradb: { address: "a Bolt URI", build: (uri, s) => new HydraDBStore(uri, boltOptions(s)) },
    falkordb: { address: FALKOR_ADDRESS, build: falkorStore },
  };

export const STORES: readonly string[] = [...Object.keys(SERVER_STORES), "kuzu"];

/**
 * The store name the settings resolve to: the named store, else hydradb with a URI, else kuzu.
 *
 * @param settings (GraphSettings): the resolved store configuration.
 * @return (string): the lowercase store name.
 */
export function storeKind(settings: GraphSettings): string {
  return (settings.store || (settings.uri ? "hydradb" : "kuzu")).toLowerCase();
}

/**
 * The connection settings that are set but ignored by the store the settings resolve to.
 *
 * @param settings (GraphSettings): the resolved store configuration.
 * @return (string[]): the ignored setting names, such as "database" for kuzu.
 */
export function ignoredSettings(settings: GraphSettings): Array<"auth" | "database"> {
  return (IGNORED_BY_STORE[storeKind(settings)] ?? []).filter((key) => settings[key]);
}

/**
 * Require a server store's address: present, not a Kuzu path, and for FalkorDB a host:port or redis:// style URL.
 *
 * @param kind (string): the resolved server store name.
 * @param uri (string | null): the configured URI.
 */
function requireStoreUri(kind: string, uri: string | null): void {
  if (!uri) {
    throw new ValidationError(
      `the ${pyRepr(kind)} store needs ${SERVER_STORES[kind]!.address}; pass ${settingHint("uri")}`,
    );
  }
  if (!uri.includes("://") && (uri.endsWith(".kuzu") || uri.includes("/") || uri.includes(sep))) {
    throw new ValidationError(
      `${pyRepr(uri)} is not a URI for the ${pyRepr(kind)} store; this looks like a Kuzu path; ${STORE_KUZU_HINT}`,
    );
  }
  if (kind === "falkordb") falkorAddress(uri);
}

/**
 * Construct the store the settings name without connecting; unnamed, a URI means HydraDB and no URI an embedded Kuzu file under ~/.selfgraph.
 *
 * @param settings (GraphSettings): the resolved store configuration.
 * @return (GraphStore): the store.
 */
export function buildStore(settings: GraphSettings): GraphStore {
  const kind = storeKind(settings);
  for (const key of ignoredSettings(settings)) log(`${key} is ignored by store ${kind}`);
  if (kind === "kuzu") {
    return new KuzuStore(settings.uri || join(homedir(), ".selfgraph", "default.kuzu"));
  }
  const server = SERVER_STORES[kind];
  if (server === undefined) throw unknownStore(settings);
  requireStoreUri(kind, settings.uri);
  return server.build(settings.uri!, settings);
}

/**
 * Parse the LLM timeout setting: seconds as a positive number, default 120.
 *
 * @param value (number | string | null): the setting, or null for the default.
 * @return (number): the timeout in seconds.
 */
export function llmTimeout(value: number | string | null): number {
  if (value === null || value === "") return LLM_DEFAULTS.timeout;
  const seconds = typeof value === "number" ? value : pyStrip(value) ? Number(pyStrip(value)) : Number.NaN;
  if (!(seconds > 0) || !Number.isFinite(seconds)) {
    throw new ValidationError(`llm_timeout must be a positive number of seconds, got ${pyRepr(value)}`);
  }
  return seconds;
}

/**
 * Parse the LLM concurrency setting: how many chunks extract at once, a positive integer, default 4.
 *
 * @param value (number | string | null): the setting, or null for the default.
 * @return (number): the number of chunks.
 */
export function llmConcurrency(value: number | string | null): number {
  if (value === null || value === "") return LLM_DEFAULTS.concurrency;
  const text = typeof value === "string" ? pyStrip(value) : value;
  const n = typeof text === "string" && /^\+?\d+$/.test(text) ? Number(text) : text;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
    throw new ValidationError(`llm_concurrency must be a positive integer, got ${pyRepr(value)}`);
  }
  return n;
}

/**
 * The LLM configuration the settings name, or null when none is set.
 *
 * @param settings (GraphSettings): the resolved LLM configuration.
 * @return (LLMConfig | null): the LLM configuration.
 */
export function buildLlm(settings: GraphSettings): LLMConfig | null {
  if (!settings.llm_provider && !settings.llm_model) return null;
  const provider =
    settings.llm_provider || (settings.llm_model?.includes("/") ? settings.llm_model.split("/")[0] : null);
  if (!settings.llm_model) {
    throw new ValidationError(`an LLM needs a model; pass ${settingHint("llm_model")}, e.g. gpt-4o-mini`);
  }
  if (!provider) {
    throw new ValidationError(
      `an LLM needs a provider; pass ${settingHint("llm_provider")}, or a provider-prefixed ` +
        "model such as openai/gpt-4o-mini",
    );
  }
  requireMatchingPrefix(provider, settings.llm_model, settings.llm_base_url);
  return {
    provider,
    model: settings.llm_model,
    api_key: settings.llm_api_key,
    base_url: settings.llm_base_url,
    timeout: llmTimeout(settings.llm_timeout),
    concurrency: llmConcurrency(settings.llm_concurrency),
  };
}

const unknownStore = (settings: GraphSettings) =>
  new ValidationError(`unknown store ${pyRepr(settings.store)}; choose one of ${STORES.join(", ")}`);

/**
 * Validate every setting without a store or LLM call, so a bad one fails before any command runs. The schema, instructions, and prompts are read (inline JSON, a file, or "-" for stdin) and validated here, prompt placeholders included, so the returned settings carry them parsed and nothing reads them twice.
 *
 * @param settings (GraphSettings): the resolved settings.
 * @return (GraphSettings): the settings with the schema, instructions, and prompts parsed.
 */
export function checkSettings(settings: GraphSettings): GraphSettings {
  requireNamespace(settings.namespace ?? DEFAULT_SETTINGS.namespace);
  if (settings.uri != null && !pyStrip(settings.uri)) {
    throw new ValidationError(`uri cannot be empty; omit ${settingHint("uri")} to use the default store`);
  }
  const kind = storeKind(settings);
  if (!STORES.includes(kind)) throw unknownStore(settings);
  if (kind !== "kuzu") requireStoreUri(kind, settings.uri);
  requireSchemaMode(settings.schema_mode || "warn");
  requireLevel("level", settings.level || "balanced");
  requireLevel("max_tier", settings.max_tier || "max");
  if (settings.contradiction != null) requireContradictionMode(settings.contradiction);
  if (settings.resolver != null) requireResolver(settings.resolver);
  llmTimeout(settings.llm_timeout);
  llmConcurrency(settings.llm_concurrency);
  const llm = buildLlm(settings);
  if (llm !== null) checkLlmConfig(llm);
  const schema = asSchema(jsonSetting<Schema | ParsedSchema>(settings.schema, "schema"));
  requireSchemaForMode(settings.schema_mode, schema);
  const instructions = asInput(
    ExtractionInstructions,
    jsonSetting(settings.instructions, "instructions"),
    "instructions",
  );
  const prompts = asInput(ExtractionPrompts, jsonSetting(settings.prompts, "prompts"), "prompts");
  checkPrompts(prompts);
  return { ...settings, schema, instructions, prompts };
}

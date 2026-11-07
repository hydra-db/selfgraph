import { z } from "zod";

import { SelfGraph } from "./client.js";
import { errorMessage, SelfGraphError, ValidationError } from "./errors.js";
import { Lazy } from "./internal/lazy.js";
import { loadOptional } from "./internal/optional.js";
import { PY_WORD_CLASS, PY_WS_CLASS } from "./internal/py.js";
import { DEFAULT_KIND, DEFAULT_STATUS, type Kind, type Status } from "./models.js";
import { toJsonable } from "./output.js";
import { DEFAULT_PAGE_LIMIT } from "./resources/common.js";
import { RETRIEVE_DEFAULTS } from "./retrieval.js";
import { type GraphSettings, settingsFromEnv, version } from "./runtime.js";

const WB_START = `(?<![${PY_WORD_CLASS}])`;
const WB_END = `(?![${PY_WORD_CLASS}])`;
const WRITE_CLAUSE = new RegExp(
  `${WB_START}(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|ALTER|RENAME|TRUNCATE|FOREACH|COPY|LOAD|IMPORT|EXPORT|` +
    `INSTALL|UNINSTALL|ATTACH|USE|CALL|COMMENT|BEGIN|COMMIT|ROLLBACK|CHECKPOINT|GRANT|REVOKE|DENY)${WB_END}`,
  "iu",
);
const ALIAS = new RegExp(`${WB_START}AS[${PY_WS_CLASS}]+[${PY_WORD_CLASS}]+`, "giu");
const MAP_KEY = new RegExp(`([{,][${PY_WS_CLASS}]*)[A-Za-z_][${PY_WORD_CLASS}]*([${PY_WS_CLASS}]*:)`, "gu");
const PROP_OR_LABEL = new RegExp(`[.:][${PY_WS_CLASS}]*[${PY_WORD_CLASS}]+`, "gu");
const PARAM = new RegExp(`\\$[${PY_WORD_CLASS}]+`, "gu");
const READ_OPENERS = new RegExp(`^(MATCH|OPTIONAL|WITH|UNWIND|RETURN|SHOW|EXPLAIN|PROFILE)${WB_END}`, "iu");
const LEADING_BLANK = new RegExp(`^[${PY_WS_CLASS}\\x00]+`, "u");
const LINE_TERMINATORS = new Set(["\n", "\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]);
const BLANK = "\x00";

/**
 * Blank string literals, backtick identifiers, and comments with a scan that matches engine lexing, leaving an unterminated token's tail visible so a hidden write keyword still scans (fail closed).
 *
 * @param query (string): the raw Cypher statement.
 * @return (string): the query with lexical tokens replaced.
 */
function blankLexicalTokens(query: string): string {
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

function stripSafeTokens(query: string): string {
  return blankLexicalTokens(query)
    .replace(PARAM, BLANK)
    .replace(ALIAS, " ")
    .replace(MAP_KEY, "$1$2")
    .replace(PROP_OR_LABEL, " ");
}

/**
 * Report whether run_cypher must reject a query: a write clause appears anywhere, or the first significant token is not a known read opener.
 *
 * @param query (string): the raw Cypher statement.
 * @return (boolean): true when the query must be rejected.
 */
export function isBlockedQuery(query: string): boolean {
  const stripped = stripSafeTokens(query);
  if (WRITE_CLAUSE.test(stripped)) return true;
  const head = stripped.replace(LEADING_BLANK, "");
  return head.length > 0 && !READ_OPENERS.test(head);
}

type Shape = Record<string, z.ZodType>;

export interface Tool {
  name: string;
  description: string;
  input: Shape;
  run(graph: SelfGraph, args: Record<string, unknown>): Promise<unknown>;
}

interface ToolSpec<S extends Shape> {
  name: string;
  description: string;
  input: S;
  run(graph: SelfGraph, args: z.output<z.ZodObject<S>>): Promise<unknown>;
}

const str = z.string();
const optStr = z.string().nullish();
const optObj = z.record(z.string(), z.any()).nullish();
const optList = z.array(z.string()).nullish();
const limit = z.number().int().default(DEFAULT_PAGE_LIMIT);
const cursor = z.string().nullish();
const newestFirst = z.boolean().default(true);

const tool = <S extends Shape>(spec: ToolSpec<S>): Tool => ({
  ...spec,
  run: (graph, args) => spec.run(graph, args as z.output<z.ZodObject<S>>),
});

/**
 * Pick the named arguments that were given and are not null, so only those reach the SDK call.
 *
 * @param args (A): the tool arguments.
 * @param keys (readonly K[]): the argument names to pick.
 * @return ({ [P in K]?: NonNullable<A[P]> }): the given arguments.
 */
function present<A extends Record<string, unknown>, K extends keyof A & string>(
  args: A,
  keys: readonly K[],
): { [P in K]?: NonNullable<A[P]> } {
  return Object.fromEntries(keys.filter((k) => args[k] != null).map((k) => [k, args[k]])) as {
    [P in K]?: NonNullable<A[P]>;
  };
}

const READ_ONLY_MESSAGE =
  "run_cypher is read-only: it runs a single read that begins with MATCH, OPTIONAL MATCH, WITH, " +
  "UNWIND, RETURN, SHOW, EXPLAIN, or PROFILE and contains no write, schema, transaction, or I/O " +
  "clause (CREATE, MERGE, SET, DELETE, DETACH, REMOVE, DROP, ALTER, RENAME, TRUNCATE, FOREACH, CALL, " +
  "LOAD, COPY, IMPORT, EXPORT, INSTALL, UNINSTALL, ATTACH, USE, COMMENT, GRANT, REVOKE, DENY, and " +
  "transaction or admin commands such as BEGIN, COMMIT, TERMINATE). Use the typed resources or insert " +
  "for writes.";

export const TOOLS: Tool[] = [
  tool({
    name: "insert_text",
    description:
      "Extract an ontology from text and merge it into the graph. Needs an LLM. Idempotent: ids are derived " +
      "deterministically from content, so re-inserting the same text converges on the same graph instead of " +
      "duplicating it. Safe to retry.",
    input: { text: str, source_id: optStr },
    run: (g, a) => g.insert.text(a.text, { source_id: a.source_id }),
  }),
  tool({
    name: "insert_ontology",
    description:
      "Merge a ready ontology (entities/relations/preferences/decisions) in one call. Every write is an " +
      "idempotent upsert keyed by deterministic id, so re-sending the same ontology never duplicates data. " +
      "Entity ids are 'type:name' (e.g. 'person:jane'); omit an id to have it derived. Prefer this over the " +
      "create_* tools for bulk writes and for anything you may retry. References are validated before any " +
      "write; the batch is atomic on transactional backends (Neo4j, Memgraph), while auto-commit backends " +
      "(HydraDB, Kuzu, FalkorDB) apply writes incrementally, so a mid-batch failure can leave earlier writes " +
      "in place. Re-running the same ontology reconciles it.",
    input: { ontology: z.record(z.string(), z.any()), source_id: optStr },
    run: (g, a) => g.insert.ontology(a.ontology, { source_id: a.source_id }),
  }),
  tool({
    name: "create_entity",
    description:
      "Create an entity (node). Ids are deterministic 'type:name' (e.g. 'person:jane'); omit id to derive one " +
      "from type and name. This is a strict create and conflicts if the id already exists; use insert_ontology " +
      "to upsert idempotently instead.",
    input: { name: str, type: str, id: optStr, aliases: optList, external_ids: optObj, properties: optObj },
    run: (g, a) =>
      g.entities.create(a.name, a.type, {
        id: a.id,
        aliases: a.aliases,
        external_ids: a.external_ids,
        properties: a.properties,
      }),
  }),
  tool({
    name: "get_entity",
    description: "Fetch one entity by id, or null if it does not exist.",
    input: { id: str },
    run: (g, a) => g.entities.get(a.id),
  }),
  tool({
    name: "list_entities",
    description: "List entities, optionally filtered by type and/or name. Paged via next_cursor.",
    input: { type: optStr, name: optStr, limit, cursor },
    run: (g, a) => g.entities.list({ type: a.type, name: a.name, limit: a.limit, cursor: a.cursor }),
  }),
  tool({
    name: "update_entity",
    description:
      "Update an entity. aliases/properties/external_ids merge in; remove_aliases/remove_properties drop keys.",
    input: {
      id: str,
      name: optStr,
      type: optStr,
      aliases: optList,
      external_ids: optObj,
      properties: optObj,
      remove_aliases: optList,
      remove_properties: optList,
    },
    run: (g, a) =>
      g.entities.update(
        a.id,
        present(a, ["name", "type", "aliases", "external_ids", "properties", "remove_aliases", "remove_properties"]),
      ),
  }),
  tool({
    name: "delete_entity",
    description: "Delete an entity, its relations, and any decision trace that references it.",
    input: { id: str },
    run: (g, a) => g.entities.delete(a.id),
  }),
  tool({
    name: "create_relation",
    description:
      "Create a directed, versioned relationship between two entities. from_entity and to_entity are existing " +
      "entity ids ('type:name'); create the entities first. The type normalizes to UPPER_SNAKE, so 'works at' " +
      "and 'WORKS_AT' are the same relation.",
    input: { from_entity: str, type: str, to_entity: str, id: optStr, properties: optObj },
    run: (g, a) => g.relations.create(a.from_entity, a.type, a.to_entity, { id: a.id, properties: a.properties }),
  }),
  tool({
    name: "get_relation",
    description: "Fetch the current version of a relationship by id, or null.",
    input: { id: str },
    run: (g, a) => g.relations.get(a.id),
  }),
  tool({
    name: "list_relations",
    description: "List current relationships, optionally filtered by endpoints and/or type.",
    input: { from_entity: optStr, type: optStr, to_entity: optStr, limit, cursor },
    run: (g, a) =>
      g.relations.list({
        from_entity: a.from_entity,
        type: a.type,
        to_entity: a.to_entity,
        limit: a.limit,
        cursor: a.cursor,
      }),
  }),
  tool({
    name: "update_relation",
    description: "Create a new version of a relationship with changed properties.",
    input: { id: str, set_properties: optObj, remove_properties: optList },
    run: (g, a) =>
      g.relations.update(a.id, { set_properties: a.set_properties, remove_properties: a.remove_properties ?? [] }),
  }),
  tool({
    name: "relation_versions",
    description: "Return every version of a relationship, newest first by default.",
    input: { id: str, newest_first: newestFirst },
    run: (g, a) => g.relations.versions(a.id, { newest_first: a.newest_first }),
  }),
  tool({
    name: "delete_relation",
    description: "Delete a relationship, all of its versions, and any decision trace that uses it as a step.",
    input: { id: str },
    run: (g, a) => g.relations.delete(a.id),
  }),
  tool({
    name: "create_preference",
    description:
      "Record that an entity prefers or avoids a value (kind: preference|disinterest). Omit id to derive one; " +
      "a manual id must start with 'preference:'.",
    input: {
      subject_entity: str,
      key: str,
      value_entity: str,
      kind: z.string().default(DEFAULT_KIND),
      id: optStr,
      about_entity: optStr,
      strength: z.number().nullish(),
      properties: optObj,
    },
    run: (g, a) =>
      g.preferences.create(a.subject_entity, a.key, a.value_entity, {
        id: a.id,
        kind: a.kind as Kind,
        about_entity: a.about_entity,
        strength: a.strength,
        properties: a.properties,
      }),
  }),
  tool({
    name: "list_preferences",
    description: "List current preferences, optionally scoped to one subject entity. Paged via next_cursor.",
    input: { subject_entity: optStr, key: optStr, kind: optStr, limit, cursor },
    run: (g, a) =>
      g.preferences.list(a.subject_entity ?? null, {
        key: a.key,
        kind: a.kind as Kind,
        limit: a.limit,
        cursor: a.cursor,
      }),
  }),
  tool({
    name: "preference_versions",
    description: "Return every version of a preference, newest first by default.",
    input: { id: str, newest_first: newestFirst },
    run: (g, a) => g.preferences.versions(a.id, { newest_first: a.newest_first }),
  }),
  tool({
    name: "update_preference",
    description: "Update a preference (new version). properties merge in; remove_properties drop keys.",
    input: { id: str, strength: z.number().nullish(), properties: optObj, remove_properties: optList },
    run: (g, a) =>
      g.preferences.update(a.id, {
        strength: a.strength,
        properties: a.properties,
        remove_properties: a.remove_properties ?? [],
      }),
  }),
  tool({
    name: "get_preference",
    description: "Fetch the current version of a preference by id, or null.",
    input: { id: str },
    run: (g, a) => g.preferences.get(a.id),
  }),
  tool({
    name: "delete_preference",
    description: "Delete a preference and all of its versions.",
    input: { id: str },
    run: (g, a) => g.preferences.delete(a.id),
  }),
  tool({
    name: "create_decision",
    description:
      "Record a decision trace. steps are ids of relations that already exist (relation:..., from " +
      "create_relation or list_relations), in order; they are the path that led to the outcome.",
    input: {
      title: str,
      steps: z.array(z.string()),
      id: optStr,
      actor_entity: optStr,
      summary: optStr,
      rationale: optStr,
      outcome_entity: optStr,
      alternative_entities: optList,
      status: z.string().default(DEFAULT_STATUS),
    },
    run: (g, a) =>
      g.decisions.create(a.title, {
        steps: a.steps,
        id: a.id,
        actor_entity: a.actor_entity,
        summary: a.summary,
        rationale: a.rationale,
        outcome_entity: a.outcome_entity,
        alternative_entities: a.alternative_entities ?? [],
        status: a.status as Status,
      }),
  }),
  tool({
    name: "update_decision",
    description: "Update fields of a decision trace, creating a new version.",
    input: {
      id: str,
      title: optStr,
      steps: optList,
      actor_entity: optStr,
      summary: optStr,
      rationale: optStr,
      outcome_entity: optStr,
      alternative_entities: optList,
      status: optStr,
    },
    run: (g, a) =>
      g.decisions.update(a.id, {
        ...present(a, [
          "title",
          "steps",
          "actor_entity",
          "summary",
          "rationale",
          "outcome_entity",
          "alternative_entities",
        ]),
        ...(a.status != null && { status: a.status as Status }),
      }),
  }),
  tool({
    name: "delete_decision",
    description: "Delete a decision trace and its steps.",
    input: { id: str },
    run: (g, a) => g.decisions.delete(a.id),
  }),
  tool({
    name: "get_decision",
    description: "Fetch one decision trace by id, or null.",
    input: { id: str },
    run: (g, a) => g.decisions.get(a.id),
  }),
  tool({
    name: "list_decisions",
    description: "List decision traces, optionally filtered by actor and/or status.",
    input: { actor_entity: optStr, status: optStr, limit, cursor },
    run: (g, a) =>
      g.decisions.list({ actor_entity: a.actor_entity, status: a.status as Status, limit: a.limit, cursor: a.cursor }),
  }),
  tool({
    name: "run_cypher",
    description:
      "Run a read Cypher statement and return its rows; a keyword scan rejects writes but is a guard, not a sandbox.",
    input: { query: str, params: optObj },
    run: async (g, a) => {
      if (isBlockedQuery(a.query)) throw new ValidationError(READ_ONLY_MESSAGE);
      return g.runCypher(a.query, a.params ?? null);
    },
  }),
  tool({
    name: "retrieve",
    description:
      'Retrieve graph context for a query by keyword seeds and bounded BFS, DFS, or PageRank ("ppr") ranking.',
    input: {
      query: str,
      strategy: z.string().default(RETRIEVE_DEFAULTS.strategy),
      depth: z.number().int().default(RETRIEVE_DEFAULTS.depth),
      k: z.number().int().default(RETRIEVE_DEFAULTS.k),
      max_nodes: z.number().int().default(RETRIEVE_DEFAULTS.max_nodes),
      budget_tokens: z.number().int().default(RETRIEVE_DEFAULTS.budget_tokens),
    },
    run: (g, a) =>
      g.retrieve(a.query, {
        strategy: a.strategy,
        depth: a.depth,
        k: a.k,
        max_nodes: a.max_nodes,
        budget_tokens: a.budget_tokens,
      }),
  }),
];

let settings: GraphSettings | null = null;
const graph = new Lazy(async () => {
  if (settings === null) settings = settingsFromEnv();
  const g = SelfGraph.connect(settings);
  await g.initialize();
  return g;
});

/**
 * Set the backend for the tools and drop any cached graph.
 *
 * @param value (GraphSettings | null): the backend settings, or null to read the environment.
 */
export function configure(value: GraphSettings | null = null): void {
  settings = value ?? settingsFromEnv();
  graph.reset();
}

/**
 * Run a tool, turning an error into a structured {error, error_type} result flagged as an MCP error.
 *
 * @param t (Tool): the tool.
 * @param args (Record<string, unknown>): the validated arguments.
 * @return ({ result: unknown; isError: boolean }): the JSON-ready result, and whether it is an error.
 */
export async function callTool(t: Tool, args: Record<string, unknown>): Promise<{ result: unknown; isError: boolean }> {
  try {
    return { result: toJsonable(await t.run(await graph.get(), args)), isError: false };
  } catch (exc) {
    if (exc instanceof SelfGraphError) return { result: { error: exc.message, error_type: exc.name }, isError: true };
    const name = exc instanceof Error ? exc.name : "Error";
    return { result: { error: `${name}: ${errorMessage(exc)}`, error_type: "InternalError" }, isError: true };
  }
}

interface McpServerLike {
  registerTool(
    name: string,
    config: { description: string; inputSchema: Shape },
    cb: (args: Record<string, unknown>) => Promise<unknown>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create an MCP server with every tool registered, requiring @modelcontextprotocol/sdk.
 *
 * @param name (string): the server name.
 * @return (McpServerLike): the server.
 */
export async function buildServer(name = "selfgraph"): Promise<McpServerLike> {
  const { McpServer } = await loadOptional<{
    McpServer: new (info: { name: string; version: string }) => McpServerLike;
  }>(
    "@modelcontextprotocol/sdk/server/mcp.js",
    "the MCP server needs '@modelcontextprotocol/sdk'; npm install @modelcontextprotocol/sdk",
    SelfGraphError,
  );
  const server = new McpServer({ name, version });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args) => {
      const { result, isError } = await callTool(t, args);
      const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
      const structured = result !== null && typeof result === "object" && !Array.isArray(result) ? result : { result };
      return { content, structuredContent: structured, isError };
    });
  }
  return server;
}

/**
 * Configure the backend and serve the tools over stdio until the client disconnects.
 *
 * @param value (GraphSettings | null): the backend settings, or null to read the environment.
 */
export async function runStdio(value: GraphSettings | null = null): Promise<void> {
  configure(value);
  const server = await buildServer();
  const { StdioServerTransport } = await loadOptional<{ StdioServerTransport: new () => unknown }>(
    "@modelcontextprotocol/sdk/server/stdio.js",
    "the MCP server needs '@modelcontextprotocol/sdk'",
    SelfGraphError,
  );
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => process.stdin.once("close", resolve));
  await graph.release((g) => g.close().catch(() => undefined));
}

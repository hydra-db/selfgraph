import { z } from "zod";

import { SelfGraph } from "./client.js";
import { errorMessage, SelfGraphError, surfaceHint, ValidationError } from "./errors.js";
import { toOssie } from "./export.js";
import { Lazy } from "./internal/lazy.js";
import { loadOptional } from "./internal/optional.js";
import { PY_WORD_CLASS, PY_WS_CLASS, pyRepr } from "./internal/py.js";
import {
  DEFAULT_STANCE,
  DEFAULT_STATUS,
  type EvidenceInput,
  type ExtractionInstructions,
  type ExtractionPrompts,
  Stance,
  Status,
  validationMessage,
} from "./models.js";
import { toNeo4jOntology } from "./neo4jSchema.js";
import { DECISION_CLEARABLE, PREFERENCE_CLEARABLE, requireChanges } from "./ops.js";
import { toJsonable } from "./output.js";
import { RESOLVER_MODES } from "./resolution.js";
import { DEFAULT_PAGE_LIMIT } from "./resources/common.js";
import { RETRIEVE_DEFAULTS, type Strategy } from "./retrieval.js";
import {
  BLANK,
  bindParams,
  blankLexicalTokens,
  checkedCypher,
  checkSettings,
  currentRelation,
  type GraphSettings,
  settingsFromEnv,
  surfaced,
  version,
} from "./runtime.js";
import { CONTRADICTION_MODES, SCHEMA_MODES, type Schema } from "./schema.js";
import type { SeedTier } from "./tiers.js";
import { checkOptions, parseTime } from "./validate.js";

const WB_START = `(?<![${PY_WORD_CLASS}])`;
const WB_END = `(?![${PY_WORD_CLASS}])`;
const WRITE_CLAUSE = new RegExp(
  `${WB_START}(CREATE|INSERT|MERGE|DELETE|DETACH|SET|REMOVE|DROP|ALTER|RENAME|TRUNCATE|FOREACH|COPY|LOAD|IMPORT|` +
    `EXPORT|INSTALL|UNINSTALL|ATTACH|USE|CALL|COMMENT|BEGIN|COMMIT|ROLLBACK|CHECKPOINT|GRANT|REVOKE|DENY|` +
    `TERMINATE)${WB_END}`,
  "iu",
);
const UNICODE_ESCAPE = /(?<!\\)(?:\\\\)*\\[uU]/u;
const MAP_KEY = new RegExp(`([{,][${PY_WS_CLASS}]*)[A-Za-z_][${PY_WORD_CLASS}]*([${PY_WS_CLASS}]*:)`, "gu");
const PROP_OR_LABEL = new RegExp(`[.:][${PY_WS_CLASS}]*[${PY_WORD_CLASS}]+`, "gu");
const PARAM = new RegExp(`\\$[${PY_WORD_CLASS}]+`, "gu");
const READ_OPENERS = new RegExp(`^(MATCH|OPTIONAL|WITH|UNWIND|RETURN|SHOW|EXPLAIN|PROFILE)${WB_END}`, "iu");
const LEADING_BLANK = new RegExp(`^[${PY_WS_CLASS}\\x00]+`, "u");

/**
 * Report whether run_cypher must reject a query: a unicode escape appears anywhere (Neo4j decodes them before lexing), a backslash or write clause appears outside literals, or a ';'-separated statement does not begin with a known read opener.
 *
 * @param query (string): the raw Cypher statement.
 * @return (boolean): true when the query must be rejected.
 */
export function isBlockedQuery(query: string): boolean {
  if (UNICODE_ESCAPE.test(query)) return true;
  const stripped = blankLexicalTokens(query).replace(PARAM, BLANK).replace(MAP_KEY, "$1$2").replace(PROP_OR_LABEL, " ");
  if (stripped.includes("\\") || WRITE_CLAUSE.test(stripped)) return true;
  return stripped.split(";").some((statement) => {
    const head = statement.replace(LEADING_BLANK, "");
    return head.length > 0 && !READ_OPENERS.test(head);
  });
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
const resolver = z.enum(RESOLVER_MODES).nullish();
const newestFirst = z.boolean().default(true);
const contradiction = z.enum(CONTRADICTION_MODES).nullish();
const schemaMode = z.enum(SCHEMA_MODES).nullish();
const evidence = z.array(z.record(z.string(), z.any())).nullish();
const SCHEMA_ARGS =
  " schema (a SelfGraph schema object) and schema_mode (off, warn, strict) override the server's for this call.";
const EVIDENCE_ARG =
  " evidence lists records {source_id, chunk_id?, quote?, start_offset?, end_offset?, confidence?} supporting it.";

/**
 * Parse an optional ISO 8601 tool parameter with the shared parser, passing null and undefined through.
 *
 * @param value (string | null | undefined): the text.
 * @param field (string): the parameter name, for the error.
 * @return (Date | null | undefined): the time.
 */
function time<T extends null | undefined>(value: string | T, field: string): Date | T {
  return typeof value === "string" ? parseTime(value, field) : value;
}

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
  "clause (CREATE, INSERT, MERGE, SET, DELETE, DETACH, REMOVE, DROP, ALTER, RENAME, TRUNCATE, FOREACH, " +
  "CALL, LOAD, COPY, IMPORT, EXPORT, INSTALL, UNINSTALL, ATTACH, USE, COMMENT, GRANT, REVOKE, DENY, and " +
  "transaction or admin commands such as BEGIN, COMMIT, TERMINATE), even as a bare alias or variable " +
  "name (backtick-quote it), and no unicode escape (pass such text as a parameter). Use the typed " +
  "resources or insert for writes.";

export const INSTRUCTIONS =
  "SelfGraph is a knowledge graph built from text. To answer from it: call check_readiness once to confirm the " +
  "graph is reachable and holds data; call check_answerable with the question and its key terms; if the verdict " +
  "is not_answerable, say the graph does not hold the answer instead of guessing, and if it is partial, say " +
  "which terms are missing; then call retrieve and answer only from the facts and passages it returns. Treat " +
  "context lines marked (via hub) as weak links, and prefer facts marked [certified].";

export const TOOLS: Tool[] = [
  tool({
    name: "check_readiness",
    description:
      "Check the graph can answer before relying on it: whether the store is reachable and the namespace holds " +
      "entities, the counts of entities, relations, preferences, decisions, and sources, and lint (orphan entities, " +
      "relations with no evidence, decisions with a retired step, types the schema does not declare).",
    input: {},
    run: (g) => g.readiness(),
  }),
  tool({
    name: "check_answerable",
    description:
      "Check whether the graph holds what a question asks about before retrieving or answering. terms are the key " +
      "phrases of the question (names, types, attributes); pass them when you can, else they are read from the " +
      "question. Each term is matched to entities, types, definitions, relation types, or property keys; a schema term " +
      "with nothing stored for it is schema_only and counts as missing. verdict is answerable, partial (missing lists " +
      "what the graph lacks), uncertain (matched entities are not connected within depth hops, or only through a hub), " +
      "or not_answerable. A note means the check is lexical and embedding seeds may still find the missing terms, so " +
      "try retrieve before concluding. as_of (ISO 8601) judges the graph as it stood then.",
    input: {
      question: str,
      terms: z.array(z.string()).nullish(),
      as_of: optStr,
      depth: z.number().int().min(1).default(3),
    },
    run: (g, a) =>
      g.checkAnswerable(a.question, { terms: a.terms ?? null, as_of: time(a.as_of, "as_of"), depth: a.depth }),
  }),
  tool({
    name: "get_schema",
    description:
      "Return the schema inserts are checked against (entity and relation types), or null when none is set. " +
      'format "neo4j" renders it as a Neo4j graph schema (node_types, relationship_types, patterns, constraints); ' +
      '"ossie" as an Apache Ossie ontology (concepts and relationships).',
    input: { format: z.enum(["selfgraph", "neo4j", "ossie"]).default("selfgraph") },
    run: async (g, a) => {
      if (g.schema === null || a.format === "selfgraph") return g.schema;
      return a.format === "neo4j" ? toNeo4jOntology(g.schema) : toOssie(g.schema);
    },
  }),
  tool({
    name: "insert_text",
    description:
      "Extract facts from text and merge them into the graph. Uses the configured LLM, or with none " +
      "configured falls back to a built-in LLM-free extractor (coarser). event_time (ISO 8601) is the default " +
      "valid time for what is extracted; metadata is stored on the source. Idempotent: ids are derived " +
      "deterministically from content, so re-inserting the same text converges on the same graph instead of " +
      "duplicating it. Safe to retry. resolver (exact, default, fuzzy, or llm) overrides the server's entity " +
      "resolution for this call. contradiction (off, warn, supersede, llm) overrides how a relation that breaks " +
      "a schema max_count is handled." +
      SCHEMA_ARGS +
      " instructions and prompts override the extraction instructions and prompt templates for this call." +
      " replace_source (needs source_id) treats the text as the new content of that source: relations only its" +
      " older versions stated are retired, and source_diff lists the kept, added, and retired relation ids.",
    input: {
      text: str,
      source_id: optStr,
      event_time: optStr,
      metadata: optObj,
      resolver,
      contradiction,
      schema: optObj,
      schema_mode: schemaMode,
      instructions: optObj,
      prompts: optObj,
      replace_source: z.boolean().default(false),
    },
    run: async (g, a) =>
      surfaced(
        await g.insert.text(a.text, {
          replace_source: a.replace_source,
          source_id: a.source_id,
          event_time: time(a.event_time, "event_time"),
          metadata: a.metadata,
          resolver: a.resolver,
          contradiction: a.contradiction,
          schema: a.schema as Schema | null | undefined,
          schema_mode: a.schema_mode,
          instructions: a.instructions as ExtractionInstructions | null | undefined,
          prompts: a.prompts as ExtractionPrompts | null | undefined,
        }),
      ),
  }),
  tool({
    name: "insert_facts",
    description:
      "Merge ready facts (entities/relations/preferences/decisions) in one call. Every write is an " +
      "idempotent upsert keyed by deterministic id, so re-sending the same facts never duplicates data. " +
      "Entity ids are 'type:name' (e.g. 'person:jane'); omit an id to have it derived. Prefer this over the " +
      "create_* tools for bulk writes and for anything you may retry. References are validated before any " +
      "write; the batch is atomic on transactional backends (Neo4j, Memgraph), while auto-commit backends " +
      "(HydraDB, Kuzu, FalkorDB) apply writes incrementally, so a mid-batch failure can leave earlier writes " +
      "in place. Re-sending the same facts reconciles the graph. event_time (ISO 8601) is the default valid time for " +
      "relations, preferences, and decisions that carry none of their own. resolver (exact, default, fuzzy, or llm) overrides the " +
      "server's entity resolution for this call; each merge is in the result's merges. contradiction (off, " +
      "warn, supersede, llm) overrides how a relation that breaks a schema max_count is handled: warn keeps both " +
      "and reports it, supersede retires the older relation." +
      SCHEMA_ARGS,
    input: {
      facts: z.record(z.string(), z.any()),
      source_id: optStr,
      event_time: optStr,
      resolver,
      contradiction,
      schema: optObj,
      schema_mode: schemaMode,
    },
    run: async (g, a) =>
      surfaced(
        await g.insert.facts(a.facts, {
          source_id: a.source_id,
          event_time: time(a.event_time, "event_time"),
          resolver: a.resolver,
          contradiction: a.contradiction,
          schema: a.schema as Schema | null | undefined,
          schema_mode: a.schema_mode,
        }),
      ),
  }),
  tool({
    name: "create_entity",
    description:
      "Create an entity (node). Ids are deterministic 'type:name' (e.g. 'person:jane'); omit id to derive one " +
      "from type and name. This is a strict create and conflicts if the id already exists; use insert_facts " +
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
    description:
      "List entities, optionally filtered by type and/or name (an exact, case-sensitive match on the current " +
      "name). Paged via next_cursor.",
    input: { type: optStr, name: optStr, limit, cursor },
    run: (g, a) => g.entities.list({ type: a.type, name: a.name, limit: a.limit, cursor: a.cursor }),
  }),
  tool({
    name: "entity_evidence",
    description:
      "List the evidence (source, version, chunk, quote, offsets, confidence) supporting an entity. Paged via " +
      "next_cursor.",
    input: { id: str, limit, cursor },
    run: (g, a) => g.entities.evidence(a.id, { limit: a.limit, cursor: a.cursor }),
  }),
  tool({
    name: "entity_merges",
    description:
      "List the merge records of entities that entity resolution folded into this entity: the absorbed input, " +
      "reason, confidence, added aliases, and rewritten references. Paged via next_cursor.",
    input: { id: str, limit, cursor },
    run: (g, a) => g.entities.merges(a.id, { limit: a.limit, cursor: a.cursor }),
  }),
  tool({
    name: "unmerge_entity",
    description:
      "Reverse one merge by merge id: recreate the absorbed entity, drop the aliases it added to the survivor, " +
      "and move its relations, preferences, and decisions back.",
    input: { merge_id: str },
    run: (g, a) => g.entities.unmerge(a.merge_id),
  }),
  tool({
    name: "update_entity",
    description:
      "Update an entity. aliases/properties/external_ids merge in; remove_aliases/remove_properties drop keys. " +
      "type can change only its case or spacing (the type is part of the id).",
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
      "and 'WORKS_AT' are the same relation. event_time (ISO 8601) is when the fact became true. Creating a " +
      "relation a contradiction invalidated reasserts it. contradiction (off, warn, supersede, llm) overrides how a " +
      "schema max_count conflict is handled." +
      EVIDENCE_ARG,
    input: {
      from_entity: str,
      type: str,
      to_entity: str,
      id: optStr,
      properties: optObj,
      event_time: optStr,
      contradiction,
      evidence,
    },
    run: (g, a) =>
      g.relations.create(a.from_entity, a.type, a.to_entity, {
        id: a.id,
        properties: a.properties,
        event_time: time(a.event_time, "event_time"),
        contradiction: a.contradiction,
        evidence: (a.evidence ?? []) as EvidenceInput[],
      }),
  }),
  tool({
    name: "get_relation",
    description:
      "Fetch the current version of a relationship by id, or null for an unknown id. A relationship a " +
      "contradiction retired fails with the relation that retired it; read it with relation_versions.",
    input: { id: str },
    run: (g, a) => currentRelation(g, a.id, "use relation_versions or list_relations with include_invalidated"),
  }),
  tool({
    name: "list_relations",
    description:
      "List current relationships, optionally filtered by endpoints and/or type. include_invalidated also lists " +
      "relationships a contradiction retired, with invalidated_at and invalidated_by set.",
    input: {
      from_entity: optStr,
      type: optStr,
      to_entity: optStr,
      limit,
      cursor,
      include_invalidated: z.boolean().default(false),
    },
    run: (g, a) =>
      g.relations.list({
        from_entity: a.from_entity,
        type: a.type,
        to_entity: a.to_entity,
        limit: a.limit,
        cursor: a.cursor,
        include_invalidated: a.include_invalidated,
      }),
  }),
  tool({
    name: "update_relation",
    description:
      "Create a new version of a relationship with changed properties; remove_properties ignores keys that are " +
      "absent. event_time (ISO 8601) is when the new version became true; omit it to keep the current one." +
      EVIDENCE_ARG.replace(" supporting it", " to add; existing evidence is kept"),
    input: { id: str, set_properties: optObj, remove_properties: optList, event_time: optStr, evidence },
    run: (g, a) =>
      g.relations.update(
        a.id,
        requireChanges({
          ...present(a, ["set_properties", "remove_properties"]),
          evidence: (a.evidence ?? undefined) as EvidenceInput[] | undefined,
          event_time: time(a.event_time ?? undefined, "event_time"),
        }),
      ),
  }),
  tool({
    name: "relation_versions",
    description: "Return every version of a relationship, newest first by default.",
    input: { id: str, newest_first: newestFirst },
    run: (g, a) => g.relations.versions(a.id, { newest_first: a.newest_first }),
  }),
  tool({
    name: "relation_evidence",
    description:
      "List the evidence (source, version, chunk, quote, offsets, confidence) supporting a relationship across " +
      "all its versions. Paged via next_cursor.",
    input: { id: str, limit, cursor },
    run: (g, a) => g.relations.evidence(a.id, { limit: a.limit, cursor: a.cursor }),
  }),
  tool({
    name: "certify_relation",
    description:
      "Mark a current relation as verified by someone (by). A certified relation is not retired by a supersede " +
      "contradiction or a replaced source, and retrieval lists it first, marked [certified].",
    input: { id: str, by: str },
    run: (g, a) => g.relations.certify(a.id, { by: a.by }),
  }),
  tool({
    name: "uncertify_relation",
    description: "Remove the certification of a relation.",
    input: { id: str },
    run: (g, a) => g.relations.uncertify(a.id),
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
      "Record that an entity prefers or avoids a value (stance: preference|disinterest). Omit id to derive one; " +
      "a manual id must start with 'preference:'. event_time (ISO 8601) is when the preference became true.",
    input: {
      subject_entity: str,
      key: str,
      value_entity: str,
      stance: Stance.default(DEFAULT_STANCE),
      id: optStr,
      about_entity: optStr,
      strength: z.number().nullish(),
      properties: optObj,
      event_time: optStr,
    },
    run: (g, a) =>
      g.preferences.create(a.subject_entity, a.key, a.value_entity, {
        id: a.id,
        stance: a.stance,
        about_entity: a.about_entity,
        strength: a.strength,
        properties: a.properties,
        event_time: time(a.event_time, "event_time"),
      }),
  }),
  tool({
    name: "list_preferences",
    description: "List current preferences, optionally scoped to one subject entity. Paged via next_cursor.",
    input: { subject_entity: optStr, key: optStr, stance: Stance.nullish(), limit, cursor },
    run: (g, a) =>
      g.preferences.list(a.subject_entity ?? null, {
        key: a.key,
        stance: a.stance,
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
    description:
      "Update a preference (new version). properties merge in; remove_properties drop keys. event_time " +
      "(ISO 8601) is when the new version became true; omit it to keep the current one. clear lists fields to " +
      "clear: strength, about_entity, event_time.",
    input: {
      id: str,
      strength: z.number().nullish(),
      properties: optObj,
      remove_properties: optList,
      event_time: optStr,
      clear: z.array(z.enum(PREFERENCE_CLEARABLE)).nullish(),
    },
    run: (g, a) =>
      g.preferences.update(
        a.id,
        requireChanges({
          ...present(a, ["strength", "properties", "remove_properties"]),
          ...(a.clear?.length && { clear: a.clear }),
          event_time: time(a.event_time ?? undefined, "event_time"),
        }),
      ),
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
      "Record a decision trace. steps (optional, default empty) are ids of relations that already exist (relation:..., " +
      "from create_relation or list_relations), in order; they are the path that led to the outcome. event_time " +
      "(ISO 8601) is when the decision was made.",
    input: {
      title: str,
      steps: z.array(z.string()).default([]),
      id: optStr,
      actor_entity: optStr,
      summary: optStr,
      rationale: optStr,
      outcome_entity: optStr,
      alternative_entities: optList,
      status: Status.default(DEFAULT_STATUS),
      event_time: optStr,
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
        status: a.status,
        event_time: time(a.event_time, "event_time"),
      }),
  }),
  tool({
    name: "update_decision",
    description:
      "Update fields of a decision trace in place; it keeps no version history. An omitted field keeps its " +
      "value; an explicit null clears actor_entity, summary, rationale, outcome_entity, or event_time (ISO 8601), " +
      "and steps [] empties the steps. clear lists fields to clear the same way, alternative_entities and steps " +
      "to [].",
    input: {
      id: str,
      title: optStr,
      steps: optList,
      actor_entity: optStr,
      summary: optStr,
      rationale: optStr,
      outcome_entity: optStr,
      alternative_entities: optList,
      status: Status.nullish(),
      event_time: optStr,
      clear: z.array(z.enum(DECISION_CLEARABLE)).nullish(),
    },
    run: (g, a) =>
      g.decisions.update(
        a.id,
        requireChanges({
          ...present(a, ["title", "steps", "alternative_entities"]),
          ...(a.clear?.length && { clear: a.clear }),
          ...Object.fromEntries(
            (["actor_entity", "summary", "rationale", "outcome_entity"] as const)
              .filter((k) => a[k] !== undefined)
              .map((k) => [k, a[k]]),
          ),
          ...(a.event_time !== undefined && { event_time: time(a.event_time, "event_time") }),
          ...(a.status != null && { status: a.status }),
        }),
      ),
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
    input: { actor_entity: optStr, status: Status.nullish(), limit, cursor },
    run: (g, a) =>
      g.decisions.list({ actor_entity: a.actor_entity, status: a.status, limit: a.limit, cursor: a.cursor }),
  }),
  tool({
    name: "run_cypher",
    description:
      "Run a read Cypher statement and return its rows; a keyword scan rejects writes but is a guard, not a sandbox. " +
      "Not scoped to the namespace: it sees every namespace on the server, so filter on the ns property yourself. " +
      "When no rows come back, warnings name labels and relationship types the namespace never stored and name " +
      "literals that differ from a stored entity name only by case or spacing.",
    input: { query: str, params: optObj },
    run: async (g, a) => {
      if (isBlockedQuery(a.query)) throw new ValidationError(READ_ONLY_MESSAGE);
      return checkedCypher(g, a.query, bindParams(a.query, a.params));
    },
  }),
  tool({
    name: "retrieve",
    description:
      'Retrieve graph context for a query by keyword seeds and bounded BFS, DFS, or PageRank ("ppr") ranking. ' +
      "as_of (ISO 8601; no offset means UTC) reads the graph as it stood at that time. strategy and seeds (bm25, " +
      "synonyms, embeddings) default to the server's level. hubs lists entities with 50 or more relations the walk " +
      "reached; context lines through one are marked (via hub), as weak links. skip_hubs stops the walk at hubs.",
    input: {
      query: str,
      strategy: optStr,
      depth: z.number().int().min(0).default(RETRIEVE_DEFAULTS.depth),
      k: z.number().int().min(1).default(RETRIEVE_DEFAULTS.k),
      max_nodes: z.number().int().min(1).default(RETRIEVE_DEFAULTS.max_nodes),
      budget_tokens: z.number().int().min(1).default(RETRIEVE_DEFAULTS.budget_tokens),
      as_of: optStr,
      seeds: optStr,
      skip_hubs: z.boolean().default(false),
    },
    run: (g, a) =>
      g.retrieve(a.query, {
        skip_hubs: a.skip_hubs,
        strategy: a.strategy as Strategy | null | undefined,
        depth: a.depth,
        k: a.k,
        max_nodes: a.max_nodes,
        budget_tokens: a.budget_tokens,
        as_of: time(a.as_of, "as_of"),
        seeds: a.seeds as SeedTier | null | undefined,
      }),
  }),
  tool({
    name: "maintenance_decay",
    description:
      "Score every entity and current relation by recency (half-life decay from its latest timestamp) and " +
      "frequency (sources, plus degree for entities) and store it as relevance, without a new version. Never " +
      "deletes. now (ISO 8601) defaults to the current time. Dry run by default: returns the scores; pass " +
      "dry_run false to write them.",
    input: { half_life_days: z.number().default(30), now: optStr, dry_run: z.boolean().default(true) },
    run: (g, a) =>
      g.maintenance.decay({ half_life_days: a.half_life_days, now: time(a.now, "now"), dry_run: a.dry_run }),
  }),
  tool({
    name: "maintenance_prune",
    description:
      "Remove entities and relations below min_relevance (set by maintenance_decay) and/or last touched " +
      "before older_than (ISO 8601); types narrows entities and relation_types relations (given only one, the other " +
      "kind is not matched). Needs min_relevance or older_than. Certified relations and the entities they connect are " +
      "kept (listed in certified) unless include_certified is true; merge_ids lists merge records whose unmerge a " +
      "removal would lose. Dry run by default: returns the plan; pass dry_run false to delete, which cascades like " +
      "delete_entity.",
    input: {
      min_relevance: z.number().nullish(),
      older_than: optStr,
      types: optList,
      relation_types: optList,
      include_certified: z.boolean().default(false),
      dry_run: z.boolean().default(true),
    },
    run: async (g, a) =>
      surfaced(
        await g.maintenance.prune({
          min_relevance: a.min_relevance,
          older_than: time(a.older_than, "older_than"),
          types: a.types,
          relation_types: a.relation_types,
          include_certified: a.include_certified,
          dry_run: a.dry_run,
        }),
      ),
  }),
  tool({
    name: "maintenance_dedupe_relations",
    description:
      "Merge parallel current relations with the same endpoints and type but different ids into the lowest " +
      "id: properties merge (survivor wins), evidence and decision steps move over, duplicates are deleted. " +
      "Dry run by default: returns the groups; pass dry_run false to merge.",
    input: { dry_run: z.boolean().default(true) },
    run: (g, a) => g.maintenance.dedupeRelations({ dry_run: a.dry_run }),
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
 * Set the backend for the tools, closing any cached graph.
 *
 * @param value (GraphSettings | null): the backend settings, or null to read the environment.
 */
export async function configure(value: GraphSettings | null = null): Promise<void> {
  settings = value ?? settingsFromEnv();
  await close();
}

/** Close the cached graph, if one is open, so an embedding process can exit; the next tool call reopens it. */
export async function close(): Promise<void> {
  await graph.release((g) => g.close().catch(() => undefined));
}

/**
 * Validate the arguments and run a tool, turning an error into a structured {error, error_type} result flagged as an MCP error.
 *
 * @param target (Tool | string): the tool, or its name.
 * @param args (Record<string, unknown>): the arguments.
 * @return ({ result: unknown; isError: boolean }): the JSON-ready result, and whether it is an error.
 */
export async function callTool(
  target: Tool | string,
  args: Record<string, unknown> = {},
): Promise<{ result: unknown; isError: boolean }> {
  const t = typeof target === "string" ? TOOLS.find((tool) => tool.name === target) : target;
  try {
    if (t === undefined) throw new ValidationError(`unknown tool ${pyRepr(target)}`);
    checkOptions(t.name, args, Object.keys(t.input));
  } catch (exc) {
    return { result: { error: (exc as Error).message, error_type: "ValidationError" }, isError: true };
  }
  const parsed = z.object(t.input).safeParse(args);
  if (!parsed.success) {
    const error = validationMessage("invalid arguments", parsed.error, args);
    return { result: { error, error_type: "ValidationError" }, isError: true };
  }
  try {
    return { result: toJsonable(await t.run(await graph.get(), parsed.data)), isError: false };
  } catch (exc) {
    if (exc instanceof SelfGraphError) {
      return { result: { error: surfaceHint(exc.message), error_type: exc.name }, isError: true };
    }
    const name = exc instanceof Error ? exc.name : "Error";
    return { result: { error: `${name}: ${errorMessage(exc)}`, error_type: "InternalError" }, isError: true };
  }
}

type ToolAnnotations = { readOnlyHint: true } | { destructiveHint: boolean; idempotentHint: boolean };

const READ_ONLY = [
  "get_schema",
  "retrieve",
  "run_cypher",
  "entity_evidence",
  "entity_merges",
  "relation_evidence",
  "check_readiness",
  "check_answerable",
];
const DESTRUCTIVE = ["maintenance_prune", "maintenance_dedupe_relations"];
const IDEMPOTENT = [
  "insert_facts",
  "maintenance_prune",
  "maintenance_dedupe_relations",
  "certify_relation",
  "uncertify_relation",
];

/**
 * The MCP behavior hints for a tool: read-only, destructive, and idempotent.
 *
 * @param name (string): the tool name.
 * @return (ToolAnnotations): readOnlyHint for a read, else destructiveHint and idempotentHint.
 */
function toolAnnotations(name: string): ToolAnnotations {
  if (READ_ONLY.includes(name) || /^(get|list)_/.test(name) || name.endsWith("_versions"))
    return { readOnlyHint: true };
  const deletes = name.startsWith("delete_");
  return {
    destructiveHint: deletes || DESTRUCTIVE.includes(name),
    idempotentHint: deletes || IDEMPOTENT.includes(name),
  };
}

interface CallToolRequest {
  params: { name: string; arguments?: Record<string, unknown> };
}

interface McpServerLike {
  server: { setRequestHandler(schema: unknown, handler: (request: CallToolRequest) => Promise<unknown>): void };
  registerTool(
    name: string,
    config: { description: string; inputSchema: z.ZodType; annotations: ToolAnnotations },
    cb: (args: Record<string, unknown>) => Promise<unknown>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  validateToolInput?: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
}

/**
 * Run a tool and shape the outcome as an MCP tool result, so an unknown tool name is a tool error.
 *
 * @param target (Tool | string): the tool, or its name.
 * @param args (Record<string, unknown>): the arguments.
 * @return (Promise<object>): the content, structured content, and error flag.
 */
async function respond(target: Tool | string, args: Record<string, unknown>) {
  const { result, isError } = await callTool(target, args);
  const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
  const structured = result !== null && typeof result === "object" && !Array.isArray(result) ? result : { result };
  return { content, structuredContent: structured, isError };
}

/**
 * Create an MCP server with every tool registered, requiring @modelcontextprotocol/sdk.
 *
 * @param name (string): the server name.
 * @return (McpServerLike): the server.
 */
export async function buildServer(name = "selfgraph"): Promise<McpServerLike> {
  const { McpServer } = await loadOptional<{
    McpServer: new (info: { name: string; version: string }, options?: { instructions?: string }) => McpServerLike;
  }>(
    "@modelcontextprotocol/sdk/server/mcp.js",
    "the MCP server needs '@modelcontextprotocol/sdk'; npm install @modelcontextprotocol/sdk",
    SelfGraphError,
  );
  const { CallToolRequestSchema } = await loadOptional<{ CallToolRequestSchema: unknown }>(
    "@modelcontextprotocol/sdk/types.js",
    "the MCP server needs '@modelcontextprotocol/sdk'",
    SelfGraphError,
  );
  const server = new McpServer({ name, version }, { instructions: INSTRUCTIONS });
  server.validateToolInput = async (_tool, args) => args;
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: z.looseObject(t.input), annotations: toolAnnotations(t.name) },
      (args) => respond(t, args),
    );
  }
  server.server.setRequestHandler(CallToolRequestSchema, (request: CallToolRequest) =>
    respond(request.params.name, request.params.arguments ?? {}),
  );
  return server;
}

/**
 * Configure the backend and serve the tools over stdio until the client disconnects.
 *
 * @param value (GraphSettings | null): the backend settings, or null to read the environment.
 */
export async function runStdio(value: GraphSettings | null = null): Promise<void> {
  await configure(checkSettings(value ?? settingsFromEnv()));
  const server = await buildServer();
  const { StdioServerTransport } = await loadOptional<{ StdioServerTransport: new () => unknown }>(
    "@modelcontextprotocol/sdk/server/stdio.js",
    "the MCP server needs '@modelcontextprotocol/sdk'",
    SelfGraphError,
  );
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => process.stdin.once("close", resolve));
  await close();
}

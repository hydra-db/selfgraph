import { z } from "zod";

import { ValidationError } from "./errors.js";
import { normalizeRelType } from "./ids.js";
import { comparePy, isPlainObject, pyRepr, pyStrip } from "./internal/py.js";
import { parseIso } from "./internal/time.js";
import { KINDS } from "./labels.js";
import { hasSurrogate, keyHint, requireCleanJson, requireNoControl, requireUnit } from "./validate.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | readonly JsonValue[]
  | { [key: string]: JsonValue };

export type DeepReadonly<T> = T extends Date
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
export type JsonObject = { [key: string]: JsonValue };

export const JsonValue: z.ZodType<JsonValue> = z.json() as z.ZodType<JsonValue>;

export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

export const Status = z.enum(["active", "completed", "reversed"]);
export type Status = z.infer<typeof Status>;

export const DEFAULT_KIND: Kind = "preference";
export const DEFAULT_STATUS: Status = "completed";

export const LLM_DEFAULTS = { temperature: 0, max_retries: 3, timeout: 120, concurrency: 4 } as const;

export const DateTimeInput = z.union([z.date(), z.string()]).transform((value, ctx) => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      ctx.addIssue({ code: "custom", message: "invalid date" });
      return z.NEVER;
    }
    return value;
  }
  try {
    return parseIso(value);
  } catch (exc) {
    ctx.addIssue({ code: "custom", message: (exc as Error).message });
    return z.NEVER;
  }
});
export type DateTimeInput = z.input<typeof DateTimeInput>;

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);
export const optString = nullable(z.string());
export const optNumber = nullable(z.number());
const optDate = nullable(DateTimeInput);
const props = <V extends z.ZodType<JsonValue>>(label: string, values: V = JsonValue as unknown as V) =>
  z
    .record(z.string(), values)
    .default({})
    .transform((value) => {
      requireCleanJson(label, value);
      return value;
    });

const entityText = z.string().transform((value) => {
  if (!value || !pyStrip(value)) {
    throw new ValidationError(
      "entity type and name cannot be empty; an entity needs both, e.g. type='Person', name='Jane Doe'",
    );
  }
  return pyStrip(value);
});

const noControl = (label: string) =>
  z.string().transform((value) => {
    requireNoControl(label, value);
    return value;
  });

export interface Evidence {
  source_id: string;
  source_version: string;
  chunk_id: string | null;
  quote: string | null;
  start_offset: number | null;
  end_offset: number | null;
  confidence: number | null;
}

export const EvidenceSchema = z.object({
  source_id: z.string(),
  source_version: z.string(),
  chunk_id: optString,
  quote: optString,
  start_offset: optNumber,
  end_offset: optNumber,
  confidence: optNumber,
});

export interface Entity {
  id: string;
  type: string;
  name: string;
  aliases: string[];
  external_ids: Record<string, string>;
  properties: JsonObject;
  source_count: number;
  created_at: Date;
  updated_at: Date;
  relevance: number | null;
  relevance_at: Date | null;
}

export interface Relation {
  id: string;
  revision: number;
  from_entity: string;
  type: string;
  to_entity: string;
  properties: JsonObject;
  event_time: Date | null;
  created_at: Date;
  is_current: boolean;
  source_count: number;
  invalidated_at: Date | null;
  invalidated_by: string | null;
  relevance: number | null;
  relevance_at: Date | null;
}

export interface Preference {
  id: string;
  revision: number;
  profile_id: string;
  subject_entity: string;
  kind: Kind;
  key: string;
  value_entity: string;
  about_entity: string | null;
  strength: number | null;
  properties: JsonObject;
  event_time: Date | null;
  created_at: Date;
  is_current: boolean;
}

export interface DecisionStep {
  order: number;
  relation_id: string;
  from_entity: string;
  to_entity: string;
}

export interface DecisionTrace {
  id: string;
  actor_entity: string | null;
  title: string;
  summary: string | null;
  rationale: string | null;
  status: Status;
  outcome_entity: string | null;
  alternative_entities: string[];
  steps: DecisionStep[];
  event_time: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface InsertWarning {
  code: string;
  message: string;
  source_id: string | null;
  chunk_id: string | null;
  merge_id: string | null;
}

/**
 * An insert warning not tied to a source or chunk.
 *
 * @param code (string): the warning code.
 * @param message (string): the warning message.
 * @return (InsertWarning): the warning.
 */
export function insertWarning(code: string, message: string): InsertWarning {
  return { code, message, source_id: null, chunk_id: null, merge_id: null };
}

export interface MergeRewrite {
  kind: "relation" | "preference" | "decision";
  id: string;
  original: JsonObject;
  rewritten: JsonObject;
  existed: boolean;
  dropped: boolean;
}

export interface MergeRecord {
  id: string;
  survivor_id: string;
  absorbed_id: string;
  absorbed: JsonObject;
  reason: string;
  confidence: number;
  source_id: string | null;
  source_ids: string[];
  added_aliases: string[];
  added_external_ids: string[];
  added_properties: string[];
  rewrites: MergeRewrite[];
  created_at: Date;
  reverted_at: Date | null;
}

export interface InsertResult {
  source_id: string | null;
  source_version: string | null;
  created_at: Date;
  entities: Entity[];
  relations: Relation[];
  preferences: Preference[];
  decisions: DecisionTrace[];
  warnings: InsertWarning[];
  merges: MergeRecord[];
}

export interface UnmergeResult {
  merge: MergeRecord;
  entity: Entity;
  survivor: Entity | null;
  relations: Relation[];
  preferences: Preference[];
  decisions: DecisionTrace[];
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface DeleteResult {
  deleted_entities: number;
  deleted_relation_versions: number;
  deleted_decisions: number;
  deleted_preference_versions: number;
}

export interface DecayResult {
  dry_run: boolean;
  half_life_days: number;
  now: Date;
  entities: Record<string, number>;
  relations: Record<string, number>;
  updated_entities: number;
  updated_relations: number;
}

export interface PruneResult {
  dry_run: boolean;
  entity_ids: string[];
  relation_ids: string[];
  /** The delete counts; absent on a dry run. */
  deleted?: DeleteResult;
  note: string | null;
}

export interface ConsolidateGroup {
  from_entity: string;
  type: string;
  to_entity: string;
  survivor: string;
  duplicates: string[];
  conflicts: Record<string, string[]>;
  versions_lost: Record<string, number>;
}

export interface ConsolidateResult {
  dry_run: boolean;
  groups: ConsolidateGroup[];
  /** The delete counts; absent on a dry run. */
  deleted?: DeleteResult;
  note: string | null;
}

export type CypherRow = Record<string, JsonValue | bigint>;

export interface CypherResult {
  columns: string[];
  /** Row values; an integer beyond Number.MAX_SAFE_INTEGER, such as a HydraDB internal id, is a bigint (toJsonable renders it as a string). */
  rows: CypherRow[];
  counters: Record<string, number>;
}

export const EntityInput = z.strictObject({
  id: optString,
  type: entityText,
  name: entityText,
  aliases: z.array(noControl("entity alias")).default([]),
  external_ids: props("entity property and external id", z.string()),
  properties: props("entity property and external id"),
});
export type EntityInput = DeepReadonly<z.input<typeof EntityInput>>;
export type ParsedEntityInput = z.output<typeof EntityInput>;

export const EvidenceInput = z.strictObject({
  source_id: noControl("evidence source_id"),
  chunk_id: nullable(noControl("evidence chunk_id")),
  quote: nullable(z.string()).transform((value) => {
    if (value !== null && hasSurrogate(value)) {
      throw new ValidationError("evidence quote cannot contain unpaired surrogate characters");
    }
    return value;
  }),
  start_offset: nullable(z.number().int()),
  end_offset: nullable(z.number().int()),
  confidence: nullable(z.number()).transform((value) => {
    if (value !== null) requireUnit("evidence confidence", value, true);
    return value;
  }),
});
export type EvidenceInput = DeepReadonly<z.input<typeof EvidenceInput>>;
export type ParsedEvidenceInput = z.output<typeof EvidenceInput>;

export const RelationInput = z.strictObject({
  id: optString,
  from_entity: z.string(),
  type: z.string().transform(normalizeRelType),
  to_entity: z.string(),
  properties: props("relation property"),
  event_time: optDate,
  evidence: z.array(EvidenceInput).default([]),
});
export type RelationInput = DeepReadonly<z.input<typeof RelationInput>>;
export type ParsedRelationInput = z.output<typeof RelationInput>;

export const PreferenceInput = z.strictObject({
  id: optString,
  subject_entity: z.string(),
  kind: Kind.default(DEFAULT_KIND),
  key: noControl("preference key"),
  value_entity: z.string(),
  about_entity: optString,
  strength: optNumber,
  properties: props("preference property"),
  event_time: optDate,
});
export type PreferenceInput = DeepReadonly<z.input<typeof PreferenceInput>>;
export type ParsedPreferenceInput = z.output<typeof PreferenceInput>;

export const DecisionTraceInput = z.strictObject({
  id: optString,
  title: z.string(),
  steps: z.array(z.string()).default([]),
  actor_entity: optString,
  summary: optString,
  rationale: optString,
  outcome_entity: optString,
  alternative_entities: z.array(z.string()).default([]),
  status: Status.default(DEFAULT_STATUS),
  event_time: optDate,
});
export type DecisionTraceInput = DeepReadonly<z.input<typeof DecisionTraceInput>>;
export type ParsedDecisionTraceInput = z.output<typeof DecisionTraceInput>;

export const Ontology = z.strictObject({
  entities: z.array(EntityInput).default([]),
  relations: z.array(RelationInput).default([]),
  preferences: z.array(PreferenceInput).default([]),
  decisions: z.array(DecisionTraceInput).default([]),
});
export type Ontology = DeepReadonly<z.input<typeof Ontology>>;
export type ParsedOntology = z.output<typeof Ontology>;

const DIRECT_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "google",
  "mistral",
  "xai",
  "deepseek",
  "cohere",
  "perplexity",
];
const KNOWN_PROVIDERS = [
  ...DIRECT_PROVIDERS,
  "azure",
  "bedrock",
  "cerebras",
  "fireworks",
  "fireworks_ai",
  "gateway",
  "groq",
  "ollama",
  "openrouter",
  "together_ai",
  "togetherai",
  "vertex",
  "vertex_ai",
];
const SAME_PROVIDER: Record<string, string> = { google: "gemini" };

/**
 * Reject a model prefixed with another provider than a first-party provider's own, such as anthropic with gemini/x. Routers (openrouter, groq, together, and the like) and any provider with a base_url take vendor-prefixed models, so only a first-party provider without a base_url is checked, and only against a known provider prefix.
 *
 * @param provider (string): the configured provider.
 * @param model (string): the configured model.
 * @param baseUrl (string | null | undefined): the configured base URL.
 */
export function requireMatchingPrefix(provider: string, model: string, baseUrl: string | null | undefined): void {
  const i = model.indexOf("/");
  const prefix = model.slice(0, i);
  const own = provider.toLowerCase();
  const other = prefix.toLowerCase();
  if (i < 0 || baseUrl || !DIRECT_PROVIDERS.includes(own) || !KNOWN_PROVIDERS.includes(other)) return;
  if ((SAME_PROVIDER[own] ?? own) !== (SAME_PROVIDER[other] ?? other)) {
    throw new ValidationError(`provider ${pyRepr(provider)} conflicts with model prefix ${pyRepr(prefix)}`);
  }
}

export const LLMConfig = z.strictObject({
  provider: z.string(),
  model: z.string(),
  api_key: optString,
  base_url: optString,
  temperature: z.number().default(LLM_DEFAULTS.temperature),
  max_retries: z.number().int().min(0).default(LLM_DEFAULTS.max_retries),
  timeout: z.number().positive().nullable().default(LLM_DEFAULTS.timeout),
  concurrency: z.number().int().min(1).default(LLM_DEFAULTS.concurrency),
});
export type LLMConfig = z.input<typeof LLMConfig>;
export type ParsedLLMConfig = z.output<typeof LLMConfig>;

export const PromptTemplate = z.strictObject({
  system: z.string(),
  user: z.string(),
  version: z.string(),
});
export type PromptTemplate = z.output<typeof PromptTemplate>;

export const ExtractionInstructions = z.strictObject({
  entities: optString,
  relations: optString,
  preferences: optString,
  decisions: optString,
});
export type ExtractionInstructions = z.input<typeof ExtractionInstructions>;

export const ExtractionPrompts = z.strictObject({
  entities: nullable(PromptTemplate),
  relations: nullable(PromptTemplate),
  preferences: nullable(PromptTemplate),
  decisions: nullable(PromptTemplate),
});
export type ExtractionPrompts = z.input<typeof ExtractionPrompts>;

export interface ParsedDocument {
  text: string;
  media_type: string;
  metadata: JsonObject;
}

export interface RetrievalSeed {
  id: string;
  score: number;
}

export interface Subgraph {
  entities: Entity[];
  relations: Relation[];
  preferences: Preference[];
  decisions: DecisionTrace[];
}

export interface RetrievalResult {
  query: string;
  strategy: string;
  seeds: RetrievalSeed[];
  subgraph: Subgraph;
  context: string;
}

/**
 * Strip optional, nullable, default, and transform wrappers off a zod schema.
 *
 * @param schema (z.core.$ZodType): the schema.
 * @return (z.core.$ZodType): the innermost schema.
 */
function unwrapSchema(schema: z.core.$ZodType): z.core.$ZodType {
  let current = schema;
  for (;;) {
    const def = current._zod.def as { type: string; innerType?: z.core.$ZodType; in?: z.core.$ZodType };
    if (def.innerType) current = def.innerType;
    else if (def.type === "pipe" && def.in) current = def.in;
    else return current;
  }
}

/**
 * The declared keys of an object schema, or null when the schema is not an object.
 *
 * @param schema (z.core.$ZodType): the unwrapped schema.
 * @return (Record<string, z.core.$ZodType> | null): the object's shape.
 */
function shapeOf(schema: z.core.$ZodType): Record<string, z.core.$ZodType> | null {
  const def = schema._zod.def as { type: string; shape?: Record<string, z.core.$ZodType> };
  return def.type === "object" && def.shape ? def.shape : null;
}

/**
 * Walk raw input against an object schema and describe the first unknown key, depth first in declared order.
 *
 * @param schema (z.core.$ZodType): the schema the value should match.
 * @param value (unknown): the raw input.
 * @param where (string): the location of the value, for the message.
 * @return (string | null): the error message, or null when every key is known.
 */
function unknownKey(schema: z.core.$ZodType, value: unknown, where: string): string | null {
  const shape = shapeOf(unwrapSchema(schema));
  if (shape === null || !isPlainObject(value)) return null;
  const keys = Object.keys(shape);
  const unknown = Object.keys(value)
    .filter((k) => !keys.includes(k))
    .sort(comparePy);
  if (unknown.length) return `unknown key ${pyRepr(unknown[0])} in ${where}${keyHint(unknown[0]!, keys)}`;
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const field = unwrapSchema(shape[key]!);
    const def = field._zod.def as { type: string; element?: z.core.$ZodType };
    if (def.type === "array" && def.element) {
      const items = value[key];
      if (!Array.isArray(items)) continue;
      for (const [i, item] of items.entries()) {
        const found = unknownKey(def.element, item, `${where}.${key}[${i}]`);
        if (found !== null) return found;
      }
    } else {
      const found = unknownKey(field, value[key], `${where}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Parse a value with a zod schema, raising SelfGraph's ValidationError on failure.
 *
 * @param schema (z.ZodType<T>): the schema.
 * @param value (unknown): the value.
 * @param what (string): a label for the error message.
 * @return (T): the parsed value.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const unknown = unknownKey(schema, value, what);
  if (unknown !== null) throw new ValidationError(unknown);
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ValidationError(validationMessage(`invalid ${what}`, result.error, value), { cause: result.error });
}

const JSON_TYPES: Record<string, string> = { int: "integer", record: "object", map: "object", tuple: "array" };

/**
 * Render an error location as entities[0].name: keys joined by dots, list indexes in brackets.
 *
 * @param path (readonly PropertyKey[]): the location parts, keys as strings and indexes as numbers.
 * @return (string): the path, or "" at the root.
 */
function errorPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/**
 * Join literal choices the way pydantic does: 'a', 'b' or 'c'.
 *
 * @param values (readonly unknown[]): the accepted values.
 * @return (string): the choices.
 */
function choices(values: readonly unknown[]): string {
  const shown = values.map(pyRepr);
  return shown.length < 2 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}`;
}

/**
 * Describe one zod issue in the wording the Python package uses for the same pydantic error.
 *
 * @param issue (z.core.$ZodIssue): the issue.
 * @param value (unknown): the input that was parsed, to tell a missing field from a mistyped one.
 * @return (string): the message, such as "field required" or "expected string".
 */
function issueMessage(issue: z.core.$ZodIssue, value: unknown): string {
  if (issue.code === "invalid_type") {
    let at: unknown = value;
    for (const part of issue.path)
      at = isPlainObject(at) || Array.isArray(at) ? (at as Record<PropertyKey, unknown>)[part as string] : undefined;
    if (at === undefined && issue.path.length) return "field required";
    return `expected ${JSON_TYPES[issue.expected] ?? issue.expected}`;
  }
  if (issue.code === "invalid_value") return `expected ${choices(issue.values)}`;
  if (
    (issue.code === "too_small" || issue.code === "too_big") &&
    (issue.origin === "number" || issue.origin === "int")
  ) {
    const bound = issue.code === "too_small" ? issue.minimum : issue.maximum;
    const op = issue.code === "too_small" ? ">" : "<";
    return `must be ${op}${issue.inclusive ? "=" : ""} ${String(bound)}`;
  }
  return issue.message.charAt(0).toLowerCase() + issue.message.slice(1);
}

/**
 * Format one zod issue as a "path: message" line, or the message alone at the root.
 *
 * @param issue (z.core.$ZodIssue): the issue.
 * @param value (unknown): the input that was parsed.
 * @return (string): the line.
 */
export function issueLine(issue: z.core.$ZodIssue, value: unknown): string {
  const path = errorPath(issue.path);
  const message = issueMessage(issue, value);
  return path ? `${path}: ${message}` : message;
}

/**
 * Format a zod error as one "path: message" line per issue, with entities[0].name paths. One issue stays inline after the heading; several go on indented lines.
 *
 * @param head (string): what failed, such as "invalid ontology".
 * @param error (z.ZodError): the error.
 * @param value (unknown): the input that was parsed.
 * @return (string): the message.
 */
export function validationMessage(head: string, error: z.ZodError, value: unknown): string {
  const lines = error.issues.map((issue) => issueLine(issue, value));
  return lines.length === 1 ? `${head}: ${lines[0]}` : `${head}:${lines.map((line) => `\n  ${line}`).join("")}`;
}

/**
 * Coerce an optional input argument: null and undefined stay null, anything else is parsed.
 *
 * @param schema (z.ZodType<T>): the schema.
 * @param value (unknown): the argument.
 * @param what (string): a label for the error message.
 * @return (T | null): the parsed value, or null.
 */
export function asInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T | null {
  return value === null || value === undefined ? null : parseOrThrow(schema, value, what);
}

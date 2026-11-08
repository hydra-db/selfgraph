import { z } from "zod";

import { ValidationError } from "./errors.js";
import { normalizeRelType } from "./ids.js";
import { comparePy, cpLen, isPlainObject, pyRepr, pyStrip } from "./internal/py.js";
import { parseIso } from "./internal/time.js";
import { KINDS } from "./labels.js";
import { hasSurrogate, requireCleanJson, requireNoControl } from "./validate.js";

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

export const LLM_DEFAULTS = { temperature: 0, max_retries: 3 } as const;

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
}

/**
 * An insert warning not tied to a source or chunk.
 *
 * @param code (string): the warning code.
 * @param message (string): the warning message.
 * @return (InsertWarning): the warning.
 */
export function insertWarning(code: string, message: string): InsertWarning {
  return { code, message, source_id: null, chunk_id: null };
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
  quote: nullable(z.string()).transform((value) => {
    if (value !== null && hasSurrogate(value)) {
      throw new ValidationError("evidence quote cannot contain unpaired surrogate characters");
    }
    return value;
  }),
  start_offset: nullable(z.number().int()),
  end_offset: nullable(z.number().int()),
  confidence: nullable(z.number()).transform((value) => {
    if (value !== null && !Number.isFinite(value))
      throw new ValidationError("evidence confidence must be a finite number");
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
  steps: z.array(z.string()),
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

export const LLMConfig = z.object({
  provider: z.string(),
  model: z.string(),
  api_key: optString,
  base_url: optString,
  temperature: z.number().default(LLM_DEFAULTS.temperature),
  max_retries: z.number().int().min(0).default(LLM_DEFAULTS.max_retries),
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
 * Count the single-character insertions, deletions, and substitutions that turn one string into another.
 *
 * @param a (string): the first string.
 * @param b (string): the second string.
 * @return (number): the Levenshtein distance.
 */
function editDistance(a: string, b: string): number {
  const bs = Array.from(b);
  let prev = Array.from({ length: bs.length + 1 }, (_, j) => j);
  let i = 0;
  for (const ca of a) {
    i += 1;
    const cur = [i];
    bs.forEach((cb, j) => {
      cur.push(Math.min(prev[j + 1]! + 1, cur[j]! + 1, prev[j]! + (ca === cb ? 0 : 1)));
    });
    prev = cur;
  }
  return prev[bs.length]!;
}

/**
 * Pick the valid key closest to an unknown one: edit distance at most 2 and below the key's length, ties by order.
 *
 * @param key (string): the unknown key.
 * @param valid (readonly string[]): the accepted keys in declared order.
 * @return (string | null): the suggestion, or null when nothing is close.
 */
export function suggestKey(key: string, valid: readonly string[]): string | null {
  let best: string | null = null;
  let limit = Math.min(2, cpLen(key) - 1);
  for (const candidate of valid) {
    const distance = editDistance(key, candidate);
    if (distance <= limit) {
      best = candidate;
      limit = distance - 1;
    }
  }
  return best;
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
  if (unknown.length) {
    const suggestion = suggestKey(unknown[0]!, keys);
    const hint = suggestion === null ? "" : `; did you mean ${pyRepr(suggestion)}?`;
    return `unknown key ${pyRepr(unknown[0])} in ${where}${hint}`;
  }
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
  const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  throw new ValidationError(`invalid ${what}: ${detail}`, { cause: result.error });
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

/**
 * Parse an optional event time.
 *
 * @param value (DateTimeInput | null | undefined): a Date or ISO text, or null.
 * @return (Date | null): the parsed time, or null.
 */
export const parseDate = (value: DateTimeInput | null | undefined): Date | null =>
  value == null ? null : parseOrThrow(DateTimeInput, value, "event_time");

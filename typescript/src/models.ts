import { z } from "zod";

import { ValidationError } from "./errors.js";
import { normalizeRelType } from "./ids.js";
import { pyStrip } from "./internal/py.js";
import { parseIso } from "./internal/time.js";
import { KINDS } from "./labels.js";
import { hasControl, hasSurrogate, requireCleanJson } from "./validate.js";

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
const optString = nullable(z.string());
const optNumber = nullable(z.number());
const optDate = nullable(DateTimeInput);
const props = (label: string) =>
  z
    .record(z.string(), JsonValue)
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

const noControl = (message: string) =>
  z.string().transform((value) => {
    if (hasControl(value)) throw new ValidationError(message);
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
  evidence: Evidence[];
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
  evidence: Evidence[];
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

export interface CypherResult {
  columns: string[];
  rows: Array<Record<string, JsonValue>>;
  counters: Record<string, number>;
}

export const EntityInput = z.object({
  id: optString,
  type: entityText,
  name: entityText,
  aliases: z.array(noControl("entity alias cannot contain control or surrogate characters")).default([]),
  external_ids: z
    .record(z.string(), z.string())
    .default({})
    .transform((value) => {
      requireCleanJson("entity property and external id", value);
      return value;
    }),
  properties: props("entity property and external id"),
});
export type EntityInput = DeepReadonly<z.input<typeof EntityInput>>;
export type ParsedEntityInput = z.output<typeof EntityInput>;

export const EvidenceInput = z.object({
  source_id: noControl("evidence source_id cannot contain control or surrogate characters"),
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

export const RelationInput = z.object({
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

export const PreferenceInput = z.object({
  id: optString,
  subject_entity: z.string(),
  kind: Kind.default(DEFAULT_KIND),
  key: noControl("preference key cannot contain control or surrogate characters"),
  value_entity: z.string(),
  about_entity: optString,
  strength: optNumber,
  properties: props("preference property"),
  event_time: optDate,
});
export type PreferenceInput = DeepReadonly<z.input<typeof PreferenceInput>>;
export type ParsedPreferenceInput = z.output<typeof PreferenceInput>;

export const DecisionTraceInput = z.object({
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

export const Ontology = z.object({
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

export const PromptTemplate = z.object({
  system: z.string(),
  user: z.string(),
  version: z.string(),
});
export type PromptTemplate = z.output<typeof PromptTemplate>;

export const ExtractionInstructions = z.object({
  entities: optString,
  relations: optString,
  preferences: optString,
  decisions: optString,
});
export type ExtractionInstructions = z.input<typeof ExtractionInstructions>;

export const ExtractionPrompts = z.object({
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
 * Parse a value with a zod schema, raising SelfGraph's ValidationError on failure.
 *
 * @param schema (z.ZodType<T>): the schema.
 * @param value (unknown): the value.
 * @param what (string): a label for the error message.
 * @return (T): the parsed value.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  throw new ValidationError(`invalid ${what}: ${detail}`, { cause: result.error });
}

/**
 * Parse an optional event time.
 *
 * @param value (DateTimeInput | null | undefined): a Date or ISO text, or null.
 * @return (Date | null): the parsed time, or null.
 */
export const parseDate = (value: DateTimeInput | null | undefined): Date | null =>
  value == null ? null : parseOrThrow(DateTimeInput, value, "event_time");

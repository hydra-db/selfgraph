import { z } from "zod";
import { loadTokenizer } from "../chunking.js";
import { ExtractionError, errorMessage } from "../errors.js";
import * as ids from "../ids.js";
import { pySplit, pyStrip } from "../internal/py.js";
import {
  DateTimeInput,
  DEFAULT_STATUS,
  ExtractionInstructions,
  ExtractionPrompts,
  type InsertWarning,
  insertWarning,
  Kind,
  Ontology,
  type ParsedDocument,
  type ParsedOntology,
  parseOrThrow,
  Status,
} from "../models.js";
import type { Extractor, LLMClient } from "../protocols.js";
import { type ParsedSchema, renderSchemaCatalog } from "../schema.js";
import { effectiveInstruction, effectivePrompt, type ObjectType, render } from "./prompts.js";

const EntitiesOut = z.object({
  entities: z.array(z.object({ type: z.string(), name: z.string(), aliases: z.array(z.string()).nullable() })),
});

const RelationsOut = z.object({
  relations: z.array(
    z.object({
      from_name: z.string(),
      type: z.string(),
      to_name: z.string(),
      event_time: z.string().nullable(),
    }),
  ),
});

const PreferencesOut = z.object({
  preferences: z.array(
    z.object({
      subject_name: z.string(),
      kind: Kind,
      key: z.string(),
      value_name: z.string(),
      about_name: z.string().nullable(),
      strength: z.number().nullable(),
    }),
  ),
});

const DecisionsOut = z.object({
  decisions: z.array(
    z.object({
      title: z.string(),
      actor_name: z.string().nullable(),
      summary: z.string().nullable(),
      rationale: z.string().nullable(),
      outcome_name: z.string().nullable(),
      alternative_names: z.array(z.string()),
      status: Status,
      steps: z.array(z.object({ from_name: z.string(), type: z.string(), to_name: z.string() })),
    }),
  ),
});

export interface RawEntity {
  type: string;
  name: string;
  aliases?: string[] | null;
}

export interface RawRelation {
  from_name: string;
  type: string;
  to_name: string;
  properties?: Record<string, unknown> | null;
  event_time?: string | Date | null;
}

export interface RawPreference {
  subject_name: string;
  kind: Kind;
  key: string;
  value_name: string;
  about_name?: string | null;
  strength?: number | null;
}

export interface RawDecision {
  title: string;
  actor_name?: string | null;
  summary?: string | null;
  rationale?: string | null;
  outcome_name?: string | null;
  alternative_names?: string[];
  status?: Status;
  steps?: Array<{ from_name: string; type: string; to_name: string }>;
}

const HAS_LETTER = /\p{L}/u;
export const FALLBACK_TYPE = "Thing";
const MAX_CONCURRENT_CALLS = 8;

const norm = (name: string): string => pyStrip(name).toLowerCase();

/**
 * Report whether a name is a bare quantity or phrase fragment (empty, over six words, or without a letter) rather than an entity.
 *
 * @param name (string): the candidate entity name.
 * @return (boolean): true when the name should not become an entity.
 */
export function isNoiseName(name: string): boolean {
  const text = pyStrip(name);
  if (!text) return true;
  if (pySplit(text).length > 6) return true;
  return !HAS_LETTER.test(text);
}

function lenientTime(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const parsed = DateTimeInput.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve raw extracted names to deterministic ids and assemble a deduplicated ontology.
 *
 * @param rawEntities (RawEntity[]): the extracted entities.
 * @param rawRelations (RawRelation[]): the extracted relations, by name.
 * @param rawPreferences (RawPreference[]): the extracted preferences, by name.
 * @param rawDecisions (RawDecision[]): the extracted decisions, by name.
 * @return (ParsedOntology): the assembled ontology.
 */
export function assembleOntology(
  rawEntities: RawEntity[],
  rawRelations: RawRelation[],
  rawPreferences: RawPreference[],
  rawDecisions: RawDecision[],
): ParsedOntology {
  const registry = new Map<string, RawEntity>();
  for (const ent of rawEntities) {
    const key = norm(ent.name);
    if (!registry.has(key) && !isNoiseName(ent.name)) registry.set(key, ent);
  }

  const resolve = (name: string | null | undefined): string | null => {
    if (name == null || !pyStrip(name)) return null;
    const key = norm(name);
    let ent =
      registry.get(key) ??
      [...registry.values()].find((e) => ids.entityId(e.type, name) === ids.entityId(e.type, e.name));
    if (ent === undefined) {
      if (isNoiseName(name)) return null;
      ent = { type: FALLBACK_TYPE, name: pyStrip(name) };
      registry.set(key, ent);
    }
    return ids.entityId(ent.type, ent.name);
  };

  const relations = new Map<string, Record<string, unknown>>();
  const addRelation = (
    fromId: string,
    rtype: string,
    toId: string,
    props?: Record<string, unknown> | null,
    eventTime?: Date | null,
  ): string => {
    const rid = ids.relationId(fromId, rtype, toId);
    if (!relations.has(rid)) {
      relations.set(rid, {
        from_entity: fromId,
        type: rtype,
        to_entity: toId,
        properties: { ...(props ?? {}) },
        event_time: eventTime ?? null,
      });
    }
    return rid;
  };

  for (const rel of rawRelations) {
    const fromId = resolve(rel.from_name);
    const toId = resolve(rel.to_name);
    if (fromId && toId) addRelation(fromId, rel.type, toId, rel.properties, lenientTime(rel.event_time));
  }

  const preferences = new Map<string, Record<string, unknown>>();
  for (const pref of rawPreferences) {
    const subjectId = resolve(pref.subject_name);
    const valueId = resolve(pref.value_name);
    if (!(subjectId && valueId)) continue;
    const pid = ids.preferenceId(subjectId, pref.kind, pref.key, valueId);
    if (!preferences.has(pid)) {
      preferences.set(pid, {
        subject_entity: subjectId,
        kind: pref.kind,
        key: pref.key,
        value_entity: valueId,
        about_entity: resolve(pref.about_name),
        strength: pref.strength ?? null,
      });
    }
  }

  const decisions = new Map<string, Record<string, unknown>>();
  for (const dec of rawDecisions) {
    const actorId = resolve(dec.actor_name);
    const stepIds: string[] = [];
    for (const step of dec.steps ?? []) {
      const fromId = resolve(step.from_name);
      const toId = resolve(step.to_name);
      if (fromId && toId) stepIds.push(addRelation(fromId, step.type, toId));
    }
    const tid = ids.decisionId(actorId, dec.title);
    if (!decisions.has(tid)) {
      decisions.set(tid, {
        title: dec.title,
        steps: stepIds,
        actor_entity: actorId,
        summary: dec.summary ?? null,
        rationale: dec.rationale ?? null,
        outcome_entity: resolve(dec.outcome_name),
        alternative_entities: (dec.alternative_names ?? []).map(resolve).filter((a): a is string => Boolean(a)),
        status: dec.status ?? DEFAULT_STATUS,
      });
    }
  }

  return Ontology.parse({
    entities: [...registry.values()].map((e) => ({ type: e.type, name: e.name, aliases: e.aliases ?? [] })),
    relations: [...relations.values()],
    preferences: [...preferences.values()],
    decisions: [...decisions.values()],
  });
}

export interface DefaultExtractorOptions {
  prompts?: ExtractionPrompts | null;
  instructions?: ExtractionInstructions | null;
  call_prompts?: ExtractionPrompts | null;
  call_instructions?: ExtractionInstructions | null;
  schema?: ParsedSchema | null;
}

export class DefaultExtractor implements Extractor {
  private warnings: InsertWarning[] = [];
  private readonly catalogs: Partial<Record<ObjectType, string>>;
  private readonly options: DefaultExtractorOptions;

  /**
   * Extract entities, relations, preferences, and decisions from text with an LLM, chunk by chunk.
   *
   * @param llm (LLMClient): the LLM client.
   * @param options (DefaultExtractorOptions): client-level and per-call prompts, instructions, and schema guidance.
   */
  constructor(
    private readonly llm: LLMClient,
    options: DefaultExtractorOptions = {},
  ) {
    this.options = {
      prompts: parseOrThrow(ExtractionPrompts.nullish(), options.prompts, "prompts"),
      instructions: parseOrThrow(ExtractionInstructions.nullish(), options.instructions, "instructions"),
      call_prompts: parseOrThrow(ExtractionPrompts.nullish(), options.call_prompts, "call prompts"),
      call_instructions: parseOrThrow(ExtractionInstructions.nullish(), options.call_instructions, "call instructions"),
    };
    const [entities, relations] = options.schema ? renderSchemaCatalog(options.schema) : ["", ""];
    this.catalogs = { entities, relations };
  }

  popWarnings(): InsertWarning[] {
    const out = this.warnings;
    this.warnings = [];
    return out;
  }

  private messages(objectType: ObjectType, text: string): [string, string] {
    const template = effectivePrompt(objectType, this.options.prompts, this.options.call_prompts);
    let instruction = effectiveInstruction(objectType, this.options.instructions, this.options.call_instructions);
    const catalog = this.catalogs[objectType] ?? "";
    if (catalog) instruction = instruction ? `${instruction}\n\n${catalog}` : catalog;
    return render(template, text, instruction);
  }

  private async call<T>(objectType: ObjectType, text: string, output: z.ZodType<T>): Promise<T> {
    const [system, user] = this.messages(objectType, text);
    return this.llm.generate({ system, user, output });
  }

  async extract(document: ParsedDocument): Promise<ParsedOntology> {
    this.warnings = [];
    const chunks = (await loadTokenizer()).chunkText(document.text);
    if (!chunks.length) return Ontology.parse({});

    const rawEntities: RawEntity[] = [];
    const rawRelations: RawRelation[] = [];
    const rawPreferences: RawPreference[] = [];
    const rawDecisions: RawDecision[] = [];

    const step = <T>(kind: ObjectType, schema: z.ZodType<T>, sink: (result: T) => void) => ({
      kind,
      run: async (text: string) => {
        const result = await this.call(kind, text, schema);
        return () => sink(result);
      },
    });
    const steps = [
      step("entities", EntitiesOut, (r) => rawEntities.push(...r.entities)),
      step("relations", RelationsOut, (r) => rawRelations.push(...r.relations)),
      step("preferences", PreferencesOut, (r) => rawPreferences.push(...r.preferences)),
      step("decisions", DecisionsOut, (r) => rawDecisions.push(...r.decisions)),
    ];

    for (const { kind } of steps) this.messages(kind, "");
    const calls = chunks.flatMap((chunk) => steps.map(({ kind, run }) => ({ chunk, kind, run })));
    const outcomes: Array<{ apply: () => void } | { error: unknown }> = [];
    let next = 0;
    const worker = async () => {
      while (next < calls.length) {
        const i = next++;
        const { chunk, run } = calls[i]!;
        outcomes[i] = await run(chunk.text).then(
          (apply) => ({ apply }),
          (error: unknown) => ({ error }),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_CALLS, calls.length) }, worker));

    const ok = new Set<number>();
    calls.forEach(({ chunk, kind }, i) => {
      const outcome = outcomes[i]!;
      if ("apply" in outcome) {
        outcome.apply();
        ok.add(chunk.index);
      } else {
        this.warnings.push(
          insertWarning(
            "extraction_partial_failure",
            `${kind} extraction failed on chunk ${chunk.index}: ${errorMessage(outcome.error)}`,
          ),
        );
      }
    });

    if (!ok.size && this.warnings.length) {
      throw new ExtractionError(
        `extraction failed for the whole input (${this.warnings.length} errors); first: ${this.warnings[0]!.message}`,
      );
    }
    return assembleOntology(rawEntities, rawRelations, rawPreferences, rawDecisions);
  }
}

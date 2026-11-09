import { z } from "zod";
import { loadTokenizer } from "../chunking.js";
import { ExtractionError, ValidationError } from "../errors.js";
import * as ids from "../ids.js";
import { log } from "../internal/log.js";
import { pySplit, pyStrip, utf8 } from "../internal/py.js";
import { EDGE_TYPES, preferenceKindOf } from "../labels.js";
import { summarizeError } from "../llm/index.js";
import {
  DateTimeInput,
  DEFAULT_STATUS,
  ExtractionInstructions,
  ExtractionPrompts,
  type InsertWarning,
  insertWarning,
  issueLine,
  Kind,
  LLM_DEFAULTS,
  Ontology,
  type ParsedDocument,
  type ParsedOntology,
  parseOrThrow,
  Status,
} from "../models.js";
import { rejectReservedRelType, validateEntityIdentity, validateStrength } from "../ops.js";
import type { Extractor, LLMClient } from "../protocols.js";
import { type ParsedSchema, renderSchemaCatalog } from "../schema.js";
import { checkOptions, keysOf, requireOptionalText } from "../validate.js";
import { checkPrompts, effectiveInstruction, effectivePrompt, type ObjectType, render } from "./prompts.js";

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
  evidence?: ChunkEvidence | null;
}

type ChunkEvidence = { source_id: string; chunk_id: string };

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
  evidence?: ChunkEvidence | null;
}

const HAS_LETTER = /\p{L}/u;
export const FALLBACK_TYPE = "Thing";

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

/**
 * Report whether an extracted relation type names one of SelfGraph's internal edge types.
 *
 * @param rtype (string): the type as the model wrote it.
 * @return (boolean): true for a reserved type such as CONSIDERED.
 */
function isReserved(rtype: string): boolean {
  try {
    return EDGE_TYPES.has(ids.normalizeRelType(rtype));
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

/**
 * Run a check on one extracted item, recording a warning and reporting false when the item is invalid.
 *
 * @param warnings (InsertWarning[]): the warning list to append to.
 * @param kind (string): the kind of item, for the message.
 * @param check (() => void): throws ValidationError when the item is invalid.
 * @param rtype (string | null): the relation type of a relation or decision step, so a reserved one gets the dropped_reserved_relation code.
 * @return (boolean): true when the item is valid and should be kept.
 */
function admitted(warnings: InsertWarning[], kind: string, check: () => void, rtype: string | null = null): boolean {
  try {
    check();
    return true;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const code = rtype !== null && isReserved(rtype) ? "dropped_reserved_relation" : "extraction_partial_failure";
    warnings.push(insertWarning(code, `dropped an extracted ${kind}: ${error.message}`));
    return false;
  }
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
 * @param warnings (InsertWarning[]): receives one warning per dropped invalid item.
 * @return (ParsedOntology): the assembled ontology.
 */
export function assembleOntology(
  rawEntities: RawEntity[],
  rawRelations: RawRelation[],
  rawPreferences: RawPreference[],
  rawDecisions: RawDecision[],
  warnings: InsertWarning[] = [],
): ParsedOntology {
  const registry = new Map<string, RawEntity>();
  const rejected = new Set<string>();
  const admit = (ent: RawEntity): boolean =>
    admitted(warnings, "entity", () => validateEntityIdentity(ids.entityId(ent.type, ent.name), ent.type, ent.name));
  for (const ent of rawEntities) {
    const key = norm(ent.name);
    if (!registry.has(key) && !isNoiseName(ent.name) && admit(ent)) registry.set(key, ent);
  }

  const resolve = (name: string | null | undefined): string | null => {
    if (name == null || !pyStrip(name)) return null;
    const key = norm(name);
    let ent =
      registry.get(key) ??
      [...registry.values()].find((e) => ids.entityId(e.type, name) === ids.entityId(e.type, e.name));
    if (ent === undefined) {
      if (isNoiseName(name) || rejected.has(key)) return null;
      ent = { type: FALLBACK_TYPE, name: pyStrip(name) };
      if (!admit(ent)) {
        rejected.add(key);
        return null;
      }
      registry.set(key, ent);
    }
    return ids.entityId(ent.type, ent.name);
  };

  const relations = new Map<string, Record<string, unknown> & { evidence: ChunkEvidence[] }>();
  const addRelation = (
    fromId: string,
    rtype: string,
    toId: string,
    props?: Record<string, unknown> | null,
    eventTime?: Date | null,
    evidence?: ChunkEvidence | null,
  ): string => {
    const rid = ids.relationId(fromId, rtype, toId);
    rejectReservedRelType(ids.normalizeRelType(rtype), rtype);
    if (!relations.has(rid)) {
      relations.set(rid, {
        from_entity: fromId,
        type: rtype,
        to_entity: toId,
        properties: { ...(props ?? {}) },
        event_time: eventTime ?? null,
        evidence: [],
      });
    }
    const cited = relations.get(rid)!.evidence;
    if (evidence && !cited.some((ev) => ev.chunk_id === evidence.chunk_id && ev.source_id === evidence.source_id)) {
      cited.push(evidence);
    }
    return rid;
  };

  const promoted: RawPreference[] = [];
  for (const rel of rawRelations) {
    const fromId = resolve(rel.from_name);
    const toId = resolve(rel.to_name);
    if (fromId && toId) {
      admitted(
        warnings,
        "relation",
        () => {
          const kind = preferenceKindOf(ids.normalizeRelType(rel.type));
          const value = registry.get(norm(rel.to_name));
          if (kind !== null && value !== undefined && value.type !== FALLBACK_TYPE) {
            promoted.push({
              subject_name: rel.from_name,
              kind,
              key: value.type.toLowerCase(),
              value_name: rel.to_name,
            });
          } else {
            addRelation(fromId, rel.type, toId, rel.properties, lenientTime(rel.event_time), rel.evidence);
          }
        },
        rel.type,
      );
    }
  }

  const preferences = new Map<string, Record<string, unknown>>();
  const stated = new Set<string>();
  for (const [index, pref] of [...rawPreferences, ...promoted].entries()) {
    const subjectId = resolve(pref.subject_name);
    const valueId = resolve(pref.value_name);
    if (!(subjectId && valueId)) continue;
    const triple = JSON.stringify([subjectId, pref.kind, valueId]);
    if (index >= rawPreferences.length && stated.has(triple)) continue;
    stated.add(triple);
    let pid = "";
    const valid = admitted(warnings, "preference", () => {
      validateStrength(pref.strength);
      pid = ids.preferenceId(subjectId, pref.kind, pref.key, valueId);
    });
    if (valid && !preferences.has(pid)) {
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
      if (fromId && toId) {
        admitted(
          warnings,
          "decision step",
          () => stepIds.push(addRelation(fromId, step.type, toId, null, null, dec.evidence)),
          step.type,
        );
      }
    }
    let tid = "";
    const valid = admitted(warnings, "decision", () => {
      requireOptionalText("decision summary", dec.summary);
      requireOptionalText("decision rationale", dec.rationale);
      tid = ids.decisionId(actorId, dec.title);
    });
    if (valid && !decisions.has(tid)) {
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
  source_id?: string | null;
}

const OPTION_KEYS = keysOf<DefaultExtractorOptions>({
  prompts: true,
  instructions: true,
  call_prompts: true,
  call_instructions: true,
  schema: true,
  source_id: true,
});

export class WarningSink {
  protected warnings: InsertWarning[] = [];

  popWarnings(): InsertWarning[] {
    const out = this.warnings;
    this.warnings = [];
    return out;
  }
}

export class DefaultExtractor extends WarningSink implements Extractor {
  private readonly catalogs: Partial<Record<ObjectType, string>>;
  private readonly options: DefaultExtractorOptions;
  private readonly sourceId: string | null;

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
    super();
    checkOptions("DefaultExtractor", options, OPTION_KEYS);
    this.options = {
      prompts: parseOrThrow(ExtractionPrompts.nullish(), options.prompts, "prompts"),
      instructions: parseOrThrow(ExtractionInstructions.nullish(), options.instructions, "instructions"),
      call_prompts: parseOrThrow(ExtractionPrompts.nullish(), options.call_prompts, "call prompts"),
      call_instructions: parseOrThrow(ExtractionInstructions.nullish(), options.call_instructions, "call instructions"),
    };
    checkPrompts(this.options.prompts);
    checkPrompts(this.options.call_prompts);
    const [entities, relations] = options.schema ? renderSchemaCatalog(options.schema) : ["", ""];
    this.catalogs = { entities, relations };
    this.sourceId = options.source_id ?? null;
  }

  private messages(objectType: ObjectType, text: string): [string, string] {
    const template = effectivePrompt(objectType, this.options.prompts, this.options.call_prompts);
    let instruction = effectiveInstruction(objectType, this.options.instructions, this.options.call_instructions);
    const catalog = this.catalogs[objectType] ?? "";
    if (catalog) instruction = instruction ? `${instruction}\n\n${catalog}` : catalog;
    return render(template, text, instruction, objectType);
  }

  async extract(document: ParsedDocument): Promise<ParsedOntology> {
    this.warnings = [];
    const chunks = (await loadTokenizer()).chunkText(document.text);
    if (!chunks.length) return Ontology.parse({});

    const rawEntities: RawEntity[] = [];
    const rawRelations: RawRelation[] = [];
    const rawPreferences: RawPreference[] = [];
    const rawDecisions: RawDecision[] = [];

    const step = <T>(
      kind: ObjectType,
      schema: z.ZodType<T>,
      sink: (result: T, evidence: ChunkEvidence | null) => void,
    ) => ({
      kind,
      run: async (text: string) => {
        const [system, user] = this.messages(kind, text);
        const result = await this.llm.generate({ system, user, output: schema });
        const parsed = schema.safeParse(result);
        if (!parsed.success) {
          const line = issueLine(parsed.error.issues[0]!, result);
          throw new ExtractionError(`LLM client returned an invalid result for the ${kind} pass: ${line}`, {
            cause: parsed.error,
          });
        }
        return (evidence: ChunkEvidence | null) => sink(parsed.data, evidence);
      },
    });
    const steps = [
      step("entities", EntitiesOut, (r) => rawEntities.push(...r.entities)),
      step("relations", RelationsOut, (r, evidence) =>
        rawRelations.push(...r.relations.map((x) => ({ ...x, evidence }))),
      ),
      step("preferences", PreferencesOut, (r) => rawPreferences.push(...r.preferences)),
      step("decisions", DecisionsOut, (r, evidence) =>
        rawDecisions.push(...r.decisions.map((x) => ({ ...x, evidence }))),
      ),
    ];

    for (const { kind } of steps) this.messages(kind, "");
    const calls = chunks.flatMap((chunk) => steps.map(({ kind, run }) => ({ chunk, kind, run })));
    const outcomes: Array<{ apply: (evidence: ChunkEvidence | null) => void } | { error: unknown }> = [];
    let next = 0;
    let fatal: ExtractionError | null = null;
    const worker = async () => {
      while (next < calls.length && fatal === null) {
        const i = next++;
        const { chunk, kind, run } = calls[i]!;
        if (chunks.length > 1 && kind === steps[0]!.kind)
          log(`extracting chunk ${chunk.index + 1}/${chunks.length}`, "info");
        outcomes[i] = await run(chunk.text).then(
          (apply) => ({ apply }),
          (error: unknown) => {
            if (error instanceof ExtractionError) fatal ??= error;
            return { error };
          },
        );
      }
    };
    const { concurrency } = this.llm as { concurrency?: unknown };
    const chunksAtOnce =
      typeof concurrency === "number" && Number.isSafeInteger(concurrency) && concurrency > 0
        ? concurrency
        : LLM_DEFAULTS.concurrency;
    await Promise.all(Array.from({ length: Math.min(chunksAtOnce * steps.length, calls.length) }, worker));
    if (fatal !== null) throw fatal;

    const version =
      this.sourceId === null ? null : ids.sourceVersionId(this.sourceId, ids.contentHash(utf8(document.text)));
    calls.forEach(({ chunk, kind }, i) => {
      const outcome = outcomes[i]!;
      const chunkId = version === null ? null : ids.chunkId(version, chunk.index);
      if ("apply" in outcome) {
        outcome.apply(chunkId === null ? null : { source_id: this.sourceId!, chunk_id: chunkId });
      } else {
        this.warnings.push({
          ...insertWarning(
            "extraction_partial_failure",
            `${kind} extraction failed on chunk ${chunk.index}: ${summarizeError(outcome.error)}`,
          ),
          source_id: this.sourceId,
          chunk_id: chunkId,
        });
      }
    });

    const failed = this.warnings.length;
    const ontology = assembleOntology(rawEntities, rawRelations, rawPreferences, rawDecisions, this.warnings);
    const { entities, relations, preferences, decisions } = ontology;
    if (failed && !(entities.length || relations.length || preferences.length || decisions.length)) {
      throw new ExtractionError(
        `extraction failed for the whole input (${failed} of ${calls.length} LLM calls failed); ` +
          `first: ${this.warnings[0]!.message}`,
      );
    }
    return ontology;
  }
}

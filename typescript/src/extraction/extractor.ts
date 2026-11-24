import { z } from "zod";
import { loadTokenizer } from "../chunking.js";
import { ExtractionError, ValidationError } from "../errors.js";
import * as ids from "../ids.js";
import { log } from "../internal/log.js";
import { pyRepr, pySplit, pyStrip, utf8 } from "../internal/py.js";
import { parseIso, toIso } from "../internal/time.js";
import { LETTER_CLASS, lower } from "../internal/unicode.js";
import { EDGE_TYPES, preferenceStanceOf } from "../labels.js";
import { summarizeError } from "../llm/index.js";
import {
  Extraction,
  ExtractionInstructions,
  ExtractionPrompts,
  type InsertWarning,
  insertWarning,
  issueLine,
  type JsonObject,
  LLM_DEFAULTS,
  type ParsedDocument,
  type ParsedExtraction,
  parseOrThrow,
  Stance,
  Status,
} from "../models.js";
import { rejectReservedRelType, validateEntityIdentity, validateStrength } from "../ops.js";
import type { Extractor, LLMClient } from "../protocols.js";
import { canonicalEntityType, type ParsedSchema, renderSchemaCatalog } from "../schema.js";
import {
  checkOptions,
  keysOf,
  rejectProtoKeys,
  requireCleanJson,
  requireJsonMapping,
  requireNoControl,
  requireOptionalText,
  requireStr,
} from "../validate.js";
import { checkPrompts, effectiveInstruction, effectivePrompt, type ObjectType, render } from "./prompts.js";

const EntitiesOut = z.object({
  entities: z.array(
    z.object({ type: z.string(), name: z.string(), aliases: z.array(z.string()).nullable().default(null) }),
  ),
});

const RelationsOut = z.object({
  relations: z.array(
    z.object({
      from_name: z.string(),
      type: z.string(),
      to_name: z.string(),
      event_time: z.string().nullable().default(null),
      properties: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

/**
 * Coerce extracted strength like Python's lax float output field.
 * @param value (unknown): the extracted strength.
 * @return (unknown): the coerced number, or the original invalid value.
 */
function coerceStrength(value: unknown): unknown {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string") {
    const text = pyStrip(value);
    const numeric = text.replaceAll("_", "");
    if (!/^_|_$|__/.test(text) && /^[+-]?(?:nan|inf(?:inity)?|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(numeric)) {
      return Number(numeric);
    }
  }
  return value;
}

const PreferencesOut = z.object({
  preferences: z.array(
    z.object({
      subject_name: z.string(),
      stance: Stance.default("preference"),
      key: z.string(),
      value_name: z.string(),
      about_name: z.string().nullable().default(null),
      strength: z.union([z.number(), z.boolean(), z.string()]).nullable().default(null),
    }),
  ),
});

const CheckedPreferencesOut = PreferencesOut.extend({
  preferences: z.array(
    PreferencesOut.shape.preferences.element.extend({
      strength: z.preprocess(
        coerceStrength,
        z
          .union([z.number(), z.nan(), z.literal(Infinity), z.literal(-Infinity)])
          .nullable()
          .default(null),
      ),
    }),
  ),
});

const DecisionsOut = z.object({
  decisions: z.array(
    z.object({
      title: z.string(),
      actor_name: z.string().nullable().default(null),
      summary: z.string().nullable().default(null),
      rationale: z.string().nullable().default(null),
      outcome_name: z.string().nullable().default(null),
      alternative_names: z.array(z.string()).default([]),
      status: Status.nullable().default(null),
      steps: z.array(z.object({ from_name: z.string(), type: z.string(), to_name: z.string() })).default([]),
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
  event_time?: string | null;
  evidence?: ChunkEvidence | null;
}

type ChunkEvidence = { source_id: string; chunk_id: string };

export interface RawPreference {
  subject_name: string;
  stance: Stance;
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
  status?: Status | null;
  steps?: Array<{ from_name: string; type: string; to_name: string }>;
  evidence?: ChunkEvidence | null;
}

const HAS_LETTER = new RegExp(`[${LETTER_CLASS}]`, "u");
export const FALLBACK_TYPE = "Thing";

const norm = (name: string): string => lower(pyStrip(name));

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

/**
 * Parse an extracted event_time; a bare year 0001-9999 becomes Jan 1 UTC, and unparseable values become null.
 *
 * @param value (string | null | undefined): ISO text, a four-digit year, or null.
 * @return (Date | null): the time, or null when absent or not parseable.
 */
export function lenientTime(value: string | null | undefined): Date | null {
  const text = pyStrip(value ?? "");
  if (!text) return null;
  if (/^\d{4}$/.test(text)) return Number(text) >= 1 ? parseIso(`${text}-01-01`) : null;
  try {
    const parsed = parseIso(text);
    toIso(parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve raw extracted names to deterministic ids and assemble deduplicated facts.
 *
 * @param rawEntities (RawEntity[]): the extracted entities.
 * @param rawRelations (RawRelation[]): the extracted relations, by name.
 * @param rawPreferences (RawPreference[]): the extracted preferences, by name.
 * @param rawDecisions (RawDecision[]): the extracted decisions, by name.
 * @param warnings (InsertWarning[]): receives one warning per dropped invalid item.
 * @param schema (ParsedSchema | null): endpoint types for resolving ambiguous names.
 * @return (ParsedExtraction): the assembled facts.
 */
export function assembleExtraction(
  rawEntities: RawEntity[],
  rawRelations: RawRelation[],
  rawPreferences: RawPreference[],
  rawDecisions: RawDecision[],
  warnings: InsertWarning[] = [],
  schema: ParsedSchema | null = null,
): ParsedExtraction {
  const registry = new Map<string, RawEntity>();
  const canonical = new Map<boolean, { type: string; names: Map<string, RawEntity[]> }>();
  const rejected = new Set<string>();
  const admit = (ent: RawEntity): boolean =>
    admitted(warnings, "entity", () => validateEntityIdentity(ids.entityId(ent.type, ent.name), ent.type, ent.name));
  /**
   * Add an entity to the registry and to the index of canonical names.
   *
   * @param key (string): the entity id the registry stores it under.
   * @param ent (RawEntity): the entity to register.
   * @return (void): nothing.
   */
  const register = (key: string, ent: RawEntity): void => {
    const org = ids.isOrgType(ent.type);
    if (!canonical.has(org)) canonical.set(org, { type: ent.type, names: new Map() });
    const { names } = canonical.get(org)!;
    const name = ids.canonicalName(ent.type, ent.name);
    if (!names.has(name)) names.set(name, []);
    names.get(name)!.push(ent);
    registry.set(key, ent);
  };
  /**
   * List the registered entities whose canonical name equals the canonical form of a name.
   *
   * @param name (string): the extracted name to look up.
   * @return (RawEntity[]): every registered entity that matches, across entity types.
   */
  const matching = (name: string): RawEntity[] => {
    if (registry.size === 0) return [];
    requireStr("entity name", name);
    return [...canonical.values()].flatMap(({ type, names }) => names.get(ids.canonicalName(type, name)) ?? []);
  };
  for (const ent of rawEntities) {
    if (!admit(ent) || isNoiseName(ent.name)) continue;
    const key = ids.entityId(ent.type, ent.name);
    const cleanAliases = (ent.aliases ?? []).filter((alias) =>
      admitted(warnings, "alias", () => requireNoControl("entity alias", alias)),
    );
    if (!registry.has(key)) register(key, { ...ent, aliases: [] });
    const kept = registry.get(key)!;
    kept.aliases = [...new Set([...(kept.aliases ?? []), ...cleanAliases])];
  }

  /**
   * Resolve an extracted name to the id of one registered entity, registering a fallback entity when none match.
   *
   * @param name (string | null | undefined): the extracted name.
   * @param types (string[]): the endpoint types that narrow several matches to one.
   * @return (string | null): the entity id, or null when the name is blank, invalid, or matches several types.
   */
  const resolve = (name: string | null | undefined, types: string[] = []): string | null => {
    if (name == null || !pyStrip(name)) return null;
    const key = norm(name);
    let matches: RawEntity[];
    try {
      matches = matching(name);
      if (matches.length > 1 && types.length) {
        const typed = matches.filter((e) => types.some((t) => norm(t) === norm(e.type)));
        if (typed.length) matches = typed;
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      if (!rejected.has(key)) {
        rejected.add(key);
        warnings.push(insertWarning("extraction_partial_failure", `dropped an extracted entity: ${error.message}`));
      }
      return null;
    }
    if (matches.length > 1) {
      warnings.push(
        insertWarning(
          "extraction_partial_failure",
          `unresolved extracted entity reference ${pyRepr(name)}: multiple entity types match`,
        ),
      );
      return null;
    }
    let ent = matches[0];
    if (ent === undefined) {
      if (isNoiseName(name) || rejected.has(key)) return null;
      ent = { type: FALLBACK_TYPE, name: pyStrip(name) };
      if (!admit(ent)) {
        rejected.add(key);
        return null;
      }
      register(ids.entityId(ent.type, ent.name), ent);
    }
    return ids.entityId(ent.type, ent.name);
  };

  const endpointTypes = (rtype: string, side: "from" | "to"): string[] => {
    const rel = schema?.relations.find((r) => [r.type, ...r.aliases].some((t) => norm(t) === norm(rtype)));
    return rel?.[side].types ?? [];
  };

  const relations = new Map<
    string,
    Record<string, unknown> & { properties: JsonObject; event_time: Date | null; evidence: ChunkEvidence[] }
  >();
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
    props = { ...props };
    for (const key of Object.keys(props)) {
      if (!pyStrip(key)) {
        admitted(warnings, "relation property", () => requireJsonMapping("properties", { [key]: props![key] }));
        delete props[key];
      }
    }
    rejectProtoKeys(props);
    requireCleanJson("relation property", props);
    if (!relations.has(rid)) {
      relations.set(rid, {
        from_entity: fromId,
        type: rtype,
        to_entity: toId,
        properties: {},
        event_time: null,
        evidence: [],
      });
    }
    const relation = relations.get(rid)!;
    Object.assign(relation.properties, props);
    if (eventTime != null) relation.event_time = eventTime;
    const cited = relation.evidence;
    if (evidence && !cited.some((ev) => ev.chunk_id === evidence.chunk_id && ev.source_id === evidence.source_id)) {
      cited.push(evidence);
    }
    return rid;
  };

  const promoted: RawPreference[] = [];
  for (const rel of rawRelations) {
    const fromId = resolve(rel.from_name, endpointTypes(rel.type, "from"));
    const toId = resolve(rel.to_name, endpointTypes(rel.type, "to"));
    if (fromId && toId) {
      admitted(
        warnings,
        "relation",
        () => {
          const stance = preferenceStanceOf(ids.normalizeRelType(rel.type));
          const value = registry.get(toId);
          if (stance !== null && value !== undefined && value.type !== FALLBACK_TYPE) {
            promoted.push({
              subject_name: rel.from_name,
              stance,
              key: lower(canonicalEntityType(value.type, schema)),
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
    const triple = JSON.stringify([subjectId, pref.stance, valueId]);
    if (index >= rawPreferences.length && stated.has(triple)) continue;
    stated.add(triple);
    let pid = "";
    const valid = admitted(warnings, "preference", () => {
      validateStrength(pref.strength);
      pid = ids.preferenceId(subjectId, pref.stance, pref.key, valueId);
    });
    if (valid && !preferences.has(pid)) {
      preferences.set(pid, {
        subject_entity: subjectId,
        stance: pref.stance,
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
      const fromId = resolve(step.from_name, endpointTypes(step.type, "from"));
      const toId = resolve(step.to_name, endpointTypes(step.type, "to"));
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
        alternative_entities: (dec.alternative_names ?? [])
          .map((name) => resolve(name))
          .filter((a): a is string => Boolean(a)),
        status: dec.status ?? null,
      });
    }
  }

  return Extraction.parse({
    entities: [...registry.values()].map((e) => ({ type: e.type, name: e.name, aliases: e.aliases ?? [] })),
    relations: [...relations.values()],
    preferences: [...preferences.values()],
    decisions: [...decisions.values()],
  });
}

export interface LLMExtractorOptions {
  prompts?: ExtractionPrompts | null;
  instructions?: ExtractionInstructions | null;
  call_prompts?: ExtractionPrompts | null;
  call_instructions?: ExtractionInstructions | null;
  schema?: ParsedSchema | null;
  source_id?: string | null;
}

const OPTION_KEYS = keysOf<LLMExtractorOptions>({
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

export class LLMExtractor extends WarningSink implements Extractor {
  private readonly catalogs: Partial<Record<ObjectType, string>>;
  private readonly options: LLMExtractorOptions;
  private readonly sourceId: string | null;
  private readonly schema: ParsedSchema | null;

  /**
   * Extract entities, relations, preferences, and decisions from text with an LLM, chunk by chunk.
   *
   * @param llm (LLMClient): the LLM client.
   * @param options (LLMExtractorOptions): client-level and per-call prompts, instructions, and schema guidance.
   */
  constructor(
    private readonly llm: LLMClient,
    options: LLMExtractorOptions = {},
  ) {
    super();
    checkOptions("LLMExtractor", options, OPTION_KEYS);
    this.options = {
      prompts: parseOrThrow(ExtractionPrompts.nullish(), options.prompts, "prompts"),
      instructions: parseOrThrow(ExtractionInstructions.nullish(), options.instructions, "instructions"),
      call_prompts: parseOrThrow(ExtractionPrompts.nullish(), options.call_prompts, "call prompts"),
      schema: options.schema,
      call_instructions: parseOrThrow(ExtractionInstructions.nullish(), options.call_instructions, "call instructions"),
    };
    checkPrompts(this.options.prompts);
    checkPrompts(this.options.call_prompts);
    const [entities, relations] = options.schema ? renderSchemaCatalog(options.schema) : ["", ""];
    this.catalogs = { entities, relations };
    this.sourceId = options.source_id ?? null;
    this.schema = options.schema ?? null;
  }

  private messages(objectType: ObjectType, text: string): [string, string] {
    const template = effectivePrompt(objectType, this.options.prompts, this.options.call_prompts);
    let instruction = effectiveInstruction(objectType, this.options.instructions, this.options.call_instructions);
    const catalog = this.catalogs[objectType] ?? "";
    if (catalog) instruction = instruction ? `${instruction}\n\n${catalog}` : catalog;
    return render(template, text, instruction, objectType);
  }

  async extract(document: ParsedDocument): Promise<ParsedExtraction> {
    this.warnings = [];
    const chunks = (await loadTokenizer()).chunkText(document.text);
    if (!chunks.length) return Extraction.parse({});

    const rawEntities: RawEntity[] = [];
    const rawRelations: RawRelation[] = [];
    const rawPreferences: RawPreference[] = [];
    const rawDecisions: RawDecision[] = [];

    const step = <T, U = T>(
      kind: ObjectType,
      schema: z.ZodType<T>,
      sink: (result: U, evidence: ChunkEvidence | null, raw: unknown) => void,
      checked: z.ZodType<U> = schema as unknown as z.ZodType<U>,
    ) => ({
      kind,
      run: async (text: string) => {
        const [system, user] = this.messages(kind, text);
        const result = await this.llm.generate({ system, user, output: schema });
        const parsed = checked.safeParse(result);
        if (!parsed.success) {
          const line = issueLine(parsed.error.issues[0]!, result);
          throw new ExtractionError(`LLM client returned an invalid result for the ${kind} pass: ${line}`, {
            cause: parsed.error,
            code: "invalid_llm_output",
          });
        }
        return (evidence: ChunkEvidence | null) => sink(parsed.data, evidence, result);
      },
    });
    const steps = [
      step("entities", EntitiesOut, (r) => rawEntities.push(...r.entities)),
      step("relations", RelationsOut, (r, evidence, raw) =>
        rawRelations.push(
          ...r.relations.map((x, i) => ({
            ...x,
            properties: (raw as z.input<typeof RelationsOut>).relations[i]!.properties ?? x.properties,
            evidence,
          })),
        ),
      ),
      step("preferences", PreferencesOut, (r) => rawPreferences.push(...r.preferences), CheckedPreferencesOut),
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
    const baseUrl = (this.llm as { base_url?: string | null }).base_url ?? null;
    calls.forEach(({ chunk, kind }, i) => {
      const outcome = outcomes[i]!;
      const chunkId = version === null ? null : ids.chunkId(version, chunk.index);
      if ("apply" in outcome) {
        outcome.apply(chunkId === null ? null : { source_id: this.sourceId!, chunk_id: chunkId });
      } else {
        this.warnings.push({
          ...insertWarning(
            "extraction_partial_failure",
            `${kind} extraction failed on chunk ${chunk.index}: ${summarizeError(outcome.error, baseUrl)}`,
          ),
          source_id: this.sourceId,
          chunk_id: chunkId,
        });
      }
    });

    const failed = this.warnings.length;
    const facts = assembleExtraction(
      rawEntities,
      rawRelations,
      rawPreferences,
      rawDecisions,
      this.warnings,
      this.options.schema,
    );
    const { entities, relations, preferences, decisions } = facts;
    if (failed && !(entities.length || relations.length || preferences.length || decisions.length)) {
      throw new ExtractionError(
        `extraction failed for the whole input (${failed} of ${calls.length} LLM calls failed); ` +
          `first: ${this.warnings[0]!.message}`,
      );
    }
    return facts;
  }
}

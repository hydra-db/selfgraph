import { z } from "zod";

import { ExtractionError, NotFoundError, needsLlm, ValidationError } from "./errors.js";
import { FALLBACK_TYPE } from "./extraction/extractor.js";
import * as ids from "./ids.js";
import { dumps, loads } from "./internal/json.js";
import { contextPayload } from "./internal/payload.js";
import { comparePy, cpLen, deepEqual, pyFloatRepr, pyRepr, pyStrip } from "./internal/py.js";
import { fromIso, jsonIso, toIso } from "./internal/time.js";
import { DECIMAL_CLASS } from "./internal/unicode.js";
import { L_ENTITY, L_EVIDENCE, L_MERGE, L_MERGE_ENTRY, L_SOURCE_VERSION, L_TRACE } from "./labels.js";
import { type LLMArg, resolveLlm } from "./llm/index.js";
import { scanLiveMerges } from "./maintenance.js";
import {
  DEFAULT_STATUS,
  type DecisionTrace,
  DecisionTraceInput,
  type Entity,
  EntityInput,
  type Evidence,
  type InsertWarning,
  insertWarning,
  type JsonObject,
  type MergeRecord,
  type MergeRewrite,
  type ParsedDecisionTraceInput,
  type ParsedEntityInput,
  type ParsedExtraction,
  type ParsedPreferenceInput,
  type ParsedRelationInput,
  type Preference,
  PreferenceInput,
  parseOrThrow,
  type Relation,
  RelationInput,
  type UnmergeResult,
} from "./models.js";
import * as ops from "./ops.js";
import type { EdgeRow, EdgeWrite, GraphPrimitives, LLMClient, Props } from "./protocols.js";
import { fold, tokens } from "./retrieval.js";
import { canonicalEntityType, entityIndex, lineage, type ParsedSchema, requireMode } from "./schema.js";
import { decodeEntity, decodeEvidence } from "./serde.js";
import { clamp, type Level } from "./tiers.js";
import { checkOptions, requireInt, requireStr, typeName } from "./validate.js";

type Runner = GraphPrimitives;

export const RESOLVER_MODES = ["exact", "default", "fuzzy", "llm"] as const;
export type ResolverMode = (typeof RESOLVER_MODES)[number];

const FALLBACK_KEY = ops.entityTypeKey(FALLBACK_TYPE);
const DEFAULT_THRESHOLD = 0.92;
const DEFAULT_BAND: readonly [number, number] = [0.8, 0.92];
const MAX_QUESTIONS = 3;
const ALIAS_CONFIDENCE = 0.95;
const PREFIX_LIMIT = 4;
const PREFIX_SCALE = 0.1;
const GENERATIONAL = new Set(["jr", "sr", "ii", "iii", "iv"]);
const LLM_SYSTEM =
  "You decide whether two mentions name the same real-world entity. Answer same=true only when you are " +
  "confident they are the same entity; different entities with similar names are not the same.";

const SameEntity = z.object({ same: z.boolean() });

export interface ResolutionDecision {
  target_id?: string | null;
  confidence?: number | null;
  reason?: string | null;
}

export interface EntityResolver {
  /** Whether entities earlier in the same insert are offered as merge targets; true when absent. */
  readonly within_batch?: boolean;
  resolve(candidate: ParsedEntityInput, existing: readonly Entity[]): Promise<ResolutionDecision>;
}

/**
 * Score two strings by Jaro-Winkler similarity over code points, with the prefix bonus capped at four.
 *
 * @param a (string): the first string.
 * @param b (string): the second string.
 * @return (number): the similarity in [0, 1].
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const x = Array.from(a);
  const y = Array.from(b);
  const la = x.length;
  const lb = y.length;
  if (!la || !lb) return 0;
  const window = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
  const aHit = new Array<boolean>(la).fill(false);
  const bHit = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(lb, i + window + 1); j++) {
      if (!bHit[j] && y[j] === x[i]) {
        aHit[i] = true;
        bHit[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let transposed = 0;
  let j = 0;
  for (let i = 0; i < la; i++) {
    if (!aHit[i]) continue;
    while (!bHit[j]) j++;
    if (x[i] !== y[j]) transposed++;
    j++;
  }
  const jaro = (matches / la + matches / lb + (matches - transposed / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(PREFIX_LIMIT, la, lb); i++) {
    if (x[i] !== y[i]) break;
    prefix++;
  }
  return jaro + prefix * PREFIX_SCALE * (1 - jaro);
}

/**
 * Score two texts by the Jaccard overlap of their casefolded content tokens.
 *
 * @param a (string): the first text.
 * @param b (string): the second text.
 * @return (number): the overlap in [0, 1], 0 when either side has no tokens.
 */
export function tokenJaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

const folded = (s: string): string => fold(pyStrip(s));

/**
 * Score two entity names lexically: the higher of folded Jaro-Winkler and token Jaccard.
 *
 * @param a (string): the first name.
 * @param b (string): the second name.
 * @return (number): the similarity in [0, 1].
 */
export function nameSimilarity(a: string, b: string): number {
  return Math.max(jaroWinkler(folded(a), folded(b)), tokenJaccard(a, b));
}

const DIGITS = new RegExp(`[${DECIMAL_CLASS}]+`, "gu");
const DECIMAL_CHAR = new RegExp(`^[${DECIMAL_CLASS}]$`, "u");

/**
 * Collect the tokens that tell apart otherwise similar names: digit runs, single-letter words, and generations.
 *
 * @param tokens (string[]): the name's folded word tokens.
 * @return ([string[], string[], string[]]): the sorted digit runs, the sorted single-letter word tokens, and the sorted generational suffixes (Jr, Sr, II, III, IV).
 */
function distinguishers(tokens: string[]): [string[], string[], string[]] {
  const digits = tokens.flatMap((t) => [...t.matchAll(DIGITS)].map((m) => m[0])).sort(comparePy);
  const letters = tokens.filter((t) => cpLen(t) === 1 && !DECIMAL_CHAR.test(t)).sort(comparePy);
  const generations = tokens.filter((t) => GENERATIONAL.has(t)).sort(comparePy);
  return [digits, letters, generations];
}

/**
 * Split a name into its folded word tokens.
 *
 * @param name (string): the entity name.
 * @return (string[]): the folded letter and digit runs, in order.
 */
function words(name: string): string[] {
  return ids.wordRuns(folded(name));
}

/**
 * Report whether every word has a counterpart among the other name's words: a word one of the two starts with, or one whose Jaro-Winkler similarity reaches the threshold.
 *
 * @param mine (string[]): the folded words that need a counterpart.
 * @param others (string[]): the other name's folded words.
 * @param threshold (number): the per-word similarity a counterpart needs.
 * @return (boolean): true when every word has a counterpart.
 */
function covered(mine: string[], others: string[], threshold: number): boolean {
  return mine.every((w) => others.some((o) => w.startsWith(o) || o.startsWith(w) || jaroWinkler(w, o) >= threshold));
}

/**
 * Report whether two similar names carry different distinguishing tokens, so they must not merge by similarity. Names differ when their digit runs differ as multisets (Employee1 and Employee2, Project 12 and Project 13), when their generational suffixes (Jr, Sr, II, III, IV) differ (Bobby Tables Jr and Bobby Tables), when both have single-letter words and those differ (Model A and Model B), or when both have several words and a word of the shorter name (of either, at equal length) has no counterpart in the other, so Katherine Zorkfuzzy and Katherine Zorkdefault differ while Jon Smithers and Jonathan Smithers do not.
 *
 * @param a (string): the first name.
 * @param b (string): the second name.
 * @param threshold (number): the per-word Jaro-Winkler similarity that counts as the same word.
 * @return (boolean): true when a similarity or LLM merge between the names is not allowed.
 */
export function distinctNames(a: string, b: string, threshold: number = DEFAULT_THRESHOLD): boolean {
  const wordsA = words(a);
  const wordsB = words(b);
  const [digitsA, lettersA, generationsA] = distinguishers(wordsA);
  const [digitsB, lettersB, generationsB] = distinguishers(wordsB);
  const same = (x: string[], y: string[]): boolean => x.length === y.length && x.every((t, i) => t === y[i]);
  if (!same(digitsA, digitsB) || !same(generationsA, generationsB)) return true;
  if (lettersA.length > 0 && lettersB.length > 0 && !same(lettersA, lettersB)) return true;
  if (wordsA.length < 2 || wordsB.length < 2) return false;
  return (
    (wordsA.length <= wordsB.length && !covered(wordsA, wordsB, threshold)) ||
    (wordsB.length <= wordsA.length && !covered(wordsB, wordsA, threshold))
  );
}

const candidateId = (candidate: ParsedEntityInput): string =>
  candidate.id || ids.entityId(ops.cleanText(candidate.type), ops.cleanText(candidate.name));

/**
 * Report whether any of the candidate's name and aliases matches the entity's name or one of its aliases.
 *
 * @param candidate (ParsedEntityInput): the candidate entity.
 * @param ent (Entity): the existing entity.
 * @return (boolean): true on a folded match.
 */
function surfaceMatch(candidate: ParsedEntityInput, ent: Entity): boolean {
  const forms = formsOf(ent.name, ent.aliases);
  return [...formsOf(candidate.name, candidate.aliases)].some((f) => forms.has(f));
}

const FORMS_CACHE_LIMIT = 1 << 16;
const formsCache = new Map<string, ReadonlySet<string>>();

/**
 * The folded name and aliases of an entity, cached since resolution compares each one against many.
 *
 * @param name (string): the name.
 * @param aliases (readonly string[]): the aliases.
 * @return (ReadonlySet<string>): the stripped, folded forms.
 */
function formsOf(name: string, aliases: readonly string[]): ReadonlySet<string> {
  const key = [name, ...aliases].join("\u0000");
  let forms = formsCache.get(key);
  if (forms === undefined) {
    if (formsCache.size >= FORMS_CACHE_LIMIT) formsCache.clear();
    forms = new Set([name, ...aliases].map(folded));
    formsCache.set(key, forms);
  }
  return forms;
}

const overlaps = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((f) => b.has(f));

/**
 * The keys an entity is indexed under for the default resolver: its folded name and aliases, and its external ids. Two entities share a key exactly when the default resolver's alias or external id signal can fire between them.
 *
 * @param name (string): the name.
 * @param aliases (readonly string[]): the aliases.
 * @param externalIds (Record<string, string>): the external ids.
 * @return (Set<string>): the keys.
 */
export function matchKeys(name: string, aliases: readonly string[], externalIds: Record<string, string>): Set<string> {
  const forms = [...formsOf(name, aliases)].map((f) => `form:${f}`);
  return new Set([...forms, ...Object.entries(externalIds).map(([k, v]) => `xid:${dumps([k, v])}`)]);
}

const noMatch = (): ResolutionDecision => ({ target_id: null, confidence: 0, reason: "no_match" });

/**
 * Validate a number lies in the unit interval, optionally excluding zero.
 *
 * @param name (string): the parameter name for the message.
 * @param value (unknown): the value.
 * @param openLow (boolean): reject zero when true.
 */
function requireUnit(name: string, value: unknown, openLow: boolean): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${name} must be a number, got ${typeName(value)}`);
  }
  if (value > 1 || value < 0 || (openLow && value === 0)) {
    throw new ValidationError(`${name} must be in ${openLow ? "(0, 1]" : "[0, 1]"}, got ${pyFloatRepr(value)}`);
  }
}

export interface DefaultResolverOptions {
  fuzzy?: boolean;
  threshold?: number;
}

export class DefaultResolver implements EntityResolver {
  readonly fuzzy: boolean;
  readonly threshold: number;

  /**
   * An LLM-free resolver: id, external id, and alias matches merge; lexical similarity merges when fuzzy.
   *
   * @param options (DefaultResolverOptions): fuzzy also merges same-type names at or above threshold, and within one batch.
   */
  constructor(options: DefaultResolverOptions = {}) {
    checkOptions("DefaultResolver", options, ["fuzzy", "threshold"]);
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    requireUnit("threshold", threshold, true);
    this.fuzzy = Boolean(options.fuzzy);
    this.threshold = threshold;
  }

  get within_batch(): boolean {
    return this.fuzzy;
  }

  async resolve(candidate: ParsedEntityInput, existing: readonly Entity[]): Promise<ResolutionDecision> {
    return this.decide(candidate, existing);
  }

  /**
   * Score one existing entity as the candidate's merge target by the first signal that fires.
   *
   * @param candidate (ParsedEntityInput): the candidate entity.
   * @param ent (Entity): the existing entity.
   * @return ([number, string] | null): the confidence and reason, or null when no signal fires.
   */
  score(candidate: ParsedEntityInput, ent: Entity): [number, string] | null {
    return this.scorer(candidate)(ent);
  }

  /**
   * Score existing entities against one candidate, deriving the candidate's type, id, and forms once.
   *
   * @param candidate (ParsedEntityInput): the candidate entity.
   * @return ((ent: Entity) => [number, string] | null): score for one existing entity.
   */
  private scorer(candidate: ParsedEntityInput): (ent: Entity) => [number, string] | null {
    const ctype = ops.cleanText(candidate.type);
    const ckey = ops.entityTypeKey(ctype);
    const forms = formsOf(candidate.name, candidate.aliases);
    let derived: string | undefined;
    const cid = (): string => {
      derived ??= candidateId(candidate);
      return derived;
    };
    return (ent) => {
      const ekey = ops.entityTypeKey(ent.type);
      if (ckey === FALLBACK_KEY && ekey !== ckey) {
        return overlaps(forms, formsOf(ent.name, ent.aliases)) ? [ALIAS_CONFIDENCE, "alias"] : null;
      }
      if (cid() === ent.id) return [1, "id"];
      if (Object.entries(ent.external_ids).some(([key, value]) => candidate.external_ids[key] === value)) {
        return [1, "external_id"];
      }
      if (overlaps(forms, formsOf(ent.name, ent.aliases))) return [ALIAS_CONFIDENCE, "alias"];
      if (this.fuzzy && ekey === ckey && !distinctNames(candidate.name, ent.name, this.threshold)) {
        const similarity = nameSimilarity(candidate.name, ent.name);
        if (similarity >= this.threshold) return [similarity, "similarity"];
      }
      return null;
    };
  }

  /**
   * Pick the merge target: highest confidence, ties to the lexicographically smallest id.
   *
   * Signal 3 (alias) matches any candidate surface form (name or alias) against any target surface form, so a candidate alias equal to two entities' names or aliases ties at the alias confidence and the smallest id wins.
   *
   * @param candidate (ParsedEntityInput): the candidate entity.
   * @param existing (readonly Entity[]): the type-compatible entities it may merge into.
   * @return (ResolutionDecision): the decision, with target_id null when nothing matches.
   */
  decide(candidate: ParsedEntityInput, existing: readonly Entity[]): ResolutionDecision {
    let best: [number, string, string] | null = null;
    const score = this.scorer(candidate);
    for (const ent of existing) {
      const scored = score(ent);
      if (scored === null) continue;
      if (best === null || scored[0] > best[0] || (scored[0] === best[0] && comparePy(ent.id, best[1]) < 0)) {
        best = [scored[0], ent.id, scored[1]];
      }
    }
    return best === null ? noMatch() : { target_id: best[1], confidence: best[0], reason: best[2] };
  }
}

export interface LLMResolverOptions {
  band?: readonly [number, number];
  max_questions?: number;
}

/**
 * Render the yes/no question for one candidate and one existing entity.
 *
 * @param candidate (ParsedEntityInput): the candidate entity.
 * @param ent (Entity): the existing entity.
 * @return (string): the user prompt.
 */
function question(candidate: ParsedEntityInput, ent: Entity): string {
  const describe = (type: string, name: string, aliases: readonly string[]): string =>
    contextPayload(`${type} ${pyRepr(name)}${aliases.length ? ` (also known as ${aliases.join(", ")})` : ""}`);
  return (
    `Mention A: ${describe(candidate.type, candidate.name, candidate.aliases)}\n` +
    `Mention B: ${describe(ent.type, ent.name, ent.aliases)}\n` +
    "Do A and B name the same entity?"
  );
}

export class LLMResolver implements EntityResolver {
  readonly within_batch = true;
  readonly band: readonly [number, number];
  readonly max_questions: number;
  private readonly llm: LLMClient;
  private readonly lexical: DefaultResolver;

  /**
   * A resolver that asks the LLM a yes/no question for same-type names in a middle similarity band. Names whose digit runs or single-letter words differ, or whose words have no counterpart within the band's bottom, are never merged by similarity or asked about (see distinctNames).
   *
   * @param llm (LLMArg): the LLM to ask.
   * @param options (LLMResolverOptions): band [low, high), where low <= score < high is asked, and max_questions per candidate.
   */
  constructor(llm: LLMArg, options: LLMResolverOptions = {}) {
    checkOptions("LLMResolver", options, ["band", "max_questions"]);
    const client = resolveLlm(llm);
    if (client === null)
      throw new ValidationError("LLMResolver needs an LLM; pass an LLMConfig or an LLMClient", {
        code: "llm_required",
      });
    const band = options.band ?? DEFAULT_BAND;
    if (!Array.isArray(band) || band.length !== 2) {
      throw new ValidationError(`band must be a (low, high) pair, got ${pyRepr(band)}`);
    }
    const [low, high] = band;
    requireUnit("band low", low, false);
    requireUnit("band high", high, true);
    if (!(low < high)) throw new ValidationError(`band low must be below band high, got ${pyRepr(band)}`);
    const maxQuestions = options.max_questions ?? MAX_QUESTIONS;
    requireInt("max_questions", maxQuestions);
    if (maxQuestions < 1)
      throw new ValidationError(`max_questions must be >= 1, got ${maxQuestions}`, { field: "max_questions" });
    this.llm = client;
    this.band = [low, high];
    this.max_questions = maxQuestions;
    this.lexical = new DefaultResolver({ fuzzy: true, threshold: high });
  }

  /**
   * Decide lexically, then ask the LLM about same-type names in the band, highest similarity first.
   *
   * @param candidate (ParsedEntityInput): the candidate entity.
   * @param existing (readonly Entity[]): the type-compatible entities it may merge into.
   * @return (ResolutionDecision): the decision, with reason "llm" when the LLM confirmed it.
   */
  async resolve(candidate: ParsedEntityInput, existing: readonly Entity[]): Promise<ResolutionDecision> {
    const decision = this.lexical.decide(candidate, existing);
    if (decision.target_id !== null) return decision;
    const [low, high] = this.band;
    const ckey = ops.entityTypeKey(candidate.type);
    const band = existing
      .filter((ent) => ops.entityTypeKey(ent.type) === ckey && !distinctNames(candidate.name, ent.name, low))
      .map((ent) => [nameSimilarity(candidate.name, ent.name), ent] as const)
      .filter(([s]) => low <= s && s < high)
      .sort((p, q) => q[0] - p[0] || comparePy(p[1].id, q[1].id));
    for (const [similarity, ent] of band.slice(0, this.max_questions)) {
      const answer = await this.llm.generate({
        system: LLM_SYSTEM,
        user: question(candidate, ent),
        output: SameEntity,
      });
      const parsed = SameEntity.safeParse(answer);
      if (!parsed.success) {
        throw new ExtractionError("LLM client returned an invalid result for the resolver: same must be a boolean", {
          code: "invalid_llm_output",
          field: "same",
        });
      }
      if (parsed.data.same) return { target_id: ent.id, confidence: similarity, reason: "llm" };
    }
    return noMatch();
  }
}

/**
 * Reject a resolver argument that is neither a mode name nor an object with a resolve method.
 *
 * @param value (unknown): the resolver argument.
 */
export function requireResolver(value: unknown): void {
  if (typeof value === "string") {
    requireMode("resolver", value, RESOLVER_MODES);
    return;
  }
  if (typeof (value as { resolve?: unknown } | null)?.resolve !== "function") {
    throw new ValidationError(
      `resolver must be 'exact', 'default', 'fuzzy', 'llm', or an EntityResolver, got ${typeName(value)}`,
    );
  }
}

/**
 * Turn a resolver argument into a resolver, or null for exact matching.
 *
 * @param value (EntityResolver | ResolverMode): "exact", "default", "fuzzy", "llm", or an EntityResolver.
 * @param llm (LLMClient | null): the graph's LLM, needed for "llm".
 * @return (EntityResolver | null): the resolver, or null for "exact".
 */
export function asResolver(value: EntityResolver | ResolverMode, llm: LLMClient | null): EntityResolver | null {
  requireResolver(value);
  if (value === "exact") return null;
  if (value === "default") return new DefaultResolver();
  if (value === "fuzzy") return new DefaultResolver({ fuzzy: true });
  if (value === "llm") {
    if (llm === null) {
      throw needsLlm("resolver 'llm'");
    }
    return new LLMResolver(llm);
  }
  return value;
}

/**
 * Build a resolver from a mode or an object, lowering a mode to the cost cap.
 *
 * @param value (EntityResolver | ResolverMode): the mode name or a resolver object.
 * @param llm (LLMClient | null): the graph's LLM, needed for "llm".
 * @param maxTier (Level): the cost cap.
 * @return ([string, EntityResolver | null]): the tier name, "custom" for an object, and the resolver.
 */
export function resolverFor(
  value: EntityResolver | ResolverMode,
  llm: LLMClient | null,
  maxTier: Level,
): [string, EntityResolver | null] {
  if (typeof value !== "string") return ["custom", asResolver(value, llm)];
  requireResolver(value);
  const tier = clamp("resolution", value, maxTier) as ResolverMode;
  return [tier, asResolver(tier, llm)];
}

/**
 * The case-folded entity type keys a type may merge with: itself, plus schema ancestors, descendants, and aliases.
 *
 * @param etype (string): the cleaned entity type.
 * @param schema (ParsedSchema | null): the active schema.
 * @return (Set<string>): the compatible case-folded type keys.
 */
function compatibleTypes(etype: string, schema: ParsedSchema | null): Set<string> {
  const out = new Set([ops.entityTypeKey(etype)]);
  if (schema === null) return out;
  const index = entityIndex(schema);
  const own = index.get(canonicalEntityType(etype, schema));
  if (own === undefined) return out;
  const related = new Set([...lineage(own, index)].map((t) => t.name));
  for (const ent of schema.entities) {
    if ([...lineage(ent, index)].some((t) => t.name === own.name)) related.add(ent.name);
  }
  for (const ent of schema.entities) {
    if (related.has(ent.name)) {
      for (const name of [ent.name, ...ent.aliases]) out.add(ops.entityTypeKey(name));
    }
  }
  return out;
}

interface PendingMerge {
  absorbed_id: string;
  survivor_id: string;
  candidate: ParsedEntityInput;
  decision: { confidence: number; reason: string };
  added_aliases: string[];
  added_external_ids: string[];
  added_properties: string[];
  rewrites: MergeRewrite[];
}

/**
 * Record the aliases, external id keys, and property keys a fold added to the survivor.
 *
 * @param merge (PendingMerge): the merge, updated in place.
 * @param added ([string[], string[], string[]]): what absorbInto returned.
 */
function noteAdded(merge: PendingMerge, added: [string[], string[], string[]]): void {
  merge.added_aliases.push(...added[0]);
  merge.added_external_ids.push(...added[1]);
  merge.added_properties.push(...added[2]);
}

export interface Resolution {
  facts: ParsedExtraction;
  merges: PendingMerge[];
  warnings: InsertWarning[];
  /** Each written relation's statements, by statementKey (see statementsOf). */
  via?: Map<string, Set<string>>;
  /** The statements behind each entity's evidence, by entity id: direct, or the ids of the merges that redirected into it. */
  entity_via?: Map<string, Set<string>>;
  /** Each dropped rewrite with the evidence its relation stated, which saveMerges completes with the insert's source evidence. */
  held?: Array<[MergeRewrite, ParsedRelationInput["evidence"]]>;
}

const statementKey = (rel: ParsedRelationInput): string =>
  dumps([ridOf(rel), dumpRelation(rel), rel.evidence as unknown as JsonObject[]]);

/**
 * The statements behind one resolved relation, for the evidence it records (see ops.evidenceVia).
 *
 * A relation the merges rewrote is recorded under the ids of those merges, so an unmerge moves exactly that evidence; one stated directly is recorded as direct. Inputs that resolve to the same relation with the same evidence write the same records, so each record lists all of their statements.
 *
 * @param resolution (Resolution): the resolution the insert planned.
 * @param rel (ParsedRelationInput): a relation of its facts.
 * @return (string[]): the statements.
 */
export function statementsOf(resolution: Resolution, rel: ParsedRelationInput): string[] {
  return [...(resolution.via?.get(statementKey(rel)) ?? [ops.DIRECT])];
}

const ridOf = (rel: ParsedRelationInput): string => rel.id || ids.relationId(rel.from_entity, rel.type, rel.to_entity);
const pidOf = (p: ParsedPreferenceInput): string =>
  p.id || ids.preferenceId(p.subject_entity, p.stance, p.key, p.value_entity);
const tidOf = (d: ParsedDecisionTraceInput): string => d.id || ids.decisionId(d.actor_entity, d.title);

const isoOrNull = (d: Date | null): string | null => (d === null ? null : jsonIso(d));

const dumpEntity = (e: ParsedEntityInput): JsonObject => ({
  id: e.id,
  type: e.type,
  name: e.name,
  aliases: [...e.aliases],
  external_ids: { ...e.external_ids },
  properties: { ...e.properties },
});

/**
 * Fold a repeat of a merged candidate into the input recorded for it, as an upsert of the absorbed id would.
 *
 * @param base (ParsedEntityInput): the absorbed input recorded so far.
 * @param ent (ParsedEntityInput): the repeated candidate.
 * @return (ParsedEntityInput): the input unmerge restores, keeping the recorded name and taking the repeat's aliases, external ids, and properties.
 */
function foldAbsorbed(base: ParsedEntityInput, ent: ParsedEntityInput): ParsedEntityInput {
  return {
    ...base,
    aliases: ops.aliasList(base.name, [...base.aliases, ...ent.aliases, ent.name]),
    external_ids: { ...base.external_ids, ...ent.external_ids },
    properties: ops.mergeProps(base.properties, ent.properties),
  };
}

const dumpRelation = (r: ParsedRelationInput): JsonObject => ({
  id: r.id,
  from_entity: r.from_entity,
  type: r.type,
  to_entity: r.to_entity,
  properties: { ...r.properties },
  event_time: isoOrNull(r.event_time),
});

const dumpPreference = (p: ParsedPreferenceInput): JsonObject => ({
  id: p.id,
  subject_entity: p.subject_entity,
  stance: p.stance,
  key: p.key,
  value_entity: p.value_entity,
  about_entity: p.about_entity,
  strength: p.strength,
  properties: { ...p.properties },
  event_time: isoOrNull(p.event_time),
});

const dumpDecision = (d: ParsedDecisionTraceInput): JsonObject => ({
  id: d.id,
  title: d.title,
  steps: [...d.steps],
  actor_entity: d.actor_entity,
  summary: d.summary,
  rationale: d.rationale,
  outcome_entity: d.outcome_entity,
  alternative_entities: [...d.alternative_entities],
  status: d.status,
  event_time: isoOrNull(d.event_time),
});

/**
 * An in-memory entity for a batch input, so later candidates can match it.
 *
 * @param ent (ParsedEntityInput): the input.
 * @param eid (string): its id.
 * @param etype (string): its cleaned type.
 * @param ename (string): its cleaned name.
 * @param at (Date): the insert time.
 * @return (Entity): the view.
 */
function viewOf(ent: ParsedEntityInput, eid: string, etype: string, ename: string, at: Date): Entity {
  return {
    id: eid,
    type: etype,
    name: ename,
    aliases: ops.aliasList(ename, ent.aliases),
    external_ids: { ...ent.external_ids },
    properties: { ...ent.properties },
    source_count: 0,
    created_at: at,
    updated_at: at,
    relevance: null,
    relevance_at: null,
  };
}

/**
 * Fold an input into an in-memory view; a merge only fills keys the view lacks, so the survivor's values win.
 *
 * @param view (Entity): the target view, updated in place.
 * @param ent (ParsedEntityInput): the input being folded in.
 * @param ename (string): the input's cleaned name.
 * @param merge (boolean): fold as a merge (fill missing keys only) rather than as an upsert of the same id (input wins).
 * @return ([string[], string[], string[]]): the aliases, external id keys, and property keys the view did not have.
 */
function absorbInto(view: Entity, ent: ParsedEntityInput, ename: string, merge = true): [string[], string[], string[]] {
  const aliases = ops.aliasList(view.name, [ename, ...ent.aliases]).filter((f) => !view.aliases.includes(f));
  const external = Object.keys(ent.external_ids).filter((k) => !Object.hasOwn(view.external_ids, k));
  const given = ops.canonProps(ent.properties);
  const props = Object.keys(given).filter((k) => !Object.hasOwn(view.properties, k) && given[k] !== null);
  view.aliases = [...view.aliases, ...aliases];
  if (merge) {
    view.external_ids = { ...view.external_ids, ...Object.fromEntries(external.map((k) => [k, ent.external_ids[k]!])) };
    view.properties = { ...view.properties, ...Object.fromEntries(props.map((k) => [k, given[k]!])) };
  } else {
    view.external_ids = { ...view.external_ids, ...ent.external_ids };
    view.properties = ops.mergeProps(view.properties, ent.properties);
  }
  return [aliases, external, props];
}

/**
 * The input that folds a merged candidate into its target through the normal upsert alias path.
 *
 * @param ent (ParsedEntityInput): the candidate, already folded into the target view.
 * @param target (Entity): the target view, whose values win for every key the candidate shares with it.
 * @return (ParsedEntityInput): an input with the target's id, name, and type, the candidate's surface forms as aliases, and the target's values for the candidate's external id and property keys.
 */
function redirect(ent: ParsedEntityInput, target: Entity): ParsedEntityInput {
  return parseOrThrow(
    EntityInput,
    {
      id: target.id,
      type: target.type,
      name: target.name,
      aliases: [...ent.aliases, ent.name],
      external_ids: Object.fromEntries(Object.keys(ent.external_ids).map((k) => [k, target.external_ids[k]!])),
      properties: Object.fromEntries(
        Object.keys(ent.properties)
          .filter((k) => Object.hasOwn(target.properties, k))
          .map((k) => [k, target.properties[k]!]),
      ),
    },
    "entity",
  );
}

/**
 * Resolve each new entity without an explicit id against compatible stored and batch entities, and rewrite refs.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param facts (ParsedExtraction): the validated facts.
 * @param resolver (EntityResolver): the resolver.
 * @param schema (ParsedSchema | null): the active schema, for parent-closure type compatibility.
 * @param createdAt (Date): the insert time.
 * @return (Resolution): the rewritten facts, the merges it carries, and merge_self_loop warnings.
 */
export async function planResolution(
  runner: Runner,
  ns: string,
  facts: ParsedExtraction,
  resolver: EntityResolver,
  schema: ParsedSchema | null,
  createdAt: Date,
): Promise<Resolution> {
  const keyed = facts.entities.map((ent) => {
    const etype = ops.cleanText(ent.type);
    const ename = ops.cleanText(ent.name);
    return { ent, eid: ent.id || ids.entityId(etype, ename), etype, ename };
  });
  const found = await ops.nodesById(runner, ns, L_ENTITY, ops.dedupList(keyed.map((k) => k.eid)));
  const stored = new Set(found.keys());
  const candidateTypes = new Set(keyed.filter((k) => !k.ent.id && !stored.has(k.eid)).map((k) => k.etype));
  if (!candidateTypes.size) return { facts, merges: [], warnings: [] };
  const wanted = new Set<string>();
  for (const etype of candidateTypes) for (const t of compatibleTypes(etype, schema)) wanted.add(t);
  const fallbackForms = new Set(
    keyed
      .filter((k) => ops.entityTypeKey(k.etype) === FALLBACK_KEY && !k.ent.id)
      .flatMap((k) => [...formsOf(k.ent.name, k.ent.aliases)]),
  );
  const named = new Set(keyed.map((k) => k.eid));
  const keep = (props: Props): boolean =>
    wanted.has(ops.entityTypeKey(props.type as string)) ||
    named.has(props.id as string) ||
    overlaps(formsOf(props.name as string, (props.aliases as string[] | null) ?? []), fallbackForms);
  async function* candidates(): AsyncGenerator<Props[]> {
    if (
      runner.entitiesMatching &&
      resolver instanceof DefaultResolver &&
      resolver.constructor === DefaultResolver &&
      !resolver.fuzzy
    ) {
      const fresh = keyed.filter((k) => !k.ent.id && !stored.has(k.eid));
      const keys = new Set(fresh.flatMap((k) => [...matchKeys(k.ent.name, k.ent.aliases, k.ent.external_ids)]));
      yield [...found.values(), ...(await runner.entitiesMatching(ns, keys))];
      return;
    }
    yield* ops.keyset((after, limit) => runner.matchNodes(ns, L_ENTITY, { equals: {}, limit, id_gt: after }));
  }
  const pool = new Map<string, Entity>();
  for await (const rows of candidates()) {
    for (const ent of rows.filter(keep).map(decodeEntity)) pool.set(ent.id, ent);
  }

  const within = resolver.within_batch ?? true;
  const batch = new Map<string, Entity>();
  const mapping = new Map<string, string>();
  const merges = new Map<string, PendingMerge>();
  const entities: ParsedEntityInput[] = [...facts.entities];
  const redirected = new Map<number, [string, string]>();
  const order = keyed.map((_, i) => i);
  order.sort(
    (a, b) =>
      Number(ops.entityTypeKey(keyed[a]!.etype) === FALLBACK_KEY) -
      Number(ops.entityTypeKey(keyed[b]!.etype) === FALLBACK_KEY),
  );
  for (const i of order) {
    const { ent, eid, etype, ename } = keyed[i]!;
    const merged = merges.get(eid);
    if (merged !== undefined) {
      const target = pool.get(merged.survivor_id) ?? batch.get(merged.survivor_id)!;
      noteAdded(merged, absorbInto(target, ent, ename));
      merged.candidate = foldAbsorbed(merged.candidate, ent);
      entities[i] = redirect(ent, target);
      redirected.set(i, [target.id, ids.entityMergeId(target.id, eid)]);
      continue;
    }
    if (ent.id || stored.has(eid) || batch.has(eid)) {
      const view = pool.get(eid) ?? batch.get(eid);
      if (view !== undefined) absorbInto(view, ent, ename, false);
      else if (ent.id && !stored.has(eid)) batch.set(eid, viewOf(ent, eid, etype, ename, createdAt));
      continue;
    }
    const fallback = ops.entityTypeKey(etype) === FALLBACK_KEY;
    const compatible = compatibleTypes(etype, schema);
    const existing = [...pool.values()]
      .filter((e) => compatible.has(ops.entityTypeKey(e.type)) || (fallback && surfaceMatch(ent, e)))
      .sort((a, b) => comparePy(a.id, b.id));
    existing.push(
      ...[...batch.values()].filter(
        (e) =>
          (compatible.has(ops.entityTypeKey(e.type)) && within) ||
          (fallback && !compatible.has(ops.entityTypeKey(e.type)) && surfaceMatch(ent, e)),
      ),
    );
    const decision = await resolver.resolve(ent, existing);
    if (
      typeof decision !== "object" ||
      decision === null ||
      (decision.target_id != null && typeof decision.target_id !== "string")
    ) {
      throw new ValidationError(`a resolver must return a ResolutionDecision, got ${typeName(decision)}`, {
        code: "invalid_resolver_decision",
      });
    }
    if (decision.target_id == null) {
      batch.set(eid, viewOf(ent, eid, etype, ename, createdAt));
      continue;
    }
    for (const [name, kind] of [
      ["confidence", "number"],
      ["reason", "string"],
    ] as const) {
      if (decision[name] == null) {
        throw new ValidationError(
          `resolver decision merging ${pyRepr(eid)} into ${pyRepr(decision.target_id)} is missing ${name}; ` +
            "a decision with a target_id needs confidence and reason",
          { code: "invalid_resolver_decision" },
        );
      }
      if (typeof decision[name] !== kind) {
        throw new ValidationError(`resolver decision ${name} must be a ${kind}, got ${typeName(decision[name])}`);
      }
    }
    const target = existing.find((e) => e.id === decision.target_id);
    if (target === undefined) {
      throw new ValidationError(
        `resolver chose ${pyRepr(decision.target_id)} for ${pyRepr(eid)}, ` +
          "which is not one of the compatible entities it was offered",
        { code: "invalid_resolver_decision" },
      );
    }
    mapping.set(eid, target.id);
    const merge: PendingMerge = {
      absorbed_id: eid,
      survivor_id: target.id,
      candidate: ent,
      decision: { confidence: decision.confidence as number, reason: decision.reason as string },
      added_aliases: [],
      added_external_ids: [],
      added_properties: [],
      rewrites: [],
    };
    noteAdded(merge, absorbInto(target, ent, ename));
    merges.set(eid, merge);
    entities[i] = redirect(ent, target);
    redirected.set(i, [target.id, ids.entityMergeId(target.id, eid)]);
  }
  if (!mapping.size) return { facts, merges: [], warnings: [] };
  const entityVia = new Map<string, Set<string>>();
  for (const [i, { eid }] of keyed.entries()) {
    const [target, statement] = redirected.get(i) ?? [eid, ops.DIRECT];
    entityVia.set(target, (entityVia.get(target) ?? new Set<string>()).add(statement));
  }
  const warnings: InsertWarning[] = [];
  const via = new Map<string, Set<string>>();
  const held: Array<[MergeRewrite, ParsedRelationInput["evidence"]]> = [];
  const rewritten = await rewriteRefs(runner, ns, facts, mapping, merges, warnings, via, held);
  return {
    facts: { ...rewritten, entities },
    merges: [...merges.values()],
    warnings,
    via,
    entity_via: entityVia,
    held,
  };
}

/**
 * Drop planned merges and rewrites whose survivor or rewritten item was removed by dropOffSchema.
 *
 * @param resolution (Resolution): the planned resolution before schema dropping.
 * @param kept (ParsedExtraction): the facts kept after dropOffSchema.
 * @return (Resolution): the resolution aligned to kept.
 */
export function trimResolution(resolution: Resolution, kept: ParsedExtraction): Resolution {
  const entities = new Set(kept.entities.map((ent) => ent.id || ids.entityId(ent.type, ent.name)));
  const keptByKind = {
    relation: new Set(kept.relations.map(ridOf)),
    preference: new Set(kept.preferences.map(pidOf)),
    decision: new Set(kept.decisions.map(tidOf)),
  };
  const merges: PendingMerge[] = [];
  for (const merge of resolution.merges) {
    if (!entities.has(merge.survivor_id)) continue;
    merges.push({
      ...merge,
      rewrites: merge.rewrites.filter((r) => r.dropped || keptByKind[r.kind].has(r.id)),
    });
  }
  const warnings = resolution.warnings.filter((w) =>
    [...entities].some((eid) => w.message.includes(`join ${eid} to itself`)),
  );
  return {
    facts: kept,
    merges,
    warnings,
    via: resolution.via,
    entity_via: resolution.entity_via,
    held: resolution.held,
  };
}

/**
 * Point every reference to a merged candidate at its target and record each rewrite on the merges it involves. A relation between two different entities that the merge would join into a self-loop is dropped, with a merge_self_loop warning; its rewrite is still recorded, marked dropped, so unmerging restores it.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param facts (ParsedExtraction): the facts.
 * @param mapping (Map<string, string>): candidate id to target id.
 * @param merges (Map<string, PendingMerge>): the merges by candidate id.
 * @param warnings (InsertWarning[]): receives one merge_self_loop warning per dropped relation.
 * @param via (Map<string, Set<string>>): receives each written relation's statements (see statementsOf).
 * @param held (Array<[MergeRewrite, ParsedRelationInput["evidence"]]>): receives each dropped rewrite with the evidence its relation stated, which saveMerges completes with the insert's source evidence.
 * @return (ParsedExtraction): the facts with rewritten relations, preferences, and decisions.
 */
async function rewriteRefs(
  runner: Runner,
  ns: string,
  facts: ParsedExtraction,
  mapping: Map<string, string>,
  merges: Map<string, PendingMerge>,
  warnings: InsertWarning[],
  via: Map<string, Set<string>>,
  held: Array<[MergeRewrite, ParsedRelationInput["evidence"]]>,
): Promise<ParsedExtraction> {
  const m = <T extends string | null>(eid: T): T => (eid === null ? eid : ((mapping.get(eid) ?? eid) as T));
  const note = (rewrite: MergeRewrite, refs: Set<string>): void => {
    for (const eid of [...refs].filter((r) => mapping.has(r)).sort(comparePy)) merges.get(eid)!.rewrites.push(rewrite);
  };
  const state = (rel: ParsedRelationInput, statement: string): void => {
    const key = statementKey(rel);
    via.set(key, (via.get(key) ?? new Set<string>()).add(statement));
  };
  const touched = facts.relations.map((rel) => mapping.has(rel.from_entity) || mapping.has(rel.to_entity));
  const keptRids = new Set(facts.relations.filter((_, i) => !touched[i]).map(ridOf));
  const relMap = new Map<string, string>();
  const relRefs = new Map<string, Set<string>>();
  const dropped = new Set<string>();
  const relations: ParsedRelationInput[] = [];
  for (const [i, rel] of facts.relations.entries()) {
    if (!touched[i]) {
      state(rel, ops.DIRECT);
      relations.push(rel);
      continue;
    }
    const next = { ...rel, from_entity: m(rel.from_entity), to_entity: m(rel.to_entity) };
    const oldId = ridOf(rel);
    const newId = ridOf(next);
    const refs = new Set([rel.from_entity, rel.to_entity]);
    relRefs.set(oldId, refs);
    const existed = keptRids.has(newId) || (await ops.relationExists(runner, ns, newId));
    const loop = next.from_entity === next.to_entity && rel.from_entity !== rel.to_entity;
    const rewrite: MergeRewrite = {
      kind: "relation",
      id: newId,
      original: dumpRelation(rel),
      rewritten: dumpRelation(next),
      existed,
      dropped: loop,
      evidence: [],
    };
    note(rewrite, refs);
    if (loop) {
      held.push([rewrite, rel.evidence]);
      dropped.add(oldId);
      warnings.push(
        insertWarning(
          "merge_self_loop",
          `relation ${oldId} (${rel.from_entity} -${rel.type}-> ${rel.to_entity}) would join ` +
            `${next.from_entity} to itself after a merge and was dropped; unmerging restores it`,
        ),
      );
      continue;
    }
    relMap.set(oldId, newId);
    state(next, ops.viaOf([...refs].filter((r) => mapping.has(r)).map((r) => ids.entityMergeId(mapping.get(r)!, r))));
    relations.push(next);
  }

  const preferences: ParsedPreferenceInput[] = [];
  for (const pref of facts.preferences) {
    const refs = new Set([pref.subject_entity, pref.value_entity, ...(pref.about_entity ? [pref.about_entity] : [])]);
    if (![...refs].some((r) => mapping.has(r))) {
      preferences.push(pref);
      continue;
    }
    const next = {
      ...pref,
      subject_entity: m(pref.subject_entity),
      value_entity: m(pref.value_entity),
      about_entity: m(pref.about_entity),
    };
    const newId = pidOf(next);
    const existed = await ops.preferenceExists(runner, ns, newId);
    note(
      {
        kind: "preference",
        id: newId,
        original: dumpPreference(pref),
        rewritten: dumpPreference(next),
        existed,
        dropped: false,
        evidence: [],
      },
      refs,
    );
    preferences.push(next);
  }

  const decisions: ParsedDecisionTraceInput[] = [];
  for (const dec of facts.decisions) {
    const refs = new Set(
      [dec.actor_entity, dec.outcome_entity, ...dec.alternative_entities].filter((r): r is string => r !== null),
    );
    for (const step of dec.steps) for (const r of relRefs.get(step) ?? []) refs.add(r);
    if (![...refs].some((r) => mapping.has(r))) {
      decisions.push(dec);
      continue;
    }
    const next = {
      ...dec,
      actor_entity: m(dec.actor_entity),
      outcome_entity: m(dec.outcome_entity),
      alternative_entities: dec.alternative_entities.map(m),
      steps: dec.steps.filter((s) => !dropped.has(s)).map((s) => relMap.get(s) ?? s),
    };
    const newId = tidOf(next);
    const existed = await runner.nodeExists(ns, L_TRACE, newId);
    note(
      {
        kind: "decision",
        id: newId,
        original: dumpDecision(dec),
        rewritten: dumpDecision(next),
        existed,
        dropped: false,
        evidence: [],
      },
      refs,
    );
    decisions.push(next);
  }
  return { ...facts, relations, preferences, decisions };
}

/**
 * The merge record node, without its sources and rewrites, which live in EntityMergeEntry rows.
 *
 * @param ns (string): the namespace.
 * @param rec (MergeRecord): the record.
 * @return (Props): the node properties.
 */
function encodeMerge(ns: string, rec: MergeRecord): Props {
  return {
    id: rec.id,
    ns,
    survivor_id: rec.survivor_id,
    absorbed_id: rec.absorbed_id,
    reason: rec.reason,
    confidence: rec.confidence,
    source_id: rec.source_id,
    absorbed_json: dumps(rec.absorbed),
    added_aliases_json: dumps(rec.added_aliases),
    added_external_ids_json: dumps(rec.added_external_ids),
    added_properties_json: dumps(rec.added_properties),
    source_entries: rec.source_ids.length,
    rewrite_entries: rec.rewrites.length,
    created_at: toIso(rec.created_at),
    reverted_at: toIso(rec.reverted_at),
  };
}

/**
 * One row per source and per rewrite of a merge record, keyed by a position that never moves.
 *
 * @param ns (string): the namespace.
 * @param rec (MergeRecord): the record.
 * @return (Map<string, Props>): the entry node properties by entry id.
 */
function entryRows(ns: string, rec: MergeRecord): Map<string, Props> {
  const rows = new Map<string, Props>();
  const kinds: Array<[string, readonly unknown[]]> = [
    ["source", rec.source_ids],
    ["rewrite", rec.rewrites],
  ];
  for (const [kind, values] of kinds) {
    values.forEach((value, seq) => {
      const id = ids.mergeEntryId(rec.id, kind, seq);
      rows.set(id, { id, ns, merge_id: rec.id, kind, seq, value_json: dumps(value) });
    });
  }
  return rows;
}

/**
 * Read the source and rewrite rows of some stored merge records, by id from the counts each record keeps.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param records (readonly Props[]): the stored merge record nodes.
 * @return (Map<string, Props[]>): each record's entry rows, in no particular order.
 */
async function loadEntries(runner: Runner, ns: string, records: readonly Props[]): Promise<Map<string, Props[]>> {
  const found = new Map<string, Props[]>(records.map((props) => [props.id as string, []]));
  const wanted: string[] = [];
  for (const props of records) {
    for (const kind of ["source", "rewrite"]) {
      const count = Number(props[`${kind}_entries`] ?? 0) || 0;
      for (let seq = 0; seq < count; seq++) wanted.push(ids.mergeEntryId(props.id as string, kind, seq));
    }
  }
  for (const row of (await ops.nodesById(runner, ns, L_MERGE_ENTRY, wanted)).values()) {
    found.get(row.merge_id as string)?.push(row);
  }
  return found;
}

/**
 * Rebuild a merge record from its node and entry rows.
 *
 * @param props (Props): the record node.
 * @param entries (readonly Props[]): its EntityMergeEntry rows.
 * @return (MergeRecord): the record.
 */
function decodeMerge(props: Props, entries: readonly Props[] = []): MergeRecord {
  const listed: Record<string, unknown[]> = { source: [], rewrite: [] };
  for (const row of [...entries].sort((a, b) => Number(a.seq) - Number(b.seq))) {
    listed[row.kind as string]!.push(loads<unknown>(row.value_json, null));
  }
  return {
    id: props.id as string,
    survivor_id: props.survivor_id as string,
    absorbed_id: props.absorbed_id as string,
    absorbed: loads<JsonObject>(props.absorbed_json, {}),
    reason: (props.reason as string | null) || "",
    confidence: Number(props.confidence ?? 0) || 0,
    source_id: (props.source_id as string | null | undefined) ?? null,
    source_ids: listed.source as string[],
    added_aliases: loads<string[]>(props.added_aliases_json, []),
    added_external_ids: loads<string[]>(props.added_external_ids_json, []),
    added_properties: loads<string[]>(props.added_properties_json, []),
    rewrites: (listed.rewrite as MergeRewrite[]).map((rw) => ({
      ...rw,
      dropped: rw.dropped ?? false,
      evidence: rw.evidence ?? [],
    })),
    created_at: fromIso(props.created_at)!,
    reverted_at: fromIso(props.reverted_at),
  };
}

/**
 * Write merge records, rewriting only the entry rows that are new or changed, so a repeat costs its own rows.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param records (readonly MergeRecord[]): the records to store.
 * @param stored (ReadonlyMap<string, Props[]>): each already stored record's entry rows, by id.
 */
async function writeMerges(
  runner: Runner,
  ns: string,
  records: readonly MergeRecord[],
  stored: ReadonlyMap<string, Props[]>,
): Promise<void> {
  const nodes: Array<readonly [string, Props]> = [];
  const entries: Array<readonly [string, Props]> = [];
  for (const rec of records) {
    const rows = stored.get(rec.id) ?? [];
    nodes.push([rec.id, encodeMerge(ns, rec)]);
    const have = new Map(rows.map((row) => [row.id as string, row.value_json]));
    for (const [id, row] of entryRows(ns, rec)) if (have.get(id) !== row.value_json) entries.push([id, row]);
  }
  ops.precheckNodes(runner, ns, L_MERGE_ENTRY, entries);
  ops.precheckNodes(runner, ns, L_MERGE, nodes);
  if (entries.length) await runner.upsertNodes(ns, L_MERGE_ENTRY, entries);
  await runner.upsertNodes(ns, L_MERGE, nodes);
}

/**
 * Key a rewrite by what it points at and by its original, so a repeated merge keeps each distinct original.
 *
 * Two statements a merge redirects onto one object each need undoing to their own endpoints, while a repeat of the same statement is the same rewrite.
 *
 * @param rw (MergeRewrite): the recorded rewrite.
 * @return (string): its deduplication key.
 */
function rewriteKey(rw: MergeRewrite): string {
  let original: string;
  if (rw.kind === "relation") original = ridOf(parseOrThrow(RelationInput, rw.original, "relation"));
  else if (rw.kind === "preference") original = pidOf(parseOrThrow(PreferenceInput, rw.original, "preference"));
  else original = tidOf(parseOrThrow(DecisionTraceInput, rw.original, "decision"));
  return dumps([rw.kind, rw.id, original]);
}

/**
 * Add the rewrites a repeat of a merge brings, and the evidence it gives each dropped one already recorded.
 *
 * @param prev (readonly MergeRewrite[]): the rewrites recorded so far.
 * @param fresh (readonly MergeRewrite[]): the repeat's rewrites.
 * @return (MergeRewrite[]): the rewrites to record.
 */
function foldRewrites(prev: readonly MergeRewrite[], fresh: readonly MergeRewrite[]): MergeRewrite[] {
  const where = new Map(prev.map((rw, i) => [rewriteKey(rw), i] as const));
  const out = [...prev];
  for (const rw of fresh) {
    const i = where.get(rewriteKey(rw));
    if (i === undefined) out.push(rw);
    else if (rw.dropped) {
      const kept = new Map([...out[i]!.evidence, ...rw.evidence].map((ev) => [dumps(ev), ev] as const));
      out[i] = { ...out[i]!, evidence: [...kept.values()] };
    }
  }
  return out;
}

/**
 * Write one record per merge, folding a repeat of the same merge into its live record so inserts stay idempotent.
 *
 * A dropped relation has no stored evidence to carry back, so its rewrite keeps the evidence it would have recorded.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param resolution (Resolution): the planned merges.
 * @param sourceId (string | null): the inserted source, if any.
 * @param sourceVersion (string | null): the inserted source's version, if any.
 * @param evidence (readonly Evidence[]): the insert's source-level evidence, empty without a source.
 * @param createdAt (Date): the insert time.
 * @return (MergeRecord[]): the stored records, in candidate order.
 */
export async function saveMerges(
  runner: Runner,
  ns: string,
  resolution: Resolution,
  sourceId: string | null,
  sourceVersion: string | null,
  evidence: readonly Evidence[],
  createdAt: Date,
): Promise<MergeRecord[]> {
  if (!resolution.merges.length) return [];
  for (const [rewrite, own] of resolution.held ?? []) {
    rewrite.evidence = ops.relationEvidence(own, [...evidence], sourceId, sourceVersion);
  }
  const keyed = resolution.merges.map((m) => [ids.entityMergeId(m.survivor_id, m.absorbed_id), m] as const);
  const stored = await ops.nodesById(
    runner,
    ns,
    L_MERGE,
    keyed.map(([mid]) => mid),
  );
  const entries = await loadEntries(runner, ns, [...stored.values()]);
  const records: MergeRecord[] = [];
  for (const [mid, merge] of keyed) {
    let rec: MergeRecord = {
      id: mid,
      survivor_id: merge.survivor_id,
      absorbed_id: merge.absorbed_id,
      absorbed: { ...dumpEntity(merge.candidate), id: merge.absorbed_id },
      reason: merge.decision.reason,
      confidence: merge.decision.confidence,
      source_id: sourceId,
      source_ids: sourceId === null ? [] : [sourceId],
      added_aliases: merge.added_aliases,
      added_external_ids: merge.added_external_ids,
      added_properties: merge.added_properties,
      rewrites: merge.rewrites,
      created_at: createdAt,
      reverted_at: null,
    };
    const prevProps = stored.get(mid);
    const prev = prevProps === undefined ? null : decodeMerge(prevProps, entries.get(mid));
    if (prev !== null && prev.reverted_at === null) {
      rec = {
        ...prev,
        source_ids: ops.dedupList([...prev.source_ids, ...rec.source_ids]),
        absorbed: dumpEntity(foldAbsorbed(parseOrThrow(EntityInput, prev.absorbed, "entity"), merge.candidate)),
        added_aliases: ops.dedupList([...prev.added_aliases, ...merge.added_aliases]),
        added_external_ids: ops.dedupList([...prev.added_external_ids, ...merge.added_external_ids]),
        added_properties: ops.dedupList([...prev.added_properties, ...merge.added_properties]),
        rewrites: foldRewrites(prev.rewrites, merge.rewrites),
      };
    }
    records.push(rec);
  }
  await writeMerges(runner, ns, records, entries);
  return records;
}

/**
 * One entity_merged warning per merge, so callers notice that an entity was folded into another.
 *
 * @param records (readonly MergeRecord[]): the merges.
 * @return (InsertWarning[]): the warnings.
 */
export function mergeWarnings(records: readonly MergeRecord[]): InsertWarning[] {
  return records.map((rec) => ({
    code: "entity_merged",
    message:
      `entity ${rec.absorbed_id} merged into ${rec.survivor_id} ` +
      `(${rec.reason}, confidence ${pyFloatRepr(rec.confidence)}, merge id ${rec.id}); undo with unmerge`,
    source_id: rec.source_id,
    chunk_id: null,
    merge_id: rec.id,
  }));
}

/**
 * List the merge records whose survivor is an entity, ordered by merge id.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param entityId (string): the surviving entity id.
 * @param skip (number): rows to skip.
 * @param limit (number): maximum rows.
 * @return (MergeRecord[]): the records; throws NotFoundError for an unknown entity with no records.
 */
export async function listMerges(
  runner: Runner,
  ns: string,
  given: string,
  skip: number,
  limit: number,
): Promise<MergeRecord[]> {
  const entityId = ids.canonicalEntityId(given);
  const rows = await runner.matchNodes(ns, L_MERGE, { equals: { survivor_id: entityId }, skip, limit });
  if (!rows.length && skip === 0 && !(await runner.nodeExists(ns, L_ENTITY, entityId))) {
    throw await ops.missingEntity(runner, ns, entityId);
  }
  return decodeMerges(runner, ns, rows);
}

/**
 * Rebuild stored merge records with their source and rewrite entries, in the order given.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rows (readonly Props[]): the stored merge record nodes.
 * @return (MergeRecord[]): the records.
 */
export async function decodeMerges(runner: Runner, ns: string, rows: readonly Props[]): Promise<MergeRecord[]> {
  const entries = await loadEntries(runner, ns, rows);
  return rows.map((r) => decodeMerge(r, entries.get(r.id as string)));
}

type Moved = Array<[MergeRewrite, MergeRewrite]>;

interface Split {
  carried: Array<[Evidence, string[]]>;
  changed: Array<[Props, string[]]>;
  emptied: string[];
  sources: Set<string>;
}

/**
 * The via entry of the statement one rewrite redirected: this merge and each other merge still redirecting it.
 *
 * An endpoint whose rewritten id differs from its original is still redirected by the merge of that original into that survivor, so a statement two merges redirect is told apart from one only this merge redirects.
 *
 * @param rw (MergeRewrite): a relation rewrite of the merge being reverted, as forwarded so far.
 * @param mergeId (string): the merge being reverted.
 * @return (string): the entry, as ops.viaOf gives it.
 */
function statementOf(rw: MergeRewrite, mergeId: string): string {
  const ends = (["from_entity", "to_entity"] as const).map((k) => [rw.original[k], rw.rewritten[k]] as const);
  const others = ends
    .filter(([old, next]) => old !== next)
    .map(([old, next]) => ids.entityMergeId(next as string, old as string));
  return ops.viaOf([mergeId, ...others]);
}

/**
 * Split a relation's evidence between the statement one rewrite carried onto it and the ones that stay.
 *
 * Each row lists the statements that wrote it (see ops.evidenceVia). The rewrite's statement moves with the merge, minus that merge's id, so a row another merge also carried keeps that merge on its new relation. Every other statement, stated directly, by another merge, or by another rewrite of this one, stays, so a row both kinds wrote is on both relations.
 *
 * @param rows (Props[]): the relation's stored evidence rows.
 * @param statement (string): the rewrite's statement, from statementOf.
 * @param mergeId (string): the merge being reverted.
 * @return (Split): the evidence to carry, each with its statements there; each row that stays with fewer statements; the rows no statement backs any more; and the distinct sources of the rows that stay.
 */
function splitEvidence(rows: Props[], statement: string, mergeId: string): Split {
  const out: Split = { carried: [], changed: [], emptied: [], sources: new Set() };
  const moved = ops.viaOf(statement.split(" ").filter((m) => m !== mergeId));
  for (const row of rows) {
    const statements = ops.evidenceVia(row);
    const rest = statements.filter((s) => s !== statement);
    if (rest.length < statements.length) {
      out.carried.push([decodeEvidence(row), [moved]]);
      if (rest.length) out.changed.push([row, rest]);
      else out.emptied.push(row.id as string);
    }
    if (rest.length) out.sources.add(row.source_id as string);
  }
  return out;
}

/**
 * Take a merge's statements off a relation that stays, and recount the distinct sources its evidence keeps.
 *
 * The count is written before any row is changed or deleted, so a write that fails partway leaves the merge's rows in place and a retried unmerge finds them again; the evidence was already carried to the restored relation.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param relationId (string): the relation the merge rewrote onto.
 * @param split (Split): what splitEvidence found on it.
 * @return (Promise<void>): nothing.
 */
async function leaveEvidence(runner: Runner, ns: string, relationId: string, split: Split): Promise<void> {
  const edge = await runner.getCurrentEdge(ns, relationId);
  if (edge !== null && edge.props.source_count !== split.sources.size) {
    await runner.updateCurrentEdge(ns, relationId, { source_count: split.sources.size });
  }
  await writeSplit(runner, ns, split);
}

/**
 * Rewrite the evidence rows that keep fewer statements and delete the ones no statement backs.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param split (Split): what splitEvidence found.
 * @return (Promise<void>): nothing.
 */
async function writeSplit(runner: Runner, ns: string, split: Split): Promise<void> {
  if (split.changed.length) {
    const rows = split.changed.map(
      ([row, rest]) =>
        [row.id as string, { ...row, via: rest.length === 1 && rest[0] === ops.DIRECT ? null : rest }] as const,
    );
    await runner.upsertNodes(ns, L_EVIDENCE, rows);
  }
  if (split.emptied.length) await runner.deleteNodes(ns, L_EVIDENCE, split.emptied);
}

/**
 * Take a merge's statement off the survivor's evidence, and recount the distinct sources its evidence keeps.
 *
 * The count is written before any row is changed or deleted, as leaveEvidence does, and the evidence was already carried to the restored entity.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param entityId (string): the surviving entity.
 * @param split (Split): what splitEvidence found on it.
 * @return (Promise<void>): nothing.
 */
async function leaveEntityEvidence(runner: Runner, ns: string, entityId: string, split: Split): Promise<void> {
  const props = await runner.getNode(ns, L_ENTITY, entityId);
  if (props !== null && props.source_count !== split.sources.size) {
    await runner.upsertNodes(ns, L_ENTITY, [[entityId, { ...props, source_count: split.sources.size }]], {
      extra_label: props.type as string,
    });
  }
  await writeSplit(runner, ns, split);
}

const ENDING_KEYS = ["is_current", "invalidated_at", "invalidated_by", "invalidated_known_at"];

/**
 * Whether a relation version is what the statements, landing in some order, made of the version before.
 *
 * Each statement writes its event time and its properties over the earlier ones, so the event time and each property of the result come from one of the statements that gave it, and from the version before when none did.
 *
 * @param before (Relation): the version before the statements.
 * @param stated ({ properties: JsonObject; event_time?: Date | null }[]): the statements.
 * @param newest (Relation): the version after them.
 * @return (boolean): true when nothing but the statements shaped it.
 */
function explained(
  before: Relation,
  stated: { properties: JsonObject; event_time?: Date | null }[],
  newest: Relation,
): boolean {
  const times = stated.map((r) => toIso(r.event_time)).filter((time) => time !== null);
  if (!(times.length ? times : [toIso(before.event_time)]).includes(toIso(newest.event_time))) return false;
  const keys = new Set([...Object.keys(before.properties), ...Object.keys(newest.properties)]);
  for (const r of stated) for (const key of Object.keys(r.properties)) keys.add(key);
  for (const key of keys) {
    const said = stated.filter((r) => key in r.properties).map((r) => r.properties[key]);
    const outcomes = said.length
      ? said.map((value) => ops.mergeProps({}, { [key]: value })[key])
      : [before.properties[key]];
    if (!outcomes.some((outcome) => deepEqual(newest.properties[key], outcome))) return false;
  }
  return true;
}

/**
 * Put a relation that existed before the merge back to the version it had, when only the merge wrote after it.
 *
 * The versions the merge insert wrote carry its created_at. They are removed, and the version before them takes the place of the newest one, current or retired as it was, only when nothing wrote after them, nothing certified the relation, and the newest one is what the rewrites of every merge of that insert, reverted ones included, would have made of the version before, in some order. Otherwise a direct statement or a later write shaped the relation, and it stays as it is.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rec (MergeRecord): the merge being reverted.
 * @param rw (MergeRewrite): one of its rewrites onto the existing relation.
 * @return (Promise<void>): nothing.
 */
async function undoRevision(runner: Runner, ns: string, rec: MergeRecord, rw: MergeRewrite): Promise<void> {
  const edges = await ops.relationEdges(runner, ns, rw.id);
  const wrote = edges.map((e) => fromIso(e.props.created_at as string)!.getTime() === rec.created_at.getTime());
  const first = Math.max(0, wrote.indexOf(true));
  if (first === 0 || !wrote.slice(first).every(Boolean)) return;
  const before = ops.relationOf(edges[first - 1]!);
  const newest = ops.relationOf(edges[edges.length - 1]!);
  const rows = await ops.scan(ops.nodeListing(runner, ns, L_MERGE, { equals: { created_at: toIso(rec.created_at) } }));
  const inserted = [rec, ...(await decodeMerges(runner, ns, rows)).filter((m) => m.id !== rec.id)];
  const stated = inserted
    .flatMap((m) => m.rewrites)
    .filter((r) => r.kind === rw.kind && r.id === rw.id && r.existed && !r.dropped)
    .map((r) => parseOrThrow(RelationInput, r.rewritten, "relation"));
  if (
    before.invalidated_at !== null ||
    before.certifications.length > 0 ||
    newest.certifications.length > 0 ||
    !explained(before, stated, newest)
  ) {
    return;
  }
  const kept: EdgeWrite[] = edges.slice(0, first - 1).map((e) => [e.type, e.from_id, e.to_id, e.props]);
  const last = edges[first - 1]!;
  const ended = edges[edges.length - 1]!.props;
  const ending = Object.fromEntries(ENDING_KEYS.map((key) => [key, ended[key] ?? null]));
  kept.push([last.type, last.from_id, last.to_id, { ...last.props, ...ending }]);
  await runner.deleteEdges(ns, rw.id);
  await runner.createEdges(ns, L_ENTITY, L_ENTITY, kept);
}

/**
 * The source version and time that withdrew the last of a relation's evidence, when every record was replaced.
 *
 * Evidence recorded by hand has no stored version and always counts, as in ops.replaceSource.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rows (Props[]): the stored evidence nodes of a relation.
 * @return ([string, Date] | undefined): the replacing version and when it replaced, or undefined when any record stands.
 */
async function withdrawal(runner: Runner, ns: string, rows: Props[]): Promise<[string, Date] | undefined> {
  const stored = await ops.nodesById(
    runner,
    ns,
    L_SOURCE_VERSION,
    ops.dedupList(rows.map((r) => r.source_version as string)),
  );
  const marks = rows.map((r) => stored.get(r.source_version as string));
  if (!marks.length || !marks.every((m) => m?.replaced_by)) return undefined;
  const last = marks.reduce((a, b) => (String(b!.replaced_at) > String(a!.replaced_at) ? b : a))!;
  return [last.replaced_by as string, fromIso(last.replaced_at as string)!];
}

/**
 * List what the other live merges rewrote onto each object, so an unmerge keeps one another merge still backs.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param mergeId (string): the merge being reverted.
 * @return ([Map<string, JsonObject[]>, Props[], Map<string, Props[]>]): the originals each object's live sibling rewrites came from, by JSON.stringify([kind, id]); and the live sibling merges with their entries, for forwardSiblings.
 */
async function siblingRewrites(
  runner: Runner,
  ns: string,
  mergeId: string,
): Promise<[Map<string, JsonObject[]>, Props[], Map<string, Props[]>]> {
  const live = (await scanLiveMerges(runner, ns)).filter((props) => props.id !== mergeId);
  const entries = await loadEntries(runner, ns, live);
  const out = new Map<string, JsonObject[]>();
  for (const props of live) {
    for (const rw of decodeMerge(props, entries.get(props.id as string) ?? []).rewrites) {
      if (rw.dropped) continue;
      const key = JSON.stringify([rw.kind, rw.id]);
      out.set(key, [...(out.get(key) ?? []), rw.original]);
    }
  }
  return [out, live, entries];
}

/**
 * Whether another live merge rewrote a statement this merge did not onto the object this rewrite points at.
 *
 * A sibling with the same original as one of this merge's rewrites onto the object is the same statement seen through its other merged endpoint, which moves with this unmerge, so it does not keep the object.
 *
 * @param rw (MergeRewrite): a rewrite of the merge being reverted.
 * @param rec (MergeRecord): the merge being reverted.
 * @param siblings (Map<string, JsonObject[]>): what siblingRewrites found.
 * @return (boolean): whether the object stays for that merge.
 */
function backedElsewhere(rw: MergeRewrite, rec: MergeRecord, siblings: Map<string, JsonObject[]>): boolean {
  const own = rec.rewrites.filter((r) => r.kind === rw.kind && r.id === rw.id && !r.dropped).map((r) => r.original);
  return (siblings.get(JSON.stringify([rw.kind, rw.id])) ?? []).some(
    (original) => !own.some((mine) => deepEqual(original, mine)),
  );
}

/**
 * Point one rewrite of another merge at where an unmerge put the object it shares with that merge.
 *
 * @param rw (MergeRewrite): a rewrite of a still-live merge.
 * @param moved (Moved): each rewrite the unmerge replayed, with its new location.
 * @param restored (Map<string, string>): the relation ids the unmerge moved, old to new.
 * @return (MergeRewrite): the rewrite to keep on that merge.
 */
function forward(rw: MergeRewrite, moved: Moved, restored: Map<string, string>, handed: Set<string>): MergeRewrite {
  for (const [old, next] of moved) {
    if (rw.kind === old.kind && rw.id === old.id && deepEqual(rw.original, old.original)) return next;
  }
  if (rw.existed && handed.has(JSON.stringify([rw.kind, rw.id]))) return { ...rw, existed: false };
  const steps = rw.rewritten.steps;
  if (rw.kind === "decision" && Array.isArray(steps) && steps.some((s) => restored.has(s as string))) {
    return { ...rw, rewritten: { ...rw.rewritten, steps: steps.map((s) => restored.get(s as string) ?? s) } };
  }
  return rw;
}

/**
 * Update the live merges that share a rewrite with an unmerged one, so unmerging them later replays exactly. Merges from one insert can rewrite the same relation, preference, or decision (both endpoints merged, say); once one is unmerged that object lives somewhere new, so the other merges record that location, whether it existed before, and the restored entity id, and undo from there. An object the unmerged merge created and left in place for another merge is that merge's to undo now, so its rewrite stops saying the object already existed.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param mergeId (string): the merge being reverted.
 * @param moved (Moved): each rewrite the unmerge replayed, with its new location.
 * @param restored (Map<string, string>): the relation ids the unmerge deleted, each to the relation it moved them to.
 * @param handed (Set<string>): JSON.stringify([kind, id]) of each object the unmerged merge created and left in place.
 */
async function forwardSiblings(
  runner: Runner,
  ns: string,
  mergeId: string,
  moved: Moved,
  restored: Map<string, string>,
  handed: Set<string>,
  liveMerges?: Props[] | null,
  liveEntries?: Map<string, Props[]> | null,
): Promise<void> {
  const live = liveMerges ?? (await scanLiveMerges(runner, ns)).filter((props) => props.id !== mergeId);
  const entries = liveEntries ?? (await loadEntries(runner, ns, live));
  for (const props of live) {
    const own = entries.get(props.id as string) ?? [];
    const sib = decodeMerge(props, own);
    const rewrites = sib.rewrites.map((rw) => forward(rw, moved, restored, handed));
    if (rewrites.every((rw, i) => rw === sib.rewrites[i])) continue;
    await runner.lockNode(ns, L_MERGE, sib.id);
    await writeMerges(runner, ns, [{ ...sib, rewrites }], entries);
  }
}

/**
 * Reverse one merge: recreate the absorbed entity, drop what it added to the survivor, and move references back.
 *
 * The record is replayed exactly: the absorbed entity gets back the created_at of the merge and the evidence the merge wrote on the survivor, which restores its source_count and leaves the survivor the evidence it had without the merge, a relation the merge dropped as a self-loop is restored with the evidence its rewrite recorded, and a relation the merge created on the survivor is removed with all its
 * versions, and its original is written back as the current relation of the absorbed entity, or retired again when a
 * replaced source retired its last version, so an unmerge never reasserts a withdrawn fact; one a contradiction retired comes back current, since the conflict came from the merged identity. Each evidence row records the merges whose
 * rewrite wrote it, so the restored relation takes exactly the rows this merge carried, and a survivor relation that a
 * direct statement or another live merge still backs stays, with its other evidence, its recounted source_count, and
 * its decision steps. A relation that existed before the merge goes back to the revision it had when only the merge wrote after it, and a survivor relation a removed relation retired is current again. An object an earlier rewrite of this merge created is this merge's to undo even where a repeat
 * of the merge recorded it as existing. A restored relation that keeps the explicit id of the redirected one takes all
 * of its evidence, and the redirected edge is deleted before the id is written again. Each restored relation is
 * returned once, as stored after the last write. A merge whose moved relation is certified is refused until it is uncertified, since the mark verified other endpoints.
 * An endpoint whose own merge is still live keeps pointing at that
 * merge's survivor, and that merge is updated to undo from the new location, so unmerging every merge of an
 * insert, in any order, restores the relations it would have written without them. Restored relations are
 * written with contradiction checks off, so an unmerge never supersedes or warns about another relation.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param mergeId (string): the merge record id.
 * @param caps (ReadonlyMap<string, ops.RelationCap> | null | undefined): the schema's max_count limits, or null without a schema.
 * @return (UnmergeResult): the reverted record, the recreated entity, the survivor, and what was moved back.
 */
export async function unmerge(
  runner: Runner,
  ns: string,
  mergeId: string,
  caps?: ReadonlyMap<string, ops.RelationCap> | null,
): Promise<UnmergeResult> {
  requireStr("merge id", mergeId);
  await runner.lockNode(ns, L_MERGE, mergeId);
  const props = await runner.getNode(ns, L_MERGE, mergeId);
  if (props === null) throw new NotFoundError("EntityMerge", mergeId, undefined, { namespace: ns });
  const entries = (await loadEntries(runner, ns, [props])).get(mergeId) ?? [];
  const stored = decodeMerge(props, entries);
  if (stored.reverted_at !== null) {
    throw new ValidationError(`merge ${pyRepr(mergeId)} was already reverted at ${jsonIso(stored.reverted_at)}`, {
      code: "merge_reverted",
    });
  }
  const created = new Set(
    stored.rewrites.filter((rw) => !(rw.existed || rw.dropped)).map((rw) => JSON.stringify([rw.kind, rw.id])),
  );
  const rec: MergeRecord = {
    ...stored,
    rewrites: stored.rewrites.map((rw) =>
      rw.existed && created.has(JSON.stringify([rw.kind, rw.id])) ? { ...rw, existed: false } : rw,
    ),
  };
  const history = new Map<string, Relation[]>();
  for (const rw of rec.rewrites) {
    if (rw.kind !== "relation" || rw.existed || rw.dropped) continue;
    const versions = await ops.listRelationVersions(runner, ns, rw.id, true);
    history.set(rw.id, versions);
    if (versions[0]?.is_current && versions[0].certified_at !== null) {
      throw new ValidationError(`relation ${rw.id} is certified, and unmerging ${pyRepr(mergeId)} would change it`, {
        code: "relation_certified",
      });
    }
  }
  const at = new Date();
  const absorbedId = rec.absorbed_id;
  const owned = splitEvidence(
    await ops.nodesWhere(runner, ns, L_EVIDENCE, "target_id", [rec.survivor_id]),
    rec.id,
    rec.id,
  );
  const exists = (eid: string): Promise<boolean> => runner.nodeExists(ns, L_ENTITY, eid);
  const absorbed = parseOrThrow(EntityInput, { ...rec.absorbed, id: absorbedId }, "entity");
  const madeAt = (await exists(absorbedId)) ? at : rec.created_at;
  const [entity] = await ops.upsertEntities(
    runner,
    ns,
    [absorbed],
    owned.carried.map(([ev]) => ev),
    madeAt,
  );
  await leaveEntityEvidence(runner, ns, rec.survivor_id, owned);

  const end = async <T extends string | null>(original: T, rewritten: T): Promise<T> => {
    if (original === null || original === absorbedId || original === rewritten) return original;
    return (await exists(original)) ? original : rewritten;
  };

  const restored = new Map<string, string>();
  const deleted = new Map<string, string>();
  const origRestored = new Map<string, string>();
  const moved: Moved = [];
  const handed = new Set<string>();
  const [siblings, liveMerges, liveEntries] = await siblingRewrites(runner, ns, rec.id);
  const gone: EdgeRow[] = [];
  const superseded: Array<[Relation, Relation]> = [];
  let relations: Relation[] = [];
  for (const rw of rec.rewrites.filter((r) => r.kind === "relation")) {
    const original = parseOrThrow(RelationInput, rw.original, "relation");
    const rewritten = parseOrThrow(RelationInput, rw.rewritten, "relation");
    const source = await end(original.from_entity, rewritten.from_entity);
    const target = await end(original.to_entity, rewritten.to_entity);
    const [latest] = history.get(rw.id) ?? [];
    if (!((await exists(source)) && (await exists(target)))) continue;
    let properties: JsonObject = { ...original.properties };
    let eventTime = original.event_time;
    if (latest !== undefined) {
      properties = latest.properties;
      eventTime = latest.event_time;
    }
    const rows = await ops.nodesWhere(runner, ns, L_EVIDENCE, "target_id", [rw.id]);
    const statement = statementOf(rw, rec.id);
    const split = splitEvidence(rows, statement, rec.id);
    if (rw.dropped) {
      const left = ops.viaOf(statement.split(" ").filter((m) => m !== rec.id));
      split.carried = rw.evidence.map((ev) => [ev, [left]]);
    }
    const back: ParsedRelationInput = {
      ...original,
      from_entity: source,
      to_entity: target,
      properties,
      event_time: eventTime,
      evidence: [],
    };
    const backId = ridOf(back);
    let touching = new Set<string>();
    const reused = backId === rw.id && !rw.dropped;
    const keep = !reused && (rw.existed || split.sources.size > 0 || backedElsewhere(rw, rec, siblings));
    if (keep && !rw.existed) handed.add(JSON.stringify([rw.kind, rw.id]));
    if (reused) {
      const stripped = ops.viaOf(statement.split(" ").filter((m) => m !== rec.id));
      split.carried = rows.map((r) => [
        decodeEvidence(r),
        [...new Set(ops.evidenceVia(r).map((s) => (s === statement ? stripped : s)))],
      ]);
      touching = await ops.tracesTouchingRelations(runner, ns, [rw.id]);
      gone.push(...(await ops.relationEdges(runner, ns, rw.id)).slice(-1));
      await runner.deleteEdges(ns, rw.id);
      await ops.deleteEvidence(runner, ns, rw.id);
      deleted.set(rw.id, rw.id);
    }
    const existed = await ops.relationExists(runner, ns, backId);
    let [rel] = await ops.upsertRelations(runner, ns, [[back, split.carried.map(([ev]) => ev)]], null, at, {
      contradiction: "off",
      via: [split.carried.map(([, statements]) => statements)],
    });
    if (keep) {
      if (rw.existed && !rec.source_ids.some((id) => split.sources.has(id)) && !backedElsewhere(rw, rec, siblings)) {
        await undoRevision(runner, ns, rec, rw);
      }
      await leaveEvidence(runner, ns, rw.id, split);
    } else if (latest !== undefined && !reused) {
      handed.delete(JSON.stringify([rw.kind, rw.id]));
      touching = await ops.tracesTouchingRelations(runner, ns, [rw.id]);
      gone.push(...(await ops.relationEdges(runner, ns, rw.id)).slice(-1));
      await runner.deleteEdges(ns, rw.id);
      await ops.deleteEvidence(runner, ns, rw.id);
      deleted.set(rw.id, rel!.id);
    }
    const withdrawn = latest !== undefined && !latest.is_current && !existed;
    if (withdrawn && (await runner.nodeExists(ns, L_SOURCE_VERSION, latest.invalidated_by!))) {
      const edge = await runner.getCurrentEdge(ns, rel!.id);
      [rel] = await ops.retireRelations(runner, ns, [[edge!, latest.invalidated_by!, latest.invalidated_at!]], at);
    }
    if (withdrawn) superseded.push([rel!, latest]);
    restored.set(rw.id, rel!.id);
    origRestored.set(ridOf(original), rel!.id);
    relations.push(rel!);
    moved.push([rw, { ...rw, id: rel!.id, rewritten: dumpRelation(back), existed, dropped: false }]);
    await ops.repointSteps(runner, ns, touching, deleted);
  }

  const slots = (rel: Relation): Set<string> =>
    new Set(
      ops.capSlots(caps ?? new Map(), rel.type, rel.from_entity, rel.to_entity).map(([slot]) => JSON.stringify(slot)),
    );
  for (const [rel, old] of superseded) {
    const by = relations.find((r) => r.id === restored.get(old.invalidated_by!));
    if (by === undefined || ![...slots(rel)].some((key) => slots(by).has(key))) continue;
    const edge = await runner.getCurrentEdge(ns, rel.id);
    await ops.retireRelations(runner, ns, [[edge!, by.id, old.invalidated_at!]], at);
  }
  for (const rid of new Set([...restored.values(), ...restored.keys()])) {
    const edge = await runner.getCurrentEdge(ns, rid);
    if (edge === null || (edge.props.certified_at ?? null) !== null) continue;
    const cut = await withdrawal(runner, ns, await ops.nodesWhere(runner, ns, L_EVIDENCE, "target_id", [rid]));
    if (cut === undefined) continue;
    const [ended] = await ops.retireRelations(runner, ns, [[edge, ...cut]], at);
    relations = relations.map((r) => (r.id === rid ? ended! : r));
  }

  const preferences: Preference[] = [];
  for (const rw of rec.rewrites.filter((r) => r.kind === "preference")) {
    const original = parseOrThrow(PreferenceInput, rw.original, "preference");
    const rewritten = parseOrThrow(PreferenceInput, rw.rewritten, "preference");
    const subject = await end(original.subject_entity, rewritten.subject_entity);
    const value = await end(original.value_entity, rewritten.value_entity);
    const about = await end(original.about_entity, rewritten.about_entity);
    if (!((await exists(subject)) && (await exists(value)))) continue;
    const current = await ops.getPreference(runner, ns, rw.id);
    const kept = current !== null && !rw.existed ? current : original;
    if (kept === current) {
      if (backedElsewhere(rw, rec, siblings)) handed.add(JSON.stringify([rw.kind, rw.id]));
      else await runner.deleteEdges(ns, rw.id);
    }
    const back: ParsedPreferenceInput = {
      ...original,
      subject_entity: subject,
      value_entity: value,
      about_entity: about === null || (await exists(about)) ? about : null,
      strength: kept.strength,
      properties: kept.properties,
      event_time: kept.event_time,
    };
    const existed = await ops.preferenceExists(runner, ns, pidOf(back));
    const pref = await ops.upsertPreference(runner, ns, back, null, at);
    preferences.push(pref);
    moved.push([rw, { ...rw, id: pref.id, rewritten: dumpPreference(back), existed, dropped: false }]);
  }

  const decisions: DecisionTrace[] = [];
  const decisionRws = rec.rewrites.filter((r) => r.kind === "decision");
  const droppedSiblingIds = new Set<string>();
  const siblingStepMap = new Map<string, string>();
  if (decisionRws.length > 0) {
    for (const props of liveMerges) {
      const sib = decodeMerge(props, liveEntries.get(props.id as string) ?? []);
      for (const srw of sib.rewrites) {
        if (srw.kind !== "relation") continue;
        const sorigId = ridOf(parseOrThrow(RelationInput, srw.original, "relation"));
        if (srw.dropped) droppedSiblingIds.add(sorigId);
        else siblingStepMap.set(sorigId, restored.get(srw.id) ?? srw.id);
      }
    }
  }

  for (const rw of decisionRws) {
    const original = parseOrThrow(DecisionTraceInput, rw.original, "decision");
    const rewritten = parseOrThrow(DecisionTraceInput, rw.rewritten, "decision");
    const current = await ops.getTrace(runner, ns, rw.id);
    const actor =
      current !== null && !rw.existed && current.actor_entity !== rewritten.actor_entity
        ? current.actor_entity
        : await end(original.actor_entity, rewritten.actor_entity);
    const outcome =
      current !== null && !rw.existed && current.outcome_entity !== rewritten.outcome_entity
        ? current.outcome_entity
        : await end(original.outcome_entity, rewritten.outcome_entity);
    if ((actor !== null && !(await exists(actor))) || (outcome !== null && !(await exists(outcome)))) continue;
    const steps = rewritten.steps.map((s) => restored.get(s) ?? s);
    const currentSteps =
      current !== null && !rw.existed ? current.steps.map((s) => restored.get(s.relation_id) ?? s.relation_id) : steps;
    const stepInputs = deepEqual(currentSteps, steps) ? original.steps : currentSteps;
    let stepsExist = true;
    for (const s of currentSteps) stepsExist = stepsExist && (await ops.relationExists(runner, ns, s));
    if (!stepsExist) continue;
    const kept = current !== null && !rw.existed ? current : original;
    if (kept === current) {
      if (backedElsewhere(rw, rec, siblings)) handed.add(JSON.stringify([rw.kind, rw.id]));
      else await ops.deleteTraceQuietly(runner, ns, rw.id);
    }
    const alternatives: string[] = [];
    for (const [i, o] of original.alternative_entities.entries()) {
      const alternative = await end(o, rewritten.alternative_entities[i]!);
      if (await exists(alternative)) alternatives.push(alternative);
    }
    if (current !== null && !rw.existed && !deepEqual(current.alternative_entities, rewritten.alternative_entities)) {
      alternatives.splice(0, alternatives.length, ...current.alternative_entities);
    }
    const restoredSteps: string[] = [];
    for (const s of stepInputs) {
      if (droppedSiblingIds.has(s) && !origRestored.has(s)) continue;
      if (origRestored.has(s)) {
        restoredSteps.push(origRestored.get(s)!);
      } else if (siblingStepMap.has(s)) {
        restoredSteps.push(siblingStepMap.get(s)!);
      } else if (restored.has(s)) {
        restoredSteps.push(restored.get(s)!);
      } else if (await ops.relationExists(runner, ns, s)) {
        restoredSteps.push(s);
      }
    }
    const back: ParsedDecisionTraceInput = {
      ...original,
      title: kept.title,
      summary: kept.summary,
      rationale: kept.rationale,
      status: kept.status,
      event_time: kept.event_time,
      steps: restoredSteps,
      actor_entity: actor,
      outcome_entity: outcome,
      alternative_entities: alternatives,
    };
    const existed = await runner.nodeExists(ns, L_TRACE, tidOf(back));
    const trace = await ops.upsertTrace(runner, ns, {
      tid: back.id,
      title: back.title,
      step_rel_ids: back.steps,
      actor_entity: back.actor_entity,
      summary: back.summary,
      rationale: back.rationale,
      outcome_entity: back.outcome_entity,
      alternative_entities: back.alternative_entities,
      status: back.status ?? DEFAULT_STATUS,
      event_time: back.event_time,
      created_at: at,
    });
    decisions.push(trace);
    moved.push([rw, { ...rw, id: trace.id, rewritten: dumpDecision(back), existed, dropped: false }]);
  }

  await ops.resettleEndpoints(runner, ns, gone, caps, at, true);
  if (moved.length) await forwardSiblings(runner, ns, rec.id, moved, deleted, handed, liveMerges, liveEntries);
  const survivor = (await exists(rec.survivor_id))
    ? await ops.updateEntity(
        runner,
        ns,
        rec.survivor_id,
        { remove_aliases: rec.added_aliases, remove_properties: rec.added_properties },
        undefined,
        rec.added_external_ids,
      )
    : null;
  const reverted: MergeRecord = { ...rec, reverted_at: at };
  await writeMerges(runner, ns, [reverted], new Map([[rec.id, entries]]));
  const restoredRelations: Relation[] = [];
  for (const rid of new Set(relations.map((rel) => rel.id))) {
    const [latest] = await ops.listRelationVersions(runner, ns, rid, true);
    if (latest !== undefined) restoredRelations.push(latest);
  }
  return { merge: reverted, entity: entity!, survivor, relations: restoredRelations, preferences, decisions };
}

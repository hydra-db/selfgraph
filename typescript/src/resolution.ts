import { z } from "zod";

import { LLM_HINT, NotFoundError, ValidationError } from "./errors.js";
import { FALLBACK_TYPE } from "./extraction/extractor.js";
import * as ids from "./ids.js";
import { dumps, loads } from "./internal/json.js";
import { comparePy, cpLen, deepEqual, pyFloatRepr, pyRepr, pyStrip } from "./internal/py.js";
import { fromIso, jsonIso, toIso } from "./internal/time.js";
import { L_ENTITY, L_EVIDENCE, L_MERGE, L_MERGE_ENTRY, L_SOURCE_VERSION, L_TRACE } from "./labels.js";
import { type LLMArg, resolveLlm } from "./llm/index.js";
import { scanLiveMerges } from "./maintenance.js";
import {
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
import type { GraphPrimitives, LLMClient, Props } from "./protocols.js";
import { fold, tokens } from "./retrieval.js";
import { entityIndex, lineage, type ParsedSchema, requireMode } from "./schema.js";
import { decodeEntity, decodeEvidence } from "./serde.js";
import { clamp, type Level } from "./tiers.js";
import { checkOptions, requireInt, requireStr, typeName } from "./validate.js";

type Runner = GraphPrimitives;

export const RESOLVER_MODES = ["exact", "default", "fuzzy", "llm"] as const;
export type ResolverMode = (typeof RESOLVER_MODES)[number];

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

const DIGITS = /\p{Nd}+/gu;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Collect the tokens that tell apart otherwise similar names: digit runs, single-letter words, and generations.
 *
 * @param tokens (string[]): the name's folded word tokens.
 * @return ([string[], string[], string[]]): the sorted digit runs, the sorted single-letter word tokens, and the sorted generational suffixes (Jr, Sr, II, III, IV).
 */
function distinguishers(tokens: string[]): [string[], string[], string[]] {
  const digits = tokens.flatMap((t) => [...t.matchAll(DIGITS)].map((m) => m[0])).sort(comparePy);
  const letters = tokens.filter((t) => cpLen(t) === 1 && !/^\p{Nd}$/u.test(t)).sort(comparePy);
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
  return [...folded(name).matchAll(WORD)].map((m) => m[0]);
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
    const forms = formsOf(candidate.name, candidate.aliases);
    let derived: string | undefined;
    const cid = (): string => {
      derived ??= candidateId(candidate);
      return derived;
    };
    return (ent) => {
      if (ctype === FALLBACK_TYPE && ent.type !== ctype) {
        return overlaps(forms, formsOf(ent.name, ent.aliases)) ? [ALIAS_CONFIDENCE, "alias"] : null;
      }
      if (cid() === ent.id) return [1, "id"];
      if (Object.entries(ent.external_ids).some(([key, value]) => candidate.external_ids[key] === value)) {
        return [1, "external_id"];
      }
      if (overlaps(forms, formsOf(ent.name, ent.aliases))) return [ALIAS_CONFIDENCE, "alias"];
      if (this.fuzzy && ctype === ent.type && !distinctNames(candidate.name, ent.name, this.threshold)) {
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
    `${type} ${pyRepr(name)}${aliases.length ? ` (also known as ${aliases.join(", ")})` : ""}`;
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
    if (client === null) throw new ValidationError("LLMResolver needs an LLM; pass an LLMConfig or an LLMClient");
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
    if (maxQuestions < 1) throw new ValidationError(`max_questions must be >= 1, got ${maxQuestions}`);
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
    const ctype = ops.cleanText(candidate.type);
    const band = existing
      .filter((ent) => ent.type === ctype && !distinctNames(candidate.name, ent.name, low))
      .map((ent) => [nameSimilarity(candidate.name, ent.name), ent] as const)
      .filter(([s]) => low <= s && s < high)
      .sort((p, q) => q[0] - p[0] || comparePy(p[1].id, q[1].id));
    for (const [similarity, ent] of band.slice(0, this.max_questions)) {
      const answer = await this.llm.generate({
        system: LLM_SYSTEM,
        user: question(candidate, ent),
        output: SameEntity,
      });
      if (answer.same) return { target_id: ent.id, confidence: similarity, reason: "llm" };
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
      throw new ValidationError(`resolver 'llm' needs an LLM: ${LLM_HINT}`);
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
 * The entity type names a type may merge with: itself, plus its schema ancestors and descendants with aliases.
 *
 * @param etype (string): the cleaned entity type.
 * @param schema (ParsedSchema | null): the active schema.
 * @return (Set<string>): the compatible type names.
 */
function compatibleTypes(etype: string, schema: ParsedSchema | null): Set<string> {
  const out = new Set([etype]);
  if (schema === null) return out;
  const index = entityIndex(schema);
  const own = index.get(etype);
  if (own === undefined) return out;
  const related = new Set([...lineage(own, index)].map((t) => t.name));
  for (const ent of schema.entities) {
    if ([...lineage(ent, index)].some((t) => t.name === own.name)) related.add(ent.name);
  }
  for (const ent of schema.entities) {
    if (related.has(ent.name)) for (const name of [ent.name, ...ent.aliases]) out.add(name);
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
 * @return (ParsedEntityInput): an input with the target's id and type, the candidate's surface forms, and the target's values for the candidate's external id and property keys.
 */
function redirect(ent: ParsedEntityInput, target: Entity): ParsedEntityInput {
  return parseOrThrow(
    EntityInput,
    {
      id: target.id,
      type: target.type,
      name: ent.name,
      aliases: [...ent.aliases],
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
 * Resolve each new entity without an explicit id against compatible stored and batch entities, and rewrite refs. A typed candidate is offered every stored entity of its compatible types, each type read once per insert in id-ordered pages. A candidate of the extraction fallback type (Thing) is also offered entities of other types, stored and from the same batch, whose name or alias matches its own, and is resolved after the others so a typed entity later in the batch can absorb it; of the stored entities of other types, only those are kept in memory. When the store indexes match keys (entitiesMatching), the default resolver is offered only the stored entities sharing a key with a candidate, the only ones it can merge with, instead of every entity of the compatible types.
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
  const wanted = new Set<string | null>();
  for (const etype of candidateTypes) for (const t of compatibleTypes(etype, schema)) wanted.add(t);
  if (candidateTypes.has(FALLBACK_TYPE)) wanted.add(null);
  const fallbackForms = new Set(
    keyed.filter((k) => k.etype === FALLBACK_TYPE && !k.ent.id).flatMap((k) => [...formsOf(k.ent.name, k.ent.aliases)]),
  );
  const named = new Set(keyed.map((k) => k.eid));
  const keep = (props: Props): boolean =>
    wanted.has(props.type as string) ||
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
    const scans = wanted.has(null) ? [null] : [...wanted].sort((a, b) => comparePy(String(a), String(b)));
    for (const etype of scans) {
      const equals = etype === null ? {} : { type: etype };
      yield* ops.keyset((after, limit) => runner.matchNodes(ns, L_ENTITY, { equals, limit, id_gt: after }));
    }
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
  const order = keyed.map((_, i) => i);
  order.sort((a, b) => Number(keyed[a]!.etype === FALLBACK_TYPE) - Number(keyed[b]!.etype === FALLBACK_TYPE));
  for (const i of order) {
    const { ent, eid, etype, ename } = keyed[i]!;
    const merged = merges.get(eid);
    if (merged !== undefined) {
      const target = pool.get(merged.survivor_id) ?? batch.get(merged.survivor_id)!;
      noteAdded(merged, absorbInto(target, ent, ename));
      entities[i] = redirect(ent, target);
      continue;
    }
    if (ent.id || stored.has(eid) || batch.has(eid)) {
      const view = pool.get(eid) ?? batch.get(eid);
      if (view !== undefined) absorbInto(view, ent, ename, false);
      else if (ent.id && !stored.has(eid)) batch.set(eid, viewOf(ent, eid, etype, ename, createdAt));
      continue;
    }
    const fallback = etype === FALLBACK_TYPE;
    const compatible = compatibleTypes(etype, schema);
    const existing = [...pool.values()]
      .filter((e) => compatible.has(e.type) || (fallback && surfaceMatch(ent, e)))
      .sort((a, b) => comparePy(a.id, b.id));
    existing.push(
      ...[...batch.values()].filter(
        (e) => (compatible.has(e.type) && within) || (fallback && !compatible.has(e.type) && surfaceMatch(ent, e)),
      ),
    );
    const decision = await resolver.resolve(ent, existing);
    if (
      typeof decision !== "object" ||
      decision === null ||
      (decision.target_id != null && typeof decision.target_id !== "string")
    ) {
      throw new ValidationError(`a resolver must return a ResolutionDecision, got ${typeName(decision)}`);
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
  }
  if (!mapping.size) return { facts, merges: [], warnings: [] };
  const warnings: InsertWarning[] = [];
  const rewritten = await rewriteRefs(runner, ns, facts, mapping, merges, warnings);
  return { facts: { ...rewritten, entities }, merges: [...merges.values()], warnings };
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
 * @return (ParsedExtraction): the facts with rewritten relations, preferences, and decisions.
 */
async function rewriteRefs(
  runner: Runner,
  ns: string,
  facts: ParsedExtraction,
  mapping: Map<string, string>,
  merges: Map<string, PendingMerge>,
  warnings: InsertWarning[],
): Promise<ParsedExtraction> {
  const m = <T extends string | null>(eid: T): T => (eid === null ? eid : ((mapping.get(eid) ?? eid) as T));
  const note = (rewrite: MergeRewrite, refs: Set<string>): void => {
    for (const eid of [...refs].filter((r) => mapping.has(r)).sort(comparePy)) merges.get(eid)!.rewrites.push(rewrite);
  };
  const touched = facts.relations.map((rel) => mapping.has(rel.from_entity) || mapping.has(rel.to_entity));
  const keptRids = new Set(facts.relations.filter((_, i) => !touched[i]).map(ridOf));
  const relMap = new Map<string, string>();
  const relRefs = new Map<string, Set<string>>();
  const dropped = new Set<string>();
  const relations: ParsedRelationInput[] = [];
  for (const [i, rel] of facts.relations.entries()) {
    if (!touched[i]) {
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
    const rewrite = { original: dumpRelation(rel), rewritten: dumpRelation(next), existed, dropped: loop };
    note({ kind: "relation", id: newId, ...rewrite }, refs);
    if (loop) {
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
      },
      refs,
    );
    decisions.push(next);
  }
  return { ...facts, relations, preferences, decisions };
}

/**
 * The merge record node, without its sources and rewrites, which live in EntityMergeEntry rows. A record repeats every time an insert merges the same pair again, so its sources and rewrites grow without bound; kept inline they would outgrow a store's per-document limit (32000 bytes on HydraDB).
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
    rewrites: (listed.rewrite as MergeRewrite[]).map((rw) => ({ ...rw, dropped: rw.dropped ?? false })),
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
  for (const [, props] of [...nodes, ...entries]) ops.precheckWrite(runner, props);
  if (entries.length) await runner.upsertNodes(ns, L_MERGE_ENTRY, entries);
  await runner.upsertNodes(ns, L_MERGE, nodes);
}

/**
 * Write one record per merge, folding a repeat of the same merge into its live record so inserts stay idempotent.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param resolution (Resolution): the planned merges.
 * @param sourceId (string | null): the inserted source, if any.
 * @param createdAt (Date): the insert time.
 * @return (MergeRecord[]): the stored records, in candidate order.
 */
export async function saveMerges(
  runner: Runner,
  ns: string,
  resolution: Resolution,
  sourceId: string | null,
  createdAt: Date,
): Promise<MergeRecord[]> {
  if (!resolution.merges.length) return [];
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
      const seen = new Set(prev.rewrites.map((r) => `${r.kind}\u0000${r.id}`));
      rec = {
        ...prev,
        source_ids: ops.dedupList([...prev.source_ids, ...rec.source_ids]),
        added_aliases: ops.dedupList([...prev.added_aliases, ...merge.added_aliases]),
        added_external_ids: ops.dedupList([...prev.added_external_ids, ...merge.added_external_ids]),
        added_properties: ops.dedupList([...prev.added_properties, ...merge.added_properties]),
        rewrites: [...prev.rewrites, ...merge.rewrites.filter((r) => !seen.has(`${r.kind}\u0000${r.id}`))],
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
    throw new NotFoundError("Entity", entityId);
  }
  const entries = await loadEntries(runner, ns, rows);
  return rows.map((r) => decodeMerge(r, entries.get(r.id as string)));
}

type Moved = Array<[MergeRewrite, MergeRewrite]>;

/**
 * Point one rewrite of another merge at where an unmerge put the object it shares with that merge.
 *
 * @param rw (MergeRewrite): a rewrite of a still-live merge.
 * @param moved (Moved): each rewrite the unmerge replayed, with its new location.
 * @param restored (Map<string, string>): the relation ids the unmerge moved, old to new.
 * @return (MergeRewrite): the rewrite to keep on that merge.
 */
function forward(rw: MergeRewrite, moved: Moved, restored: Map<string, string>): MergeRewrite {
  for (const [old, next] of moved) {
    if (rw.kind === old.kind && rw.id === old.id && deepEqual(rw.original, old.original)) return next;
  }
  const steps = rw.rewritten.steps;
  if (rw.kind === "decision" && Array.isArray(steps) && steps.some((s) => restored.has(s as string))) {
    return { ...rw, rewritten: { ...rw.rewritten, steps: steps.map((s) => restored.get(s as string) ?? s) } };
  }
  return rw;
}

/**
 * Update the live merges that share a rewrite with an unmerged one, so unmerging them later replays exactly. Merges from one insert can rewrite the same relation, preference, or decision (both endpoints merged, say); once one is unmerged that object lives somewhere new, so the other merges record that location, whether it existed before, and the restored entity id, and undo from there.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param mergeId (string): the merge being reverted.
 * @param moved (Moved): each rewrite the unmerge replayed, with its new location.
 * @param restored (Map<string, string>): the relation ids the unmerge moved, old to new.
 */
async function forwardSiblings(
  runner: Runner,
  ns: string,
  mergeId: string,
  moved: Moved,
  restored: Map<string, string>,
): Promise<void> {
  const live = (await scanLiveMerges(runner, ns)).filter((props) => props.id !== mergeId);
  const entries = await loadEntries(runner, ns, live);
  for (const props of live) {
    const own = entries.get(props.id as string) ?? [];
    const sib = decodeMerge(props, own);
    const rewrites = sib.rewrites.map((rw) => forward(rw, moved, restored));
    if (rewrites.every((rw, i) => rw === sib.rewrites[i])) continue;
    await runner.lockNode(ns, L_MERGE, sib.id);
    await writeMerges(runner, ns, [{ ...sib, rewrites }], entries);
  }
}

/**
 * Reverse one merge: recreate the absorbed entity, drop what it added to the survivor, and move references back.
 *
 * The record is replayed exactly: the absorbed entity gets back the created_at of the merge and the survivor's
 * evidence from every source the merge was seen in (source_ids), which restores its source_count, a relation the merge
 * dropped as a self-loop is restored, and a relation the merge created on the survivor is removed with all its
 * versions, and its original is written back as the current relation of the absorbed entity, or retired again when a
 * replaced source retired its last version, so an unmerge never reasserts a withdrawn fact; one a contradiction retired
 * comes back current, since the conflict came from the merged identity. A
 * merge whose moved relation is certified is refused until it is uncertified, since the mark verified other endpoints.
 * An endpoint whose own merge is still live keeps pointing at that
 * merge's survivor, and that merge is updated to undo from the new location, so unmerging every merge of an
 * insert, in any order, restores the relations it would have written without them. Restored relations are
 * written with contradiction checks off, so an unmerge never supersedes or warns about another relation, and a
 * relation the merged insert superseded stays retired until it is inserted again.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param mergeId (string): the merge record id.
 * @return (UnmergeResult): the reverted record, the recreated entity, the survivor, and what was moved back.
 */
export async function unmerge(runner: Runner, ns: string, mergeId: string): Promise<UnmergeResult> {
  requireStr("merge id", mergeId);
  await runner.lockNode(ns, L_MERGE, mergeId);
  const props = await runner.getNode(ns, L_MERGE, mergeId);
  if (props === null) throw new NotFoundError("EntityMerge", mergeId);
  const entries = (await loadEntries(runner, ns, [props])).get(mergeId) ?? [];
  const rec = decodeMerge(props, entries);
  if (rec.reverted_at !== null) {
    throw new ValidationError(`merge ${pyRepr(mergeId)} was already reverted at ${jsonIso(rec.reverted_at)}`);
  }
  const history = new Map<string, Relation[]>();
  for (const rw of rec.rewrites) {
    if (rw.kind !== "relation" || rw.existed || rw.dropped) continue;
    const versions = await ops.listRelationVersions(runner, ns, rw.id, true);
    history.set(rw.id, versions);
    if (versions[0]?.is_current && versions[0].certified_at !== null) {
      throw new ValidationError(`relation ${rw.id} is certified; uncertify it before unmerging ${pyRepr(mergeId)}`);
    }
  }
  const at = new Date();
  const absorbedId = rec.absorbed_id;
  const evidence: Evidence[] = [];
  for (const sourceId of rec.source_ids) {
    const equals = { target_id: rec.survivor_id, source_id: sourceId };
    evidence.push(...(await ops.scan(ops.nodeListing(runner, ns, L_EVIDENCE, { equals }))).map(decodeEvidence));
  }
  const exists = (eid: string): Promise<boolean> => runner.nodeExists(ns, L_ENTITY, eid);
  const absorbed = parseOrThrow(EntityInput, { ...rec.absorbed, id: absorbedId }, "entity");
  const madeAt = (await exists(absorbedId)) ? at : rec.created_at;
  const [entity] = await ops.upsertEntities(runner, ns, [absorbed], evidence, madeAt);

  const end = async <T extends string | null>(original: T, rewritten: T): Promise<T> => {
    if (original === null || original === absorbedId || original === rewritten) return original;
    return (await exists(original)) ? original : rewritten;
  };

  const restored = new Map<string, string>();
  const moved: Moved = [];
  const relations: Relation[] = [];
  for (const rw of rec.rewrites.filter((r) => r.kind === "relation")) {
    const original = parseOrThrow(RelationInput, rw.original, "relation");
    const rewritten = parseOrThrow(RelationInput, rw.rewritten, "relation");
    const [latest] = history.get(rw.id) ?? [];
    history.delete(rw.id);
    let properties: JsonObject = { ...original.properties };
    let eventTime = original.event_time;
    let carried: Evidence[] = [];
    let touching = new Set<string>();
    if (latest !== undefined) {
      properties = latest.properties;
      eventTime = latest.event_time;
      carried = await ops.scan((skip, limit) => ops.listEvidence(runner, ns, rw.id, "relation", skip, limit));
      touching = await ops.tracesTouchingRelations(runner, ns, [rw.id]);
      await runner.deleteEdges(ns, rw.id);
      await ops.deleteEvidence(runner, ns, rw.id);
    }
    const back: ParsedRelationInput = {
      ...original,
      from_entity: await end(original.from_entity, rewritten.from_entity),
      to_entity: await end(original.to_entity, rewritten.to_entity),
      properties,
      event_time: eventTime,
      evidence: [],
    };
    const existed = await ops.relationExists(runner, ns, ridOf(back));
    let [rel] = await ops.upsertRelations(runner, ns, [[back, carried]], null, at, { contradiction: "off" });
    const withdrawn = latest !== undefined && !latest.is_current && !existed;
    if (withdrawn && (await runner.nodeExists(ns, L_SOURCE_VERSION, latest.invalidated_by!))) {
      const edge = await runner.getCurrentEdge(ns, rel!.id);
      [rel] = await ops.retireRelations(runner, ns, [[edge!, latest.invalidated_by!, latest.invalidated_at!]]);
    }
    restored.set(rw.id, rel!.id);
    relations.push(rel!);
    moved.push([rw, { ...rw, id: rel!.id, rewritten: dumpRelation(back), existed, dropped: false }]);
    await ops.repointSteps(runner, ns, touching, restored);
  }

  const preferences: Preference[] = [];
  for (const rw of rec.rewrites.filter((r) => r.kind === "preference")) {
    const original = parseOrThrow(PreferenceInput, rw.original, "preference");
    const rewritten = parseOrThrow(PreferenceInput, rw.rewritten, "preference");
    const current = await ops.getPreference(runner, ns, rw.id);
    const kept = current !== null && !rw.existed ? current : original;
    if (kept === current) await runner.deleteEdges(ns, rw.id);
    const back: ParsedPreferenceInput = {
      ...original,
      subject_entity: await end(original.subject_entity, rewritten.subject_entity),
      value_entity: await end(original.value_entity, rewritten.value_entity),
      about_entity: await end(original.about_entity, rewritten.about_entity),
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
  for (const rw of rec.rewrites.filter((r) => r.kind === "decision")) {
    const original = parseOrThrow(DecisionTraceInput, rw.original, "decision");
    const rewritten = parseOrThrow(DecisionTraceInput, rw.rewritten, "decision");
    const current = await ops.getTrace(runner, ns, rw.id);
    const kept = current !== null && !rw.existed ? current : original;
    if (kept === current) await ops.deleteTraceQuietly(runner, ns, rw.id);
    const alternatives: string[] = [];
    for (const [i, o] of original.alternative_entities.entries()) {
      alternatives.push(await end(o, rewritten.alternative_entities[i]!));
    }
    const back: ParsedDecisionTraceInput = {
      ...original,
      title: kept.title,
      summary: kept.summary,
      rationale: kept.rationale,
      status: kept.status,
      event_time: kept.event_time,
      steps: rewritten.steps.map((s) => restored.get(s) ?? s),
      actor_entity: await end(original.actor_entity, rewritten.actor_entity),
      outcome_entity: await end(original.outcome_entity, rewritten.outcome_entity),
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
      status: back.status,
      event_time: back.event_time,
      created_at: at,
    });
    decisions.push(trace);
    moved.push([rw, { ...rw, id: trace.id, rewritten: dumpDecision(back), existed, dropped: false }]);
  }

  if (moved.length) await forwardSiblings(runner, ns, rec.id, moved, restored);
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
  return { merge: reverted, entity: entity!, survivor, relations, preferences, decisions };
}

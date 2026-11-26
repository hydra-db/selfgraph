import { ValidationError } from "./errors.js";
import { normalizeRelType } from "./ids.js";
import { comparePy, deepEqual, pyRepr } from "./internal/py.js";
import { epochMicros, toIso } from "./internal/time.js";
import { EDGE_TYPES, L_ENTITY, L_EVIDENCE, L_MERGE, L_SOURCE } from "./labels.js";
import type {
  DecisionTrace,
  DedupeGroup,
  DeleteResult,
  Entity,
  Evidence,
  JsonObject,
  LintIssue,
  Preference,
  Relation,
} from "./models.js";
import * as ops from "./ops.js";
import type { EdgeWrite, GraphPrimitives, NodeRow, Props } from "./protocols.js";
import { canonicalEntityType, canonicalRelationType, type ParsedSchema, relationIndex } from "./schema.js";
import { decodeEntity, decodeEvidence, encodeEntityProps, relevanceProps } from "./serde.js";

const DAY_MS = 86_400_000;
const SCALE = 1_000_000;
const LINT_SAMPLE = 5;

/**
 * The most recent of the given timestamps, ignoring missing ones.
 *
 * @param timestamps (ReadonlyArray<Date | null>): created_at, updated_at, or event_time values.
 * @return (Date): the latest one.
 */
export function latest(timestamps: ReadonlyArray<Date | null>): Date {
  let best: Date | null = null;
  for (const t of timestamps) if (t !== null && (best === null || t.getTime() > best.getTime())) best = t;
  return best!;
}

/**
 * Score how relevant a memory is from its recency and how often it was seen.
 *
 * recency = 0.5 ** (age_days / half_life_days), where age_days counts whole milliseconds from the latest timestamp to now and is never negative; frequency = signal / (signal + 1); the score is recency * (1 + frequency) / 2, rounded half up to six decimals, so it lies in [0, 1).
 *
 * @param timestamps (ReadonlyArray<Date | null>): the item's timestamps; the latest one dates it.
 * @param now (Date): the reference time.
 * @param halfLifeDays (number): the days after which recency halves.
 * @param signal (number): source_count, plus degree for an entity.
 * @return (number): the relevance score.
 */
export function relevanceScore(
  timestamps: ReadonlyArray<Date | null>,
  now: Date,
  halfLifeDays: number,
  signal: number,
): number {
  const ageMs = Math.max(0, now.getTime() - latest(timestamps).getTime());
  const recency = 0.5 ** (ageMs / DAY_MS / halfLifeDays);
  const frequency = signal / (signal + 1);
  return Math.min(Math.floor(((recency * (1 + frequency)) / 2) * SCALE + 0.5) / SCALE, 0.999999);
}

/**
 * Validate a value is a finite real number, optionally strictly positive or within [0, upper].
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value to check.
 * @param positive (boolean): also require the value to be greater than zero.
 * @param upper (number | null): also require the value to be between 0 and this, inclusive.
 */
export function requireNumber(
  field: string,
  value: unknown,
  positive = false,
  upper: number | null = null,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number, got ${pyRepr(value)}`);
  }
  if (positive && value <= 0) throw new ValidationError(`${field} must be greater than 0, got ${pyRepr(value)}`);
  if (upper !== null && !(value >= 0 && value <= upper)) {
    throw new ValidationError(`${field} must be between 0 and ${upper}, got ${pyRepr(value)}`);
  }
}

/**
 * Read every entity in the namespace, a page at a time.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @return (Entity[]): the entities in id order.
 */
export function scanEntities(runner: GraphPrimitives, ns: string): Promise<Entity[]> {
  return ops.scan((skip, limit) => ops.listEntities(runner, ns, { skip, limit }));
}

/**
 * Read every merge record in the namespace that has not been reverted, a page at a time.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @return (Props[]): the stored merge records, in id order.
 */
export async function scanLiveMerges(runner: GraphPrimitives, ns: string): Promise<Props[]> {
  const rows = await ops.scan(ops.nodeListing(runner, ns, L_MERGE, {}));
  return rows
    .filter((row) => (row.reverted_at ?? null) === null)
    .sort((a, b) => comparePy(a.id as string, b.id as string));
}

/**
 * Read the current version of every relation in the namespace, a page at a time.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @return (Relation[]): the current relations in id order.
 */
export function scanRelations(runner: GraphPrimitives, ns: string): Promise<Relation[]> {
  return ops.scan((skip, limit) => ops.listRelations(runner, ns, { skip, limit }));
}

/**
 * Store relevance on entities in place, rereading each under its lock so a concurrent edit is kept.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param scores (Map<string, number>): the relevance per entity id.
 * @param at (Date): when the scores were computed.
 * @return (number): how many entities were written; deleted ones are skipped.
 */
export async function writeEntityRelevance(
  runner: GraphPrimitives,
  ns: string,
  scores: Map<string, number>,
  at: Date,
): Promise<number> {
  for (const eid of scores.keys()) await runner.lockNode(ns, L_ENTITY, eid);
  const byType = new Map<string, NodeRow[]>();
  let written = 0;
  for (const [eid, props] of await ops.nodesById(runner, ns, L_ENTITY, [...scores.keys()])) {
    const e = decodeEntity(props);
    const encoded = encodeEntityProps({ ns, ...e, relevance: scores.get(eid)!, relevance_at: at });
    byType.set(e.type, [...(byType.get(e.type) ?? []), [eid, encoded]]);
    written++;
  }
  ops.precheckNodes(runner, ns, L_ENTITY, [...byType.values()].flat());
  for (const [etype, rows] of byType) await runner.upsertNodes(ns, L_ENTITY, rows, { extra_label: etype });
  return written;
}

/**
 * Store relevance on the current version of relations in place, without a new version, in batched writes.
 *
 * Each current version is read again in a batch and rewritten with its revision, so a relation retired or deleted since the scan is skipped.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param relations (readonly Relation[]): the scanned relations to score.
 * @param scores (Map<string, number>): the relevance per relation id.
 * @param at (Date): when the scores were computed.
 * @return (number): how many relations were written.
 */
export async function writeRelationRelevance(
  runner: GraphPrimitives,
  ns: string,
  relations: readonly Relation[],
  scores: Map<string, number>,
  at: Date,
): Promise<number> {
  const found = await ops.currentRelations(
    runner,
    ns,
    relations.map((rel) => [rel.id, rel] as const),
  );
  const rows: EdgeWrite[] = [];
  for (const [rid, edge] of found) {
    if (!edge.props.is_current) continue;
    rows.push([edge.type, edge.from_id, edge.to_id, { ...edge.props, ...relevanceProps(scores.get(rid)!, at) }]);
  }
  ops.precheckEdges(runner, ns, L_ENTITY, L_ENTITY, rows);
  if (rows.length) await runner.createEdges(ns, L_ENTITY, L_ENTITY, rows);
  return rows.length;
}

/**
 * Union the properties of parallel relations, the survivor winning a conflict, then each duplicate in order.
 *
 * @param survivor (Relation): the relation that is kept.
 * @param duplicates (readonly Relation[]): the relations folded into it, in id order.
 * @return ([JsonObject, Record<string, string[]>]): the merged properties, and per duplicate id the sorted keys whose value lost to an earlier one (duplicates without a conflict are left out).
 */
export function foldProperties(
  survivor: Relation,
  duplicates: readonly Relation[],
): [JsonObject, Record<string, string[]>] {
  const merged: JsonObject = { ...survivor.properties };
  const conflicts: Record<string, string[]> = {};
  for (const rel of duplicates) {
    for (const [key, value] of Object.entries(rel.properties)) {
      if (!Object.hasOwn(merged, key)) merged[key] = value;
      else if (!deepEqual(merged[key], value)) conflicts[rel.id] = [...(conflicts[rel.id] ?? []), key];
    }
  }
  for (const keys of Object.values(conflicts)) keys.sort(comparePy);
  return [merged, conflicts];
}

/**
 * The earliest of the given timestamps, ignoring missing ones.
 *
 * @param timestamps (ReadonlyArray<Date | null>): event_time values.
 * @return (Date | null): the earliest one, or null when all are missing.
 */
function earliest(timestamps: ReadonlyArray<Date | null>): Date | null {
  let best: Date | null = null;
  for (const t of timestamps) if (t !== null && (best === null || epochMicros(t) < epochMicros(best))) best = t;
  return best;
}

/**
 * Fold duplicate parallel relations into a survivor: merge properties, event time, and evidence, then delete.
 *
 * Properties are unioned with the survivor winning a conflict, then each duplicate in id order (see foldProperties). The survivor takes the earliest event_time of the group. Evidence is rewritten onto the survivor, which recounts its distinct sources. Every decision step that used any duplicate moves to the survivor before a duplicate is deleted, and deleting a duplicate never deletes a decision, so none is lost. The group is read again under its source entity's lock, and left alone when any of it is now certified. Only relations that still have the planned endpoints and type are folded, and none when the survivor lost them.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param survivor (string): the relation id that is kept.
 * @param duplicates (readonly string[]): the relation ids folded into it.
 * @param ends (readonly [string, string, string]): the planned [from_entity, type, to_entity], checked again.
 * @return ([DeleteResult, boolean, DedupeGroup | null]): the delete counts of the removed duplicates, whether the group was left alone because a relation in it is certified, and the group as merged (the duplicates folded, the keys each lost, and the versions deleted per duplicate), or null when none was.
 */
export async function mergeRelations(
  runner: GraphPrimitives,
  ns: string,
  survivor: string,
  duplicates: readonly string[],
  ends: readonly [string, string, string],
): Promise<[DeleteResult, boolean, DedupeGroup | null]> {
  const counts = { ...ops.NO_DELETES };
  const planned = (rel: Relation | null): rel is Relation =>
    rel !== null && rel.from_entity === ends[0] && rel.type === ends[1] && rel.to_entity === ends[2];
  const before = await ops.getRelationCurrent(runner, ns, survivor);
  if (before === null) return [counts, false, null];
  await runner.lockNode(ns, L_ENTITY, before.from_entity);
  const current = await ops.getRelationCurrent(runner, ns, survivor);
  if (!planned(current)) return [counts, false, null];
  const found: Relation[] = [];
  for (const rid of duplicates) {
    const rel = await ops.getRelationCurrent(runner, ns, rid);
    if (planned(rel)) found.push(rel);
  }
  if ([current, ...found].some((rel) => rel.certified_at !== null)) return [counts, true, null];
  if (!found.length) return [counts, false, null];
  const evidence: Evidence[] = [];
  for (const rel of found) {
    const rows = await ops.scan(ops.nodeListing(runner, ns, L_EVIDENCE, { equals: { target_id: rel.id } }));
    evidence.push(...rows.map(decodeEvidence));
  }
  const [merged, conflicts] = foldProperties(current, found);
  const first = earliest([current.event_time, ...found.map((rel) => rel.event_time)]);
  await ops.updateRelation(runner, ns, survivor, {
    set_properties: Object.fromEntries(
      Object.entries(merged).filter(([key]) => !Object.hasOwn(current.properties, key)),
    ),
    remove_properties: [],
    event_time: toIso(first) === toIso(current.event_time) ? null : first,
    evidence,
  });
  const gone = found.map((rel) => ({
    props: { id: rel.id },
    type: rel.type,
    from_id: rel.from_entity,
    to_id: rel.to_entity,
  }));
  const rids = found.map((rel) => rel.id);
  const tids = await ops.tracesTouchingRelations(runner, ns, rids);
  await ops.repointSteps(runner, ns, tids.keys(), new Map(rids.map((rid) => [rid, survivor])));
  const versionsLost: Record<string, number> = {};
  for (const rid of rids) {
    versionsLost[rid] = await runner.deleteEdges(ns, rid);
    counts.deleted_relation_versions += versionsLost[rid];
    await ops.deleteEvidence(runner, ns, rid);
  }
  await ops.repointRetired(runner, ns, gone, survivor);
  const group: DedupeGroup = {
    from_entity: ends[0],
    type: ends[1],
    to_entity: ends[2],
    survivor,
    duplicates: rids,
    conflicts,
    versions_lost: versionsLost,
  };
  return [counts, false, group];
}

export interface PruneBatch {
  counts: DeleteResult;
  entity_ids: string[];
  relation_ids: string[];
  certified: string[];
  merge_ids: string[];
}

/**
 * Read the current relations that start or end at some entities.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param eids (readonly string[]): the entity ids.
 * @return (Map<string, Relation>): the current relations by id.
 */
async function currentTouching(
  runner: GraphPrimitives,
  ns: string,
  eids: readonly string[],
): Promise<Map<string, Relation>> {
  const found = new Map<string, Relation>();
  for (const side of ["from_in", "to_in"] as const) {
    const filter = { from_label: L_ENTITY, to_label: L_ENTITY, current_only: true };
    for (const edge of await ops.edgesAt(runner, ns, filter, side, eids)) {
      if (!EDGE_TYPES.has(edge.type)) found.set(edge.props.id as string, ops.relationOf(edge));
    }
  }
  return found;
}

/**
 * Delete the entities a prune planned, after checking the plan again under their locks.
 *
 * Each entity is read again with the current relations that touch it, and those relations' source entities are locked too, so a concurrent certify or edit either lands before the check or waits for the delete. An entity that no longer matches, or that a certified relation now connects (unless includeCertified), is kept. The relations listed are the current ones the deleted entities took with them, including any created since the scan, and the merges listed are the live merge records they took with them, including any made since the scan.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param eids (readonly string[]): the planned entity ids.
 * @param stillMatches ((e: Entity) => boolean): the prune criteria, applied to the entity as stored now.
 * @param includeCertified (boolean): also delete entities a certified relation connects.
 * @param caps (ReadonlyMap<string, ops.RelationCap>): the schema's max_count limits, to settle endpoints after deletes.
 * @return (PruneBatch): the delete counts, the entities, relations, and live merge records deleted, and the certified relations kept.
 */
export async function pruneEntities(
  runner: GraphPrimitives,
  ns: string,
  eids: readonly string[],
  stillMatches: (e: Entity) => boolean,
  includeCertified: boolean,
  caps: ReadonlyMap<string, ops.RelationCap>,
): Promise<PruneBatch> {
  for (const eid of eids) await runner.lockNode(ns, L_ENTITY, eid);
  const planned = new Set(eids);
  const sources = new Set([...(await currentTouching(runner, ns, eids)).values()].map((r) => r.from_entity));
  for (const source of [...sources].filter((s) => !planned.has(s)).sort(comparePy)) {
    await runner.lockNode(ns, L_ENTITY, source);
  }
  const live: string[] = [];
  for (const [eid, props] of await ops.nodesById(runner, ns, L_ENTITY, [...eids])) {
    if (stillMatches(decodeEntity(props))) live.push(eid);
  }
  const touching = await currentTouching(runner, ns, live);
  const certified = includeCertified ? [] : [...touching.values()].filter((r) => r.certified_at !== null);
  const held = new Set(certified.flatMap((r) => [r.from_entity, r.to_entity]));
  const doomed = live.filter((eid) => !held.has(eid)).sort(comparePy);
  const gone = new Set(doomed);
  const taken = [...touching.values()]
    .filter((r) => gone.has(r.from_entity) || gone.has(r.to_entity))
    .map((r) => r.id)
    .sort(comparePy);
  const merges = new Set<string>();
  for (const side of ["survivor_id", "absorbed_id"]) {
    for (const row of await ops.nodesWhere(runner, ns, L_MERGE, side, doomed)) {
      if (row.reverted_at == null) merges.add(row.id as string);
    }
  }
  const counts = await ops.deleteEntities(runner, ns, doomed, caps);
  return {
    counts,
    entity_ids: doomed,
    relation_ids: taken,
    certified: certified.map((r) => r.id).sort(comparePy),
    merge_ids: [...merges].sort(comparePy),
  };
}

/**
 * Delete the relations a prune planned, after reading each again under its source entity's lock.
 *
 * A relation that is gone, no longer current, no longer matches, or is now certified (unless includeCertified) is kept.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param rids (readonly string[]): the planned relation ids.
 * @param stillMatches ((r: Relation) => boolean): the prune criteria, applied to the relation as stored now.
 * @param includeCertified (boolean): also delete certified relations.
 * @param caps (ReadonlyMap<string, ops.RelationCap>): the schema's max_count limits, to settle endpoints after deletes.
 * @return (PruneBatch): the delete counts, the relations deleted, and the certified relations kept.
 */
export async function pruneRelations(
  runner: GraphPrimitives,
  ns: string,
  rids: readonly string[],
  stillMatches: (r: Relation) => boolean,
  includeCertified: boolean,
  caps: ReadonlyMap<string, ops.RelationCap>,
): Promise<PruneBatch> {
  const doomed: string[] = [];
  const certified: string[] = [];
  for (const rid of rids) {
    const before = await ops.getRelationCurrent(runner, ns, rid);
    if (before === null) continue;
    await runner.lockNode(ns, L_ENTITY, before.from_entity);
    const rel = await ops.getRelationCurrent(runner, ns, rid);
    if (rel === null || !stillMatches(rel)) continue;
    if (rel.certified_at !== null && !includeCertified) certified.push(rid);
    else doomed.push(rid);
  }
  const counts = await ops.deleteRelations(runner, ns, doomed, caps);
  return { counts, entity_ids: [], relation_ids: doomed, certified, merge_ids: [] };
}

/**
 * Find what makes a graph a weak source of answers, without changing it.
 *
 * orphan_entity: an entity no current relation, preference, decision, or live merge record references; a merge survivor is kept off it, since deleting it would delete the merge and lose its unmerge. unsupported_fact: a current relation with no evidence record. stale_decision_step: a decision with a step whose relation is no longer current. type_off_schema: with a schema, an entity or relation whose type it does not declare.
 *
 * @param entities (Entity[]): every entity.
 * @param relations (Relation[]): every current relation.
 * @param preferences (Preference[]): every current preference.
 * @param decisions (DecisionTrace[]): every decision.
 * @param supported (ReadonlySet<string>): the ids that have at least one evidence record.
 * @param schema (ParsedSchema | null): the schema, or null to skip the type check.
 * @param merged (Iterable<string>): the entity ids a live merge record references.
 * @return (LintIssue[]): each problem found, with its count and the first ids in id order.
 */
export function lint(
  entities: Entity[],
  relations: Relation[],
  preferences: Preference[],
  decisions: DecisionTrace[],
  supported: ReadonlySet<string>,
  schema: ParsedSchema | null,
  merged: Iterable<string> = [],
): LintIssue[] {
  const used = new Set<string>(merged);
  for (const r of relations) used.add(r.from_entity).add(r.to_entity);
  for (const p of preferences)
    for (const eid of [p.subject_entity, p.value_entity, p.about_entity]) if (eid) used.add(eid);
  for (const d of decisions) {
    for (const eid of [d.actor_entity, d.outcome_entity, ...d.alternative_entities]) if (eid) used.add(eid);
    for (const step of d.steps) used.add(step.from_entity).add(step.to_entity);
  }
  const current = new Set(relations.map((r) => r.id));
  const found: Array<[LintIssue["code"], string[]]> = [
    ["orphan_entity", entities.filter((e) => !used.has(e.id)).map((e) => e.id)],
    ["unsupported_fact", relations.filter((r) => !supported.has(r.id)).map((r) => r.id)],
    ["stale_decision_step", decisions.filter((d) => d.steps.some((s) => !current.has(s.relation_id))).map((d) => d.id)],
    ["type_off_schema", []],
  ];
  if (schema !== null) {
    const names = new Set(schema.entities.map((t) => t.name));
    const declared = relationIndex(schema);
    found[3]![1] = [
      ...entities.filter((e) => !names.has(canonicalEntityType(e.type, schema))).map((e) => e.id),
      ...relations
        .filter((r) => !declared.has(normalizeRelType(canonicalRelationType(r.type, schema))))
        .map((r) => r.id),
    ];
  }
  return found
    .filter(([, ids]) => ids.length)
    .map(([code, ids]) => ({ code, count: ids.length, sample: [...ids].sort(comparePy).slice(0, LINT_SAMPLE) }));
}

/**
 * Count what a namespace holds and lint it, reading every item a page at a time.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param schema (ParsedSchema | null): the schema to check types against, or null.
 * @return ([Record<string, number>, LintIssue[]]): the counts of entities, current relations, current preferences, decisions, and sources, and the lint issues.
 */
export async function inspect(
  runner: GraphPrimitives,
  ns: string,
  schema: ParsedSchema | null,
): Promise<[Record<string, number>, LintIssue[]]> {
  const entities = await scanEntities(runner, ns);
  const relations = await scanRelations(runner, ns);
  const preferences = await ops.scan((skip, limit) => ops.listPreferences(runner, ns, { skip, limit }));
  const decisions = await ops.scan((skip, limit) => ops.listTraces(runner, ns, { skip, limit }));
  const sources = await ops.scan(ops.nodeListing(runner, ns, L_SOURCE, {}));
  const evidence = await ops.scan(ops.nodeListing(runner, ns, L_EVIDENCE, {}));
  const counts = {
    entities: entities.length,
    relations: relations.length,
    preferences: preferences.length,
    decisions: decisions.length,
    sources: sources.length,
  };
  const supported = new Set(evidence.map((row) => row.target_id as string));
  const merged = (await scanLiveMerges(runner, ns)).flatMap((m) => [m.survivor_id as string, m.absorbed_id as string]);
  return [counts, lint(entities, relations, preferences, decisions, supported, schema, merged)];
}

import { ValidationError } from "./errors.js";
import { comparePy, deepEqual, pyRepr } from "./internal/py.js";
import { epochMicros, toIso } from "./internal/time.js";
import { L_ENTITY, L_EVIDENCE } from "./labels.js";
import type { DeleteResult, Entity, Evidence, JsonObject, Relation } from "./models.js";
import * as ops from "./ops.js";
import type { EdgeWrite, GraphPrimitives, NodeRow } from "./protocols.js";
import { decodeEntity, decodeEvidence, encodeEntityProps, relevanceProps } from "./serde.js";

const DAY_MS = 86_400_000;
const SCALE = 1_000_000;

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
  return Math.floor(((recency * (1 + frequency)) / 2) * SCALE + 0.5) / SCALE;
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
    ops.precheckWrite(runner, encoded);
    byType.set(e.type, [...(byType.get(e.type) ?? []), [eid, encoded]]);
    written++;
  }
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
  for (const [, , , props] of rows) ops.precheckWrite(runner, props);
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
      if (!(key in merged)) merged[key] = value;
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
 * Properties are unioned with the survivor winning a conflict, then each duplicate in id order (see foldProperties). The survivor takes the earliest event_time of the group. Evidence is rewritten onto the survivor, which recounts its distinct sources. Every decision step that used any duplicate moves to the survivor before a duplicate is deleted, and deleting a duplicate never deletes a decision, so none is lost.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param survivor (string): the relation id that is kept.
 * @param duplicates (readonly string[]): the relation ids folded into it.
 * @return (DeleteResult): the delete counts of the removed duplicates.
 */
export async function mergeRelations(
  runner: GraphPrimitives,
  ns: string,
  survivor: string,
  duplicates: readonly string[],
): Promise<DeleteResult> {
  const counts = { ...ops.NO_DELETES };
  const current = await ops.getRelationCurrent(runner, ns, survivor);
  if (current === null) return counts;
  const evidence: Evidence[] = [];
  const found: Relation[] = [];
  for (const rid of duplicates) {
    const rel = await ops.getRelationCurrent(runner, ns, rid);
    if (rel === null) continue;
    const rows = await ops.scan(ops.nodeListing(runner, ns, L_EVIDENCE, { equals: { target_id: rid } }));
    evidence.push(...rows.map(decodeEvidence));
    found.push(rel);
  }
  const [merged] = foldProperties(current, found);
  const first = earliest([current.event_time, ...found.map((rel) => rel.event_time)]);
  await ops.updateRelation(runner, ns, survivor, {
    set_properties: Object.fromEntries(Object.entries(merged).filter(([key]) => !(key in current.properties))),
    remove_properties: [],
    event_time: toIso(first) === toIso(current.event_time) ? null : first,
    evidence,
  });
  const rids = found.map((rel) => rel.id);
  const tids = await ops.tracesTouchingRelations(runner, ns, rids);
  await ops.repointSteps(runner, ns, tids, new Map(rids.map((rid) => [rid, survivor])));
  for (const rid of rids) {
    counts.deleted_relation_versions += await runner.deleteEdges(ns, rid);
    await ops.deleteEvidence(runner, ns, rid);
  }
  return counts;
}

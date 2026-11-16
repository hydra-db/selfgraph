import { comparePy } from "./internal/py.js";
import { epochMicros, fromIso } from "./internal/time.js";
import { L_ENTITY, L_MERGE, L_PROFILE, L_SOURCE_VERSION } from "./labels.js";
import type { Change, DecisionTrace, Entity, GraphDiff, MergeRecord, Preference, Relation } from "./models.js";
import * as ops from "./ops.js";
import type { GraphPrimitives, Props } from "./protocols.js";
import { decodeMerge } from "./resolution.js";
import { decodeEntity } from "./serde.js";

const PAGE = 500;
const order = (a: Relation, b: Relation): number => comparePy(a.id, b.id) || a.revision - b.revision;

export const DIFF_KINDS = ["entity", "relation", "preference", "decision", "merge", "source"] as const;

/**
 * Derive the change log from decoded graph objects, oldest to newest writes in no particular order.
 *
 * @param entities (Entity[]): the entities.
 * @param relations (Relation[]): every stored relation version, current or not.
 * @param preferences (Preference[]): every stored preference version, current or not.
 * @param decisions (DecisionTrace[]): the decision traces.
 * @param merges (MergeRecord[]): the merge records, reverted ones included.
 * @param versions (Props[]): the source version nodes.
 * @return (Change[]): the changes, unsorted.
 */
export function changeEvents(
  entities: Entity[],
  relations: Relation[],
  preferences: Preference[],
  decisions: DecisionTrace[],
  merges: MergeRecord[],
  versions: Props[],
): Change[] {
  const events: Change[] = [];
  for (const e of entities) {
    events.push({ kind: "entity", action: "created", id: e.id, at: e.created_at, summary: `${e.type} ${e.name}` });
  }
  for (const r of relations) {
    const summary = `${r.type} ${r.from_entity} -> ${r.to_entity}`;
    events.push({
      kind: "relation",
      action: r.revision === 1 ? "created" : "updated",
      id: r.id,
      at: r.created_at,
      summary,
    });
    if (r.invalidated_at !== null) {
      events.push({
        kind: "relation",
        action: "retired",
        id: r.id,
        at: r.invalidated_known_at ?? r.invalidated_at,
        summary: `${summary} (by ${r.invalidated_by})`,
      });
    }
    for (const c of r.certifications) {
      const marked = `${summary} (by ${c.by})`;
      events.push({ kind: "relation", action: "certified", id: r.id, at: c.at, summary: marked });
      if (c.until !== null) {
        events.push({ kind: "relation", action: "uncertified", id: r.id, at: c.until, summary: marked });
      }
    }
  }
  for (const p of preferences) {
    const summary = `${p.stance} ${p.key}: ${p.subject_entity} -> ${p.value_entity}`;
    events.push({
      kind: "preference",
      action: p.revision === 1 ? "created" : "updated",
      id: p.id,
      at: p.created_at,
      summary,
    });
  }
  for (const d of decisions) {
    events.push({ kind: "decision", action: "created", id: d.id, at: d.created_at, summary: d.title });
    if (epochMicros(d.updated_at) > epochMicros(d.created_at)) {
      events.push({ kind: "decision", action: "updated", id: d.id, at: d.updated_at, summary: d.title });
    }
  }
  for (const m of merges) {
    const summary = `${m.absorbed_id} into ${m.survivor_id}: ${m.reason}`;
    events.push({ kind: "merge", action: "merged", id: m.id, at: m.created_at, summary });
    if (m.reverted_at !== null) {
      events.push({
        kind: "merge",
        action: "unmerged",
        id: m.id,
        at: m.reverted_at,
        summary: `${m.absorbed_id} back out of ${m.survivor_id}`,
      });
    }
  }
  for (const v of versions) {
    events.push({
      kind: "source",
      action: "created",
      id: v.source_id as string,
      at: fromIso(v.created_at as string)!,
      summary: `version ${v.id as string}`,
    });
  }
  return events;
}

/**
 * Scan stored changes one page at a time, retaining only changes in the window.
 *
 * @param runner (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param since (Date): exclusive known-time lower bound.
 * @param until (Date): inclusive known-time upper bound.
 * @param kinds (readonly string[] | null): the kinds to include in changes, or null for all of them.
 * @param limit (number | null): the most changes to return, keeping the newest, or null for all.
 * @return (GraphDiff): changes in id and revision order, plus the change log.
 */
export async function graphDiff(
  runner: GraphPrimitives,
  ns: string,
  since: Date,
  until: Date,
  kinds: readonly string[] | null = null,
  limit: number | null = null,
): Promise<GraphDiff> {
  const result: GraphDiff = {
    since,
    until,
    relations_added: [],
    relations_retired: [],
    relations_revised: [],
    entities_created: [],
    limitations: ["Deletes are not visible."],
    total: 0,
    counts: {},
    changes: [],
  };
  const within = (stamp: Date): boolean =>
    epochMicros(since) < epochMicros(stamp) && epochMicros(stamp) <= epochMicros(until);
  const retired = new Map<string, Relation>();
  const relations: Relation[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const rows = await runner.matchEdges(ns, {
      from_label: L_ENTITY,
      to_label: L_ENTITY,
      current_only: false,
      skip,
      limit: PAGE,
    });
    for (const row of rows) {
      const relation = ops.relationOf(row);
      relations.push(relation);
      if (within(relation.created_at)) {
        (relation.revision === 1 ? result.relations_added : result.relations_revised).push(relation);
      }
      const ended = relation.invalidated_known_at;
      if (ended !== null && within(ended) && epochMicros(relation.created_at) <= epochMicros(ended)) {
        const key = JSON.stringify([relation.id, epochMicros(ended)]);
        const previous = retired.get(key);
        if (!previous || previous.revision < relation.revision) retired.set(key, relation);
      }
    }
    if (rows.length < PAGE) break;
  }
  result.relations_added.sort(order);
  result.relations_revised.sort(order);
  result.relations_retired = [...retired.values()].sort(
    (a, b) => comparePy(a.id, b.id) || epochMicros(a.invalidated_known_at!) - epochMicros(b.invalidated_known_at!),
  );
  const entities: Entity[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const rows = await runner.matchNodes(ns, L_ENTITY, { skip, limit: PAGE });
    for (const row of rows) {
      const entity = decodeEntity(row);
      entities.push(entity);
      if (within(entity.created_at)) result.entities_created.push(entity);
    }
    if (rows.length < PAGE) break;
  }
  result.entities_created.sort((a, b) => comparePy(a.id, b.id));
  const preferences = (
    await ops.scan((skip, limit_) =>
      runner.matchEdges(ns, {
        from_label: L_PROFILE,
        to_label: L_ENTITY,
        current_only: false,
        skip,
        limit: limit_,
      }),
    )
  ).map(ops.preferenceOf);
  const decisions = await ops.scan((skip, limit_) => ops.listTraces(runner, ns, { skip, limit: limit_ }));
  const merges = (await ops.scan(ops.nodeListing(runner, ns, L_MERGE, {}))).map((props) => decodeMerge(props));
  const versions = await ops.scan(ops.nodeListing(runner, ns, L_SOURCE_VERSION, {}));
  const events = changeEvents(entities, relations, preferences, decisions, merges, versions)
    .filter((c) => within(c.at))
    .sort(
      (a, b) =>
        epochMicros(a.at) - epochMicros(b.at) ||
        comparePy(a.kind, b.kind) ||
        comparePy(a.action, b.action) ||
        comparePy(a.id, b.id),
    );
  result.total = events.length;
  const counts: Record<string, number> = {};
  for (const c of events) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  result.counts = counts;
  let kept = events;
  if (kinds !== null) kept = kept.filter((c) => kinds.includes(c.kind));
  if (limit !== null && kept.length > limit) kept = kept.slice(kept.length - limit);
  result.changes = kept;
  return result;
}

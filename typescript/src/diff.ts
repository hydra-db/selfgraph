import { comparePy } from "./internal/py.js";
import { epochMicros, fromIso } from "./internal/time.js";
import { L_ENTITY, L_MERGE, L_PROFILE, L_SOURCE_VERSION } from "./labels.js";
import type { Change, DecisionTrace, DiffResult, Entity, MergeRecord, Preference, Relation } from "./models.js";
import * as ops from "./ops.js";
import type { GraphPrimitives, Props } from "./protocols.js";
import { decodeMerge } from "./resolution.js";

export const DIFF_KINDS = ["entity", "relation", "preference", "decision", "merge", "source"] as const;

/**
 * Report whether a change time falls in the (since, until] window.
 *
 * @param at (Date): the change time.
 * @param since (Date | null): changes at or before this time are left out, or null for no lower bound.
 * @param until (Date | null): changes after this time are left out, or null for no upper bound.
 * @return (boolean): true when the change is inside the window.
 */
function inWindow(at: Date, since: Date | null, until: Date | null): boolean {
  return (
    (since === null || epochMicros(at) > epochMicros(since)) &&
    (until === null || epochMicros(at) <= epochMicros(until))
  );
}

/**
 * Derive the change log from decoded graph objects, oldest to newest writes in no particular order.
 *
 * Every kind of write is one change: an entity created or later updated, a relation or preference version
 * written (created for revision 1, updated for a later revision), a relation retired with what retired it, a
 * certification started or ended on a current relation, a decision created or later updated, an entity merge
 * recorded and when it was undone, and a source version recorded. Nothing is deleted from the log, so a
 * change survives its object being deleted.
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
    const summary = `${e.type} ${e.name}`;
    events.push({ kind: "entity", action: "created", id: e.id, at: e.created_at, summary });
    if (epochMicros(e.updated_at) > epochMicros(e.created_at)) {
      events.push({ kind: "entity", action: "updated", id: e.id, at: e.updated_at, summary });
    }
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
    if (r.is_current) {
      for (const c of r.certifications) {
        const marked = `${summary} (by ${c.by})`;
        events.push({ kind: "relation", action: "certified", id: r.id, at: c.at, summary: marked });
        if (c.until !== null) {
          events.push({ kind: "relation", action: "uncertified", id: r.id, at: c.until, summary: marked });
        }
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
    const summary = d.title;
    events.push({ kind: "decision", action: "created", id: d.id, at: d.created_at, summary });
    if (epochMicros(d.updated_at) > epochMicros(d.created_at)) {
      events.push({ kind: "decision", action: "updated", id: d.id, at: d.updated_at, summary });
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
 * Read the change log of a namespace between two times.
 *
 * Every change in the window is returned oldest first, with counts per kind over the whole window; limit keeps
 * only the newest changes, after the counts were taken.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param since (Date | null): changes at or before this time are left out, or null.
 * @param until (Date | null): changes after this time are left out, or null for now.
 * @param kinds (readonly string[] | null): the kinds to include, or null for all of them.
 * @param limit (number | null): the most changes to return, keeping the newest, or null for all.
 * @return (DiffResult): the window, the total, the counts per kind, and the changes oldest first.
 */
export async function buildDiff(
  runner: GraphPrimitives,
  ns: string,
  args: {
    since: Date | null;
    until: Date | null;
    kinds: readonly string[] | null;
    limit: number | null;
  },
): Promise<DiffResult> {
  const entities = await ops.scan((skip, limit_) => ops.listEntities(runner, ns, { skip, limit: limit_ }));
  const relations = (
    await ops.scan((skip, limit_) =>
      runner.matchEdges(ns, {
        from_label: L_ENTITY,
        to_label: L_ENTITY,
        current_only: false,
        skip,
        limit: limit_,
      }),
    )
  ).map(ops.relationOf);
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
    .filter((c) => inWindow(c.at, args.since, args.until) && (args.kinds === null || args.kinds.includes(c.kind)))
    .sort(
      (a, b) =>
        epochMicros(a.at) - epochMicros(b.at) ||
        comparePy(a.kind, b.kind) ||
        comparePy(a.action, b.action) ||
        comparePy(a.id, b.id),
    );
  const counts: Record<string, number> = {};
  for (const c of events) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const kept = args.limit !== null && events.length > args.limit ? events.slice(events.length - args.limit) : events;
  return { since: args.since, until: args.until, total: events.length, counts, changes: kept };
}

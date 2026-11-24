import { comparePy } from "./internal/py.js";
import { epochMicros, fromIso } from "./internal/time.js";
import { L_ENTITY, L_MERGE, L_PROFILE, L_SOURCE_VERSION, L_TRACE } from "./labels.js";
import type { GraphDiff, Relation } from "./models.js";
import { decodeTraces, edgesAt, keyset, preferenceOf, relationOf } from "./ops.js";
import type { GraphPrimitives, Props } from "./protocols.js";
import { decodeMerges } from "./resolution.js";
import { decodeEntity, decodeSourceVersion } from "./serde.js";

const order = (a: { id: string; revision: number }, b: { id: string; revision: number }): number =>
  comparePy(a.id, b.id) || a.revision - b.revision;

/**
 * Page through every node of one label in id order.
 *
 * @param runner (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param label (string): the node label.
 * @return (AsyncGenerator<Props[]>): each non-empty page of node properties.
 */
function nodes(runner: GraphPrimitives, ns: string, label: string): AsyncGenerator<Props[]> {
  return keyset((after, limit) => runner.matchNodes(ns, label, { id_gt: after, limit }));
}

/**
 * Add the entities created and the relation versions written, retired, certified, or uncertified in the window.
 *
 * @param runner (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param within ((stamp: Date | null) => boolean): whether a known time falls in the window.
 * @param result (GraphDiff): the diff to fill.
 * @return (Promise<void>): nothing.
 */
async function relations(
  runner: GraphPrimitives,
  ns: string,
  within: (stamp: Date | null) => boolean,
  result: GraphDiff,
): Promise<void> {
  const retired = new Map<string, Relation>();
  for await (const page of nodes(runner, ns, L_ENTITY)) {
    for (const row of page) {
      const entity = decodeEntity(row);
      if (within(entity.created_at)) result.entities_created.push(entity);
    }
    const from = page.map((row) => row.id as string);
    for (const row of await edgesAt(runner, ns, { from_label: L_ENTITY, to_label: L_ENTITY }, "from_in", from)) {
      const relation = relationOf(row);
      if (within(relation.created_at)) {
        (relation.revision === 1 ? result.relations_added : result.relations_revised).push(relation);
      }
      const ended = relation.invalidated_known_at;
      if (within(ended) && epochMicros(relation.created_at) <= epochMicros(ended!)) {
        const key = JSON.stringify([relation.id, epochMicros(ended!)]);
        const previous = retired.get(key);
        if (!previous || previous.revision < relation.revision) retired.set(key, relation);
      }
      const own = relation.certifications.filter((c) => epochMicros(relation.created_at) <= epochMicros(c.at));
      if (own.some((c) => within(c.at))) result.relations_certified.push(relation);
      if (own.some((c) => within(c.until))) result.relations_uncertified.push(relation);
    }
  }
  result.relations_retired = [...retired.values()].sort(
    (a, b) => comparePy(a.id, b.id) || epochMicros(a.invalidated_known_at!) - epochMicros(b.invalidated_known_at!),
  );
}

/**
 * Read the history stored in the known-time window (since, until], one list per kind and change.
 *
 * @param runner (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param since (Date): exclusive known-time lower bound.
 * @param until (Date): inclusive known-time upper bound.
 * @return (GraphDiff): changes in id and revision order.
 */
export async function graphDiff(runner: GraphPrimitives, ns: string, since: Date, until: Date): Promise<GraphDiff> {
  const result: GraphDiff = {
    since,
    until,
    relations_added: [],
    relations_retired: [],
    relations_revised: [],
    entities_created: [],
    relations_certified: [],
    relations_uncertified: [],
    preferences_added: [],
    preferences_revised: [],
    decisions_created: [],
    decisions_updated: [],
    entities_merged: [],
    entities_unmerged: [],
    source_versions_added: [],
    limitations: ["Deletes and entity edits are not visible."],
  };
  const within = (stamp: Date | null): boolean =>
    stamp !== null && epochMicros(since) < epochMicros(stamp) && epochMicros(stamp) <= epochMicros(until);
  await relations(runner, ns, within, result);
  for await (const page of nodes(runner, ns, L_PROFILE)) {
    const from = page.map((row) => row.id as string);
    for (const row of await edgesAt(runner, ns, { from_label: L_PROFILE, to_label: L_ENTITY }, "from_in", from)) {
      const preference = preferenceOf(row);
      if (within(preference.created_at)) {
        (preference.revision === 1 ? result.preferences_added : result.preferences_revised).push(preference);
      }
    }
  }
  for await (const page of nodes(runner, ns, L_TRACE)) {
    const rows = page.filter((row) => within(fromIso(row.created_at)) || within(fromIso(row.updated_at)));
    for (const trace of await decodeTraces(runner, ns, rows)) {
      if (within(trace.created_at)) result.decisions_created.push(trace);
      if (epochMicros(trace.updated_at) > epochMicros(trace.created_at) && within(trace.updated_at)) {
        result.decisions_updated.push(trace);
      }
    }
  }
  for await (const page of nodes(runner, ns, L_MERGE)) {
    const rows = page.filter((row) => within(fromIso(row.created_at)) || within(fromIso(row.reverted_at)));
    for (const record of await decodeMerges(runner, ns, rows)) {
      if (within(record.created_at)) result.entities_merged.push(record);
      if (within(record.reverted_at)) result.entities_unmerged.push(record);
    }
  }
  for await (const page of nodes(runner, ns, L_SOURCE_VERSION)) {
    result.source_versions_added.push(...page.map(decodeSourceVersion).filter((v) => within(v.created_at)));
  }
  for (const versions of [
    result.relations_added,
    result.relations_revised,
    result.relations_certified,
    result.relations_uncertified,
    result.preferences_added,
    result.preferences_revised,
  ]) {
    versions.sort(order);
  }
  result.entities_created.sort((a, b) => comparePy(a.id, b.id));
  return result;
}

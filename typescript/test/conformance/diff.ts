import type { SelfGraph } from "../../src/index.js";
import { epochMicros } from "../../src/internal/time.js";

/**
 * Compare five boundary windows over the fixture's stored changes.
 *
 * @param graph (SelfGraph): the shared graph.
 * @return (unknown): compact diff outputs for exact cross-SDK comparison.
 */
export async function diffWindows(graph: SelfGraph): Promise<unknown> {
  const all = await graph.diff("1900-01-01", "2100-01-01");
  const stamps = [
    ...[...all.relations_added, ...all.relations_revised, ...all.relations_retired].flatMap((r) => [
      r.created_at,
      r.invalidated_known_at,
    ]),
    ...[...all.relations_certified, ...all.relations_uncertified].flatMap((r) =>
      r.certifications.flatMap((c) => [c.at, c.until]),
    ),
    ...[...all.preferences_added, ...all.preferences_revised].map((p) => p.created_at),
    ...[...all.decisions_created, ...all.decisions_updated].flatMap((t) => [t.created_at, t.updated_at]),
    ...[...all.entities_merged, ...all.entities_unmerged].flatMap((m) => [m.created_at, m.reverted_at]),
    ...all.source_versions_added.map((v) => v.created_at),
  ];
  const times = [
    ...new Map(stamps.filter((at): at is Date => at !== null).map((at) => [epochMicros(at), at])).values(),
  ].sort((a, b) => epochMicros(a) - epochMicros(b));
  if (!times.length) return [];
  const first = times[0];
  const middle = times[Math.floor(times.length / 2)];
  const last = times[times.length - 1];
  const windows: Array<[Date | string, Date | string]> = [
    ["1900-01-01", first],
    [first, first],
    [first, middle],
    [middle, last],
    [last, "2100-01-01"],
  ];
  const out = [];
  for (const [since, until] of windows) {
    const d = await graph.diff(since, until);
    out.push({
      since: d.since,
      until: d.until,
      added: d.relations_added.map((r) => [r.id, r.revision]),
      revised: d.relations_revised.map((r) => [r.id, r.revision]),
      retired: d.relations_retired.map((r) => [r.id, r.revision, r.invalidated_by]),
      entities: d.entities_created.map((e) => e.id),
      certified: d.relations_certified.map((r) => [r.id, r.revision]),
      uncertified: d.relations_uncertified.map((r) => [r.id, r.revision]),
      preferences_added: d.preferences_added.map((p) => [p.id, p.revision]),
      preferences_revised: d.preferences_revised.map((p) => [p.id, p.revision]),
      decisions_created: d.decisions_created.map((t) => t.id),
      decisions_updated: d.decisions_updated.map((t) => t.id),
      merged: d.entities_merged.map((m) => m.id),
      unmerged: d.entities_unmerged.map((m) => m.id),
      sources: d.source_versions_added.map((v) => [v.source_id, v.id]),
      limitations: d.limitations,
    });
  }
  return out;
}

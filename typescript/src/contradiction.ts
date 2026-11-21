import { z } from "zod";

import type { GraphAccess } from "./access.js";
import { comparePy, pyStr } from "./internal/py.js";
import { epochMicros } from "./internal/time.js";
import { L_ENTITY } from "./labels.js";
import { summarizeError } from "./llm/index.js";
import { type InsertWarning, insertWarning, type JsonObject, parseOrThrow, type Relation } from "./models.js";
import * as ops from "./ops.js";
import type { EdgeRow, GraphPrimitives, LLMClient } from "./protocols.js";
import { decodeEntity } from "./serde.js";

const MAX_RIVALS = 20;
const SYSTEM =
  "You decide whether a new fact makes older facts about the same subject no longer true. List an older fact " +
  "only when it and the new fact cannot both hold at once, such as a previous employer after a job change or " +
  "a liking that became a dislike. Facts that can hold together, such as knowing several people, are not " +
  "contradicted. When unsure, list nothing.";

const Verdict = z.object({ retired: z.array(z.number().int()).default([]) });

/**
 * Render one fact for the judge.
 *
 * @param edgeType (string): the relation type.
 * @param source (string): the source entity's name.
 * @param target (string): the destination entity's name.
 * @param properties (JsonObject): the relation's properties.
 * @return (string): the fact as one line.
 */
function line(edgeType: string, source: string, target: string, properties: JsonObject): string {
  const entries = Object.entries(properties);
  const props = entries.length ? ` {${entries.map(([k, v]) => `${k}=${pyStr(v)}`).join(", ")}}` : "";
  return `${source} -[${edgeType}]-> ${target}${props}`;
}

/**
 * Name the older relations askJudge would show the LLM for some written relations, without asking it.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param written (readonly Relation[]): the relations a write stored.
 * @param caps (ReadonlyMap<string, ops.RelationCap> | null): the schema's max_count limits by relation type.
 * @param writtenAt (Date): the write's timestamp; only relations it created or revised are judged.
 * @return (Set<string>): the rival relation ids.
 */
export async function judgedRivals(
  runner: GraphPrimitives,
  ns: string,
  written: readonly Relation[],
  caps: ReadonlyMap<string, ops.RelationCap> | null,
  writtenAt: Date,
): Promise<Set<string>> {
  const fresh = new Set(written.filter((r) => r.created_at.getTime() === writtenAt.getTime()).map((r) => r.id));
  if (!fresh.size) return new Set();
  const rivals = await ops.rivalRelations(runner, ns, written, caps, MAX_RIVALS);
  return new Set(
    [...rivals].filter(([rid]) => fresh.has(rid)).flatMap(([, edges]) => edges.map((e) => e.props.id as string)),
  );
}

/**
 * Ask the LLM which older relations each written relation makes untrue, without writing anything.
 *
 * Only relations the cardinality rules left alone are judged: one call per written relation that has a rival (see
 * ops.rivalRelations). It runs after the write commits and outside any transaction, so no lock is held while the LLM
 * answers and a retried write never asks again; applyVerdicts then retires what it chose.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param llm (LLMClient): the LLM to ask.
 * @param written (readonly Relation[]): the relations a write just stored.
 * @param caps (ReadonlyMap<string, ops.RelationCap> | null): the schema's max_count limits by relation type.
 * @param writtenAt (Date): the write's timestamp; only relations it created or revised are judged.
 * @return (Array<readonly [Relation, EdgeRow]>): each written relation, as judged, with a rival edge row the LLM judged it contradicts.
 */
export async function askJudge(
  runner: GraphPrimitives,
  ns: string,
  llm: LLMClient,
  written: readonly Relation[],
  caps: ReadonlyMap<string, ops.RelationCap> | null,
  writtenAt: Date,
): Promise<Array<readonly [Relation, EdgeRow]>> {
  const byId = new Map(written.filter((r) => r.created_at.getTime() === writtenAt.getTime()).map((r) => [r.id, r]));
  if (!byId.size) return [];
  const rivals = await ops.rivalRelations(runner, ns, written, caps, MAX_RIVALS);
  for (const rid of rivals.keys()) if (!byId.has(rid)) rivals.delete(rid);
  if (!rivals.size) return [];
  const refs = new Set<string>();
  for (const [rid, edges] of rivals) {
    refs.add(byId.get(rid)!.from_entity).add(byId.get(rid)!.to_entity);
    for (const edge of edges) refs.add(edge.to_id);
  }
  const nodes = await ops.nodesById(runner, ns, L_ENTITY, [...refs].sort(comparePy));
  const name = (eid: string): string => {
    const props = nodes.get(eid);
    return props === undefined ? eid : decodeEntity(props).name;
  };

  const chosen: Array<readonly [Relation, EdgeRow]> = [];
  const taken = new Set<unknown>();
  for (const [rid, edges] of rivals) {
    const fresh = byId.get(rid)!;
    const open = edges.filter((e) => !taken.has(e.props.id));
    if (!open.length) continue;
    const older = open
      .map((e, i) => `${i + 1}. ${line(e.type, name(e.from_id), name(e.to_id), ops.relationOf(e).properties)}`)
      .join("\n");
    const user =
      `New fact: ${line(fresh.type, name(fresh.from_entity), name(fresh.to_entity), fresh.properties)}\n` +
      `Older facts:\n${older}\n` +
      "Which older facts, by number, are no longer true now that the new fact holds?";
    const answer = await llm.generate({ system: SYSTEM, user, output: Verdict });
    const verdict = parseOrThrow(Verdict, answer, "contradiction verdict");
    for (const number of new Set(verdict.retired)) {
      if (number >= 1 && number <= open.length) {
        const edge = open[number - 1]!;
        taken.add(edge.props.id);
        chosen.push([fresh, edge]);
      }
    }
  }
  return chosen;
}

/**
 * Tell whether two edge rows are the same stored version, so a relation deleted and created again does not match.
 *
 * @param a (EdgeRow): one edge row.
 * @param b (EdgeRow): the other edge row.
 * @return (boolean): true when their revision and creation time agree.
 */
function sameVersion(a: EdgeRow, b: EdgeRow): boolean {
  return ops.revisionOf(a) === ops.revisionOf(b) && a.props.created_at === b.props.created_at;
}

/**
 * Retire the older relations the judge chose, each read again with its written relation under their source locks.
 *
 * A verdict is stale, and left alone, when the rival or the written relation is gone, no longer current, or is another version than the one judged: another revision, or the same revision created again after a delete. A retired relation is invalidated by the written relation at its effective time. A certified relation is never retired, as with the cardinality rules.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param chosen (ReadonlyArray<readonly [Relation, EdgeRow]>): each written relation with a rival edge row, as askJudge returns.
 * @param known (Date): the timestamp of this write, stamped on each retirement.
 * @return (InsertWarning[]): one relation_superseded warning per retired relation, and one certified_kept warning per certified relation the LLM judged contradicted, which stays current.
 */
export async function applyVerdicts(
  runner: GraphPrimitives,
  ns: string,
  chosen: ReadonlyArray<readonly [Relation, EdgeRow]>,
  known: Date,
): Promise<InsertWarning[]> {
  const sources = ops.dedupList(chosen.flatMap(([asked, edge]) => [asked.from_entity, edge.from_id]));
  for (const source of sources.sort(comparePy)) await runner.lockNode(ns, L_ENTITY, source);
  const retirements: Array<readonly [EdgeRow, string, Date]> = [];
  const kept: InsertWarning[] = [];
  for (const [asked, judged] of chosen) {
    const rid = asked.id;
    const fresh = await ops.getRelationCurrent(runner, ns, rid);
    if (
      fresh === null ||
      fresh.revision !== asked.revision ||
      epochMicros(fresh.created_at) !== epochMicros(asked.created_at)
    ) {
      continue;
    }
    const edge = await runner.getCurrentEdge(ns, judged.props.id as string);
    if (edge === null || !sameVersion(edge, judged)) continue;
    if (edge.props.certified_at === null || edge.props.certified_at === undefined) {
      retirements.push([edge, rid, ops.effectiveTime(fresh)]);
      continue;
    }
    const message = `relation ${edge.props.id} is certified, so it stays current though the LLM judged ${rid} to contradict it`;
    kept.push(insertWarning("certified_kept", message));
  }
  const retired = await ops.retireRelations(runner, ns, retirements, known);
  return [
    ...kept,
    ...retired.map((rel) =>
      insertWarning(
        "relation_superseded",
        `relation ${rel.id} was superseded by ${rel.invalidated_by}, which the LLM judged to contradict it`,
      ),
    ),
  ];
}

/**
 * Ask the LLM judge about relations a committed write stored, then retire what it chose in a short write.
 *
 * The write has already committed, so a failed judge does not fail it: it is reported as a contradiction_not_judged warning naming the relations it did not judge.
 *
 * @param graph (GraphAccess): the graph, to read outside any transaction and then write.
 * @param llm (LLMClient): the LLM to ask.
 * @param written (readonly Relation[]): the relations the write stored.
 * @param caps (ReadonlyMap<string, ops.RelationCap> | null): the schema's max_count limits by relation type.
 * @param writtenAt (Date): the write's timestamp; only relations it created or revised are judged.
 * @return (InsertWarning[]): the judge's relation_superseded and certified_kept warnings, or one contradiction_not_judged warning when the judge failed.
 */
export async function judgeWritten(
  graph: GraphAccess,
  llm: LLMClient,
  written: readonly Relation[],
  caps: ReadonlyMap<string, ops.RelationCap> | null,
  writtenAt: Date,
): Promise<InsertWarning[]> {
  let chosen: Array<readonly [Relation, EdgeRow]>;
  try {
    chosen = await graph.read((store, ns) => askJudge(store, ns, llm, written, caps, writtenAt));
  } catch (exc) {
    const unjudged = [
      ...new Set(written.filter((r) => r.created_at.getTime() === writtenAt.getTime()).map((r) => r.id)),
    ]
      .sort(comparePy)
      .join(", ");
    const message = `the LLM contradiction judge failed, so ${unjudged} were not judged: ${summarizeError(exc)}`;
    return [insertWarning("contradiction_not_judged", message)];
  }
  if (!chosen.length) return [];
  return graph.write((tx, ns) => applyVerdicts(tx, ns, chosen, new Date()));
}

import { z } from "zod";

import { comparePy, pyStr } from "./internal/py.js";
import { L_ENTITY } from "./labels.js";
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
 * Ask the LLM which older relations each written relation makes untrue, and retire those.
 *
 * Only relations the cardinality rules left alone are judged: one call per written relation that has a rival (see
 * ops.rivalRelations). A retired relation is invalidated by the written one at its effective time.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param llm (LLMClient): the LLM to ask.
 * @param written (readonly Relation[]): the relations a write just stored.
 * @param caps (ReadonlyMap<string, ops.RelationCap> | null): the schema's max_count limits by relation type.
 * @return (InsertWarning[]): one relation_superseded warning per retired relation.
 */
export async function judgeContradictions(
  runner: GraphPrimitives,
  ns: string,
  llm: LLMClient,
  written: readonly Relation[],
  caps: ReadonlyMap<string, ops.RelationCap> | null,
): Promise<InsertWarning[]> {
  const rivals = await ops.rivalRelations(runner, ns, written, caps, MAX_RIVALS);
  if (!rivals.size) return [];
  const byId = new Map(written.map((r) => [r.id, r]));
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

  const pairs: Array<readonly [EdgeRow, Relation]> = [];
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
        pairs.push([edge, fresh]);
      }
    }
  }
  const retired = await ops.retireRelations(runner, ns, pairs);
  return retired.map((rel) =>
    insertWarning(
      "relation_superseded",
      `relation ${rel.id} was superseded by ${rel.invalidated_by}, which the LLM judged to contradict it`,
    ),
  );
}

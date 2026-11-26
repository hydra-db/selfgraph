import { z } from "zod";
import { ExtractionError } from "./errors.js";

import { contextPayload } from "./internal/payload.js";
import { comparePy, pyStr } from "./internal/py.js";
import { L_ENTITY } from "./labels.js";
import { type InsertWarning, insertWarning, type JsonObject, type Relation } from "./models.js";
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
 * @return (string): the fact as one line, with line breaks and control characters escaped.
 */
function line(edgeType: string, source: string, target: string, properties: JsonObject): string {
  const entries = Object.entries(properties).sort(([a], [b]) => comparePy(a, b));
  const props = entries.length ? ` {${entries.map(([k, v]) => `${k}=${pyStr(v)}`).join(", ")}}` : "";
  return contextPayload(`${source} -[${edgeType}]-> ${target}${props}`);
}

/**
 * Validate contradiction verdicts before writing and return their retirement operation.
 *
 * Only relations the cardinality rules left alone are judged: one call per written relation that has a rival (see
 * ops.rivalRelations). A retired relation is invalidated by the written one at its effective time. A certified
 * relation is never retired, as with the cardinality rules.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param llm (LLMClient): the LLM to ask.
 * @param written (readonly Relation[]): the planned relation versions.
 * @param caps (ReadonlyMap<string, ops.RelationCap> | null): the schema's max_count limits by relation type.
 * @param known (Date): the timestamp of the write, stamped on each retirement.
 * @param names (ReadonlyMap<string, string>): names of entities in the planned write.
 * @return (Function): apply the validated retirements at the write timestamp and return their warnings.
 */
export async function judgeContradictions(
  runner: GraphPrimitives,
  ns: string,
  llm: LLMClient,
  written: readonly Relation[],
  caps: ReadonlyMap<string, ops.RelationCap> | null,
  known: Date,
  names: ReadonlyMap<string, string> = new Map(),
): Promise<(at: Date) => Promise<InsertWarning[]>> {
  const byId = new Map(written.filter((r) => r.created_at.getTime() === known.getTime()).map((r) => [r.id, r]));
  const rivals = await ops.rivalRelations(runner, ns, written, caps, MAX_RIVALS);
  for (const rid of rivals.keys()) if (!byId.has(rid)) rivals.delete(rid);
  const refs = new Set<string>();
  for (const [rid, edges] of rivals) {
    refs.add(byId.get(rid)!.from_entity).add(byId.get(rid)!.to_entity);
    for (const edge of edges) refs.add(edge.to_id);
  }
  const nodes = await ops.nodesById(runner, ns, L_ENTITY, [...refs].sort(comparePy));
  const name = (eid: string): string => {
    const props = nodes.get(eid);
    return names.get(eid) ?? (props === undefined ? eid : decodeEntity(props).name);
  };

  const retirements: Array<readonly [EdgeRow, string, Date | null]> = [];
  const kept: InsertWarning[] = [];
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
    let verdict: z.infer<typeof Verdict>;
    try {
      verdict = Verdict.parse(await llm.generate({ system: SYSTEM, user, output: Verdict }));
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      throw new ExtractionError("LLM client returned an invalid contradiction verdict", {
        code: "invalid_llm_output",
        field: "retired",
        cause: error,
      });
    }
    for (const number of new Set(verdict.retired)) {
      if (number >= 1 && number <= open.length) {
        const edge = open[number - 1]!;
        taken.add(edge.props.id);
        if (edge.props.certified_at === null || edge.props.certified_at === undefined) {
          retirements.push([edge, fresh.id, fresh.event_time]);
          continue;
        }
        const message = `relation ${edge.props.id} is certified, so it stays current though the LLM judged ${rid} to contradict it`;
        kept.push(insertWarning("certified_kept", message));
      }
    }
  }
  return async (at) => {
    const retired = await ops.retireRelations(
      runner,
      ns,
      retirements.map(([edge, by, when]) => [edge, by, when ?? at] as const),
      at,
    );
    return [
      ...kept,
      ...retired.map((rel) =>
        insertWarning(
          "relation_superseded",
          `relation ${rel.id} was superseded by ${rel.invalidated_by}, which the LLM judged to contradict it`,
        ),
      ),
    ];
  };
}

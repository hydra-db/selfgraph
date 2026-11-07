import { loadTokenizer } from "./chunking.js";
import * as ids from "./ids.js";
import { pyJsonDumps, pyStr, utf8 } from "./internal/py.js";
import { toIso } from "./internal/time.js";
import type { Evidence, JsonObject } from "./models.js";
import type { GraphPrimitives } from "./protocols.js";
import { childEdgeId, L_CHUNK, L_SOURCE, L_SOURCE_VERSION, R_HAS_CHUNK, R_HAS_VERSION } from "./schema.js";
import { evidenceOf } from "./serde.js";

/**
 * Write the source, content-addressed version, and chunk structure and return the source version with its base evidence.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param args ({ source_id: string; parsed_text: string; media_type: string; metadata: JsonObject | null; created_at: Date }): the source id, parsed text, media type, metadata, and insert timestamp.
 * @return ([string, Evidence[]]): the source version id and the base evidence.
 */
export async function recordSource(
  runner: GraphPrimitives,
  ns: string,
  args: {
    source_id: string;
    parsed_text: string;
    media_type: string;
    metadata: JsonObject | null;
    created_at: Date;
  },
): Promise<[string, Evidence[]]> {
  const { source_id: sourceId, parsed_text: text } = args;
  const sv = ids.sourceVersionId(sourceId, ids.contentHash(utf8(text)));
  const sourceNode = ids.sourceNodeId(sourceId);

  await runner.upsertNode(ns, L_SOURCE, sourceNode, { id: sourceNode, ns, source_id: sourceId });
  await runner.upsertNode(ns, L_SOURCE_VERSION, sv, {
    id: sv,
    ns,
    source_id: sourceId,
    media_type: args.media_type,
    created_at: toIso(args.created_at),
    metadata_json: pyJsonDumps(args.metadata ?? {}, { sortKeys: true, default: pyStr }),
  });
  await runner.createEdge(ns, R_HAS_VERSION, L_SOURCE, sourceNode, L_SOURCE_VERSION, sv, {
    ns,
    id: childEdgeId(R_HAS_VERSION, sv),
    revision: 1,
  });

  const { chunkText } = await loadTokenizer();
  for (const chunk of chunkText(text)) {
    const cid = ids.chunkId(sv, chunk.index);
    await runner.upsertNode(ns, L_CHUNK, cid, {
      id: cid,
      ns,
      index: chunk.index,
      text: chunk.text,
      start_offset: chunk.start_offset,
      end_offset: chunk.end_offset,
    });
    await runner.createEdge(ns, R_HAS_CHUNK, L_SOURCE_VERSION, sv, L_CHUNK, cid, {
      ns,
      id: childEdgeId(R_HAS_CHUNK, cid),
      revision: 1,
    });
  }

  return [sv, [evidenceOf({ source_id: sourceId, source_version: sv, chunk_id: null })]];
}

/**
 * The text of a source version's chunks, in chunk order.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param sourceVersion (string): the source version id.
 * @return (string[]): each chunk's text, empty when a chunk has none.
 */
export async function readChunks(runner: GraphPrimitives, ns: string, sourceVersion: string): Promise<string[]> {
  const chunks = await runner.childNodes(ns, L_SOURCE_VERSION, sourceVersion, R_HAS_CHUNK, L_CHUNK);
  return chunks
    .sort((a, b) => Math.trunc(Number(a.index)) - Math.trunc(Number(b.index)))
    .map((c) => (typeof c.text === "string" ? c.text : ""));
}

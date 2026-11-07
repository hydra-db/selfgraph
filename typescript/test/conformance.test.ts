import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { KuzuStore, SelfGraph } from "../src/index.js";
import { conformanceStore, dump, write } from "./conformance/ts_side.js";
import { reachable, selectedStores, uniqueNs } from "./helpers.js";

const PY = process.env.SELFGRAPH_PY;
const SCRIPT = fileURLToPath(new URL("./conformance/py_side.py", import.meta.url));
const KUZU_DIR = mkdtempSync(join(tmpdir(), "selfgraph-conf-"));
const KUZU = join(KUZU_DIR, "graph.kuzu");

afterAll(() => rmSync(KUZU_DIR, { recursive: true, force: true }));

function py(cmd: "write" | "dump", store: string, ns: string): unknown {
  const out = execFileSync(PY!, [SCRIPT, cmd, store, ns, KUZU], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

async function ts<T>(store: string, ns: string, fn: (g: SelfGraph) => Promise<T>): Promise<T> {
  const graph = new SelfGraph(conformanceStore(store, KUZU), { namespace: ns });
  try {
    await graph.initialize();
    return await fn(graph);
  } finally {
    await graph.close();
    if (store === "kuzu") await KuzuStore.closeDatabase(KUZU);
  }
}

/**
 * Round floats so BM25 scores summed in Python's per-process set order compare equal.
 *
 * @param value (unknown): the JSON value.
 * @return (unknown): the value with rounded floats.
 */
function roundFloats(value: unknown): unknown {
  if (typeof value === "number" && !Number.isInteger(value)) return Number(value.toFixed(9));
  if (Array.isArray(value)) return value.map(roundFloats);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundFloats(v)]));
  }
  return value;
}

/**
 * Mask what legitimately differs between two runs: wall-clock timestamps, the namespace, and timestamp-hashed source version ids.
 *
 * @param value (unknown): the JSON value.
 * @return (unknown): the masked value.
 */
function mask(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/sv:[0-9a-f]{24}/g, "sv:<sv>");
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (k === "created_at" || k === "updated_at") return [k, "<ts>"];
        if (k === "ns") return [k, "<ns>"];
        if (k === "message") return [k, "<message>"];
        if (k === "evidence_json" && typeof v === "string") return [k, mask(v)];
        return [mask(k) as string, mask(v)];
      }),
    );
  }
  return value;
}

/**
 * Key source versions and their chunks by source id, since sv ids hash the insert time and sort differently per run.
 *
 * @param snapshot (unknown): a dump.
 * @return (unknown): the dump with sources keyed by source id.
 */
function bySource(snapshot: unknown): unknown {
  const s = snapshot as { source_versions: Array<{ id: string; source_id: string }>; chunks: Record<string, unknown> };
  const svToSource = new Map(s.source_versions.map((sv) => [sv.id, sv.source_id]));
  return {
    ...s,
    source_versions: Object.fromEntries(s.source_versions.map((sv) => [sv.source_id, sv])),
    chunks: Object.fromEntries(Object.entries(s.chunks).map(([sv, c]) => [svToSource.get(sv), c])),
  };
}

const specs = PY ? selectedStores() : [];
const live = new Map<string, boolean>();
for (const spec of specs) live.set(spec.name, await reachable(spec));

describe.skipIf(!PY)("cross-language conformance with the Python SDK", () => {
  for (const { name: store } of specs) {
    it.skipIf(!live.get(store))(
      `${store}: Python and TypeScript read, write, and agree on the same graph`,
      async () => {
        const nsPy = uniqueNs("conf_py");
        const nsTs = uniqueNs("conf_ts");

        const pyOps = py("write", store, nsPy);
        const tsOps = await ts(store, nsTs, write);

        const pyReadsPy = py("dump", store, nsPy);
        const tsReadsPy = await ts(store, nsPy, (g) => dump(g, nsPy));

        const tsReadsTs = await ts(store, nsTs, (g) => dump(g, nsTs));
        const pyReadsTs = py("dump", store, nsTs);

        const evidence = mkdtempSync(join(tmpdir(), `selfgraph-conformance-${store}-`));
        const keep = { pyOps, tsOps, pyReadsPy, tsReadsPy, tsReadsTs, pyReadsTs };
        for (const [name, value] of Object.entries(keep))
          writeFileSync(join(evidence, `${name}.json`), JSON.stringify(value, null, 2));
        const where = `(snapshots in ${evidence})`;

        expect(roundFloats(tsReadsPy), `TS decodes Python-written data exactly ${where}`).toEqual(
          roundFloats(pyReadsPy),
        );
        expect(roundFloats(pyReadsTs), `Python decodes TS-written data exactly ${where}`).toEqual(
          roundFloats(tsReadsTs),
        );
        expect(mask(roundFloats(bySource(tsReadsTs))), `both libraries write the same graph ${where}`).toEqual(
          mask(roundFloats(bySource(pyReadsPy))),
        );
        expect(mask(tsOps), `both libraries return the same results ${where}`).toEqual(mask(pyOps));
        rmSync(evidence, { recursive: true, force: true });
      },
    );
  }
});

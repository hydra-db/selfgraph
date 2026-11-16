import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ids, KuzuStore, SelfGraph } from "../src/index.js";
import type { Schema } from "../src/schema.js";
import { conformanceStore, dump, SUPERSEDE_SCHEMA, schemaWarnings, supersede, write } from "./conformance/ts_side.js";
import { reachable, selectedStores, tempKuzu, uniqueNs } from "./helpers.js";

const PY = process.env.SELFGRAPH_PY;
const SCRIPT = fileURLToPath(new URL("./conformance/py_side.py", import.meta.url));
const KUZU = tempKuzu("selfgraph-conf-");

function py(cmd: "write" | "dump" | "schema" | "supersede", store: string, ns: string): unknown {
  const out = execFileSync(PY!, [SCRIPT, cmd, store, ns, KUZU], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

async function ts<T>(
  store: string,
  ns: string,
  fn: (g: SelfGraph) => Promise<T>,
  options: { schema?: Schema; contradiction?: "supersede" } = {},
): Promise<T> {
  const graph = new SelfGraph(conformanceStore(store, KUZU), { namespace: ns, ...options });
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
        if (
          k === "created_at" ||
          k === "updated_at" ||
          k === "invalidated_known_at" ||
          k === "at" ||
          k === "since" ||
          k === "until"
        )
          return [k, "<ts>"];
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
  it("schema validation produces identical warnings in both languages", () => {
    expect(schemaWarnings()).toEqual(py("schema", "-", "-"));
  });

  for (const { name: store } of specs) {
    it.skipIf(!live.get(store))(`${store}: superseding at both endpoints agrees in both languages`, async () => {
      const fromPy = py("supersede", store, uniqueNs("conf_sup_py"));
      const fromTs = await ts(store, uniqueNs("conf_sup_ts"), supersede, {
        schema: SUPERSEDE_SCHEMA,
        contradiction: "supersede",
      });
      expect(mask(fromTs)).toEqual(mask(fromPy));
      const ended = Object.values((fromTs as { versions: Record<string, unknown[][]> }).versions).map((v) => v[0]![3]);
      expect(ended.filter((at) => at !== null).sort()).toEqual(["2022-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
    });

    it.skipIf(!live.get(store))(
      `${store}: Python and TypeScript read, write, and agree on the same graph`,
      async () => {
        const nsPy = uniqueNs("conf_py");
        const nsTs = uniqueNs("conf_ts");

        const pyOps = py("write", store, nsPy);
        const tsOps = await ts(store, nsTs, write);
        expect(tsOps.dedupe_conflicts).toEqual({ "relation:touch-b": ["active", "flags"] });
        expect(tsOps.facts_none).toBe("invalid facts: expected object");

        const pyReadsPy = py("dump", store, nsPy);
        const tsReadsPy = await ts(store, nsPy, (g) => dump(g, nsPy));
        expect(pyReadsPy).toMatchObject({
          known_at_sources: { seeds: ["database:hydradb"], counts: { "database:hydradb": 1, "company:acme": 1 } },
        });

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
        const dec = ids.decisionId("person:jane-doe", "Pick HydraDB");
        const step = ids.stepId(dec, 0);
        for (const ops of [pyOps, tsOps]) {
          expect((ops as { dec_retry: unknown }).dec_retry).toEqual({
            links: [
              ["CONSIDERED", dec, "database:postgres"],
              ["FROM", step, "company:acme"],
              ["MADE_DECISION", "person:jane-doe", dec],
              ["RESULTED_IN", dec, "database:hydradb"],
              ["TO", step, "database:hydradb"],
            ],
            unchanged: true,
          });
        }
        rmSync(evidence, { recursive: true, force: true });
      },
    );
  }
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ids, KuzuStore, SelfGraph } from "../src/index.js";
import type { Schema } from "../src/schema.js";
import {
  conformanceStore,
  cutDecisionDeletes,
  cutDecisionUpdates,
  dump,
  exitCodes,
  kuzuParamErrors,
  kuzuReadOnly,
  kuzuSchemeErrors,
  kuzuStatements,
  kuzuValues,
  pinnedUnicode,
  SUPERSEDE_SCHEMA,
  schemaWarnings,
  supersede,
  tokenChunks,
  unmerge,
  write,
} from "./conformance/ts_side.js";
import { reachable, selectedStores, tempKuzu, uniqueNs } from "./helpers.js";

const PY = process.env.SELFGRAPH_PY;
const SCRIPT = fileURLToPath(new URL("./conformance/py_side.py", import.meta.url));
const KUZU = tempKuzu("selfgraph-conf-");

function py(
  cmd:
    | "write"
    | "dump"
    | "schema"
    | "supersede"
    | "unmerge"
    | "kuzu_isolation"
    | "exit_codes"
    | "pinned_unicode"
    | "kuzu_statements"
    | "kuzu_cut_update"
    | "kuzu_cut_delete"
    | "kuzu_values"
    | "kuzu_scheme_errors"
    | "kuzu_params"
    | "kuzu_read_only"
    | "token_chunks",
  store: string,
  ns: string,
): unknown {
  const out = execFileSync(PY!, [SCRIPT, cmd, store, ns, KUZU], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

async function ts<T>(
  store: string,
  ns: string,
  fn: (g: SelfGraph) => Promise<T>,
  options: { schema?: Schema; contradiction?: "supersede"; resolver?: "default" } = {},
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
        if (k === "invalidated_at" && String((value as Record<string, unknown>).invalidated_by).startsWith("sv:"))
          return [k, "<ts>"];
        if (["created_at", "updated_at", "invalidated_known_at", "reverted_at", "since", "until"].includes(k))
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
  it.skipIf(!live.get("kuzu"))(
    "rejects empty Kuzu parameters with the same error fields in both languages",
    async () => {
      expect(await kuzuParamErrors()).toEqual(py("kuzu_params", "-", "-"));
      expect(await kuzuParamErrors()).toEqual({
        list: expect.objectContaining({
          error: "parameter 'x' is an empty list, which Kuzu cannot type; pass a non-empty list",
          code: "invalid_argument",
          field: "x",
        }),
        map: expect.objectContaining({
          error: "parameter 'x' is an empty map, which Kuzu cannot type; pass a non-empty map",
          code: "invalid_argument",
          field: "x",
        }),
        nested_list: expect.objectContaining({
          error: "parameter 'x.a' is an empty list, which Kuzu cannot type; pass a non-empty list",
          code: "invalid_argument",
          field: "x",
        }),
        nested_map: expect.objectContaining({
          error: "parameter 'x.a' is an empty map, which Kuzu cannot type; pass a non-empty map",
          code: "invalid_argument",
          field: "x",
        }),
        sorted_map: expect.objectContaining({
          error: "parameter 'x.1' is an empty map, which Kuzu cannot type; pass a non-empty map",
          code: "invalid_argument",
          field: "x",
        }),
      });
    },
  );

  it.skipIf(!live.get("kuzu"))("isolates anonymous Kuzu databases in both languages", async () => {
    const result: (boolean | string)[] = [];
    for (const path of ["", ":memory:"]) {
      await using first = new SelfGraph(new KuzuStore(path));
      await using second = new SelfGraph(new KuzuStore(path));
      const entity = await first.entities.create("Jane", "Person");
      result.push((await second.entities.get(entity.id)) === null);
      await second.insert.facts({ entities: [{ name: "Jane", type: "Person" }] });
      await second.entities.delete(entity.id);
      result.push((await first.entities.get(entity.id))?.id === entity.id);
    }
    const shared = new KuzuStore(KUZU);
    await shared.initialize();
    for (const options of [{ read_only: true }, { read_only: true, max_db_size: 1024 }]) {
      try {
        await new KuzuStore(KUZU, options).initialize();
        result.push("no error");
      } catch (exc) {
        result.push(exc instanceof Error ? exc.message : String(exc));
      }
    }
    await shared.close();
    expect(result.slice(0, 4)).toEqual([true, true, true, true]);
    expect(py("kuzu_isolation", "-", "-")).toEqual(result);
  });

  it.skipIf(!live.get("kuzu"))(
    "refuses a server URI with the same code, field and store name in both languages",
    () => {
      expect(kuzuSchemeErrors()).toEqual(py("kuzu_scheme_errors", "-", "-"));
    },
  );

  it.skipIf(!live.get("kuzu"))(
    "reads a stored graph read-only and survives a failed read-only open the same way in both languages",
    async () => {
      const result = await kuzuReadOnly();
      expect(result).toEqual(py("kuzu_read_only", "-", "-"));
      expect(result).toEqual({
        ids: ["company:acme", "person:ann"],
        context: expect.stringContaining("Ann -[WORKS_AT]-> Acme"),
        empty_database_code: "query_failed",
        write_after_failed_open: true,
      });
    },
  );

  it("counts tokens and splits chunks the same around a NEL or a byte order mark in both languages", async () => {
    const result = await tokenChunks();
    expect(result).toEqual(py("token_chunks", "-", "-"));
    expect(result[2]).toEqual({ tokens: 2, chunks: [[0, 3]] });
  });

  it("derives ids, relation types, and tokens from the pinned Unicode tables in both languages", () => {
    const pinned = pinnedUnicode();
    expect(pinned.entity_ids.slice(0, 4)).toEqual(["person:王", "company:王", "person:王", "company:王"]);
    expect(pinned).toEqual(py("pinned_unicode", "-", "-"));
  });

  it("gives every error code the same CLI exit code in both languages", () => {
    expect(exitCodes()).toEqual(py("exit_codes", "-", "-"));
  });

  it.skipIf(!live.get("kuzu"))("rejects a multi-statement run_cypher identically in both languages", async () => {
    const result = await kuzuStatements(tempKuzu("selfgraph-conf-stmt-"));
    const multi = {
      error: "Kuzu runs one statement per query; pass one statement, not several joined by ';'",
      code: "query_failed",
    };
    expect(result).toEqual({
      outcomes: [multi, multi, { rows: [{ s: "a; b" }] }, { rows: [{ c: 2 }] }],
      ids: ["t:a", "t:b"],
    });
    expect(py("kuzu_statements", "-", "-")).toEqual(result);
  });

  it.skipIf(!live.get("kuzu"))(
    "keeps the steps of a decision update cut off at any write in both languages",
    async () => {
      const result = await cutDecisionUpdates(tempKuzu("selfgraph-conf-cut-"));
      for (const run of Object.values(result)) {
        expect(run.whole.rationale).toBe("new");
        expect(run.failed_cuts).toEqual([]);
      }
      expect(py("kuzu_cut_update", "-", "-")).toEqual(result);
    },
    180_000,
  );

  it.skipIf(!live.get("kuzu"))(
    "leaves no decision behind when a delete is cut off at any write in both languages",
    async () => {
      const result = await cutDecisionDeletes(tempKuzu("selfgraph-conf-cut-"));
      for (const run of Object.values(result)) {
        expect(run.whole.decisions).toEqual([]);
        expect(run.whole.step_nodes).toEqual([]);
        expect(run.failed_cuts).toEqual([]);
      }
      expect(py("kuzu_cut_delete", "-", "-")).toEqual(result);
    },
    180_000,
  );

  it.skipIf(!live.get("kuzu"))("returns the same run_cypher values in both languages", async () => {
    const fromTs = await kuzuValues(tempKuzu("selfgraph-conf-values-"));
    const fromPy = py("kuzu_values", "-", "-") as typeof fromTs;
    const one = (v: unknown) => ({ rows: [{ v }] });
    expect(fromTs.agree).toEqual(fromPy.agree);
    expect(fromPy.wide).toEqual([
      one("9007199254740993"),
      one("-9223372036854775808"),
      one("18446744073709551615"),
      one("123456789012345678.5"),
      one("99999999999999999999999999999999999999"),
      one("1.50000000000000000000"),
      one([1, "9007199254740993"]),
      one({ a: "9007199254740993" }),
      one({ 1: "9007199254740993" }),
      one("9007199254740993"),
      { rows: [{ w: { pk: 1, big: "9007199254740993", u: 1.5, _label: "W", _id: { offset: 0, table: 7 } } }] },
      one(1.5),
    ]);
    expect(fromTs.wide.map((outcome) => (outcome as { code: string }).code)).toEqual(
      fromPy.wide.map(() => "inexact_value"),
    );
    expect(fromPy.subsecond).toEqual([
      one("2024-01-01T12:34:56.789123Z"),
      one("1969-12-31T23:59:59.999999Z"),
      one("2024-01-01T12:34:56.789123Z"),
      one("PT0.000001S"),
    ]);
    expect(fromTs.subsecond).toEqual([
      one("2024-01-01T12:34:56.789000Z"),
      one("1970-01-01T00:00:00Z"),
      one("2024-01-01T12:34:56.789000Z"),
      one("PT0S"),
    ]);
  });

  it("schema validation produces identical warnings in both languages", () => {
    const warnings = schemaWarnings();
    expect(warnings).toEqual(py("schema", "-", "-"));
    expect(warnings.consistency_errors.map((error) => error.field)).toEqual([
      "entities[1].name",
      "entities[0].parent",
      "relations[0].to.types[0]",
      "relations[1].type",
      "relations[0].from.max_count",
    ]);
    expect(warnings.ossie.warnings).toContain("the OneToMany multiplicity of relation LEADS are left out");
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
      expect((fromTs as { undated_correction: unknown[][] }).undated_correction.map((v) => v[2])).toEqual([
        true,
        false,
      ]);
      const nakatomi = ids.relationId("person:kim", "WORKS_AT", "company:nakatomi");
      const moved = fromTs as { moved_later: unknown[][]; moved_later_valid: string[] };
      expect(moved.moved_later).toEqual([[1, false, nakatomi, "2022-01-01T00:00:00Z"]]);
      expect(moved.moved_later_valid).toEqual([nakatomi]);
      const parallel = (fromTs as { parallel_retirement: Record<string, Record<string, unknown[]>> })
        .parallel_retirement;
      expect(parallel.chronological!["relation:old"]).toEqual([1, false, "relation:new", "2020-02-15T00:00:00Z"]);
      expect(parallel.other_end_unread!["relation:f0"]).toEqual([1, false, "relation:f3", "2020-11-15T00:00:00Z"]);
      const apertureMia = ids.relationId("person:mia", "WORKS_AT", "company:aperture");
      const gap = fromTs as { moved_earlier_gap: unknown[][]; moved_earlier_gap_valid: string[] };
      expect(gap.moved_earlier_gap).toEqual([[1, false, apertureMia, "2014-01-01T00:00:00Z"]]);
      expect(gap.moved_earlier_gap_valid).toEqual([apertureMia]);
      const reasserted = fromTs as {
        reasserted_earlier: Record<string, unknown[][]>;
        reasserted_earlier_valid: string[];
      };
      expect(reasserted.reasserted_earlier.x![0]).toEqual([3, false, "relation:y", "2020-08-28T00:00:00Z"]);
      expect(reasserted.reasserted_earlier_valid).toEqual(["relation:y"]);
    });

    it.skipIf(!live.get(store))(`${store}: unmerging a merge with no source agrees in both languages`, async () => {
      const nsPy = uniqueNs("conf_um_py");
      const nsTs = uniqueNs("conf_um_ts");
      const fromPy = py("unmerge", store, nsPy);
      const fromTs = await ts(store, nsTs, unmerge, { resolver: "default" });
      expect(fromTs).toEqual(fromPy);
      expect(fromTs).toEqual({
        "person:bob": { source_count: 0, sources: [] },
        "person:robert": { source_count: 1, sources: ["s2"] },
      });
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
        for (const ops of [pyOps, tsOps]) {
          const names = (ops as { unicode_text: { entities: { name: string }[] } }).unicode_text.entities.map(
            (entity) => entity.name,
          );
          expect(names).toEqual(expect.arrayContaining(["Émile Zola", "Łukasz Nowak"]));
        }

        const pyReadsPy = py("dump", store, nsPy);
        const tsReadsPy = await ts(store, nsPy, (g) => dump(g, nsPy));
        expect(pyReadsPy).toMatchObject({
          known_at_sources: { seeds: ["database:hydradb"], counts: { "database:hydradb": 1, "company:acme": 1 } },
        });

        const tsReadsTs = await ts(store, nsTs, (g) => dump(g, nsTs));
        const pyReadsTs = py("dump", store, nsTs);
        for (const snapshot of [pyReadsPy, tsReadsPy, tsReadsTs, pyReadsTs]) {
          expect((snapshot as { symbol_entity_ids: { ids: string[] } }).symbol_entity_ids.ids).toEqual([
            "language:c-plus-plus",
            "language:c-sharp",
            "language:c",
            "language:f-sharp",
            "language:disney-plus",
            "language:disney",
            "language:a-plus-b",
            "language:sharp-1",
            "language:plus",
            "language:c-plus-plus",
          ]);
        }
        if (store === "kuzu") {
          for (const snapshot of [pyReadsPy, tsReadsPy, tsReadsTs, pyReadsTs]) {
            expect(snapshot).toMatchObject({
              filters: {
                aliases_equals: [{ id: "person:jane-doe" }],
                aliases_any_of: [{ id: "person:jane-doe" }],
                empty_any_of: [],
              },
            });
          }
        }

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
        if (store === "hydradb") {
          for (const ops of [pyOps, tsOps]) {
            expect((ops as { extra_label: unknown }).extra_label).toEqual({
              primary: "extra:batch-1",
              batch_extra: "extra:batch-2",
              single_extra: "extra:single",
            });
          }
        }
        for (const ops of [pyOps, tsOps]) {
          expect((ops as { large_document: unknown }).large_document).toEqual({ entity: 40_000, relation: 40_000 });
        }
        for (const ops of [pyOps, tsOps]) {
          const plural = (ops as { retrieval_plural_seeds: Record<string, { seeds: string[]; verdict: string }> })
            .retrieval_plural_seeds;
          expect(Object.values(plural).map((row) => [row.seeds.length > 0, row.verdict])).toEqual(
            Object.keys(plural).map(() => [true, "answerable"]),
          );
        }
        rmSync(evidence, { recursive: true, force: true });
      },
    );
  }
});

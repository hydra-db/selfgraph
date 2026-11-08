import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { chunkByChars, loadTokenizer } from "../src/chunking.js";
import { BasicExtractor } from "../src/extraction/basic.js";
import { assembleOntology, isNoiseName } from "../src/extraction/extractor.js";
import {
  contentHash,
  decisionId,
  entityId,
  evidenceId,
  normalizeRelType,
  preferenceId,
  relationId,
  slug,
  sourceNodeId,
  sourceVersionId,
} from "../src/ids.js";
import { comparePy, pyFloatRepr, pyJsonDumps, utf8 } from "../src/internal/py.js";
import { fromIso, jsonIso, parseIso, pyStrDate, toIso } from "../src/internal/time.js";
import { toJsonable } from "../src/output.js";
import { fold, formatProps, grepScore, pprRank, selectSeeds, tokens } from "../src/retrieval.js";
import { quoteLabel } from "../src/stores/cypherPrimitives.js";
import { surrogateKey } from "../src/stores/hydradb.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));

/**
 * Run a function the way the fixture's Python attempt() did: the value, or {error: <class name>}.
 *
 * @param fn (() => T): the function to call.
 * @return (T | { error: string }): the result or the error class name.
 */
function attempt<T>(fn: () => T): T | { error: string } {
  try {
    return fn();
  } catch (exc) {
    return { error: (exc as Error).name };
  }
}

describe("ids match Python byte for byte", () => {
  it("slug", () => {
    for (const [input, expected] of Object.entries(fx.slug)) expect(attempt(() => slug(input))).toEqual(expected);
  });
  it("entity_id, with NFC, org-scoped suffix stripping, and control-character rejection", () => {
    for (const [type, name, expected] of fx.entity_id) {
      expect(
        attempt(() => entityId(type, name)),
        `${type} / ${name}`,
      ).toEqual(expected);
    }
  });
  it("rejects control and surrogate characters, and empty relation types", () => {
    for (const [bad, expected] of Object.entries(fx.bad_strings)) {
      expect(
        [attempt(() => entityId("Person", bad)), attempt(() => normalizeRelType(bad))],
        JSON.stringify(bad),
      ).toEqual(expected);
    }
    for (const [type, expected] of Object.entries(fx.rel_type_errors)) {
      expect(
        attempt(() => normalizeRelType(type)),
        JSON.stringify(type),
      ).toEqual(expected);
    }
  });
  it("NFC-normalizes preference keys and decision titles inside the hash", () => {
    expect([
      preferenceId("person:jane", "preference", "cafe\u0301", "x:y"),
      preferenceId("person:jane", "preference", "café", "x:y"),
      decisionId(null, "Cafe\u0301"),
      decisionId(null, "Café"),
    ]).toEqual(fx.nfc_ids);
  });
  it("normalize_rel_type", () => {
    for (const [input, expected] of Object.entries(fx.normalize_rel_type))
      expect(normalizeRelType(input)).toBe(expected);
  });
  it("relation_id", () => {
    for (const [from, type, to, expected] of fx.relation_id) expect(relationId(from, type, to)).toBe(expected);
  });
  it("preference_id", () => {
    for (const [s, k, key, v, expected] of fx.preference_id)
      expect(attempt(() => preferenceId(s, k, key, v))).toEqual(expected);
  });
  it("decision_id, with an empty actor or title rejected", () => {
    for (const [actor, title, expected] of fx.decision_id)
      expect(attempt(() => decisionId(actor, title))).toEqual(expected);
  });
  it("source_version_id and content_hash", () => {
    expect(sourceVersionId("notes", "abc")).toBe(fx.source_version_id);
    expect(sourceNodeId("notes")).toBe(fx.source_node_id);
    for (const [text, expected] of Object.entries(fx.content_hash)) expect(contentHash(utf8(text))).toBe(expected);
  });
  it("evidence_id", () => {
    for (const [target, ev, expected] of fx.evidence_id) expect(evidenceId(target, ev)).toBe(expected);
  });
  it("quote_label", () => {
    for (const [input, expected] of Object.entries(fx.quote_label)) expect(quoteLabel(input)).toBe(expected);
    expect(() => quoteLabel("   ")).toThrow();
  });
});

describe("json.dumps parity", () => {
  it("sort_keys=True", () => {
    for (const [value, expected] of fx.dumps_sorted) expect(pyJsonDumps(value, { sortKeys: true })).toBe(expected);
  });
  it("insertion order (except integer-like keys, which JS objects reorder)", () => {
    for (const [value, expected] of fx.dumps_default) {
      if (value && typeof value === "object" && "10" in value) continue;
      expect(pyJsonDumps(value)).toBe(expected);
    }
  });
  it("rejects NaN like allow_nan=False", () => {
    expect(() => pyJsonDumps({ x: Number.NaN })).toThrow();
  });
  it("float repr", () => {
    for (const [value, expected] of fx.float_repr) expect(pyFloatRepr(value)).toBe(expected);
  });
});

describe("datetime parity", () => {
  it("to_iso, str(), and pydantic JSON round-trip microseconds", () => {
    for (const c of fx.datetimes) {
      const d = parseIso(c.iso);
      expect(toIso(d)).toBe(c.iso);
      if (!c.str.endsWith("+00:00")) continue;
      expect(pyStrDate(d)).toBe(c.str);
      expect(jsonIso(d)).toBe(c.pydantic);
    }
  });
  it("from_iso treats offset-less text as UTC, as Python does", () => {
    for (const [input, expected] of Object.entries(fx.from_iso)) expect(toIso(fromIso(input))).toBe(expected);
  });
  it("rejects surrounding whitespace, as fromisoformat does", () => {
    expect(() => parseIso(" 2024-01-01T00:00:00")).toThrow(RangeError);
    expect(() => parseIso("2024-01-01T00:00:00 ")).toThrow(RangeError);
  });
  it("a mutated Date drops its stale microseconds", () => {
    const d = parseIso("2026-11-06T10:00:00.123456+00:00");
    d.setTime(d.getTime() + 1000);
    expect(toIso(d)).toBe("2026-11-06T10:00:01.123000+00:00");
  });
});

describe("extraction, chunking, and retrieval helpers match Python", () => {
  it("character chunking, with code point offsets across emoji", () => {
    expect(chunkByChars(fx.chunks.text, 200, 40)).toEqual(fx.chunks.by_chars);
  });

  it("token chunking and counting with cl100k_base", async () => {
    const { chunkText, countTokens } = await loadTokenizer();
    expect(chunkText(fx.chunks.text, { max_tokens: 64, overlap_tokens: 8 })).toEqual(fx.chunks.by_tokens);
    expect(fx.extract.map((c: { text: string }) => countTokens(c.text))).toEqual(fx.chunks.count_tokens);
  });

  it("the LLM-free regex extractor assembles the same ontology", async () => {
    for (const c of fx.extract) {
      const ontology = await new BasicExtractor().extract({ text: c.text, media_type: "text/plain", metadata: {} });
      expect(toJsonable(ontology), c.text).toEqual(c.ontology);
    }
  });

  it("relation endpoints resolve to an extracted entity by canonical name", () => {
    const { entities, relations, ontology } = fx.assemble;
    expect(toJsonable(assembleOntology(entities, relations, [], []))).toEqual(ontology);
  });

  it("noise names and context property rendering", () => {
    for (const [name, expected] of Object.entries(fx.noise)) expect(isNoiseName(name), name).toBe(expected);
    for (const [props, expected] of fx.format_props) expect(formatProps(props)).toBe(expected);
  });

  it("HydraDB 63-bit surrogate keys", () => {
    for (const [ns, sid, expected] of fx.sk) expect(surrogateKey(ns, sid).toString()).toBe(expected);
  });
});

describe("MCP run_cypher write guard matches Python", () => {
  it("blocks and allows the same queries", async () => {
    const { isBlockedQuery } = await import("../src/mcp.js");
    const cases = { ...(fx.cypher_blocked as Record<string, boolean>), ...(fx.cypher_fuzz as Record<string, boolean>) };
    expect(Object.keys(cases).length).toBeGreaterThan(1000);
    const mismatches = Object.entries(cases).filter(([q, blocked]) => isBlockedQuery(q) !== blocked);
    expect(mismatches).toEqual([]);
  });

  it("matches cursor encoding", async () => {
    const { encodeCursor, decodeCursor } = await import("../src/resources/common.js");
    for (const [n, c] of Object.entries(fx.cursors as Record<string, string>)) {
      expect(encodeCursor(Number(n))).toBe(c);
      expect(decodeCursor(c)).toBe(Number(n));
    }
    expect(() => decodeCursor("not-a-cursor")).toThrow();
    expect(() => decodeCursor("1")).toThrow();
    expect(() => decodeCursor("MTA=é")).toThrow("invalid cursor 'MTA=é'");
    expect(() => decodeCursor(5)).toThrow("cursor must be a string, got int");
  });
});

describe("retrieval ranking matches Python (NFC + casefold tokens, specificity, PageRank)", () => {
  const revive = (o: Record<string, unknown>) => ({
    ...o,
    created_at: new Date(o.created_at as string),
    updated_at: o.updated_at ? new Date(o.updated_at as string) : undefined,
  });

  it("folds and tokenizes like str.casefold() over Unicode words", () => {
    for (const [text, expected] of Object.entries(fx.fold as Record<string, string>))
      expect(fold(text), text).toBe(expected);
    for (const [text, expected] of Object.entries(fx.tokens as Record<string, string[]>)) {
      expect([...tokens(text)].sort(comparePy), text).toEqual(expected);
    }
  });

  it("counts grep hits, skipping short ASCII terms", () => {
    for (const [terms, text, expected] of fx.grep) expect(grepScore(new Set(terms), text)).toBe(expected);
  });

  it("damps seed scores by distinct source count", () => {
    const entities = fx.seed_entities.map(revive);
    for (const [query, expected] of Object.entries(fx.seeds as Record<string, Array<[string, number]>>)) {
      const got = selectSeeds(entities, tokens(query), 20).map(([e, sc]) => [e.id, Number(sc.toFixed(12))]);
      expect(got, query).toEqual(expected.map(([id, sc]) => [id, Number(sc.toFixed(12))]));
    }
  });

  it("ranks by personalized PageRank", () => {
    for (const [name, c] of Object.entries(
      fx.ppr as Record<
        string,
        {
          seeds: Array<[string, number]>;
          nodes: string[];
          relations: Array<Record<string, unknown>>;
          ranks: Record<string, number>;
        }
      >,
    )) {
      const seeds = c.seeds.map(([id, score]) => [{ id } as never, score] as [never, number]);
      const ranks = pprRank(seeds, c.nodes, c.relations.map(revive) as never);
      expect(Object.fromEntries(ranks), name).toEqual(c.ranks);
    }
  });
});

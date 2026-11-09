import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { chunkByChars, chunkText, loadTokenizer } from "../src/chunking.js";
import { errorReason, ValidationError } from "../src/errors.js";
import { BasicExtractor } from "../src/extraction/basic.js";
import { assembleOntology, isNoiseName } from "../src/extraction/extractor.js";
import {
  canonicalEntityId,
  contentHash,
  decisionId,
  entityId,
  entityMergeId,
  evidenceId,
  normalizeRelType,
  preferenceId,
  relationId,
  slug,
  sourceNodeId,
  sourceVersionId,
} from "../src/ids.js";
import { setLogger } from "../src/index.js";
import { log } from "../src/internal/log.js";
import { comparePy, pyFloatRepr, pyJsonDumps, pyRepr, utf8 } from "../src/internal/py.js";
import { epochMicros, fromIso, jsonIso, parseIso, pyStrDate, toIso } from "../src/internal/time.js";
import { relevanceScore } from "../src/maintenance.js";
import { isBlockedQuery } from "../src/mcp.js";
import { EntityInput, type Preference, type Relation } from "../src/models.js";
import { fromNeo4jOntology, toNeo4jOntology } from "../src/neo4jSchema.js";
import { Contradictions, versionAsOf } from "../src/ops.js";
import { toJsonable } from "../src/output.js";
import { DefaultResolver, distinctNames, jaroWinkler, nameSimilarity, tokenJaccard } from "../src/resolution.js";
import { decodeCursor, decodeKeyCursor, encodeCursor } from "../src/resources/common.js";
import { fold, formatProps, grepScore, pprRank, selectSeeds, tokens } from "../src/retrieval.js";
import { contradictionCaps, Schema } from "../src/schema.js";
import { quoteLabel } from "../src/stores/cypherPrimitives.js";
import { surrogateKey } from "../src/stores/hydradb.js";
import { requireStr } from "../src/validate.js";
import { captureLog, captureWarnings, storedEntity } from "./helpers.js";

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
  it("slug, entity, relation, preference, decision, evidence, and source ids, with bad input rejected", () => {
    for (const [input, expected] of Object.entries(fx.slug)) expect(attempt(() => slug(input))).toEqual(expected);
    for (const [type, name, expected] of fx.entity_id) {
      expect(
        attempt(() => entityId(type, name)),
        `${type} / ${name}`,
      ).toEqual(expected);
    }
    for (const [input, expected] of fx.canonical_entity_id)
      expect(
        attempt(() => canonicalEntityId(input)),
        input,
      ).toEqual(expected);
    for (const [from, type, to, expected] of fx.relation_id) expect(relationId(from, type, to)).toBe(expected);
    for (const [s, k, key, v, expected] of fx.preference_id)
      expect(attempt(() => preferenceId(s, k, key, v))).toEqual(expected);
    for (const [actor, title, expected] of fx.decision_id)
      expect(attempt(() => decisionId(actor, title))).toEqual(expected);
    for (const [target, ev, expected] of fx.evidence_id) expect(evidenceId(target, ev)).toBe(expected);
    expect(sourceVersionId("notes", "abc")).toBe(fx.source_version_id);
    expect(sourceNodeId("notes")).toBe(fx.source_node_id);
    for (const [text, expected] of Object.entries(fx.content_hash)) expect(contentHash(utf8(text))).toBe(expected);
    expect([
      preferenceId("person:jane", "preference", "cafe\u0301", "x:y"),
      preferenceId("person:jane", "preference", "café", "x:y"),
      decisionId(null, "Cafe\u0301"),
      decisionId(null, "Café"),
    ]).toEqual(fx.nfc_ids);
  });

  it("relation types, control and surrogate characters, and quoted labels", () => {
    for (const [input, expected] of Object.entries(fx.normalize_rel_type))
      expect(normalizeRelType(input)).toBe(expected);
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
    for (const [input, expected] of Object.entries(fx.quote_label)) expect(quoteLabel(input)).toBe(expected);
    expect(() => quoteLabel("   ")).toThrow();
  });
});

describe("json.dumps and datetime parity", () => {
  it("dumps sorted and in insertion order, rejects NaN, and reprs floats", () => {
    for (const [value, expected] of fx.dumps_sorted) expect(pyJsonDumps(value, { sortKeys: true })).toBe(expected);
    for (const [value, expected] of fx.dumps_default) {
      if (value && typeof value === "object" && "10" in value) continue;
      expect(pyJsonDumps(value)).toBe(expected);
    }
    expect(() => pyJsonDumps({ x: Number.NaN })).toThrow();
    for (const [value, expected] of fx.float_repr) expect(pyFloatRepr(value)).toBe(expected);
  });

  it("to_iso, str(), and pydantic JSON round-trip microseconds, and from_iso reads offset-less text as UTC", () => {
    for (const c of fx.datetimes) {
      const d = parseIso(c.iso);
      expect(toIso(d)).toBe(c.iso);
      if (!c.str.endsWith("+00:00")) continue;
      expect(pyStrDate(d)).toBe(c.str);
      expect(jsonIso(d)).toBe(c.pydantic);
    }
    for (const [input, expected] of Object.entries(fx.from_iso)) expect(toIso(fromIso(input))).toBe(expected);
    expect(() => parseIso(" 2024-01-01T00:00:00")).toThrow(RangeError);
    expect(() => parseIso("2024-01-01T00:00:00 ")).toThrow(RangeError);
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
    expect(chunkText(fx.chunks.text, { max_tokens: 16 })).toEqual(
      chunkText(fx.chunks.text, { max_tokens: 16, overlap_tokens: 4 }),
    );
    expect(chunkText(fx.chunks.text, { max_tokens: 1 }).length).toBeGreaterThan(0);
    expect(fx.extract.map((c: { text: string }) => countTokens(c.text))).toEqual(fx.chunks.count_tokens);
  });

  it("the LLM-free regex extractor assembles the same ontology", async () => {
    for (const c of fx.extract) {
      const ontology = await new BasicExtractor().extract({ text: c.text, media_type: "text/plain", metadata: {} });
      expect(toJsonable(ontology), c.text).toEqual(c.ontology);
    }
  });

  it("assembles relation endpoints by canonical name, flags noise names, and renders context properties", () => {
    const { entities, relations, ontology } = fx.assemble;
    expect(toJsonable(assembleOntology(entities, relations, [], []))).toEqual(ontology);
    for (const [name, expected] of Object.entries(fx.noise)) expect(isNoiseName(name), name).toBe(expected);
    for (const [props, expected] of fx.format_props) expect(formatProps(props)).toBe(expected);
  });

  it("HydraDB 63-bit surrogate keys", () => {
    for (const [ns, sid, expected] of fx.sk) expect(surrogateKey(ns, sid).toString()).toBe(expected);
  });
});

describe("MCP run_cypher write guard matches Python", () => {
  it("blocks and allows the same queries", () => {
    const cases = { ...(fx.cypher_blocked as Record<string, boolean>), ...(fx.cypher_fuzz as Record<string, boolean>) };
    expect(Object.keys(cases).length).toBeGreaterThan(1000);
    const mismatches = Object.entries(cases).filter(([q, blocked]) => isBlockedQuery(q) !== blocked);
    expect(mismatches).toEqual([]);
  });

  it("matches cursor encoding", () => {
    for (const [n, c] of Object.entries(fx.cursors as Record<string, string>)) {
      expect(encodeCursor(Number(n))).toBe(c);
      expect(decodeCursor(c)).toBe(Number(n));
    }
    expect(() => decodeCursor("not-a-cursor")).toThrow();
    expect(() => decodeCursor("1")).toThrow();
    expect(() => decodeCursor("MTA=é")).toThrow("invalid cursor 'MTA=é'");
    expect(() => decodeCursor(5)).toThrow("cursor must be a string, got number");
    for (const bad of ["", "AAAA", "MQ", "MQ==\n", encodeCursor("01"), encodeCursor("person:ada")]) {
      expect(() => decodeCursor(bad)).toThrow(`invalid cursor ${pyRepr(bad)}`);
    }
    for (const [id, c] of Object.entries(fx.key_cursors as Record<string, string>)) {
      expect(encodeCursor(id)).toBe(c);
      expect(decodeKeyCursor(c, "entity")).toBe(id);
    }
    expect(decodeKeyCursor(encodeCursor("relation:r"), "relation")).toBe("relation:r");
    expect(decodeKeyCursor(null, "entity")).toBeNull();
    for (const bad of ["", "AAAA", "garbage", "_w==", "MQ==", encodeCursor("decision:x")]) {
      expect(() => decodeKeyCursor(bad, "relation")).toThrow(`invalid cursor ${pyRepr(bad)}`);
    }
    expect(() => decodeKeyCursor(5, "entity")).toThrow("cursor must be a string, got number");
  });
});

describe("retrieval ranking matches Python (NFC + casefold tokens, specificity, PageRank)", () => {
  const revive = (o: Record<string, unknown>) => ({
    ...o,
    created_at: new Date(o.created_at as string),
    updated_at: o.updated_at ? new Date(o.updated_at as string) : undefined,
  });

  it("folds and tokenizes like str.casefold() and counts grep hits, skipping short ASCII terms", () => {
    for (const [text, expected] of Object.entries(fx.fold as Record<string, string>))
      expect(fold(text), text).toBe(expected);
    for (const [text, expected] of Object.entries(fx.tokens as Record<string, string[]>)) {
      expect([...tokens(text)].sort(comparePy), text).toEqual(expected);
    }
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

describe("contradiction and as-of rules match Python", () => {
  const dates = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...o };
    for (const key of ["created_at", "event_time", "invalidated_at"]) {
      if (typeof out[key] === "string") out[key] = parseIso(out[key] as string);
    }
    return out;
  };

  it("picks the version valid at a point in time and derives max_count caps from the schema", () => {
    for (const [name, c] of Object.entries(
      fx.as_of as Record<string, { versions: Array<Record<string, unknown>>; picked: Record<string, number | null> }>,
    )) {
      const versions = c.versions.map(dates) as unknown as Array<Relation | Preference>;
      for (const [at, revision] of Object.entries(c.picked)) {
        expect(versionAsOf(versions, parseIso(at))?.revision ?? null, `${name} at ${at}`).toBe(revision);
      }
    }
    const caps = contradictionCaps(Schema.parse(fx.contradictions.schema));
    expect(Object.fromEntries([...caps].map(([k, c]) => [k, [c.canonical, c.types, c.limits]]))).toEqual(
      fx.contradictions.caps,
    );
  });

  it("resolves conflicts, retirements, and out-of-order facts", () => {
    const caps = contradictionCaps(Schema.parse(fx.contradictions.schema));
    for (const [name, c] of Object.entries(
      fx.contradictions.cases as Record<
        string,
        {
          mode: string;
          existing: Array<Record<string, unknown>>;
          admits: Array<[string, string, string, string, string]>;
          results: unknown[];
        }
      >,
    )) {
      const tracker = new Contradictions(caps, c.mode, c.existing.map(dates) as unknown as Relation[]);
      const got = c.admits.map(([rid, rtype, from, to, iso]) => {
        const at = parseIso(iso);
        const warnings = tracker.admit(rid, rtype, from, to, [epochMicros(at), 1, epochMicros(at)], at);
        const [ended, settled] = tracker.settle();
        const retired = Object.fromEntries([...ended].map(([old, [by, when]]) => [old, [by, toIso(when)]]));
        return [retired, [...warnings, ...settled].map((w) => [w.code, w.message])];
      });
      expect(got, name).toEqual(c.results);
    }
  });
});

describe("entity resolution scores and decisions match Python", () => {
  const fxr = fx.resolution;

  it("scores names, keeps names apart by digit runs and single letters, and derives merge ids identically", () => {
    for (const [a, b, expected] of fxr.jaro_winkler) expect(jaroWinkler(a, b), `${a} / ${b}`).toBe(expected);
    for (const [a, b, expected] of fxr.token_jaccard) expect(tokenJaccard(a, b), `${a} / ${b}`).toBe(expected);
    for (const [a, b, expected] of fxr.name_similarity) expect(nameSimilarity(a, b), `${a} / ${b}`).toBe(expected);
    for (const [a, b, expected] of fxr.distinct) expect(distinctNames(a, b), `${a} / ${b}`).toBe(expected);
    for (const [a, b, expected] of fxr.distinct_low) expect(distinctNames(a, b, 0.8), `${a} / ${b}`).toBe(expected);
    for (const [s, a, expected] of fxr.merge_id) expect(entityMergeId(s, a)).toBe(expected);
  });

  it("makes the same DefaultResolver decisions", () => {
    const existing = fxr.existing.map(storedEntity);
    for (const [raw, fuzzy, threshold, expected] of fxr.decide) {
      const got = new DefaultResolver({ fuzzy, threshold }).decide(EntityInput.parse(raw), existing);
      expect(got, `${JSON.stringify(raw)} fuzzy=${fuzzy} threshold=${threshold}`).toEqual(expected);
    }
  });
});

describe("memory maintenance and schema interop match Python", () => {
  it("scores relevance identically", () => {
    for (const [stamps, now, halfLife, signal, expected] of fx.relevance as Array<
      [Array<string | null>, string, number, number, number]
    >) {
      const dates = stamps.map((t) => (t === null ? null : parseIso(t)));
      expect(relevanceScore(dates, parseIso(now), halfLife, signal), JSON.stringify(stamps)).toBe(expected);
    }
  });

  it("maps Neo4j graph schemas both ways", async () => {
    await captureWarnings(() => {
      for (const c of fx.neo4j_schema as Array<{ input: unknown; schema: unknown; export: unknown }>) {
        const schema = fromNeo4jOntology(c.input);
        expect(toJsonable(schema)).toEqual(c.schema);
        expect(toNeo4jOntology(schema)).toEqual(c.export);
      }
    });
  });
});

describe("validation and diagnostics", () => {
  it("chunkText validates its sizes, caps the default overlap at 64, and the fallback splits on word boundaries", () => {
    for (const options of [{ max_tokens: 0 }, { overlap_tokens: -1 }, { max_tokens: 8, overlap_tokens: 8 }]) {
      expect(() => chunkText("some text", options)).toThrow(ValidationError);
    }
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(20);
    const long = text.repeat(20);
    expect(chunkText(long, { max_tokens: 400 })).toEqual(chunkText(long, { max_tokens: 400, overlap_tokens: 64 }));
    expect(chunkText(long, { max_tokens: 400 })).not.toEqual(chunkText(long, { max_tokens: 400, overlap_tokens: 100 }));
    const chunks = chunkByChars(text, 40, 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.start_offset === 0 || text[chunk.start_offset - 1] === " ").toBe(true);
      expect(chunk.end_offset === text.length || text[chunk.end_offset] === " ").toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(40);
    }
  });

  it("words empty text, a wrong type, and an empty or dangling error reason from the cause chain", () => {
    expect(() => requireStr("namespace", "  ")).toThrow(/^namespace cannot be empty$/);
    expect(() => requireStr("namespace", 5)).toThrow(/^namespace must be a string, got number$/);
    const refused = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    const wrapped = Object.assign(new Error("Failed to connect to FalkorDB: ."), { socketError: refused });
    expect(errorReason(wrapped)).toBe("Failed to connect to FalkorDB: connection refused");
    expect(
      errorReason(new Error("Cannot connect to API: ", { cause: new TypeError("fetch failed", { cause: refused }) })),
    ).toBe("Cannot connect to API: connection refused");
    expect(errorReason(new Error("Socket closed unexpectedly.."))).toBe("Socket closed unexpectedly");
    const boilerplate =
      "Connection Failed. Please ensure that your database is listening on the correct host and port and that you " +
      "have enabled encryption if required. Note that the default encryption setting has changed in Neo4j 4.0. " +
      "See the docs for more information. Failed to establish encrypted connection";
    expect(errorReason(new Error(`[ConnectionResetError] ${boilerplate}`))).toBe(
      "[ConnectionResetError] Failed to establish encrypted connection",
    );
    const js =
      "Failed to connect to server. Please ensure that your database is listening on the correct host and port and " +
      "that you have compatible encryption settings both on Neo4j server and driver. Note that the default " +
      "encryption setting has changed in Neo4j 4.0. Caused by: socket disconnected";
    expect(errorReason(new Error(js))).toBe("Failed to connect to server. Caused by: socket disconnected");
  });

  it("routes library warnings through setLogger, null silences them, and the default hides info", async () => {
    const schema = Schema.parse({ name: "s", entities: [{ name: "Person", parent: "Agent" }, { name: "Agent" }] });
    const { logged } = await captureLog(async () => {
      toNeo4jOntology(schema);
      setLogger(null);
      const { warnings } = await captureWarnings(() => toNeo4jOntology(schema));
      expect(warnings).toEqual([]);
      setLogger(undefined);
      const restored = await captureWarnings(() => {
        log("extracting chunk 1/2", "info");
        toNeo4jOntology(schema);
      });
      expect(restored.warnings).toHaveLength(1);
      expect(restored.warnings[0]).toMatch(/^selfgraph: neo4j ontology: no Neo4j counterpart for: /);
    });
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatch(/^warning: neo4j ontology: no Neo4j counterpart for: /);
  });
});

import { createServer } from "node:http";

import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loadTokenizer } from "../src/chunking.js";
import { assembleExtraction, LLMExtractor, type RawEntity } from "../src/extraction/extractor.js";
import { render } from "../src/extraction/prompts.js";
import * as idsModule from "../src/ids.js";
import {
  buildLlmClient,
  ExtractionError,
  ids,
  KuzuStore,
  PromptTemplateError,
  SelfGraph,
  ValidationError,
} from "../src/index.js";
import { pyRepr } from "../src/internal/py.js";
import { fatalError, summarizeError } from "../src/llm/index.js";
import type { InsertWarning } from "../src/models.js";
import type { LLMClient } from "../src/protocols.js";
import { Schema } from "../src/schema.js";
import { captureLog, freshGraphs, KUZU_SPEC } from "./helpers.js";

type Kind = "entities" | "relations" | "preferences" | "decisions";

const REPLIES: Record<Kind, unknown> = {
  entities: {
    entities: [
      { type: "Person", name: "Soham", aliases: ["S."] },
      { type: "Database", name: "HydraDB", aliases: null },
      { type: "Team", name: "Platform Team", aliases: [] },
      { type: "Quantity", name: "3 nodes", aliases: [] },
    ],
  },
  relations: {
    relations: [
      { from_name: "Soham", type: "member of", to_name: "Platform Team", event_time: "2025-01-02" },
      { from_name: "Platform Team", type: "CHOSE", to_name: "HydraDB", event_time: "not a date" },
      { from_name: "Soham", type: "USES", to_name: "Neo4j", event_time: null },
    ],
  },
  preferences: {
    preferences: [
      {
        subject_name: "Soham",
        stance: "preference",
        key: "database",
        value_name: "HydraDB",
        about_name: null,
        strength: 0.8,
      },
    ],
  },
  decisions: {
    decisions: [
      {
        title: "Adopt HydraDB",
        actor_name: "Platform Team",
        summary: null,
        rationale: "temporal history",
        outcome_name: "HydraDB",
        alternative_names: ["Neo4j"],
        status: "completed",
        steps: [{ from_name: "Platform Team", type: "CHOSE", to_name: "HydraDB" }],
      },
    ],
  },
};

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function kindOf(options: { responseFormat?: { schema?: unknown } }): Kind {
  const schema = JSON.stringify(options.responseFormat?.schema ?? {});
  return (["entities", "relations", "preferences", "decisions"] as const).find((k) => schema.includes(`"${k}"`))!;
}

function textOf(options: { prompt: Array<{ role: string; content: unknown }> }, role: string): string {
  const msg = options.prompt.find((m) => m.role === role);
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return (msg.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
}

/**
 * Build a mock AI SDK model that answers each extraction pass with JSON.
 *
 * @param answer ((kind: Kind, options: Record<string, unknown>) => unknown): the reply for a pass; throw to fail the call.
 * @return (MockLanguageModelV4): the model.
 */
function mockModel(
  answer: (kind: Kind, options: Record<string, unknown>) => unknown = (kind) => REPLIES[kind],
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const json = answer(kindOf(options as never), options as never);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(json) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: USAGE,
        warnings: [],
      } as never;
    },
  });
}

const open = freshGraphs(KUZU_SPEC, "llm");

describe("extraction name resolution", () => {
  const RESOLVE_TYPES = [
    "Person",
    "Company",
    "Organization",
    "Organisation",
    "Bank",
    "Org",
    "COMPANY",
    "Place",
    "Thing",
  ];
  const RESOLVE_BASES = ["Acme", "Beta", "Café", "Straße", "Ünï", "Jane Doe"];
  const RESOLVE_PREFIXES = ["", "The ", "the "];
  const RESOLVE_SUFFIXES = ["", " Inc", " inc.", " Corp", " LLC", "!", " Ltd"];
  const RESOLVE_CASES: Array<(text: string) => string> = [(t) => t, (t) => t.toUpperCase(), (t) => t.toLowerCase()];
  const RESOLVE_FORMS = ["NFC", "NFD"];
  const FILLERS = 1000;

  const seeded = (seed: number): (() => number) => {
    let state = seed + 1;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  };

  const pick = <T>(rng: () => number, items: T[]): T => items[Math.floor(rng() * items.length)]!;

  const resolveSurface = (rng: () => number): string =>
    pick(
      rng,
      RESOLVE_CASES,
    )(pick(rng, RESOLVE_PREFIXES) + pick(rng, RESOLVE_BASES) + pick(rng, RESOLVE_SUFFIXES)).normalize(
      pick(rng, RESOLVE_FORMS),
    );

  const scanResolve = (registry: Map<string, RawEntity>, name: string): string | null => {
    const matches = [...registry.values()].filter((e) => ids.entityId(e.type, name) === ids.entityId(e.type, e.name));
    if (matches.length > 1) return null;
    if (matches.length === 0) {
      const ent = { type: "Thing", name: name.trim() };
      registry.set(ids.entityId(ent.type, ent.name), ent);
      return ids.entityId(ent.type, ent.name);
    }
    return ids.entityId(matches[0]!.type, matches[0]!.name);
  };

  const limitDerivations = (budget: number): void => {
    let calls = 0;
    const guard =
      (real: (type: string, name: string) => string) =>
      (type: string, name: string): string => {
        calls += 1;
        if (calls > budget) throw new Error(`name resolution derived more than ${budget} ids`);
        return real(type, name);
      };
    const guardedEntityId = guard(idsModule.entityId);
    const guardedCanonicalName = guard(idsModule.canonicalName);
    vi.spyOn(idsModule, "entityId").mockImplementation(guardedEntityId);
    vi.spyOn(idsModule, "canonicalName").mockImplementation(guardedCanonicalName);
  };

  const fillers = (): RawEntity[] =>
    Array.from({ length: FILLERS }, (_, i) => ({ type: "Thing", name: `Filler ${i}` }));

  const assembleNames = (entities: RawEntity[], names: string[], warnings: InsertWarning[] = []) => {
    limitDerivations(3.5 * FILLERS + 20 * names.length);
    return assembleExtraction(
      [...fillers(), ...entities, { type: "Person", name: "Anchor" }],
      names.map((name, i) => ({ from_name: name, type: `R${i}`, to_name: "Anchor" })),
      [],
      [],
      warnings,
    );
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(Array.from({ length: 60 }, (_, seed) => seed))(
    "matches the linear scan on random name sets (seed %i)",
    (seed) => {
      const rng = seeded(seed);
      const entities = Array.from({ length: Math.floor(rng() * 15) }, () => ({
        type: pick(rng, RESOLVE_TYPES),
        name: resolveSurface(rng),
        aliases: [resolveSurface(rng)],
      }));
      const names = Array.from({ length: 40 }, () => resolveSurface(rng));
      const registry = new Map<string, RawEntity>();
      for (const ent of [...entities, { type: "Person", name: "Anchor" }]) {
        const key = ids.entityId(ent.type, ent.name);
        if (!registry.has(key)) registry.set(key, ent);
      }
      const expected = names.map((name) => scanResolve(registry, name));
      const warnings: InsertWarning[] = [];
      const facts = assembleNames(entities, names, warnings);
      expect(facts.relations.map((r) => r.from_entity)).toEqual(expected.filter((id) => id !== null));
      expect(facts.entities.slice(FILLERS).map((e) => [e.type, e.name])).toEqual(
        [...registry.values()].map((e) => [e.type, e.name]),
      );
      expect(warnings.map((w) => w.message)).toEqual(
        names
          .filter((_, i) => expected[i] === null)
          .map((name) => `unresolved extracted entity reference ${pyRepr(name)}: multiple entity types match`),
      );
    },
  );

  it.each([
    [
      [
        ["Organization", "Acme"],
        ["Company", "Acme Ltd"],
      ],
      "ACME Inc",
      null,
    ],
    [
      [
        ["Company", "Acme Ltd"],
        ["Organization", "Acme"],
      ],
      "ACME Inc",
      null,
    ],
    [
      [
        ["Person", "Acme"],
        ["Company", "Acme"],
      ],
      "Acme Inc",
      "company:acme",
    ],
    [
      [
        ["Person", "Acme!"],
        ["Company", "Acme Corp"],
      ],
      "Acme",
      null,
    ],
    [
      [
        ["Person", "Acme!"],
        ["Company", "Acme Corp"],
      ],
      "The Acme Inc",
      "company:acme",
    ],
    [
      [
        ["Person", "Acme!"],
        ["Company", "Acme Corp"],
      ],
      "ACME.",
      null,
    ],
    [
      [
        ["Person", "Bob"],
        ["Place", "Bob"],
      ],
      "BOB.",
      null,
    ],
    [[["Person", "Robert"]], "Bob", "thing:bob"],
    [
      [
        ["Person", "Bob"],
        ["Person", "Robert"],
      ],
      "BOB.",
      "person:bob",
    ],
    [
      [
        ["Person", "Bob"],
        ["Human", "Bob"],
      ],
      "bob",
      null,
    ],
    [[["Place", "Café"]], "Café", "place:café"],
    [[["Place", "Café"]], "CAFÉ", "place:café"],
    [[["COMPANY", "Acme Corp"]], "ACME inc", "company:acme"],
    [[["Person", "The Acme Inc"]], "The Acme Inc!", "person:the-acme-inc"],
    [[["Thing", "Acme Inc"]], "ACME INC.", "thing:acme-inc"],
    [[], "Acme Inc", "thing:acme-inc"],
  ] as Array<[Array<[string, string]>, string, string | null]>)(
    "pins the winner for %j and %s",
    (entities, name, expected) => {
      const warnings: InsertWarning[] = [];
      const facts = assembleNames(
        entities.map(([type, entityName]) => ({ type, name: entityName })),
        [name],
        warnings,
      );
      expect(facts.relations.map((r) => r.from_entity)).toEqual(expected === null ? [] : [expected]);
      expect(warnings).toHaveLength(expected === null ? 1 : 0);
    },
  );

  it.each(["!!!", "...", " - "])("drops the punctuation-only name %j without a warning", (name) => {
    const warnings: InsertWarning[] = [];
    const facts = assembleNames([{ type: "Person", name: "Bob" }], [name, "BOB."], warnings);
    expect(facts.relations.map((r) => r.from_entity)).toEqual(["person:bob"]);
    expect(warnings).toEqual([]);
  });

  it.each([true, false])("ignores aliases that name another entity (bob first: %s)", (bobFirst) => {
    const bob = { type: "Person", name: "Bob" };
    const robert = { type: "Person", name: "Robert", aliases: ["Bob", "Rob"] };
    const facts = assembleNames(bobFirst ? [bob, robert] : [robert, bob], ["BOB.", "ROB."]);
    expect(facts.relations.map((r) => r.from_entity)).toEqual(["person:bob", "thing:rob"]);
  });

  it("picks the endpoint type out of several matches", () => {
    limitDerivations(3.5 * FILLERS + 100);
    const schema = Schema.parse({
      entities: [{ name: "Person" }, { name: "Company" }],
      relations: [{ type: "WORKS_AT", from: { types: ["Person"] }, to: { types: ["Company"] } }],
    });
    const facts = assembleExtraction(
      [...fillers(), { type: "Company", name: "Acme" }, { type: "Person", name: "acme" }],
      [{ from_name: "ACME", type: "WORKS_AT", to_name: "Acme." }],
      [],
      [],
      [],
      schema,
    );
    expect(facts.relations.map((r) => [r.from_entity, r.to_entity])).toEqual([["person:acme", "company:acme"]]);
  });

  it.each([
    [["Person"], "person:acme"],
    [["Person", "Company"], null],
    [["Place"], "place:acme"],
    [["Org"], null],
  ] as Array<[string[], string | null]>)("narrows several matches by endpoint type %j", (fromTypes, expected) => {
    limitDerivations(3.5 * FILLERS + 100);
    const schema = Schema.parse({
      entities: [{ name: "Person" }, { name: "Company" }, { name: "Place" }, { name: "Org" }],
      relations: [{ type: "KNOWS", from: { types: fromTypes }, to: { types: ["Person"] } }],
    });
    const warnings: InsertWarning[] = [];
    const facts = assembleExtraction(
      [
        ...fillers(),
        ...["Company", "Person", "Place"].map((type) => ({ type, name: "Acme" })),
        { type: "Person", name: "Anchor" },
      ],
      [{ from_name: "ACME", type: "KNOWS", to_name: "Anchor" }],
      [],
      [],
      warnings,
      schema,
    );
    expect(facts.relations.map((r) => r.from_entity)).toEqual(expected === null ? [] : [expected]);
    expect(warnings).toHaveLength(expected === null ? 1 : 0);
  });

  it("resolves every kind of name lookup through the same index", () => {
    const acme = "ACME inc";
    const cafe = "Café";
    limitDerivations(3.5 * FILLERS + 100);
    const facts = assembleExtraction(
      [
        ...fillers(),
        { type: "Company", name: "Acme Corp" },
        { type: "Person", name: "Jane" },
        { type: "Place", name: "Café" },
      ],
      [{ from_name: acme, type: "OWNS", to_name: cafe }],
      [{ subject_name: acme, stance: "preference", key: "venue", value_name: cafe, about_name: acme }],
      [
        {
          title: "Pick a venue",
          actor_name: acme,
          outcome_name: cafe,
          alternative_names: [cafe, acme, "Nowhere Inc"],
          steps: [{ from_name: acme, type: "USES", to_name: cafe }],
        },
      ],
    );
    expect(facts.relations.map((r) => [r.from_entity, r.to_entity])).toEqual([
      ["company:acme", "place:café"],
      ["company:acme", "place:café"],
    ]);
    expect(facts.preferences.map((p) => [p.subject_entity, p.value_entity, p.about_entity])).toEqual([
      ["company:acme", "place:café", "company:acme"],
    ]);
    expect(facts.decisions.map((d) => [d.actor_entity, d.outcome_entity, d.alternative_entities])).toEqual([
      ["company:acme", "place:café", ["place:café", "company:acme", "thing:nowhere-inc"]],
    ]);
    expect(facts.entities.slice(FILLERS).map((e) => [e.type, e.name])).toEqual([
      ["Company", "Acme Corp"],
      ["Person", "Jane"],
      ["Place", "Café"],
      ["Thing", "Nowhere Inc"],
    ]);
  });

  it("drops invalid and blank names with one warning", () => {
    const bad = "Bad\u0000name";
    let warnings: InsertWarning[] = [];
    const alone = [0, 1].map((i) => ({ from_name: bad, type: `R${i}`, to_name: "Jane" }));
    expect(assembleExtraction([], alone, [], [], warnings).relations).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(["extraction_partial_failure"]);
    expect(warnings[0]!.message.startsWith("dropped an extracted entity: ")).toBe(true);

    warnings = [];
    const facts = assembleNames([], [bad, "  ", bad, "", "\t", "Gamma Inc"], warnings);
    expect(facts.relations.map((r) => r.from_entity)).toEqual(["thing:gamma-inc"]);
    expect(warnings.map((w) => w.code)).toEqual(["extraction_partial_failure"]);
    expect(warnings[0]!.message.startsWith("dropped an extracted entity: ")).toBe(true);
  });

  it("derives a bounded number of ids however many entities and names it resolves", () => {
    const n = 2000;
    limitDerivations(30 * n);
    const entities = Array.from({ length: n }, (_, i) => ({ type: "Person", name: `Person ${i}` }));
    const relations = Array.from({ length: n }, (_, i) => ({
      from_name: `Person ${i}`,
      type: "KNOWS",
      to_name: `Stranger ${i}`,
    }));
    const facts = assembleExtraction(entities, relations, [], []);
    expect(facts.entities).toHaveLength(2 * n);
    expect(facts.relations).toHaveLength(n);
  });
});

describe("LLM extraction through the AI SDK", () => {
  it.each([false, true])("issue 343 keeps same-name entities with different types (typed: %s)", async (typed) => {
    const llm: LLMClient = {
      async generate({ output }) {
        const kind = Object.keys((output as z.ZodObject<z.ZodRawShape>).shape)[0]!;
        if (kind === "entities")
          return {
            entities: [
              { type: "Person", name: "Acme", aliases: [] },
              { type: "Company", name: "acme", aliases: [] },
            ],
          } as never;
        if (kind === "relations")
          return { relations: [{ from_name: "Acme", type: "WORKS_AT", to_name: "acme", event_time: null }] } as never;
        if (kind === "decisions")
          return {
            decisions: [
              {
                title: "Join",
                actor_name: null,
                summary: null,
                rationale: null,
                outcome_name: null,
                alternative_names: [],
                status: null,
                steps: [{ from_name: "Acme", type: "WORKS_AT", to_name: "acme" }],
              },
            ],
          } as never;
        return { [kind]: [] } as never;
      },
    };
    const schema = typed
      ? {
          entities: [{ name: "Person" }, { name: "Company" }],
          relations: [{ type: "WORKS_AT", from: { types: ["Person"] }, to: { types: ["Company"] } }],
        }
      : null;
    const g = open({ llm, resolver: "exact", schema });
    const result = await g.insert.text("Acme works at acme.");
    expect(result.entities.map((e) => e.id).sort()).toEqual(["company:acme", "person:acme"]);
    expect((await g.entities.list()).items.map((e) => e.id).sort()).toEqual(["company:acme", "person:acme"]);
    if (typed) {
      expect(result.relations.map((r) => [r.from_entity, r.to_entity])).toEqual([["person:acme", "company:acme"]]);
      expect(result.decisions[0]!.steps.map((step) => step.relation_id)).toEqual([result.relations[0]!.id]);
      expect(result.warnings).toEqual([]);
    } else {
      expect(result.relations).toEqual([]);
      expect(result.decisions[0]!.steps).toEqual([]);
      expect(result.warnings.map((w) => w.code)).toEqual(Array(4).fill("extraction_partial_failure"));
    }
  });

  it.each([false, true])(
    "issue 360 unions aliases from every mention (multiple chunks: %s)",
    async (multipleChunks) => {
      let calls = 0;
      const llm: LLMClient = {
        async generate({ output }) {
          const kind = Object.keys((output as z.ZodObject<z.ZodRawShape>).shape)[0]!;
          if (kind !== "entities") return { [kind]: [] } as never;
          calls += 1;
          const first = { type: "Person", name: "Ann", aliases: ["A"] };
          const later = { type: "Person", name: "ann", aliases: ["A", "Annie"] };
          return { entities: multipleChunks && calls === 1 ? [first] : [first, later] } as never;
        },
      };
      const g = open({ llm, resolver: "exact" });
      const text = `Ann is also called Annie.${multipleChunks ? " context".repeat(650) : ""}`;
      expect((await loadTokenizer()).chunkText(text)).toHaveLength(multipleChunks ? 2 : 1);
      const result = await g.insert.text(text);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]!.aliases).toEqual(["A", "Annie"]);
      expect((await g.entities.get("person:ann"))!.aliases).toEqual(["A", "Annie"]);
      expect(result.warnings).toEqual([]);
    },
  );

  it("preserves source facts when one chunk call fails during replacement", async () => {
    let calls = 0;
    let phase = "initial";
    const llm: LLMClient = {
      async generate({ output }) {
        const kind = Object.keys((output as z.ZodObject<z.ZodRawShape>).shape)[0]!;
        if (kind === "entities")
          return {
            entities: [
              { type: "Person", name: "Jane", aliases: [] },
              { type: "Company", name: "Acme", aliases: [] },
              { type: "Company", name: "Globex", aliases: [] },
            ],
          } as never;
        if (kind !== "relations") return { [kind]: [] } as never;
        calls += 1;
        if (phase === "partial" && calls === 2) throw new Error("provider timed out");
        const target = phase === "initial" && calls === 2 ? "Globex" : "Acme";
        return { relations: [{ from_name: "Jane", type: "WORKS_AT", to_name: target, event_time: null }] } as never;
      },
    };
    const g = open({ llm, resolver: "exact" });
    const text = "Jane works at Acme and Globex." + " context".repeat(650);
    expect((await loadTokenizer()).chunkText(text)).toHaveLength(2);
    const options = { source_id: "doc", replace_source: true };
    const first = await g.insert.text(text, options);
    const prior = first.relations.map((r) => r.id).sort();
    expect(prior).toHaveLength(2);
    phase = "partial";
    calls = 0;
    const result = await g.insert.text(text + " Updated.", options);
    expect(calls).toBe(2);
    expect(result.warnings.map((w) => w.code)).toEqual(["extraction_partial_failure"]);
    expect(result.source_diff!.retired).toEqual([]);
    expect(result.source_diff!.kept).toEqual(result.relations.map((r) => r.id).sort());
    expect((await g.relations.list()).items.map((r) => r.id).sort()).toEqual(prior);
    expect((await g.relations.list({ include_invalidated: true })).items.every((r) => r.is_current)).toBe(true);
    phase = "complete";
    calls = 0;
    const complete = await g.insert.text(text + " Removed Globex.", options);
    expect(calls).toBe(2);
    const produced = complete.relations.map((r) => r.id).sort();
    expect(complete.source_diff!.retired).toEqual(prior.filter((id) => !produced.includes(id)));
    expect(complete.warnings.map((w) => w.code)).toEqual(["fact_retired_by_source"]);
    expect((await g.relations.list()).items.map((r) => r.id).sort()).toEqual(produced);
  });

  it.each([
    [[null, "2020-01-01"], "2020-01-01"],
    [["2020-01-01", null], "2020-01-01"],
    [[null, null], null],
    [["2020-01-01", "2020-01-01"], "2020-01-01"],
    [["2020-01-01", "2022-01-01"], "2022-01-01"],
    [["2022-01-01", "2020-01-01"], "2020-01-01"],
    [[null, "2020-01-01", "2022-01-01"], "2022-01-01"],
    [["not a date", "2020-01-01"], "2020-01-01"],
    [["2020-01-01", "not a date"], "2020-01-01"],
    [["0001", null], "0001-01-01"],
  ] as Array<[(string | null)[], string | null]>)(
    "keeps the last valid date from repeated extracted relations: %j",
    (dates, expected) => {
      const facts = assembleExtraction(
        [
          { type: "Person", name: "Jane" },
          { type: "Company", name: "Acme" },
        ],
        dates.map((event_time) => ({ from_name: "Jane", type: "WORKS_AT", to_name: "Acme", event_time })),
        [],
        [],
      );
      expect(facts.relations).toHaveLength(1);
      expect(facts.relations[0]!.event_time?.toISOString() ?? null).toBe(
        expected === null ? null : `${expected}T00:00:00.000Z`,
      );
      expect(facts.relations[0]).toMatchObject({
        from_entity: "person:jane",
        type: "WORKS_AT",
        to_entity: "company:acme",
      });
    },
  );

  it.each([false, true])(
    "merges dates, properties and evidence for repeated extracted relations (multiple chunks: %s)",
    async (multipleChunks) => {
      const first = [
        { event_time: "2020-01-01", properties: { role: "Engineer", remove: "old", nested: { old: 1 } } },
        { event_time: null, properties: { team: "Platform" } },
      ];
      const later = [
        { event_time: "2022-01-01", properties: { role: "Lead", remove: null, nested: { new: 2 } } },
        { event_time: "not a date", properties: { office: "London" } },
        { event_time: null },
      ];
      const text = `Jane works at Acme.${multipleChunks ? " context".repeat(650) : ""}`;
      const chunks = (await loadTokenizer()).chunkText(text);
      expect(chunks.length > 1).toBe(multipleChunks);
      let relationCalls = 0;
      const llm = {
        async generate({ output }: { output: z.ZodType }) {
          const [kind] = Object.keys((output as z.ZodObject).shape);
          if (kind === "entities")
            return {
              entities: [
                { type: "Person", name: "Jane", aliases: [] },
                { type: "Company", name: "Acme", aliases: [] },
              ],
            };
          if (kind === "relations") {
            relationCalls++;
            const rows = multipleChunks ? (relationCalls === 1 ? first : later) : [...first, ...later];
            return { relations: rows.map((row) => ({ from_name: "Jane", type: "WORKS_AT", to_name: "Acme", ...row })) };
          }
          return { [kind!]: [] };
        },
      } as unknown as LLMClient;
      const g = open({ llm, resolver: "exact" });
      const result = await g.insert.text(text, { source_id: "dated-chunks" });
      const [rel] = (await g.relations.list()).items;
      expect(rel!.event_time?.toISOString()).toBe("2022-01-01T00:00:00.000Z");
      expect(rel!.properties).toEqual({ role: "Lead", team: "Platform", office: "London", nested: { new: 2 } });
      expect(result.relations).toHaveLength(1);
      expect(relationCalls).toBe(chunks.length);
      const evidence = (await g.relations.evidence(rel!.id)).items;
      expect(new Set(evidence.map((e) => e.chunk_id))).toEqual(
        new Set(chunks.map((c) => ids.chunkId(result.source_version!, c.index))),
      );
      expect(rel!.source_count).toBe(1);
      expect((await g.retrieve("Jane", { as_of: "2023-01-01" })).subgraph.relations.map((r) => r.id)).toEqual([
        rel!.id,
      ]);
    },
  );

  const relationsLlm = (rows: Array<Record<string, unknown>>) =>
    ({
      async generate({ output }: { output: z.ZodType }) {
        const [kind] = Object.keys((output as z.ZodObject).shape);
        if (kind === "entities")
          return {
            entities: [
              { type: "Person", name: "Jane", aliases: [] },
              { type: "Company", name: "Acme", aliases: [] },
            ],
          };
        if (kind === "relations")
          return {
            relations: rows.map((row) => ({
              from_name: "Jane",
              type: "WORKS_AT",
              to_name: "Acme",
              event_time: null,
              ...row,
            })),
          };
        return { [kind!]: [] };
      },
    }) as unknown as LLMClient;

  it.each([
    [[{ properties: { role: null } }], { team: "Platform" }],
    [
      [{ properties: { role: "a", office: "London" } }, { properties: { role: null } }],
      { team: "Platform", office: "London" },
    ],
    [[{ properties: { role: null } }, { properties: { role: "b" } }], { team: "Platform", role: "b" }],
  ])("lets an extracted null property clear the stored key: %j", async (rows, expected) => {
    const g = open({ llm: relationsLlm(rows), resolver: "exact" });
    await g.insert.facts({
      entities: [
        { type: "Person", name: "Jane" },
        { type: "Company", name: "Acme" },
      ],
      relations: [
        {
          from_entity: "person:jane",
          type: "WORKS_AT",
          to_entity: "company:acme",
          properties: { role: "x", team: "Platform" },
        },
      ],
    });
    const res = await g.insert.text("Jane works at Acme.", { source_id: "null-props" });
    expect(res.warnings).toEqual([]);
    const [rel] = (await g.relations.list()).items;
    expect(rel!.properties).toEqual(expected);
    expect(rel!.revision).toBe(2);
  });

  it("drops an extracted relation with a proto or control property key or a non-JSON value with a warning", async () => {
    const bad = [
      JSON.parse('{"__proto__": 1}'),
      JSON.parse('{"nested": {"__proto__": {}}}'),
      { "a\u0000b": 1 },
      { nested: [{ "a\u0000b": 1 }] },
      { when: new Date("2022-01-01T00:00:00Z") },
      { p: Number.POSITIVE_INFINITY },
      { p: Number.NaN },
    ];
    const rows = [{ properties: { ok: 1 } }, ...bad.map((properties) => ({ properties, event_time: "2022-01-01" }))];
    const g = open({ llm: relationsLlm(rows), resolver: "exact" });
    const res = await g.insert.text("Jane works at Acme.", { source_id: "bad-prop-keys" });
    const proto = "dropped an extracted relation: property and external id keys cannot be '__proto__'";
    const control =
      "dropped an extracted relation: relation property keys cannot contain control or surrogate characters";
    const date = "dropped an extracted relation: relation property cannot hold Date values; use an ISO 8601 string";
    const finite =
      "dropped an extracted relation: relation property cannot hold NaN or Infinity; use a finite number or a string";
    expect(res.warnings.map((w) => [w.code, w.message])).toEqual(
      [proto, proto, control, control, date, finite, finite].map((m) => ["extraction_partial_failure", m]),
    );
    const [rel] = (await g.relations.list()).items;
    expect([rel!.properties, rel!.event_time]).toEqual([{ ok: 1 }, null]);
  });

  it("extracts and resolves names to deterministic ids the way Python does", async () => {
    const seen: Array<{ kind: Kind; system: string; user: string }> = [];
    const signals: unknown[] = [];
    const model = mockModel((kind, options) => {
      seen.push({ kind, system: textOf(options as never, "system"), user: textOf(options as never, "user") });
      signals.push(options.abortSignal);
      return REPLIES[kind];
    });
    const text = "Soham on the Platform Team chose HydraDB over Neo4j for temporal history.";
    const res = await open({ llm: model }).insert.text(text, { source_id: "chat" });

    expect(seen.map((s) => s.kind)).toEqual(["entities", "relations", "preferences", "decisions"]);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(seen[0]!.system.startsWith("You extract entities for a knowledge graph.")).toBe(true);
    expect(seen[0]!.user).toBe(`Extract every entity from the text below.\n\n\nText:\n"""\n${text}\n"""`);

    expect(res.entities.map((e) => e.id)).toEqual([
      "person:soham",
      "database:hydradb",
      "team:platform-team",
      "quantity:3-nodes",
      "thing:neo4j",
    ]);
    expect(res.entities[0]!.aliases).toEqual(["S."]);
    expect(res.relations.map((r) => [r.type, r.event_time?.toISOString() ?? null])).toEqual([
      ["MEMBER_OF", "2025-01-02T00:00:00.000Z"],
      ["CHOSE", null],
      ["USES", null],
    ]);
    const pref = { subject_entity: "person:soham", value_entity: "database:hydradb", strength: 0.8 };
    expect(res.preferences[0]).toMatchObject(pref);
    expect(res.decisions[0]).toMatchObject({
      id: "decision:13497e2ba2c6ede055d4b2fc",
      outcome_entity: "database:hydradb",
      alternative_entities: ["thing:neo4j"],
    });
    expect(res.decisions[0]!.steps[0]!.relation_id).toBe("relation:6c3390fa7879ec144c96a8d8");
    expect(res.warnings).toEqual([]);
  });

  it("keeps a stored decision's fields when the model restates it without them", async () => {
    let restate = false;
    const model = mockModel((kind) => {
      if (kind !== "decisions" || !restate) return REPLIES[kind];
      const [dec] = (REPLIES.decisions as { decisions: object[] }).decisions;
      return { decisions: [{ ...dec, rationale: null, status: null }] };
    });
    const g = open({ llm: model });
    const text = "Soham on the Platform Team chose HydraDB over Neo4j for temporal history.";
    const [dec] = (await g.insert.text(text, { source_id: "chat" })).decisions;
    expect(dec!.status).toBe("completed");
    await g.decisions.update(dec!.id, { status: "active" });
    restate = true;
    const [again] = (await g.insert.text(`${text} Again.`, { source_id: "notes" })).decisions;
    expect(again).toMatchObject({ id: dec!.id, status: "active", rationale: "temporal history" });
  });

  it("re-asks when a reply does not match the schema", async () => {
    let entityCalls = 0;
    const model = mockModel((kind) => {
      if (kind === "entities" && entityCalls++ === 0) return { entities: [{ nope: true }] };
      return kind === "entities" ? REPLIES.entities : { [kind]: [] };
    });
    const res = await open({ llm: model }).insert.text("Soham likes HydraDB.");
    expect(entityCalls).toBe(2);
    expect(res.entities.map((e) => e.id)).toContain("person:soham");
  });

  it("drops an invalid item or failed pass with one cleaned warning each and keeps the rest", async () => {
    const extra: Partial<Record<Kind, unknown>> = {
      relations: {
        relations: [
          ...(REPLIES.relations as { relations: unknown[] }).relations,
          { from_name: "Soham", type: "", to_name: "HydraDB", event_time: null },
          { from_name: "Soham", type: "has_step", to_name: "HydraDB", event_time: null },
        ],
      },
      preferences: {
        preferences: [
          ...(REPLIES.preferences as { preferences: unknown[] }).preferences,
          {
            subject_name: "Soham",
            stance: "preference",
            key: "editor",
            value_name: "HydraDB",
            about_name: null,
            strength: 2,
          },
        ],
      },
    };
    const model = mockModel((kind) => {
      if (kind === "decisions") throw new Error(`\u001b[31mModelResponse(id=1)\u001b[0m\n${"y".repeat(500)}`);
      return extra[kind] ?? REPLIES[kind];
    });
    const res = await open({ llm: model }).insert.text("Soham chose HydraDB.", { source_id: "m-sum" });
    expect(res.relations.map((r) => r.type)).toEqual(["MEMBER_OF", "CHOSE", "USES"]);
    expect(res.preferences.map((p) => p.key)).toEqual(["database"]);
    expect(res.decisions).toEqual([]);
    const partial = res.warnings.filter((w) => w.code === "extraction_partial_failure");
    expect(partial).toHaveLength(3);
    expect(partial.some((w) => w.message.includes("preference strength"))).toBe(true);
    const failed = partial.find((w) => w.message.startsWith("decisions"))!;
    expect(failed.message).toBe("decisions extraction failed on chunk 0: Error: ModelResponse(id=1)");
    expect([failed.chunk_id, failed.source_id]).toEqual([ids.chunkId(res.source_version!, 0), "m-sum"]);
    expect(res.warnings.filter((w) => w.code === "dropped_reserved_relation").map((w) => w.message)).toEqual([
      "dropped an extracted relation: relation type 'has_step' is reserved for internal use; choose another type",
    ]);
  });

  it("never re-substitutes placeholders in the document text and rejects a bad template at build time", () => {
    const slotted = { system: "s", user: "{instructions}|{text}", version: "v1" };
    expect(render(slotted, "doc {instructions} {text}", "be brief {text}")[1]).toBe(
      "be brief {text}|doc {instructions} {text}",
    );
    const appended = { system: "s", user: "T:{text}", version: "v2" };
    expect(render(appended, "doc {instructions}", "extra")[1]).toBe(
      "T:doc {instructions}\n\nAdditional instructions:\nextra",
    );
    expect(() => render({ system: "s", user: "none", version: "1" }, "doc", null, "entities")).toThrow(
      "prompt 'entities' is missing required variable {text}",
    );
    const missing = { entities: { system: "s", user: "no placeholder", version: "v1" } };
    expect(() => open({ prompts: missing })).toThrow(
      new PromptTemplateError("prompt 'entities' is missing required variable {text}"),
    );
    const bogus = { relations: { system: "s", user: "{text} {bogus}", version: "v1" } };
    const message = "prompt 'relations' uses unknown variable {bogus}; allowed variables: {text}, {instructions}";
    expect(() => open({ prompts: bogus })).toThrow(new PromptTemplateError(message));
    const llm = {} as LLMClient;
    expect(() => new LLMExtractor(llm, { call_prompts: bogus })).toThrow(message);
    const ok = { entities: { system: "s", user: '{instructions} {text} {"json": 1}', version: "v1" } };
    expect(() => new LLMExtractor(llm, { prompts: ok })).not.toThrow();
  });

  it("rejects an unknown provider, config key, or llm shape when built, and checks a client's output", async () => {
    for (const [config, error] of [
      [{ provider: "nonesuch", model: "x" }, /^unknown LLM provider 'nonesuch': use one of anthropic, /],
      [{ provider: "opnai", model: "x" }, /; did you mean 'openai'\?$/],
      [{ provider: "nope", model: "x" }, /^(?!.*did you mean).*$/s],
      [{ provider: "openai", model: "m", concurrency: 0 }, ValidationError],
      [{ provider: "openai", model: "m", timeout: 0 }, ValidationError],
      [{ provider: "openai", model: "m", apikey: "k" }, "unknown key 'apikey' in llm config; did you mean 'api_key'?"],
    ] as const) {
      expect(() => buildLlmClient(config as never)).toThrow(error);
    }
    expect(buildLlmClient({ provider: "openai", model: "m" })).toMatchObject({ concurrency: 4 });
    expect(() => new SelfGraph(new KuzuStore(":memory:"), { llm: { provider: "nope", model: "x" } })).toThrow(
      ValidationError,
    );
    expect(buildLlmClient({ provider: "custom", model: "m", base_url: "http://localhost:1" })).toBeDefined();
    const unknownShape = () => new SelfGraph(new KuzuStore(":memory:"), { llm: { chat() {} } });
    expect(unknownShape).toThrow(ValidationError);
    expect(unknownShape).toThrow(/AI SDK language model/);
    const partial = { generate: async () => ({ entities: [] }) } as unknown as LLMClient;
    await expect(open({ llm: partial }).insert.text("Soham chose HydraDB.")).rejects.toThrow(
      /LLM client returned an invalid result for the relations pass: relations: field required/,
    );
  });

  it.each([null, 2024])("revalidates a mutated output object: %j", async (value) => {
    const llm: LLMClient = {
      async generate<T>({ output }: { output: z.ZodType<T> }): Promise<T> {
        const kind = kindOf({ responseFormat: { schema: z.toJSONSchema(output) } });
        const result = output.parse(REPLIES[kind]);
        if (kind === "relations") {
          const reply = result as { relations: Array<{ event_time: unknown }> | null };
          if (value === null) reply.relations = null;
          else reply.relations![0]!.event_time = value;
        }
        return result;
      },
    };
    const g = open({ llm });
    const result = g.insert.text("Soham chose HydraDB.", { source_id: "s" });
    await expect(result).rejects.toBeInstanceOf(ExtractionError);
    await expect(result).rejects.toMatchObject({ code: "invalid_llm_output" });
    expect((await g.entities.list()).items).toEqual([]);
    expect((await g.relations.list()).items).toEqual([]);
  });

  it("extracts up to llm concurrency chunks at once and merges them in chunk order", async () => {
    const text = Array.from({ length: 6 }, (_, i) => `Chunk${i} filler words here. `.repeat(300)).join(" ");
    const orders: string[][] = [];
    for (const [concurrency, peak] of [
      [1, 4],
      [2, 8],
    ]) {
      let active = 0;
      let seen = 0;
      const llm = {
        concurrency,
        async generate({ user, output }: { user: string; output: z.ZodType }) {
          active += 1;
          seen = Math.max(seen, active);
          await new Promise((resolve) => setTimeout(resolve, user.includes("Chunk0") ? 30 : 5));
          active -= 1;
          const name = /Chunk\d+/.exec(user)![0];
          const [kind] = Object.keys((output as unknown as z.ZodObject).shape);
          return output.parse({ [kind!]: kind === "entities" ? [{ type: "Word", name, aliases: null }] : [] });
        },
      } as unknown as LLMClient;
      const facts = await new LLMExtractor(llm).extract({ text, media_type: "text/plain", metadata: {} });
      orders.push(facts.entities.map((e) => e.name));
      expect(seen).toBe(peak);
    }
    expect(orders[0]).toEqual(Array.from({ length: 6 }, (_, i) => `Chunk${i}`));
    expect(orders[1]).toEqual(orders[0]);
  });

  it("logs the no-LLM warning and chunk progress, and cites the chunk on extracted relations", async () => {
    const basic = await captureLog(() => open().insert.text("Acme acquired Globex."));
    expect(basic.result.warnings.map((w) => w.code)).toEqual(["basic_extraction"]);
    expect(basic.logged).toContain(`warning: basic_extraction: ${basic.result.warnings[0]!.message}`);
    expect(basic.result.warnings[0]!.message).toContain("pass llm in the SelfGraph options");
    const text = Array(400).fill("Soham on the Platform Team chose HydraDB over Neo4j.").join(" ");
    const g = open({ llm: mockModel() });
    const { result: res, logged } = await captureLog(() => g.insert.text(text, { source_id: "long" }));
    const progress = logged.filter((m) => m.includes("extracting chunk"));
    const total = progress.length;
    expect(total).toBeGreaterThan(1);
    expect(progress[0]).toBe(`info: extracting chunk 1/${total}`);
    const rel = res.relations.find((r) => r.type === "CHOSE")!;
    const evidence = (await g.relations.evidence(rel.id, { limit: 100 })).items;
    expect(new Set(evidence.map((ev) => ev.chunk_id))).toEqual(
      new Set(Array.from({ length: total }, (_, i) => ids.chunkId(res.source_version!, i))),
    );
  });

  it.each([
    ["every call fails", () => new Error("down"), /whole input \(4 of 4 LLM calls failed\)/],
    [
      "nothing was extracted and a call failed",
      (kind: Kind) => (kind === "entities" ? new Error("No tool calls or function call found") : null),
      /whole input \(1 of 4 LLM calls failed\)/,
    ],
    [
      "authentication fails",
      () =>
        new APICallError({
          message: "\u001b[31mAPI key not valid\u001b[0m",
          url: "https://example.test",
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        }),
      /^LLM authentication failed for provider mock-provider: check the API key, set by api_key in the llm config \(or SELFGRAPH_LLM_API_KEY\)$/,
    ],
    [
      "a prebuilt model has no key",
      () => new LoadAPIKeyError({ message: "Pass it using the 'apiKey' parameter or GOOGLE_GENERATIVE_AI_API_KEY" }),
      "no API key for LLM provider mock-provider: SelfGraph cannot pass a key to a prebuilt AI SDK model; " +
        "set GOOGLE_GENERATIVE_AI_API_KEY, or pass apiKey when you create the provider",
    ],
  ] as const)("raises ExtractionError when %s", async (_, failure, message) => {
    let calls = 0;
    const model = mockModel((kind) => {
      calls++;
      const exc = failure(kind);
      if (exc) throw exc;
      return { [kind]: [] };
    });
    const err = await open({ llm: model })
      .insert.text("Soham chose HydraDB.")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as Error).message).toMatch(message);
    expect(calls).toBeLessThanOrEqual(4);
  });

  it("turns a reserved preference relation into a preference and drops reserved decision steps", async () => {
    const llm: LLMClient = {
      async generate({ system, output }) {
        const reply = {
          entities: [
            { type: "Person", name: "Soham", aliases: null },
            { type: "Database", name: "Postgres", aliases: null },
          ],
          relations: [
            { from_name: "Soham", type: "prefers", to_name: "Postgres", event_time: null },
            { from_name: "Soham", type: "AVOIDS", to_name: "Mongo", event_time: null },
          ],
          preferences: [],
          decisions: [],
        };
        const reserved =
          "AVOIDS, CONSIDERED, FROM, HAS_CHUNK, HAS_PROFILE, HAS_STEP, HAS_VERSION, MADE_DECISION, PREFERS, RESULTED_IN, TO";
        if (system.startsWith("You extract directed relationships")) {
          expect(system.endsWith(`Never use these reserved relationship types: ${reserved}.`)).toBe(true);
        }
        if (system.startsWith("You extract decision traces")) {
          expect(system).toContain(`never these reserved relationship types: ${reserved}. Put the alternatives`);
          expect(system.endsWith("never as CONSIDERED or RESULTED_IN steps.")).toBe(true);
        }
        return output.parse(reply);
      },
    };
    const extractor = new LLMExtractor(llm);
    const facts = await extractor.extract({
      text: "Soham prefers Postgres.",
      media_type: "text/plain",
      metadata: {},
    });
    expect(facts.preferences.map((p) => [p.stance, p.key, p.value_entity])).toEqual([
      ["preference", "database", "database:postgres"],
    ]);
    expect(facts.relations).toEqual([]);
    const dropped = extractor.popWarnings();
    expect(dropped.map((w) => w.code)).toEqual(["dropped_reserved_relation"]);
    expect(dropped[0]!.message).toContain("'AVOIDS' is reserved");
    const step = { from_name: "Team", type: "CONSIDERED", to_name: "Neo4j" };
    const decision = { title: "Pick a DB", actor_name: "Team", outcome_name: "HydraDB", steps: [step, step] };
    const warnings: InsertWarning[] = [];
    const assembled = assembleExtraction([], [], [], [decision], warnings);
    expect(warnings.map((w) => w.code)).toEqual(["dropped_reserved_relation", "dropped_reserved_relation"]);
    expect([assembled.relations, assembled.decisions[0]!.steps]).toEqual([[], []]);
  });

  it("drops a relation whose endpoint name is invalid with one warning instead of failing the insert", () => {
    const warnings: InsertWarning[] = [];
    const facts = assembleExtraction(
      [{ type: "Person", name: "Ann" }],
      [{ from_name: "Bob\nLee", type: "KNOWS", to_name: "Ann" }],
      [],
      [],
      warnings,
    );
    expect(facts.entities.map((e) => e.name)).toEqual(["Ann"]);
    expect(facts.relations).toEqual([]);
    expect(warnings.map((w) => w.message)).toEqual([
      "dropped an extracted entity: entity name cannot contain control or surrogate characters",
    ]);
  });

  it("keeps relation properties returned by the LLM", async () => {
    const llm: LLMClient = {
      async generate({ output }) {
        const shape = (output as unknown as z.ZodObject<z.ZodRawShape>).shape;
        if ("entities" in shape) {
          return output.parse({
            entities: [
              { type: "Person", name: "Jane", aliases: null },
              { type: "Company", name: "Acme", aliases: null },
            ],
          });
        }
        if ("relations" in shape) {
          return output.parse({
            relations: [
              {
                from_name: "Jane",
                type: "WORKS_AT",
                to_name: "Acme",
                properties: { role: "cto" },
                event_time: null,
              },
            ],
          });
        }
        return output.parse({ preferences: [], decisions: [] });
      },
    };
    const facts = await new LLMExtractor(llm).extract({
      text: "Jane works at Acme as cto.",
      media_type: "text/plain",
      metadata: {},
    });
    expect(facts.relations).toHaveLength(1);
    expect(facts.relations[0]!.properties).toEqual({ role: "cto" });
  });

  it("masks base_url credentials in the model-not-found error", () => {
    const exc = Object.assign(new Error("Not Found"), { statusCode: 404 });
    const err = fatalError(exc, {
      provider: "openai",
      model: "m",
      base_url: "https://proxyuser:hunter2@llm.example/v1",
    });
    expect(err?.message).toContain('LLM model "m" was not found for provider openai at https://***@llm.example/v1');
    expect(err?.message).not.toContain("hunter2");
    expect(err?.code).toBe("llm_model_not_found");
  });

  it("masks a base_url the provider quotes in a summarized error", () => {
    const exc = new Error("APICallError: request to https://u:secret@llm.example/v1/chat failed");
    const summary = summarizeError(exc, "https://u:secret@llm.example/v1");
    expect(summary).not.toContain("secret");
    expect(summary).toContain("https://***@llm.example/v1");
  });

  it("uses chat completions for the openai provider with a base_url and reports a refused connection as its root cause", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"Not Found"}}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/v1`;
    const call = (options: { max_retries?: number; timeout?: number }) =>
      buildLlmClient({ provider: "openai", model: "m", api_key: "k", base_url: base, ...options })
        .generate({ system: "", user: "hi", output: z.object({}) })
        .catch((e: unknown) => e);
    try {
      expect(String(await call({ max_retries: 0 }))).toContain(
        `LLM model "m" was not found for provider openai at ${base}`,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(paths).toEqual(["/v1/chat/completions"]);
    expect(summarizeError(await call({ timeout: 0.5 }))).toBe(`connection refused 127.0.0.1:${port}`);
  });
});
it.each([false, true])("does not classify a reply quoting invalid API key as authentication: wrapped=%s", (wrapped) => {
  const config = { provider: "openai", model: "m" };
  const error = Object.assign(new Error('Could not parse model reply: "invalid API key"'), {
    name: "AI_NoObjectGeneratedError",
  });
  const exc = wrapped ? Object.assign(new Error("retry failed"), { name: "AI_RetryError", lastError: error }) : error;
  expect(fatalError(exc, config)).toBeNull();
  const auth = fatalError(Object.assign(new Error("unauthorized"), { statusCode: 401 }), config);
  expect(auth?.code).toBe("llm_auth_failed");
  expect(auth?.message).toBe(
    "LLM authentication failed for provider openai: check the API key, set by " +
      "api_key in the llm config (or SELFGRAPH_LLM_API_KEY)",
  );
});

it("issue 361 extraction defaults and strength", async () => {
  for (const strength of [null, true, false, "0.5", "0_._5", "nan", Number.NaN, Infinity, -Infinity]) {
    const replies: Record<string, unknown[]> = {
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
      ],
      relations: [{ from_name: "Ann", type: "WORKS_AT", to_name: "Acme" }],
      preferences: [{ subject_name: "Ann", key: "food", value_name: "Pizza", strength }],
      decisions: [{ title: "Choose lunch" }],
    };
    const llm: LLMClient = {
      async generate({ output }) {
        const kind = Object.keys((output as z.ZodObject<z.ZodRawShape>).shape)[0]!;
        return { [kind]: replies[kind] ?? [] } as never;
      },
    };
    const result = await open({ llm }).insert.text("Ann works at Acme and chooses lunch.");
    expect(result.entities.map((e) => e.id)).toEqual(expect.arrayContaining(["person:ann", "company:acme"]));
    expect(result.relations).toHaveLength(1);
    expect(result.decisions).toHaveLength(1);
    const invalid = ["nan", "infinity", "-infinity"].includes(String(strength).toLowerCase());
    expect(result.preferences).toHaveLength(invalid ? 0 : 1);
    expect(result.warnings.map((w) => w.code)).toEqual(invalid ? ["extraction_partial_failure"] : []);
    if (!invalid) {
      expect(result.preferences[0]!.stance).toBe("preference");
      expect(result.preferences[0]!.strength).toBe(
        strength === null ? null : Number(typeof strength === "string" ? strength.replaceAll("_", "") : strength),
      );
    }
  }
});

it("issue 362 drops only bad extracted alias", async () => {
  for (const alias of ["Acme\u0007Inc", "Acme\u0000Inc", "Acme\ud800Inc", "Acme\u0085Inc"]) {
    const replies: Record<string, unknown[]> = {
      entities: [
        { type: "Person", name: "Ann", aliases: [] },
        { type: "Company", name: "Acme", aliases: ["AC", alias] },
      ],
      relations: [{ from_name: "Ann", type: "WORKS_AT", to_name: "Acme", event_time: null }],
    };
    const llm: LLMClient = {
      async generate({ output }) {
        const kind = Object.keys((output as z.ZodObject<z.ZodRawShape>).shape)[0]!;
        return { [kind]: replies[kind] ?? [] } as never;
      },
    };
    const g = open({ llm });
    const result = await g.insert.text("Ann works at Acme.");
    expect(result.entities.map((e) => e.id).sort()).toEqual(["company:acme", "person:ann"]);
    expect((await g.entities.get("company:acme"))!.aliases).toEqual(["AC"]);
    expect(result.relations).toHaveLength(1);
    expect(result.warnings.map((w) => [w.code, w.message])).toEqual([
      [
        "extraction_partial_failure",
        "dropped an extracted alias: entity alias cannot contain control or surrogate characters",
      ],
    ]);
    await expect(g.insert.facts({ entities: [{ type: "Company", name: "Other", aliases: [alias] }] })).rejects.toThrow(
      "entity alias cannot contain",
    );
  }
});

it("issue 363 discards out of range extracted time", async () => {
  for (const event_time of ["9999-12-31T23:59:59-14:00", "0001-01-01T00:00:00+14:00"]) {
    const llm: LLMClient = {
      async generate({ output }) {
        const kind = Object.keys((output as z.ZodObject<z.ZodRawShape>).shape)[0]!;
        return {
          [kind]: kind === "relations" ? [{ from_name: "Ann", type: "KNOWS", to_name: "Bob", event_time }] : [],
        } as never;
      },
    };
    const g = open({ llm });
    const result = await g.insert.text("Ann knows Bob.");
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.event_time).toBeNull();
    expect(result.warnings).toEqual([]);
    expect((await g.relations.get(result.relations[0]!.id))!.event_time).toBeNull();
  }
});

import { AsyncLocalStorage } from "node:async_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  buildGraph,
  DEFAULT_SETTINGS,
  type Embedder,
  fromTables,
  type GraphSettings,
  type InsertResult,
  ids,
  type LLMClient,
  type Schema,
  SelfGraph,
  TransientError,
  ValidationError,
} from "../src/index.js";
import { callTool, close as closeMcp, configure as configureMcp } from "../src/mcp.js";
import { LLMResolver, type ResolutionDecision } from "../src/resolution.js";
import { stem } from "../src/terms.js";
import {
  buildCli,
  captureLog,
  forEachStore,
  freshGraphs,
  runCli,
  type StoreSpec,
  tempKuzu,
  uniqueNs,
  worksAt,
} from "./helpers.js";

const ACME = ids.relationId("person:ann", "WORKS_AT", "company:acme");
const GLOBEX = ids.relationId("person:ann", "WORKS_AT", "company:globex");
const ANN_ACME_GLOBEX = [
  { type: "Person", name: "Ann" },
  { type: "Company", name: "Acme" },
  { type: "Company", name: "Globex" },
];
const ROBERT = { type: "Person", name: "Robert Johnson", aliases: ["Bob Johnson"] };
const BOB = { type: "Person", name: "Bob Johnson" };
const TERMS: Schema = {
  entities: [
    {
      name: "Company",
      synonyms: ["employer", "firm"],
      certified: true,
      definitions: [{ name: "headcount", expression: "count(Person)", synonyms: ["staff size"] }],
    },
    { name: "Person", aliases: ["user"] },
  ],
  relations: [{ type: "WORKS_AT", synonyms: ["employed by"] }],
};

const annAt = (company: string, year: number) => worksAt("person:ann", `company:${company}`, year);

class Judge implements LLMClient {
  readonly prompts: string[] = [];
  constructor(private readonly retire: number[] = [1]) {}

  async generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T> {
    this.prompts.push(args.user);
    return args.output.parse({ retired: this.retire });
  }
}

class WritingLLM implements LLMClient {
  readonly prompts: string[] = [];
  write: (() => Promise<unknown>) | null = null;
  private readonly otherClient = AsyncLocalStorage.snapshot();
  constructor(private readonly answer: Record<string, unknown>) {}

  async generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T> {
    this.prompts.push(args.user);
    const write = this.write;
    if (write !== null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("the write waited on the LLM call")), 5000);
      });
      await Promise.race([this.otherClient(() => write()), timeout]).finally(() => clearTimeout(timer));
    }
    return args.output.parse(this.answer);
  }
}

class PausedJudge implements LLMClient {
  release: () => void = () => {};
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private markAsked: () => void = () => {};
  readonly asked = new Promise<void>((resolve) => {
    this.markAsked = resolve;
  });

  async generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T> {
    this.markAsked();
    await this.released;
    return args.output.parse({ retired: [] });
  }
}

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((t) => (t.includes("feline") || t.includes("Cat") ? [1, 0] : [0, 1]));
  }
}

function suite(spec: StoreSpec): void {
  const open = freshGraphs(spec, "tier");

  it("levels set every default and reject unknown names", () => {
    expect(open().tiers).toEqual({
      level: "balanced",
      max_tier: "max",
      extraction: "regex",
      resolution: "default",
      contradiction: "warn",
      seeds: "synonyms",
      traversal: "bfs",
    });
    const light = open({ level: "light" }).tiers;
    expect([light.extraction, light.resolution, light.seeds]).toEqual(["regex", "exact", "bm25"]);
    const top = open({ level: "max", llm: new Judge() }).tiers;
    expect([top.extraction, top.resolution, top.contradiction]).toEqual(["llm", "llm", "llm"]);
    expect([top.seeds, top.traversal]).toEqual(["synonyms", "ppr"]);
    expect(open({ level: "max", llm: new Judge(), embedder: new FakeEmbedder() }).tiers.seeds).toBe("embeddings");
    expect(() => open({ level: "heavy" as never })).toThrow(/level must be one of light, balanced, max, got 'heavy'/);
    expect(() => open({ max_tier: "heavy" as never })).toThrow(/max_tier must be one of light, balanced, max/);
    expect(() => open({ level: "max" })).toThrow(/level 'max' needs an LLM/);
    expect(() => open({ contradiction: "llm" })).toThrow(/contradiction 'llm' needs an LLM/);
    expect(() => open({ extraction: "llm" })).toThrow(/extraction 'llm' needs an LLM/);
    expect(() => open({ extraction: "ner" as never })).toThrow(/extraction must be one of regex, spacy, llm/);
    expect(() => open({ seeds: "embeddings" })).toThrow(/seeds 'embeddings' needs an embedder/);
    expect(() => open({ seeds: "vector" as never })).toThrow(/seeds must be one of bm25, synonyms, embeddings/);
    expect(() => open({ level: "heavy" as never })).toThrow(ValidationError);
  });

  it("an LLM turns on extraction only and an explicit option wins", () => {
    const g = open({ llm: new Judge() });
    expect(g.tiers.extraction).toBe("llm");
    expect([g.tiers.resolution, g.tiers.contradiction]).toEqual(["default", "warn"]);
    expect(open({ llm: new Judge(), extraction: "regex" }).tiers.extraction).toBe("regex");
    expect(open({ extraction: "spacy" }).tiers.extraction).toBe("regex");
    expect(open({ level: "light", resolver: "fuzzy" }).tiers.resolution).toBe("fuzzy");
    expect(open({ extractor: { extract: async () => ({}) } }).tiers.extraction).toBe("custom");
  });

  it("max_tier caps graph and per-call options", async () => {
    const g = open({ llm: new Judge(), level: "max", max_tier: "balanced" });
    expect(g.tiers.extraction).toBe("regex");
    expect([g.tiers.resolution, g.tiers.contradiction, g.tiers.seeds]).toEqual(["fuzzy", "supersede", "synonyms"]);
    const res = await g.insert.facts({ entities: [BOB] }, { resolver: "llm", contradiction: "llm" });
    expect(res.tiers).toEqual({ resolution: "fuzzy", contradiction: "supersede" });
    const quiet = open({ level: "max", max_tier: "balanced", resolver: "llm", contradiction: "llm" });
    expect([quiet.tiers.resolution, quiet.tiers.contradiction]).toEqual(["fuzzy", "supersede"]);
    const capped = open({ max_tier: "light" });
    expect([capped.tiers.resolution, capped.tiers.seeds]).toEqual(["exact", "bm25"]);
    expect((await capped.retrieve("Ann", { seeds: "synonyms" })).tiers.seeds).toBe("bm25");
  });

  it("balanced merges by alias and results name their tiers", async () => {
    const g = open();
    await g.insert.facts({ entities: [ROBERT] });
    const res = await g.insert.facts({ entities: [BOB] });
    expect(res.merges).toHaveLength(1);
    expect(res.tiers).toEqual({ resolution: "default", contradiction: "warn" });
    const light = open({ level: "light" });
    await light.insert.facts({ entities: [ROBERT] });
    expect((await light.insert.facts({ entities: [BOB] })).merges).toEqual([]);
    const text = await light.insert.text("Ann works at Acme.");
    expect(text.tiers).toEqual({ extraction: "regex", resolution: "exact", contradiction: "warn" });
    expect(Object.keys(text.tiers)).toEqual(["extraction", "resolution", "contradiction"]);
    expect((await g.insert.text("Ann works at Acme.")).tiers.extraction).toBe("regex");
    const found = await light.retrieve("Ann");
    expect(found.tiers).toEqual({ seeds: "bm25", traversal: "bfs" });
    expect((await light.retrieve("Ann", { strategy: "ppr" })).tiers.traversal).toBe("ppr");
    const custom = open({ extractor: { extract: async () => ({ entities: [BOB] }) } });
    expect((await custom.insert.text("Bob")).tiers.extraction).toBe("custom");
  });

  it("LLM-judged contradiction retires an older fact without a schema", async () => {
    const judge = new Judge();
    const g = open({ llm: judge, extraction: "regex", contradiction: "llm" });
    await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: [annAt("acme", 2020)] });
    expect(judge.prompts).toEqual([]);
    const res = await g.insert.facts({ relations: [annAt("globex", 2022)] });
    expect(res.tiers.contradiction).toBe("llm");
    expect(res.warnings.map((w) => w.code)).toEqual(["relation_superseded"]);
    expect(res.warnings[0]!.message).toBe(
      `relation ${ACME} was superseded by ${GLOBEX}, which the LLM judged to contradict it`,
    );
    expect(judge.prompts[0]).toBe(
      "New fact: Ann -[WORKS_AT]-> Globex\nOlder facts:\n1. Ann -[WORKS_AT]-> Acme\n" +
        "Which older facts, by number, are no longer true now that the new fact holds?",
    );
    expect((await g.relations.list({ from_entity: "person:ann" })).items.map((r) => r.id)).toEqual([GLOBEX]);
    const old = (await g.relations.versions(ACME)).at(-1)!;
    expect([old.is_current, old.invalidated_by, old.invalidated_at]).toEqual([
      false,
      GLOBEX,
      new Date(Date.UTC(2022, 0, 1)),
    ]);
    const past = await g.retrieve("Ann", { as_of: "2021-06-01" });
    expect(past.subgraph.relations.map((r) => r.id)).toEqual([ACME]);
  });

  it("LLM judge keeps compatible facts and skips same-write and older inputs", async () => {
    const judge = new Judge([]);
    let g = open({ llm: judge, extraction: "regex", contradiction: "llm" });
    await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: [annAt("acme", 2020)] });
    const res = await g.insert.facts({ relations: [annAt("globex", 2022)] });
    expect(res.warnings).toEqual([]);
    expect(judge.prompts).toHaveLength(1);
    expect((await g.relations.list({ from_entity: "person:ann" })).items).toHaveLength(2);
    g = open({ llm: new Judge(), extraction: "regex", contradiction: "llm" });
    const both = [annAt("acme", 2020), annAt("globex", 2022)];
    expect((await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: both })).warnings).toEqual([]);
    const late = new Judge();
    g = open({ llm: late, extraction: "regex", contradiction: "llm" });
    await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: [annAt("globex", 2022)] });
    expect((await g.insert.facts({ relations: [annAt("acme", 2020)] })).warnings).toEqual([]);
    expect(late.prompts).toEqual([]);
  });

  it("LLM judge excludes unchanged relations in a mixed batch", async () => {
    const judge = new Judge();
    const g = open({ llm: judge, extraction: "regex", contradiction: "llm" });
    const both = [annAt("acme", 2020), annAt("globex", 2022)];
    await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: both });
    expect((await g.insert.facts({ relations: both })).warnings).toEqual([]);
    expect(judge.prompts).toEqual([]);
    const changed = [both[0]!, { ...both[1]!, properties: { role: "lead" } }];
    const result = await g.insert.facts({ relations: changed });
    expect(judge.prompts).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.relations.map((r) => [r.revision, r.is_current])).toEqual([
      [1, true],
      [2, true],
    ]);
    expect((await g.relations.get(ACME))?.is_current).toBe(true);
    expect((await g.relations.get(GLOBEX))?.is_current).toBe(true);
    expect((await g.insert.facts({ relations: changed })).warnings).toEqual([]);
    expect(judge.prompts).toEqual([]);
    await g.entities.create("Initech", "Company");
    const external = await g.insert.facts({ relations: [annAt("initech", 2024)] });
    expect(judge.prompts).toHaveLength(1);
    expect(judge.prompts[0]).toContain("Ann -[WORKS_AT]-> Acme");
    expect(judge.prompts[0]).toContain("Ann -[WORKS_AT]-> Globex");
    expect(external.warnings.map((w) => w.code)).toEqual(["relation_superseded"]);
    expect((await g.relations.list()).items).toHaveLength(2);
  });

  it("LLM judge leaves cardinality types to the schema rule and judges other types", async () => {
    const judge = new Judge();
    const schema: Schema = { relations: [{ type: "WORKS_AT", from: { max_count: 1 } }] };
    const g = open({ llm: judge, extraction: "regex", contradiction: "llm", schema });
    await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: [annAt("acme", 2020)] });
    const res = await g.insert.facts({ relations: [annAt("globex", 2022)] });
    expect(res.warnings.map((w) => w.code)).toEqual(["relation_superseded"]);
    expect(judge.prompts).toEqual([]);
    await g.insert.facts({ relations: [{ from_entity: "person:ann", type: "LIKES", to_entity: "company:acme" }] });
    const rel = await g.relations.create("person:ann", "DISLIKES", "company:acme");
    expect(judge.prompts[0]).toContain("1. Ann -[LIKES]-> Acme");
    expect((await g.relations.list({ to_entity: "company:acme" })).items.map((r) => r.type)).toEqual(["DISLIKES"]);
    const liked = await g.relations.versions(ids.relationId("person:ann", "LIKES", "company:acme"));
    expect(liked.at(-1)!.invalidated_by).toBe(rel.id);
  });

  it("check_answerable grounds schema synonyms, definitions, and plurals", async () => {
    const g = open({ schema: TERMS });
    await g.insert.facts({ entities: [{ type: "Company", name: "Acme" }] });
    let report = await g.checkAnswerable("What is the staff size of the firm Acme by ad spend?");
    expect(report.terms.map((t) => [t.term, t.status, t.matches, t.certified])).toEqual([
      ["staff size", "definition", ["headcount"], false],
      ["firm", "type", ["Company"], true],
      ["acme", "entity", ["company:acme"], false],
      ["ad", "missing", [], false],
      ["spend", "missing", [], false],
    ]);
    expect([report.verdict, report.missing]).toEqual(["partial", ["ad", "spend"]]);
    report = await g.checkAnswerable("users employed by employers");
    expect(report.terms.map((t) => [t.status, t.matches])).toEqual([
      ["schema_only", ["Person"]],
      ["schema_only", ["WORKS_AT"]],
      ["type", ["Company"]],
    ]);
    expect([report.verdict, report.missing]).toEqual(["partial", ["users", "employed"]]);
    await g.insert.facts({
      entities: [{ type: "Person", name: "Ann" }],
      relations: [worksAt("person:ann", "company:acme")],
    });
    report = await g.checkAnswerable("users employed by employers");
    expect(report.terms.map((t) => [t.status, t.matches])).toEqual([
      ["type", ["Person"]],
      ["relation", ["WORKS_AT"]],
      ["type", ["Company"]],
    ]);
    expect(report.verdict).toBe("answerable");
    expect((await open().checkAnswerable("anything")).verdict).toBe("not_answerable");
  });

  it("check_answerable ignores possessive and contraction endings", async () => {
    const spec: Schema = {
      entities: [{ name: "Person" }, { name: "Company" }],
      relations: [{ type: "WORKS_AT" }, { type: "BACKS", synonyms: ["John's employer"] }],
    };
    const g = open({ schema: spec });
    await g.insert.facts({
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
        { type: "Company", name: "Ann's Bakery" },
      ],
      relations: [worksAt("person:ann", "company:acme")],
    });
    for (const question of ["What is Ann's company?", "What is Ann’s company?", "Doesn't Ann work at Acme?"]) {
      const report = await g.checkAnswerable(question);
      expect([report.verdict, report.missing], question).toEqual(["answerable", []]);
    }
    expect((await g.checkAnswerable("What is Ann's company?")).terms.map((t) => t.term)).toEqual(["ann", "company"]);
    for (const question of ["What is Ann's Bakery?", "What is Ann’s Bakery?"]) {
      const terms = (await g.checkAnswerable(question)).terms;
      expect(terms.map((t) => [t.term, t.status])).toEqual([["ann bakery", "entity"]]);
    }
    for (const question of ["Who is John's employer?", "Who is John’s employer?"]) {
      const terms = (await g.checkAnswerable(question)).terms;
      expect(terms.map((t) => [t.term, t.status])).toEqual([["john employer", "schema_only"]]);
    }
  });

  it("check_answerable keeps won't and can't whole", async () => {
    const g = open();
    await g.insert.facts({ entities: [{ type: "Person", name: "Ann" }] });
    expect((await g.checkAnswerable("Why can't Ann stay?")).terms.map((t) => t.term)).toEqual(["can't", "ann", "stay"]);
    expect((await g.checkAnswerable("Won’t Ann stay?")).terms.map((t) => t.term)).toEqual(["won't", "ann", "stay"]);
  });

  it("synonym seeding finds entities by a type synonym", async () => {
    const g = open({ schema: TERMS });
    await g.insert.facts({
      entities: [
        { type: "Company", name: "Acme" },
        { type: "Person", name: "Ann" },
      ],
    });
    const found = await g.retrieve("which employers are there");
    expect(found.tiers.seeds).toBe("synonyms");
    expect(found.seeds.map((s) => s.id)).toEqual(["company:acme"]);
    expect((await g.retrieve("which employers are there", { seeds: "bm25" })).seeds).toEqual([]);
    expect((await open().retrieve("which employers")).tiers.seeds).toBe("bm25");
    await expect(g.retrieve("x", { seeds: "embeddings" })).rejects.toThrow(/seeds 'embeddings' needs an embedder/);
  });

  it("synonym seeding expands parent types and definitions to subtypes", async () => {
    const hierarchy: Schema = {
      entities: [
        {
          name: "Employee",
          aliases: ["Worker"],
          synonyms: ["staff"],
          definitions: [{ name: "Active Staff", expression: "active = true", synonyms: ["personnel"] }],
        },
        { name: "Engineer", parent: "Employee" },
        { name: "PrincipalEngineer", parent: "Engineer" },
      ],
    };
    const g = open({ schema: hierarchy });
    await g.entities.create("Ann", "PrincipalEngineer");
    for (const question of [
      "Who are the Employees?",
      "Who are the Workers?",
      "Who are the staff?",
      "Who are the personnel?",
    ]) {
      expect((await g.checkAnswerable(question)).verdict, question).toBe("answerable");
      const found = await g.retrieve(question, { seeds: "synonyms" });
      expect(
        found.seeds.map((s) => s.id),
        question,
      ).toEqual(["principalengineer:ann"]);
      expect((await g.retrieve(question, { seeds: "bm25" })).seeds, question).toEqual([]);
    }
  });

  it("BM25 seed ranking counts repeated document words", async () => {
    const g = open();
    await g.insert.facts({
      entities: [
        { type: "Thing", name: "Zebra", properties: { text: "alpha alpha beta" } },
        { type: "Thing", name: "Mango", properties: { text: "alpha beta beta" } },
      ],
    });
    const found = await g.retrieve("alpha", { seeds: "bm25" });
    expect(found.seeds.slice(0, 2).map((seed) => seed.id)).toEqual(["thing:zebra", "thing:mango"]);
    expect(found.seeds[0]!.score).toBeGreaterThan(found.seeds[1]!.score);
  });

  it("embedding seeding fuses with BM25 and embeds each entity once", async () => {
    const embedder = new FakeEmbedder();
    const g = open({ embedder, seeds: "embeddings" });
    await g.insert.facts({
      entities: [
        { type: "Animal", name: "Cat" },
        { type: "Animal", name: "Dog" },
      ],
    });
    const found = await g.retrieve("feline");
    expect(found.tiers.seeds).toBe("embeddings");
    expect(found.seeds.map((s) => s.id)).toEqual(["animal:cat"]);
    expect(found.seeds[0]!.score).toBeCloseTo(1 / 61);
    expect((await g.retrieve("feline", { seeds: "bm25" })).seeds).toEqual([]);
    const calls = embedder.calls.length;
    await g.retrieve("feline");
    expect(embedder.calls).toHaveLength(calls + 1);
    expect(embedder.calls.at(-1)).toEqual(["feline"]);
    expect(() => open({ embedder: {} as never })).toThrow(/embedder must have an embed method/);
  });

  it("embedding seeding rejects mismatched dimensions and can retry", async () => {
    let valid = false;
    const embedder: Embedder = {
      embed: async (texts) => texts.map((text) => (valid || text === "unrelated" ? [1, 0] : [1])),
    };
    const g = open({ embedder, seeds: "embeddings" });
    await g.insert.facts({ entities: [{ type: "Thing", name: "Match" }] });
    await expect(g.retrieve("unrelated")).rejects.toThrow("embedding vectors must have the same dimensions");
    valid = true;
    expect((await g.retrieve("unrelated")).seeds.map((seed) => seed.id)).toEqual(["thing:match"]);
  });

  it("stem singularizes -es plurals and keeps status and analysis", async () => {
    const singular: Record<string, string> = {
      addresses: "address",
      boxes: "box",
      dishes: "dish",
      batches: "batch",
      branches: "branch",
      statuses: "status",
      buses: "bus",
      movies: "movie",
      cookies: "cookie",
      quizzes: "quiz",
      heroes: "hero",
      potatoes: "potato",
      axes: "axe",
      shoes: "shoe",
      buzzes: "buzz",
      waltzes: "waltz",
      menus: "menu",
      excuses: "excuse",
      abuses: "abuse",
      status: "status",
      analysis: "analysis",
      class: "class",
    };
    for (const [word, expected] of Object.entries(singular)) {
      expect([word, stem(word)]).toEqual([word, expected]);
      expect(stem(expected)).toBe(expected);
    }
    const tables = [
      "addresses",
      "order_status",
      "tax_classes",
      "batches",
      "analysis",
      "movies",
      "cookies",
      "quizzes",
      "businesses",
    ];
    expect(fromTables(tables.map((name) => ({ name }))).entities.map((e) => e.name)).toEqual([
      "Address",
      "OrderStatus",
      "TaxClass",
      "Batch",
      "Analysis",
      "Movie",
      "Cookie",
      "Quiz",
      "Business",
    ]);
    const g = open({ schema: { entities: [{ name: "Address" }, { name: "Status" }] } });
    await g.insert.facts({
      entities: [
        { type: "Address", name: "12 Main St" },
        { type: "Status", name: "Shipped" },
      ],
    });
    for (const [question, matched] of [
      ["which addresses", "Address"],
      ["which statuses", "Status"],
      ["which status", "Status"],
    ]) {
      const report = await g.checkAnswerable(question!);
      expect([report.verdict, report.terms.map((t) => t.matches)]).toEqual(["answerable", [[matched]]]);
    }
  });

  it("fromTables drafts types, properties, relations, and mappings", async () => {
    const schema = fromTables(
      [
        {
          name: "sales.invoice_lines",
          description: "one line of an invoice",
          columns: [
            { name: "invoice_id", type: "bigint", references: "sales.invoices" },
            { name: "extended_price", type: "numeric(18,2)", nullable: false },
            { name: "note", type: "varchar" },
          ],
        },
        { name: "sales.invoices", columns: [{ name: "invoice_date", type: "date" }] },
      ],
      { name: "sales" },
    );
    const [line, invoice] = schema.entities;
    expect([line!.name, line!.description, line!.certified]).toEqual(["InvoiceLine", "one line of an invoice", false]);
    expect(line!.synonyms).toEqual(["invoice lines", "invoice line"]);
    expect(line!.mappings).toEqual([{ source: null, table: "sales.invoice_lines", column: null }]);
    expect(line!.properties.map((p) => [p.name, p.type, p.required])).toEqual([
      ["extended_price", "float", true],
      ["note", "string", false],
    ]);
    expect([invoice!.name, invoice!.properties[0]!.type]).toEqual(["Invoice", "datetime"]);
    expect(schema.relations).toHaveLength(1);
    const rel = schema.relations[0]!;
    expect([rel.type, rel.from.types, rel.from.max_count, rel.to.types]).toEqual([
      "HAS_INVOICE",
      ["InvoiceLine"],
      1,
      ["Invoice"],
    ]);
    const g = open({ schema });
    const { terms } = await g.checkAnswerable("total for invoice lines");
    expect(terms.filter((t) => t.status === "schema_only").map((t) => [t.term, t.matches])).toEqual([
      ["invoice lines", ["InvoiceLine"]],
    ]);
    expect(() => fromTables([{ name: "t", columns: [{ name: "x_id", references: "nope" }] }])).toThrow(
      /unknown table 'nope'/,
    );
    expect(() => fromTables([{}])).toThrow(/each table needs a name/);
    expect(() => fromTables({} as never)).toThrow(/tables must be a list of table mappings/);
  });

  it("fromTables maps only integer SQL types to integer", () => {
    const types = [
      "int",
      "INT UNSIGNED",
      "hugeint",
      "point",
      "interval",
      "int4range",
      "integer[]",
      "_int8",
      "ARRAY",
      "tstzrange",
    ];
    const schema = fromTables([{ name: "t", columns: types.map((type, i) => ({ name: `c${i}`, type })) }]);
    expect(schema.entities[0]!.properties.map((p) => p.type)).toEqual([
      ...Array(3).fill("integer"),
      ...Array(7).fill("string"),
    ]);
  });

  it("asks the LLM judge outside the write and rechecks what it chose", async () => {
    const judge = new WritingLLM({ retired: [1] });
    const g = open({ llm: judge, extraction: "regex", contradiction: "llm" });
    await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: [annAt("acme", 2020)] });
    judge.write = () => g.relations.certify(ACME, { by: "hr" });
    const res = await g.insert.facts({ relations: [annAt("globex", 2022)] });
    expect([judge.prompts.length, res.warnings.map((w) => w.code)]).toEqual([1, ["certified_kept"]]);
    expect((await g.relations.list({ from_entity: "person:ann" })).items.map((r) => r.id).sort()).toEqual(
      [ACME, GLOBEX].sort(),
    );
  });

  it("drops a judge verdict when the new relation changed while the LLM answered", async () => {
    const judge = new WritingLLM({ retired: [1] });
    const g = open({ llm: judge, extraction: "regex", contradiction: "llm" });
    await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: [annAt("acme", 2020)] });
    judge.write = () => g.relations.update(GLOBEX, { set_properties: { role: "intern" } });
    const res = await g.insert.facts({ relations: [annAt("globex", 2022)] });
    expect([judge.prompts.length, res.warnings]).toEqual([1, []]);
    expect((await g.relations.list({ from_entity: "person:ann" })).items.map((r) => r.id).sort()).toEqual(
      [ACME, GLOBEX].sort(),
    );
    expect((await g.relations.get(GLOBEX))!.revision).toBe(2);
  });

  it.each([true, false])("lets the judge see a rival the replaced source would retire (retire=%s)", async (retire) => {
    const g = open({ llm: new Judge(retire ? [1] : []), extraction: "regex", contradiction: "llm" });
    const old = (await g.insert.text("Ann works at Acme.", { source_id: "hr" })).relations[0]!;
    const res = await g.insert.text("Ann works at Globex.", { source_id: "hr", replace_source: true });
    const fresh = res.relations[0]!;
    const codes = res.warnings.map((w) => w.code).filter((code) => code !== "basic_extraction");
    const stored = (await g.relations.versions(old.id)).find((v) => v.invalidated_at !== null)!;
    if (retire) {
      expect([codes, res.source_diff!.retired, stored.invalidated_by]).toEqual([["relation_superseded"], [], fresh.id]);
    } else {
      expect([codes, res.source_diff!.retired, stored.invalidated_by]).toEqual([
        ["fact_retired_by_source"],
        [old.id],
        res.source_version,
      ]);
    }
    expect((await g.relations.list()).items.map((r) => r.id)).toEqual([fresh.id]);
  });

  it("folds a deferred source replacement into a newer replacement that committed first", async () => {
    const judge = new WritingLLM({ retired: [] });
    const g = open({ llm: judge, extraction: "regex", contradiction: "llm" });
    await g.insert.text("Ann works at Acme.", { source_id: "hr" });
    const other = new SelfGraph(g.store, { namespace: g.namespace, extraction: "regex" });
    const newer: InsertResult[] = [];
    judge.write = async () => {
      newer.push(await other.insert.text("Ann works at Initech.", { source_id: "hr", replace_source: true }));
    };
    const res = await g.insert.text("Ann works at Globex.", { source_id: "hr", replace_source: true });
    expect([judge.prompts.length, newer.length]).toEqual([1, 1]);
    expect((await g.relations.list()).items.map((r) => r.to_entity)).toEqual(["thing:initech"]);
    const stored = new Map(
      (await g.store.matchNodes(g.namespace, "SourceVersion")).map((v) => [v.id as string, v.replaced_by ?? null]),
    );
    expect([stored.get(newer[0]!.source_version!), stored.get(res.source_version!)]).toEqual([
      null,
      newer[0]!.source_version,
    ]);
    const acme = (await g.relations.list({ include_invalidated: true })).items.find(
      (r) => r.to_entity === "thing:acme",
    );
    expect(acme!.invalidated_by).toBe(newer[0]!.source_version);
    const initech = (await g.store.matchNodes(g.namespace, "SourceVersion")).find((v) => v.id === acme!.invalidated_by);
    expect(acme!.invalidated_known_at!.getTime()).toBeGreaterThanOrEqual(
      new Date(initech!.created_at as string).getTime(),
    );
  });

  const appended = [
    ["globex", false],
    ["globex", true],
    ["initech", false],
    ["initech", true],
  ] as const;
  it.each(appended)("folds a deferred replacement past an append: %s first, restated %s", async (first, restated) => {
    const g = open({ extraction: "regex" });
    await g.insert.text("Ann works at Acme.", { source_id: "hr" });
    const judges = { globex: new PausedJudge(), initech: new PausedJudge() };
    const tasks: Record<string, Promise<InsertResult>> = {};
    for (const company of ["globex", "initech"] as const) {
      const graph = new SelfGraph(g.store, {
        namespace: g.namespace,
        extraction: "regex",
        llm: judges[company],
        contradiction: "llm",
      });
      const text = `Ann works at ${company[0]!.toUpperCase()}${company.slice(1)}.`;
      tasks[company] = graph.insert.text(text, { source_id: "hr", replace_source: true });
      await judges[company].asked;
    }
    const text = restated ? "Ann works at Acme. Bob works at Paris." : "Bob works at Paris.";
    const append = await g.insert.text(text, { source_id: "hr" });
    for (const company of first === "globex" ? (["globex", "initech"] as const) : (["initech", "globex"] as const)) {
      judges[company].release();
      await tasks[company];
    }
    const initech = await tasks.initech!;
    const current = (await g.relations.list()).items.map((r) => r.to_entity).sort();
    expect(current).toEqual(
      restated ? ["thing:acme", "thing:initech", "thing:paris"] : ["thing:initech", "thing:paris"],
    );
    const versions = await g.store.matchNodes(g.namespace, "SourceVersion");
    const replacedBy = (id: string | null) => versions.find((v) => v.id === id)!.replaced_by ?? null;
    expect([replacedBy(initech.source_version), replacedBy(append.source_version)]).toEqual([null, null]);
    if (!restated) {
      const acme = (await g.relations.list({ include_invalidated: true })).items.find(
        (r) => r.to_entity === "thing:acme",
      );
      expect(acme!.invalidated_by).toBe(initech.source_version);
      const stored = versions.find((v) => v.id === initech.source_version)!;
      expect(acme!.invalidated_known_at!.getTime()).toBeGreaterThanOrEqual(
        new Date(stored.created_at as string).getTime(),
      );
    }
  });

  it.each(["insert", "create"])("warns instead of failing a committed write when the judge fails (%s)", async (via) => {
    const failing: LLMClient = {
      generate: async () => {
        throw new Error("provider down");
      },
    };
    const g = open({ llm: failing, extraction: "regex", contradiction: "llm" });
    await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: [annAt("acme", 2020)] });
    const { result: warnings, logged } = await captureLog(async () => {
      if (via === "insert") return (await g.insert.facts({ relations: [annAt("globex", 2022)] })).warnings;
      await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: "2022-01-01" });
      return [];
    });
    const message = `the LLM contradiction judge failed, so ${GLOBEX} were not judged: Error: provider down`;
    if (via === "insert")
      expect(warnings.map((w) => [w.code, w.message])).toEqual([["contradiction_not_judged", message]]);
    expect(logged.filter((line) => line.includes("contradiction_not_judged"))).toEqual([
      `warning: schema warning [contradiction_not_judged]: ${message}`,
    ]);
    expect((await g.relations.list({ from_entity: "person:ann" })).items.map((r) => r.id).sort()).toEqual(
      [ACME, GLOBEX].sort(),
    );
  });

  it.each(["rival", "new"])(
    "drops a judge verdict when the %s relation is created again while the LLM answered",
    async (recreated) => {
      const judge = new WritingLLM({ retired: [1] });
      const g = open({ llm: judge, extraction: "regex", contradiction: "llm" });
      await g.insert.facts({ entities: ANN_ACME_GLOBEX, relations: [annAt("acme", 2020)] });
      const [company, rid] = recreated === "rival" ? ["acme", ACME] : ["globex", GLOBEX];
      judge.write = async () => {
        await g.relations.delete(rid);
        await g.relations.create("person:ann", "WORKS_AT", `company:${company}`, {
          properties: { role: "temp" },
          contradiction: "warn",
        });
      };
      const res = await g.insert.facts({ relations: [annAt("globex", 2022)] });
      expect([judge.prompts.length, res.warnings]).toEqual([1, []]);
      const current = new Map((await g.relations.list({ from_entity: "person:ann" })).items.map((r) => [r.id, r]));
      expect([...current.keys()].sort()).toEqual([ACME, GLOBEX].sort());
      expect([current.get(rid)!.revision, current.get(rid)!.properties]).toEqual([1, { role: "temp" }]);
    },
  );

  it("asks the LLM resolver before the write and never inside it", async () => {
    const llm = new WritingLLM({ same: true });
    const g = open({ llm, resolver: "llm" });
    await g.entities.create("Katherine Jones", "Person");
    llm.write = () => g.entities.create("Unrelated", "Thing");
    const res = await g.insert.facts({ entities: [{ type: "Person", name: "Kathy Jones" }] });
    expect(res.merges.map((m) => [m.absorbed_id, m.survivor_id])).toEqual([
      ["person:kathy-jones", "person:katherine-jones"],
    ]);
    expect(llm.prompts).toHaveLength(1);
    expect(await g.entities.get("thing:unrelated")).not.toBeNull();
  });

  it("runs an LLMResolver subclass with private fields as given, asking the LLM once", async () => {
    class Remembering extends LLMResolver {
      readonly #seen: string[] = [];
      override async resolve(...args: Parameters<LLMResolver["resolve"]>): Promise<ResolutionDecision> {
        this.#seen.push(args[0].name);
        return super.resolve(...args);
      }
      get seen(): string[] {
        return [...this.#seen];
      }
    }
    const llm = new WritingLLM({ same: true });
    const g = open({ llm });
    await g.entities.create("Katherine Jones", "Person");
    const resolver = new Remembering(llm);
    const res = await g.insert.facts({ entities: [{ type: "Person", name: "Kathy Jones" }] }, { resolver });
    expect(res.merges.map((m) => [m.absorbed_id, m.survivor_id])).toEqual([
      ["person:kathy-jones", "person:katherine-jones"],
    ]);
    expect([llm.prompts.length, resolver.seen]).toEqual([1, ["Kathy Jones", "Kathy Jones"]]);
  });

  it("keeps an LLMResolver subclass's own resolve", async () => {
    class NeverMerge extends LLMResolver {
      override async resolve(): Promise<ResolutionDecision> {
        return {};
      }
    }
    const llm = new WritingLLM({ same: true });
    const g = open({ llm });
    await g.entities.create("Katherine Jones", "Person");
    const res = await g.insert.facts(
      { entities: [{ type: "Person", name: "Kathy Jones" }] },
      { resolver: new NeverMerge(llm) },
    );
    expect(res.merges).toEqual([]);
    expect(await g.entities.get("person:kathy-jones")).not.toBeNull();
  });

  it("does not ask the LLM resolver again when the write is retried", async () => {
    const llm = new WritingLLM({ same: true });
    const g = open({ llm, resolver: "llm" });
    await g.entities.create("Katherine Jones", "Person");
    const store = g.store as unknown as { transaction: (fn: (tx: object) => Promise<unknown>) => Promise<unknown> };
    const transaction = store.transaction;
    let failed = false;
    const conflicting = (tx: object): object =>
      new Proxy(tx, {
        get(target, key) {
          if (key === "upsertNodes" && !failed) {
            return async () => {
              failed = true;
              throw new TransientError("transaction conflict");
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    store.transaction = function (this: unknown, fn) {
      return transaction.call(this, (tx) => fn(failed ? tx : conflicting(tx)));
    };
    try {
      const res = await g.insert.facts({ entities: [{ type: "Person", name: "Kathy Jones" }] });
      expect([failed, llm.prompts.length, res.merges.length]).toEqual([true, 1, 1]);
    } finally {
      store.transaction = transaction;
    }
  });

  it("keeps the lexical decision when the resolver's target changed after asking", async () => {
    const llm = new WritingLLM({ same: true });
    const g = open({ llm, resolver: "llm" });
    await g.entities.create("Katherine Jones", "Person");
    llm.write = () => g.entities.update("person:katherine-jones", { aliases: ["KJ"] });
    const res = await g.insert.facts({ entities: [{ type: "Person", name: "Kathy Jones" }] });
    expect([res.merges, llm.prompts.length]).toEqual([[], 1]);
    expect(await g.entities.get("person:kathy-jones")).not.toBeNull();
  });
}

await forEachStore("tiers", suite);

describe("tiers over the CLI, MCP, and settings", () => {
  const uri = tempKuzu("selfgraph-tiers-");
  const settings = (over: Partial<GraphSettings> = {}): GraphSettings => ({
    ...DEFAULT_SETTINGS,
    store: "kuzu",
    uri,
    namespace: uniqueNs("tier"),
    ...over,
  });

  beforeAll(buildCli);
  afterAll(closeMcp);

  it("the CLI, MCP, and settings carry the level", async () => {
    const env = { SELFGRAPH_STORE: "", SELFGRAPH_URI: undefined, SELFGRAPH_LEVEL: undefined };
    const flags = ["--store", "kuzu", "--uri", tempKuzu("selfgraph-tiers-cli-"), "--namespace", "tier"];
    const cli = (...args: string[]) => runCli([...flags, ...args], { env });
    expect(cli("entity", "create", "--name", "Acme", "--type", "Company").code).toBe(0);
    const found = cli("retrieve", "Acme", "--seeds", "bm25").out as { tiers: Record<string, string> };
    expect(found.tiers).toEqual({ seeds: "bm25", traversal: "bfs" });
    const capped = cli("--level", "max", "--max-tier", "bogus", "init");
    expect(capped.code).toBe(2);
    expect(capped.err).toContain("--max-tier");
    const viaEnv = runCli([...flags, "init"], { env: { ...env, SELFGRAPH_LEVEL: "huge" } });
    expect(viaEnv.code).toBe(2);
    expect(viaEnv.err).toContain("level must be one of light, balanced, max, got 'huge'");

    const light = buildGraph(settings({ level: "light" }));
    expect(light.tiers.resolution).toBe("exact");
    await light.close();
    const fuzzy = buildGraph(settings({ max_tier: "light", resolver: "fuzzy" }));
    expect(fuzzy.tiers.resolution).toBe("exact");
    await fuzzy.close();
    expect(() => buildGraph(settings({ level: "huge" }))).toThrow(/level must be one of/);

    await configureMcp(settings({ level: "light" }));
    expect((await callTool("create_entity", { name: "Acme", type: "Company" })).isError).toBe(false);
    const retrieved = await callTool("retrieve", { query: "Acme" });
    expect((retrieved.result as { tiers: Record<string, string> }).tiers).toEqual({ seeds: "bm25", traversal: "bfs" });
    const seeded = await callTool("retrieve", { query: "Acme", seeds: "vector" });
    expect(seeded.isError).toBe(true);
  });
});

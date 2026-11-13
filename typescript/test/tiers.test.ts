import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  buildGraph,
  DEFAULT_SETTINGS,
  type Embedder,
  fromTables,
  type GraphSettings,
  ids,
  type LLMClient,
  type Schema,
  ValidationError,
} from "../src/index.js";
import { callTool, close as closeMcp, configure as configureMcp } from "../src/mcp.js";
import { buildCli, forEachStore, freshGraphs, runCli, type StoreSpec, tempKuzu, uniqueNs, worksAt } from "./helpers.js";

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

  it("coverage names schema terms, entities, and what is missing", async () => {
    const g = open({ schema: TERMS });
    await g.insert.facts({ entities: [{ type: "Company", name: "Acme" }] });
    const cov = await g.coverage("What is the staff size of the firm Acme by ad spend?");
    expect(cov.terms.map((t) => [t.term, t.kind, t.matched, t.certified])).toEqual([
      ["Company", "entity", "firm", true],
      ["headcount", "definition", "staff size", false],
    ]);
    expect(cov.terms.map((t) => t.tokens)).toEqual([["firm"], ["size", "staff"]]);
    expect(cov.covered).toEqual(["acme", "firm", "size", "staff"]);
    expect(cov.uncovered).toEqual(["ad", "spend"]);
    expect(cov.ratio).toBeCloseTo(4 / 6);
    expect((await g.coverage("users employed by employers")).terms.map((t) => t.term)).toEqual([
      "Company",
      "Person",
      "WORKS_AT",
    ]);
    const bare = await open().coverage("anything");
    expect(bare).toEqual({ question: "anything", terms: [], covered: [], uncovered: ["anything"], ratio: 0 });
    await expect(g.coverage(" ")).rejects.toThrow(/question cannot be empty/);
    await expect(g.coverage(1 as never)).rejects.toThrow(/question must be a string/);
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
    expect((await g.coverage("total for invoice lines")).terms[0]!.term).toBe("InvoiceLine");
    expect(() => fromTables([{ name: "t", columns: [{ name: "x_id", references: "nope" }] }])).toThrow(
      /unknown table 'nope'/,
    );
    expect(() => fromTables([{}])).toThrow(/each table needs a name/);
    expect(() => fromTables({} as never)).toThrow(/tables must be a list of table mappings/);
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

  it("the CLI, MCP, and settings carry the level and coverage", async () => {
    const env = { SELFGRAPH_STORE: "", SELFGRAPH_URI: undefined, SELFGRAPH_LEVEL: undefined };
    const flags = ["--store", "kuzu", "--uri", tempKuzu("selfgraph-tiers-cli-"), "--namespace", "tier"];
    const cli = (...args: string[]) => runCli([...flags, ...args], { env });
    expect(cli("entity", "create", "--name", "Acme", "--type", "Company").code).toBe(0);
    const cov = cli("coverage", "Acme", "revenue").out as { covered: string[]; uncovered: string[] };
    expect([cov.covered, cov.uncovered]).toEqual([["acme"], ["revenue"]]);
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
    const coverage = await callTool("coverage", { question: "Acme revenue" });
    expect((coverage.result as { uncovered: string[] }).uncovered).toEqual(["revenue"]);
    const retrieved = await callTool("retrieve", { query: "Acme" });
    expect((retrieved.result as { tiers: Record<string, string> }).tiers).toEqual({ seeds: "bm25", traversal: "bfs" });
    const seeded = await callTool("retrieve", { query: "Acme", seeds: "vector" });
    expect(seeded.isError).toBe(true);
  });
});

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { toOssie } from "../src/export.js";
import {
  type Embedder,
  type Entity,
  type Extractor,
  type LLMClient,
  Neo4jStore,
  type Relation,
  SelfGraph,
  type SelfGraphOptions,
  StoreError,
} from "../src/index.js";
import { callTool, close, configure } from "../src/mcp.js";
import { answerability, HUB_DEGREE, pprRank } from "../src/retrieval.js";
import { checkedCypher, DEFAULT_SETTINGS } from "../src/runtime.js";
import { asSchema } from "../src/schema.js";
import {
  ANN_AT_ACME,
  buildCli,
  captureLog,
  forEachStore,
  freshGraphs,
  runCli,
  SINGLE_EMPLOYER,
  type StoreSpec,
  tempDir,
  tempKuzu,
  worksAt,
} from "./helpers.js";

const lineExtractor: Extractor = {
  extract: async (document) => {
    const entities = new Map<string, { type: string; name: string }>();
    const relations: Array<{ from_entity: string; type: string; to_entity: string }> = [];
    for (const line of document.text.split("\n")) {
      const [a, rtype, b] = line.split(" ") as [string, string, string];
      for (const name of [a, b]) entities.set(name, { type: "Thing", name });
      relations.push({ from_entity: `thing:${a}`, type: rtype, to_entity: `thing:${b}` });
    }
    return { entities: [...entities.values()], relations };
  },
};

const utc = (year: number, month = 1) => new Date(Date.UTC(year, month - 1, 1));

const judge: LLMClient = {
  generate: async <T>(args: { output: z.ZodType<T> }): Promise<T> => args.output.parse({ retired: [1] }),
};

const flatEmbedder: Embedder = { embed: async (texts: string[]) => texts.map(() => [1, 0]) };

const entity = (id: string, name: string, type = "Thing"): Entity => ({
  id,
  type,
  name,
  aliases: [],
  external_ids: {},
  properties: {},
  source_count: 0,
  created_at: utc(2026),
  updated_at: utc(2026),
  relevance: null,
  relevance_at: null,
});

const relation = (id: string, from: string, to: string): Relation => ({
  id,
  revision: 1,
  from_entity: from,
  type: "R",
  to_entity: to,
  properties: {},
  event_time: null,
  created_at: utc(2026),
  is_current: true,
  invalidated_at: null,
  invalidated_by: null,
  source_count: 0,
  relevance: null,
  relevance_at: null,
  certified_at: null,
  certified_by: null,
});

function suite(spec: StoreSpec): void {
  const open = freshGraphs(spec, "trust");
  const employment = async (options: SelfGraphOptions = {}) => {
    const g = open({ schema: SINGLE_EMPLOYER, ...options });
    await g.insert.facts({ entities: ANN_AT_ACME.entities });
    return g;
  };

  it("judges answerability now and as of a past time", async () => {
    const g = await employment();
    await g.insert.facts({ relations: [worksAt("person:ann", "company:acme", 2024)] });
    expect((await g.checkAnswerable("where does Ann work")).verdict).toBe("answerable");
    expect((await g.checkAnswerable("x", { terms: ["Ann", "Globex"] })).verdict).toBe("uncertain");
    expect((await g.checkAnswerable("Ann", { as_of: "2000-01-01" })).verdict).toBe("not_answerable");
    for (const [options, message] of [
      [{ terms: [] }, "terms must be a non-empty list"],
      [{ terms: ["ok", " "] }, "terms must be a non-empty list"],
      [{ depth: 0 }, "depth must be >= 1"],
    ] as const) {
      await expect(g.checkAnswerable("Ann", options)).rejects.toThrow(message);
    }
    await expect(g.checkAnswerable("  ")).rejects.toThrow("question must be a non-empty string");
  });

  it("lists hubs, marks lines through them, and can skip them", async () => {
    const g = open();
    const names = ["Ada", "Bo", ...Array.from({ length: HUB_DEGREE }, (_, i) => `Leaf${i}`)];
    await g.insert.facts({
      entities: ["Hub", ...names].map((name) => ({ type: "Thing", name })),
      relations: names.map((n) => ({ from_entity: "thing:hub", type: "HAS", to_entity: `thing:${n.toLowerCase()}` })),
    });
    const result = await g.retrieve("Ada", { k: 1, depth: 2 });
    expect(result.hubs).toEqual(["thing:hub"]);
    expect(result.context.split("\n")).toContain("Hub -[HAS]-> Ada (via hub)");
    expect(result.subgraph.entities.map((e) => e.id)).toContain("thing:bo");
    const skipped = await g.retrieve("Ada", { k: 1, depth: 2, skip_hubs: true });
    expect(skipped.subgraph.entities.map((e) => e.id).sort()).toEqual(["thing:ada", "thing:hub"]);
    expect((await g.retrieve("Hub", { k: 1, depth: 1 })).context).not.toContain("(via hub)");
    await expect(g.retrieve("Ada", { skip_hubs: "yes" as unknown as boolean })).rejects.toThrow(
      "skip_hubs must be a boolean",
    );
  });

  it("keeps certified relations through supersede and lists them first", async () => {
    const g = await employment({ contradiction: "supersede" });
    const old = (await g.insert.facts({ relations: [worksAt("person:ann", "company:acme", 2024)] })).relations[0]!;
    const certified = await g.relations.certify(old.id, { by: "hr" });
    expect([certified.certified_by, certified.certified_at !== null, certified.revision]).toEqual([
      "hr",
      true,
      old.revision,
    ]);
    const result = await g.insert.facts({ relations: [worksAt("person:ann", "company:globex", 2025)] });
    expect(result.warnings.map((w) => w.code)).toEqual(["certified_kept"]);
    expect((await g.relations.get(old.id))!.is_current).toBe(true);
    expect((await g.retrieve("Ann")).context).toContain("Ann -[WORKS_AT]-> Acme [certified]");
    expect((await g.relations.uncertify(old.id)).certified_at).toBeNull();
    await g.relations.certify(old.id, { by: "hr" });
    expect((await g.relations.update(old.id, { set_properties: { role: "cto" } })).certified_at).toBeNull();
    await expect(g.relations.certify(old.id, { by: " " })).rejects.toThrow("certified_by must be a non-empty string");
    await expect(g.relations.certify("relation:missing", { by: "hr" })).rejects.toThrow("does not exist");
  });

  it("refuses to certify a retired relation", async () => {
    const g = await employment({ contradiction: "supersede" });
    const old = (await g.insert.facts({ relations: [worksAt("person:ann", "company:acme", 2024)] })).relations[0]!;
    await g.insert.facts({ relations: [worksAt("person:ann", "company:globex", 2025)] });
    await expect(g.relations.certify(old.id, { by: "hr" })).rejects.toThrow("only a current relation can be certified");
  });

  it("retires what only older versions of a replaced source stated", async () => {
    const g = open({ extractor: lineExtractor });
    const first = await g.insert.text("ann WORKS_AT acme\nann KNOWS bob", { source_id: "hr", event_time: utc(2024) });
    const [works, knows] = first.relations.map((r) => r.id) as [string, string];
    const likes = (await g.insert.text("ann LIKES tea", { source_id: "chat" })).relations[0]!.id;
    await g.insert.text("ann LIKES tea", { source_id: "hr", event_time: utc(2024) });
    const second = await g.insert.text("ann KNOWS bob\nann READS news", {
      source_id: "hr",
      event_time: utc(2025),
      replace_source: true,
    });
    const reads = second.relations[1]!.id;
    expect(second.source_diff).toEqual({ kept: [knows], added: [reads], retired: [works] });
    expect(second.warnings.map((w) => w.code)).toEqual(["fact_retired_by_source"]);
    const retired = (await g.relations.versions(works))[0]!;
    expect([retired.is_current, retired.invalidated_at, retired.invalidated_by]).toEqual([
      false,
      utc(2025),
      second.source_version,
    ]);
    expect((await g.relations.get(likes))!.is_current).toBe(true);
    const now = await g.retrieve("ann acme");
    expect(now.context).not.toContain("WORKS_AT");
    expect(now.context).not.toContain("ann WORKS_AT acme");
    const then = await g.retrieve("ann acme", { as_of: utc(2024, 6) });
    expect(then.context).toContain("ann -[WORKS_AT]-> acme");
    expect(then.context).toContain("ann WORKS_AT acme");
    const again = await g.insert.text("ann KNOWS bob\nann READS news", { source_id: "hr", replace_source: true });
    expect(again.source_diff).toEqual({ kept: [knows, reads].sort(), added: [], retired: [] });
  });

  it("keeps certified facts on a replaced source and needs a source id", async () => {
    const g = open({ extractor: lineExtractor });
    const rel = (await g.insert.text("ann WORKS_AT acme", { source_id: "hr" })).relations[0]!;
    await g.relations.certify(rel.id, { by: "hr" });
    const result = await g.insert.text("ann KNOWS bob", { source_id: "hr", replace_source: true });
    expect(result.source_diff!.retired).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["certified_kept"]);
    expect((await g.relations.get(rel.id))!.is_current).toBe(true);
    expect((await g.insert.text("ann KNOWS bob", { source_id: "hr" })).source_diff).toBeNull();
    await expect(g.insert.text("ann KNOWS bob", { replace_source: true })).rejects.toThrow(
      "replace_source needs a source_id",
    );
    await expect(
      g.insert.text("ann KNOWS bob", { source_id: "hr", replace_source: "yes" as unknown as boolean }),
    ).rejects.toThrow("replace_source must be a boolean");
  });

  it("counts and lints the namespace", async () => {
    const schema = { entities: [{ name: "Thing" }], relations: [{ type: "KNOWS" }] };
    const g = open({ extractor: lineExtractor, schema });
    const empty = await g.readiness();
    expect([empty.ready, empty.reachable, empty.has_schema, empty.lint]).toEqual([false, true, true, []]);
    expect(empty.counts).toEqual({ entities: 0, relations: 0, preferences: 0, decisions: 0, sources: 0 });
    const first = await g.insert.text("ann KNOWS bob", { source_id: "hr" });
    await g.insert.facts({
      entities: [
        { type: "Gadget", name: "Lamp" },
        { type: "Thing", name: "Cy" },
      ],
    });
    const loose = await g.relations.create("thing:ann", "LIKES", "thing:cy");
    await g.decisions.create("Pick", { steps: [first.relations[0]!.id] });
    await g.insert.text("ann LIKES cy", { source_id: "hr", replace_source: true });
    const report = await g.readiness();
    expect([report.ready, report.store, report.namespace]).toEqual([true, g.store.constructor.name, g.namespace]);
    expect(report.counts).toEqual({ entities: 4, relations: 1, preferences: 0, decisions: 1, sources: 1 });
    const decision = (await g.decisions.list()).items[0]!.id;
    expect(Object.fromEntries(report.lint.map((i) => [i.code, [i.count, i.sample]]))).toEqual({
      orphan_entity: [1, ["gadget:lamp"]],
      stale_decision_step: [1, [decision]],
      type_off_schema: [2, ["gadget:lamp", loose.id].sort()],
    });
    await g.relations.create("thing:bob", "KNOWS", "thing:cy");
    expect((await g.readiness()).lint.map((i) => i.code)).toContain("unsupported_fact");
  });

  it("renders an Obsidian vault", async () => {
    const g = open();
    await g.insert.facts({
      entities: [
        { type: "Person", name: "Ann", aliases: ["Annie"], properties: { age: 30 } },
        { type: "Company", name: "Acme" },
        { type: "Product", name: "Acme" },
        { type: "Thing", name: "A/B: test?" },
      ],
      relations: [{ id: "relation:w", from_entity: "person:ann", type: "WORKS_AT", to_entity: "company:acme" }],
      preferences: [{ subject_entity: "person:ann", key: "tool", value_entity: "product:acme" }],
      decisions: [{ title: "Join", steps: ["relation:w"], actor_entity: "person:ann" }],
    });
    const vault = await g.exportObsidian();
    expect(Object.keys(vault).sort()).toEqual([
      "A-B- test-.md",
      "Acme (Product).md",
      "Acme.md",
      "Ann.md",
      "decisions/Join.md",
    ]);
    expect(vault["Ann.md"]).toBe(
      '---\nid: "person:ann"\ntype: "Person"\naliases: ["Annie"]\n---\n# Ann\n\n## Properties\n- age: 30\n\n' +
        "## Links\n- WORKS_AT [[Acme]]\n- prefers [[Acme (Product)]] for tool\n\n## Decisions\n- [[decisions/Join]]\n",
    );
    expect(vault["decisions/Join.md"]).toMatch(
      /# Join\n\n- Actor: \[\[Ann\]\]\n\n## Steps\n1\. \[\[Ann\]\] to \[\[Acme\]\] \(relation:w\)\n$/,
    );
  });

  const merged = async () => {
    const g = open({ extractor: lineExtractor });
    await g.insert.facts({ entities: [{ type: "Thing", name: "acme", aliases: ["acmecorp"] }] });
    return [g, await g.insert.text("ann WORKS_AT acmecorp", { source_id: "hr", event_time: utc(2024) })] as const;
  };

  it("keeps a certified rival through an LLM-judged contradiction", async () => {
    const g = open({ llm: judge, extraction: "regex", contradiction: "llm" });
    const acme = (
      await g.insert.facts({ entities: ANN_AT_ACME.entities, relations: [worksAt("person:ann", "company:acme", 2020)] })
    ).relations[0]!;
    await g.relations.certify(acme.id, { by: "hr" });
    const res = await g.insert.facts({ relations: [worksAt("person:ann", "company:globex", 2022)] });
    expect(res.warnings.map((w) => w.code)).toEqual(["certified_kept"]);
    expect((await g.relations.get(acme.id))!.is_current).toBe(true);
  });

  it("warns when a write changes a certified relation", async () => {
    const g = await employment();
    const rel = (await g.insert.facts({ relations: [worksAt("person:ann", "company:acme", 2024)] })).relations[0]!;
    await g.relations.certify(rel.id, { by: "hr" });
    const same = await g.insert.facts({ relations: [worksAt("person:ann", "company:acme", 2024)] });
    expect(same.warnings).toEqual([]);
    expect((await g.relations.get(rel.id))!.certified_by).toBe("hr");
    const changed = await g.insert.facts({
      relations: [worksAt("person:ann", "company:acme", 2024, { role: "cto" })],
    });
    expect(changed.warnings.map((w) => w.code)).toEqual(["certified_dropped"]);
    expect((await g.relations.get(rel.id))!.certified_at).toBeNull();
  });

  it("ignores support from a replaced version of another source", async () => {
    const g = open({ extractor: lineExtractor });
    const rid = (await g.insert.text("ann WORKS_AT acme", { source_id: "hr", event_time: utc(2024) })).relations[0]!.id;
    await g.insert.text("ann WORKS_AT acme", { source_id: "wiki", event_time: utc(2024) });
    const replace = { event_time: utc(2025), replace_source: true };
    const first = await g.insert.text("ann KNOWS bob", { source_id: "hr", ...replace });
    expect(first.source_diff!.retired).toEqual([]);
    expect((await g.relations.get(rid))!.is_current).toBe(true);
    const second = await g.insert.text("ann KNOWS bob", { source_id: "wiki", ...replace });
    expect(second.source_diff!.retired).toEqual([rid]);
    expect((await g.relations.versions(rid))[0]!.is_current).toBe(false);
  });

  it("leaves a dedupe group with a certified relation alone", async () => {
    const g = open();
    await g.insert.facts({ entities: ANN_AT_ACME.entities });
    for (const id of ["relation:a", "relation:b"])
      await g.relations.create("person:ann", "WORKS_AT", "company:acme", { id });
    await g.relations.certify("relation:b", { by: "hr" });
    const plan = await g.maintenance.dedupeRelations({ dry_run: false });
    expect(plan.groups).toEqual([]);
    expect(plan.certified.map((c) => [c.survivor, c.duplicates])).toEqual([["relation:a", ["relation:b"]]]);
    expect((await g.relations.list()).items.map((r) => r.id).sort()).toEqual(["relation:a", "relation:b"]);
  });

  it("refuses a certified unmerge and keeps a source retirement", async () => {
    const [g, res] = await merged();
    const mergeId = res.merges[0]!.id;
    const rid = res.relations[0]!.id;
    await g.relations.certify(rid, { by: "hr" });
    await expect(g.entities.unmerge(mergeId)).rejects.toThrow(`relation ${rid} is certified`);
    await g.relations.uncertify(rid);
    const gone = await g.insert.text("ann KNOWS bob", { source_id: "hr", event_time: utc(2025), replace_source: true });
    expect(gone.source_diff!.retired).toEqual([rid]);
    const [back] = (await g.entities.unmerge(mergeId)).relations;
    expect([back!.from_entity, back!.to_entity, back!.is_current]).toEqual(["thing:ann", "thing:acmecorp", false]);
    expect([back!.invalidated_by, back!.invalidated_at]).toEqual([gone.source_version, utc(2025)]);
  });

  it("prunes around certified facts and lists the merges it would lose", async () => {
    const [g, res] = await merged();
    const rid = res.relations[0]!.id;
    await g.relations.certify(rid, { by: "hr" });
    const soon = new Date(Date.now() + 30_000);
    const kept = await g.maintenance.prune({ older_than: soon });
    expect([kept.entity_ids, kept.relation_ids, kept.certified, kept.merge_ids]).toEqual([[], [], [rid], []]);
    const every = await g.maintenance.prune({ older_than: soon, include_certified: true });
    expect([every.entity_ids, every.relation_ids]).toEqual([["thing:acme", "thing:ann"], [rid]]);
    expect([every.certified, every.merge_ids]).toEqual([[], [res.merges[0]!.id]]);
  });

  it("keeps a merge survivor off the orphan list", async () => {
    const g = open();
    await g.insert.facts({ entities: [{ type: "Thing", name: "acme", aliases: ["acmecorp"] }] });
    expect((await g.insert.facts({ entities: [{ type: "Thing", name: "acmecorp" }] })).merges).toHaveLength(1);
    expect((await g.readiness()).lint.map((i) => i.code)).not.toContain("orphan_entity");
  });

  it("notes that a check with embedding seeds is lexical", async () => {
    const g = open({ seeds: "embeddings", embedder: flatEmbedder });
    expect((await g.checkAnswerable("zebra")).note).toContain("lexical");
    expect((await open().checkAnswerable("zebra")).note).toBeNull();
  });

  it("explains an empty or failed Cypher query", async () => {
    const g = await employment();
    await g.insert.facts({ relations: [worksAt("person:ann", "company:acme")] });
    let notes: string[];
    try {
      notes = (await checkedCypher(g, "MATCH (p:Persn {name: 'ann'})-[:WORKZ_AT]->(c) RETURN p")).warnings;
    } catch (exc) {
      if (!(exc instanceof StoreError)) throw exc;
      notes = [exc.message];
    }
    const text = notes.join(" ");
    expect(text).toContain("label 'Persn' is not stored");
    expect(text).toContain("stored: Company, Person");
    expect(text).toContain("relationship type 'WORKZ_AT' is not stored");
    expect(text).toContain("is named 'ann', but one is named 'Ann'");
  });
}

await forEachStore("agent trust", suite);

describe("trust rules without a store", () => {
  it("needs stored instances of a schema term", () => {
    const schema = {
      entities: [
        { name: "Person" },
        { name: "Company", synonyms: ["firm"], definitions: [{ name: "headcount", expression: "n" }] },
        { name: "Startup", parent: "Company" },
      ],
    };
    const ann = entity("person:ann", "Ann", "Person");
    const bare = answerability("firm headcount", null, [ann], [], [], asSchema(schema), 3);
    expect(bare.terms.map((t) => [t.term, t.status, t.matches])).toEqual([
      ["firm", "schema_only", ["Company"]],
      ["headcount", "schema_only", ["headcount"]],
    ]);
    expect([bare.verdict, bare.missing]).toEqual(["not_answerable", ["firm", "headcount"]]);
    const zap = entity("startup:zap", "Zap", "Startup");
    const held = answerability("firm headcount", null, [ann, zap], [], [], asSchema(schema), 3);
    expect(held.terms.map((t) => [t.status, t.matches])).toEqual([
      ["type", ["Company"]],
      ["definition", ["headcount"]],
    ]);
  });

  it("passes no PageRank mass through a blocked hub", () => {
    const seeds: Array<[Entity, number]> = [[entity("thing:a", "A"), 1]];
    const rels = [relation("relation:ah", "thing:a", "thing:h"), relation("relation:hb", "thing:h", "thing:b")];
    const nodes = ["thing:a", "thing:h", "thing:b", "thing:0"];
    const open = pprRank(seeds, nodes, rels);
    expect(open.get("thing:b")!).toBeLessThan(open.get("thing:0")!);
    const blocked = pprRank(seeds, nodes, rels, new Set(["thing:h"]));
    expect(blocked.get("thing:0")!).toBeLessThan(blocked.get("thing:b")!);
    expect(blocked.get("thing:h")).toBe(1);
  });

  it("logs every schema field the Ossie export leaves out", async () => {
    const schema = {
      entities: [{ name: "Company", aliases: ["Co"], certified: true }],
      relations: [{ type: "OWNS", from: { types: ["Company"], min_count: 1 }, synonyms: ["holds"] }],
    };
    const { logged } = await captureLog(() => toOssie(schema));
    expect(logged.map((line) => line.slice(line.indexOf(": ") + 2))).toEqual([
      "ossie export: the aliases, certified flag of entity type Company are left out",
      "ossie export: the synonyms, min counts of relation OWNS are left out",
    ]);
  });
});

describe("readiness of an unreachable store", () => {
  it("reports it instead of throwing", async () => {
    const g = new SelfGraph(new Neo4jStore("bolt://127.0.0.1:1", { auth: ["neo4j", "x"] }));
    const report = await g.readiness();
    expect([report.ready, report.reachable, report.store]).toEqual([false, false, "Neo4jStore"]);
    expect(report.error).toContain("127.0.0.1:1");
    await g.close();
  });
});

describe("agent trust over the CLI and MCP", () => {
  const dir = tempDir("sg-trust-cli-");
  const kuzu = ["--store", "kuzu", "--uri", join(dir, "cli.kuzu"), "--schema", JSON.stringify(SINGLE_EMPLOYER)];
  const cli = (args: string[]) =>
    runCli([...kuzu, ...args], { env: { SELFGRAPH_STORE: "", SELFGRAPH_URI: undefined } });

  beforeAll(buildCli);

  it("runs readiness, check-answerable, certify, Ossie export, hubs, replace-source, and the vault export", () => {
    const ontology = join(dir, "ann.json");
    writeFileSync(ontology, JSON.stringify({ ...ANN_AT_ACME, relations: [worksAt("person:ann", "company:acme")] }));
    const rel = (cli(["insert", "facts", ontology]).out as { relations: Array<{ id: string }> }).relations[0]!;
    expect((cli(["readiness"]).out as { counts: { relations: number } }).counts.relations).toBe(1);
    expect((cli(["check-answerable", "where", "does", "Ann", "work"]).out as { verdict: string }).verdict).toBe(
      "answerable",
    );
    expect(
      (cli(["check-answerable", "x", "--term", "Ann", "--term", "churn"]).out as { missing: string[] }).missing,
    ).toEqual(["churn"]);
    expect((cli(["relation", "certify", rel.id, "--by", "hr"]).out as { certified_by: string }).certified_by).toBe(
      "hr",
    );
    expect((cli(["relation", "uncertify", rel.id]).out as { certified_by: null }).certified_by).toBeNull();
    const ossie = cli(["schema", "export", "--to", "ossie"]).out as { ontology: Array<{ concept: string }> };
    expect(ossie.ontology[0]!.concept).toBe("Person");
    expect((cli(["retrieve", "Ann", "--skip-hubs"]).out as { hubs: string[] }).hubs).toEqual([]);
    const inserted = cli(["insert", "text", "Ann works at Acme.", "--source-id", "s", "--replace-source"]);
    expect((inserted.out as { source_diff: unknown }).source_diff).not.toBeNull();
    const vault = join(dir, "vault");
    const written = cli(["export", "obsidian", vault]).out as { notes: number; directory: string };
    expect(written.directory).toBe(vault);
    expect(readFileSync(join(vault, "Ann.md"), "utf8").startsWith("---\n")).toBe(true);
  });

  it("serves the trust tools and instructions over MCP", async () => {
    await configure({ ...DEFAULT_SETTINGS, store: "kuzu", uri: tempKuzu("sg-trust-mcp-") });
    try {
      await callTool("insert_facts", { facts: { entities: [{ type: "Person", name: "Ann" }] } });
      expect(((await callTool("check_readiness", {})).result as { ready: boolean }).ready).toBe(true);
      const report = (await callTool("check_answerable", { question: "Ann churn" })).result as { verdict: string };
      expect(report.verdict).toBe("partial");
      expect(
        ((await callTool("retrieve", { query: "Ann", skip_hubs: true })).result as { hubs: string[] }).hubs,
      ).toEqual([]);
    } finally {
      await close();
    }
  });
});

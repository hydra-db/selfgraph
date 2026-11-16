import { expect, it } from "vitest";

import { ValidationError } from "../src/index.js";
import { forEachStore, freshGraphs, type StoreSpec } from "./helpers.js";

const AB_FACTS = {
  entities: [
    { type: "T", name: "A", id: "t:a" },
    { type: "T", name: "B", id: "t:b" },
  ],
  relations: [{ id: "relation:ab", from_entity: "t:a", type: "KNOWS", to_entity: "t:b" }],
};

async function instant(): Promise<Date> {
  await new Promise((r) => setTimeout(r, 10));
  const stamp = new Date();
  await new Promise((r) => setTimeout(r, 10));
  return stamp;
}

function suite(spec: StoreSpec): void {
  const open = freshGraphs(spec, "diff");

  async function factsGraph() {
    const g = open();
    await g.insert.facts(AB_FACTS, { source_id: "doc-1" });
    return g;
  }

  it("lists every write oldest first, with counts", async () => {
    const g = await factsGraph();
    const out = await g.diff();
    expect(out.changes.map((c) => [c.kind, c.action])).toEqual([
      ["entity", "created"],
      ["entity", "created"],
      ["relation", "created"],
      ["source", "created"],
    ]);
    expect(out.changes.map((c) => c.id)).toEqual(["t:a", "t:b", "relation:ab", "doc-1"]);
    expect(out.changes[0].summary).toBe("T A");
    expect(out.changes[2].summary).toBe("KNOWS t:a -> t:b");
    expect(out.changes[3].summary).toMatch(/^version /);
    expect(out.since).toBeNull();
    expect(out.until).toBeNull();
    expect(out.total).toBe(4);
    expect(out.counts).toEqual({ entity: 2, relation: 1, source: 1 });
  });

  it("reads the half open window between two times", async () => {
    const g = await factsGraph();
    const mid = await instant();
    await g.entities.create("C", "T");
    const all = await g.diff();
    expect(all.total).toBe(5);
    const since = await g.diff({ since: mid });
    expect(since.total).toBe(1);
    expect(since.changes.map((c) => c.id)).toEqual(["t:c"]);
    const until = await g.diff({ until: mid });
    expect(until.total).toBe(4);
    const last = all.changes[all.changes.length - 1].at;
    expect((await g.diff({ since: last })).total).toBe(0);
    const empty = await g.diff({ since: await instant() });
    expect(empty.total).toBe(0);
    expect(empty.counts).toEqual({});
    expect(empty.changes).toEqual([]);
  });

  it("records updates, retirements, certifications, preferences, merges, and unmerges", async () => {
    const g = open({
      schema: {
        entities: [{ name: "Person" }, { name: "Company" }],
        relations: [{ type: "WORKS_AT", from: { types: ["Person"], max_count: 1 } }],
      },
      contradiction: "supersede",
    });
    await g.insert.facts({
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
        { type: "Company", name: "Globex" },
      ],
    });
    const acme = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    const globex = await g.relations.create("person:ann", "WORKS_AT", "company:globex");
    await g.relations.certify(globex.id, { by: "qa" });
    await g.relations.uncertify(globex.id);
    const pref = await g.preferences.create("person:ann", "tool", "company:acme", { strength: 0.5 });
    await g.preferences.update(pref.id, { strength: 0.9 });
    const res = await g.insert.facts({ entities: [{ type: "Person", name: "Robert Smith", aliases: ["Bob Smith"] }] });
    const robert = res.entities[0]!.id;
    const merge = (await g.insert.facts({ entities: [{ type: "Person", name: "bob smith" }] })).merges[0];
    await g.entities.unmerge(merge!.id);
    const out = await g.diff();
    const kind = (k: string) => out.changes.filter((c) => c.kind === k).map((c) => [c.action, c.id, c.summary]);
    expect(kind("relation")).toEqual([
      ["created", acme.id, "WORKS_AT person:ann -> company:acme"],
      ["created", globex.id, "WORKS_AT person:ann -> company:globex"],
      ["retired", acme.id, `WORKS_AT person:ann -> company:acme (by ${globex.id})`],
      ["certified", globex.id, `WORKS_AT person:ann -> company:globex (by qa)`],
      ["uncertified", globex.id, `WORKS_AT person:ann -> company:globex (by qa)`],
    ]);
    expect(kind("preference")).toEqual([
      ["created", pref.id, "preference tool: person:ann -> company:acme"],
      ["updated", pref.id, "preference tool: person:ann -> company:acme"],
    ]);
    expect(kind("merge")).toEqual([
      ["merged", merge!.id, `${merge!.absorbed_id} into ${merge!.survivor_id}: alias`],
      ["unmerged", merge!.id, `${merge!.absorbed_id} back out of ${merge!.survivor_id}`],
    ]);
    expect(kind("entity")).toContainEqual(["created", robert, "Person Robert Smith"]);
  });

  it("filters by kind and keeps counts over the whole window when limited", async () => {
    const g = await factsGraph();
    await g.preferences.create("t:a", "tool", "t:b");
    const whole = await g.diff();
    const out = await g.diff({ kinds: ["entity"] });
    expect(out.total).toBe(2);
    expect(out.counts).toEqual({ entity: 2 });
    expect(out.changes.every((c) => c.kind === "entity")).toBe(true);
    const limited = await g.diff({ limit: 2 });
    expect(limited.total).toBe(whole.total);
    expect(limited.changes).toEqual(whole.changes.slice(-2));
    const entityLimited = await g.diff({ kinds: ["entity"], limit: 1 });
    expect(entityLimited.total).toBe(2);
    expect(entityLimited.changes).toEqual(out.changes.slice(-1));
  });

  it("rejects bad arguments", async () => {
    const g = await factsGraph();
    await expect(g.diff({ kinds: ["nope"] })).rejects.toThrow(ValidationError);
    await expect(g.diff({ limit: 0 })).rejects.toThrow(ValidationError);
    await expect(g.diff({ since: "yesterday" })).rejects.toThrow(ValidationError);
  });
}

await forEachStore("diff reads", suite);

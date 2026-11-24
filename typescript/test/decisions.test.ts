import { expect, it } from "vitest";
import { ids, ValidationError } from "../src/index.js";
import { forEachStore, freshGraphs, type StoreSpec } from "./helpers.js";

function suite(spec: StoreSpec): void {
  const open = freshGraphs(spec, "step-ids");
  it("keeps every step when a page of decisions holds more than a thousand", async () => {
    const g = open();
    await g.insert.facts({
      entities: [
        { type: "Person", name: "A" },
        { type: "Person", name: "B" },
      ],
    });
    const rel = await g.relations.create("person:a", "KNOWS", "person:b");
    for (let i = 0; i < 3; i++) {
      await g.decisions.create(`D${i}`, { id: `decision:d${i}`, steps: Array(400).fill(rel.id) });
    }
    const traces = (await g.decisions.list({ limit: 10 })).items;
    const want = Array.from({ length: 400 }, (_, k) => k);
    expect(traces.map((t) => t.steps.map((s) => s.order))).toEqual([want, want, want]);
  });
  it.each(["relation", "preference", "decision", "profile"] as const)(
    "addresses an inserted %s using id helpers with noncanonical references",
    async (kind) => {
      const g = open();
      const actor = " Person : Jane  Doe ";
      const target = " Company : Acme ";
      await g.insert.facts({
        entities: [
          { type: "Person", name: "Jane Doe" },
          { type: "Company", name: "Acme" },
        ],
        relations: [{ from_entity: actor, type: "worksAt", to_entity: target }],
        preferences: [{ subject_entity: actor, key: "employer", value_entity: target }],
        decisions: [{ actor_entity: actor, title: "Pick employer" }],
      });
      const getters = {
        relation: () => g.relations.get(ids.relationId(actor, "worksAt", target)),
        preference: () => g.preferences.get(ids.preferenceId(actor, "preference", "employer", target)),
        decision: () => g.decisions.get(ids.decisionId(actor, "Pick employer")),
        profile: () => g.store.getNode(g.namespace, "Profile", ids.profileId(actor)),
      };
      expect(await getters[kind]()).not.toBeNull();
    },
  );
  for (const stepFirst of [false, true]) {
    it(`keeps decisions and steps separate with stepFirst=${stepFirst}`, async () => {
      const g = open();
      await g.entities.create("Ann", "Person");
      await g.entities.create("Bob", "Person");
      const rel = await g.relations.create("person:ann", "KNOWS", "person:bob");
      const withStep = () => g.decisions.create("With a step", { id: "decision:first", steps: [rel.id] });
      const other = () => g.decisions.create("Independent decision", { id: "decision:first:step:0" });
      if (stepFirst) {
        await withStep();
        await other();
      } else {
        await other();
        await withStep();
      }
      expect((await g.decisions.get("decision:first:step:0"))?.title).toBe("Independent decision");
      expect((await g.decisions.get("decision:first"))?.steps.map((s) => s.relation_id)).toEqual([rel.id]);
      await g.decisions.delete("decision:first:step:0");
      expect((await g.decisions.get("decision:first"))?.steps.map((s) => s.relation_id)).toEqual([rel.id]);
      expect((await g.relations.delete(rel.id)).deleted_decisions).toBe(1);
      expect(await g.decisions.get("decision:first")).toBeNull();
    });
    it(`reserves the internal step prefix with stepFirst=${stepFirst}`, async () => {
      const g = open();
      await g.entities.create("Ann", "Person");
      await g.entities.create("Bob", "Person");
      const rel = await g.relations.create("person:ann", "KNOWS", "person:bob");
      const withStep = () => g.decisions.create("With a step", { id: "decision:first", steps: [rel.id] });
      if (stepFirst) await withStep();
      const id = "decisionstep:decision:first:step:0";
      await expect(g.entities.create("Intruder", "Thing", { id })).rejects.toThrow(/reserved/);
      await expect(g.decisions.create("Intruder", { id })).rejects.toThrow(ValidationError);
      if (!stepFirst) await withStep();
      expect((await g.decisions.get("decision:first"))?.steps.map((s) => s.relation_id)).toEqual([rel.id]);
    });
  }
}
await forEachStore("decision step ids", suite);

it("round trips internal step ids", () => {
  for (const tid of ["decision:first", "decision:first:step:0", "decision:日本語"]) {
    for (const order of [0, 1, 99]) {
      const sid = ids.stepId(tid, order);
      expect(sid).toBe(`decisionstep:${tid}:step:${order}`);
      expect(ids.traceOfStep(sid)).toBe(tid);
    }
  }
});

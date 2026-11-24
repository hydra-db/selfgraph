import { expect, it } from "vitest";
import type { Schema } from "../src/index.js";
import { ValidationError } from "../src/index.js";
import { forEachStore, freshGraphs } from "./helpers.js";

const TO_CAP: Schema = {
  entities: [{ name: "Person" }, { name: "Company" }],
  relations: [{ type: "WORKS_AT", to: { types: ["Company"], max_count: 1 } }],
};
const FROM_CAP: Schema = {
  entities: [{ name: "Person" }, { name: "Company" }],
  relations: [{ type: "WORKS_AT", from: { types: ["Person"], max_count: 1 } }],
};
const BOTH_CAP: Schema = {
  entities: [{ name: "Person" }, { name: "Company" }],
  relations: [{ type: "WORKS_AT", from: { types: ["Person"], max_count: 1 }, to: { max_count: 1 } }],
};

const PEOPLE = Array.from({ length: 4 }, (_, i) => `person:p${i}`);

await forEachStore("concurrent max_count", (spec) => {
  const fresh = freshGraphs(spec, "maxcount");

  const seed = async (schema: Schema, options = {}) => {
    const g = fresh({ schema, contradiction: "supersede", ...options });
    await g.insert.facts({
      entities: [
        { type: "Company", name: "Acme", id: "company:acme" },
        ...PEOPLE.map((id, i) => ({ type: "Person", name: `P${i}`, id })),
      ],
    });
    return g;
  };

  const currentInto = async (g: Awaited<ReturnType<typeof seed>>, target: string) =>
    (await g.relations.list()).items.filter((r) => r.to_entity === target).map((r) => r.id);
  const currentFrom = async (g: Awaited<ReturnType<typeof seed>>, source: string) =>
    (await g.relations.list()).items.filter((r) => r.from_entity === source).map((r) => r.id);

  it.runIf(spec.transactional)("holds the to-side cap under concurrent supersede creates", async () => {
    const g = await seed(TO_CAP);
    await Promise.allSettled(
      PEOPLE.map((p, i) => g.relations.create(p, "WORKS_AT", "company:acme", { id: `relation:${i}` })),
    );
    expect(await currentInto(g, "company:acme")).toHaveLength(1);
  });

  it.runIf(spec.transactional)("rejects the to-side surplus under concurrent strict creates", async () => {
    const g = await seed(TO_CAP, { contradiction: "warn", schema_mode: "strict" });
    const results = await Promise.allSettled(
      PEOPLE.map((p, i) => g.relations.create(p, "WORKS_AT", "company:acme", { id: `relation:${i}` })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(await currentInto(g, "company:acme")).toHaveLength(1);
    expect(ok).toHaveLength(1);
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
  });

  it.runIf(spec.transactional)("holds the to-side cap under concurrent insert.facts", async () => {
    const g = await seed(TO_CAP);
    await Promise.allSettled(
      PEOPLE.map((p) =>
        g.insert.facts({ relations: [{ from_entity: p, type: "WORKS_AT", to_entity: "company:acme" }] }),
      ),
    );
    expect(await currentInto(g, "company:acme")).toHaveLength(1);
  });

  it.runIf(spec.transactional)("holds the from-side cap under concurrent supersede creates", async () => {
    const g = await seed(FROM_CAP);
    const companies = Array.from({ length: 4 }, (_, i) => `company:c${i}`);
    await g.insert.facts({ entities: companies.map((id, i) => ({ type: "Company", name: `C${i}`, id })) });
    await Promise.allSettled(
      companies.map((c, i) => g.relations.create("person:p0", "WORKS_AT", c, { id: `relation:${i}` })),
    );
    expect(await currentFrom(g, "person:p0")).toHaveLength(1);
  });

  it.runIf(spec.transactional)("holds both caps under concurrent supersede creates", async () => {
    const g = await seed(BOTH_CAP);
    await Promise.allSettled(
      PEOPLE.map((p, i) => g.relations.create(p, "WORKS_AT", "company:acme", { id: `relation:${i}` })),
    );
    expect(await currentInto(g, "company:acme")).toHaveLength(1);
  });
});

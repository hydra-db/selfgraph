import { expect, it } from "vitest";
import { StoreError, ValidationError } from "../src/index.js";
import { checkedCypher } from "../src/runtime.js";
import { forEachStore, freshGraphs } from "./helpers.js";

await forEachStore("store errors", (spec) => {
  const open = freshGraphs(spec, "store_errors");
  it.runIf(spec.name === "kuzu").each(["x", "{}", "[]", "null", "missing_fields"])(
    "codes malformed stored document %s",
    async (doc) => {
      for (const edge of [false, true]) {
        const g = open();
        await g.entities.create("Ada", "Person");
        await g.entities.create("Bo", "Person");
        const rel = await g.relations.create("person:ada", "KNOWS", "person:bo");
        const id = edge ? rel.id : "person:ada";
        const query = edge
          ? "MATCH ()-[r:R]->() WHERE r.ns = $ns AND r.sid = $id SET r.doc = $doc"
          : "MATCH (n:N) WHERE n.ns = $ns AND n.id = $id SET n.doc = $doc";
        await g.runCypher(query, {
          ns: g.namespace,
          id,
          doc: doc === "missing_fields" ? JSON.stringify({ id, ns: g.namespace }) : doc,
        });
        const reads = edge
          ? [() => g.relations.get(id), () => g.relations.list(), () => g.relations.versions(id)]
          : [() => g.entities.get(id), () => g.entities.list()];
        reads.push(() => checkedCypher(g, "MATCH (n:N) WHERE false RETURN n") as never);
        for (const read of reads) {
          await expect(read()).rejects.toBeInstanceOf(StoreError);
          await expect(read()).rejects.toMatchObject({
            code: "invalid_stored_data",
            field: "doc",
            message: expect.stringContaining(id),
          });
          await expect(read()).rejects.toMatchObject({ message: expect.stringContaining(g.namespace) });
        }
      }
    },
  );
  it.runIf(["kuzu", "hydradb"].includes(spec.name))("codes certification surrogates without writing", async () => {
    const g = open();
    await g.entities.create("Ada", "Person");
    await g.entities.create("Bo", "Person");
    const rel = await g.relations.create("person:ada", "KNOWS", "person:bo");
    await expect(g.relations.certify(rel.id, { by: "a\ud83dlonely" })).rejects.toBeInstanceOf(ValidationError);
    await expect(g.relations.certify(rel.id, { by: "a\ud83dlonely" })).rejects.toMatchObject({
      code: "invalid_argument",
      field: "by",
      message: "certified_by cannot contain unpaired surrogate characters",
    });
    expect((await g.relations.get(rel.id))!.certified_by).toBeNull();
    expect((await g.relations.certify(rel.id, { by: "Ada 😀" })).certified_by).toBe("Ada 😀");
  });
  it.runIf(spec.name === "hydradb")("codes surrogates in the HydraDB size guard", async () => {
    const g = open();
    await expect(
      g.store.upsertNode(g.namespace, "Entity", "person:ada", { id: "person:ada", name: "a\ud83dlonely" }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      field: "name",
      message: "HydraDB write field 'name' cannot contain unpaired surrogate characters",
    });
  });
});

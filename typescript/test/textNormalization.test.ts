import { expect, it } from "vitest";
import type { z } from "zod";
import type { LLMClient } from "../src/protocols.js";
import { freshGraphs, KUZU_SPEC } from "./helpers.js";

const open = freshGraphs(KUZU_SPEC, "normalization");

it("promoted preference key uses canonical type", async () => {
  let type = "DB";
  const llm: LLMClient = {
    async generate({ output }) {
      const kind = Object.keys((output as z.ZodObject<z.ZodRawShape>).shape)[0]!;
      if (kind === "entities")
        return {
          entities: [
            { type: "Person", name: "Ann", aliases: [] },
            { type, name: "HydraDB", aliases: [] },
          ],
        } as never;
      if (kind === "relations")
        return { relations: [{ from_name: "Ann", type: "PREFERS", to_name: "HydraDB", event_time: null }] } as never;
      return { [kind]: [] } as never;
    },
  };
  const graph = open({
    llm,
    resolver: "exact",
    schema: { entities: [{ name: "Person" }, { name: "Database", aliases: ["DB"] }] },
  });
  const first = await graph.insert.text("Ann likes HydraDB.");
  type = "Database";
  const second = await graph.insert.text("Ann likes HydraDB.");
  expect(first.preferences[0]!.key).toBe("database");
  expect(second.preferences[0]!.key).toBe("database");
  expect(first.preferences[0]!.id).toBe(second.preferences[0]!.id);
  expect((await graph.preferences.list()).items).toHaveLength(1);
});

it.each(
  ["μαΐου", "αΰπνία"].flatMap((name) =>
    ["NFC", "NFD"].flatMap((form) => [false, true].map((uppercaseStored) => ({ name, form, uppercaseStored }))),
  ),
)("retrieves Greek casefold $name $form $uppercaseStored", async ({ name, form, uppercaseStored }) => {
  const graph = open();
  const stored = (uppercaseStored ? name.toUpperCase() : name).normalize(form);
  const query = (uppercaseStored ? name : name.toUpperCase()).normalize(form);
  const entity = await graph.entities.create(stored, "Word");
  expect((await graph.retrieve(query)).seeds.map((seed) => seed.id)).toEqual([entity.id]);
});

import { describe, expect, it } from "vitest";

import { freshGraphs, KUZU_SPEC } from "./helpers.js";

const PEOPLE = {
  entities: [
    { name: "Ada", type: "Person" },
    { name: "Acme", type: "Company" },
  ],
};

describe("error fields", () => {
  const open = freshGraphs(KUZU_SPEC, "fields");

  it.each([
    [
      "immutable_identity",
      (graph: ReturnType<typeof open>) => graph.entities.update("person:ada", { type: "Robot" }),
      "type",
    ],
    ["invalid_cursor", (graph: ReturnType<typeof open>) => graph.entities.list({ cursor: "bogus" }), "cursor"],
  ] as const)("names %s at fault", async (code, call, field) => {
    const graph = open();
    await graph.insert.facts(PEOPLE);
    await expect(call(graph)).rejects.toThrow(expect.objectContaining({ code, field }));
  });
});

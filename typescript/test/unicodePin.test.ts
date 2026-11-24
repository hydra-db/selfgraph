import { describe, expect, it } from "vitest";
import { ids } from "../src/index.js";
import { freshGraphs, KUZU_SPEC } from "./helpers.js";

const open = freshGraphs(KUZU_SPEC, "unicodepin");
const AFTER_15_0 = ["\u{2ebf0}", "\u{2ebf1}", "\u{323b0}", "\u{1c89}", "\u{a7cb}"];

describe("ids and tokens use the Unicode 15.0 tables whatever Node runs", () => {
  it.each(AFTER_15_0)("drops %s, added after Unicode 15.0, from ids", (char) => {
    expect(ids.entityId("Person", `王${char}`)).toBe("person:王");
    expect(ids.entityId("Person", `Ann ${char}x`)).toBe("person:ann-x");
    expect(ids.normalizeRelType(`works${char}at`)).toBe("WORKS_AT");
  });

  it("keeps the characters added in Unicode 14.0 and 15.0 and lowercases a final sigma like Python", () => {
    expect(ids.entityId("Person", "王\u{31350}\u{2ebf0}")).toBe("person:王\u{31350}");
    expect(ids.entityId("Person", "\u{2c2f}")).toBe("person:\u{2c5f}");
    expect(ids.normalizeRelType("\u{a7c0}")).toBe("\u{a7c0}");
    expect(ids.entityId("Person", "ΟΔΥΣΣΕΥΣ")).toBe("person:οδυσσευς");
    expect(ids.entityId("Person", "ΑΣ ΣΑ")).toBe("person:ας-σα");
  });

  it.each(AFTER_15_0)("seeds retrieval the same with %s, added after Unicode 15.0", async (char) => {
    const graph = open();
    const entity = await graph.entities.create("王", "Person");
    expect((await graph.retrieve(`王${char}`)).seeds.map((seed) => seed.id)).toEqual([entity.id]);
  });

  it.each(AFTER_15_0)("keeps a contraction after %s, added after Unicode 15.0, in question terms", async (char) => {
    const report = await open().checkAnswerable(`${char}can't go`);
    expect(report.terms.map((item) => item.term)).toEqual(["can't", "go"]);
  });
});

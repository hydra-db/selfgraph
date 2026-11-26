import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors.js";
import { EntityInput, PreferenceInput, RelationInput } from "../src/models.js";
import { parseJson, readJson } from "../src/runtime.js";
import { tempDir } from "./helpers.js";

const dir = tempDir("sg-json-depth-");

const nested = (levels: number) => "[".repeat(levels) + "]".repeat(levels);

describe("deep JSON input", () => {
  it("rejects a property deeper than the validator can recurse with a coded error", () => {
    for (const wrap of [(v: unknown) => ({ a: v }), (v: unknown) => [v]]) {
      let value: unknown = 1;
      for (let i = 0; i < 20_000; i++) value = wrap(value);
      const builds: Array<[() => unknown, string]> = [
        [
          () => EntityInput.parse({ type: "T", name: "n", properties: { p: value } }),
          "entity property and external id",
        ],
        [
          () => RelationInput.parse({ from_entity: "t:a", type: "R", to_entity: "t:b", properties: { p: value } }),
          "relation property",
        ],
        [
          () =>
            PreferenceInput.parse({ subject_entity: "t:a", key: "k", value_entity: "t:b", properties: { p: value } }),
          "preference property",
        ],
      ];
      for (const [build, label] of builds) {
        let error: unknown;
        try {
          build();
        } catch (exc) {
          error = exc;
        }
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).code).toBe("invalid_argument");
        expect((error as ValidationError).message).toBe(`${label} is nested too deeply; keep it under 64 levels`);
      }
    }
  });

  it("raises instead of returning a value past the depth limit", () => {
    try {
      parseJson(nested(130), "");
    } catch (exc) {
      expect(exc).toBeInstanceOf(ValidationError);
      expect((exc as ValidationError).code).toBe("invalid_argument");
      expect((exc as Error).message).toContain("nested too deeply");
      return;
    }
    throw new Error("parseJson accepted a document past the depth limit");
  });

  it("uses the same depth boundary as the typed API", () => {
    expect(() => parseJson(nested(65), "")).not.toThrow();
    expect(() => parseJson(nested(66), "")).toThrow(/nested too deeply/);
  });

  it("names the field and the file the caller gave", () => {
    let field: string | undefined;
    try {
      parseJson(nested(130), " in --prop", "k");
    } catch (exc) {
      field = (exc as ValidationError).field;
    }
    expect(field).toBe("k");

    const path = join(dir, "facts.json");
    writeFileSync(path, nested(130));
    expect(() => readJson(path)).toThrow(/nested too deeply/);
  });
});

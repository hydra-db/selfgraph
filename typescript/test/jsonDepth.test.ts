import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { parseJson, readJson } from "../src/runtime.js";
import { buildCli, runCli, tempDir } from "./helpers.js";

const DEEP = "[".repeat(100_000) + "]".repeat(100_000);
const ARGV_DEEP = "[".repeat(200) + "]".repeat(200);
const MESSAGE = "invalid JSON in --prop: too deeply nested; keep it under 64 levels";
const FLAG_MESSAGE = "invalid JSON: too deeply nested; keep it under 64 levels";
const dir = tempDir("sg-json-depth-");

beforeAll(buildCli);

describe("deep JSON input", () => {
  it("reports a deep document as invalid JSON with its field, without counting string brackets", () => {
    const text = JSON.stringify({ value: "[".repeat(1000) + "]".repeat(1000) });
    expect(parseJson(text, "")).toEqual({ value: "[".repeat(1000) + "]".repeat(1000) });
    try {
      parseJson(DEEP, " in --prop", "k");
    } catch (exc) {
      if (!(exc instanceof ValidationError)) throw exc;
      expect(exc.message).toBe(MESSAGE);
      expect([exc.code, exc.field]).toEqual(["invalid_argument", "k"]);
      return;
    }
    throw new Error("parseJson accepted a deep document");
  });

  it("names the path for a deep file", () => {
    const path = join(dir, "facts.json");
    writeFileSync(path, DEEP);
    try {
      readJson(path);
    } catch (exc) {
      if (!(exc instanceof ValidationError)) throw exc;
      expect(exc.message).toContain(`invalid JSON in '${path}': too deeply nested`);
      expect(exc.field).toBe("path");
      return;
    }
    throw new Error("readJson accepted a deep document");
  });

  it("exits 2 for a deep --prop without falling back to text", () => {
    const args = ["--store", "kuzu", "--uri", join(dir, "cli.kuzu"), "entity", "create"];
    for (const flag of ["--name", "A", "--type", "T"]) args.push(flag);
    args.push("--prop", `k=${ARGV_DEEP}`);
    const result = runCli(args, { env: { SELFGRAPH_STORE: "", SELFGRAPH_URI: undefined } });
    expect(result.code).toBe(2);
    expect(result.err).toContain(`error[invalid_argument]: ${FLAG_MESSAGE}`);
    expect(result.err).toContain("field: k");
    expect(result.err).not.toContain("stack");
  });
});

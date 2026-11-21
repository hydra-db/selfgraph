import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { SelfGraph } from "../src/client.js";
import { KuzuStore } from "../src/stores/kuzu.js";
import { buildCli, cliError, runCli, tempKuzu } from "./helpers.js";

const KUZU = tempKuzu("selfgraph-kuzu-params-");

/**
 * Run the built CLI against the suite's Kuzu database.
 *
 * @param args (string[]): the CLI arguments.
 * @return ({ code: number; out: unknown; err: string }): the exit code, parsed stdout, and stderr.
 */
function cli(args: string[]) {
  return runCli(["--store", "kuzu", "--uri", KUZU, ...args]);
}

beforeAll(buildCli);

describe("empty Kuzu query parameters", () => {
  it("rejects empty containers through the SDK, naming the parameter and nested path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selfgraph-params-"));
    const g = new SelfGraph(new KuzuStore(join(dir, "params.kuzu")));
    try {
      const message = (path: string, kind: string) =>
        `parameter '${path}' is an empty ${kind}, which Kuzu cannot type; pass a non-empty ${kind}`;
      for (const [param, path, kind] of [
        [[], "x", "list"],
        [{}, "x", "map"],
        [{ a: [] }, "x.a", "list"],
        [{ a: { b: {} } }, "x.a.b", "map"],
      ] as const) {
        const exc = (await g.runCypher("RETURN $x AS x", { x: param }).catch((e: unknown) => e)) as {
          message: string;
          code: string;
          field: string;
        };
        expect(exc.message).toBe(message(path, kind));
        expect([exc.code, exc.field]).toEqual(["invalid_argument", "x"]);
      }
      expect((await g.runCypher("RETURN $x AS x", { x: [1] })).rows).toEqual([{ x: [1] }]);
      expect((await g.runCypher("RETURN $x AS x", { x: [{ a: 1 }] })).rows).toEqual([{ x: [{ a: 1 }] }]);
      await expect(g.runCypher("RETURN $x AS x", { x: [{}] })).rejects.toThrow(
        "parameter 'x[0]' is an empty map, which Kuzu cannot type; pass a non-empty map",
      );
    } finally {
      await g.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty parameter through the built CLI with the parameter field", () => {
    for (const [param, kind] of [
      ["[]", "list"],
      ["{}", "map"],
      ['{"a":[]}', "list"],
      ['{"a":{}}', "map"],
    ] as const) {
      const result = cli(["query", "RETURN $x AS x", "--param", `x=${param}`]);
      const path = param.startsWith('{"a":') ? "x.a" : "x";
      expect([result.code, result.out]).toEqual([2, ""]);
      expect(result.err).toBe(
        cliError(
          "invalid_argument",
          `parameter '${path}' is an empty ${kind}, which Kuzu cannot type; pass a non-empty ${kind}`,
          "selfgraph query",
          "x",
        ),
      );
    }
  });

  it("rejects an empty parameter through MCP with the same error fields", async () => {
    const { callTool, close, configure } = await import("../src/mcp.js");
    const { DEFAULT_SETTINGS } = await import("../src/runtime.js");
    await configure({ ...DEFAULT_SETTINGS, store: "kuzu", uri: KUZU, namespace: "mcp_empty_param" });
    try {
      const { result, isError } = await callTool("run_cypher", { query: "RETURN $x AS x", params: { x: [] } });
      expect(isError).toBe(true);
      expect(result).toMatchObject({
        error: "parameter 'x' is an empty list, which Kuzu cannot type; pass a non-empty list",
        error_type: "ValidationError",
        code: "invalid_argument",
        field: "x",
        tool: "run_cypher",
      });
    } finally {
      await close();
    }
  });
});

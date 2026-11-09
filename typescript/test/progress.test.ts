import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { main } from "../src/cli.js";
import type { LLMClient } from "../src/protocols.js";
import { tempKuzu } from "./helpers.js";

const { fakeLlm } = vi.hoisted(() => ({
  fakeLlm: {
    async generate<T>({ output }: { system: string; user: string; output: z.ZodType<T> }): Promise<T> {
      const [key] = Object.keys((output as unknown as z.ZodObject).shape);
      const items = key === "entities" ? [{ type: "Person", name: "Alice", aliases: null }] : [];
      return { [key!]: items } as T;
    },
  } satisfies LLMClient,
}));

vi.mock("../src/runtime.js", async (original) => ({
  ...(await original<typeof import("../src/runtime.js")>()),
  buildLlm: () => fakeLlm,
}));

const uri = tempKuzu("sg-progress-");

describe("insert progress", () => {
  it("prints extracting chunk N/M on stderr for a multi-chunk LLM insert from the CLI", async () => {
    const err: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => err.push(String(chunk)) > 0);
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
      const done = args.find((a) => typeof a === "function") as (() => void) | undefined;
      done?.();
      return true;
    });
    try {
      const text = Array(600).fill("Alice met Bob near the old river bridge at dawn.").join(" ");
      expect(await main(["--store", "kuzu", "--uri", uri, "insert", "text", text])).toBe(0);
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
    expect(err.join("")).toContain("selfgraph: extracting chunk 1/");
    expect(err.join("")).toContain("selfgraph: extracting chunk 2/");
  });
});

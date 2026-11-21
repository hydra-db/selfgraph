import { afterEach, describe, expect, it, vi } from "vitest";

import { SelfGraph } from "../src/client.js";
import { KuzuStore } from "../src/stores/kuzu.js";
import { tempKuzu } from "./helpers.js";

const setup = vi.hoisted(() => ({ fails: false }));

vi.mock("../src/llm/index.js", async (original) => {
  const actual = await original<typeof import("../src/llm/index.js")>();
  return {
    ...actual,
    resolveLlm: (llm: Parameters<typeof actual.resolveLlm>[0]) => {
      if (setup.fails) throw new Error("the LLM setup failed");
      return actual.resolveLlm(llm);
    },
  };
});

const uri = tempKuzu("sg-build-");

afterEach(() => {
  setup.fails = false;
  vi.restoreAllMocks();
});

describe("buildGraph", () => {
  it("closes the store it built when a later step fails, and the path opens again", async () => {
    const close = vi.spyOn(KuzuStore.prototype, "close");
    setup.fails = true;
    expect(() => SelfGraph.connect({ store: "kuzu", uri })).toThrow("the LLM setup failed");
    expect(close).toHaveBeenCalledTimes(1);
    setup.fails = false;
    const g = SelfGraph.connect({ store: "kuzu", uri });
    await g.initialize();
    expect((await g.entities.create("Ada", "Person")).id).toBe("person:ada");
    await g.close();
  });

  it("throws the build error when closing the store also fails", () => {
    const close = vi.spyOn(KuzuStore.prototype, "close").mockRejectedValue(new Error("close failed"));
    setup.fails = true;
    expect(() => SelfGraph.connect({ store: "kuzu", uri })).toThrow("the LLM setup failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

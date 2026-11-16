import { describe, expect, it } from "vitest";

import { type GraphStore, HydraDBStore, StoreError } from "../src/index.js";
import { forEachStore, type StoreSpec, uniqueNs } from "./helpers.js";

const props = (ns: string, id: string) => ({ id, ns, name: id });

function suite(spec: StoreSpec) {
  it.runIf(spec.name === "hydradb")("runs a nested transaction's writes on another store", async () => {
    const [outer, inner]: GraphStore[] = [spec.make(), spec.make()];
    const ns = uniqueNs("queue");
    try {
      await outer.transaction(async (a) => {
        await a.upsertNode(ns, "Source", "x:outer", props(ns, "x:outer"));
        await inner.transaction((b) => b.upsertNode(ns, "Source", "x:inner", props(ns, "x:inner")));
      });
      const found = await Promise.all(["x:outer", "x:inner"].map((id) => outer.getNode(ns, "Source", id)));
      expect(found.map((n) => n !== null)).toEqual([true, true]);
    } finally {
      await outer.close?.();
      await inner.close?.();
    }
  });

  it.runIf(spec.name === "hydradb")("checks the label of an edge endpoint that is still queued", async () => {
    const store: GraphStore = spec.make();
    const ns = uniqueNs("queue");
    try {
      const [wrong, right] = await store.transaction(async (tx) => {
        await tx.upsertNode(ns, "Source", "x:a", props(ns, "x:a"));
        await tx.upsertNode(ns, "Profile", "x:b", props(ns, "x:b"));
        return [
          await tx.createEdge(ns, "KNOWS", "Source", "x:a", "Source", "x:b", { id: "e1", ns }),
          await tx.createEdge(ns, "KNOWS", "Source", "x:a", "Profile", "x:b", { id: "e2", ns }),
        ];
      });
      expect([wrong, right]).toEqual([false, true]);
      expect((await store.listEdgeVersions(ns, "e2")).map((e) => e.props.id)).toEqual(["e2"]);
    } finally {
      await store.close?.();
    }
  });

  it.runIf(spec.name === "hydradb")("leaves evidence unwritten when a write queued before it fails", async () => {
    const store: GraphStore = spec.make();
    const ns = uniqueNs("queue");
    const queue = store as unknown as { exec: (query: string, params?: unknown) => Promise<unknown> };
    const real = queue.exec.bind(store);
    try {
      queue.exec = (query, params) =>
        query.includes("SET n:Source") ? Promise.reject(new StoreError("write failed")) : real(query, params);
      await expect(
        store.transaction(async (tx) => {
          await tx.upsertNode(ns, "Source", "x:s", props(ns, "x:s"));
          await tx.upsertNode(ns, "Evidence", "x:e", { ...props(ns, "x:e"), target_id: "x:s" });
        }),
      ).rejects.toThrow(StoreError);
      queue.exec = real;
      expect(await store.getNode(ns, "Evidence", "x:e")).toBeNull();
    } finally {
      await store.close?.();
    }
  });

  it.runIf(spec.name === "hydradb")("applies extra_label to the node", async () => {
    const store: GraphStore = spec.make();
    const ns = uniqueNs("queue");
    try {
      await store.transaction(async (tx) => {
        await tx.upsertNode(ns, "Source", "x:a", props(ns, "x:a"), { extra_label: "CustomLabel" });
      });
      const byPrimary = await store.getNode(ns, "Source", "x:a");
      const byExtra = await store.getNode(ns, "CustomLabel", "x:a");
      expect(byPrimary).not.toBeNull();
      expect(byExtra).not.toBeNull();
      expect(byExtra?.id).toBe("x:a");
    } finally {
      await store.close?.();
    }
  });
}

await forEachStore("HydraDB write queue", suite);

describe("HydraDB write queue failure", () => {
  it("rejects the transaction without an unhandled rejection when a queued write fails", async () => {
    const store = new HydraDBStore("bolt://127.0.0.1:1", { auth: ["neo4j", "unused"] });
    const queue = store as unknown as { exec: (query: string, params?: unknown) => Promise<unknown> };
    queue.exec = (query) =>
      query.includes("SET n:Source") ? Promise.reject(new StoreError("write failed")) : Promise.resolve({ rows: [] });
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      await expect(store.transaction((tx) => tx.upsertNode("ns", "Source", "x:s", props("ns", "x:s")))).rejects.toThrow(
        "write failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
      await store.close();
    }
  });
});

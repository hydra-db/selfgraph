import { describe, expect, it } from "vitest";

import { type GraphStore, HydraDBStore, SelfGraph, StoreError } from "../src/index.js";
import { forEachStore, type StoreSpec, uniqueNs } from "./helpers.js";

const props = (ns: string, id: string) => ({ id, ns, name: id });

function suite(spec: StoreSpec) {
  it.runIf(spec.name === "hydradb")("keeps parallel versions and namespace isolation in point reads", async () => {
    const store = spec.make();
    const namespaces = [uniqueNs("point"), uniqueNs("point_other")];
    const sid = "relation:shared";
    try {
      await store.initialize();
      for (const ns of namespaces) {
        for (const node of ["x:a", "x:b", "x:c", "x:d"]) {
          await store.upsertNode(ns, "Entity", node, {
            ...props(ns, node),
            type: "X",
            aliases: [],
            external_ids_json: "{}",
            properties_json: "{}",
            source_count: 0,
            created_at: "2026-01-01T00:00:00+00:00",
            updated_at: "2026-01-01T00:00:00+00:00",
          });
        }
        for (const [revision, source, target] of [
          [1, "x:a", "x:b"],
          [2, "x:a", "x:b"],
          [3, "x:c", "x:d"],
        ] as const) {
          expect(
            await store.createEdge(ns, "LINK", "Entity", source, "Entity", target, {
              id: sid,
              ns,
              revision,
              is_current: revision === 3,
            }),
          ).toBe(true);
        }
        for (const [id, current] of [
          ["relation:other", true],
          ["relation:retired", false],
        ] as const) {
          expect(
            await store.createEdge(ns, "LINK", "Entity", "x:a", "Entity", "x:b", {
              id,
              ns,
              revision: 1,
              is_current: current,
            }),
          ).toBe(true);
        }
      }
      for (const ns of namespaces) {
        const versions = await store.listEdgeVersions(ns, sid);
        expect(versions.map((v) => v.props.revision)).toEqual([1, 2, 3]);
        expect(versions.every((v) => v.props.ns === ns && v.props.id === sid)).toBe(true);
        const bulk = await store.edgeVersions!(ns, "Entity", "Entity", [sid, "relation:missing"]);
        expect(bulk?.map((v) => v.props.revision).sort()).toEqual([1, 2, 3]);
        expect(bulk?.every((v) => v.props.ns === ns && v.props.id === sid)).toBe(true);
        expect(await store.edgeVersions!(ns, "Source", "Entity", [sid])).toEqual([]);
        const current = await store.getCurrentEdge(ns, sid);
        expect(current?.props.revision).toBe(3);
        expect(current?.props.ns).toBe(ns);
        expect([current?.from_id, current?.to_id]).toEqual(["x:c", "x:d"]);
        expect(await store.getCurrentEdge(ns, "relation:retired")).toBeNull();
        expect(await store.listEdgeVersions(ns, "relation:retired")).toHaveLength(1);
        expect(await store.getCurrentEdge(ns, "relation:missing")).toBeNull();
        expect(await store.listEdgeVersions(ns, "relation:missing")).toEqual([]);
        expect(await store.deleteEdges(ns, sid)).toBe(3);
        expect(await store.listEdgeVersions(ns, sid)).toEqual([]);
        expect(await store.deleteEdges(ns, sid)).toBe(0);
        expect(await store.getCurrentEdge(ns, "relation:other")).not.toBeNull();
      }
    } finally {
      for (const ns of namespaces) {
        for (const node of ["x:a", "x:b", "x:c", "x:d"]) await store.deleteNode(ns, "Entity", node);
      }
      await store.close?.();
    }
  });

  it.each(["node", "edge", "update"])("uses the full HydraDB row budget for JSON blobs: %s", async (operation) => {
    if (spec.name !== "hydradb") return;
    const store = spec.make();
    const ns = uniqueNs("blob");
    const blob = `{"text":"${"x".repeat(1100 * 1024)}"}`;
    try {
      await store.initialize();
      await store.upsertNode(ns, "Source", "x:a", props(ns, "x:a"));
      await store.upsertNode(ns, "Source", "x:b", props(ns, "x:b"));
      const edge = { id: "e:blob", ns, revision: 1, is_current: true, properties_json: blob };
      let query: string;
      if (operation === "node") {
        await store.upsertNode(ns, "Source", "x:a", { ...props(ns, "x:a"), properties_json: blob });
        expect((await store.getNode(ns, "Source", "x:a"))?.properties_json).toBe(blob);
        query = "MATCH (n:Source {ns: $ns, sid: 'x:a'}) RETURN n.properties_json AS duplicate";
      } else {
        const initial = operation === "update" ? { ...edge, properties_json: "{}" } : edge;
        expect(await store.createEdge(ns, "LINK", "Source", "x:a", "Source", "x:b", initial)).toBe(true);
        if (operation === "update") await store.updateCurrentEdge(ns, "e:blob", { properties_json: blob });
        expect((await store.getCurrentEdge(ns, "e:blob"))?.props.properties_json).toBe(blob);
        query = "MATCH (:Source {ns: $ns})-[r:RELATES]->() RETURN r.properties_json AS duplicate";
      }
      expect((await store.runCypher(query, { ns })).rows).toEqual([{ duplicate: null }]);
      await store.deleteNode(ns, "Source", "x:a");
      await store.deleteNode(ns, "Source", "x:b");
    } finally {
      await store.close?.();
    }
  });

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

  it.runIf(spec.name === "hydradb")("writes entity types that are not HydraDB labels", async () => {
    const ns = uniqueNs("labels");
    const graph = new SelfGraph(spec.make(), { namespace: ns });
    try {
      await graph.initialize();
      for (const [name, type] of [
        ["Acme", "Big Co"],
        ["Delhi", "शहर"],
        ["Ada", "Person"],
        ["Bot", "Big-Co.v2"],
      ] as const) {
        await graph.entities.create(name, type);
      }
      const types = Object.fromEntries((await graph.entities.list()).items.map((e) => [e.id, e.type]));
      expect(types).toEqual({
        "big-co:acme": "Big Co",
        "शहर:delhi": "शहर",
        "person:ada": "Person",
        "big-co.v2:bot": "Big-Co.v2",
      });
      expect(await graph.store.getNode(ns, "Person", "person:ada")).not.toBeNull();
    } finally {
      await graph.close();
    }
  });
}

await forEachStore("HydraDB write queue", suite);

it("filters version reads after selecting sources", async () => {
  const store = new HydraDBStore("bolt://127.0.0.1:1", { auth: ["neo4j", "unused"] });
  const queries: string[] = [];
  const driver = store as unknown as { exec: (query: string) => Promise<{ rows: unknown[] }> };
  driver.exec = async (query) => {
    queries.push(query);
    return { rows: [] };
  };
  try {
    await store.matchEdges("versions", { from_label: "Entity", to_label: "Entity", type: "KNOWS", current_only: true });
    await store.matchEdges("versions", { from_label: "Entity", to_label: "Entity", from_in: ["person:a"] });
    await store.getCurrentEdge("versions", "relation:a");
    await store.listEdgeVersions("versions", "relation:a");
    expect(await store.edgeVersions("versions", "Entity", "Entity", ["relation:b", "relation:a"])).toEqual([]);
  } finally {
    await store.close();
  }
  expect(queries).toHaveLength(6);
  const [current, history, byId, versionSeed, versions, batch] = queries;
  expect(current).toContain("(a:Entity {ns: $ns})");
  expect(current).toContain("NOT r.`ns` <> $eq0");
  expect(current).toContain("NOT r.`etype` <> $eq1");
  expect(current).toContain("NOT r.is_current <> true");
  expect(history).toContain("a.id IN $fiids_in");
  expect(history).toContain("NOT r.`ns` <> $eq0");
  expect(history).not.toContain("r.is_current");
  expect(byId).toContain("{sid: $sid}");
  expect(byId).toContain("NOT r.is_current <> true");
  expect(versionSeed).toContain("{sid: $sid}");
  expect(versions).toContain("a.id IN $sources");
  expect(versions).toContain("NOT r.`ns` <> $ns");
  expect(versions).toContain("[r:RELATES {sid: $sid}]");
  expect(versions).not.toContain("r.`sid`");
  expect(batch).toContain("r.sid IN $sids");
  expect(batch).toContain("RETURN a.id AS source");
});

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

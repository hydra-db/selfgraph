import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphPrimitives, GraphStore } from "../src/index.js";
import { ConflictError, ids, NotFoundError, SelfGraph, TransientError, ValidationError } from "../src/index.js";
import { childEdgeId } from "../src/schema.js";
import { reachable, STORE_SPECS, type StoreSpec, selectedStores, uniqueNs } from "./helpers.js";

const specs = selectedStores();
const live = new Map<string, boolean>();
for (const spec of specs) live.set(spec.name, await reachable(spec));

const NO_DELETES = {
  deleted_entities: 0,
  deleted_relation_versions: 0,
  deleted_decisions: 0,
  deleted_preference_versions: 0,
};

const ONTOLOGY = {
  entities: [
    { type: "Person", name: "Jane Doe", aliases: ["JD"], properties: { title: "CTO" } },
    { type: "Company", name: "Acme, Inc." },
    { type: "Database", name: "HydraDB" },
    { type: "Database", name: "Postgres" },
  ],
  relations: [
    { from_entity: "person:jane-doe", type: "works at", to_entity: "company:acme", properties: { since: 2020 } },
    { from_entity: "company:acme", type: "USES", to_entity: "database:hydradb" },
  ],
  preferences: [
    { subject_entity: "person:jane-doe", key: "database", value_entity: "database:hydradb", strength: 0.9 },
    { subject_entity: "person:jane-doe", kind: "disinterest", key: "database", value_entity: "database:postgres" },
  ],
  decisions: [
    {
      title: "Pick HydraDB",
      actor_entity: "person:jane-doe",
      steps: [ids.relationId("company:acme", "USES", "database:hydradb")],
      outcome_entity: "database:hydradb",
      alternative_entities: ["database:postgres"],
      rationale: "temporal history",
    },
  ],
} as const;

function suite(spec: StoreSpec) {
  let graph: SelfGraph;
  let other: SelfGraph;
  const ns = uniqueNs(`ts_${spec.name}`);

  beforeAll(async () => {
    graph = new SelfGraph(spec.make(), { namespace: ns });
    other = new SelfGraph(spec.make(), { namespace: `${ns}_other` });
    await graph.initialize();
  });

  afterAll(async () => {
    await graph?.close();
    await other?.close();
  });

  it("creates, conflicts on, reads, pages, merges updates, and deletes entities", async () => {
    const e = await graph.entities.create("Ada Lovelace", "Person", {
      aliases: ["Ada", "Ada"],
      properties: { born: 1815 },
    });
    expect(e.id).toBe("person:ada-lovelace");
    expect(e.aliases).toEqual(["Ada"]);
    await expect(graph.entities.create("Ada Lovelace", "Person")).rejects.toBeInstanceOf(ConflictError);

    await graph.entities.create("Charles Babbage", "Person");
    await graph.entities.create("Analytical Engine", "Machine");
    const page1 = await graph.entities.list({ type: "Person", limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).toBe("MQ==");
    const page2 = await graph.entities.list({ type: "Person", limit: 1, cursor: page1.next_cursor });
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    await expect(graph.entities.list({ cursor: "garbage" })).rejects.toBeInstanceOf(ValidationError);
    await expect(graph.entities.list({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    const all = [];
    for await (const x of graph.entities.iterate({ type: "Person", limit: 1 })) all.push(x.id);
    expect(all.sort()).toEqual(["person:ada-lovelace", "person:charles-babbage"]);

    const merged = await graph.entities.update(e.id, {
      type: "Mathematician",
      aliases: ["Countess"],
      properties: { died: 1852 },
    });
    expect(merged.type).toBe("Mathematician");
    expect(merged.aliases).toEqual(["Ada", "Countess"]);
    expect(merged.properties).toEqual({ born: 1815, died: 1852 });
    const trimmed = await graph.entities.update(e.id, { remove_aliases: ["Ada"], remove_properties: ["born"] });
    expect(trimmed.aliases).toEqual(["Countess"]);
    expect(trimmed.properties).toEqual({ died: 1852 });
    const unchanged = await graph.entities.update(e.id, { properties: { died: 1852 } });
    expect(unchanged.updated_at.getTime()).toBe(trimmed.updated_at.getTime());
    await expect(graph.entities.update(e.id, { colour: "red" } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(graph.entities.create("x", "Entity")).rejects.toBeInstanceOf(ValidationError);
    await expect(graph.entities.create("x", "Person", { id: "profile:x" })).rejects.toBeInstanceOf(ValidationError);

    const deleted = await graph.entities.delete(e.id);
    expect(deleted).toEqual({ ...NO_DELETES, deleted_entities: 1 });
    expect(Object.keys(deleted)).toEqual(Object.keys(NO_DELETES));
    expect(await graph.entities.get(e.id)).toBeNull();
    await expect(graph.entities.delete(e.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("versions relations, merging properties and skipping no-op updates", async () => {
    await graph.entities.create("Alan Turing", "Person");
    await graph.entities.create("Bletchley Park", "Place");
    const r1 = await graph.relations.create("person:alan-turing", "worked at", "place:bletchley-park", {
      properties: { role: "codebreaker" },
      event_time: "1939-09-04T00:00:00Z",
      evidence: [{ source_id: "bio", quote: "worked at Bletchley" }],
    });
    expect(r1.type).toBe("WORKED_AT");
    expect(r1.evidence[0]).toMatchObject({ source_id: "bio", source_version: "bio:manual", chunk_id: null });
    await expect(
      graph.relations.create("person:alan-turing", "WORKED_AT", "place:bletchley-park"),
    ).rejects.toBeInstanceOf(ConflictError);

    const r2 = await graph.relations.update(r1.id, { set_properties: { hut: 8 } });
    expect(r2.revision).toBe(2);
    expect(r2.properties).toEqual({ role: "codebreaker", hut: 8 });
    const same = await graph.relations.update(r1.id, { set_properties: { hut: 8 } });
    expect(same.revision).toBe(2);
    const r3 = await graph.relations.update(r1.id, { remove_properties: ["role"] });
    expect(r3.properties).toEqual({ hut: 8 });
    await expect(graph.relations.update(r1.id, { bogus: 1 } as never)).rejects.toBeInstanceOf(ValidationError);

    expect((await graph.relations.versions(r1.id)).map((v) => [v.revision, v.is_current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect((await graph.relations.list({ from_entity: "person:alan-turing", type: "worked at" })).items).toHaveLength(
      1,
    );
    expect(await graph.relations.delete(r1.id)).toEqual({ ...NO_DELETES, deleted_relation_versions: 3 });
    expect(await graph.relations.get(r1.id)).toBeNull();
  });

  it("inserts an ontology idempotently, merging on change", async () => {
    const first = await graph.insert.ontology(ONTOLOGY);
    expect(first.entities.map((e) => e.id)).toEqual([
      "person:jane-doe",
      "company:acme",
      "database:hydradb",
      "database:postgres",
    ]);
    expect(first.relations[0]!.type).toBe("WORKS_AT");

    const again = await graph.insert.ontology(ONTOLOGY);
    expect(again.relations.map((r) => r.revision)).toEqual([1, 1]);
    expect(again.preferences.map((p) => p.revision)).toEqual([1, 1]);
    expect(again.entities[0]!.updated_at.getTime()).toBe(first.entities[0]!.updated_at.getTime());

    const changed = await graph.insert.ontology({
      ...ONTOLOGY,
      relations: [{ ...ONTOLOGY.relations[0], properties: { team: "core" } }],
      preferences: [{ ...ONTOLOGY.preferences[0], strength: 0.5 }],
      decisions: [],
    });
    expect(changed.relations[0]!.revision).toBe(2);
    expect(changed.relations[0]!.properties).toEqual({ since: 2020, team: "core" });
    expect(changed.preferences[0]!.revision).toBe(2);

    const pid = ids.preferenceId("person:jane-doe", "preference", "database", "database:hydradb");
    expect((await graph.preferences.versions(pid)).map((p) => [p.revision, p.strength])).toEqual([
      [2, 0.5],
      [1, 0.9],
    ]);
    const updated = await graph.preferences.update(pid, { properties: { why: "history" } });
    expect(updated.revision).toBe(3);
    expect((await graph.preferences.update(pid, { remove_properties: ["why"] })).properties).toEqual({});
    await expect(graph.preferences.update(pid, { strength: 2 })).rejects.toBeInstanceOf(ValidationError);
    expect((await graph.preferences.list("person:jane-doe", { kind: "disinterest" })).items).toHaveLength(1);
    expect((await graph.preferences.list({ key: "database" })).items).toHaveLength(2);
  });

  it("rejects a bad reference before writing anything", async () => {
    await expect(
      graph.insert.ontology({
        entities: [{ type: "Person", name: "Ghost Writer" }],
        relations: [{ from_entity: "person:ghost-writer", type: "KNOWS", to_entity: "person:nobody" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await graph.entities.get("person:ghost-writer")).toBeNull();
    await expect(graph.insert.ontology({ entities: [{ type: "Person", name: "  " }] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      graph.insert.ontology({ entities: [{ type: "Person", name: "Bad\u0000Name" }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("cascades entity and relation deletes into decision traces", async () => {
    const dec = (await graph.decisions.list({ actor_entity: "person:jane-doe" })).items[0]!;
    expect(dec.title).toBe("Pick HydraDB");
    const updated = await graph.decisions.update(dec.id, { status: "active", rationale: null });
    expect(updated.rationale).toBeNull();
    expect(updated.created_at.getTime()).toBe(dec.created_at.getTime());
    const noop = await graph.decisions.update(dec.id, { status: "active" });
    expect(noop.updated_at.getTime()).toBe(updated.updated_at.getTime());
    await expect(graph.decisions.update(dec.id, { status: "bogus" as never })).rejects.toBeInstanceOf(ValidationError);

    const counts = await graph.entities.delete("person:jane-doe");
    expect(counts).toEqual({
      deleted_entities: 1,
      deleted_relation_versions: 2,
      deleted_decisions: 1,
      deleted_preference_versions: 5,
    });
    expect(await graph.decisions.get(dec.id)).toBeNull();

    await graph.entities.create("Bob", "Person");
    const uses = ids.relationId("company:acme", "USES", "database:hydradb");
    const t = await graph.decisions.create("Keep HydraDB", {
      steps: [uses],
      actor_entity: "person:bob",
      alternative_entities: ["database:postgres"],
    });
    await graph.entities.delete("database:postgres");
    expect((await graph.decisions.get(t.id))!.alternative_entities).toEqual([]);
    expect(await graph.relations.delete(uses)).toEqual({
      ...NO_DELETES,
      deleted_relation_versions: 1,
      deleted_decisions: 1,
    });
    expect(await graph.decisions.get(t.id)).toBeNull();
  });

  it("extracts text without an LLM, with idempotent source provenance", async () => {
    const text = "Grace Hopper joined Remington Rand. Grace Hopper wrote COBOL.";
    const res = await graph.insert.text(text, { source_id: "notes", metadata: { author: "test" } });
    expect(res.warnings.map((w) => w.code)).toEqual(["basic_extraction"]);
    const grace = res.entities.find((e) => e.name === "Grace Hopper")!;
    expect(grace.id).toBe("thing:grace-hopper");
    expect(grace.evidence[0]).toMatchObject({ source_id: "notes", source_version: res.source_version, chunk_id: null });

    const again = await graph.insert.text(text, { source_id: "notes" });
    expect(again.source_version).toBe(res.source_version);
    const sv = res.source_version!;
    expect(await graph.store.childNodes(ns, "SourceVersion", sv, "HAS_CHUNK", "Chunk")).toHaveLength(1);
    expect(await graph.store.listEdgeVersions(ns, childEdgeId("HAS_VERSION", sv))).toHaveLength(1);

    const empty = await graph.insert.text("   ");
    expect(empty.warnings.map((w) => w.code)).toEqual(["empty_text"]);
    await expect(graph.insert.text("bad\u0000text")).rejects.toBeInstanceOf(ValidationError);
  });

  it("retrieves context by keyword seeds and traversal", async () => {
    const result = await graph.retrieve("what did Grace Hopper write", { depth: 2 });
    expect(result.seeds[0]!.id).toBe("thing:grace-hopper");
    expect(result.context).toContain("Grace Hopper -[RELATED_TO]-> COBOL");
    expect(result.context).toContain("Grace Hopper joined Remington Rand.");
    expect((await graph.retrieve("Grace Hopper", { strategy: "DFS", depth: 1 })).strategy).toBe("dfs");
    await expect(graph.retrieve("x", { strategy: "random" })).rejects.toBeInstanceOf(ValidationError);
    const ppr = await graph.retrieve("what did Grace Hopper write", { strategy: "ppr", depth: 2, max_nodes: 2 });
    expect(ppr.strategy).toBe("ppr");
    expect(ppr.subgraph.entities.map((e) => e.id)).toHaveLength(2);
    expect(ppr.subgraph.entities[0]!.id).toBe("thing:grace-hopper");
    for (const r of ppr.subgraph.relations) {
      expect(ppr.subgraph.entities.map((e) => e.id)).toEqual(expect.arrayContaining([r.from_entity, r.to_entity]));
    }
    await expect(graph.retrieve("x", { depth: 1.5 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("matches queries across case folding, NFC, and CJK", async () => {
    await graph.entities.create("Hauptstraße", "Place", { properties: { city: "Berlin" } });
    await graph.entities.create("東京タワー", "Place");
    expect((await graph.retrieve("HAUPTSTRASSE", { depth: 0 })).seeds[0]!.id).toBe("place:hauptstraße");
    expect((await graph.retrieve("東京", { depth: 0 })).seeds[0]!.id).toBe("place:東京タワー");
  });

  it("isolates namespaces", async () => {
    await other.entities.create("Grace Hopper", "Thing", { properties: { other: true } });
    expect((await other.entities.get("thing:grace-hopper"))?.properties).toEqual({ other: true });
    expect((await graph.entities.get("thing:grace-hopper"))?.properties).toEqual({});
  });

  it("runs raw Cypher with integer parameters", async () => {
    await expect(graph.runCypher("  ")).rejects.toBeInstanceOf(ValidationError);
    if (spec.name === "kuzu") {
      const res = await graph.runCypher("MATCH (n:N) WHERE n.ns = $ns RETURN count(*) AS n", { ns });
      expect(typeof res.rows[0]!.n).toBe("number");
      return;
    }
    const res = await graph.runCypher("MATCH (n:Entity) WHERE n.ns = $ns RETURN n.id AS id ORDER BY id LIMIT $limit", {
      ns,
      limit: 2,
    });
    expect(res.columns).toEqual(["id"]);
    expect(res.rows).toHaveLength(2);
  });

  it.runIf(spec.transactional)("rolls back a failed transaction", async () => {
    await expect(
      graph.store.transaction(async (tx) => {
        await tx.upsertNode(ns, "Entity", "person:rollback", { id: "person:rollback", ns, name: "x" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await graph.store.nodeExists(ns, "Entity", "person:rollback")).toBe(false);
  });

  it.runIf(spec.transactional)("serializes concurrent versioning of one relation", async () => {
    await graph.entities.create("Racer", "Person");
    await graph.entities.create("Track", "Place");
    const rel = await graph.relations.create("person:racer", "AT", "place:track");
    const writers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => graph.relations.update(rel.id, { set_properties: { lap: i } })),
    );
    expect(new Set(writers.map((w) => w.revision)).size).toBe(6);
    const versions = await graph.relations.versions(rel.id);
    expect(versions).toHaveLength(7);
    expect(versions.filter((v) => v.is_current)).toHaveLength(1);
  });

  it.runIf(spec.name === "hydradb")("survives HydraDB's split Bolt handshake on fresh connections", async () => {
    for (let i = 0; i < 40; i++) {
      const store = spec.make();
      try {
        expect(await store.nodeExists(ns, "Entity", "thing:grace-hopper")).toBe(true);
      } finally {
        await store.close?.();
      }
    }
  });

  it.runIf(spec.name === "hydradb")("rejects a document over HydraDB's 32 KB string limit before writing", async () => {
    await expect(graph.entities.create("Huge", "Thing", { properties: { blob: "x".repeat(40_000) } })).rejects.toThrow(
      /32000 bytes/,
    );
    expect(await graph.entities.get("thing:huge")).toBeNull();
  });
}

for (const spec of specs) {
  const run = live.get(spec.name) ? describe : describe.skip;
  run(`store: ${spec.name}`, () => suite(spec));
}

describe("write retry", () => {
  it("retries a TransientError with backoff, then surfaces contention", async () => {
    const spec = STORE_SPECS.find((s) => s.name === "kuzu")!;
    const inner = spec.make();
    let failures = 2;
    const flaky: GraphStore = Object.assign(Object.create(inner) as GraphStore, {
      transaction: async <T>(fn: (tx: GraphPrimitives) => Promise<T>): Promise<T> => {
        if (failures-- > 0) throw new TransientError("lost race");
        return inner.transaction(fn);
      },
    });
    const graph = new SelfGraph(flaky, { namespace: uniqueNs("retry") });
    try {
      expect((await graph.entities.create("Retry Me", "Thing")).id).toBe("thing:retry-me");
      failures = 100;
      await expect(graph.entities.create("Never", "Thing")).rejects.toThrow(/could not commit after 12 retries/);
    } finally {
      await graph.close();
    }
  }, 60_000);
});

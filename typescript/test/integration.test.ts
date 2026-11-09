import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTokenizer } from "../src/chunking.js";
import { surfaceHint } from "../src/errors.js";
import type { GraphPrimitives, GraphStore, JsonObject, Strategy } from "../src/index.js";
import {
  ConflictError,
  CypherStore,
  FalkorDBStore,
  HydraDBStore,
  ids,
  KuzuStore,
  NotFoundError,
  SelfGraph,
  StoreError,
  TransientError,
  ValidationError,
} from "../src/index.js";
import { childEdgeId, LABELS } from "../src/labels.js";
import { boltError, parseAuth, queryError } from "../src/stores/bolt.js";
import { uniqueLabels } from "../src/stores/cypher.js";
import { kuzuError } from "../src/stores/kuzu.js";
import { forEachStore, freshGraphs, KUZU_SPEC, type StoreSpec, uniqueNs } from "./helpers.js";

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
  const fresh = freshGraphs(spec, "fresh");

  beforeAll(async () => {
    graph = new SelfGraph(spec.make(), { namespace: ns });
    other = new SelfGraph(spec.make(), { namespace: `${ns}_other` });
    await graph.initialize();
  });

  afterAll(async () => {
    await graph?.close();
    await other?.close();
  });

  it("canonicalizes explicit entity ids on every input path", async () => {
    const g = fresh();
    expect((await g.entities.create("X", "T", { id: "T:X" })).id).toBe("t:x");
    await expect(g.entities.create("X", "T", { id: "t:X" })).rejects.toThrow(ConflictError);
    expect((await g.entities.get("T:x"))!.id).toBe("t:x");
    expect((await g.entities.update("T:X", { properties: { k: 1 } })).properties).toEqual({ k: 1 });
    expect((await g.entities.evidence("T:X")).items).toEqual([]);
    expect((await g.entities.merges("T:X")).items).toEqual([]);
    await g.entities.create("Y", "T", { id: "t:y" });
    const rel = await g.relations.create("T:X", "KNOWS", "T:Y");
    expect([rel.from_entity, rel.to_entity]).toEqual(["t:x", "t:y"]);
    expect((await g.relations.list({ from_entity: "T:X" })).items.map((r) => r.id)).toEqual([rel.id]);
    const pref = await g.preferences.create("T:X", "likes", "T:Y", { about_entity: "T:Y" });
    expect([pref.subject_entity, pref.value_entity, pref.about_entity]).toEqual(["t:x", "t:y", "t:y"]);
    expect((await g.preferences.list("T:X")).items.map((p) => p.id)).toEqual([pref.id]);
    const dec = await g.decisions.create("Pick", {
      steps: [rel.id],
      actor_entity: "T:X",
      alternative_entities: ["T:Y"],
    });
    expect([dec.actor_entity, dec.alternative_entities]).toEqual(["t:x", ["t:y"]]);
    expect((await g.decisions.list({ actor_entity: "T:X" })).items.map((d) => d.id)).toEqual([dec.id]);
    const res = await g.insert.ontology({
      entities: [{ id: "Person:Jane Doe", type: "Person", name: "Jane Doe" }],
      relations: [{ from_entity: "PERSON:Jane Doe", type: "KNOWS", to_entity: "T:X" }],
    });
    expect(res.entities.map((e) => e.id)).toEqual(["person:jane-doe"]);
    expect(res.relations.map((r) => [r.from_entity, r.to_entity])).toEqual([["person:jane-doe", "t:x"]]);
    expect((await g.entities.delete("T:X")).deleted_entities).toBe(1);
    expect(await g.entities.get("t:x")).toBeNull();
    const once = { subject_entity: "person:jane-doe", key: "database", value_entity: "database:hydradb" };
    const result = await g.insert.ontology({
      entities: ONTOLOGY.entities,
      preferences: [once, { ...once, strength: 0.5 }, { ...once, strength: 0.7 }],
    });
    expect(result.preferences.map((p) => [p.id, p.strength])).toEqual([
      [ids.preferenceId("person:jane-doe", "preference", "database", "database:hydradb"), 0.7],
    ]);
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
    expect(page1.next_cursor).toBe("cGVyc29uOmFkYS1sb3ZlbGFjZQ==");
    const page2 = await graph.entities.list({ type: "Person", limit: 1, cursor: page1.next_cursor });
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    for (const cursor of ["garbage", "", "AAAA"]) {
      await expect(graph.entities.list({ cursor })).rejects.toThrow(/^invalid cursor /);
      await expect(graph.decisions.list({ cursor })).rejects.toThrow(/^invalid cursor /);
      await expect(graph.entities.evidence(e.id, { cursor })).rejects.toThrow(/^invalid cursor /);
    }
    await expect(graph.relations.list({ cursor: page1.next_cursor })).rejects.toThrow(/^invalid cursor /);
    await expect(graph.entities.list({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    const all = [];
    for await (const x of graph.entities.iterate({ type: "Person", limit: 1 })) all.push(x.id);
    expect(all.sort()).toEqual(["person:ada-lovelace", "person:charles-babbage"]);

    await expect(graph.entities.update(e.id, { type: "Mathematician" })).rejects.toThrow(
      "type is part of the id 'person:ada-lovelace'; create a new entity to change its type",
    );
    const merged = await graph.entities.update(e.id, {
      type: "PERSON",
      aliases: ["Countess"],
      properties: { died: 1852 },
    });
    expect(merged.type).toBe("Person");
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
    expect(r1.source_count).toBe(1);
    expect((await graph.relations.evidence(r1.id)).items[0]).toMatchObject({
      source_id: "bio",
      source_version: "bio:manual",
      chunk_id: null,
    });
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

  it("canonicalizes schema type names and aliases in any case before ids are derived", async () => {
    const schema = {
      entities: [{ name: "Person", aliases: ["Human"] }, { name: "Company" }],
      relations: [{ type: "WORKS_AT", aliases: ["employed by"] }],
    };
    const g = fresh({ schema });
    const res = await g.insert.ontology({
      entities: [
        { type: "human", name: "Ann" },
        { type: "COMPANY", name: "Acme" },
      ],
      relations: [{ from_entity: "human:ann", type: "employed by", to_entity: "company:acme" }],
      decisions: [
        {
          title: "Join",
          actor_entity: "person:ann",
          steps: [ids.relationId("human:ann", "EMPLOYED_BY", "company:acme")],
        },
      ],
    });
    expect(res.entities.map((e) => [e.id, e.type])).toEqual([
      ["person:ann", "Person"],
      ["company:acme", "Company"],
    ]);
    expect(res.relations.map((r) => [r.id, r.type])).toEqual([
      [ids.relationId("person:ann", "WORKS_AT", "company:acme"), "WORKS_AT"],
    ]);
    expect(res.decisions[0]!.actor_entity).toBe("person:ann");
    expect(res.warnings).toEqual([]);
    expect((await g.entities.create("Bea", "Human")).id).toBe("person:bea");
    expect((await g.relations.create("person:bea", "employed by", "company:acme")).type).toBe("WORKS_AT");
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

  it("unlinks what a decision clears or a deleted about_entity, and null keeps a field", async () => {
    const g = fresh();
    for (const [name, type] of [
      ["Ann", "Person"],
      ["Acme", "Company"],
      ["Beta", "Company"],
      ["X", "Team"],
      ["Y", "Team"],
      ["Soham", "Person"],
      ["HydraDB", "Company"],
      ["Graphs", "Topic"],
      ["A", "Person"],
      ["B", "Person"],
    ] as const) {
      await g.entities.create(name, type);
    }
    const rel = await g.relations.create("team:x", "SELECTED", "team:y");
    const dec = await g.decisions.create("Pick a vendor", {
      steps: [rel.id],
      actor_entity: "person:ann",
      outcome_entity: "company:acme",
      alternative_entities: ["company:beta"],
    });
    const out = await g.decisions.update(dec.id, {
      clear: ["actor_entity", "outcome_entity", "alternative_entities", "steps"],
    });
    expect([out.actor_entity, out.outcome_entity, out.alternative_entities, out.steps]).toEqual([null, null, [], []]);
    expect((await g.decisions.list({ actor_entity: "person:ann" })).items).toEqual([]);
    for (const id of ["person:ann", "company:acme", "company:beta", "team:x"]) {
      expect((await g.entities.delete(id)).deleted_decisions).toBe(0);
    }
    expect(await g.decisions.get(dec.id)).not.toBeNull();

    const pref = await g.preferences.create("person:soham", "database", "company:hydradb", {
      about_entity: "topic:graphs",
      strength: 0.4,
    });
    expect((await g.entities.delete("topic:graphs")).deleted_preference_versions).toBe(0);
    const current = (await g.preferences.get(pref.id))!;
    expect(current.about_entity).toBeNull();
    expect(current.revision).toBe(2);
    expect(current.strength).toBe(0.4);
    expect(await g.preferences.update(pref.id, { strength: null, properties: {} })).toMatchObject({
      strength: 0.4,
      revision: 2,
    });
    await expect(g.preferences.update(pref.id, { strength: null })).rejects.toThrow(/nothing to update/);
    const dated = await g.relations.create("person:a", "KNOWS", "person:b", { event_time: "2025-01-02T00:00:00Z" });
    const kept = await g.relations.update(dated.id, { event_time: null, set_properties: {} });
    expect(kept.event_time).toEqual(dated.event_time);
    expect(kept.revision).toBe(dated.revision);
    await expect(g.relations.update(dated.id, { event_time: null })).rejects.toThrow(/nothing to update/);
  });

  it("fails every call after close with StoreError, even from a second graph on the store", async () => {
    const g = fresh();
    await g.entities.create("Before", "Thing");
    await g.close();
    await g.close();
    for (const call of [() => g.entities.get("thing:before"), () => g.entities.create("After", "Thing")]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreError);
      expect(err).not.toBeInstanceOf(TransientError);
      expect((err as Error).message).toMatch(/closed/);
    }
    await expect(g.initialize()).rejects.toBeInstanceOf(StoreError);
    const again = new SelfGraph(g.store, { namespace: uniqueNs("closed") });
    for (const call of [() => again.initialize(), () => again.entities.list()]) {
      await expect(call()).rejects.toThrow(/^this store is closed; create a new store for each SelfGraph$/);
    }
  });

  it.runIf(spec.name === "memgraph" || spec.name === "neo4j")(
    "reports a Cypher syntax error as StoreError, not TransientError",
    async () => {
      const err = await graph.runCypher("RETURN").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreError);
      expect(err).not.toBeInstanceOf(TransientError);
    },
  );

  it("extracts text without an LLM, with idempotent source provenance", async () => {
    const text = "Grace Hopper joined Remington Rand. Grace Hopper wrote COBOL.";
    const res = await graph.insert.text(text, { source_id: "notes", metadata: { author: "test" } });
    expect(res.warnings.map((w) => w.code)).toEqual(["basic_extraction"]);
    const grace = res.entities.find((e) => e.name === "Grace Hopper")!;
    expect(grace.id).toBe("thing:grace-hopper");
    expect(grace.source_count).toBe(1);
    expect((await graph.entities.evidence(grace.id)).items[0]).toMatchObject({
      source_id: "notes",
      source_version: res.source_version,
      chunk_id: null,
    });

    const again = await graph.insert.text(text, { source_id: "notes" });
    expect(again.source_version).toBe(res.source_version);
    const sv = res.source_version!;
    expect(await graph.store.childNodes(ns, "SourceVersion", sv, "HAS_CHUNK", "Chunk")).toHaveLength(1);
    expect(await graph.store.listEdgeVersions(ns, childEdgeId("HAS_VERSION", sv))).toHaveLength(1);

    await expect(graph.insert.text("   ")).rejects.toThrow("text cannot be empty or whitespace");
    await expect(graph.insert.text("bad\u0000text")).rejects.toBeInstanceOf(ValidationError);
  });

  it("retrieves context by keyword seeds and traversal", async () => {
    const result = await graph.retrieve("what did Grace Hopper write", { depth: 2 });
    expect(result.seeds[0]!.id).toBe("thing:grace-hopper");
    expect(result.context).toContain("Grace Hopper -[RELATED_TO]-> COBOL");
    expect(result.context).toContain("Grace Hopper joined Remington Rand.");
    expect((await graph.retrieve("Grace Hopper", { strategy: "DFS" as Strategy, depth: 1 })).strategy).toBe("dfs");
    await expect(graph.retrieve("x", { strategy: "random" as Strategy })).rejects.toBeInstanceOf(ValidationError);
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

  it("warns on schema violations but still writes, and rejects them in strict mode", async () => {
    const schema = {
      entities: [{ name: "Person", properties: [{ name: "age", type: "integer" as const, required: true }] }],
      relations: [{ type: "KNOWS", from: { types: ["Person"] }, to: { types: ["Person"] } }],
    };
    const ontology = {
      entities: [{ id: "person:schemaguy", type: "Person", name: "Schema Guy" }],
      relations: [{ from_entity: "person:schemaguy", type: "LIKES", to_entity: "person:schemaguy" }],
    };
    const warned = await graph.insert.ontology(ontology, { schema });
    expect(warned.warnings.map((w) => w.code)).toEqual(["missing_required_property", "unknown_relation_type"]);
    expect(await graph.entities.get("person:schemaguy")).not.toBeNull();

    await expect(graph.insert.ontology(ontology, { schema, schema_mode: "strict" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const quiet = await graph.insert.ontology(ontology, { schema, schema_mode: "off" });
    expect(quiet.warnings).toEqual([]);
  });

  for (const kind of ["entities", "relations", "preferences", "decisions"] as const) {
    it(`iterates ${kind} past deletes between pages`, async () => {
      const g = fresh();
      const letters = [..."abcdefg"];
      await g.insert.ontology({
        entities: [...letters.map((c) => ({ type: "T", name: c.toUpperCase() })), { type: "Hub", name: "Hub" }],
      });
      for (const c of letters) {
        if (kind === "relations") await g.relations.create("hub:hub", "LINKS", `t:${c}`);
        if (kind === "preferences") await g.preferences.create("hub:hub", `k${c}`, `t:${c}`);
        if (kind === "decisions") await g.decisions.create(`Decide ${c}`);
      }
      const resource = g[kind] as unknown as {
        iterate(options: { limit: number }): AsyncGenerator<{ id: string }>;
        delete(id: string): Promise<unknown>;
        list(): Promise<{ items: Array<{ id: string }> }>;
      };
      const seen: string[] = [];
      for await (const item of resource.iterate({ limit: 2 })) {
        seen.push(item.id);
        if (kind !== "entities" || item.id.startsWith("t:")) await resource.delete(item.id);
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(kind === "entities" ? 8 : 7);
      expect((await resource.list()).items.map((i) => i.id)).toEqual(kind === "entities" ? ["hub:hub"] : []);
    });
  }

  it.runIf(spec.name === "hydradb")("rejects a document over HydraDB's 32 KB string limit before writing", async () => {
    await expect(graph.entities.create("Huge", "Thing", { properties: { blob: "x".repeat(40_000) } })).rejects.toThrow(
      /32000 bytes/,
    );
    expect(await graph.entities.get("thing:huge")).toBeNull();
  });
}

await forEachStore("store", suite);

describe("write retry", () => {
  it("retries a TransientError with backoff, then surfaces contention", async () => {
    const inner = KUZU_SPEC.make();
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

describe("store setup errors", () => {
  const err = (code: string, message: string) => Object.assign(new Error(message), { code });

  it("maps Bolt login, missing-database, and unreachable errors to plain messages", () => {
    const auth = err("Neo.ClientError.Security.Unauthorized", "{neo4j_code: ...} invalid credentials");
    expect(boltError(auth, "bolt://h:1", "default")?.message).toBe(
      "authentication failed for bolt://h:1: check the token/password",
    );
    const missing = err("Neo.ClientError.Statement.InvalidSyntax", "unknown graph database nosuch");
    expect(boltError(missing, "bolt://h:1", "nosuch")?.message).toBe("database 'nosuch' not found");
    const down = err("ServiceUnavailable", "Failed to connect to server");
    expect(boltError(down, "bolt://h:1", null)?.message).toMatch(/^could not connect to bolt:\/\/h:1: /);
    expect(boltError(err("Neo.ClientError.Statement.SyntaxError", "bad"), "bolt://h:1", null)).toBeNull();
  });

  it("validates addresses, trims syntax errors, and names a missing HydraDB token or another engine", async () => {
    expect(() => SelfGraph.connect({ store: "falkordb", uri: "nonsense:abc" })).toThrow(
      new ValidationError("invalid FalkorDB address 'nonsense:abc': expected host:port with a port from 1 to 65535"),
    );
    expect(() => new HydraDBStore("http://127.0.0.1:1")).toThrow(/is not a Bolt URI; use bolt:\/\/host:port$/);
    const tokens = Array.from({ length: 80 }, (_, i) => `'T${i}'`).join(", ");
    const syntax = err(
      "Memgraph.ClientError.MemgraphError.MemgraphError",
      `parsing error is mismatched {${tokens}}\nmore`,
    );
    const message = queryError(syntax, "bolt://h:1", null, "Cypher", () => false).message;
    expect(message.startsWith("Cypher query failed: parsing error is mismatched")).toBe(true);
    expect(message.length).toBe("Cypher query failed: ".length + 120);
    const mapped = (store: HydraDBStore, exc: unknown) =>
      (store as unknown as { error(exc: unknown): StoreError }).error(exc).message;
    const unauthorized = err("Neo.ClientError.Security.Unauthorized", "invalid credentials");
    const anonymous = new HydraDBStore("bolt://127.0.0.1:1");
    const authed = new HydraDBStore("bolt://127.0.0.1:1", { auth: ["neo4j", "bad"] });
    try {
      const noToken = mapped(anonymous, unauthorized);
      expect(noToken).toBe(
        "HydraDB needs a token: pass auth: TOKEN in the HydraDBStore options (or set SELFGRAPH_AUTH)",
      );
      expect(surfaceHint(noToken)).toBe("HydraDB needs a token: pass --auth TOKEN (or SELFGRAPH_AUTH)");
      for (const auth of [123, ["a"], ["a", 1]]) {
        expect(() => new HydraDBStore("bolt://127.0.0.1:1", { auth } as never)).toThrow(
          "auth must be 'user:password', a bare token, or a [user, password] pair",
        );
      }
      expect(parseAuth("tok")).toEqual(["neo4j", "tok"]);
      expect(parseAuth("u:tok")).toEqual(["u", "tok"]);
      await new HydraDBStore("bolt://127.0.0.1:1", { auth: "tok" }).close();
      expect(mapped(authed, unauthorized)).toMatch(/^authentication failed for bolt:\/\/127\.0\.0\.1:1/);
      const missing = err(
        "Memgraph.ClientError.MemgraphError.MemgraphError",
        'Tried to retrieve an unknown database "default".',
      );
      expect(mapped(anonymous, missing)).toBe(
        'database \'default\' not found; if this is Neo4j or Memgraph, pass store: "neo4j" (or store: "memgraph")',
      );
      const own = err(
        "Neo.ClientError.Statement.InvalidSyntax",
        "ClientProtocol query is not supported yet: unknown graph database foo",
      );
      expect(mapped(anonymous, own)).toBe("database 'default' not found");
    } finally {
      await anonymous.close();
      await authed.close();
    }
  });

  it("skips Bolt constraint DDL when the constraints exist or the check keeps conflicting", async () => {
    const memgraphRows = async (query: string) => {
      if (query === "SHOW CONSTRAINTS") {
        throw new StoreError("Cypher query failed", {
          cause: Object.assign(new Error("parsing error at SHOW"), { code: "x" }),
        });
      }
      const rows = LABELS.map((label) => ({ "constraint type": "unique", label, properties: ["ns", "id"] }));
      return { columns: [], rows, counters: {} };
    };
    const busy = async () => {
      throw new TransientError("Cannot get read-only access to the storage");
    };
    const store = new CypherStore("bolt://127.0.0.1:1");
    try {
      for (const fake of [memgraphRows, busy]) {
        Object.assign(store, {
          _run: fake,
          session: () => {
            throw new Error("constraint DDL ran");
          },
        });
        await store.initialize();
      }
    } finally {
      await store.close();
    }
    const neo4jRows = LABELS.map((label) => ({ type: "UNIQUENESS", labelsOrTypes: [label], properties: ["id", "ns"] }));
    expect(uniqueLabels(neo4jRows)).toEqual(new Set(LABELS));
    expect(uniqueLabels(neo4jRows.slice(1))).toEqual(new Set(LABELS.slice(1)));
  });

  it("checks store options, expands ~ in a Kuzu path, and explains lock and mmap failures", async () => {
    for (const size of [-1, 0, 1.5]) {
      expect(() => new KuzuStore("x.kuzu", { max_db_size: size })).toThrow(
        `max_db_size must be a positive integer of bytes, got ${size}`,
      );
    }
    expect(() => new FalkorDBStore("localhost", 6379, { readonly: true } as never)).toThrow(
      "unknown option 'readonly' for FalkorDBStore",
    );
    const home = mkdtempSync(join(tmpdir(), "selfgraph-home-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const store = new KuzuStore("~/sub/x.kuzu");
      await store.initialize();
      await store.close();
      expect(existsSync(join(home, "sub", "x.kuzu"))).toBe(true);
    } finally {
      process.env.HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
    expect(kuzuError(new Error("IO exception: Could not set lock on file : /x"), "open").message).toMatch(
      /Kuzu allows one process at a time$/,
    );
    expect(kuzuError(new Error("Buffer manager exception: Mmap for size 1 failed."), "q").message).toMatch(
      /pass a smaller max_db_size$/,
    );
  });
});

describe("property values", () => {
  const open = freshGraphs(KUZU_SPEC, "props");

  it("clears null property keys, rejects unsafe values and blank keys, and trims aliases", async () => {
    const g = open();
    let e = await g.entities.create("Ann", "Person", { properties: { m: 1, gone: null } });
    expect(e.properties).toEqual({ m: 1 });
    e = await g.entities.update(e.id, { properties: { m: null, n: 2 } });
    expect(e.properties).toEqual({ n: 2 });
    await g.entities.create("Acme", "Company");
    let rel = await g.relations.create(e.id, "WORKS_AT", "company:acme", { properties: { a: 1, b: null } });
    expect(rel.properties).toEqual({ a: 1 });
    rel = await g.relations.update(rel.id, { set_properties: { a: null, c: 3 } });
    expect(rel.properties).toEqual({ c: 3 });
    const pref = await g.preferences.create(e.id, "employer", "company:acme", { properties: { x: 1, y: null } });
    expect(pref.properties).toEqual({ x: 1 });
    expect((await g.preferences.update(pref.id, { properties: { x: null } })).properties).toEqual({});

    await expect(g.entities.create("Bob", "Person", { properties: { n: 9007199254740993n } } as never)).rejects.toThrow(
      "properties integer 9007199254740993 is outside the safe range; store it as a string",
    );
    await expect(g.entities.update(e.id, { properties: { at: new Date() } } as never)).rejects.toThrow(
      "properties cannot hold Date values; use an ISO 8601 string",
    );
    await expect(
      g.insert.text("Ann met Bob.", { source_id: "s", metadata: { n: -(2n ** 60n) } as never }),
    ).rejects.toThrow(/outside the safe range/);
    for (const bad of [{ "": 1 }, { "  ": 2 }] as JsonObject[]) {
      await expect(g.entities.create("A", "T", { properties: bad })).rejects.toThrow(
        "properties keys cannot be empty or whitespace",
      );
    }
    await expect(
      g.insert.ontology({
        relations: [{ from_entity: e.id, type: "R", to_entity: "company:acme", properties: { " ": 1 } }],
      }),
    ).rejects.toThrow("properties keys cannot be empty");
    await expect(g.relations.update(rel.id, { set_properties: { "": 1 } })).rejects.toThrow(
      "set_properties keys cannot be empty",
    );
    await expect(g.insert.text("A met B.", { source_id: "s", metadata: { " ": "x" } })).rejects.toThrow(
      "metadata keys cannot be empty",
    );

    const jane = await g.entities.create("Jane Doe", "Person", {
      aliases: ["jane doe", " JANE DOE ", "JD", " Other", "Other ", "Annié ", "  "],
    });
    expect(jane.aliases).toEqual(["JD", "Other", "Annié"]);
    const renamed = await g.entities.update(jane.id, { aliases: ["Jane Doe", " Janie "], remove_aliases: [" Other "] });
    expect(renamed.aliases).toEqual(["JD", "Annié", "Janie"]);
    expect((await g.entities.update(jane.id, { name: "JD" })).aliases).toEqual(["Annié", "Janie"]);
  });

  it("checks entity types and ids, and keeps the stored type on a case-only update", async () => {
    const g = open();
    await expect(g.entities.create("X", "Person", { id: "company:x" })).rejects.toThrow(
      "id 'company:x' does not match type 'Person' (expected prefix 'person:')",
    );
    await expect(g.insert.ontology({ entities: [{ id: "company:zzz", type: "Person", name: "Z" }] })).rejects.toThrow(
      "id 'company:zzz' does not match type 'Person'",
    );
    expect((await g.entities.create("X", "Big Co", { id: "Big Co:x" })).id).toBe("big-co:x");
    await expect(g.entities.create("A", "Per:son")).rejects.toThrow("entity type 'Per:son' cannot contain ':'");
    await expect(g.insert.ontology({ entities: [{ type: "Per:son", name: "A" }] })).rejects.toThrow(
      "cannot contain ':'",
    );
    await expect(g.entities.create("X", "bad type!")).rejects.toThrow(/can only contain letters, digits, spaces/);
    expect((await g.entities.create("Zoë", "Café Owner_v2.1-b")).type).toBe("Café Owner_v2.1-b");
    const calls = [
      (eid: string) => g.entities.get(eid),
      (eid: string) => g.entities.delete(eid),
      (eid: string) => g.entities.evidence(eid),
      (eid: string) => g.entities.merges(eid),
      (eid: string) => g.entities.update(eid, { name: "X" }),
    ];
    for (const call of calls) {
      await expect(call("nocolon")).rejects.toThrow(
        /^entity id must be 'type:name', e\.g\. 'person:jane', got 'nocolon'$/,
      );
    }
    for (const bad of ["jane", "person:", "person: ", ":x"]) {
      expect(() => ids.canonicalEntityId(bad)).toThrow(/entity id must/);
    }

    const s = open({ schema: { entities: [{ name: "Company", aliases: ["org"] }] } });
    expect((await s.entities.create("Acme", "org", { id: "company:acme" })).type).toBe("Company");
    expect((await s.entities.create("Beta", "Company", { id: "ORG:Beta" })).id).toBe("company:beta");
    const result = await s.insert.ontology({
      entities: [
        { id: "org:acme", type: "org", name: "Acme" },
        { id: "org:gamma", type: "Company", name: "Gamma" },
      ],
      relations: [{ from_entity: "org:gamma", type: "OWNS", to_entity: "org:acme" }],
    });
    expect(result.entities.map((e) => e.id).sort()).toEqual(["company:acme", "company:gamma"]);
    expect([result.relations[0]?.from_entity, result.relations[0]?.to_entity]).toEqual([
      "company:gamma",
      "company:acme",
    ]);
    await expect(s.insert.ontology({ entities: [{ id: "person:acme", type: "org", name: "Acme" }] })).rejects.toThrow(
      "(expected prefix 'company:')",
    );
    await expect(s.entities.create("Acme", "org", { id: "person:acme" })).rejects.toThrow(
      "(expected prefix 'company:')",
    );

    await g.entities.create("Ann", "Person");
    expect((await g.entities.update("person:ann", { type: "person" })).type).toBe("Person");
    expect((await g.entities.update("person:ann", { type: " PERSON " })).type).toBe("Person");
    await expect(g.entities.update("person:ann", { type: "Company" })).rejects.toThrow("type is part of the id");
    await g.entities.create("Bob", "person");
    const withSchema = new SelfGraph(g.store, { namespace: g.namespace, schema: { entities: [{ name: "Person" }] } });
    expect((await withSchema.entities.update("person:bob", { type: "PERSON" })).type).toBe("Person");
  });

  it("cuts context to any budget, keeps one line at a tiny one, and rejects an empty query", async () => {
    const g = open();
    await g.insert.ontology({
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
      ],
    });
    await g.insert.text("Ann works at Acme in Paris as a senior engineer.", { source_id: "note" });
    const { countTokens } = await loadTokenizer();
    const full = (await g.retrieve("Ann Acme")).context;
    let previous = "";
    for (const budget of [1, 2, 3]) {
      const { context } = await g.retrieve("Ann Acme", { budget_tokens: budget });
      expect(context).not.toBe("");
      expect(countTokens(context)).toBeLessThanOrEqual(budget);
      expect(full.startsWith(context) && context.startsWith(previous)).toBe(true);
      previous = context;
    }
    for (const query of ["", "   "]) await expect(g.retrieve(query)).rejects.toThrow(/^query cannot be empty$/);

    const h = open();
    await h.entities.create("A", "Person", { id: "person:a" });
    await h.entities.create("Bob Builder", "Person", { id: "person:bob" });
    await h.relations.create("person:a", "KNOWS", "person:bob", {
      properties: { since: "a long time ago".repeat(20) },
    });
    const tiny = await h.retrieve("Bob Builder", { budget_tokens: 1 });
    expect(tiny.subgraph.entities.length).toBeGreaterThan(0);
    expect(tiny.context.split("\n")).toHaveLength(1);
    expect((await h.retrieve("A")).seeds.map((s) => s.id)).toEqual(["person:a"]);
  });

  it("rejects empty updates, bad list filters, and missing endpoints, and clears named fields", async () => {
    const g = open();
    await g.insert.ontology({
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
        { type: "Company", name: "Neo" },
      ],
    });
    const rel = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    const pref = await g.preferences.create("person:ann", "employer", "company:acme", {
      about_entity: "company:neo",
      strength: 0.9,
    });
    const dec = await g.decisions.create("Join", {
      steps: [rel.id],
      actor_entity: "person:ann",
      summary: "s",
      rationale: "r",
    });
    await expect(g.entities.update("person:ann", {})).rejects.toThrow(/nothing to update/);
    await expect(g.relations.update(rel.id)).rejects.toThrow(/nothing to update/);
    await expect(g.preferences.update(pref.id)).rejects.toThrow(/nothing to update/);
    await expect(g.decisions.update(dec.id, {})).rejects.toThrow(/nothing to update/);
    expect((await g.relations.update(rel.id, { remove_properties: ["x"] })).revision).toBe(1);
    await expect(g.decisions.list({ status: "zzz" as never })).rejects.toThrow(ValidationError);
    await expect(g.preferences.list({ kind: "zzz" as never })).rejects.toThrow(ValidationError);
    const link = (from_entity: string, to_entity: string) =>
      g.insert.ontology({ relations: [{ from_entity, type: "R", to_entity }] });
    await expect(link("person:ann", "t:zz")).rejects.toThrow(/^relation endpoint not found \(to='t:zz'\);/);
    await expect(link("t:y", "t:zz")).rejects.toThrow(/^relation endpoints not found \(from='t:y', to='t:zz'\);/);
    await expect(g.relations.create("t:y", "R", "person:ann")).rejects.toThrow(
      /^relation endpoint not found \(from='t:y'\);/,
    );

    const cleared = await g.preferences.update(pref.id, {
      clear: ["strength", "about_entity"],
      event_time: "2024-01-02",
    });
    expect([cleared.strength, cleared.about_entity, cleared.revision]).toEqual([null, null, 2]);
    expect(cleared.event_time?.toISOString()).toBe("2024-01-02T00:00:00.000Z");
    await expect(g.preferences.update(pref.id, { clear: ["key"] })).rejects.toThrow(/cannot clear 'key'/);
    await expect(g.preferences.update(pref.id, { strength: 0.5, clear: ["strength"] })).rejects.toThrow(
      /cannot both set and clear 'strength'/,
    );
    const out = await g.decisions.update(dec.id, {
      clear: ["summary"],
      rationale: null,
      event_time: "2024-03-01T00:00:00Z",
    });
    expect([out.summary, out.rationale, out.title]).toEqual([null, null, "Join"]);
    await expect(g.decisions.update(dec.id, { clear: ["title"] })).rejects.toThrow(/cannot clear 'title'/);
    await expect(g.decisions.update(dec.id, { summary: "x", clear: ["summary"] })).rejects.toThrow(
      /cannot both set and clear 'summary'/,
    );
  });

  it("scores every entity past five thousand when seeding retrieval", async () => {
    const g = open();
    const fillers = Array.from({ length: 5100 }, (_, i) => ({
      type: "Filler",
      name: `filler ${String(i).padStart(5, "0")} common`,
    }));
    await g.insert.ontology({ entities: [...fillers, { type: "Tool", name: "Zebracorn common" }] });
    expect((await g.retrieve("zebracorn", { k: 3 })).seeds.map((s) => s.id)).toEqual(["tool:zebracorn-common"]);
    expect((await g.retrieve("filler 05099", { k: 1 })).seeds[0]!.id).toBe("filler:filler-05099-common");
  }, 120_000);

  it("passes the insert metadata to a custom extractor", async () => {
    const seen: unknown[] = [];
    const g = open({
      extractor: {
        extract: async (document) => {
          seen.push([document.media_type, document.metadata]);
          return { entities: [], relations: [] };
        },
      },
    });
    await g.insert.text("hello", { metadata: { lang: "en" }, event_time: "2024-05-01T00:00:00Z" });
    expect(seen).toEqual([["text/plain", { lang: "en" }]]);
  });

  it("filters entity types ignoring case and through schema aliases", async () => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Bob", "PERSON");
    await g.entities.create("Cy", "human");
    await g.entities.create("Acme", "Company");
    const listed = async (graph: SelfGraph, type: string) =>
      (await graph.entities.list({ type })).items.map((e) => e.id);
    expect(await listed(g, "person")).toEqual(["person:ann", "person:bob"]);
    const first = await g.entities.list({ type: "pErSoN", limit: 1 });
    expect(first.items.map((e) => e.id)).toEqual(["person:ann"]);
    const second = await g.entities.list({ type: "pErSoN", limit: 1, cursor: first.next_cursor });
    expect(second.items.map((e) => e.id)).toEqual(["person:bob"]);
    expect((await g.entities.list({ type: "Person", name: "ann" })).items).toEqual([]);
    const schema = { entities: [{ name: "Person", aliases: ["Human"] }, { name: "Company" }] };
    const s = open({ namespace: g.namespace, schema });
    for (const given of ["person", "HUMAN"])
      expect(await listed(s, given)).toEqual(["human:cy", "person:ann", "person:bob"]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import { buildLlmClient, ExtractionError, KuzuStore, SelfGraph } from "../src/index.js";

type Kind = "entities" | "relations" | "preferences" | "decisions";

const REPLIES: Record<Kind, unknown> = {
  entities: {
    entities: [
      { type: "Person", name: "Soham", aliases: ["S."] },
      { type: "Database", name: "HydraDB", aliases: null },
      { type: "Team", name: "Platform Team", aliases: [] },
      { type: "Quantity", name: "3 nodes", aliases: [] },
    ],
  },
  relations: {
    relations: [
      { from_name: "Soham", type: "member of", to_name: "Platform Team", event_time: "2025-01-02" },
      { from_name: "Platform Team", type: "CHOSE", to_name: "HydraDB", event_time: "not a date" },
      { from_name: "Soham", type: "USES", to_name: "Neo4j", event_time: null },
    ],
  },
  preferences: {
    preferences: [
      {
        subject_name: "Soham",
        kind: "preference",
        key: "database",
        value_name: "HydraDB",
        about_name: null,
        strength: 0.8,
      },
    ],
  },
  decisions: {
    decisions: [
      {
        title: "Adopt HydraDB",
        actor_name: "Platform Team",
        summary: null,
        rationale: "temporal history",
        outcome_name: "HydraDB",
        alternative_names: ["Neo4j"],
        status: "completed",
        steps: [{ from_name: "Platform Team", type: "CHOSE", to_name: "HydraDB" }],
      },
    ],
  },
};

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function kindOf(options: { responseFormat?: { schema?: unknown } }): Kind {
  const schema = JSON.stringify(options.responseFormat?.schema ?? {});
  return (["entities", "relations", "preferences", "decisions"] as const).find((k) => schema.includes(`"${k}"`))!;
}

function textOf(options: { prompt: Array<{ role: string; content: unknown }> }, role: string): string {
  const msg = options.prompt.find((m) => m.role === role);
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return (msg.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
}

function reply(json: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof json === "string" ? json : JSON.stringify(json) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: USAGE,
    warnings: [],
  };
}

const dir = mkdtempSync(join(tmpdir(), "selfgraph-llm-"));
const graphs: SelfGraph[] = [];

function graphWith(model: unknown, ns: string): SelfGraph {
  const g = new SelfGraph(new KuzuStore(join(dir, "g.kuzu")), { llm: model as object, namespace: ns });
  graphs.push(g);
  return g;
}

afterAll(async () => {
  for (const g of graphs) await g.close();
  await KuzuStore.closeDatabase(join(dir, "g.kuzu"));
  rmSync(dir, { recursive: true, force: true });
});

describe("LLM extraction through the AI SDK", () => {
  it("extracts and resolves names to deterministic ids the way Python does", async () => {
    const seen: Array<{ kind: Kind; system: string; user: string }> = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const kind = kindOf(options as never);
        seen.push({ kind, system: textOf(options as never, "system"), user: textOf(options as never, "user") });
        return reply(REPLIES[kind]) as never;
      },
    });
    const text = "Soham on the Platform Team chose HydraDB over Neo4j for temporal history.";
    const res = await graphWith(model, "llm_ok").insert.text(text, { source_id: "chat" });

    expect(seen.map((s) => s.kind)).toEqual(["entities", "relations", "preferences", "decisions"]);
    expect(seen[0]!.system.startsWith("You extract entities for a knowledge graph.")).toBe(true);
    expect(seen[0]!.user).toBe(`Extract every entity from the text below.\n\n\nText:\n"""\n${text}\n"""`);

    expect(res.entities.map((e) => e.id)).toEqual([
      "person:soham",
      "database:hydradb",
      "team:platform-team",
      "quantity:3-nodes",
      "thing:neo4j",
    ]);
    expect(res.entities[0]!.aliases).toEqual(["S."]);
    expect(res.relations.map((r) => [r.type, r.event_time?.toISOString() ?? null])).toEqual([
      ["MEMBER_OF", "2025-01-02T00:00:00.000Z"],
      ["CHOSE", null],
      ["USES", null],
    ]);
    expect(res.preferences[0]).toMatchObject({
      subject_entity: "person:soham",
      value_entity: "database:hydradb",
      strength: 0.8,
    });
    expect(res.decisions[0]).toMatchObject({
      id: "decision:13497e2ba2c6ede055d4b2fc",
      outcome_entity: "database:hydradb",
      alternative_entities: ["thing:neo4j"],
    });
    expect(res.decisions[0]!.steps[0]!.relation_id).toBe("relation:6c3390fa7879ec144c96a8d8");
    expect(res.warnings).toEqual([]);
  });

  it("re-asks when a reply does not match the schema", async () => {
    let entityCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const kind = kindOf(options as never);
        if (kind === "entities" && entityCalls++ === 0) return reply({ entities: [{ nope: true }] }) as never;
        return reply(kind === "entities" ? REPLIES.entities : { [kind]: [] }) as never;
      },
    });
    const res = await graphWith(model, "llm_retry").insert.text("Soham likes HydraDB.");
    expect(entityCalls).toBe(2);
    expect(res.entities.map((e) => e.id)).toContain("person:soham");
  });

  it("keeps going on partial failure and reports a warning", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const kind = kindOf(options as never);
        if (kind === "preferences") throw new Error("rate limited");
        return reply(REPLIES[kind]) as never;
      },
    });
    const res = await graphWith(model, "llm_partial").insert.text("Soham chose HydraDB.");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]!.code).toBe("extraction_partial_failure");
    expect(res.warnings[0]!.message).toContain("preferences extraction failed on chunk 0");
    expect(res.relations.map((r) => r.type)).toEqual(["MEMBER_OF", "CHOSE", "USES"]);
  });

  it("drops an invalid extracted item with a warning and keeps the rest", async () => {
    const extra: Partial<Record<Kind, unknown>> = {
      relations: {
        relations: [
          ...(REPLIES.relations as { relations: unknown[] }).relations,
          { from_name: "Soham", type: "", to_name: "HydraDB", event_time: null },
          { from_name: "Soham", type: "prefers", to_name: "HydraDB", event_time: null },
        ],
      },
      preferences: {
        preferences: [
          ...(REPLIES.preferences as { preferences: unknown[] }).preferences,
          {
            subject_name: "Soham",
            kind: "preference",
            key: "editor",
            value_name: "HydraDB",
            about_name: null,
            strength: 2,
          },
        ],
      },
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const kind = kindOf(options as never);
        return reply(extra[kind] ?? REPLIES[kind]) as never;
      },
    });
    const res = await graphWith(model, "llm_drop").insert.text("Soham chose HydraDB.");
    expect(res.relations.map((r) => r.type)).toEqual(["MEMBER_OF", "CHOSE", "USES"]);
    expect(res.preferences.map((p) => p.key)).toEqual(["database"]);
    expect(res.decisions).toHaveLength(1);
    const dropped = res.warnings.filter((w) => w.code === "extraction_partial_failure").map((w) => w.message);
    expect(dropped).toHaveLength(3);
    expect(dropped.some((m) => m.includes("preference strength"))).toBe(true);
    expect(dropped.some((m) => m.includes("reserved"))).toBe(true);
  });

  it("never re-substitutes placeholders that appear in the document text", async () => {
    const { render } = await import("../src/extraction/prompts.js");
    const slotted = { system: "s", user: "{instructions}|{text}", version: "v1" };
    expect(render(slotted, "doc {instructions} {text}", "be brief {text}")[1]).toBe(
      "be brief {text}|doc {instructions} {text}",
    );
    const appended = { system: "s", user: "T:{text}", version: "v2" };
    expect(render(appended, "doc {instructions}", "extra")[1]).toBe(
      "T:doc {instructions}\n\nAdditional instructions:\nextra",
    );
  });

  it("raises ExtractionError when every call fails", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("down");
      },
    });
    await expect(graphWith(model, "llm_fail").insert.text("Soham chose HydraDB.")).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });

  it("fails clearly for an unknown provider without a base_url", async () => {
    const client = buildLlmClient({ provider: "nope", model: "x" });
    await expect(
      client.generate({ system: "", user: "hi", output: (await import("zod")).z.object({}) }),
    ).rejects.toBeInstanceOf(ExtractionError);
  });
});

import { expect, it } from "vitest";

import { HINTS } from "../src/errors.js";
import { entityId, normalizeRelType } from "../src/ids.js";
import { fromTables, KuzuStore, SelfGraph, ValidationError } from "../src/index.js";
import { parseOrThrow } from "../src/models.js";
import { Schema } from "../src/schema.js";
import { tempKuzu } from "./helpers.js";

it("306 rejects schema relation types that normalize to empty", async () => {
  await using graph = new SelfGraph(new KuzuStore(tempKuzu("schema-306-"), { buffer_pool_size: 128 << 20 }));
  await graph.initialize();
  expect((await graph.entities.list()).items).toEqual([]);
  for (const value of ["!!!", "___", " - / ", "💥"]) {
    let normalized: ValidationError | undefined;
    try {
      normalizeRelType(value);
    } catch (err) {
      normalized = err as ValidationError;
    }
    expect(normalized).toBeInstanceOf(ValidationError);
    expect(() => parseOrThrow(Schema, { relations: [{ type: value }] }, "schema")).toThrowError(
      expect.objectContaining({
        message: normalized!.message,
        code: "invalid_argument",
        field: "relations[0].type",
        hint: HINTS.invalid_argument,
      }),
    );
  }
  expect(parseOrThrow(Schema, { relations: [{ type: "works at" }] }, "schema").relations[0]!.type).toBe("works at");
});

it("309 distinguishes schema-qualified table names", async () => {
  const schema = fromTables([
    { name: "sales.users", columns: [{ name: "support_id", references: "support.users" }] },
    { name: "support.users", columns: [{ name: "sales_id", references: "sales.users" }] },
    { name: "sales.orders", columns: [{ name: "user_id", references: "sales.users" }] },
  ]);
  expect(schema.entities.map((entity) => entity.name)).toEqual(["SalesUser", "SupportUser", "Order"]);
  expect(schema.entities.map((entity) => entity.mappings[0]!.table)).toEqual([
    "sales.users",
    "support.users",
    "sales.orders",
  ]);
  expect(schema.relations.map((rel) => [rel.from.types, rel.to.types])).toEqual([
    [["SalesUser"], ["SupportUser"]],
    [["SupportUser"], ["SalesUser"]],
    [["Order"], ["SalesUser"]],
  ]);
  await using graph = new SelfGraph(new KuzuStore(tempKuzu("schema-309-"), { buffer_pool_size: 128 << 20 }), {
    schema,
    schema_mode: "strict",
  });
  const result = await graph.insert.facts({
    entities: schema.entities.slice(0, 2).map((entity) => ({ type: entity.name, name: "Ann" })),
    relations: [
      { from_entity: entityId("SalesUser", "Ann"), type: "HAS_SUPPORT", to_entity: entityId("SupportUser", "Ann") },
    ],
  });
  expect(result.warnings).toEqual([]);
  expect((await graph.entities.list()).items).toHaveLength(2);
  expect((await graph.relations.list()).items).toHaveLength(1);
});

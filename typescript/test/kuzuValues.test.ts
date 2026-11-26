import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KuzuStore, StoreError } from "../src/index.js";
import { tempKuzu } from "./helpers.js";

const DECIMAL_38 = "0.12345678901234567890123456789012345678";
const UNREADABLE = "Kuzu cannot return a negative DECIMAL between -0.1 and 0";

const VALUES: Array<[string, unknown]> = [
  ["RETURN 123 AS v", 123],
  ["RETURN cast('170141183460469231731687303715884105727' AS INT128) AS v", "170141183460469231731687303715884105727"],
  ["RETURN cast('1.50' AS DECIMAL(5,2)) AS v", 1.5],
  ["RETURN date('2024-01-02') AS v", "2024-01-02"],
  ["RETURN timestamp('2024-01-01 12:34:56.789') AS v", "2024-01-01T12:34:56.789000Z"],
  ["RETURN cast('2024-01-01 12:34:56+05:30' AS TIMESTAMP_TZ) AS v", "2024-01-01T07:04:56Z"],
  ["RETURN interval('1 year 2 months 3 days 4 hours') AS v", "P423DT4H"],
  ["RETURN interval('1 day') AS v", "P1D"],
  ["RETURN interval('1500 milliseconds') AS v", "PT1.5S"],
  ["RETURN timestamp('2024-01-01') - timestamp('2024-01-02 00:00:01.5') AS v", "-P1DT1.5S"],
  ["RETURN union_value(a := 1) AS v", 1],
  ["RETURN [[date('2024-01-02')], []] AS v", [["2024-01-02"], []]],
  [
    "RETURN {a: 1, b: interval('1 day'), c: union_value(x := 's'), d: cast('1.50' AS DECIMAL(5,2))} AS v",
    { a: 1, b: "P1D", c: "s", d: 1.5 },
  ],
  ["RETURN {`x, y`: date('2024-01-01'), `a b`: 1} AS v", { "x, y": "2024-01-01", "a b": 1 }],
  ["RETURN map([date('2024-01-02')], [interval('1 day')]) AS v", { "2024-01-02": "P1D" }],
  ["RETURN {`a, b`: 1, b: 2} AS v", { "a, b": 1, b: 2 }],
  ["RETURN {`f(`: 1, g: date('2024-01-02')} AS v", { "f(": 1, g: "2024-01-02" }],
  ["RETURN union_value(a := NULL) AS v", null],
  ["RETURN to_json({a: 1}) AS v", '{"a":1}'],
  ["RETURN map([cast('1.50' AS DECIMAL(5,2))], [1]) AS v", { "1.50": 1 }],
];

const BEYOND = "beyond 2^53";
const WIDER = "wider than a double holds";
const ROUNDED: Array<[string, string, string]> = [
  ["RETURN 9007199254740992 AS v", "INT64", BEYOND],
  ["RETURN 9007199254740993 AS v", "INT64", BEYOND],
  ["RETURN -9223372036854775808 AS v", "INT64", BEYOND],
  ["RETURN cast(18446744073709551615 AS UINT64) AS v", "UINT64", BEYOND],
  ["RETURN cast('123456789012345678.5' AS DECIMAL(38,1)) AS v", "DECIMAL(38, 1)", WIDER],
  ["RETURN cast('99999999999999999999999999999999999999' AS DECIMAL(38,0)) AS v", "DECIMAL(38, 0)", WIDER],
  ["RETURN cast('1.50' AS DECIMAL(38,20)) AS v", "DECIMAL(38, 20)", WIDER],
  [`RETURN cast('${DECIMAL_38}' AS DECIMAL(38,38)) AS v`, "DECIMAL(38, 38)", WIDER],
  ["RETURN [1, 9007199254740993] AS v", "INT64", BEYOND],
  ["RETURN union_value(a := 9007199254740993) AS v", "INT64", BEYOND],
];

describe("kuzu run_cypher values", () => {
  const path = tempKuzu("selfgraph-ts-values-");
  const store = new KuzuStore(path);

  beforeAll(() => store.initialize());
  afterAll(() => store.close());

  it.each(VALUES)("returns %s as %j", async (query, value) => {
    expect((await store.runCypher(query)).rows).toEqual([{ v: value }]);
  });

  it.each(ROUNDED)("refuses %s because the driver rounded it", async (query, type, reason) => {
    const error = await store.runCypher(query).catch((exc: unknown) => exc);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe("inexact_value");
    expect((error as StoreError).message).toBe(
      `run_cypher column 'v' (${type}) holds a value ${reason}, which the Kuzu Node driver rounds`,
    );
  });

  it.each([
    "RETURN cast('-0.05' AS DECIMAL(5,2)) AS v",
    "RETURN cast('-0.001' AS DECIMAL(5,3)) AS v",
    "RETURN [cast('-0.05' AS DECIMAL(5,2))] AS v",
    "RETURN {a: cast('-0.05' AS DECIMAL(5,2))} AS v",
    "RETURN map([cast('-0.05' AS DECIMAL(5,2))], [1]) AS v",
  ])("refuses %s because Kuzu cannot return it", async (query) => {
    const error = await store.runCypher(query).catch((exc: unknown) => exc);
    expect((error as StoreError).code).toBe("inexact_value");
    expect((error as StoreError).message).toBe(UNREADABLE);
  });

  it("keeps a column named __proto__ as a column", async () => {
    const rows = (await store.runCypher("RETURN {a: 1} AS __proto__")).rows;
    expect(Object.keys(rows[0]!)).toEqual(["__proto__"]);
  });
});

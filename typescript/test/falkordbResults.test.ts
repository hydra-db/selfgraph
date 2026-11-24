import { expect, it } from "vitest";
import { forEachStore, freshGraphs } from "./helpers.js";

await forEachStore("Cypher results", (spec) => {
  const fresh = freshGraphs(spec, "cypher_results");

  it.skipIf(spec.name === "kuzu" || spec.name === "hydradb")("decodes path properties", async () => {
    const g = fresh();
    const ns = g.namespace;
    await g.runCypher(
      "CREATE (a:PathTest {ns:$ns, id:'1', _lock:1})-[:REL {w:2, _lock:1}]->(b:PathTest {ns:$ns, id:'2'})",
      { ns },
    );
    const path = {
      nodes: [
        { ns, id: "1" },
        { ns, id: "2" },
      ],
      relationships: [{ w: 2 }],
    };
    const query = "MATCH p=(a:PathTest {ns:$ns})-[:REL]->(b:PathTest) RETURN p, [p] AS nested";
    expect((await g.runCypher(query, { ns })).rows).toEqual([{ p: path, nested: [path] }]);
    const zero = "MATCH p=(a:PathTest {ns:$ns, id:'1'})-[*0..0]->(b) RETURN p";
    expect((await g.runCypher(zero, { ns })).rows).toEqual([{ p: { nodes: [path.nodes[0]], relationships: [] } }]);
  });

  it.runIf(spec.name === "falkordb")("normalizes non-finite Cypher numbers", async () => {
    const g = fresh();
    const result = await g.runCypher(
      "RETURN 1.0/0.0 AS positive, -1.0/0.0 AS negative, 0.0/0.0 AS nan, " +
        "{values: [1.0/0.0, 0.0/0.0, 2.5]} AS nested",
    );
    expect(result.rows).toEqual([{ positive: null, negative: null, nan: null, nested: { values: [null, null, 2.5] } }]);
    expect(JSON.parse(JSON.stringify(result.rows))).toEqual(result.rows);
  });
});

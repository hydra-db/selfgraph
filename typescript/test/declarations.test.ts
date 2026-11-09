import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const OPTIONAL_PEERS = Object.entries(pkg.peerDependenciesMeta ?? {})
  .filter(([, meta]) => meta.optional)
  .map(([name]) => name);
const declarations = existsSync(DIST) ? readdirSync(DIST).filter((f) => /\.d\.c?ts$/.test(f)) : [];

/**
 * The module specifiers a declaration file imports, from import/export-from clauses and import() types.
 *
 * @param text (string): the declaration file text.
 * @return (string[]): the specifiers.
 */
function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push((m[1] ?? m[2])!);
  }
  return out;
}

describe("built declarations", () => {
  it.skipIf(!declarations.length)("reference no optional peer dependency", () => {
    expect(OPTIONAL_PEERS).toContain("falkordb");
    const offenders: string[] = [];
    for (const file of declarations) {
      for (const spec of specifiers(readFileSync(join(DIST, file), "utf8"))) {
        if (OPTIONAL_PEERS.some((peer) => spec === peer || spec.startsWith(`${peer}/`))) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

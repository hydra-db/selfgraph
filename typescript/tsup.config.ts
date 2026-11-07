import { defineConfig } from "tsup";

const shared = {
  target: "node20",
  sourcemap: true,
  splitting: true,
  shims: true,
  noExternal: ["@commander-js/extra-typings", "@noble/hashes", "@unicode/unicode-15.0.0"],
} as const;

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts", mcp: "src/mcp.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
  },
  {
    ...shared,
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);

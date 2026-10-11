import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

const MANIFEST = resolve(__dirname, "package.json");

/**
 * `src/version.ts` imports the package manifest for its `version`. Inlined whole, the bundle would carry the
 * scripts and devDependencies too, and a dev-only dependency bump (which Dependabot makes without rebuilding
 * anything) would turn the committed bundle stale. This serves that one file as `{ version }`.
 */
export const manifestVersionOnly: Plugin = {
  name: "manifest-version-only",
  setup: (b) =>
    b.onLoad({ filter: /package\.json$/ }, (args) =>
      args.path === MANIFEST
        ? { contents: `export default ${JSON.stringify({ version: (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version: string }).version })};`, loader: "js" }
        : undefined,
    ),
};

// One self-contained file so the Claude Code plugin cache — which copies source and runs no
// install — can run the CLI with a bare `node`. Dependencies are inlined on purpose.
export default defineConfig({
  entry: { treasury: "src/cli.ts" },
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
  clean: false,
  splitting: false,
  sourcemap: false,
  minify: false,
  esbuildPlugins: [manifestVersionOnly],
});

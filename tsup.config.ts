import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const MANIFEST = resolve(__dirname, "package.json");

/**
 * `src/version.ts` imports package.json for its version. Bundled as is, the whole manifest would be inlined,
 * and every edit to it (a dev-dependency bump) would change dist/treasury.mjs. Only the version goes in.
 */
const versionOnly = {
  name: "package-json-version-only",
  setup(b: { onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => { contents: string; loader: "json" } | undefined) => void }) {
    b.onLoad({ filter: /package\.json$/ }, ({ path }) => {
      if (resolve(path) !== MANIFEST) return undefined;
      const { version } = JSON.parse(readFileSync(path, "utf8")) as { version: string };
      return { contents: JSON.stringify({ version }), loader: "json" };
    });
  },
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
  esbuildPlugins: [versionOnly],
});

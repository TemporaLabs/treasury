// Builds the two shipped files from src/: the MCP server and the Google/email sign-in page.
import { build } from "esbuild";

const common = { bundle: true, minify: false, legalComments: "none", logLevel: "info" };

await build({
  ...common,
  entryPoints: ["src/connect-server.ts"],
  outfile: "dist/connect-server.mjs",
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" },
});

await build({
  ...common,
  entryPoints: ["src/privy-page/main.tsx"],
  outfile: "dist/privy-page.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});

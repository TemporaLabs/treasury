import { defineConfig } from "tsup";

// One self-contained file so the Claude Code plugin cache — which copies source and runs no
// install — can start the MCP server with a bare `node`. Dependencies are inlined on purpose.
export default defineConfig({
  entry: { "mcp-server": "src/mcp/server.ts" },
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
});

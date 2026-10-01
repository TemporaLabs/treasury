import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Redirects an exact import specifier to a local file, via esbuild's plugin API rather than its
 * `alias` option — `alias` did not reliably apply to a package SUBPATH specifier
 * ("unstorage/drivers/fs-lite") in this bundle even though the exact same mechanism worked for the
 * bare package name ("unstorage", "cross-fetch"); this is unambiguous and debuggable (an
 * `onResolve` filter that never matches is a visible no-op, not a silent partial substitution).
 *
 * `fromImporter`, when given, additionally requires the importing file's path to END with that
 * string — needed for a RELATIVE specifier (e.g. qrcode's own `require("./renderer/png")"), which
 * resolves differently depending on which file requires it and would otherwise be ambiguous.
 */
function redirectImport(specifier: string, toFile: string, fromImporter?: string) {
  return {
    name: `redirect-${specifier}`,
    setup(build: import("esbuild").PluginBuild) {
      build.onResolve({ filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }, (args) => {
        if (fromImporter && !args.importer.endsWith(fromImporter)) return undefined;
        return { path: resolve(here, toFile) };
      });
    },
  };
}

// One self-contained file so the Claude Code plugin cache — which copies source and runs no
// install — can start the MCP server with a bare `node`. Dependencies are inlined on purpose.
export default defineConfig({
  entry: { "mcp-server": "src/mcp/server.ts", "connect-server": "src/mcp/connect-server.ts" },
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  // cross-fetch's Node entry always pulls in node-fetch -> whatwg-url -> a runtime
  // `require("punycode")`, which esbuild's CJS-interop shim (the bundle format is ESM) cannot
  // satisfy once bundled. Node 18+ ships native fetch/Headers/Request/Response and this package
  // targets Node 22, so cross-fetch is redirected to a small shim over those globals.
  // @walletconnect/keyvaluestorage's Node backend lazily `require`s "unstorage" and
  // "unstorage/drivers/fs-lite" for its default storage. wallet-session.ts never uses that default
  // (it always passes its own plain-file `storage:`), so the path is dead at runtime, but esbuild
  // still resolves and bundles it and hits the same CJS-interop limit. Both specifiers are
  // redirected to stubs that throw if ever reached. A plugin is used rather than `alias`, which
  // does not reliably apply to the "unstorage/drivers/fs-lite" subpath.
  // qrcode/lib/server.js unconditionally `require("./renderer/png")`, though wallet-session.ts only
  // renders the "terminal" type. That renderer's own `require("fs")` hits the same limit, so it is
  // stubbed too, scoped to qrcode's own server.js as the importer because "./renderer/png" is a
  // relative specifier and redirecting it everywhere would be too broad.
  esbuildPlugins: [
    redirectImport("cross-fetch", "./cross-fetch-shim.mjs"),
    redirectImport("unstorage", "./unstorage-shim.mjs"),
    redirectImport("unstorage/drivers/fs-lite", "./unstorage-fs-lite-shim.mjs"),
    redirectImport("./renderer/png", "./qrcode-png-renderer-shim.mjs", "qrcode/lib/server.js"),
  ],
  banner: { js: "#!/usr/bin/env node" },
  clean: false,
  splitting: false,
  sourcemap: false,
  minify: false,
});

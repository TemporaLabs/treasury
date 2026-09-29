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
  // cross-fetch's Node entry (node-ponyfill.js) always pulls in node-fetch -> whatwg-url -> a
  // runtime `require("punycode")`, which esbuild's CJS-interop shim (the bundle format is ESM)
  // cannot satisfy once bundled ("Dynamic require of \"punycode\" is not supported"). Node 18+
  // ships a native fetch/Headers/Request/Response, and this package targets Node 22, so the whole
  // legacy chain is unnecessary: alias cross-fetch straight to a two-line local shim over the
  // globals, in the exact shape cross-fetch's own ponyfill exports.
  // @walletconnect/keyvaluestorage's Node backend lazily `require`s "unstorage" and
  // "unstorage/drivers/fs-lite" for its own default storage. wallet-session.ts never uses that
  // default — it always passes its own `storage:` (a plain-file IKeyValueStorage) — so this path
  // is dead at runtime, but esbuild's bundler still statically resolves and bundles it, and
  // unstorage's own dynamic driver loading hits the same CJS-interop limitation as cross-fetch's
  // chain above (measured: "Dynamic require of \"fs\" is not supported"). Redirected to throwing
  // stubs: harmless if genuinely unreachable, loud if it turns out not to be. Via a plugin, not
  // `alias` — `alias` redirected the bare "unstorage" specifier but not the "unstorage/drivers/
  // fs-lite" subpath one, silently, in this exact bundle; a plugin's onResolve is explicit either way.
  // qrcode/lib/server.js unconditionally `require("./renderer/png")` at module load, even though
  // wallet-session.ts only ever renders the "terminal" type. The PNG renderer's own
  // `require("fs")` (for writing image files) hits the same limitation — measured directly, from
  // inside renderQr(), once a real WalletConnect pairing actually succeeded for the first time
  // (nothing before this had a real WALLETCONNECT_PROJECT_ID, so nothing had ever reached this
  // code path in this repo's history). Scoped to qrcode's own server.js as the importer, since
  // "./renderer/png" is a relative specifier — redirecting it unconditionally would be too broad.
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

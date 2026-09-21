// Bundles entry.jsx and Privy's SDK into ../vendor/privy-provider.js, one self-contained ES module the
// opener serves from its own origin. Run from this directory after `npm ci`.
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "vendor", "privy-provider.js");
mkdirSync(dirname(out), { recursive: true });

await build({
  entryPoints: [join(here, "entry.jsx")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  // Everything the SDK needs must be inside the file: the page's policy allows no other script source.
  loader: { ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
  logLevel: "warning",
});
console.log(`wrote ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);

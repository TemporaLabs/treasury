/**
 * The package version, read from package.json — never a literal. The declared version follows the
 * branch (v0.0.N ⇒ 0.0.N), and CI holds a version branch to that; anything that
 * reports a version reads it from here so a branch bump cannot leave a stale "0.1.0" behind
 * (a literal in server.ts once lagged package.json by two releases).
 *
 * Same resolution trick as registry.ts: this file sits at src/ top level and the bundle at dist/
 * top level, so `../package.json` is the package manifest at the repository root from both.
 * Resolved from this file's REAL path: under `--preserve-symlinks-main`, `import.meta.url` is the
 * path of a symlink to the bundle (npm's `.bin/treasury-mcp`), and `../package.json` from there is a
 * file in whatever directory holds the link.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_JSON_URL = new URL("../package.json", pathToFileURL(realpathSync(fileURLToPath(import.meta.url))));

export const PACKAGE_VERSION: string = (JSON.parse(readFileSync(fileURLToPath(PACKAGE_JSON_URL), "utf8")) as { version: string }).version;

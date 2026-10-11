/**
 * The package version, from package.json — never a literal. The declared version follows the
 * branch (v0.0.N ⇒ 0.0.N), and CI holds a version branch to that; anything that
 * reports a version reads it from here so a branch bump cannot leave a stale "0.1.0" behind
 * (a literal in server.ts once lagged package.json by two releases).
 *
 * Imported, so it is inlined into the CLI bundle at build time: the bundle reports the version it was
 * built from, whatever file sits beside it. `scripts/check-versions.sh` ties the manifests to it.
 */
import pkg from "../package.json" with { type: "json" };

export const PACKAGE_VERSION: string = pkg.version;

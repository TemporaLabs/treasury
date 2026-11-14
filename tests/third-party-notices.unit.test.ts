/**
 * `scripts/third-party-notices.ts`: a bundled package's licence, and its NOTICE file when it ships one, are carried into
 * THIRD_PARTY_NOTICES.md. Offline; each test builds a package directory in a temporary folder.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPackage, renderNotices } from "../scripts/third-party-notices.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "treasury-notices-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/lib", version: "1.2.3", license: "Apache-2.0" }));
  writeFileSync(join(dir, "LICENSE"), "Apache License\nVersion 2.0\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("third-party notices", () => {
  it("carries a package's NOTICE file after its licence", () => {
    writeFileSync(join(dir, "NOTICE"), "Example library\nCopyright 2026 Example\n");
    const pkg = readPackage(dir);
    expect(pkg.noticeText).toBe("Example library\nCopyright 2026 Example");
    const out = renderNotices([pkg]);
    const licence = out.indexOf("Apache License\nVersion 2.0");
    const notice = out.indexOf("Its NOTICE file:\n\n```text\nExample library\nCopyright 2026 Example\n```");
    expect(licence).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(licence);
  });

  it("reads a NOTICE named with an extension, in any case", () => {
    writeFileSync(join(dir, "notice.txt"), "lower-case notice");
    expect(readPackage(dir).noticeText).toBe("lower-case notice");
  });

  it("adds nothing for a package with no NOTICE file", () => {
    const pkg = readPackage(dir);
    expect(pkg.noticeText).toBeUndefined();
    expect(renderNotices([pkg])).not.toContain("NOTICE file:");
  });
});

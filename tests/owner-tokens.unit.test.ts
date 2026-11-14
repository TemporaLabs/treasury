/**
 * `src/connect/owner-tokens.ts`: the owner-token file. Offline; each test gets its own temporary directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearOwnerToken,
  clearOwnerTokens,
  ownerTokensPath,
  readOwnerToken,
  TOKEN_EXPIRY_MARGIN_MS,
  writeOwnerToken,
  type TokenKey,
} from "../src/connect/owner-tokens.js";
import { sessionPath } from "../src/connect/session.js";
import { buildConnectCommands } from "../src/connect/commands.js";

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const HOUR = 3_600_000;
const KEY: TokenKey = { host: "api.staging.example", clientId: "treasury-cli", owner: "0x52908400098527886E0F7030069857D2E4169EE7", audience: "http" };
const later = (ms: number) => new Date(NOW + ms).toISOString();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "treasury-tokens-"));
  process.env["TREASURY_CONNECT_HOME"] = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env["TREASURY_CONNECT_HOME"];
});

describe("the owner-token file", () => {
  it("keeps a token readable only by its owner, in its own file beside the session file", () => {
    writeOwnerToken(KEY, { token: "tok-1", expiresAtIso: later(HOUR) }, NOW);
    expect(readOwnerToken(KEY, NOW)).toBe("tok-1");
    expect(ownerTokensPath()).toBe(join(home, "owner-tokens.json"));
    expect(ownerTokensPath()).not.toBe(sessionPath());
    expect(statSync(ownerTokensPath()).mode & 0o777).toBe(0o600);
    // No temporary file is left behind by the write.
    expect(readdirSync(home)).toEqual(["owner-tokens.json"]);
  });

  it("reads a token back only under the same host, client, owner and door", () => {
    writeOwnerToken(KEY, { token: "tok-1", expiresAtIso: later(HOUR) }, NOW);
    expect(readOwnerToken({ ...KEY, owner: KEY.owner.toLowerCase() }, NOW)).toBe("tok-1");
    expect(readOwnerToken({ ...KEY, host: "api.temporalabs.com" }, NOW)).toBeUndefined();
    expect(readOwnerToken({ ...KEY, clientId: "acme" }, NOW)).toBeUndefined();
    expect(readOwnerToken({ ...KEY, owner: "0x0000000000000000000000000000000000000001" }, NOW)).toBeUndefined();
    expect(readOwnerToken({ ...KEY, audience: "mcp" }, NOW)).toBeUndefined();
  });

  it("treats a token as gone once it is within the margin of its expiry", () => {
    writeOwnerToken(KEY, { token: "tok-1", expiresAtIso: later(TOKEN_EXPIRY_MARGIN_MS + 1) }, NOW);
    expect(readOwnerToken(KEY, NOW)).toBe("tok-1");
    expect(readOwnerToken(KEY, NOW + 1)).toBeUndefined();
  });

  it("drops expired tokens when it writes, and keeps live ones under other keys", () => {
    const other: TokenKey = { ...KEY, owner: "0x0000000000000000000000000000000000000001" };
    writeOwnerToken(other, { token: "old", expiresAtIso: later(HOUR) }, NOW);
    writeOwnerToken({ ...KEY, audience: "mcp" }, { token: "live", expiresAtIso: later(3 * HOUR) }, NOW);
    writeOwnerToken(KEY, { token: "tok-2", expiresAtIso: later(3 * HOUR) }, NOW + 2 * HOUR);
    const kept = Object.values(JSON.parse(readFileSync(ownerTokensPath(), "utf8")) as Record<string, { token: string }>).map((t) => t.token);
    expect(kept.sort()).toEqual(["live", "tok-2"]);
  });

  it("forgets one token, or all of them", () => {
    writeOwnerToken(KEY, { token: "tok-1", expiresAtIso: later(HOUR) }, NOW);
    writeOwnerToken({ ...KEY, audience: "mcp" }, { token: "tok-m", expiresAtIso: later(HOUR) }, NOW);
    clearOwnerToken(KEY);
    expect(readOwnerToken(KEY, NOW)).toBeUndefined();
    expect(readOwnerToken({ ...KEY, audience: "mcp" }, NOW)).toBe("tok-m");
    clearOwnerTokens();
    expect(readOwnerToken({ ...KEY, audience: "mcp" }, NOW)).toBeUndefined();
  });

  it("reads a file that is not the file it writes as holding no token", () => {
    for (const body of ["not json", "[]", "null", JSON.stringify({ x: { token: "", expiresAtIso: later(HOUR) } }), JSON.stringify({ x: { token: "t", expiresAtIso: "soon" } })]) {
      writeFileSync(ownerTokensPath(), body);
      expect(readOwnerToken(KEY, NOW)).toBeUndefined();
    }
  });

  it("leaves no copy of the tokens behind when the write fails", () => {
    // A directory where the file should be: the rename into place fails.
    mkdirSync(join(ownerTokensPath(), "x"), { recursive: true });
    expect(() => writeOwnerToken(KEY, { token: "tok-1", expiresAtIso: later(HOUR) }, NOW)).toThrow();
    expect(readdirSync(home)).toEqual(["owner-tokens.json"]);
    expect(readdirSync(ownerTokensPath())).toEqual(["x"]);
  });
});

describe("treasury connect disconnect", () => {
  it("forgets the owner tokens too, and says so", async () => {
    writeOwnerToken(KEY, { token: "tok-1", expiresAtIso: later(HOUR) }, NOW);
    const out = JSON.parse(await buildConnectCommands()["connect_disconnect"]!.handler({} as never)) as { hadOwnerTokens: boolean };
    expect(out.hadOwnerTokens).toBe(true);
    expect(existsSync(ownerTokensPath())).toBe(false);
    const again = JSON.parse(await buildConnectCommands()["connect_disconnect"]!.handler({} as never)) as { hadOwnerTokens: boolean };
    expect(again.hadOwnerTokens).toBe(false);
  });
});

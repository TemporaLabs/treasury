/**
 * The owner tokens `invest` signs in for, kept between commands in a small file readable only by its owner
 * (`~/.config/treasury/owner-tokens.json`, mode 0600, beside the session file; `TREASURY_CONNECT_HOME` moves both).
 *
 * This file, unlike the session file, holds a credential: a token the API issued after the owner signed its
 * sign-in message. A token can read the owner's account and start or cancel requests; it cannot move money,
 * because every transfer and every withdrawal authorization is still signed by the owner's own wallet. It
 * expires on its own, and `invest` signs in again when the API refuses it.
 *
 * Two commands writing at once each read the file and write it back whole, so the later write can drop the
 * earlier one's token. That costs one more sign-in, never a wrong token.
 *
 * Each token is kept under everything it is bound to: the API host it was issued by, the client it was issued
 * to, the owner, and the doors it is good on. A token is only ever read back under the same key, so a token for
 * one owner, host or door is never sent for another.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { connectDir } from "./session.js";

/** What one token is bound to. */
export interface TokenKey {
  /** The API host that issued it, such as `api.temporalabs.com`. */
  host: string;
  /** The client it was issued to: `treasury-cli` for a sign-in with no client key. */
  clientId: string;
  /** The owner's address. Compared without regard to letter case. */
  owner: string;
  /** The doors it is good on, as asked for at sign-in. */
  audience: "http" | "mcp" | "both";
}

export interface StoredToken {
  token: string;
  expiresAtIso: string;
}

/** How long before its expiry a token is treated as expired, so a call never starts on one about to lapse. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export const ownerTokensPath = () => join(connectDir(), "owner-tokens.json");

const keyOf = (k: TokenKey) => [k.host.toLowerCase(), k.clientId, k.owner.toLowerCase(), k.audience].join("|");

function readAll(): Record<string, StoredToken> {
  let raw: string;
  try {
    raw = readFileSync(ownerTokensPath(), "utf8");
  } catch {
    return {};
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, StoredToken> = {};
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
      const t = e as Partial<StoredToken> | null;
      if (t && typeof t.token === "string" && t.token.length > 0 && typeof t.expiresAtIso === "string" && Number.isFinite(Date.parse(t.expiresAtIso))) {
        out[k] = { token: t.token, expiresAtIso: t.expiresAtIso };
      }
    }
    return out;
  } catch {
    // A file that does not parse holds no token, never a guessed one.
    return {};
  }
}

function writeAll(all: Record<string, StoredToken>): void {
  mkdirSync(connectDir(), { recursive: true, mode: 0o700 });
  const path = ownerTokensPath();
  // Written aside and renamed into place, so a reader never sees half a file.
  const aside = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(aside, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    chmodSync(aside, 0o600);
    renameSync(aside, path);
  } catch (e) {
    // The aside file holds the tokens too: never leave a copy behind when the write fails.
    rmSync(aside, { force: true });
    throw e;
  }
}

/** The token kept for this key, unless it has expired or is within the margin of expiring. */
export function readOwnerToken(key: TokenKey, now: number = Date.now()): string | undefined {
  const t = readAll()[keyOf(key)];
  if (!t) return undefined;
  return Date.parse(t.expiresAtIso) - TOKEN_EXPIRY_MARGIN_MS > now ? t.token : undefined;
}

/** Keeps a token for this key, replacing any before it. Tokens already expired are dropped while writing. */
export function writeOwnerToken(key: TokenKey, t: StoredToken, now: number = Date.now()): void {
  const all = readAll();
  for (const [k, e] of Object.entries(all)) if (Date.parse(e.expiresAtIso) <= now) delete all[k];
  all[keyOf(key)] = { token: t.token, expiresAtIso: t.expiresAtIso };
  writeAll(all);
}

/** Forgets the token for this key: the API refused it, or the owner signed out. */
export function clearOwnerToken(key: TokenKey): void {
  const all = readAll();
  if (!(keyOf(key) in all)) return;
  delete all[keyOf(key)];
  writeAll(all);
}

/**
 * Forgets every token, and says whether there was any file to forget. `connect disconnect` calls it, and so does
 * `connect wallet` when it connects a different account.
 */
export function clearOwnerTokens(): boolean {
  const had = existsSync(ownerTokensPath());
  rmSync(ownerTokensPath(), { force: true });
  return had;
}

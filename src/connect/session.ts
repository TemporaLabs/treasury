/**
 * The connected account, remembered between commands in a small file readable only by its owner
 * (`~/.config/treasury/connect-session.json`, mode 0600; `TREASURY_CONNECT_HOME` moves it).
 *
 * It holds no credential: an address, how it signed in, and when. Being "connected" grants nothing
 * by itself — every transaction is still confirmed by the operator in the browser and in their
 * wallet — it only fixes WHICH account the confirm page will accept and pay.
 */
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import { isAddress as isSolanaAddress } from "@solana/kit";
import type { PendingAck, PendingPlan } from "./ack.js";
import { connectHome } from "./config.js";

export interface Session {
  account: string;
  /** `external`: a browser wallet the operator controls. `embedded`: a Privy wallet opened by email or a social login. */
  walletType: "external" | "embedded";
  connectedAtIso: string;
}

const dir = () => connectHome() ?? join(homedir(), ".config", "treasury");
export const sessionPath = () => join(dir(), "connect-session.json");

export function readSession(): Session | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionPath(), "utf8");
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as Partial<Session>;
    if (typeof v.account !== "string" || !isAddress(v.account)) return undefined;
    if (v.walletType !== "external" && v.walletType !== "embedded") return undefined;
    return { account: getAddress(v.account), walletType: v.walletType, connectedAtIso: String(v.connectedAtIso ?? "") };
  } catch {
    // A file that does not parse is no session, never a guessed one.
    return undefined;
  }
}

function writeOwnerOnly(path: string, value: unknown): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; an existing file keeps its own.
  chmodSync(path, 0o600);
}

export function writeSession(s: Session): void {
  writeOwnerOnly(sessionPath(), s);
  // A new connection voids any acknowledgement, or plan, given for the one before it.
  clearPendingAck();
  clearPlan();
}

export function clearSession(): boolean {
  const had = readSession() !== undefined;
  rmSync(sessionPath(), { force: true });
  clearPendingAck();
  clearPlan();
  return had;
}

/**
 * The connected SOLANA account, kept apart from the EVM one: an operator can be connected on both at once,
 * with different wallets, and a command for a vault on one chain family reads only that family's session.
 */
export const solanaSessionPath = () => join(dir(), "connect-session-solana.json");

export function readSolanaSession(): Session | undefined {
  try {
    const v = JSON.parse(readFileSync(solanaSessionPath(), "utf8")) as Partial<Session>;
    if (typeof v.account !== "string" || !isSolanaAddress(v.account)) return undefined;
    if (v.walletType !== "external" && v.walletType !== "embedded") return undefined;
    return { account: v.account, walletType: v.walletType, connectedAtIso: String(v.connectedAtIso ?? "") };
  } catch {
    return undefined;
  }
}

export function writeSolanaSession(s: Session): void {
  writeOwnerOnly(solanaSessionPath(), s);
  clearPendingAck();
  clearPlan();
}

export function clearSolanaSession(): boolean {
  const had = readSolanaSession() !== undefined;
  rmSync(solanaSessionPath(), { force: true });
  clearPendingAck();
  clearPlan();
  return had;
}

/** The one acknowledgement waiting for `--ack` (`ack.ts`). Issuing another replaces it. */
export const pendingAckPath = () => join(dir(), "connect-ack.json");

export function writePendingAck(a: PendingAck): void {
  writeOwnerOnly(pendingAckPath(), a);
}

export function readPendingAck(): PendingAck | undefined {
  try {
    const v = JSON.parse(readFileSync(pendingAckPath(), "utf8")) as Partial<PendingAck>;
    if (typeof v.code !== "string" || typeof v.digest !== "string" || typeof v.issuedAtIso !== "string" || typeof v.expiresAtIso !== "string") return undefined;
    return { code: v.code, digest: v.digest, issuedAtIso: v.issuedAtIso, expiresAtIso: v.expiresAtIso };
  } catch {
    return undefined;
  }
}

export function clearPendingAck(): void {
  rmSync(pendingAckPath(), { force: true });
}

/** The one plan (`connect plan`, `ack.ts`) and its legs' progress. Issuing another replaces it. */
export const planPath = () => join(dir(), "connect-plan.json");

export function writePlan(p: PendingPlan): void {
  writeOwnerOnly(planPath(), p);
}

export function readPlan(): PendingPlan | undefined {
  try {
    const v = JSON.parse(readFileSync(planPath(), "utf8")) as Partial<PendingPlan>;
    if (typeof v.code !== "string" || typeof v.issuedAtIso !== "string" || typeof v.expiresAtIso !== "string" || typeof v.acknowledged !== "boolean" || !Array.isArray(v.legs)) return undefined;
    // A leg that does not read back whole makes the plan unreadable, never a plan with that leg skipped.
    for (const l of v.legs) if (!l || typeof l.leg !== "number" || typeof l.digest !== "string" || typeof l.status !== "string") return undefined;
    return v as PendingPlan;
  } catch {
    return undefined;
  }
}

export function clearPlan(): void {
  rmSync(planPath(), { force: true });
}

/**
 * One sign-in or confirmation page at a time. The page can fall back to another port when its first
 * is taken, so the port no longer keeps a second page from opening; this file does. It names the
 * process that holds it and when its page expires; a file whose process has gone, or whose page has
 * expired, is left over from a run that never closed it, and is replaced.
 */
export const pageLockPath = () => join(dir(), "connect-page.lock");

/** A lock file this young that does not parse yet is still being written by the process that made it. */
const LOCK_WRITE_GRACE_MS = 2_000;
/**
 * The holder touches its lock file this often, so the file's age says whether the page's process is still running:
 * a process ID alone can be reused, by another program or by this same one, after the holder has gone.
 */
const LOCK_BEAT_MS = 5_000;
/** A lock not touched for this long is suspect; it is replaced only if it is still not touched one beat later. */
const LOCK_BEAT_STALE_MS = 30_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists and belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const mtimeOf = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

type Held = { held: true; pid: number; port?: number } | { held: false; raw: string | undefined } | { held: "unless-beating"; raw: string; mtimeMs: number; pid: number; port?: number };

/** Whether the lock file at `path` is a live page's, read once; `raw` is the content judged, for `replaceStale`. */
function heldBy(path: string): Held {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { held: false, raw: undefined };
  }
  try {
    const v = JSON.parse(raw) as { pid?: unknown; expiresAt?: unknown; port?: unknown; beat?: unknown };
    if (typeof v.pid !== "number" || typeof v.expiresAt !== "number") return { held: false, raw };
    if (v.expiresAt < Date.now() || !alive(v.pid)) return { held: false, raw };
    const port = typeof v.port === "number" ? { port: v.port } : {};
    // A lock from a version that does not beat is judged by its process ID alone, as before.
    const mtimeMs = mtimeOf(path);
    if (v.beat === true && mtimeMs !== undefined && Date.now() - mtimeMs > LOCK_BEAT_STALE_MS) return { held: "unless-beating", raw, mtimeMs, pid: v.pid, ...port };
    return { held: true, pid: v.pid, ...port };
  } catch {
    const mtimeMs = mtimeOf(path);
    return mtimeMs !== undefined && Date.now() - mtimeMs < LOCK_WRITE_GRACE_MS ? { held: true, pid: 0 } : { held: false, raw };
  }
}

/**
 * Removes the lock file only if it still holds `seen`, the stale content this run judged. Two runs can judge the same
 * stale file at once; a plain remove would let the second delete the lock the first has just made, and both pages
 * would open. A rename is atomic, so each run moves aside whatever is there and checks it: a lock that is not the stale
 * one is put back (a hard link never replaces a file another run has made meanwhile). Returns whether it removed it.
 */
export function replaceStale(path: string, seen: string): boolean {
  const aside = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  let moved: string | undefined;
  try {
    moved = readFileSync(aside, "utf8");
  } catch {
    moved = undefined;
  }
  if (moved !== seen) {
    try {
      linkSync(aside, path);
    } catch {
      // Another run has claimed the lock in between; its claim stands.
    }
  }
  rmSync(aside, { force: true });
  return moved === seen;
}

/**
 * Claims the page lock until `ttlMs` from now. Returns `setPort` (records which port the page took)
 * and `release` (removes the file, only while it is still this claim's). Rejects when a live page holds it.
 * While held, the file is touched every `beatMs`; a suspect lock is given `waitMs` to show it is still being touched.
 */
export async function claimPageLock(
  ttlMs: number,
  { beatMs = LOCK_BEAT_MS, waitMs = LOCK_BEAT_MS + 1_000 }: { beatMs?: number; waitMs?: number } = {},
): Promise<{ setPort: (port: number) => void; release: () => void }> {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const path = pageLockPath();
  // Tells this claim from a later one in the same file; not a secret.
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const expiresAt = Date.now() + ttlMs;
  const body = (port?: number) => JSON.stringify({ pid: process.pid, expiresAt, token, beat: true, ...(port ? { port } : {}) });
  const write = (port?: number) => writeFileSync(path, body(port), { mode: 0o600 });
  const refuse = (port?: number) => new Error(`another sign-in or confirmation page is still open${port ? ` on port ${port}` : ""}; finish or close it, then retry`);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, body());
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let h = heldBy(path);
      if (h.held === "unless-beating") {
        const { mtimeMs, port, raw } = h;
        await new Promise((r) => setTimeout(r, waitMs));
        // Touched meanwhile: its holder is running (a laptop that slept, say). Otherwise the process ID was reused.
        h = mtimeOf(path) !== mtimeMs ? { held: true, pid: h.pid, ...(port ? { port } : {}) } : { held: false, raw };
      }
      if (h.held === true) throw refuse(h.port);
      if (attempt > 2 || (h.raw !== undefined && !replaceStale(path, h.raw))) throw refuse();
    }
  }
  const ours = () => {
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as { token?: unknown }).token === token;
    } catch {
      return false;
    }
  };
  const beat = setInterval(() => {
    if (!ours()) return;
    try {
      const t = new Date();
      utimesSync(path, t, t);
    } catch {
      // Gone between the check and the touch; nothing to keep alive.
    }
  }, beatMs);
  beat.unref();
  return {
    setPort: (port) => {
      if (ours()) write(port);
    },
    release: () => {
      clearInterval(beat);
      if (ours()) rmSync(path, { force: true });
    },
  };
}

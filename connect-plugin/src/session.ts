import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startConfirm, startConnect } from "./flows.ts";
import type { Connected } from "./flows.ts";
import type { Handle } from "./http.ts";
import type { Call } from "./decode.ts";
import { revokeSigner } from "./signer-client.ts";

const CONFIG_DIR = process.env.TREASURY_CONNECT_HOME ?? join(homedir(), ".config", "treasury");
const SESSION_FILE = join(CONFIG_DIR, "connect-session.json");

// `via` says which sign-in made the session: "wallet" (connected directly, no Privy) or "privy"
// (a Google/email embedded wallet delegated to the signing service).
type Persisted =
  | { via: "wallet"; account: string; chainId: number; walletType: "external"; connectedAtIso: string }
  | { via: "privy"; account: string; chainId: number; walletType: "embedded"; delegated: true; signerSession: string; connectedAtIso: string };

type Rejection = { reason: string; requestedAtIso: string };
type Pending = { url: string; opened: boolean; requestedAtIso: string; handle: Handle<Connected> };

let pending: Pending | undefined;
let lastRejection: Rejection | undefined;

function readPersisted(): Persisted | undefined {
  try {
    const p = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Record<string, unknown>;
    // Sessions from before 0.7 said "browser" for a directly connected wallet. Every other old kind
    // (WalletConnect) is no longer supported and reads as disconnected.
    if (p.via === "browser") return { via: "wallet", account: String(p.account), chainId: Number(p.chainId), walletType: "external", connectedAtIso: String(p.connectedAtIso) };
    if (p.via === "wallet" || p.via === "privy") return p as Persisted;
    return undefined;
  } catch {
    return undefined;
  }
}

function writePersisted(p: Persisted | undefined): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (p === undefined) {
    try {
      rmSync(SESSION_FILE);
    } catch {
      // Nothing to remove.
    }
    return;
  }
  writeFileSync(SESSION_FILE, JSON.stringify(p, null, 2), { mode: 0o600 });
}

// The signer session token never leaves this process; it is not part of what status reports.
const connectedState = (p: Persisted) => {
  if (p.via === "privy") {
    const { signerSession: _omit, ...rest } = p;
    return { status: "connected" as const, ...rest };
  }
  return { status: "connected" as const, ...p };
};

export async function status() {
  if (pending) return { status: "awaiting_approval" as const, url: pending.url, opened: pending.opened, requestedAtIso: pending.requestedAtIso };
  const p = readPersisted();
  if (p) return connectedState(p);
  if (lastRejection) {
    const r = lastRejection;
    lastRejection = undefined;
    return { status: "rejected" as const, ...r };
  }
  return { status: "disconnected" as const };
}

export async function connect(waitMs = 0) {
  if (pending) return status();
  const existing = readPersisted();
  if (existing) return connectedState(existing);
  const handle = await startConnect();
  const requestedAtIso = new Date().toISOString();
  pending = { url: handle.url, opened: handle.opened, requestedAtIso, handle };
  const settled = handle.done.then((r) => {
    if (pending?.requestedAtIso !== requestedAtIso) return;
    pending = undefined;
    if (!r.ok) {
      lastRejection = { reason: r.reason, requestedAtIso };
      return;
    }
    const v = r.value;
    const connectedAtIso = new Date().toISOString();
    writePersisted(
      v.walletType === "embedded"
        ? { via: "privy", account: v.account, chainId: v.chainId, walletType: "embedded", delegated: true, signerSession: v.signerSession, connectedAtIso }
        : { via: "wallet", account: v.account, chainId: v.chainId, walletType: "external", connectedAtIso },
    );
  });
  if (waitMs > 0 && handle.opened) await Promise.race([settled, new Promise((r) => setTimeout(r, waitMs).unref())]);
  return status();
}

export async function disconnect() {
  const existing = readPersisted();
  const waiting = pending;
  pending = undefined;
  waiting?.handle.close();
  if (!existing) {
    writePersisted(undefined);
    return { disconnected: false };
  }
  if (existing.via === "privy") await revokeSigner(existing.signerSession);
  writePersisted(undefined);
  return { disconnected: true };
}

export async function switchWallet(waitMs = 0) {
  await disconnect();
  return connect(waitMs);
}

export async function sendTransaction(call: Call) {
  const existing = readPersisted();
  if (!existing) throw new Error("no wallet is connected — call connect_wallet first, then connect_status until it reports connected");
  const session: Connected =
    existing.via === "privy"
      ? { account: existing.account, chainId: existing.chainId, walletType: "embedded", signerSession: existing.signerSession }
      : { account: existing.account, chainId: existing.chainId, walletType: "external" };
  const handle = await startConfirm(call, session);
  if (!handle.opened) {
    handle.close();
    throw new Error("this machine cannot open a browser for the confirmation page (SSH, no display, or opening is disabled). Run Claude Code on a machine with a browser.");
  }
  const r = await handle.done;
  if (!r.ok) return { status: "rejected" as const, reason: r.reason };
  const { hash, verified, detail } = r.value;
  return {
    status: "submitted" as const,
    hash,
    verified,
    ...(detail ? { detail } : {}),
    ...(verified === "mismatch" ? { warning: "the transaction on chain does not match the call that was requested — do not continue; tell the operator" } : {}),
  };
}

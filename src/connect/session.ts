/**
 * The connected account, remembered between commands in a small file readable only by its owner
 * (`~/.config/treasury/connect-session.json`, mode 0600; `TREASURY_CONNECT_HOME` moves it).
 *
 * It holds no credential: an address, how it signed in, and when. Being "connected" grants nothing
 * by itself — every transaction is still confirmed by the operator in the browser and in their
 * wallet — it only fixes WHICH account the confirm page will accept and pay.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
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

export function writeSession(s: Session): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(sessionPath(), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; an existing file keeps its own.
  chmodSync(sessionPath(), 0o600);
}

export function clearSession(): boolean {
  const had = readSession() !== undefined;
  rmSync(sessionPath(), { force: true });
  return had;
}

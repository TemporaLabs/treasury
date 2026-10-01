/**
 * Wallet session — WalletConnect v2 pairing, and the address it yields.
 *
 * This module never sees a private key: WalletConnect's relay carries only the pairing/session
 * handshake and, later, signing REQUESTS — the wallet app itself holds the key and signs.
 * Connecting a wallet here means exactly one thing: an address is now known. It grants no
 * transaction authority. `earn_prepare_*` (a separate skill, a separate MCP server) still
 * requires its own signature from whatever signer the operator actually uses — connecting here
 * neither gates nor bypasses that; it only supplies an address a caller can pass as `account`.
 *
 * v1 scope: EIP-155 wallets on Base (8453) that speak WalletConnect (MetaMask, Rabby, OKX
 * Wallet, and any other WalletConnect-compatible wallet). Email/Google login and creating a new
 * wallet are out of scope for this module.
 */
import { SignClient } from "@walletconnect/sign-client";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAddress, getAddress, type Address, type Hex } from "viem";
import { startConnect, startSign, type Handle } from "./browser-session.js";

/**
 * The one shape this module reads off a WalletConnect session — not the full `@walletconnect/types`
 * surface, which this package does not otherwise depend on. `SignClient.connect()`'s real return
 * type is structurally compatible with this; keeping it local avoids adding a type-only dependency
 * declaration for four fields.
 */
type ConnectedSession = { topic: string; namespaces: Record<string, { accounts: string[] } | undefined> };

const EIP155_METHODS = ["eth_sendTransaction", "eth_signTransaction", "personal_sign", "eth_signTypedData_v4"];
const EIP155_EVENTS = ["chainChanged", "accountsChanged"];
const BASE_CAIP2 = "eip155:8453";

/** Overridable so tests never touch the operator's real config directory. */
const CONFIG_DIR = process.env.TREASURY_CONNECT_HOME ?? join(homedir(), ".config", "treasury");
const SESSION_FILE = join(CONFIG_DIR, "connect-session.json");
const WC_STORAGE_FILE = join(CONFIG_DIR, "walletconnect-store.json");

/**
 * A minimal, dependency-free storage backend for WalletConnect's own session/pairing/keychain
 * data — one JSON file, loaded once and rewritten whole on every write. Passed explicitly as
 * `storage` (not `storageOptions`) to bypass @walletconnect/keyvaluestorage's own Node backend
 * entirely: that package resolves its storage driver through `unstorage`'s dynamic,
 * string-path-based driver loading, which esbuild's bundler cannot preserve correctly: the bundled
 * server fails with `ReferenceError: indexedDB is not defined`, because bundling resolves a
 * browser driver even with `platform: "node"`. The unbundled TypeScript source and tests that mock
 * SignClient never hit this. A plain file needs no dynamic module resolution at all, so there is
 * nothing left for a bundler to get wrong.
 */
class FileKeyValueStorage {
  private data: Record<string, unknown> | undefined;
  constructor(private readonly path: string) {}
  private load(): Record<string, unknown> {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
    } catch {
      this.data = {};
    }
    return this.data;
  }
  private save(): void {
    ensureDir();
    writeFileSync(this.path, JSON.stringify(this.data ?? {}));
  }
  async getKeys(): Promise<string[]> {
    return Object.keys(this.load());
  }
  async getEntries<T = unknown>(): Promise<[string, T][]> {
    return Object.entries(this.load()) as [string, T][];
  }
  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    return this.load()[key] as T | undefined;
  }
  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    this.load()[key] = value;
    this.save();
  }
  async removeItem(key: string): Promise<void> {
    delete this.load()[key];
    this.save();
  }
}

/** The two ways to sign in: a page in the operator's own browser, or a WalletConnect pairing. */
export type ConnectMethod = "browser" | "walletconnect";

export type SessionState =
  | { status: "disconnected" }
  | { status: "awaiting_approval"; via: "walletconnect"; uri: string; qr: string; requestedAtIso: string }
  | { status: "awaiting_approval"; via: "browser"; url: string; opened: boolean; requestedAtIso: string }
  | { status: "connected"; via: "walletconnect"; account: Address; chainId: number; topic: string; connectedAtIso: string }
  | { status: "connected"; via: "browser"; account: Address; chainId: number; connectedAtIso: string }
  | { status: "rejected"; reason: string; requestedAtIso: string };

/**
 * The one persisted "who is connected" record. A WalletConnect session keeps a live channel to the
 * wallet (`topic`); a browser sign-in keeps only the address, because an extension can be reached
 * only from inside its own page — every send opens a fresh one-shot page instead.
 */
export type Persisted =
  | { via: "walletconnect"; topic: string; account: Address; chainId: number; connectedAtIso: string }
  | { via: "browser"; account: Address; chainId: number; connectedAtIso: string };

const connectedState = (p: Persisted): SessionState => ({ status: "connected", ...p });

function ensureDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function readPersisted(): Persisted | undefined {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Persisted;
  } catch {
    return undefined;
  }
}

export function writePersisted(p: Persisted | undefined): void {
  ensureDir();
  if (p === undefined) {
    try {
      rmSync(SESSION_FILE);
    } catch {
      /* already gone */
    }
    return;
  }
  writeFileSync(SESSION_FILE, JSON.stringify(p, null, 2));
}

function projectId(): string {
  const id = process.env.WALLETCONNECT_PROJECT_ID;
  if (!id) {
    throw new Error(
      "WALLETCONNECT_PROJECT_ID is not set. Get a free project id from WalletConnect's dashboard " +
        "(cloud.reown.com) and set it in the environment. This id identifies " +
        "the app to the relay — it is not a secret and is not a key.",
    );
  }
  return id;
}

function accountFromSession(session: ConnectedSession): Address {
  const accounts = session.namespaces["eip155"]?.accounts ?? [];
  const first = accounts[0];
  if (!first) throw new Error("the wallet approved with no eip155 account in the session namespace");
  const addr = first.split(":")[2];
  if (!addr || !isAddress(addr)) throw new Error(`the wallet's session account is not a valid address: ${first}`);
  return getAddress(addr);
}

/** An ANSI-block QR code as a plain string, for the agent to show the operator in chat. */
async function renderQr(uri: string): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return await QRCode.toString(uri, { type: "terminal", small: true });
}

/** The package types `SignClient` as a value (its `.init()` factory), not a nominal class — this is its instance type. */
type SignClientInstance = Awaited<ReturnType<typeof SignClient.init>>;

let client: SignClientInstance | undefined;
let pending: { uri: string; qr: string; requestedAtIso: string } | undefined;
let pendingBrowser: { url: string; opened: boolean; requestedAtIso: string; handle: Handle<unknown> } | undefined;
let lastRejection: { reason: string; requestedAtIso: string } | undefined;

async function getClient(): Promise<SignClientInstance> {
  if (client) return client;
  ensureDir();
  client = await SignClient.init({
    projectId: projectId(),
    storage: new FileKeyValueStorage(WC_STORAGE_FILE),
    metadata: {
      // Plain ASCII on purpose: some relay and wallet metadata validators reject non-ASCII characters.
      name: "Agent Treasury - Connect",
      description: "Connects a wallet address for Tempora Labs treasury skills. Never requests a key or seed phrase.",
      url: "https://temporalabs.com",
      icons: [],
    },
  });
  // The wallet can end the session from its own side at any time; keep our on-disk record honest
  // without requiring another `connect_status` call to notice.
  client.on("session_delete", () => writePersisted(undefined));
  client.on("session_expire", () => writePersisted(undefined));
  return client;
}

export async function status(): Promise<SessionState> {
  if (pending) return { status: "awaiting_approval", via: "walletconnect", ...pending };
  if (pendingBrowser) return { status: "awaiting_approval", via: "browser", url: pendingBrowser.url, opened: pendingBrowser.opened, requestedAtIso: pendingBrowser.requestedAtIso };
  const p = readPersisted();
  if (p) return connectedState(p);
  if (lastRejection) {
    const r = lastRejection;
    lastRejection = undefined; // read once, like an unread-notification flag
    return { status: "rejected", ...r };
  }
  return { status: "disconnected" };
}

/**
 * Starts (or reports) a WalletConnect pairing. Returns as soon as the pairing URI exists — it does
 * NOT block for the wallet's approval, which can take anywhere from seconds to never. Poll
 * `status()` (the `connect_status` tool) to learn when it resolves to `connected` or `rejected`.
 */
export async function connect(method: ConnectMethod = "browser", waitMs = 0): Promise<SessionState> {
  if (pending || pendingBrowser) return status();
  const existing = readPersisted();
  if (existing) return connectedState(existing);
  return method === "browser" ? connectBrowser(waitMs) : connectWalletConnect();
}

/**
 * Opens the one-shot sign-in page and (optionally) waits for the wallet to answer, so the common
 * case is a single tool call: the tab opens, the operator clicks, this returns `connected`. When the
 * wait runs out, or no browser can be opened here, it returns `awaiting_approval` with the url.
 */
async function connectBrowser(waitMs: number): Promise<SessionState> {
  const handle = await startConnect();
  const requestedAtIso = new Date().toISOString();
  pendingBrowser = { url: handle.url, opened: handle.opened, requestedAtIso, handle: handle as Handle<unknown> };
  const settled = handle.done.then((r) => {
    if (pendingBrowser?.requestedAtIso !== requestedAtIso) return; // disconnected or replaced meanwhile
    pendingBrowser = undefined;
    if (r.ok) writePersisted({ via: "browser", account: r.value.account, chainId: r.value.chainId, connectedAtIso: new Date().toISOString() });
    else lastRejection = { reason: r.reason, requestedAtIso };
  });
  // A page nobody can see cannot be waited on; hand the url back at once.
  if (waitMs > 0 && handle.opened) await Promise.race([settled, new Promise((r) => setTimeout(r, waitMs).unref())]);
  return status();
}

async function connectWalletConnect(): Promise<SessionState> {
  const c = await getClient();
  const { uri, approval } = await c.connect({
    requiredNamespaces: { eip155: { methods: EIP155_METHODS, chains: [BASE_CAIP2], events: EIP155_EVENTS } },
  });
  if (!uri) throw new Error("the relay returned no pairing uri — an existing pairing may already be settling");

  const requestedAtIso = new Date().toISOString();
  const qr = await renderQr(uri);
  pending = { uri, qr, requestedAtIso };

  // Fire-and-forget: the caller already has the uri/qr back. This resolves later, off the request
  // path, and lands its result in the files `status()` reads. `approval` is a function returning
  // the promise, not the promise itself — SignClient's own API shape.
  approval()
    .then((session) => {
      const account = accountFromSession(session);
      writePersisted({ via: "walletconnect", topic: session.topic, account, chainId: 8453, connectedAtIso: new Date().toISOString() });
    })
    .catch((e: unknown) => {
      lastRejection = { reason: e instanceof Error ? e.message : String(e), requestedAtIso };
    })
    .finally(() => {
      if (pending?.requestedAtIso === requestedAtIso) pending = undefined;
    });

  return { status: "awaiting_approval", via: "walletconnect", uri, qr, requestedAtIso };
}

export async function disconnect(): Promise<{ disconnected: boolean }> {
  const existing = readPersisted();
  pending = undefined;
  const waiting = pendingBrowser;
  pendingBrowser = undefined;
  waiting?.handle.close();
  if (!existing) {
    writePersisted(undefined);
    return { disconnected: false };
  }
  if (existing.via === "walletconnect") {
    const c = await getClient();
    try {
      await c.disconnect({ topic: existing.topic, reason: { code: 6000, message: "User disconnected" } });
    } catch {
      /* the wallet may already have dropped the session on its own side; clear our record either way */
    }
  }
  writePersisted(undefined);
  return { disconnected: true };
}

export async function switchWallet(method: ConnectMethod = "browser", waitMs = 0): Promise<SessionState> {
  await disconnect();
  return connect(method, waitMs);
}

export type SendResult =
  | { status: "submitted"; hash: string; verified?: "matched" | "mismatch" | "unverified"; warning?: string }
  | { status: "rejected"; reason: string };

/** Bounded so a wallet that never answers doesn't hang the tool call forever; a signature prompt is answered within a couple of minutes or not at all, unlike connect()'s unbounded pairing wait. */
const SEND_TIMEOUT_MS = 120_000;

/**
 * Relays ONE unsigned call to the currently connected wallet as `eth_sendTransaction` over the
 * live WalletConnect session, and waits for the wallet's own response. This module still never
 * holds a key: the wallet signs and broadcasts on its own side, and this function only carries the
 * request there and the resulting hash back — the same trust boundary as `connect()`, extended from
 * "know an address" to "ask that address's wallet to do exactly this one thing". It builds nothing
 * itself and decides nothing about vaults or amounts; the caller (Earn) is the one that built `call`.
 */
export async function sendTransaction(call: { to: Address; data: Hex; value?: Hex }): Promise<SendResult> {
  const existing = readPersisted();
  if (!existing) throw new Error("no wallet is connected — call connect_wallet first, then connect_status until it reports connected");
  if (existing.via === "browser") return sendViaBrowser(call, existing.account);
  const c = await getClient();
  const request = c.request<string>({
    topic: existing.topic,
    chainId: `eip155:${existing.chainId}`,
    request: { method: "eth_sendTransaction", params: [{ from: existing.account, to: call.to, data: call.data, value: call.value ?? "0x0" }] },
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${SEND_TIMEOUT_MS / 1000}s waiting for the wallet to approve or reject`)), SEND_TIMEOUT_MS),
  );
  try {
    const hash = await Promise.race([request, timeout]);
    return { status: "submitted", hash };
  } catch (e) {
    return { status: "rejected", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Browser-connected wallets sign inside a one-shot page; the hash it returns is then checked on chain. */
async function sendViaBrowser(call: { to: Address; data: Hex; value?: Hex }, account: Address): Promise<SendResult> {
  const handle = await startSign(call, account);
  if (!handle.opened) {
    handle.close();
    throw new Error(
      "this machine cannot open a browser for the wallet (SSH, no display, or opening is disabled). " +
        "Switch to a WalletConnect sign-in: call switch_wallet with method \"walletconnect\".",
    );
  }
  const r = await handle.done;
  if (!r.ok) return { status: "rejected", reason: r.reason };
  const { hash, verified } = r.value;
  return {
    status: "submitted",
    hash,
    verified,
    ...(verified === "mismatch" ? { warning: "the transaction on chain does not match the call that was requested — do not continue; tell the operator" } : {}),
  };
}

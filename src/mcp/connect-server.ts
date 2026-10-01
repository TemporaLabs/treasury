/**
 * Agent Treasury — MCP server (connect skill).
 *
 * Owns wallet AUTHENTICATION and lifecycle: connect, disconnect, switch, and — for a caller that
 * already built a call — relaying it to the connected wallet for a signature. It never builds a
 * transaction itself and never decides what one should contain: Earn (`earn_prepare_deposit` /
 * `earn_prepare_withdraw` in the sibling `treasury` MCP server) is the one place amounts and
 * vaults get decided, and its tools take an explicit `account` on every call rather than trusting
 * ambient state. This server's job is narrower — WHO is connected, and carrying one call this
 * server did not build to the wallet that address belongs to. It never holds a key: connecting
 * grants no signing authority by itself, and `connect_send_transaction` does not either — it is
 * the CONNECTED WALLET's own approval, requested fresh for that one call, that authorizes anything.
 *
 * Five tools:
 *
 *   connect_status   connect_wallet   disconnect_wallet   switch_wallet   connect_send_transaction
 *
 * One connect method: WalletConnect (an existing wallet — MetaMask, Rabby, OKX Wallet, or any
 * other WalletConnect-compatible wallet). Creating a new wallet for someone (email login) and
 * Google login are out of scope; a future iteration may revisit them if users need to create
 * wallets.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isAddress, getAddress, type Hex } from "viem";
import { connect, disconnect, sendTransaction, status, switchWallet, type SessionState } from "../wallet-session.js";
import { PACKAGE_VERSION } from "../version.js";

const addressArg = z
  .string()
  .refine((s) => isAddress(s), "must be an EVM address")
  .transform((s) => getAddress(s));
const hexArg = (label: string) =>
  z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/, `must be 0x-prefixed hex (${label})`)
    .transform((s) => s as Hex);

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

/**
 * Every handler runs inside this. A thrown error's `.message` reaches the caller verbatim — this
 * server has no RPC endpoint or credential to leak, so no redaction layer is needed here the way
 * Earn's server needs one, but a raw stack trace still is not the contract.
 */
const guarded =
  <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
  async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  };

/** Adds the one line every state benefits from repeating, without duplicating it at each call site. */
function present(s: SessionState) {
  if (s.status === "awaiting_approval") {
    return {
      ...s,
      instructions:
        "Open the uri in a WalletConnect-compatible wallet (MetaMask, Rabby, OKX Wallet — desktop or " +
        "mobile), or scan the qr with a mobile wallet's WalletConnect scanner. This does not block: " +
        "call connect_status again to see whether it resolved.",
    };
  }
  if (s.status === "connected") {
    return { ...s, note: "An address is known. This grants no signing authority — a deposit or withdrawal still needs its own explicit signature from your signer." };
  }
  return s;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "treasury-connect", version: PACKAGE_VERSION });

  server.registerTool(
    "connect_status",
    {
      title: "Wallet connection status",
      description:
        "Reports the current WalletConnect session: `disconnected`, `awaiting_approval` (a connect_wallet pairing is pending — the same uri/qr are returned again), `connected` (an address is known), or `rejected` (declined or timed out — read once, then clears). Call this before assuming a wallet is or isn't connected; nothing here is inferred from prior conversation.",
      inputSchema: {},
    },
    guarded(async () => text(present(await status()))),
  );

  server.registerTool(
    "connect_wallet",
    {
      title: "Connect a wallet",
      description:
        "Starts a WalletConnect pairing for a Base (chain 8453) EIP-155 wallet — MetaMask, Rabby, OKX Wallet, or any other WalletConnect-compatible wallet. Returns immediately with a pairing `uri` and an ASCII `qr` to show the operator; it does NOT wait for approval, which can take anywhere from seconds to never. Poll connect_status afterward. If a wallet is already connected, returns that connected state instead of starting a new pairing — use switch_wallet to replace it.",
      inputSchema: {},
    },
    guarded(async () => text(present(await connect()))),
  );

  server.registerTool(
    "disconnect_wallet",
    {
      title: "Disconnect the wallet",
      description:
        "Ends the current WalletConnect session and clears the local record of it. Returns `disconnected: false` if nothing was connected. After this, no address is known until connect_wallet is called again — this server never retains signing authority, so there is nothing else to revoke.",
      inputSchema: {},
    },
    guarded(async () => text(await disconnect())),
  );

  server.registerTool(
    "switch_wallet",
    {
      title: "Replace the connected wallet",
      description:
        "Disconnects whatever is currently connected (if anything) and immediately starts a new WalletConnect pairing, exactly like calling disconnect_wallet then connect_wallet. Returns the new `awaiting_approval` state — poll connect_status for the outcome.",
      inputSchema: {},
    },
    guarded(async () => text(present(await switchWallet()))),
  );

  server.registerTool(
    "connect_send_transaction",
    {
      title: "Send one call through the connected wallet",
      description:
        "Relays exactly one unsigned call — `to`, `data`, optional `value` — to the connected WalletConnect wallet and waits (up to 120s) for its own approve/reject prompt. This tool builds nothing: hand it one call at a time from Earn's earn_prepare_deposit/earn_prepare_withdraw envelope, IN ORDER, following that envelope's own signer_rules (destination check, gasAdvice, any precondition). Returns `{status: \"submitted\", hash}` once signed and broadcast — NOT once confirmed; check confirmation with earn_balance or earn_status. Returns `{status: \"rejected\", reason}` if declined, rejected, or nothing happens within the timeout. Throws if nothing is connected — call connect_wallet first.",
      inputSchema: { to: addressArg, data: hexArg("data"), value: hexArg("value").optional() },
    },
    guarded(async ({ to, data, value }) => {
      const call = { to, data, ...(value === undefined ? {} : { value }) };
      return text(await sendTransaction(call));
    }),
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && /connect-server\.(ts|mjs|js)$/.test(process.argv[1])) {
  // A tool call's own error reaches the caller through `guarded()` and never gets here. What lands
  // here is everything a tool handler's try/catch structurally cannot reach — an 'error' event on
  // some dependency's EventEmitter with no listener (Node crashes the process for that regardless
  // of any surrounding try/catch), or a rejected promise nothing is awaiting. Without these two
  // handlers such a failure kills the process with no output on either stream, which makes a
  // WalletConnect relay failure indistinguishable from the process being silently killed. A
  // long-running server should never die without saying why.
  process.on("uncaughtException", (e) => {
    process.stderr.write(`treasury-connect mcp: uncaught exception: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    process.stderr.write(`treasury-connect mcp: unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
  main().catch((e) => {
    process.stderr.write(`treasury-connect mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

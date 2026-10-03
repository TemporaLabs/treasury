import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { connect, disconnect, sendTransaction, status, switchWallet } from "./session.ts";
import { PACKAGE_VERSION } from "./version.ts";

const addressArg = z.string().refine((s) => isAddress(s), "must be an EVM address").transform((s) => getAddress(s));
const hexArg = (label: string) => z.string().regex(/^0x[0-9a-fA-F]*$/, `must be 0x-prefixed hex (${label})`).transform((s) => s as `0x${string}`);
const waitArg = z.number().int().min(0).max(300).optional().describe("Seconds to wait for the operator to finish in the browser before returning (default 90). 0 returns immediately with the url.");
const DEFAULT_WAIT_S = 90;

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

type State = Awaited<ReturnType<typeof status>>;

function present(s: State) {
  if (s.status === "awaiting_approval") {
    return {
      ...s,
      instructions: s.opened
        ? "A browser tab opened with two choices: Continue with Google or email (Privy), or Connect a wallet (direct, no Privy). Tell the operator to pick one there. Call connect_status to see whether it finished."
        : "No browser could be opened on this machine. If the operator is at this machine, give them the url to open in a browser. Otherwise this plugin cannot sign in from here.",
    };
  }
  if (s.status === "connected") {
    return { ...s, note: "An address is known. This grants no signing authority — every deposit or withdrawal still shows a confirmation page and needs the operator's click." };
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
        "Reports the current session: `disconnected`, `awaiting_approval` (a connect_wallet sign-in is pending — the same url is returned again), `connected` (an address is known, with `via`: `wallet` for a directly connected wallet or `privy` for a Google/email embedded wallet), or `rejected` (declined or timed out — read once, then clears). Call this before assuming a wallet is or isn't connected; nothing here is inferred from prior conversation.",
      inputSchema: {},
    },
    async () => text(present(await status())),
  );

  server.registerTool(
    "connect_wallet",
    {
      title: "Connect a wallet",
      description:
        "Opens one page in the operator's browser with two separate choices: Continue with Google or email (a Privy embedded wallet), or Connect a wallet (MetaMask, Rabby, Coinbase Wallet or any browser wallet, connected directly with a free sign-in message and no Privy). Waits up to `wait_seconds` and returns `connected` directly. If a wallet is already connected, returns that state instead — use switch_wallet to replace it.",
      inputSchema: { wait_seconds: waitArg },
    },
    async ({ wait_seconds }) => text(present(await connect((wait_seconds ?? DEFAULT_WAIT_S) * 1000))),
  );

  server.registerTool(
    "disconnect_wallet",
    {
      title: "Disconnect the wallet",
      description:
        "Ends the current session and clears the local record of it. For a Google/email embedded wallet it also asks the signing service to revoke this machine's session token (it does not remove the signer inside Privy). Returns `disconnected: false` if nothing was connected.",
      inputSchema: {},
    },
    async () => text(await disconnect()),
  );

  server.registerTool(
    "switch_wallet",
    {
      title: "Replace the connected wallet",
      description:
        "Disconnects whatever is currently connected (if anything) and immediately opens a new sign-in page, exactly like calling disconnect_wallet then connect_wallet with the same `wait_seconds`.",
      inputSchema: { wait_seconds: waitArg },
    },
    async ({ wait_seconds }) => text(present(await switchWallet((wait_seconds ?? DEFAULT_WAIT_S) * 1000))),
  );

  server.registerTool(
    "connect_send_transaction",
    {
      title: "Send one call through the connected wallet",
      description:
        "Relays exactly one unsigned call — `to`, `data`, optional `value` — through the connected wallet. A confirmation page always opens in the operator's browser first, showing the decoded call (action, amount, vault, receiver, chain); nothing is signed until the operator clicks Confirm there. A Google/email embedded wallet is then signed by the signing service; a directly connected wallet then shows its own prompt. Waits up to 3 minutes. This tool builds nothing: hand it one call at a time from Earn's earn_prepare_deposit/earn_prepare_withdraw envelope, IN ORDER, following that envelope's own signer_rules (destination check, gasAdvice, any precondition). Returns `{status: \"submitted\", hash, verified}` once signed and broadcast — NOT once confirmed on chain; confirm with Earn's earn_balance or earn_status. `verified: \"mismatch\"` means stop and tell the operator. Returns `{status: \"rejected\", reason}` for a decline, a timeout, or a refusal from the signing service; do not retry with the fields changed.",
      inputSchema: { to: addressArg, data: hexArg("data"), value: hexArg("value").optional() },
    },
    async ({ to, data, value }) => text(await sendTransaction({ to, data, ...(value === undefined ? {} : { value }) })),
  );

  return server;
}

async function main() {
  await buildServer().connect(new StdioServerTransport());
}

if (process.argv[1] && /connect-server\.(ts|mjs|js)$/.test(process.argv[1])) {
  const die = (label: string) => (e: unknown) => {
    process.stderr.write(`treasury-connect mcp: ${label}${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  };
  process.on("uncaughtException", die("uncaught exception: "));
  process.on("unhandledRejection", die("unhandled rejection: "));
  main().catch(die(""));
}

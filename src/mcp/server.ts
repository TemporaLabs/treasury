/**
 * Agent Treasury — MCP server (earn skill).
 *
 * Read tools, quotes, and UNSIGNED call builders only. There is no `sign` and no `send` tool, and
 * there will not be one here: the skill supplies intent, the consumer supplies the signer. Anything
 * that holds a key lives outside this process and receives the calls this server emits.
 *
 * Eight tools, all `earn_`-prefixed so later skills can sit beside them
 * in one namespace:
 *
 *   earn_vaults    earn_terms     earn_quote (direction)   earn_status (no args = health)
 *   earn_balance   earn_claim     earn_prepare_deposit     earn_prepare_withdraw
 *
 * Two contracts worth stating here because they are easy to erode:
 *
 * 1. `earn_prepare_*` return an ENVELOPE, `{ requires_signature, status: "unsigned", calls }`,
 *    not a bare array. This cannot stop a model reporting "deposited" — nothing at this boundary
 *    can — but it makes an unsigned build structurally distinguishable from a completed one, so a
 *    consumer or a test can assert on it. Wrapped HERE only: `buildDeposit`/`buildWithdraw` still
 *    return arrays, so a direct library consumer (see docs/runbooks/sign_and_send.md) gets the
 *    naked calls exactly as before.
 * 2. The address argument is `account` everywhere. It was `depositor`, `owner` and `principal` in
 *    three different tools. `receiver` stays distinct because it genuinely is: `account` owns the
 *    shares, `receiver` is where the money lands.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { redactEndpoints, registerSecretSource } from "../redact.js";
import { isAddress, getAddress } from "viem";
import { isSupportedChainId, makePublicClient, rpcUrlFromEnv, logsRpcUrlFromEnv, rpcSourceForEnv, resolvedRpcSecrets, publicRpcHint, logsFallbackUrlFromEnv } from "../client.js";
import { defaultVault, depositableVaults, listVaults, loadRegistry, resolveVault } from "../registry.js";
import { linksFor } from "../links.js";
import type { VaultEntry } from "../registry-schema.js";
import { PACKAGE_VERSION } from "../version.js";
import { preflightDeposit } from "../preflight.js";
import { getPosition } from "../position.js";
import { quoteDeposit, quoteWithdraw } from "../quote.js";
import { buildDeposit, buildWithdraw, type UnsignedCall } from "../build.js";
import { DISCLOSURES } from "../disclosures.js";

const addressArg = z
  .string()
  .refine((s) => isAddress(s), "must be an EVM address")
  .transform((s) => getAddress(s));
const amountArg = z.string().regex(/^\d+(\.\d+)?$/, 'plain decimal USDC amount, e.g. "25" or "12.5"');
const vaultArg = z.string().optional().describe("the vault's ERC-20 ticker, e.g. tlCashPlusUSDC2 (earn_vaults lists them); omit for the default vault");
const accountArg = addressArg.describe("the account whose shares these are — the depositor, the owner, the holder");

function supportedVault(symbol?: string) {
  const vault = resolveVault(symbol);
  if (!isSupportedChainId(vault.chainId)) throw new Error(`chain ${vault.chainId} unsupported`);
  return vault;
}

function clientFor(symbol?: string) {
  const vault = supportedVault(symbol);
  return { vault, client: makePublicClient(vault.chainId, rpcUrlFromEnv(vault.chainId)) };
}

/** Shapes that mean "the transport failed", as opposed to a verdict about the vault. */
const RPC_FAILURE = /RPC Request failed|HTTP request failed|reads failed|over rate limit|rate.?limit|"unreachable"|fetch failed|ETIMEDOUT|ECONNREFUSED/i;

/**
 * Serialise a tool result, and when the payload shows a TRANSPORT failure while no RPC is
 * configured, attach the one sentence that turns "this is broken" into "set this variable".
 * Attached as a FIELD rather than appended to prose, so a consumer can branch on it.
 */
const text = (v: unknown) => {
  let body = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  if (RPC_FAILURE.test(body)) {
    const hint = publicRpcHint(8453);
    if (hint) {
      body =
        typeof v === "string"
          ? `${body}\n\n${hint}`
          : JSON.stringify({ ...(v as Record<string, unknown>), setup_required: hint }, null, 2);
    }
  }
  return { content: [{ type: "text" as const, text: body }] };
};

/** An unsigned build never leaves this server as a bare array. See contract 1 in the file header. */
/**
 * 🔴 THE ONE PLACE THE VAULT'S WARNING IS ATTACHED TO A RESPONSE. Every response that can be the
 * last thing an agent reads before a signer sees calldata goes through here.
 *
 * It exists as a chokepoint rather than three tidy literals for a reason worth keeping. The warning
 * first shipped on `earn_vaults` alone — a DISCOVERY call — while the warning's own text says to
 * show it before preparing a deposit. A caller who names a vault directly never makes that call, so
 * the disclosure reached whoever happened to have listed recently and nobody else. The repair added
 * it to three call sites, and two of those three were then unguarded: deleting the field from them
 * left the whole suite green.
 *
 * A test per call site would only have guarded the sites someone remembered to write a test for,
 * which is the same defect one level up. So: attach it HERE, and `server.unit.test.ts` asserts this
 * is the only place in the file that writes a `warning` field. A fourth money-committing tool then
 * gets the disclosure by going through this helper, and a hand-rolled one is caught by that test
 * rather than by someone noticing.
 *
 * Withdrawals deliberately do NOT call this. The warning is about COMMITTING money, not retrieving
 * it, and a disclosure repeated where it does not apply is what teaches a reader to skip the one
 * that does. That absence is asserted too.
 */
const commitsMoney = (vault: VaultEntry) => ({ warning: vault.warning });

const unsigned = (calls: UnsignedCall[], vault?: VaultEntry) =>
  text({
    requires_signature: true,
    status: "unsigned",
    // before `next_step`, so it is not past the field a reader stops at
    ...(vault === undefined ? {} : commitsMoney(vault)),
    next_step:
      "Hand these calls to a signer IN ORDER, following `signer_rules`. A call carrying `precondition` must not be estimated or sent until that read holds on the RPC the signer sends through. Nothing has been submitted; no funds have moved.",
    signer_rules: SIGNER_RULES,
    calls,
  });

/**
 * What a signer must do for these calls to land exactly once. Each rule is a failure measured on a
 * real Base round trip, not a precaution (2026-09-13, two runs through these tools).
 * The server cannot enforce any of them — it never signs — so it states them with every build.
 */
export const SIGNER_RULES = [
  "Before signing, check every call's destination against the addresses the operator gave: `to`, and the receiver/owner named in `description`. Do not sign a call whose destination you did not confirm.",
  "Set the nonce explicitly from eth_getTransactionCount(account, \"pending\") immediately before each send. A load-balanced RPC can hand a signing library a stale nonce, and the send is then rejected as \"nonce too low\" (measured 2026-09-14, mainnet.base.org).",
  "Set the gas limit to the call's gasAdvice (estimate × 1.5).",
  "Wait for each receipt before sending the next call, and poll for it on a provider that serves receipts: a public endpoint may refuse eth_getTransactionReceipt (measured 2026-09-14, publicnode). A failed receipt poll does not mean the transaction failed.",
  "If a send or receipt poll fails for any reason other than an on-chain revert, read the account's nonce on a DIFFERENT provider before re-sending. A nonce that moved means the transaction was accepted; re-sending it would repeat the deposit or withdrawal.",
] as const;

/**
 * Every handler runs inside this. The MCP SDK forwards a thrown error's `.message` to the caller
 * verbatim, and viem's messages carry the transport URL — a keyed provider URL is a secret.
 * Anything that escapes a handler is re-thrown with endpoints masked.
 */
const guarded =
  <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
  async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const redacted = redactEndpoints(msg);
      // A thrown transport error on the public endpoint gets the same sentence a returned one does.
      const hint = RPC_FAILURE.test(redacted) ? publicRpcHint(8453) : undefined;
      throw new Error(hint ? `${redacted}\n\n${hint}` : redacted);
    }
  };

export function buildServer(): McpServer {
  // 🔴 Value-based redaction, registered before any handler can run. `redactEndpoints` masks the
  // resolved RPC URL and its credential-bearing parts wherever they appear — including inside a
  // provider's own error body, which is prose in JSON and which no shape rule matches
  // (review, reproduced against a real viem client and a real 401).
  registerSecretSource(resolvedRpcSecrets);
  const server = new McpServer({ name: "treasury", version: PACKAGE_VERSION });

  server.registerTool(
    "earn_vaults",
    {
      title: "List vaults",
      description:
        "Every vault in the registry. `symbol` is the vault's own on-chain ERC-20 ticker — the value every other tool takes as `vault` — and `name` its `name()`; `links` are openable without any RPC endpoint, so an operator can verify the contract independently. SHOW `warning` TO THE DEPOSITOR — every vault offered today is a test vault. Each row also carries its backend, chassis, decimals and MEASURED deposit-open status. `default` is used when a tool is called without `vault`; `depositable` is the subset any account can put money into today: ERC-4626 chassis + measured open. `defaultAccess` says whether the default takes deposits from any account (`open`) or only whitelisted ones (`whitelist`); for `whitelist`, run earn_status for the account before preparing a deposit.",
      inputSchema: {},
    },
    guarded(async () => {
      const reg = loadRegistry();
      return text({
        reconciledAtIso: reg.reconciledAtIso,
        default: defaultVault().symbol,
        defaultAccess: defaultVault().depositOpen.open ? "open" : "whitelist",
        depositable: depositableVaults().map((v) => v.symbol),
        vaults: listVaults().map((v) => ({
          symbol: v.symbol,
          name: v.name,
          warning: v.warning,
          links: linksFor(v),
          backend: v.backend,
          isDefault: v.isDefault,
          chainId: v.chainId,
          address: v.address,
          chassis: v.chassis,
          asset: v.asset,
          shareDecimals: v.shareDecimals,
          depositOpen: v.depositOpen,
          notes: v.notes,
        })),
      });
    }),
  );

  server.registerTool(
    "earn_terms",
    {
      title: "Pre-deposit disclosures",
      description: "The disclosures every distribution surface must present before a depositor's first deposit. Show these to the operator and record acknowledgement before building any deposit.",
      inputSchema: {},
    },
    guarded(async () => text(DISCLOSURES)),
  );

  server.registerTool(
    "earn_status",
    {
      title: "Server health, or a deposit pre-flight verdict",
      description:
        "With NO arguments: is the server up and the RPC reachable — chain id, latest block, registry version, and which env var supplied the RPC (never the URL). With `account`: simulates deposit() from that address and reports OPEN_READY, NEEDS_APPROVAL, WHITELIST_GATED, REVERTED_OTHER, REFUSED_BY_CLIENT or UNRESOLVED, never trusting maxDeposit(). The `mode` field says which answer you got.",
      inputSchema: { vault: vaultArg, account: accountArg.optional(), amount_usdc: amountArg.optional() },
    },
    guarded(async ({ vault: symbol, account, amount_usdc }) => {
      if (account !== undefined) {
        const { vault, client } = clientFor(symbol);
        const args = amount_usdc === undefined ? { vault, depositor: account, client } : { vault, depositor: account, client, assetsHuman: amount_usdc };
        const verdict = await preflightDeposit(args);
        // spread FIRST so the discriminant cannot be overwritten by a field of the same name
        return text({ ...verdict, mode: "preflight", account, ...commitsMoney(vault) });
      }
      // Health. A partial call (a vault but no account) is answered here too, and says so in
      // STRUCTURE rather than in prose — a note is exactly what a consumer skips, and the risk is
      // a loud health result being read as a preflight pass.
      //
      // A schema error would also close this. It is not taken because a structural carrier is more
      // forgiving to an exploring agent: `earn_status` stays answerable in every state, including
      // a malformed call. This is NOT rejected on the must-never-throw rule below — that rule governs
      // a RUNTIME failure on the health path (a dead RPC must yield a verdict, not an exception),
      // whereas a partial-args call is an INPUT problem settled by MCP's own invalid-params layer
      // before the handler body runs. The two are different layers, and conflating them would license
      // "never validate inputs on a path that must not throw", which is not the rule.
      //
      // Only the account-missing case is "partial": `vault` HAS a default (documented as "omit for
      // the default vault" across the whole tool surface), `account` has none. So {account, no vault}
      // is a complete preflight against the default, not a partial call.
      const partial = symbol !== undefined ? { requested: "preflight", missing: ["account"] } : {};
      const vault = supportedVault(symbol);
      const src = rpcSourceForEnv(vault.chainId);
      const base = {
        mode: "health",
        ...partial,
        server: "treasury",
        version: PACKAGE_VERSION,
        registry: { schemaVersion: loadRegistry().schemaVersion, vaults: loadRegistry().vaults.length, reconciledAtIso: loadRegistry().reconciledAtIso },
        chainId: vault.chainId,
        rpcSource: src.source,
        rpcConfigured: src.configured,
      };
      // 🔴 The health path RETURNS a verdict when the RPC is unreachable. It must never throw: a
      // tool that throws on a dead RPC answers nothing, which is the whole point of having it.
      try {
        const client = makePublicClient(vault.chainId, rpcUrlFromEnv(vault.chainId));
        return text({ ...base, rpc: "ok", latestBlock: (await client.getBlockNumber()).toString() });
      } catch (e) {
        const reason = redactEndpoints(e instanceof Error ? e.message : String(e));
        return text({ ...base, rpc: "unreachable", latestBlock: null, reason });
      }
    }),
  );

  server.registerTool(
    "earn_quote",
    {
      title: "Quote a deposit or a withdrawal",
      description:
        "Pre-trade quote, in USDC. direction=deposit: expected shares (previewDeposit), share price, and the access verdict from a simulated deposit(). This client quotes no rate: an ERC-4626 vault exposes none, and it calls no yield API. direction=withdraw: shares burned (previewWithdraw), shares held, a simulated withdraw() verdict, maxWithdraw advisory only (Morpho V2 returns 0 by design), and queue depth. Run before the matching earn_prepare_* tool.",
      inputSchema: {
        vault: vaultArg,
        account: accountArg,
        amount_usdc: amountArg,
        direction: z.enum(["deposit", "withdraw"]).describe("which side to quote — required, there is no default"),
      },
    },
    guarded(async ({ vault: symbol, account, amount_usdc, direction }) => {
      const { vault, client } = clientFor(symbol);
      // 🔴 The tag is emitted from INSIDE each branch, beside the fields that branch produces —
      // never `{ direction, ...quote }` from the input argument. Measured in review: with the tag
      // taken from the input, swapping these two branches left `tsc -b` clean and all 61 tests
      // passing, and the result read `{ direction: "deposit", sharesToBurn: … }` — the tag said
      // deposit while the body was a withdrawal. A guard derived from the wrong side of the thing
      // it guards cannot detect the bug it exists for. Emitted here, tag and body are consistent
      // BY CONSTRUCTION; a swapped route is then wrong about the REQUEST, which the handler test
      // catches by asserting requested === returned, and never lying about the BODY.
      if (direction === "deposit") {
        return text({
          direction: "deposit" as const,
          ...commitsMoney(vault),
          ...(await quoteDeposit({ vault, depositor: account, assetsHuman: amount_usdc, client })),
        });
      }
      return text({ direction: "withdraw" as const, ...(await quoteWithdraw({ vault, owner: account, assetsHuman: amount_usdc, client })) });
    }),
  );

  server.registerTool(
    "earn_prepare_deposit",
    {
      title: "Prepare an unsigned deposit",
      description:
        "Returns the UNSIGNED calls for a deposit — [approve(asset → vault), deposit(assets, receiver)] — inside an envelope with requires_signature: true. Amount is USDC. NOTHING IS SUBMITTED: hand the calls to a signer in order. This tool cannot sign or send, and the deposit has not happened until the signer's transactions confirm.",
      inputSchema: {
        vault: vaultArg,
        account: accountArg.describe("the depositing account — the one that signs both calls; step 2's allowance precondition is read for it"),
        amount_usdc: amountArg,
        receiver: addressArg.describe("where the SHARES land — usually the account, not necessarily"),
      },
    },
    guarded(async ({ vault: symbol, account, amount_usdc, receiver }) => {
      const vault = supportedVault(symbol);
      return unsigned(buildDeposit(vault, { assetsHuman: amount_usdc, receiver, account }), vault);
    }),
  );

  server.registerTool(
    "earn_prepare_withdraw",
    {
      title: "Prepare an unsigned withdrawal",
      description:
        "Returns the UNSIGNED call for a withdrawal in USDC terms — withdraw(assets, receiver, owner) — inside an envelope with requires_signature: true. To empty the account pass all=true with shares_exact copied verbatim from earn_balance.sharesExact (redeem of the exact balance; never a rounded number). NOTHING IS SUBMITTED and no funds have moved until a signer confirms.",
      inputSchema: {
        vault: vaultArg,
        receiver: addressArg.describe("where the USDC lands — NOT necessarily the account"),
        account: accountArg.describe("whose shares are burnt"),
        amount_usdc: amountArg.optional(),
        all: z.boolean().optional(),
        shares_exact: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      },
    },
    guarded(async ({ vault: symbol, receiver, account, amount_usdc, all, shares_exact }) => {
      const vault = supportedVault(symbol);
      // ⚠️ `receiver` and `account` are DIFFERENT slots and both are addresses, so a transposition
      // here type-checks. `account` is the owner whose shares burn; `receiver` is the payee.
      if (all) {
        if (!shares_exact) throw new Error("all=true requires shares_exact (copy earn_balance.sharesExact verbatim)");
        return unsigned(buildWithdraw(vault, { receiver, owner: account, all: true, sharesExact: shares_exact }));
      }
      if (!amount_usdc) throw new Error("provide amount_usdc, or all=true with shares_exact");
      return unsigned(buildWithdraw(vault, { receiver, owner: account, assetsHuman: amount_usdc }));
    }),
  );

  server.registerTool(
    "earn_balance",
    {
      title: "Earn position",
      description:
        "Shares held (exact string + display), current USDC value, WHAT CAN ACTUALLY BE WITHDRAWN NOW (`exit`, measured by simulating the withdrawal — `usdcValue` is what the position is worth, `exit.exitableNow` is what the vault can pay; on a Fusion vault without instant-withdrawal fuses they differ by 10x and `maxWithdraw()` reports the larger one), entry basis and accrued yield derived from the vault's own Deposit/Withdraw events for this account, and share price. `scan.complete` says whether the event window covered the whole position; `sharesExact` is what earn_prepare_withdraw({ all }) needs.",
      inputSchema: {
        vault: vaultArg,
        account: accountArg,
        lookback_blocks: z.number().int().positive().optional().describe("how far back to scan for Deposit/Withdraw events; default: from the vault's deployment block, i.e. the whole history. The EFFECTIVE window is max_log_requests × the provider's eth_getLogs cap (Alchemy free 10 blocks, Base public 2,000); if the configured RPC cannot cover it, Base's public endpoint serves the scan and scan.source says so"),
        max_log_requests: z.number().int().positive().max(400).optional().describe("cap on eth_getLogs calls per event per scan; default 100 (= 1,000 blocks on Alchemy free, 200,000 on Base public). scan.wholeHistory says whether the scan actually covered every block since the vault was deployed — scan.complete alone is only a reconciliation and can be vacuously true. For an older vault, a provider with a wide eth_getLogs range (TREASURY_LOGS_RPC_BASE) is what makes it whole"),
      },
    },
    guarded(async ({ vault: symbol, account, lookback_blocks, max_log_requests }) => {
      const vault = supportedVault(symbol);
      const logsUrl = logsRpcUrlFromEnv(vault.chainId);
      const client = makePublicClient(vault.chainId, logsUrl);
      // `logsFallbackUrlFromEnv` returns undefined when the operator opted out or when the fallback
      // would be the primary itself — the wiring is a one-liner precisely so it can be unit-tested
      // (measured in review: mutating this line to `undefined` left every position-layer test green;
      // `server.unit.test.ts` is what fails now).
      const fallbackUrl = logsFallbackUrlFromEnv(vault.chainId, logsUrl);
      const fallbackClient = fallbackUrl === undefined ? undefined : makePublicClient(vault.chainId, fallbackUrl);
      return text(
        await getPosition({
          vault,
          principal: account,
          client,
          ...(fallbackClient ? { fallbackClient } : {}),
          ...(lookback_blocks === undefined ? {} : { lookbackBlocks: BigInt(lookback_blocks) }),
          ...(max_log_requests === undefined ? {} : { maxLogRequests: max_log_requests }),
        }),
      );
    }),
  );

  server.registerTool(
    "earn_claim",
    {
      title: "Claim a queued withdrawal",
      description:
        "Finalizes a queued withdrawal on chassis that settle asynchronously. No vault in the current registry queues — Morpho V2 and Fusion settle in the withdraw transaction — so this reports that nothing is claimable. Present so callers can code against the full contract before an async chassis (e.g. a queued-redemption fund) is added.",
      inputSchema: { receipt_id: z.string() },
    },
    guarded(async ({ receipt_id }) =>
      text({
        receipt_id,
        status: "nothing_to_claim",
        note: "No chassis in the registry queues withdrawals; a withdraw() that succeeded already delivered the USDC. When an async chassis is added, this tool will finalize its claim handle.",
      })),
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && /server\.(ts|mjs|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    // Defence-in-depth: HARDENED, NOT TESTED. main() only builds the server and connects a stdio
    // transport — every RPC URL is resolved inside a handler body, so nothing reachable here can
    // carry one. This guard exists so that stays true if main() ever grows.
    process.stderr.write(`treasury mcp: ${redactEndpoints(String(e))}\n`);
    process.exit(1);
  });
}

/**
 * Agent Treasury — the earn commands (earn skill), run headless by `src/cli.ts` as `treasury earn <command>`.
 *
 * Read commands, quotes, and UNSIGNED call builders only. There is no `sign` and no `send` command, and
 * there will not be one here: the skill supplies intent, the consumer supplies the signer. Anything
 * that holds a key lives outside this process and receives the calls these commands emit.
 *
 * Eight commands. Each is keyed by its tool name, `earn_`-prefixed so later skills can sit beside it
 * in one namespace; on the command line `earn_quote` is `treasury earn quote`:
 *
 *   earn_vaults    earn_terms     earn_quote (direction)   earn_status (no args = health)
 *   earn_balance   earn_claim     earn_prepare_deposit     earn_prepare_withdraw
 *
 * Three contracts worth stating here because they are easy to erode:
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
 * 3. A vault lives on ONE chain, and every tool that takes `vault` also takes `chain`. Naming a
 *    chain alone selects that chain's default vault; naming both and having them disagree is
 *    refused (`resolveVault`), never settled by picking one. Every response that names a vault says
 *    which chain it is on, because a prepared call is only correct on that chain.
 */
import { z } from "zod";
import { redactEndpoints, registerSecretSource } from "../redact.js";
import { isAddress, getAddress } from "viem";
import { CHAIN_INFO, isSupportedChainId, makePublicClient, rpcUrlFromEnv, logsRpcUrlFromEnv, rpcSourceForEnv, logsRpcSourceForEnv, resolvedRpcSecrets, publicRpcHint, logsFallbackUrlFromEnv, endpointChainId, firstEndpointOnWrongChain, supportedChainIds, type Endpoint, type SupportedChainId } from "../client.js";
import { defaultChainId, defaultVault, depositableVaults, listVaults, loadRegistry, offeredChains, resolveVault } from "../registry.js";
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
const vaultArg = z.string().optional().describe("the vault's ERC-20 ticker, e.g. tlCashPlusUSDC2 (earn_vaults lists them); omit for the default vault of `chain`, or of the default chain when `chain` is omitted too");
const accountArg = addressArg.describe("the account whose shares these are — the depositor, the owner, the holder");

/**
 * `chain`, as every vault-taking tool accepts it: one of the chains that have a vault in the
 * registry, so a caller cannot name a chain there is nothing to do on. Built per `buildCommands()`
 * call because the list comes from the registry.
 *
 * The schema is a plain string rather than an enum, for three reasons: the set of chains comes from
 * the registry, which can be swapped after this schema is built; `vault` and `chain` are settled
 * together in ONE place (`resolveVault`), so there is one refusal path to test; and that refusal
 * says what to do next — which chain the vault is on, and which vaults the named chain has.
 *
 * 🔴 It must not throw. This runs while the commands are being BUILT, and it reads the registry: a
 * registry that does not parse would stop every command from running at all, `--help` included.
 * Falling back to every supported chain lets the CLI start, and each command then reports the
 * registry's own violation by name, as it did before `chain` existed.
 */
const chainArg = () => {
  let offered: string[];
  try {
    offered = offeredChains().map((c) => c.key);
  } catch {
    offered = supportedChainIds.map((id) => CHAIN_INFO[id].key);
  }
  return z
    .string()
    .optional()
    .describe(
      `which chain: ${offered.map((k) => `"${k}"`).join(" or ")}. Omit for ${CHAIN_INFO[defaultChainId()].key} (the default), or when \`vault\` already names a vault. ` +
        "If the operator has not said which chain to deposit on, ASK them before preparing a deposit. A `vault` that is on a different chain than `chain` is refused.",
    );
};

function supportedVault(symbol?: string, chain?: string) {
  const vault = resolveVault(symbol, chain);
  if (!isSupportedChainId(vault.chainId)) throw new Error(`chain ${vault.chainId} unsupported`);
  return vault;
}

function clientFor(symbol?: string, chain?: string) {
  const vault = supportedVault(symbol, chain);
  const url = rpcUrlFromEnv(vault.chainId);
  const client = makePublicClient(vault.chainId, url);
  return { vault, client, endpoints: [{ client, url, source: rpcSourceForEnv(vault.chainId).source }] };
}

/** The sentence for the first endpoint that answers for a chain other than the vault's, or `undefined`. */
async function wrongChainReason(vault: VaultEntry, endpoints: Endpoint[]): Promise<string | undefined> {
  const wrong = await firstEndpointOnWrongChain(vault.chainId, endpoints);
  if (wrong === undefined) return undefined;
  const info = CHAIN_INFO[vault.chainId];
  return `the endpoint in ${wrong.source} answers for chain ${wrong.answersFor}, not ${info.name} (${vault.chainId}). It must be an endpoint for ${info.name}; until it is, no read for this chain can be trusted.`;
}

/**
 * Runs a tool's reads WHILE checking that each configured endpoint answers for the vault's chain.
 * A mismatch is reported INSTEAD of whatever the reads returned or threw.
 *
 * Why instead: through an endpoint for another chain, the vault's address has no contract, so the
 * reads fail with "returned no data … the address is not a contract" (measured in review, on every
 * RPC-touching tool, in both directions). That is loud, and it names the wrong thing: it reads as a
 * broken vault. The check runs alongside the reads, so it adds no round trip to a healthy call.
 */
async function onItsChain<T>(vault: VaultEntry, endpoints: Endpoint[], work: () => Promise<T>): Promise<T> {
  const [reason, settled] = await Promise.all([
    wrongChainReason(vault, endpoints),
    work().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  if (reason !== undefined) throw new Error(reason);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

/** Which chain a response is about — the name a caller passes back as `chain`, and the id a signer checks. */
const onChain = (vault: VaultEntry) => ({ chain: CHAIN_INFO[vault.chainId].key, chainId: vault.chainId });

/**
 * The chain a failed call was aimed at, for the setup hint — resolved from the call's own arguments
 * and never throwing: a call that failed BECAUSE its vault or chain did not resolve falls back to
 * the default chain, which is what the hint named before there was more than one.
 */
function hintChain(args: unknown): SupportedChainId {
  try {
    const a = (args ?? {}) as { vault?: unknown; chain?: unknown };
    return resolveVault(typeof a.vault === "string" ? a.vault : undefined, typeof a.chain === "string" ? a.chain : undefined).chainId;
  } catch {
    return defaultChainId();
  }
}

/** Shapes that mean "the transport failed", as opposed to a verdict about the vault. */
const RPC_FAILURE = /RPC Request failed|HTTP request failed|reads failed|over rate limit|rate.?limit|"unreachable"|fetch failed|ETIMEDOUT|ECONNREFUSED/i;

/**
 * Serialise a tool result, and when the payload shows a TRANSPORT failure while no RPC is
 * configured, attach the one sentence that turns "this is broken" into "set this variable".
 * Attached as a FIELD rather than appended to prose, so a consumer can branch on it.
 */
const text = (v: unknown, chainId: SupportedChainId = defaultChainId()) => {
  let body = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  if (RPC_FAILURE.test(body)) {
    const hint = publicRpcHint(chainId);
    if (hint) {
      body =
        typeof v === "string"
          ? `${body}\n\n${hint}`
          : JSON.stringify({ ...(v as Record<string, unknown>), setup_required: hint }, null, 2);
    }
  }
  return body;
};

/** An unsigned build never leaves these commands as a bare array. See contract 1 in the file header. */
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
 * which is the same defect one level up. So: attach it HERE, and `commands.unit.test.ts` asserts this
 * is the only place in the file that writes a `warning` field. A fourth money-committing tool then
 * gets the disclosure by going through this helper, and a hand-rolled one is caught by that test
 * rather than by someone noticing.
 *
 * Withdrawals deliberately do NOT call this. The warning is about COMMITTING money, not retrieving
 * it, and a disclosure repeated where it does not apply is what teaches a reader to skip the one
 * that does. That absence is asserted too.
 */
const commitsMoney = (vault: VaultEntry) => ({ warning: vault.warning });

const unsigned = (calls: UnsignedCall[], vault: VaultEntry, kind: "deposit" | "withdraw") =>
  text(
    {
      requires_signature: true,
      status: "unsigned",
      // The chain FIRST: these calls are correct on this chain and on no other.
      ...onChain(vault),
      // before `next_step`, so it is not past the field a reader stops at
      ...(kind === "deposit" ? commitsMoney(vault) : {}),
      next_step: `These calls are for ${CHAIN_INFO[vault.chainId].name} (chainId ${vault.chainId}): tell the operator which chain, and send them on that chain only. Hand these calls to a signer IN ORDER, following \`signer_rules\`. A call carrying \`precondition\` must not be estimated or sent until that read holds on the RPC the signer sends through. Nothing has been submitted; no funds have moved.`,
      signer_rules: SIGNER_RULES,
      calls,
    },
    vault.chainId,
  );

/**
 * What a signer must do for these calls to land exactly once. Every rule but the first is a failure
 * measured on a real Base round trip, not a precaution (2026-09-13, two runs through these tools).
 * The first exists because the registry spans chains: a call's `to` is an address, and an address
 * with no contract on the chain it is sent on accepts the transaction and does nothing.
 * These commands cannot enforce any of them — they never sign — so they state them with every build.
 */
export const SIGNER_RULES = [
  "Send each call on the chain its `chainId` names, and on no other: check the signer's network before signing. Sent on a different chain, a call can be mined there without doing anything — the approve or the deposit never happened, and gas was still spent.",
  "Before signing, check every call's destination against the addresses the operator gave: `to`, and the receiver/owner named in `description`. Do not sign a call whose destination you did not confirm.",
  "Set the nonce explicitly from eth_getTransactionCount(account, \"pending\") immediately before each send. A load-balanced RPC can hand a signing library a stale nonce, and the send is then rejected as \"nonce too low\" (measured 2026-09-14, mainnet.base.org).",
  "Set the gas limit to the call's gasAdvice (estimate × 1.5).",
  "Wait for each receipt before sending the next call, and poll for it on a provider that serves receipts: a public endpoint may refuse eth_getTransactionReceipt (measured 2026-09-14, publicnode). A failed receipt poll does not mean the transaction failed.",
  "If a send or receipt poll fails for any reason other than an on-chain revert, read the account's nonce on a DIFFERENT provider before re-sending. A nonce that moved means the transaction was accepted; re-sending it would repeat the deposit or withdrawal.",
] as const;

/**
 * Every handler runs inside this. The CLI prints a thrown error's `.message` to the caller verbatim,
 * and viem's messages carry the transport URL — a keyed provider URL is a secret. Anything that
 * escapes a handler is re-thrown with endpoints masked.
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
      const hint = RPC_FAILURE.test(redacted) ? publicRpcHint(hintChain(a[0])) : undefined;
      throw new Error(hint ? `${redacted}\n\n${hint}` : redacted);
    }
  };

/** One command: what `--help` prints, the arguments it takes, and the handler that answers with JSON text. */
export interface Command {
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: never) => Promise<string>;
}

export function buildCommands(): Record<string, Command> {
  // 🔴 Value-based redaction, registered before any handler can run. `redactEndpoints` masks the
  // resolved RPC URL and its credential-bearing parts wherever they appear — including inside a
  // provider's own error body, which is prose in JSON and which no shape rule matches
  // (review, reproduced against a real viem client and a real 401).
  registerSecretSource(resolvedRpcSecrets);
  const commands: Record<string, Command> = {};
  const register = <S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
  ): void => {
    commands[name] = { ...meta, inputSchema: z.object(meta.inputSchema), handler: handler as Command["handler"] };
  };
  const chain = chainArg();

  register(
    "earn_vaults",
    {
      title: "List vaults",
      description:
        "Every vault in the registry, on every chain. `symbol` is the vault's own on-chain ERC-20 ticker — the value every other tool takes as `vault` — and `name` its `name()`; `chain` is the chain it is on, the value every other tool takes as `chain`; `links` are openable without any RPC endpoint, so an operator can verify the contract independently. SHOW `warning` TO THE DEPOSITOR — every vault offered today is a test vault. Each row also carries its backend, chassis, decimals and MEASURED deposit-open status. `chains` lists the chains a deposit can go to, the default chain first, each with its own default vault: if the operator has not said which chain, show them these and ASK before preparing a deposit. `default` is used when a tool is called with neither `vault` nor `chain`, and is on `defaultChain`; `depositable` is the subset any account can put money into today, across all chains: ERC-4626 chassis + measured open. `defaultAccess` says whether a default takes deposits from any account (`open`) or only whitelisted ones (`whitelist`); for `whitelist`, run earn_status for the account before preparing a deposit.",
      inputSchema: {},
    },
    guarded(async () => {
      const reg = loadRegistry();
      return text({
        reconciledAtIso: reg.reconciledAtIso,
        defaultChain: CHAIN_INFO[defaultChainId()].key,
        default: defaultVault().symbol,
        defaultAccess: defaultVault().depositOpen.open ? "open" : "whitelist",
        depositable: depositableVaults().map((v) => v.symbol),
        chains: offeredChains().map((c) => {
          const d = defaultVault(c.chainId);
          return {
            chain: c.key,
            chainId: c.chainId,
            name: c.name,
            default: d.symbol,
            defaultAccess: d.depositOpen.open ? "open" : "whitelist",
            depositable: depositableVaults().filter((v) => v.chainId === c.chainId).map((v) => v.symbol),
          };
        }),
        vaults: listVaults().map((v) => ({
          symbol: v.symbol,
          name: v.name,
          warning: v.warning,
          links: linksFor(v),
          backend: v.backend,
          isDefault: v.isDefault,
          chain: CHAIN_INFO[v.chainId].key,
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

  register(
    "earn_terms",
    {
      title: "Pre-deposit disclosures",
      description: "The disclosures every distribution surface must present before a depositor's first deposit. Show these to the operator and record acknowledgement before building any deposit.",
      inputSchema: {},
    },
    guarded(async () => text(DISCLOSURES)),
  );

  register(
    "earn_status",
    {
      title: "Server health, or a deposit pre-flight verdict",
      description:
        "With NO `account`: is the server up and the chain's RPC reachable — chain, chain id, latest block, registry version, and which env var supplied the RPC (never the URL). Each chain has its own RPC, so pass `chain` to check the one you are about to use; `rpc` is `ok`, `unreachable`, or `wrong_chain` when the configured endpoint answers for a different chain. `chainVerified: false` beside `ok` means the endpoint answered but did not say which chain it is. When a separate logs RPC is set, `logsRpc` reports it the same way. With `account`: simulates deposit() from that address and reports OPEN_READY, NEEDS_APPROVAL, WHITELIST_GATED, REVERTED_OTHER, REFUSED_BY_CLIENT or UNRESOLVED, never trusting maxDeposit(). The `mode` field says which answer you got.",
      inputSchema: { vault: vaultArg, chain, account: accountArg.optional(), amount_usdc: amountArg.optional() },
    },
    guarded(async ({ vault: symbol, chain, account, amount_usdc }) => {
      if (account !== undefined) {
        const { vault, client, endpoints } = clientFor(symbol, chain);
        const args = amount_usdc === undefined ? { vault, depositor: account, client } : { vault, depositor: account, client, assetsHuman: amount_usdc };
        const verdict = await onItsChain(vault, endpoints, () => preflightDeposit(args));
        // spread FIRST so the discriminant cannot be overwritten by a field of the same name
        return text({ ...verdict, mode: "preflight", account, ...onChain(vault), ...commitsMoney(vault) }, vault.chainId);
      }
      // Health. A partial call (a vault but no account) is answered here too, and says so in
      // STRUCTURE rather than in prose — a note is exactly what a consumer skips, and the risk is
      // a loud health result being read as a preflight pass.
      //
      // A schema error would also close this. It is not taken because a structural carrier is more
      // forgiving to an exploring agent: `earn_status` stays answerable in every state, including
      // a malformed call. This is NOT rejected on the must-never-throw rule below — that rule governs
      // a RUNTIME failure on the health path (a dead RPC must yield a verdict, not an exception),
      // whereas a partial-args call is an INPUT problem settled by the CLI's schema check (`src/cli.ts`)
      // before the handler body runs. The two are different layers, and conflating them would license
      // "never validate inputs on a path that must not throw", which is not the rule.
      //
      // Only the account-missing case is "partial": `vault` HAS a default (documented as "omit for
      // the default vault" across the whole tool surface), `account` has none. So {account, no vault}
      // is a complete preflight against the default, not a partial call.
      const partial = symbol !== undefined ? { requested: "preflight", missing: ["account"] } : {};
      const vault = supportedVault(symbol, chain);
      const src = rpcSourceForEnv(vault.chainId);
      const base = {
        mode: "health",
        ...partial,
        server: "treasury",
        version: PACKAGE_VERSION,
        registry: { schemaVersion: loadRegistry().schemaVersion, vaults: loadRegistry().vaults.length, reconciledAtIso: loadRegistry().reconciledAtIso },
        ...onChain(vault),
        rpcSource: src.source,
        rpcConfigured: src.configured,
      };
      // 🔴 The health path RETURNS a verdict when the RPC is unreachable. It must never throw: a
      // tool that throws on a dead RPC answers nothing, which is the whole point of having it.
      try {
        const info = CHAIN_INFO[vault.chainId];
        const url = rpcUrlFromEnv(vault.chainId);
        const client = makePublicClient(vault.chainId, url);
        // Two chains mean two RPC variables, and one pointed at the other chain is the likeliest
        // mistake. Asked only of an endpoint the operator configured, alongside the block read, and
        // bounded — so a healthy answer is never held up waiting for a second one.
        const logsSrc = logsRpcSourceForEnv(vault.chainId);
        const logsUrl = logsRpcUrlFromEnv(vault.chainId);
        const separateLogs = logsUrl !== url;
        const [said, logsSaid, latest] = await Promise.all([
          src.configured ? endpointChainId(client, url) : Promise.resolve(undefined),
          separateLogs ? endpointChainId(makePublicClient(vault.chainId, logsUrl), logsUrl) : Promise.resolve(undefined),
          client.getBlockNumber(),
        ]);
        // The endpoint `earn_balance` scans through is a different variable, and it can be wrong on
        // its own. Reported beside the main verdict, only when it IS a separate endpoint.
        const logs = separateLogs
          ? {
              logsRpcSource: logsSrc.source,
              logsRpc: logsSaid === undefined ? "unreachable" : logsSaid === vault.chainId ? "ok" : "wrong_chain",
              ...(logsSaid !== undefined && logsSaid !== vault.chainId ? { logsRpcChainId: logsSaid } : {}),
            }
          : {};
        if (said !== undefined && said !== vault.chainId) {
          return text(
            {
              ...base,
              rpc: "wrong_chain",
              rpcChainId: said,
              latestBlock: null,
              reason: `the endpoint in ${src.source} answers for chain ${said}, not ${info.name} (${vault.chainId}). Point ${info.rpcEnv[0]} at an endpoint for ${info.name}; until then no read for this chain can be trusted.`,
              ...logs,
            },
            vault.chainId,
          );
        }
        // `chainVerified` is the difference between "it answered, and for this chain" and "it
        // answered a block number, and did not say which chain". Present only for a configured endpoint.
        const verified = src.configured ? { chainVerified: said === vault.chainId } : {};
        return text({ ...base, rpc: "ok", ...verified, latestBlock: latest.toString(), ...logs }, vault.chainId);
      } catch (e) {
        const reason = redactEndpoints(e instanceof Error ? e.message : String(e));
        return text({ ...base, rpc: "unreachable", latestBlock: null, reason }, vault.chainId);
      }
    }),
  );

  register(
    "earn_quote",
    {
      title: "Quote a deposit or a withdrawal",
      description:
        "Pre-trade quote, in USDC. direction=deposit: expected shares (previewDeposit), share price, and the access verdict from a simulated deposit(). This client quotes no rate: an ERC-4626 vault exposes none, and it calls no yield API. direction=withdraw: shares burned (previewWithdraw), shares held, a simulated withdraw() verdict, `instantLiquidity` — the vault's own liquid balance of the asset, which is chassis-specific in BOTH directions: a Fusion vault without instant-withdrawal fuses pays only from it, so there it is the ceiling maxWithdraw() does not know; a Morpho V2 vault holds almost none and still pays out of its markets, so there it is near zero and NOT a ceiling — the simulated verdict is what decides — maxWithdraw advisory only (Morpho V2 returns 0 by design), and queue depth. Run before the matching earn_prepare_* tool.",
      inputSchema: {
        vault: vaultArg,
        chain,
        account: accountArg,
        amount_usdc: amountArg,
        direction: z.enum(["deposit", "withdraw"]).describe("which side to quote — required, there is no default"),
      },
    },
    guarded(async ({ vault: symbol, chain, account, amount_usdc, direction }) => {
      const { vault, client, endpoints } = clientFor(symbol, chain);
      // 🔴 The tag is emitted from INSIDE each branch, beside the fields that branch produces —
      // never `{ direction, ...quote }` from the input argument. Measured in review: with the tag
      // taken from the input, swapping these two branches left `tsc -b` clean and all 61 tests
      // passing, and the result read `{ direction: "deposit", sharesToBurn: … }` — the tag said
      // deposit while the body was a withdrawal. A guard derived from the wrong side of the thing
      // it guards cannot detect the bug it exists for. Emitted here, tag and body are consistent
      // BY CONSTRUCTION; a swapped route is then wrong about the REQUEST, which the handler test
      // catches by asserting requested === returned, and never lying about the BODY.
      if (direction === "deposit") {
        return text(
          {
            direction: "deposit" as const,
            ...onChain(vault),
            ...commitsMoney(vault),
            ...(await onItsChain(vault, endpoints, () => quoteDeposit({ vault, depositor: account, assetsHuman: amount_usdc, client }))),
          },
          vault.chainId,
        );
      }
      return text({ direction: "withdraw" as const, ...onChain(vault), ...(await onItsChain(vault, endpoints, () => quoteWithdraw({ vault, owner: account, assetsHuman: amount_usdc, client }))) }, vault.chainId);
    }),
  );

  register(
    "earn_prepare_deposit",
    {
      title: "Prepare an unsigned deposit",
      description:
        "Returns the UNSIGNED calls for a deposit — [approve(asset → vault), deposit(assets, receiver)] — inside an envelope with requires_signature: true. Amount is USDC. The envelope names the `chain` and `chainId` the calls are for: say which chain to the operator, and if they have not chosen one, ask before calling this. NOTHING IS SUBMITTED: hand the calls to a signer in order. This tool cannot sign or send, and the deposit has not happened until the signer's transactions confirm. Each call also carries `function` and `args` — the same call `data` encodes, decoded, e.g. `approve(address spender, uint256 value)` with `{ spender, value }` — so an operator without a CLI signer can fill a block explorer's Write Contract form directly. `args` values are RAW contract units, which is what the form takes; `description` is the human sentence.",
      inputSchema: {
        vault: vaultArg,
        chain,
        account: accountArg.describe("the depositing account — the one that signs both calls; step 2's allowance precondition is read for it"),
        amount_usdc: amountArg,
        receiver: addressArg.describe("where the SHARES land — usually the account, not necessarily"),
      },
    },
    guarded(async ({ vault: symbol, chain, account, amount_usdc, receiver }) => {
      const vault = supportedVault(symbol, chain);
      return unsigned(buildDeposit(vault, { assetsHuman: amount_usdc, receiver, account }), vault, "deposit");
    }),
  );

  register(
    "earn_prepare_withdraw",
    {
      title: "Prepare an unsigned withdrawal",
      description:
        "Returns the UNSIGNED call for a withdrawal in USDC terms — withdraw(assets, receiver, owner) — inside an envelope with requires_signature: true, which names the `chain` the call is for: a position is withdrawn on the chain it is on, so name the vault (or its chain) and never ask the operator to choose one. To empty the account pass all=true with shares_exact copied verbatim from earn_balance.sharesExact (redeem of the exact balance; never a rounded number). NOTHING IS SUBMITTED and no funds have moved until a signer confirms. Each call also carries `function` and `args` — the same call `data` encodes, decoded, e.g. `approve(address spender, uint256 value)` with `{ spender, value }` — so an operator without a CLI signer can fill a block explorer's Write Contract form directly. `args` values are RAW contract units, which is what the form takes; `description` is the human sentence.",
      inputSchema: {
        vault: vaultArg,
        chain,
        receiver: addressArg.describe("where the USDC lands — NOT necessarily the account"),
        account: accountArg.describe("whose shares are burnt"),
        amount_usdc: amountArg.optional(),
        all: z.boolean().optional(),
        shares_exact: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      },
    },
    guarded(async ({ vault: symbol, chain, receiver, account, amount_usdc, all, shares_exact }) => {
      const vault = supportedVault(symbol, chain);
      // ⚠️ `receiver` and `account` are DIFFERENT slots and both are addresses, so a transposition
      // here type-checks. `account` is the owner whose shares burn; `receiver` is the payee.
      if (all) {
        if (!shares_exact) throw new Error("all=true requires shares_exact (copy earn_balance.sharesExact verbatim)");
        return unsigned(buildWithdraw(vault, { receiver, owner: account, all: true, sharesExact: shares_exact }), vault, "withdraw");
      }
      if (!amount_usdc) throw new Error("provide amount_usdc, or all=true with shares_exact");
      return unsigned(buildWithdraw(vault, { receiver, owner: account, assetsHuman: amount_usdc }), vault, "withdraw");
    }),
  );

  register(
    "earn_balance",
    {
      title: "Earn position",
      description:
        "A position in ONE vault, on that vault's chain (`chain` in the result) — an account's positions on different chains are separate calls. Shares held (exact string + display), current USDC value, WHAT CAN ACTUALLY BE WITHDRAWN NOW (`exit`, measured by simulating the withdrawal — `usdcValue` is what the position is worth, `exit.exitableNow` is what the vault can pay, `exit.instantLiquidity` is the vault's own liquid balance of the asset, chassis-specific in both directions — a Fusion vault without instant-withdrawal fuses pays only from it, so there it is the ceiling and `usdcValue` can exceed `exitableNow` by 10x while `maxWithdraw()` — `exit.maxWithdrawSays` — reports the larger one; a Morpho V2 vault holds almost none and still pays out of its markets, so there a near-zero `instantLiquidity` is not a ceiling and `exitableNow` is the verdict), entry basis and accrued yield derived from the vault's own Deposit/Withdraw events for this account, and share price. `scan.complete` says whether the event window covered the whole position; `sharesExact` is what earn_prepare_withdraw({ all }) needs. `scan.depositTxs` and `scan.withdrawTxs` carry the transactions behind those events — `{ txHash, blockNumber, amountUsdc }`, oldest first — so an operator can be shown an explorer link without anyone rebuilding the log query; each list holds at most the 100 most recent, while `scan.deposits`/`scan.withdrawals` stay the totals.",
      inputSchema: {
        vault: vaultArg,
        chain,
        account: accountArg,
        lookback_blocks: z.number().int().positive().optional().describe("how far back to scan for Deposit/Withdraw events; default: from the vault's deployment block, i.e. the whole history. The EFFECTIVE window is max_log_requests × the provider's eth_getLogs cap (Alchemy free 10 blocks, Base public 2,000, Infura on Arbitrum 10,000); if the configured RPC cannot cover it, the chain's public endpoint serves the scan and scan.source says so"),
        max_log_requests: z.number().int().positive().max(400).optional().describe("cap on eth_getLogs calls per event per scan; default 100 (= 1,000 blocks on Alchemy free, 200,000 on Base public). scan.wholeHistory says whether the scan actually covered every block since the vault was deployed — scan.complete alone is only a reconciliation and can be vacuously true. For an older vault, a provider with a wide eth_getLogs range (TREASURY_LOGS_RPC_BASE, or TREASURY_LOGS_RPC_ARBITRUM on Arbitrum) is what makes it whole"),
      },
    },
    guarded(async ({ vault: symbol, chain, account, lookback_blocks, max_log_requests }) => {
      const vault = supportedVault(symbol, chain);
      const logsUrl = logsRpcUrlFromEnv(vault.chainId);
      const client = makePublicClient(vault.chainId, logsUrl);
      // `logsFallbackUrlFromEnv` returns undefined when the operator opted out or when the fallback
      // would be the primary itself — the wiring is a one-liner precisely so it can be unit-tested
      // (measured in review: mutating this line to `undefined` left every position-layer test green;
      // `commands.unit.test.ts` is what fails now).
      const fallbackUrl = logsFallbackUrlFromEnv(vault.chainId, logsUrl);
      const fallbackClient = fallbackUrl === undefined ? undefined : makePublicClient(vault.chainId, fallbackUrl);
      // Every endpoint this read can go through: the logs RPC, and the fallback when the operator
      // named one. A fallback on the wrong chain answers an event scan with an EMPTY list, which
      // would be reported as a history that was read in full.
      const endpoints: Endpoint[] = [{ client, url: logsUrl, source: logsRpcSourceForEnv(vault.chainId).source }];
      if (fallbackClient && fallbackUrl !== undefined) endpoints.push({ client: fallbackClient, url: fallbackUrl, source: "TREASURY_LOGS_FALLBACK" });
      const position = await onItsChain(vault, endpoints, () =>
        getPosition({
          vault,
          principal: account,
          client,
          ...(fallbackClient ? { fallbackClient } : {}),
          ...(lookback_blocks === undefined ? {} : { lookbackBlocks: BigInt(lookback_blocks) }),
          ...(max_log_requests === undefined ? {} : { maxLogRequests: max_log_requests }),
        }),
      );
      return text({ ...onChain(vault), ...position }, vault.chainId);
    }),
  );

  register(
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

  return commands;
}

/**
 * Agent Treasury — the earn commands (earn skill), run headless by `src/cli.ts` as `treasury earn <command>`.
 *
 * Read commands, quotes, and UNSIGNED call builders only. There is no `sign` and no `send` command, and
 * there will not be one here: the skill supplies intent, the consumer supplies the signer. Anything
 * that holds a key lives outside this process and receives the calls these commands emit.
 *
 * Nine commands. Each is keyed by its tool name, `earn_`-prefixed so later skills can sit beside it
 * in one namespace; on the command line `earn_quote` is `treasury earn quote`:
 *
 *   earn_vaults    earn_terms     earn_quote (direction)   earn_status (no args = health)
 *   earn_balance   earn_prepare_deposit   earn_prepare_withdraw   earn_submit   earn_request
 *
 * On an EVM chain every command reads or acts through the Tempora API (its MCP endpoint, `./api.ts`): `vault` is the
 * vault's contract address or its ticker, which only picks the API's row, and every fact about a vault is the API's. The owner calls act for the CONNECTED wallet only,
 * signed in through the same page `invest` uses. A prepare command starts a request with the API and returns its steps
 * unsigned, each checked first by the client's own `checkSteps` (`./request.ts`); the operator's wallet sends a step,
 * and `earn_submit` hands its transaction hash back. A vault on Solana is still read and built from the registry and
 * its own chain (`./solana.ts`).
 *
 * Three contracts worth stating here because they are easy to erode:
 *
 * 1. `earn_prepare_*` return an ENVELOPE, `{ requires_signature, status: "unsigned", steps }` (`calls`, or one
 *    `transaction`, on Solana), never a bare array. This cannot stop a model reporting "deposited" — nothing at this
 *    boundary can — but it makes an unsigned request structurally distinguishable from a completed one, so a consumer
 *    or a test can assert on it.
 * 2. The address argument is `account` everywhere. It was `depositor`, `owner` and `principal` in three different
 *    tools. On an EVM chain it can only be the connected wallet, which owns the shares and receives the asset;
 *    `receiver` is taken only on Solana, where it must be the account itself.
 * 3. A vault lives on ONE chain, and every tool that takes `vault` also takes `chain`. Naming a chain alone selects
 *    that chain's default vault; naming both and having them disagree is refused (`resolveProduct`, and
 *    `resolveAnyVault` on Solana), never settled by picking one. Every response that names a vault says which chain it
 *    is on, because a prepared step is only correct on that chain.
 */
import { z } from "zod";
import { redactEndpoints, registerSecretSource } from "../redact.js";
import { isAddress, getAddress } from "viem";
import { solanaPublicRpcHint } from "../client.js";
import { isAddress as isSolanaAddress } from "@solana/kit";
import { onSolana, solanaBalance, solanaHealth, solanaPrepareDeposit, solanaPrepareWithdraw, solanaPreflight, solanaQuoteDeposit, solanaQuoteWithdraw, solanaVaultRow } from "./solana.js";
import { CHAIN_INFO, resolvedRpcSecrets, publicRpcHint, supportedChainIds, type SupportedChainId } from "../client.js";
import { defaultChainId, depositableSolanaVaults, listSolanaVaults, listVaults, offeredChainKeys, resolveAnyVault } from "../registry.js";
import type { VaultEntry } from "../registry-schema.js";
import { PACKAGE_VERSION } from "../version.js";
import { DISCLOSURES } from "../disclosures.js";
import { formatUnits, type Address } from "viem";
import type { Client, Product, Request, Result, WithdrawBody } from "@temporalabs/client";
import type { McpClient } from "@temporalabs/client/mcp";
import { readSession } from "../connect/session.js";
import { apiClient, apiUrl, failure, notConnected, withOwner } from "../invest/api.js";
import { ownerWallet, type OwnerWallet, type WalletDeps } from "../invest/flow.js";
import { EARN } from "../config/earn.js";
import { assetsAmount, chainOf, knownChain, mcpClient, resolveProduct, vaultLabel, vaultNamed, vaultProducts, verifiedTerms, type VaultProduct } from "./api.js";
import { checkedSteps, depositIntent, intentOf, nextStep, SIGNER_RULES, uncheckedSteps, withdrawIntent, type WithdrawAmount } from "./request.js";
import { parseAmount } from "../units.js";

/**
 * An address, in either family's form: `0x…` for a vault on an EVM chain, base58 for a vault on Solana. Which
 * one a command needs depends on the vault, which is resolved after the arguments parse, so each handler checks
 * the family it got (the connected-wallet check for an EVM vault, `solanaAccount` in ./solana.ts) and refuses the other.
 */
const addressArg = z.string().refine((s) => isAddress(s) || isSolanaAddress(s), "must be an EVM address (0x…), or a Solana address for a vault on Solana");

const amountArg = z.string().regex(/^\d+(\.\d+)?$/, 'plain decimal amount of the vault\'s asset (USDC; USDG on Robinhood Chain), e.g. "25" or "12.5"');
/** `vault` on the commands that read through the Tempora API: its contract address or its ticker on an EVM chain, a ticker on Solana. */
const productArg = z
  .string()
  .optional()
  .describe(
    "the vault, as `earn vaults` lists it: on an EVM chain its contract address (`vault`, 0x…) or its `ticker` (e.g. tlCashPlusUSDC2B); on Solana its ticker. Omit for the default vault of `chain`, or of the default chain when `chain` is omitted too",
  );
/** `account` on the owner reads: the connected wallet, which is the only owner they act for. */
const ownerArg = addressArg
  .optional()
  .describe(
    "the account whose shares these are — the depositor, the owner, the holder. On an EVM chain it is the connected wallet (`treasury connect wallet`), and may be left out; another account is refused. Required on Solana",
  );
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
    offered = offeredChainKeys();
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

/**
 * The chain a failed call was aimed at, for the setup hint — resolved from the call's own arguments
 * and never throwing: a call that failed BECAUSE its vault or chain did not resolve falls back to
 * the default chain, which is what the hint named before there was more than one.
 */
function hintChain(args: unknown): SupportedChainId | "solana" {
  try {
    const a = (args ?? {}) as { vault?: unknown; chain?: unknown };
    const t = resolveAnyVault(typeof a.vault === "string" ? a.vault : undefined, typeof a.chain === "string" ? a.chain : undefined);
    return t.family === "solana" ? "solana" : t.vault.chainId;
  } catch {
    return defaultChainId();
  }
}

/** The setup sentence for a transport failure on the chain's unconfigured public endpoint. */
const hintFor = (chain: SupportedChainId | "solana") => (chain === "solana" ? solanaPublicRpcHint() : publicRpcHint(chain));

/**
 * Shapes that mean "the transport failed", as opposed to a verdict about the vault. `HTTP error (429)` and
 * `HTTP error (5xx)` are how the Solana client reports a rate limit or a failing endpoint.
 */
const RPC_FAILURE = /RPC Request failed|HTTP request failed|HTTP error \((?:429|5\d\d)\)|reads failed|over rate limit|rate.?limit|"unreachable"|fetch failed|ETIMEDOUT|ECONNREFUSED/i;

/**
 * Serialise a tool result, and when the payload shows a TRANSPORT failure while no RPC is
 * configured, attach the one sentence that turns "this is broken" into "set this variable".
 * Attached as a FIELD rather than appended to prose, so a consumer can branch on it.
 */
const text = (v: unknown, chainId: SupportedChainId | "solana" = defaultChainId()) => {
  let body = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  if (RPC_FAILURE.test(body)) {
    const hint = hintFor(chainId);
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
const commitsMoney = (vault: Pick<VaultEntry, "warning"> | Pick<Product, "warnings">) => ("warnings" in vault ? { warnings: vault.warnings } : { warning: vault.warning });

/**
 * Every handler runs inside this. The CLI prints a thrown error's `.message` to the caller verbatim,
 * and viem's messages carry the transport URL — a keyed provider URL is a secret. Anything that
 * escapes a handler is re-thrown with endpoints masked.
 */
const guarded =
  <A extends unknown[], R>(fn: (...a: A) => Promise<R>, o: { api?: boolean } = {}) =>
  async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const redacted = redactEndpoints(msg);
      // A thrown transport error on the public endpoint gets the same sentence a returned one does. A command that reads
      // through the Tempora API reads no chain on an EVM chain, so the RPC sentence would name the wrong fix there.
      const hint = RPC_FAILURE.test(redacted) && (!o.api || isSolanaCall(a[0])) ? hintFor(hintChain(a[0])) : undefined;
      throw new Error(hint ? `${redacted}\n\n${hint}` : redacted);
    }
  };

/** Whether a call's own arguments name a vault on Solana, which is read from its chain rather than through the API. */
function isSolanaCall(args: unknown): boolean {
  const a = (args ?? {}) as { vault?: unknown; chain?: unknown };
  if (a.chain === onSolana.chain) return true;
  try {
    return typeof a.vault === "string" && listSolanaVaults().some((v) => v.symbol === a.vault);
  } catch {
    return false;
  }
}

/**
 * The Solana vault a call names, or `undefined` for a call that goes to the Tempora API: a Solana ticker, or
 * `chain: "solana"`. A vault the API lists, named with `chain: "solana"`, is refused rather than read on another chain.
 */
function solanaTarget(vault: string | undefined, chain: string | undefined) {
  if (!isSolanaCall({ vault, chain })) return undefined;
  if (chain === onSolana.chain && vault !== undefined && !listSolanaVaults().some((v) => v.symbol === vault) && !listVaults().some((v) => v.symbol === vault)) {
    throw new Error(`vault "${vault}" is not on solana. Name one or the other: drop \`chain\` to use ${vault}, or pick a vault on solana (${listSolanaVaults().map((v) => v.symbol).join(", ")}).`);
  }
  const t = resolveAnyVault(vault, chain);
  if (t.family !== "solana") throw new Error(`vault "${vault}" is not on solana`);
  return t.vault;
}

/** The refusal for `receiver` on an EVM vault, where the Tempora API pays only the owner. */
const noReceiver =
  "--receiver is taken only for a vault on Solana: on an EVM chain the shares and the asset always go to the connected wallet, and every step is checked to pay it. Leave --receiver out";

/** Re-exported for library consumers: what a signer must do for each step to land exactly once. */
export { SIGNER_RULES };

/** One JSON document, for an answer read from the Tempora API: no RPC was read, so no RPC setup sentence applies. */
const json = (v: unknown) => JSON.stringify(v, null, 2);

/** The Solana commands' `account`, which they still require. */
function solanaAccount(account: string | undefined): string {
  if (account === undefined) throw new Error("--account is required for a vault on Solana: the Solana account whose shares these are");
  return account;
}

/** One command: what `--help` prints, the arguments it takes, and the handler that answers with JSON text. */
export interface Command {
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: never) => Promise<string>;
}

/** What the commands reach outside this process, replaceable in tests: the API's clients, and the owner's wallet. */
export interface EarnDeps {
  /** The API's MCP endpoint, which every vault read goes through. */
  mcp?: McpClient;
  /** The API's HTTP client, for the sign-in only: it is not an MCP tool. */
  client?: Client;
  /** The owner's wallet for one command (tests pass one that answers without a page). */
  wallet?: (owner: Address, title: string) => OwnerWallet;
  walletDeps?: WalletDeps;
  now?: () => number;
}

/** What a response names about the vault it is about: its address, ticker and name, its status, and the chain it is on. */
const onProduct = (p: VaultProduct) => {
  const c = chainOf(p);
  return { ...vaultNamed(p), status: p.status, depositsOpen: p.status === "live", chain: c.chain, chainId: c.chainId };
};

/** An amount in raw units, with its decimals and the decimal string it reads as. */
const amountOut = (raw: bigint, decimals: number) => ({ raw: raw.toString(), decimals, amount: formatUnits(raw, decimals) });

export function buildCommands(deps: EarnDeps = {}): Record<string, Command> {
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
  const now = deps.now ?? Date.now;
  const mcp = () => deps.mcp ?? mcpClient();
  const products = (m: McpClient) => vaultProducts(m);
  const resolve = (all: readonly Product[], vault: string | undefined, c: string | undefined) => resolveProduct(all, vault, c, listSolanaVaults().length > 0);

  /**
   * The connected wallet: the only owner the API reads act for. An `account`, when given, must be it; a refusal is
   * decided here, before anything is asked of the API.
   */
  const connectedOwner = (account: string | undefined, chainArgument: string | undefined): Address => {
    knownChain(chainArgument, listSolanaVaults().length > 0);
    if (account !== undefined && !isAddress(account)) throw new Error(`account must be an EVM address (0x…) for a vault on an EVM chain; got ${account}`);
    const s = readSession();
    if (!s) throw notConnected();
    const owner = getAddress(s.account);
    if (account !== undefined && account.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `refused: account ${account} is not the connected wallet (${owner}). These reads act only for the connected wallet: leave --account out, or connect that wallet with \`treasury connect wallet\``,
      );
    }
    return owner;
  };

  /**
   * Runs one command's owner calls for the connected wallet, with the signing page opened only if a sign-in is needed,
   * and closed with the command's ending. `call` passes the owner's token to an MCP call, per call.
   */
  const asOwner = async <T>(
    owner: Address,
    run: (m: McpClient, call: <R>(fn: (m: McpClient, ownerToken: string) => Promise<Result<R>>) => Promise<Result<R>>) => Promise<T>,
  ): Promise<T> => {
    const w = deps.wallet ? deps.wallet(owner, "Earn: sign in") : ownerWallet(owner, "Earn: sign in", deps.walletDeps);
    const http = deps.client ?? apiClient();
    const m = mcp();
    const call = <R>(fn: (m: McpClient, ownerToken: string) => Promise<Result<R>>) => withOwner(owner, w.signIn, (token) => fn(m, token), { client: http, now });
    try {
      const v = await run(m, call);
      await w.finish({ ok: true, text: "Signed in. You can close this page." });
      return v;
    } catch (e) {
      await w.finish({ ok: false, reason: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
      throw e;
    }
  };

  /**
   * An unsigned request, as a prepare command returns it: never a bare list of calls. The chain FIRST (these steps are
   * correct on this chain and on no other), and the deposit's warnings before `next_step`, where a reader stops.
   */
  const envelope = (r: Request, p: VaultProduct, owner: Address, steps: ReturnType<typeof checkedSteps>, kind: "deposit" | "withdraw") => {
    const c = chainOf(p);
    return {
      requires_signature: true,
      status: "unsigned",
      chain: c.chain,
      chainId: c.chainId,
      ...(kind === "deposit" ? commitsMoney(p) : {}),
      ...vaultNamed(p),
      account: owner,
      requestId: r.requestId,
      state: r.state,
      expiresAt: r.expiresAt,
      steps,
      next_step: nextStep(r, p, owner, true),
      signer_rules: SIGNER_RULES,
    };
  };

  /**
   * A request read again: its states, and what to send only for a step checked against the request's own amount, the
   * vault the API lists and the connected wallet. A request for anything else is shown without anything to send.
   */
  const view = (r: Request, all: readonly Product[], owner: Address) => {
    const base = { requestId: r.requestId, action: r.action, state: r.state, expiresAt: r.expiresAt };
    const found = all.find((x): x is VaultProduct => x.id === r.chose.product && x.kind === "vault" && x.vault !== undefined);
    const intent = found ? intentOf(r, found, owner) : undefined;
    if (!found || !intent) {
      return {
        ...base,
        ...(found ? vaultNamed(found) : { vault: null }),
        checked: false,
        steps: uncheckedSteps(r),
        note: found
          ? "this request records no amount its steps can be checked against, so nothing from it is shown to send"
          : "this request is not for a vault the Tempora API lists, so nothing from it is shown to send (a portfolio's request is read with `treasury invest request`)",
      };
    }
    const c = chainOf(found);
    const steps = checkedSteps(r, found, intent);
    const ready = r.steps.some((s) => s.state === "ready" && (s as { payload?: unknown }).payload !== undefined);
    return {
      ...base,
      ...vaultNamed(found),
      chain: c.chain,
      chainId: c.chainId,
      ...(ready && r.action === "deposit" ? commitsMoney(found) : {}),
      checked: true,
      steps,
      next_step: nextStep(r, found, owner, false),
      ...(ready ? { signer_rules: SIGNER_RULES } : {}),
    };
  };

  register(
    "earn_vaults",
    {
      title: "List vaults",
      description:
        "Every vault the Tempora API lists now, on every EVM chain, plus the Solana vault this client reads from its own chain. `vault` is the value every other tool takes as `vault`: on an EVM chain the vault's contract address, and its `ticker` (null when it has none) is taken too; on Solana the ticker. `name` is its name; `chain` is the chain it is on, the value every other tool takes as `chain`; `status` is the API's: `live` takes deposits and withdrawals, `paused` takes withdrawals only (`depositsOpen: false`), anything else takes no deposit. Each row carries the vault's asset decimals, its terms version (`termsVersion`; `earn terms` shows the text), its fees, and `links` openable without any RPC endpoint, so an operator can verify the contract independently. SHOW `warnings` TO THE DEPOSITOR — every vault offered today is a test vault. `chains` lists the chains a deposit can go to, the default chain first, each with its own default vault (`default`, as `vault`, `ticker` and `name`; null unless the API lists it): if the operator has not said which chain, show them these and ASK before preparing a deposit. `default` is used when a tool is called with neither `vault` nor `chain`, and is on `defaultChain`; `depositable` is the subset taking deposits now, across all chains. Whether one account may deposit is the API's per-account gates: run `earn status` with the account before a deposit.",
      inputSchema: {},
    },
    guarded(async () => {
      const all = await products(mcp());
      const listed = all.filter((p): p is VaultProduct => p.vault !== undefined);
      /** The chain's default as the API lists it, or null: picked by its address, never replaced by another vault. */
      const defaultOn = (id: SupportedChainId): VaultProduct | null => {
        const d = EARN.defaultVaultAddressByChain[CHAIN_INFO[id].key].toLowerCase();
        const on = listed.filter((p) => p.vault.vaultAddress.toLowerCase() === d && chainOf(p).chainId === id);
        return on.length === 1 ? on[0]! : null;
      };
      const named = (p: VaultProduct | null) => (p === null ? null : vaultNamed(p));
      const solanaNamed = (v: { symbol: string; name: string }) => ({ vault: v.symbol, ticker: v.symbol, name: v.name });
      const evmChains = [defaultChainId(), ...supportedChainIds.filter((id) => id !== defaultChainId())]
        .filter((id) => listed.some((p) => chainOf(p).chainId === id))
        .map((id) => ({
          chain: CHAIN_INFO[id].key,
          chainId: id,
          name: CHAIN_INFO[id].name,
          default: named(defaultOn(id)),
          depositable: listed.filter((p) => chainOf(p).chainId === id && p.status === "live").map(vaultNamed),
        }));
      const solana = listSolanaVaults();
      return json({
        api: apiUrl(),
        defaultChain: CHAIN_INFO[defaultChainId()].key,
        default: named(defaultOn(defaultChainId())),
        depositable: [...listed.filter((p) => p.status === "live").map(vaultNamed), ...depositableSolanaVaults().map(solanaNamed)],
        chains: [
          ...evmChains,
          // Solana, when the registry has a vault there: no chain id; the cluster is in each Solana row.
          ...(solana.length === 0
            ? []
            : [{ chain: onSolana.chain, chainId: null, name: "Solana", default: solanaNamed(solana.find((v) => v.isDefault)!), defaultAccess: "open", depositable: depositableSolanaVaults().map(solanaNamed) }]),
        ],
        vaults: [
          ...listed.map((p) => ({
            ...vaultNamed(p),
            status: p.status,
            depositsOpen: p.status === "live",
            isDefault: chainOf(p).chainId !== null && defaultOn(chainOf(p).chainId as SupportedChainId) === p,
            ...chainOf(p),
            standard: p.vault.standard,
            vaultAddress: p.vault.vaultAddress,
            assetAddress: p.vault.assetAddress,
            assetDecimals: p.vault.assetDecimals,
            shareDecimals: p.vault.shareDecimals,
            termsVersion: p.vaultTerms?.version ?? null,
            fees: p.vaultFees ?? null,
            warnings: p.warnings,
            links: p.vaultLinks ?? null,
          })),
          ...solana.map((v) => ({ vault: v.symbol, ticker: v.symbol, ...solanaVaultRow(v) })),
        ],
      });
    }, { api: true }),
  );

  register(
    "earn_terms",
    {
      title: "Vault terms and pre-deposit disclosures",
      description:
        "The terms of one vault, as the Tempora API publishes them: `terms.text`, `terms.version` and `terms.sha256`. The text is hashed here (SHA-256 of its UTF-8 bytes) and refused when it does not match the sha256 the API sent with it. Show `terms.text` to the operator in full, with `disclosures`, and record their acknowledgement before building any deposit: a deposit is made against this exact version and sha256. On Solana, the disclosures alone.",
      inputSchema: { vault: productArg, chain },
    },
    guarded(async ({ vault, chain }) => {
      if (solanaTarget(vault, chain)) return text(DISCLOSURES, "solana");
      knownChain(chain, listSolanaVaults().length > 0);
      const p = resolve(await products(mcp()), vault, chain);
      const terms = verifiedTerms(p);
      return json({
        ...onProduct(p),
        terms,
        disclosures: DISCLOSURES,
        next_step: "Show `terms.text` to the operator in full, with `disclosures`, and get their explicit acceptance before preparing any deposit. A deposit is made against this exact `terms.version` and `terms.sha256`.",
      });
    }, { api: true }),
  );

  register(
    "earn_status",
    {
      title: "Health check, or an account's standing for a deposit",
      description:
        "With NO `account`: is the CLI working and the Tempora API reachable — `apiStatus` is `ok` or `unreachable` (with `reason`), and the vault the call resolves to, with its status and chain. With `account` (the connected wallet; another is refused): the API's view of that wallet on the vault — `standing`, every gate with its `status` and the vault's own `reason` VERBATIM (`gates`), the wallet's balance of the vault's asset and its allowance to the vault (`wallet`, raw units with `decimals`; null when it could not be read, never 0) — and, with `amount_usdc`, whether the vault would take that deposit (`deposit.check.state`: `open`, `holdings`, `not_admitted`, `refused`, `unsupported` or `unknown`, with `reason`). When no sign-in is kept, a local page opens for the operator's wallet to sign in to the API (no gas, nothing moves). On Solana it simulates the deposit transaction and reports OPEN_READY, NEEDS_FUNDS (the account lacks the USDC, or SOL for fees and rent), REVERTED_OTHER or UNRESOLVED. The `mode` field says which answer you got.",
      inputSchema: { vault: productArg, chain, account: ownerArg, amount_usdc: amountArg.optional() },
    },
    guarded(async ({ vault: symbol, chain, account, amount_usdc }) => {
      const v = solanaTarget(symbol, chain);
      if (v) {
        if (account !== undefined) {
          return text({ ...(await solanaPreflight(v, account, amount_usdc)), mode: "preflight", account, ...onSolana, ...commitsMoney(v) }, "solana");
        }
        return text(await solanaHealth(v, symbol !== undefined ? { requested: "preflight", missing: ["account"] } : {}), "solana");
      }
      if (account !== undefined) {
        const owner = connectedOwner(account, chain);
        const out = await asOwner(owner, async (m, call) => {
          const p = resolve(await products(m), symbol, chain);
          const amount = amount_usdc === undefined ? undefined : assetsAmount(p, amount_usdc);
          const a = await call((c, ownerToken) => c.account({ path: { product: p.id } }, { ownerToken }));
          if (!a.ok) throw failure(`The account on ${vaultLabel(p)} could not be read`, a);
          if (amount === undefined) return { p, a: a.body };
          const q = await call((c, ownerToken) => c.quote({ body: { product: p.id, action: "deposit", amount: amount.amount } }, { ownerToken }));
          if (!q.ok) throw failure(`The deposit into ${vaultLabel(p)} could not be checked`, q);
          if (!q.body.deposit) throw new Error(`the Tempora API answered a deposit quote for ${vaultLabel(p)} without a deposit`);
          return { p, a: a.body, deposit: { amount: amountOut(amount.raw, p.vault.assetDecimals), check: q.body.deposit.check, block: q.body.block, asOf: q.body.asOf } };
        });
        const wallet = out.a.account.wallet;
        return json({
          mode: "preflight",
          account: owner,
          ...onProduct(out.p),
          ...commitsMoney(out.p),
          standing: out.a.standing,
          gates: out.a.gates,
          wallet: wallet ?? null,
          alerts: out.a.alerts,
          ...(out.deposit ? { deposit: out.deposit } : {}),
        });
      }
      // Health. A partial call (a vault but no account) is answered here too, and says so in STRUCTURE rather than in
      // prose: a note is exactly what a consumer skips, and the risk is a health result being read as a pass. Only the
      // account-missing case is "partial": `vault` has a default, `account` does not.
      knownChain(chain, listSolanaVaults().length > 0);
      const partial = symbol !== undefined ? { requested: "preflight", missing: ["account"] } : {};
      const base = { mode: "health", ...partial, server: "treasury", version: PACKAGE_VERSION, api: apiUrl() };
      // 🔴 The health path RETURNS a verdict when the API cannot be reached. It must never throw for that: a check that
      // throws when the thing it checks is down answers nothing.
      let all: Product[];
      try {
        all = await products(mcp());
      } catch (e) {
        return json({ ...base, apiStatus: "unreachable", reason: redactEndpoints(e instanceof Error ? e.message : String(e)) });
      }
      // A vault or chain that does not resolve is the call's own problem, and is refused as one.
      const p = resolve(all, symbol, chain);
      return json({ ...base, apiStatus: "ok", vaultsListed: all.length, ...onProduct(p) });
    }, { api: true }),
  );

  register(
    "earn_quote",
    {
      title: "Quote a deposit or a withdrawal",
      description:
        "Pre-trade quote from the Tempora API, in the vault's asset (USDC; USDG on Robinhood Chain), for the connected wallet, read and simulated at one block (`block`). direction=deposit (`amount_usdc` required): `expectedShares` and `sharePrice` (raw, with decimals), and whether the vault would take it (`check.state`: `open`, `holdings`, `not_admitted`, `refused`, `unsupported` or `unknown`, with the vault's own `reason`). This client quotes no rate. direction=withdraw: the wallet's `position` (shares, and their value in the asset), and how much of it can be withdrawn now (`withdrawable.state`: `all`, `partial`, `refused` or `unknown`, with `assets`, `within` and `reason`), found by simulating withdrawals. Advice only: the request decides. Run before the matching `earn prepare_*` command. On Solana, the quote is read from the chain.",
      inputSchema: {
        vault: productArg,
        chain,
        account: ownerArg,
        amount_usdc: amountArg.optional().describe("the amount of the vault's asset; required for a deposit quote"),
        direction: z.enum(["deposit", "withdraw"]).describe("which side to quote — required, there is no default"),
      },
    },
    guarded(async ({ vault: symbol, chain, account, amount_usdc, direction }) => {
      const v = solanaTarget(symbol, chain);
      if (v) {
        const a = solanaAccount(account);
        if (amount_usdc === undefined) throw new Error("--amount_usdc is required for a quote on Solana");
        if (direction === "deposit") return text({ direction: "deposit" as const, ...onSolana, ...commitsMoney(v), ...(await solanaQuoteDeposit(v, a, amount_usdc)) }, "solana");
        return text({ direction: "withdraw" as const, ...onSolana, ...(await solanaQuoteWithdraw(v, a, amount_usdc)) }, "solana");
      }
      if (direction === "deposit" && amount_usdc === undefined) throw new Error("--amount_usdc is required for a deposit quote");
      const owner = connectedOwner(account, chain);
      // 🔴 The tag is emitted from INSIDE each branch, beside the fields that branch produces — never
      // `{ direction, ...quote }` from the input argument. With the tag taken from the input, swapping the two branches
      // passed every test while the result said deposit over a withdrawal's body. Emitted here, tag and body agree BY
      // CONSTRUCTION; a swapped route is then wrong about the REQUEST, which the handler test catches.
      return json(
        await asOwner(owner, async (m, call) => {
          const p = resolve(await products(m), symbol, chain);
          const amount = amount_usdc === undefined ? undefined : assetsAmount(p, amount_usdc);
          if (direction === "deposit") {
            const q = await call((c, ownerToken) => c.quote({ body: { product: p.id, action: "deposit", amount: amount!.amount } }, { ownerToken }));
            if (!q.ok) throw failure(`The deposit into ${vaultLabel(p)} could not be quoted`, q);
            const d = q.body.deposit;
            if (!d) throw new Error(`the Tempora API answered a deposit quote for ${vaultLabel(p)} without a deposit`);
            return {
              direction: "deposit" as const,
              ...onProduct(p),
              ...commitsMoney(p),
              account: owner,
              amount: amountOut(amount!.raw, p.vault.assetDecimals),
              expectedShares: d.expectedShares,
              sharePrice: d.sharePrice,
              check: d.check,
              block: q.body.block,
              asOf: q.body.asOf,
            };
          }
          const q = await call((c, ownerToken) => c.quote({ body: { product: p.id, action: "withdraw", ...(amount ? { amount: amount.amount } : {}) } }, { ownerToken }));
          if (!q.ok) throw failure(`The withdrawal from ${vaultLabel(p)} could not be quoted`, q);
          const w = q.body.withdraw;
          if (!w) throw new Error(`the Tempora API answered a withdrawal quote for ${vaultLabel(p)} without a withdrawal`);
          return {
            direction: "withdraw" as const,
            ...onProduct(p),
            account: owner,
            ...(amount ? { amount: amountOut(amount.raw, p.vault.assetDecimals) } : {}),
            position: w.position,
            withdrawable: w.withdrawable,
            block: q.body.block,
            asOf: q.body.asOf,
          };
        }),
      );
    }, { api: true }),
  );

  register(
    "earn_prepare_deposit",
    {
      title: "Prepare an unsigned deposit",
      description:
        "Starts a deposit with the Tempora API for the connected wallet and returns its UNSIGNED steps — on an EVM chain an approve of exactly the amount to the vault, then the deposit, ONE unsigned transaction (`transaction.wire`) on Solana — inside an envelope with requires_signature: true. Amount is in the vault's asset — USDC, or USDG on Robinhood Chain; `amount_usdc` keeps its name for every asset. On an EVM chain `terms_sha256` is required: the sha256 `earn terms` showed for the terms the operator accepted; terms that changed since are refused, and must be shown again. Every step is checked before it is returned: the approval only to the vault's asset with the vault as spender, the deposit only into the vault paying the shares to the connected wallet, both for exactly the amount. The envelope names the `chain` and `chainId` the steps are for: say which chain to the operator, and if they have not chosen one, ask before calling this. NOTHING IS SUBMITTED: send a step that is `ready` from the connected wallet, then `earn submit` its transaction hash; a step that is `waiting` (the deposit, until the approval is submitted) is read again with `earn request`. This tool cannot sign or send, and the deposit has not happened until the steps confirm. Each step with something to send also carries `function` and `args` — the same call `data` encodes, decoded, e.g. `approve(address spender, uint256 value)` with `{ spender, value }` — so an operator without a CLI signer can fill a block explorer's Write Contract form directly. `args` values are RAW contract units, which is what the form takes; `description` is the human sentence, read from the calldata.",
      inputSchema: {
        vault: productArg,
        chain,
        account: ownerArg,
        amount_usdc: amountArg,
        terms_sha256: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .optional()
          .describe("the `terms.sha256` from `earn terms` for the terms the operator was shown and accepted; required for a vault on an EVM chain"),
        receiver: addressArg.optional().describe("on Solana only, where the shares land: the account itself, the default. On an EVM chain the shares always go to the connected wallet, and this is refused"),
      },
    },
    guarded(async ({ vault: symbol, chain, account, amount_usdc, terms_sha256, receiver }) => {
      const v = solanaTarget(symbol, chain);
      if (v) {
        const a = solanaAccount(account);
        // The warning before `next_step`, through the chokepoint, exactly as on EVM.
        const { requires_signature, status, ...rest } = await solanaPrepareDeposit(v, a, amount_usdc, receiver ?? a);
        return text({ requires_signature, status, ...onSolana, ...commitsMoney(v), ...rest }, "solana");
      }
      knownChain(chain, listSolanaVaults().length > 0);
      if (receiver !== undefined) throw new Error(noReceiver);
      if (terms_sha256 === undefined) throw new Error("--terms_sha256 is required: run `treasury earn terms`, show the operator the terms, and pass the `terms.sha256` they accepted");
      const owner = connectedOwner(account, chain);
      return json(
        await asOwner(owner, async (m, call) => {
          const p = resolve(await products(m), symbol, chain);
          const terms = verifiedTerms(p);
          if (terms_sha256.toLowerCase() !== terms.sha256) {
            throw new Error(
              `refused: the terms of ${vaultLabel(p)} changed since the operator read them (now version ${terms.version}, sha256 ${terms.sha256}). Show them again with \`treasury earn terms\`, and pass the sha256 the operator accepts`,
            );
          }
          const amount = assetsAmount(p, amount_usdc);
          const r = await call((c, ownerToken) => c.deposit({ body: { product: p.id, amount: amount.amount, vaultTerms: { version: terms.version, sha256: terms.sha256 } } }, { ownerToken }));
          if (!r.ok) throw failure(`The API did not start the deposit into ${vaultLabel(p)}`, r);
          const steps = checkedSteps(r.body, p, depositIntent(p, owner, amount.raw));
          return envelope(r.body, p, owner, steps, "deposit");
        }),
      );
    }, { api: true }),
  );

  register(
    "earn_prepare_withdraw",
    {
      title: "Prepare an unsigned withdrawal",
      description:
        "Starts a withdrawal with the Tempora API for the connected wallet and returns its UNSIGNED step — on an EVM chain a withdraw or redeem from the vault, ONE unsigned transaction (`transaction.wire`) on Solana — inside an envelope with requires_signature: true, which names the `chain` the step is for: a position is withdrawn on the chain it is on, so name the vault (or its chain) and never ask the operator to choose one. On an EVM chain give exactly one of: --amount_usdc (an amount of the vault's asset), --all (a switch: everything, as a redeem of every share), or --shares_exact (a number of shares, copied verbatim from `sharesExact` in `earn balance`; never a rounded number). The step is checked before it is returned: only from the vault, paid to and owned by the connected wallet, for exactly the amount asked. NOTHING IS SUBMITTED: send the step from the connected wallet, then `earn submit` its transaction hash. On Solana, --all goes with --shares_exact, and --receiver must be the account itself. Each step with something to send also carries `function` and `args` — the same call `data` encodes, decoded, e.g. `approve(address spender, uint256 value)` with `{ spender, value }` — so an operator without a CLI signer can fill a block explorer's Write Contract form directly. `args` values are RAW contract units, which is what the form takes; `description` is the human sentence, read from the calldata.",
      inputSchema: {
        vault: productArg,
        chain,
        receiver: addressArg.optional().describe("on Solana only, where the asset lands: the account itself, the default. On an EVM chain the asset always goes to the connected wallet, and this is refused"),
        account: ownerArg,
        amount_usdc: amountArg.optional(),
        all: z.boolean().optional(),
        shares_exact: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      },
    },
    guarded(async ({ vault: symbol, chain, receiver, account, amount_usdc, all, shares_exact }) => {
      const v = solanaTarget(symbol, chain);
      if (v) {
        if (all && amount_usdc) throw new Error("give --amount_usdc or --all with --shares_exact, not both");
        if (!all && shares_exact) throw new Error("--shares_exact goes with --all; for an amount in the asset, use --amount_usdc alone");
        if (all && !shares_exact) throw new Error("--all requires --shares_exact (copy sharesExact from `earn balance` verbatim)");
        if (!all && !amount_usdc) throw new Error("provide --amount_usdc, or --all with --shares_exact");
        const a = solanaAccount(account);
        return text(await solanaPrepareWithdraw(v, a, receiver ?? a, all ? { sharesExact: shares_exact! } : { amountHuman: amount_usdc! }), "solana");
      }
      knownChain(chain, listSolanaVaults().length > 0);
      if (receiver !== undefined) throw new Error(noReceiver);
      const forms = [amount_usdc !== undefined && "--amount_usdc", all === true && "--all", shares_exact !== undefined && "--shares_exact"].filter((f): f is string => f !== false);
      if (forms.length !== 1) {
        throw new Error(`give exactly one of --amount_usdc, --all or --shares_exact${forms.length > 1 ? `, not ${forms.join(" and ")}` : ""}`);
      }
      const owner = connectedOwner(account, chain);
      return json(
        await asOwner(owner, async (m, call) => {
          const p = resolve(await products(m), symbol, chain);
          const form: { body: WithdrawBody["amount"]; intent: WithdrawAmount } =
            amount_usdc !== undefined
              ? (() => {
                  const a = assetsAmount(p, amount_usdc);
                  return { body: a.amount, intent: { kind: "assets", raw: a.amount.raw } };
                })()
              : shares_exact !== undefined
                ? (() => {
                    const raw = parseAmount(shares_exact, p.vault.shareDecimals, "--shares_exact").toString();
                    return { body: { kind: "shares", raw }, intent: { kind: "shares", raw } };
                  })()
                : { body: { kind: "all" }, intent: { kind: "all" } };
          const r = await call((c, ownerToken) => c.withdraw({ body: { product: p.id, amount: form.body } }, { ownerToken }));
          if (!r.ok) throw failure(`The API did not start the withdrawal from ${vaultLabel(p)}`, r);
          const steps = checkedSteps(r.body, p, withdrawIntent(p, owner, form.intent));
          return envelope(r.body, p, owner, steps, "withdraw");
        }),
      );
    }, { api: true }),
  );

  register(
    "earn_submit",
    {
      title: "Hand a sent step's transaction to the API",
      description:
        "Records with the Tempora API the transaction the connected wallet sent for one step of a request from `earn prepare_deposit` or `earn prepare_withdraw`: `request_id`, `step_id` and the `tx_hash`. The API reads the chain itself at that hash. Give --nonce and --from (the connected wallet) together, and --block if known, when the wallet reported them. Answers with the request: each step's state and the API's verification of a sent one, and, when a later step is now `ready`, that step checked and ready to send. A refusal names its code: never send the transaction again because of one; read the request with `earn request`. A page opens only when the wallet must sign in to the API.",
      inputSchema: {
        request_id: z.string().min(1).describe("the request's id, `requestId` in the envelope"),
        step_id: z.string().min(1).describe("the step the transaction was sent for, `stepId` in the envelope"),
        tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("the transaction hash the wallet returned"),
        nonce: z.string().regex(/^\d+$/).optional().describe("the transaction's nonce, as the wallet reported it; with --from"),
        from: addressArg.optional().describe("the address that sent it: the connected wallet; with --nonce"),
        block: z.string().regex(/^\d+$/).optional().describe("the block it was mined in, when known; with --nonce and --from"),
      },
    },
    guarded(async ({ request_id, step_id, tx_hash, nonce, from, block }) => {
      if ((nonce === undefined) !== (from === undefined)) throw new Error("give --nonce and --from together, or neither");
      if (block !== undefined && nonce === undefined) throw new Error("--block goes with --nonce and --from");
      if (from !== undefined && !isAddress(from)) throw new Error(`--from must be an EVM address (0x…); got ${from}`);
      const owner = connectedOwner(undefined, undefined);
      if (from !== undefined && from.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(`refused: --from ${from} is not the connected wallet (${owner}). A step is sent only from the connected wallet`);
      }
      const wallet = nonce !== undefined && from !== undefined ? { nonce, from: getAddress(from), blockNumber: block ?? null } : null;
      return json(
        await asOwner(owner, async (m, call) => {
          const all = await products(m);
          const r = await call((c, ownerToken) => c.submit({ path: { requestId: request_id, stepId: step_id }, body: { kind: "transaction", txHash: tx_hash, wallet } }, { ownerToken }));
          if (!r.ok) {
            throw new Error(
              `${failure(`The API did not record transaction ${tx_hash} for step ${step_id} of request ${request_id}`, r).message}. ` +
                `Do not send the transaction again: read the request with \`treasury earn request --request_id ${request_id}\``,
            );
          }
          try {
            return view(r.body, all, owner);
          } catch (e) {
            // The hash is recorded either way: say so, so the refusal of what comes next is never read as "send it again".
            throw new Error(`The API recorded transaction ${tx_hash} for step ${step_id}. ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
    }, { api: true }),
  );

  register(
    "earn_request",
    {
      title: "Read or cancel an earn request",
      description:
        "Reads one of the connected wallet's vault requests again, by `request_id` (from `earn prepare_deposit` or `earn prepare_withdraw`) or by the `tx_hash` of a transaction sent for it: its state, each step's state and the API's verification of a sent one, and a step that is now `ready` — checked against the request's own amount, the vault and the connected wallet before it is shown — with what to send. Give exactly one. With `cancel` true, cancels a request still waiting on the owner (nothing has moved for it). A page opens only when the wallet must sign in to the API.",
      inputSchema: {
        request_id: z.string().min(1).optional().describe("the request's id"),
        tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("the transaction hash of a step sent for the request"),
        cancel: z.boolean().optional().describe("true to cancel the request; it must be given by `request_id`"),
      },
    },
    guarded(async ({ request_id, tx_hash, cancel }) => {
      if ((request_id === undefined) === (tx_hash === undefined)) throw new Error("give exactly one of --request_id or --tx_hash");
      if (cancel && request_id === undefined) throw new Error("--cancel needs --request_id");
      const owner = connectedOwner(undefined, undefined);
      return json(
        await asOwner(owner, async (m, call) => {
          const all = await products(m);
          const r =
            cancel && request_id !== undefined
              ? await call((c, ownerToken) => c.cancel({ path: { requestId: request_id } }, { ownerToken }))
              : request_id !== undefined
                ? await call((c, ownerToken) => c.status({ path: { requestId: request_id } }, { ownerToken }))
                : await call((c, ownerToken) => c.status_lookup({ query: { txHash: tx_hash! } }, { ownerToken }));
          if (!r.ok) throw failure(cancel ? "The request could not be cancelled" : "The request could not be read", r);
          return view(r.body, all, owner);
        }),
      );
    }, { api: true }),
  );

  register(
    "earn_balance",
    {
      title: "Earn position",
      description:
        "The connected wallet's position in ONE vault, on that vault's chain (`chain` in the result), read from the Tempora API — positions on different chains are separate calls. `shares` is the exact share balance (raw, with `decimals`), and `sharesExact` the same number as a decimal string, never rounded; `value` is what it is worth in USD and how that was read (`value.state`); `withdrawable` is WHAT CAN ACTUALLY BE WITHDRAWN NOW, found by simulating withdrawals at `withdrawable.block` (`withdrawable.withdrawable.state`: `all`, `partial`, `refused` or `unknown`, with `assets` and `reason`; `basis: floor` means a lower bound), which can be less than the position's value; `stage` is the API's. A `stage` of `unknown` means the share balance could not be read: it is reported as `unknown`, never as 0. Entry basis and accrued yield are not available through the API (`basis` and `yield` say so). `position: \"none\"` means the API lists no position for this wallet in this vault. When no sign-in is kept, a local page opens for the operator's wallet to sign in to the API (no gas, nothing moves). On Solana: shares, value and what a full exit would pay now, read from the chain.",
      inputSchema: {
        vault: productArg,
        chain,
        account: ownerArg,
      },
    },
    guarded(async ({ vault: symbol, chain, account }) => {
      const v = solanaTarget(symbol, chain);
      if (v) return text({ ...onSolana, ...(await solanaBalance(v, solanaAccount(account))) }, "solana");
      const owner = connectedOwner(account, chain);
      return json(
        await asOwner(owner, async (m, call) => {
          const p = resolve(await products(m), symbol, chain);
          const r = await call((c, ownerToken) => c.positions({}, { ownerToken }));
          if (!r.ok) throw failure("The positions could not be read", r);
          const row = r.body.positions.find((x) => x.product === p.id && x.kind === "vault");
          const head = { ...onProduct(p), account: owner };
          if (!row) return { ...head, position: "none", note: `The Tempora API lists no position for ${owner} in ${vaultLabel(p)}.` };
          // A share balance the API could not read is `unknown`, never 0: a fault must not read as an empty position.
          const unread = row.stage === "unknown" || row.shares === undefined;
          return {
            ...head,
            stage: row.stage,
            shares: unread ? "unknown" : row.shares,
            sharesExact: unread ? "unknown" : formatUnits(BigInt(row.shares!.raw), row.shares!.decimals),
            value: row.value,
            withdrawable: row.withdrawable ?? "unknown",
            basis: "not available",
            yield: "not available",
          };
        }),
      );
    }, { api: true }),
  );

  return commands;
}

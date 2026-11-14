/**
 * A Smart Growth withdrawal: everything in the owner's smart account, paid to the owner's own wallet in USDT on BNB
 * Chain. The API prepares it as one or more EIP-712 authorizations, which the owner's wallet signs one at a time.
 *
 * Before each one reaches the wallet, every authorization in the request is held by the client's own check
 * (`checkPortfolioWithdrawal`) to the provider's withdrawal form exactly, on BNB Chain, debiting the owner's smart
 * account, paying the owner's own wallet, settling in USDT, expiring within `INVEST.maxAuthorizationLifetimeSeconds`,
 * matching the plan the API attached to it, and asking in total for no more of each asset than the account holds.
 *
 * The smart account and its holdings are read from the API's positions (`invest balance` shows the same), not from the
 * request: a request naming another smart account than the positions do is refused before anything is signed.
 */
import { checkPortfolioWithdrawal, type Position, type Request } from "@temporalabs/client";
import { formatUnits, getAddress, type Address } from "viem";
import { INVEST } from "../config/invest.js";
import { BNB_INFO, BNB_USDT, BNB_USDT_ASSET_ID } from "./chain.js";
import { INVEST_CHAIN_ID } from "./deposit.js";
import type { Prepared } from "./flow.js";

/**
 * The standard EIP-712 domain type, in the order the standard gives. A wallet signing through `eth_signTypedData_v4`
 * (MetaMask's own library, among others) does not derive it when it is missing: it signs an EMPTY domain, so the
 * signature would hold for any chain and any account. The API's authorizations leave it out; it is added here.
 */
const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** The typed data as the wallet must receive it: with its domain type, for the domain keys it carries. */
export function withDomainType(typedData: Record<string, unknown>): Record<string, unknown> {
  const types = { ...((typedData["types"] ?? {}) as Record<string, unknown>) };
  if (types["EIP712Domain"] === undefined) {
    const domain = (typedData["domain"] ?? {}) as Record<string, unknown>;
    types["EIP712Domain"] = DOMAIN_TYPE.filter((f) => domain[f.name] !== undefined).map((f) => ({ ...f }));
  }
  return { ...typedData, types };
}

/** The portfolio's position, from the API's positions: its smart account and what it holds. */
export interface Holding {
  smartAccount: Address;
  holdings: Record<string, string>;
  decimals: Record<string, number>;
}

export function holdingOf(positions: readonly Position[], product: string): Holding {
  const p = positions.find((x) => x.product === product && x.kind === "portfolio");
  if (!p) throw new Error(`refused: this wallet has no position in ${product}; nothing to withdraw`);
  if (typeof p.smartAccount !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.smartAccount)) {
    throw new Error(`refused: the API names no smart account for ${product}; nothing to withdraw`);
  }
  const holdings: Record<string, string> = {};
  const decimals: Record<string, number> = {};
  for (const b of p.balances) {
    holdings[b.assetId] = b.raw;
    decimals[b.assetId.toLowerCase()] = b.decimals;
  }
  return { smartAccount: getAddress(p.smartAccount), holdings, decimals };
}

/**
 * The portfolio id the authorizations name. The API's request does not carry it, so it is read from the first
 * authorization, and the check holds every other one to it. The account the signature debits is bound separately,
 * to the positions' smart account.
 */
export function portfolioIdOf(r: Request): string | undefined {
  for (const s of r.steps) {
    const m = (s as { payload?: { typedData?: { message?: { portfolioId?: unknown } } } }).payload?.typedData?.message;
    if (typeof m?.portfolioId === "string") return m.portfolioId;
  }
  return undefined;
}

export function checkWithdrawal(r: Request, owner: Address, h: Holding, now: number) {
  if (typeof r.smartAccount === "string" && r.smartAccount.toLowerCase() !== h.smartAccount.toLowerCase()) {
    return { ok: false as const, step: null, reason: `the request debits ${r.smartAccount}, not the smart account ${h.smartAccount} your positions name` };
  }
  return checkPortfolioWithdrawal(r.steps as never, {
    owner,
    smartAccount: h.smartAccount,
    portfolioId: portfolioIdOf(r) ?? "",
    chain: INVEST_CHAIN_ID,
    settlementAssetId: BNB_USDT_ASSET_ID,
    amount: { kind: "all" },
    holdings: h.holdings,
    now,
    maxLifetimeSeconds: INVEST.maxAuthorizationLifetimeSeconds,
  });
}

const amountText = (assetId: string, raw: string, h: Holding) => {
  const d = h.decimals[assetId.toLowerCase()];
  if (assetId.toLowerCase() === BNB_USDT_ASSET_ID.toLowerCase()) return `${formatUnits(BigInt(raw), BNB_USDT.decimals)} USDT`;
  return d === undefined ? `${raw} units of ${assetId}` : `${formatUnits(BigInt(raw), d)} of ${assetId}`;
};

/** What the page shows for one authorization, from its signed bytes as the check read them. */
export function prepareWithdrawal(r: Request, s: Request["steps"][number], owner: Address, h: Holding, product: string): Prepared {
  const step = s as { payload?: { typedData?: Record<string, unknown> }; manifest?: { index?: number; of?: number }; plan?: { liquidate?: unknown; assets?: unknown } };
  const typedData = step.payload?.typedData ?? {};
  const message = (typedData["message"] ?? {}) as { liquidate?: unknown; assets?: { assetId: string; amountRaw: string }[]; expiresAt?: unknown };
  const sale = message.liquidate === true;
  const n = r.steps.indexOf(s) + 1;
  return {
    view: {
      title: `Authorize withdrawal ${n} of ${r.steps.length}`,
      description: sale
        ? `Your wallet authorizes selling these holdings of your ${product} account for USDT, paid to your own wallet on ${BNB_INFO.name}.`
        : `Your wallet authorizes moving this USDT from your ${product} account to your own wallet on ${BNB_INFO.name}.`,
      facts: [
        ...(message.assets ?? []).map((a) => ({ label: sale ? "Sell" : "Move", value: amountText(a.assetId, a.amountRaw, h) })),
        { label: "From your smart account", value: h.smartAccount },
        { label: "Paid to your wallet", value: owner },
        { label: "Valid until", value: new Date(Number(message.expiresAt) * 1000).toISOString() },
      ],
    },
    ask: { kind: "sign_typed", typedData: withDomainType(typedData) },
  };
}

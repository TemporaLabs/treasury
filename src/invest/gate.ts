/**
 * The gate a portfolio withdrawal passes before the owner is asked to sign it. A withdrawal is
 * prepared by the service that holds the portfolio, as one or more EIP-712 authorizations
 * ("batches"). Nothing the service says about them is trusted: the gate reads each authorization
 * itself and holds it to what the owner asked for and to what the chain says the owner holds.
 *
 * Admitted, and nothing else:
 *   - each batch is the provider's `Withdrawal` struct exactly: its domain name and version, its
 *     field list and types, no field shown that is not signed and none signed that is not read;
 *   - on BNB Chain (56), debiting the owner's own smart account (`verifyingContract`), paying the
 *     owner's own wallet (`recipientAccountId` = `eip155:56:<owner>`), for the named portfolio;
 *   - a sale settles in USDT; a transfer moves only USDT. One withdrawal may hold both: the idle
 *     USDT as a plain transfer, then the holdings as sales;
 *   - every amount is a whole number of units, each asset entry carries exactly its two signed
 *     fields, and no batch names an asset twice;
 *   - it expires in the future, and no later than `INVEST.maxAuthorizationLifetimeSeconds` from now;
 *   - **the amounts are bounded by the chain, not by the service's plan.** The owner asks for `all`
 *     or a fraction of each holding. Each asset's total across every batch must be at most that
 *     fraction of the asset's `balanceOf` on the smart account, read through the owner's own RPC
 *     (`src/invest/chain.ts`). An asset the account does not hold is refused. A plan altered together
 *     with the authorizations is refused here, because the bound never came from the service.
 *
 * What this cannot check: the smart-account address itself comes from the service, so the bound is
 * as independent as that address. The harm is still bounded: the recipient must be the owner, and the
 * provider checks the signature against the portfolio's owner.
 *
 * Returns a summary built only from the signed bytes, for the acknowledgement, and a digest over the
 * full ordered set of batches, which the acknowledgement is bound to.
 */
import { concat, getAddress, hashTypedData, keccak256, type Address, type Hex, type TypedDataDefinition } from "viem";
import { INVEST } from "../config/invest.js";
import { BNB_INFO, BNB_USDT_ASSET_ID, tokenOf } from "./chain.js";

/** One EIP-712 authorization as the service returns it: untrusted until `admitWithdrawal` passes it. */
export interface WithdrawalAuthorization {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: unknown;
  message: Record<string, unknown>;
}

/** `all`, or a fraction of each holding as a decimal in (0, 1] with at most six places. */
export type WithdrawFraction = { all: true } | { all: false; num: bigint; den: bigint };

export interface WithdrawExpect {
  /** The connected wallet: the only recipient there is. */
  owner: Address;
  /** The smart account the service names for this portfolio. */
  smartAccount: Address;
  portfolioId: string;
  /** Raw `balanceOf` per token on the smart account, read on BNB Chain by the caller. */
  holdings: ReadonlyMap<Address, bigint>;
  now: number;
}

export interface AdmittedWithdrawal {
  /** Each batch's kind, in order. One withdrawal sends idle USDT as a plain transfer and sells the rest. */
  kinds: ("sale" | "transfer")[];
  /** Per asset, summed over every batch, from the signed amounts. */
  totals: { token: Address; amount: bigint; held: bigint }[];
  batches: number;
  /** The earliest expiry of any batch. */
  expiresAt: Date;
  /** keccak256 over each batch's EIP-712 hash, in order: the acknowledgement's binding. */
  digest: Hex;
}

const DOMAIN_NAME = "Glider Withdrawal Authorization";
const FIELDS = {
  transfer: ["portfolioId", "recipientAccountId", "assets", "nonce", "expiresAt"],
  sale: ["portfolioId", "recipientAccountId", "assets", "nonce", "expiresAt", "liquidate", "settlementAssetId"],
} as const;
const FIELD_TYPES: Record<string, string> = {
  portfolioId: "string",
  recipientAccountId: "string",
  assets: "WithdrawalAsset[]",
  nonce: "bytes32",
  expiresAt: "uint256",
  liquidate: "bool",
  settlementAssetId: "string",
};
const ASSET_TYPES: Record<string, string> = { assetId: "string", amountRaw: "string" };
const DOMAIN_FIELDS = ["chainId", "name", "verifyingContract", "version"];
const DOMAIN_TYPES: Record<string, string> = { name: "string", version: "string", chainId: "uint256", verifyingContract: "address" };
const FRACTION_PLACES = 6;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

function fieldsOf(list: unknown): { name: string; type: string }[] | null {
  if (!Array.isArray(list)) return null;
  const out = list.map((f) => (f && typeof f.name === "string" && typeof f.type === "string" ? { name: f.name as string, type: f.type as string } : null));
  return out.every((f) => f !== null) ? (out as { name: string; type: string }[]) : null;
}

/** `all`, or a decimal fraction such as `0.25`. Refuses 0, anything above 1, and more than six places. */
export function parseFraction(text: string): WithdrawFraction {
  const t = text.trim();
  if (t === "all") return { all: true };
  const m = new RegExp(`^(0|1)(?:\\.(\\d{1,${FRACTION_PLACES}}))?$`).exec(t);
  if (!m) throw new Error(`refused: --fraction must be "all" or a decimal between 0 and 1 with at most ${FRACTION_PLACES} places, not "${text}"`);
  const den = 10n ** BigInt(FRACTION_PLACES);
  const num = BigInt(m[1]!) * den + BigInt((m[2] ?? "").padEnd(FRACTION_PLACES, "0"));
  if (num === 0n || num > den) throw new Error(`refused: --fraction must be above 0 and at most 1, not "${text}"`);
  return num === den ? { all: true } : { all: false, num, den };
}

/** The most of `held` this fraction allows, rounded down. */
export const allowedOf = (held: bigint, f: WithdrawFraction): bigint => (f.all ? held : (held * f.num) / f.den);

export function admitWithdrawal(batches: readonly WithdrawalAuthorization[], fraction: WithdrawFraction, expect: WithdrawExpect): AdmittedWithdrawal {
  if (batches.length === 0) throw new Error("refused: the withdrawal has no authorization to sign");
  const owner = getAddress(expect.owner);
  const smartAccount = getAddress(expect.smartAccount);
  const totals = new Map<Address, bigint>();
  const hashes: Hex[] = [];
  const kinds: ("sale" | "transfer")[] = [];
  let earliest = Infinity;

  batches.forEach((a, i) => {
    const at = `authorization ${i + 1} of ${batches.length}`;
    const refuse = (why: string): never => {
      throw new Error(`refused (${at}): ${why}`);
    };
    const m = a.message ?? {};
    const domain = a.domain ?? {};
    const sale = m["liquidate"] === true;
    const shape = sale ? "sale" : "transfer";
    const notTheForm = () => refuse("it is not in the form a portfolio withdrawal takes");

    if (a.primaryType !== "Withdrawal" || domain["name"] !== DOMAIN_NAME) notTheForm();
    if (!sameSet(Object.keys(domain), DOMAIN_FIELDS) || domain["version"] !== (sale ? "2" : "1")) notTheForm();
    const types = a.types ?? {};
    if (Object.keys(types).some((t) => t !== "Withdrawal" && t !== "WithdrawalAsset" && t !== "EIP712Domain")) notTheForm();
    // A domain type, if present, replaces the one the signature uses: it must be the standard four
    // fields, or the signature would not be bound to the account and the chain.
    if (types["EIP712Domain"] !== undefined) {
      const d = fieldsOf(types["EIP712Domain"]);
      if (!d || !sameSet(d.map((f) => f.name), DOMAIN_FIELDS) || !d.every((f) => DOMAIN_TYPES[f.name] === f.type)) notTheForm();
    }
    const fields = fieldsOf(types["Withdrawal"]);
    const assetFields = fieldsOf(types["WithdrawalAsset"]);
    if (!fields || !sameSet(fields.map((f) => f.name), FIELDS[shape]) || fields.some((f) => FIELD_TYPES[f.name] !== f.type)) notTheForm();
    if (!assetFields || !sameSet(assetFields.map((f) => f.name), Object.keys(ASSET_TYPES)) || assetFields.some((f) => ASSET_TYPES[f.name] !== f.type)) notTheForm();
    if (!sameSet(Object.keys(m), FIELDS[shape])) notTheForm();

    kinds.push(shape);

    if (Number(domain["chainId"]) !== BNB_INFO.chainId || String(domain["chainId"]) !== String(BNB_INFO.chainId)) {
      refuse(`it is for chain ${String(domain["chainId"])}, not ${BNB_INFO.name}`);
    }
    const debit = typeof domain["verifyingContract"] === "string" && /^0x[0-9a-fA-F]{40}$/.test(domain["verifyingContract"]) ? getAddress(domain["verifyingContract"]) : null;
    if (debit !== smartAccount) refuse(`it would take funds from ${String(domain["verifyingContract"])}, not the smart account ${smartAccount}`);
    if (m["portfolioId"] !== expect.portfolioId) refuse("it is for another portfolio");

    const to = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(String(m["recipientAccountId"] ?? ""));
    if (!to || Number(to[1]) !== BNB_INFO.chainId || getAddress(to[2]!) !== owner) {
      refuse(`it would pay ${String(m["recipientAccountId"])}, not the connected wallet ${owner} on ${BNB_INFO.name}`);
    }
    if (sale && m["settlementAssetId"] !== BNB_USDT_ASSET_ID) refuse("it sells to something other than USDT on BNB Chain");
    if (typeof m["nonce"] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(m["nonce"])) notTheForm();

    const expiry = typeof m["expiresAt"] === "number" || typeof m["expiresAt"] === "string" ? Number(m["expiresAt"]) : NaN;
    if (!Number.isSafeInteger(expiry) || expiry <= 0) notTheForm();
    if (expiry * 1000 <= expect.now) refuse("it has expired");
    if (expiry * 1000 > expect.now + INVEST.maxAuthorizationLifetimeSeconds * 1000) {
      refuse(`it stays valid for more than ${INVEST.maxAuthorizationLifetimeSeconds / 60} minutes`);
    }
    earliest = Math.min(earliest, expiry);

    const assets = Array.isArray(m["assets"]) ? (m["assets"] as { assetId?: unknown; amountRaw?: unknown }[]) : [];
    if (assets.length === 0) refuse("it names no asset");
    const seen = new Set<Address>();
    for (const x of assets) {
      const token = tokenOf(x?.assetId);
      if (!token || typeof x?.amountRaw !== "string" || !/^[1-9]\d*$/.test(x.amountRaw)) {
        refuse(`it names an asset that is not a token on ${BNB_INFO.name}, or an amount that is not a whole number of units`);
      }
      // Each element is exactly { assetId, amountRaw }: a key that is shown but not signed is refused.
      if (!sameSet(Object.keys(x), Object.keys(ASSET_TYPES))) notTheForm();
      if (seen.has(token!)) refuse("it names the same asset twice");
      seen.add(token!);
      if (!sale && x.assetId !== BNB_USDT_ASSET_ID) refuse("it would move a holding other than USDT without selling it");
      totals.set(token!, (totals.get(token!) ?? 0n) + BigInt(x.amountRaw as string));
    }

    hashes.push(hashTypedData(a as unknown as TypedDataDefinition));
  });

  // The bound: each asset's total over every batch, against the chain's balance.
  const out: AdmittedWithdrawal["totals"] = [];
  for (const [token, amount] of totals) {
    const held = expect.holdings.get(token) ?? 0n;
    if (held === 0n) throw new Error(`refused: the withdrawal names ${token}, which the smart account does not hold`);
    const allowed = allowedOf(held, fraction);
    if (amount > allowed) {
      throw new Error(
        `refused: the withdrawal asks for ${amount} units of ${token}, more than ${fraction.all ? "the account holds" : "the asked fraction of what the account holds"} (${allowed} of ${held})`,
      );
    }
    out.push({ token, amount, held });
  }

  return {
    kinds,
    totals: out,
    batches: batches.length,
    expiresAt: new Date(earliest * 1000),
    digest: keccak256(concat(hashes)),
  };
}

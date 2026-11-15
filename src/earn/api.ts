/**
 * Where `earn` reaches the Tempora API for a vault on an EVM chain: its MCP endpoint, through `@temporalabs/client/mcp`,
 * never a second client. Every fact about a vault (its chain, contract, asset, decimals, status, terms and warnings) is
 * read from the API when a command runs. A vault is named as the operator types it (its ticker, its contract address
 * or its CAIP-10 id) and the API decides which vault that is; each chain's default is an address
 * (`EARN.defaultVaultAddressByChain`). The API's own product id is never shown; it only goes back to the API, as the
 * `product` of a call.
 *
 * The address and the sign-in are `invest`'s (`../invest/api.ts`): the same pinned API, `TREASURY_API_URL` to point at
 * another deployment, and one sign-in serving both of the API's doors.
 */
import { createHash } from "node:crypto";
import type { Amount, Product } from "@temporalabs/client";
import { createMcpClient, type McpClient } from "@temporalabs/client/mcp";
import { CHAIN_INFO, chainIdForKey, isSupportedChainId, supportedChainIds, type ChainKey, type SupportedChainId } from "../client.js";
import { EARN } from "../config/earn.js";
import { INVEST } from "../config/invest.js";
import { apiUrl, failure } from "../invest/api.js";
import { parseAmount } from "../units.js";

/** The API's MCP endpoint: `/mcp` on the API's own host. */
export const mcpUrl = (): string => new URL("/mcp", apiUrl()).toString();

/** A client for the MCP endpoint, with no client key. Throws a TypeError for a URL the client refuses. */
export const mcpClient = (): McpClient => createMcpClient({ url: mcpUrl(), timeoutMs: INVEST.apiTimeoutMs });

/** A vault as the API lists it, with the vault's own identity present. */
export type VaultProduct = Product & { vault: NonNullable<Product["vault"]> };

/** A chain's CAIP-2 name, the form the API names chains in. */
export const caip2Of = (chainId: SupportedChainId): string => `eip155:${chainId}`;

/** The supported chain a CAIP-2 name is, or `undefined` for one this client does not know. */
export function chainOfCaip2(caip2: string): SupportedChainId | undefined {
  const m = /^eip155:(\d+)$/.exec(caip2);
  if (!m) return undefined;
  const id = Number(m[1]);
  return isSupportedChainId(id) ? id : undefined;
}

/** Which chain a vault is on, as every response names it: the key a caller passes back as `chain`, and the chain id. */
export function chainOf(p: VaultProduct): { chain: ChainKey | null; chainId: number | null; caip2: string } {
  const id = chainOfCaip2(p.vault.chain);
  return { chain: id === undefined ? null : CHAIN_INFO[id].key, chainId: id ?? null, caip2: p.vault.chain };
}

/** The vaults the API lists now. A list that cannot be read is an error, never an empty list. */
export async function vaultProducts(mcp: McpClient): Promise<Product[]> {
  const r = await mcp.products({});
  if (!r.ok) throw failure("The vault list could not be read from the Tempora API", r);
  return r.body.products.filter((p) => p.kind === "vault");
}

/** Every EVM chain key, then `solana` when `withSolana`: the list an unknown chain's refusal names. */
export const chainKeys = (withSolana: boolean): string[] => [...supportedChainIds.map((id) => CHAIN_INFO[id].key as string), ...(withSolana ? ["solana"] : [])];

/** The chain a call names, refused when this client does not know it: decided before anything is asked of the API. */
export function knownChain(chain: string | undefined, withSolana = false): SupportedChainId | undefined {
  if (chain === undefined) return undefined;
  const id = chainIdForKey(chain);
  if (id === undefined) throw new Error(`unknown chain "${chain}"; chains with a vault: ${chainKeys(withSolana).join(", ")}`);
  return id;
}

/** A vault's contract address as typed: `0x` and 40 hex digits, in any case. */
const VAULT_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The vault's share ticker, as the Tempora API names it (`vault.shareSymbol`). */
export const tickerOf = (p: VaultProduct): string => p.vault.shareSymbol;

/** An address shortened for a label: `0x91Bc…352F`. */
export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * How every response names a vault on an EVM chain: `vault`, its contract address, `ticker`, its share ticker, and
 * `name`, all the API's. Never the API's product id.
 */
export function vaultNamed(p: VaultProduct): { vault: string; ticker: string; name: string } {
  return { vault: p.vault.vaultAddress, ticker: tickerOf(p), name: p.name };
}

/** A vault in a sentence: its share ticker, the API's (`shareSymbol`, which the client requires to be non-empty). */
export const vaultLabel = (p: VaultProduct): string => tickerOf(p);

/** The listed vaults, by ticker or address: those on `on`, or every one with its chain. Never by product id. */
function listing(listed: readonly VaultProduct[], on: SupportedChainId | undefined): string {
  const names = listed
    .filter((p) => on === undefined || chainOfCaip2(p.vault.chain) === on)
    .map((p) => (on === undefined ? `${vaultLabel(p)} (${chainOf(p).chain ?? p.vault.chain})` : vaultLabel(p)));
  return names.length > 0 ? names.join(", ") : "none";
}
const listedOn = (listed: readonly VaultProduct[], on: SupportedChainId | undefined) =>
  `the vaults the Tempora API lists${on === undefined ? "" : ` on ${CHAIN_INFO[on].key}`}: ${listing(listed, on)}`;
const vaultsOf = (products: readonly Product[]) => products.filter((p): p is VaultProduct => p.kind === "vault" && p.vault !== undefined);

/** A vault the API answered with, refused when it is on another chain than the one named, or on one this client does not support. */
function onNamedChain(vp: VaultProduct, vault: string, chain: string | undefined, chainId: SupportedChainId | undefined, others: () => string): VaultProduct {
  const its = chainOf(vp);
  if (chainId !== undefined && its.chainId !== chainId) {
    const on = its.chain ?? its.caip2;
    const o = others();
    throw new Error(
      `vault "${vault}" is on ${on}, not ${chain}. Name one or the other: drop \`chain\` to use ${vaultLabel(vp)} on ${on}` + (o !== "none" ? `, or pick a vault on ${chain} (${o}).` : "."),
    );
  }
  if (its.chainId === null) throw new Error(`refused: ${vaultLabel(vp)} is on ${its.caip2}, a chain this client does not support`);
  return vp;
}

/**
 * The vault a command is about, as the Tempora API names it. `vault` goes to the API as given: its ticker, its contract
 * address (any case, and with `chain` as its CAIP-10 id), or its CAIP-10 id; the API decides which vault that is. With none, `chain`'s default (or the
 * default chain's), asked for by its CAIP-10 id. A default the API does not know is refused, never replaced by another
 * vault, and so is a product that is not a vault. A vault on one chain named with another `chain` is refused.
 */
export async function vaultProduct(mcp: McpClient, vault: string | undefined, chain: string | undefined, withSolana = false): Promise<VaultProduct> {
  const chainId = knownChain(chain, withSolana);
  const key = (chain ?? EARN.defaultChain) as ChainKey;
  const defaultId = () => `${caip2Of(chainIdForKey(key)!)}:${EARN.defaultVaultAddressByChain[key]}`;
  // An address named with its chain is asked for by its CAIP-10 id: the same address can be a vault on more than one chain.
  const id = vault === undefined ? defaultId() : chainId !== undefined && VAULT_ADDRESS.test(vault) ? `${caip2Of(chainId)}:${vault}` : vault;
  /** The vaults the API lists, for a refusal's own hint; a list that cannot be read only leaves the hint out. */
  const hint = async (): Promise<VaultProduct[] | undefined> => {
    try {
      return vaultsOf(await vaultProducts(mcp));
    } catch {
      return undefined;
    }
  };
  let r = await mcp.product({ path: { id } });
  // Not on the chain named: asked again by the address alone, so a vault on another chain is refused as one.
  if (!r.ok && r.status === 404 && vault !== undefined && id !== vault) r = await mcp.product({ path: { id: vault } });
  if (!r.ok) {
    if (r.status !== 404) throw failure(`The vault ${vault ?? `default on ${key}`} could not be read from the Tempora API`, r);
    if (vault === undefined) {
      throw new Error(`refused: the default vault on ${key} (${EARN.defaultVaultAddressByChain[key]}) is not listed by the Tempora API now; run \`treasury earn vaults\` and name a listed vault with --vault`);
    }
    const listed = await hint();
    throw new Error(`refused: the Tempora API knows no vault "${vault}"; name a vault by its ticker or contract address${listed ? `; ${listedOn(listed, chainId)}` : ""}`);
  }
  const p = r.body as Product;
  if (p.kind !== "vault" || p.vault === undefined) throw new Error(`refused: "${vault ?? id}" is not a vault on the Tempora API; name a vault by its ticker or contract address`);
  const vp = p as VaultProduct;
  // The default is asked for on its own chain, named or not: an answer on any other chain is a different vault.
  if (vault === undefined && chainOf(vp).chainId !== chainIdForKey(key)) {
    const its = chainOf(vp);
    throw new Error(`refused: the Tempora API answers the default vault on ${key} (${EARN.defaultVaultAddressByChain[key]}) with a vault on ${its.chain ?? its.caip2}; nothing is read for it`);
  }
  // The list is read only for a refusal's hint: a vault on another chain than the one named.
  const listed = chainId !== undefined && chainOf(vp).chainId !== chainId ? await hint() : undefined;
  return onNamedChain(vp, vault ?? id, chain, chainId, () => (listed ? listing(listed, chainId) : "none"));
}

/**
 * The vault at contract address `address`, among the vaults the API lists: how a plan's leg, recorded by its vault's
 * address, finds that vault again. An address no listed vault has, or more than one has on `chain`, is refused.
 */
export function listedVault(products: readonly Product[], address: string, chain: string | undefined, withSolana = false): VaultProduct {
  const chainId = knownChain(chain, withSolana);
  const listed = vaultsOf(products);
  if (!VAULT_ADDRESS.test(address)) throw new Error(`refused: a plan leg names its vault by contract address, and "${address}" is not one; make the plan again with \`connect plan --legs\``);
  const matches = listed.filter((p) => p.vault.vaultAddress.toLowerCase() === address.toLowerCase());
  const scoped = chainId === undefined ? matches : matches.filter((p) => chainOfCaip2(p.vault.chain) === chainId);
  if (scoped.length === 0) {
    if (matches[0] !== undefined) return onNamedChain(matches[0], address, chain, chainId, () => listing(listed, chainId));
    throw new Error(`refused: no vault the Tempora API lists has the address ${address}; ${listedOn(listed, chainId)}`);
  }
  if (scoped.length > 1) {
    throw new Error(`refused: the Tempora API lists more than one vault at ${address}${chainId === undefined ? "" : ` on ${CHAIN_INFO[chainId].key}`}, so it does not name one vault; nothing is read for it`);
  }
  return onNamedChain(scoped[0]!, address, chain, chainId, () => listing(listed, chainId));
}

/** The vault's asset, as a CAIP-19 id: the form the API takes an amount in. Read from the API's own row. */
export const assetIdOf = (p: VaultProduct): string => `${p.vault.chain}/erc20:${p.vault.assetAddress}`;

/** An amount of the vault's asset as typed (`25`, `12.5`), in raw units of the vault's own asset decimals. */
export function assetsAmount(p: VaultProduct, human: string): { amount: Extract<Amount, { kind: "assets" }>; raw: bigint } {
  const raw = parseAmount(human, p.vault.assetDecimals, "--amount_usdc");
  return { amount: { kind: "assets", assetId: assetIdOf(p), raw: raw.toString() }, raw };
}

/**
 * The SHA-256 of the terms text, over its UTF-8 bytes, as `0x` and 64 lowercase hex digits: the form the API sends
 * `vaultTerms.sha256` in.
 */
export const termsSha256 = (text: string): string => `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** The vault's terms, refused unless their text hashes, here, to the sha256 the API sent with them. */
export function verifiedTerms(p: VaultProduct): { text: string; version: string; sha256: string } {
  const t = p.vaultTerms;
  if (!t) throw new Error(`refused: the Tempora API lists no terms for ${vaultLabel(p)}; no deposit can be made into it until it does`);
  const computed = termsSha256(t.text);
  if (computed !== t.sha256.toLowerCase()) {
    throw new Error(
      `refused: the terms the Tempora API sent for ${vaultLabel(p)} (version ${t.version}) do not match their own sha256: sent ${t.sha256}, computed ${computed}. ` +
        "Do not show or accept them; try again later",
    );
  }
  return { text: t.text, version: t.version, sha256: computed };
}

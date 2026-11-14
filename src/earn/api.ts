/**
 * Where `earn` reaches the Tempora API for a vault on an EVM chain: its MCP endpoint, through `@temporalabs/client/mcp`,
 * never a second client. Every fact about a vault (its chain, contract, asset, decimals, status, terms and warnings) is
 * read from the API when a command runs. A vault is named by its contract address (or its ticker, which the registry
 * turns into one), and each chain's default is an address (`EARN.defaultVaultAddressByChain`): the address only picks
 * the API's row, which stays the source of everything else. The API's own product id is never taken from a caller and
 * never shown; it only goes back to the API, as the `product` of a call.
 *
 * The address and the sign-in are `invest`'s (`../invest/api.ts`): the same pinned API, `TREASURY_API_URL` to point at
 * another deployment, and one sign-in serving both of the API's doors.
 */
import { createHash } from "node:crypto";
import type { Amount, Product } from "@temporalabs/client";
import { createMcpClient, type McpClient } from "@temporalabs/client/mcp";
import { CHAIN_INFO, chainIdForKey, isSupportedChainId, supportedChainIds, type ChainKey, type SupportedChainId } from "../client.js";
import { EARN } from "../config/earn.js";
import { listVaults } from "../registry.js";
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

/** The registry's ticker for the vault contract at `address` on `chainId`, or null when the registry has none. */
export function tickerOf(address: string, chainId: number | null): string | null {
  if (chainId === null) return null;
  const a = address.toLowerCase();
  return listVaults().find((v) => v.chainId === chainId && v.address.toLowerCase() === a)?.symbol ?? null;
}

/** An address shortened for a label: `0x91Bc…352F`. */
export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * How every response names a vault on an EVM chain: `vault`, its contract address (the API's), `ticker`, the registry's
 * ticker for that address or null, and `name`, the API's. Never the API's product id.
 */
export function vaultNamed(p: VaultProduct): { vault: string; ticker: string | null; name: string } {
  return { vault: p.vault.vaultAddress, ticker: tickerOf(p.vault.vaultAddress, chainOf(p).chainId), name: p.name };
}

/** A vault in a sentence: its ticker, or its contract address when the registry has no ticker for it. */
export const vaultLabel = (p: VaultProduct): string => tickerOf(p.vault.vaultAddress, chainOf(p).chainId) ?? p.vault.vaultAddress;

/**
 * The vault a command is about. `vault` is the vault's contract address (any case) or its ticker, which the registry
 * turns into an address; with none, the address of `chain`'s default (or the default chain's). The address only picks
 * the API's row, among the vaults it lists: an address no listed vault has, or more than one has, is refused, and so
 * is a value that is neither an address nor a known ticker (the API's product id is not taken). A default the API does
 * not list is refused, never replaced by another vault. A vault on one chain named with another `chain` is refused,
 * in both directions.
 */
export function resolveProduct(products: readonly Product[], vault: string | undefined, chain: string | undefined, withSolana = false): VaultProduct {
  const chainId = knownChain(chain, withSolana);
  const listed = products.filter((p): p is VaultProduct => p.kind === "vault" && p.vault !== undefined);
  const onChainId = (p: VaultProduct) => chainOfCaip2(p.vault.chain);
  /** The listed vaults, by ticker or address: those on `on`, or every one with its chain. Never by product id. */
  const listing = (on: SupportedChainId | undefined): string => {
    const names = listed.filter((p) => on === undefined || onChainId(p) === on).map((p) => (on === undefined ? `${vaultLabel(p)} (${chainOf(p).chain ?? p.vault.chain})` : vaultLabel(p)));
    return names.length > 0 ? names.join(", ") : "none";
  };
  const listedOn = (on: SupportedChainId | undefined) => `the vaults the Tempora API lists${on === undefined ? "" : ` on ${CHAIN_INFO[on].key}`}: ${listing(on)}`;
  const key = (chain ?? EARN.defaultChain) as ChainKey;
  // The chain the row must be on: the one named, or, for a default, the default's own chain.
  const want = chainId ?? (vault === undefined ? chainIdForKey(key) : undefined);
  let address: string;
  if (vault === undefined) address = EARN.defaultVaultAddressByChain[key];
  else if (VAULT_ADDRESS.test(vault)) address = vault;
  else {
    const t = listVaults().find((v) => v.symbol === vault);
    if (!t) throw new Error(`refused: \`--vault\` takes a vault's contract address (0x…) or its ticker, and the value given is neither; ${listedOn(chainId)}`);
    address = t.address;
  }
  const matches = listed.filter((p) => p.vault.vaultAddress.toLowerCase() === address.toLowerCase());
  const scoped = want === undefined ? matches : matches.filter((p) => onChainId(p) === want);
  if (scoped.length === 0) {
    if (vault === undefined) {
      throw new Error(`refused: the default vault on ${key} (${address}) is not listed by the Tempora API now; run \`treasury earn vaults\` and name a listed vault with --vault`);
    }
    const elsewhere = matches[0];
    if (elsewhere !== undefined && chainId !== undefined) {
      const its = chainOf(elsewhere);
      const on = its.chain ?? its.caip2;
      const others = listing(chainId);
      throw new Error(
        `vault "${vault}" is on ${on}, not ${chain}. Name one or the other: drop \`chain\` to use ${vaultLabel(elsewhere)} on ${on}` +
          (others !== "none" ? `, or pick a vault on ${chain} (${others}).` : "."),
      );
    }
    throw new Error(`refused: no vault the Tempora API lists has the address ${address}; ${listedOn(chainId)}`);
  }
  if (scoped.length > 1) {
    const chains = new Set(scoped.map(onChainId));
    throw new Error(
      `refused: the Tempora API lists more than one vault at ${address}${want === undefined ? "" : ` on ${CHAIN_INFO[want].key}`}, so it does not name one vault; nothing is read for it` +
        (want === undefined && chains.size > 1 ? ". Name its chain with `chain`" : ""),
    );
  }
  const vp = scoped[0]!;
  const its = chainOf(vp);
  if (its.chainId === null) throw new Error(`refused: ${vaultLabel(vp)} is on ${its.caip2}, a chain this client does not support`);
  return vp;
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

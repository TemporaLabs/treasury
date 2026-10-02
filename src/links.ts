/**
 * Public, human-checkable links for a vault — the verification path that costs the operator
 * nothing to follow and this client nothing to serve.
 *
 * These are derived from `chainId`, `chassis` and `address`, never stored in the registry: a stored
 * URL is another field that can drift from the address it claims to describe, and the whole point
 * of a verification link is that it resolves to the same contract the tools are about to build a
 * call for. Derive it and the two cannot disagree.
 *
 * No RPC is involved. An operator who has not configured an endpoint can still open every one of
 * these, which is why they are the answer to "how do I check this is real" rather than a live
 * `symbol()` call the client would have to make on their behalf.
 */
import type { VaultEntry } from "./registry-schema.js";

/**
 * Block explorers, by chain.
 *
 * 🔴 THIS MAP MAY NOT MISS A CHAIN, and the lookup below throws if it does. An unknown `chainId`
 * used to interpolate `undefined` into the URL — `undefined0x040f…` — which is a well-formed string,
 * so nothing threw and the caller received a link that goes nowhere. That was unreachable only
 * while the registry schema pinned one chain. It now accepts several, so the safety is the throw:
 * a chain added to the schema without a row here fails the first `earn_vaults` call, and
 * `registry.test.ts` builds a link for every chain the schema accepts.
 */
const EXPLORER: Record<number, string> = {
  8453: "https://basescan.org/address/",
  42161: "https://arbiscan.io/address/",
};

/**
 * The protocol's own front end, where one exists, the URL shape is known, AND the page resolves. A
 * chassis or chain with no entry gets no link rather than a guessed one — a wrong app URL sends an
 * operator to someone else's vault, which is worse than sending them nowhere, and a dead one teaches
 * them the links are not worth opening.
 *
 * Morpho's app: Base only. Measured 2026-10-02: `app.morpho.org/arbitrum/vault/<address>` answers
 * 404 for the Arbitrum vault in the registry, and Morpho's API does not know that address on chain
 * 42161, while the Base page and API both resolve. Add Arbitrum's slug here once that page exists.
 */
const MORPHO_APP_CHAIN: Record<number, string> = { 8453: "base" };
const APP: Record<string, (chainId: number, address: string) => string | undefined> = {
  "morpho-v2": (chainId, address) => (MORPHO_APP_CHAIN[chainId] ? `https://app.morpho.org/${MORPHO_APP_CHAIN[chainId]}/vault/${address}` : undefined),
};

export interface VaultLinks {
  /** The contract on a block explorer: source, holdings, every transaction. Always present. */
  explorer: string;
  /** The protocol's own UI for this vault, when the chassis has a known one. */
  app?: string;
}

export function linksFor(vault: Pick<VaultEntry, "chainId" | "address" | "chassis">): VaultLinks {
  const explorer = EXPLORER[vault.chainId];
  if (explorer === undefined) throw new Error(`no block explorer is recorded for chain ${vault.chainId}; add it to EXPLORER in src/links.ts`);
  const links: VaultLinks = { explorer: `${explorer}${vault.address}` };
  const app = APP[vault.chassis]?.(vault.chainId, vault.address);
  if (app) links.app = app;
  return links;
}

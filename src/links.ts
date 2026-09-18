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
 * 🔴 THIS MAP MAY NOT BE MISSED A CHAIN. An unknown `chainId` interpolates `undefined` into the
 * URL — `undefined0x040f…` — which is a well-formed string, so nothing throws and the caller
 * receives a link that goes nowhere. Today that is unreachable, but only because the registry
 * schema pins `chainId: z.literal(8453)`: a wrong value is a compile-time error wherever a
 * `VaultEntry` is built, and `loadRegistry()` rejects the whole file on any parse failure.
 *
 * So the safety here is the LITERAL, not this map. **Widening the schema to a second chain
 * without adding its row below reintroduces the broken link**, silently. Add the row in the same
 * change, or make the lookup fail loudly instead.
 */
const EXPLORER: Record<number, string> = {
  8453: "https://basescan.org/address/",
};

/**
 * The protocol's own front end, where one exists and the URL shape is known. A chassis with no
 * entry gets no link rather than a guessed one — a wrong app URL sends an operator to someone
 * else's vault, which is worse than sending them nowhere.
 */
const APP: Record<string, (chainId: number, address: string) => string | undefined> = {
  "morpho-v2": (chainId, address) => (chainId === 8453 ? `https://app.morpho.org/base/vault/${address}` : undefined),
};

export interface VaultLinks {
  /** The contract on a block explorer: source, holdings, every transaction. Always present. */
  explorer: string;
  /** The protocol's own UI for this vault, when the chassis has a known one. */
  app?: string;
}

export function linksFor(vault: Pick<VaultEntry, "chainId" | "address" | "chassis">): VaultLinks {
  const links: VaultLinks = { explorer: `${EXPLORER[vault.chainId]}${vault.address}` };
  const app = APP[vault.chassis]?.(vault.chainId, vault.address);
  if (app) links.app = app;
  return links;
}

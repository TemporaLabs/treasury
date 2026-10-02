import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registrySchema, erc4626Chassis, type Registry, type VaultEntry } from "./registry-schema.js";
import { EARN } from "./config/earn.js";
import { CHAIN_INFO, chainIdForKey, supportedChainIds, type ChainKey, type SupportedChainId } from "./client.js";

// From this file's real path, not a symlink's: see PACKAGE_JSON_URL in version.ts.
const REGISTRY_URL = new URL("../registry/vaults.json", pathToFileURL(realpathSync(fileURLToPath(import.meta.url))));

let cached: Registry | undefined;

/** Parses and validates the shipped registry. Throws on any schema violation — a registry that does not parse is not a registry. */
export function loadRegistry(): Registry {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(fileURLToPath(REGISTRY_URL), "utf8")) as unknown;
  cached = registrySchema.parse(raw);
  return cached;
}

/**
 * TEST SEAM — `tests/fixtures/registry.ts` only, and NOT re-exported from `index.ts`, so no
 * consumer of this package can reach it. The unit tiers need chassis the registry does not ship
 * (18-decimal shares, a non-ERC-4626 chassis, a vault open to anyone); without this they would
 * pin themselves to whichever vaults the fund happens to offer, and a registry edit — a product
 * decision — would redden unrelated unit tests. `undefined` restores the shipped file.
 */
export function __setRegistryForTests(r: Registry | undefined): void {
  cached = r;
}

export function listVaults(): VaultEntry[] {
  return loadRegistry().vaults;
}

export function getVault(symbol: string): VaultEntry {
  const v = loadRegistry().vaults.find((x) => x.symbol === symbol);
  if (!v) {
    const known = loadRegistry()
      .vaults.map((x) => x.symbol)
      .join(", ");
    throw new Error(`unknown vault "${symbol}"; known: ${known}`);
  }
  return v;
}

/** The chain used when a caller names neither a chain nor a vault: `EARN.defaultChain`. */
export function defaultChainId(): SupportedChainId {
  const id = chainIdForKey(EARN.defaultChain);
  if (id === undefined) throw new Error(`config/earn.ts names "${EARN.defaultChain}" as the default chain, which this client does not support`);
  return id;
}

/**
 * The chains a caller can name: every supported chain with at least one vault in the registry, the
 * default chain first. A chain this client supports and the registry has no vault on is not
 * offered — there is nothing to do there.
 */
export function offeredChains(): { key: ChainKey; chainId: SupportedChainId; name: string }[] {
  const present = new Set(loadRegistry().vaults.map((v) => v.chainId));
  const first = defaultChainId();
  return supportedChainIds
    .filter((id) => present.has(id))
    .sort((a, b) => (a === first ? -1 : b === first ? 1 : a - b))
    .map((id) => ({ key: CHAIN_INFO[id].key, chainId: id, name: CHAIN_INFO[id].name }));
}

/**
 * The vault the tools use on a chain when the caller names none: `EARN.defaultVaultByChain`
 * (config/earn.ts — the toggle), which the registry must also mark `isDefault` (the measurement; the
 * schema guarantees exactly one per chain and that it is open or whitelist-gated). A disagreement
 * between the two is refused, never resolved silently. With no argument: the default chain's.
 */
export function defaultVault(chainId: SupportedChainId = defaultChainId()): VaultEntry {
  const key = CHAIN_INFO[chainId].key;
  const named = (EARN.defaultVaultByChain as Record<string, string | undefined>)[key];
  const marked = loadRegistry().vaults.find((x) => x.chainId === chainId && x.isDefault);
  if (named === undefined || marked === undefined) {
    throw new Error(`no vault is offered on ${CHAIN_INFO[chainId].name}; chains with a vault: ${offeredChains().map((c) => c.key).join(", ")}`);
  }
  if (marked.symbol !== named) {
    throw new Error(`config/earn.ts names "${named}" as the default on ${key} but the registry marks "${marked.symbol}"; change both or neither`);
  }
  return marked;
}

/**
 * Resolves an optional ticker and an optional chain to ONE vault:
 *
 *   neither      the default chain's default vault
 *   chain only   that chain's default vault
 *   vault only   that vault, on whatever chain it is on
 *   both         that vault, and it must be on that chain — a disagreement is REFUSED, never
 *                resolved by picking one, because the two answers are different contracts on
 *                different chains and the caller meant exactly one of them.
 */
export function resolveVault(symbol?: string, chain?: string): VaultEntry {
  let chainId: SupportedChainId | undefined;
  if (chain !== undefined) {
    chainId = chainIdForKey(chain);
    const offered = offeredChains();
    if (chainId === undefined || !offered.some((c) => c.chainId === chainId)) {
      throw new Error(`unknown chain "${chain}"; chains with a vault: ${offered.map((c) => c.key).join(", ")}`);
    }
  }
  if (!symbol) return defaultVault(chainId);
  const v = getVault(symbol);
  if (chainId !== undefined && v.chainId !== chainId) {
    const on = loadRegistry()
      .vaults.filter((x) => x.chainId === chainId)
      .map((x) => x.symbol)
      .join(", ");
    throw new Error(
      `vault "${symbol}" is on ${CHAIN_INFO[v.chainId].key}, not ${chain}. Name one or the other: drop \`chain\` to use ${symbol} on ${CHAIN_INFO[v.chainId].key}, or pick a vault on ${chain} (${on}).`,
    );
  }
  return v;
}

/**
 * The vaults this client can put money into: ACTIVE, on an ERC-4626 chassis, and MEASURED open.
 * This is the rule, not a list — the count moves as vaults are provisioned, gated, or retired.
 */
export function depositableVaults(): VaultEntry[] {
  return loadRegistry().vaults.filter(
    (v) => erc4626Chassis.has(v.chassis) && v.depositOpen.open,
  );
}

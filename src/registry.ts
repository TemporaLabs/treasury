import { registrySchema, erc4626Chassis, type Registry, type SolanaVaultEntry, type VaultEntry } from "./registry-schema.js";
import registryJson from "../registry/vaults.json" with { type: "json" };
import { EARN } from "./config/earn.js";
import { CHAIN_INFO, chainIdForKey, SOLANA_INFO, supportedChainIds, type ChainKey, type SupportedChainId } from "./client.js";

let cached: Registry | undefined;

/** Parses and validates the shipped registry. Throws on any schema violation — a registry that does not parse is not a registry. */
export function loadRegistry(): Registry {
  if (cached) return cached;
  const raw: unknown = registryJson;
  const parsed = registrySchema.parse(raw);
  // The schema holds one default per chain THAT HAS A VAULT, so it cannot see a registry with no
  // vault on the default chain at all — and then the discovery call itself is what fails, with an
  // error about a chain nobody asked for. Refuse the file here, where the cause can be named.
  const chainId = defaultChainId();
  if (!parsed.vaults.some((v) => v.chainId === chainId)) {
    throw new Error(`the registry has no vault on ${CHAIN_INFO[chainId].name}, which config/earn.ts names as the default chain; add one or change defaultChain`);
  }
  cached = parsed;
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
    if (loadRegistry().solanaVaults.some((x) => x.symbol === symbol)) {
      throw new Error(`vault "${symbol}" is on solana, which this command does not handle`);
    }
    const known = [...loadRegistry().vaults, ...loadRegistry().solanaVaults].map((x) => x.symbol).join(", ");
    throw new Error(`unknown vault "${symbol}"; known: ${known}`);
  }
  return v;
}

/** The vaults on Solana (`solanaVaults` in the registry). */
export function listSolanaVaults(): SolanaVaultEntry[] {
  return loadRegistry().solanaVaults;
}

/** Every chain a caller can name, EVM and Solana, the default chain first: the list a refusal names. */
export function offeredChainKeys(): string[] {
  return [...offeredChains().map((c) => c.key as string), ...(listSolanaVaults().length > 0 ? [SOLANA_INFO.key] : [])];
}

/** One vault on any chain: an EVM row or a Solana row, which every caller must tell apart before using it. */
export type ResolvedVault = { family: "evm"; vault: VaultEntry } | { family: "solana"; vault: SolanaVaultEntry };

/**
 * `resolveVault` across chain families: `chain: "solana"`, or a `vault` that is on Solana, resolves to the
 * Solana row; anything else is `resolveVault`, unchanged. The same refusals hold: a vault and a chain that
 * disagree are refused, and the error says which chain the vault is on.
 */
export function resolveAnyVault(symbol?: string, chain?: string): ResolvedVault {
  const sol = symbol ? listSolanaVaults().find((x) => x.symbol === symbol) : undefined;
  if (chain === SOLANA_INFO.key) {
    const vaults = listSolanaVaults();
    if (vaults.length === 0) throw new Error(`unknown chain "${chain}"; chains with a vault: ${offeredChainKeys().join(", ")}`);
    if (!symbol) return { family: "solana", vault: vaults.find((x) => x.isDefault)! };
    if (sol) return { family: "solana", vault: sol };
    const evm = getVault(symbol);
    throw new Error(
      `vault "${symbol}" is on ${CHAIN_INFO[evm.chainId].key}, not solana. Name one or the other: drop \`chain\` to use ${symbol} on ${CHAIN_INFO[evm.chainId].key}, or pick a vault on solana (${vaults.map((x) => x.symbol).join(", ")}).`,
    );
  }
  if (sol) {
    if (chain) {
      throw new Error(
        `vault "${symbol}" is on solana, not ${chain}. Name one or the other: drop \`chain\` to use ${symbol} on solana, or pick a vault on ${chain}.`,
      );
    }
    return { family: "solana", vault: sol };
  }
  return { family: "evm", vault: resolveVault(symbol, chain) };
}

/** The Solana vaults any account can put money into: measured open. */
export function depositableSolanaVaults(): SolanaVaultEntry[] {
  return listSolanaVaults().filter((v) => v.depositOpen.open);
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
    .sort((a, b) => (a === first ? -1 : b === first ? 1 : 0)) // stable: the rest keep `supportedChainIds` order
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
  const named: string = EARN.defaultVaultByChain[key];
  const marked = loadRegistry().vaults.find((x) => x.chainId === chainId && x.isDefault);
  if (marked === undefined) {
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
  // An EMPTY string is an omitted argument, for `chain` exactly as for `vault` (`!symbol` below):
  // a host that sends "" for every optional it did not fill must get the default, not a refusal.
  if (chain) {
    if (chain === SOLANA_INFO.key) throw new Error(`chain "${chain}" has no ERC-4626 vault; this resolves the EVM vaults only, and the Solana vault is reached through the CLI (\`treasury earn … --chain solana\`)`);
    chainId = chainIdForKey(chain);
    const offered = offeredChains();
    if (chainId === undefined || !offered.some((c) => c.chainId === chainId)) {
      throw new Error(`unknown chain "${chain}"; chains with a vault: ${offeredChainKeys().join(", ")}`);
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

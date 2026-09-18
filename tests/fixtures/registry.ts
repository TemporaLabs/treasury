/**
 * The unit tiers' vaults — SYNTHETIC, and deliberately not the shipped ones.
 *
 * The registry ships two Tempora vaults (the open default and a gated sibling). The client's code paths are wider
 * than that by design: 18-decimal shares against a 6-decimal asset, a chassis with no ERC-4626
 * deposit path, a vault measured OPEN to any account. Pinning those paths to whichever vaults
 * happen to be in the registry made the unit tiers fail every time the fund's offering changed —
 * a registry edit is a product decision, not a code change, and should not redden a unit test.
 *
 * So: these rows exist to exercise code, they are parsed through the same strict schema as the
 * real file, and their addresses are obviously-fake digit patterns so that nothing here can ever
 * be mistaken for a live vault or reached on a chain. Tests that assert what the CLIENT SHIPS
 * (`tests/registry.test.ts`) read the real registry and must not use these.
 */
import { registrySchema, type Registry, type VaultEntry } from "../../src/registry-schema.js";
import { loadRegistry, __setRegistryForTests } from "../../src/registry.js";

const usdc = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 } as const;

const open = (block: number) => ({ open: true, method: "simulated-deposit-from-stranger", measuredAtBlock: block, measuredAtIso: "2026-09-15T00:00:00Z" }) as const;
const closed = (reason: "WHITELIST_GATED" | "NOT_ERC4626", block: number) =>
  ({ open: false, method: "simulated-deposit-from-stranger", measuredAtBlock: block, measuredAtIso: "2026-09-15T00:00:00Z", reason }) as const;

/** Slugs the unit tiers name. Exported so a test never spells one as a literal twice. */
export const FIXTURE = {
  /** 18-decimal shares, 6-decimal asset, open to anyone — the deposit/withdraw arithmetic path. */
  morphoOpen: "fixture-morpho-open",
  /** A second open row, so "the depositable set" is a set and not a single row. */
  morphoOpen2: "fixture-morpho-open-2",
  /** 8-decimal shares, whitelist-gated — the access-refusal path, and the decimals trap. */
  fusionGated: "fixture-fusion-gated",
  /** No ERC-4626 deposit path at all — the chassis-refusal path. */
  enzyme: "fixture-enzyme",
} as const;

const rows = [
  {
    slug: FIXTURE.morphoOpen,
    displayName: "Fixture Morpho V2 (open)",
    chainId: 8453,
    address: "0x1111111111111111111111111111111111111111",
    chassis: "morpho-v2",
    backend: "tempora",
    isDefault: false,
    asset: usdc,
    shareDecimals: 18,
    shareSymbol: "fixMORPHO",
    depositOpen: open(51_000_001),
    deployedAtBlock: 50_000_001,
    notes: ["A FIXTURE. No contract exists at this address."],
  },
  {
    slug: FIXTURE.morphoOpen2,
    displayName: "Fixture Morpho V2 (open, second)",
    chainId: 8453,
    address: "0x2222222222222222222222222222222222222222",
    chassis: "morpho-v2",
    backend: "tempora",
    isDefault: false,
    asset: usdc,
    shareDecimals: 18,
    shareSymbol: "fixMORPHO2",
    depositOpen: open(51_000_002),
    deployedAtBlock: 50_000_002,
    notes: ["A FIXTURE. No contract exists at this address."],
  },
  {
    slug: FIXTURE.fusionGated,
    displayName: "Fixture Fusion (whitelist-gated)",
    chainId: 8453,
    address: "0x3333333333333333333333333333333333333333",
    chassis: "fusion",
    backend: "tempora",
    isDefault: false,
    asset: usdc,
    shareDecimals: 8,
    shareSymbol: "fixFUSION",
    depositOpen: closed("WHITELIST_GATED", 51_000_003),
    deployedAtBlock: 50_000_003,
    notes: ["A FIXTURE. No contract exists at this address."],
  },
  {
    slug: FIXTURE.enzyme,
    displayName: "Fixture Enzyme (no ERC-4626 deposit path)",
    chainId: 8453,
    address: "0x4444444444444444444444444444444444444444",
    chassis: "enzyme",
    backend: "tempora",
    isDefault: false,
    asset: usdc,
    shareDecimals: 18,
    shareSymbol: "fixENZYME",
    depositOpen: closed("NOT_ERC4626", 51_000_004),
    deployedAtBlock: 50_000_004,
    notes: ["A FIXTURE. No contract exists at this address."],
  },
] as const;

/**
 * The shipped registry PLUS the fixture rows, installed for the duration of the process.
 * The real default stays the default, so `resolveVault()` and `earn_vaults` behave as they ship.
 */
export function useFixtureRegistry(): Registry {
  // Always merge onto the SHIPPED rows, never onto whatever is installed: calling this twice must
  // be the same as calling it once, or the second call appends the fixtures to themselves and the
  // schema refuses a duplicate slug — in a test that has nothing to do with slugs.
  __setRegistryForTests(undefined);
  const shipped = loadRegistry();
  const merged = registrySchema.parse({
    schemaVersion: 1,
    reconciledAtIso: shipped.reconciledAtIso,
    vaults: [...shipped.vaults, ...rows],
  });
  __setRegistryForTests(merged);
  return merged;
}

/** Drops the fixtures again — the next `loadRegistry()` reads the shipped file. */
export function useShippedRegistry(): void {
  __setRegistryForTests(undefined);
}

/** A fixture row, by slug. Fails loudly rather than returning undefined into an assertion. */
export function fixtureVault(slug: string): VaultEntry {
  const v = useFixtureRegistry().vaults.find((x) => x.slug === slug);
  if (!v) throw new Error(`no fixture vault "${slug}"`);
  return v;
}

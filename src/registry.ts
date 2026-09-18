import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registrySchema, erc4626Chassis, type Registry, type VaultEntry } from "./registry-schema.js";
import { EARN } from "./config/earn.js";

const REGISTRY_URL = new URL("../registry/vaults.json", import.meta.url);

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

export function getVault(slug: string): VaultEntry {
  const v = loadRegistry().vaults.find((x) => x.slug === slug);
  if (!v) {
    const known = loadRegistry()
      .vaults.map((x) => x.slug)
      .join(", ");
    throw new Error(`unknown vault slug "${slug}"; known: ${known}`);
  }
  return v;
}

/**
 * The vault the tools use when the caller names none: `EARN.defaultVault` (config/earn.ts — the
 * toggle), which the registry must also mark `isDefault` (the measurement; the schema guarantees exactly
 * one and that it is open). A disagreement between the two is refused, never resolved silently.
 */
export function defaultVault(): VaultEntry {
  const v = getVault(EARN.defaultVault);
  if (!v.isDefault) {
    const marked = loadRegistry().vaults.find((x) => x.isDefault)?.slug ?? "(none)";
    throw new Error(`config/earn.ts names "${EARN.defaultVault}" as the default but the registry marks "${marked}"; change both or neither`);
  }
  return v;
}

/** Resolves an optional slug to a vault: the named one, or the default. */
export function resolveVault(slug?: string): VaultEntry {
  return slug ? getVault(slug) : defaultVault();
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

/**
 * Two questions, kept apart on purpose:
 *
 *   1. WHAT THE CLIENT SHIPS — the real `registry/vaults.json`, read as it ships. A change here is
 *      a product decision (which vaults Tempora offers), so these assertions are meant to be
 *      re-stated deliberately when that decision changes, never loosened to survive it.
 *   2. WHAT THE SCHEMA REFUSES — a hand-edit's mistakes, exercised against SYNTHETIC rows
 *      (`fixtures/registry.ts`). A schema rule about a chassis must not need a live vault of that
 *      chassis to be testable, or the rule quietly stops being tested the day that vault retires.
 */
import { describe, it, expect, afterAll } from "vitest";
import { registrySchema } from "../src/registry-schema.js";
import { loadRegistry, depositableVaults, getVault, listVaults, defaultVault, resolveVault } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";
import { FIXTURE, useFixtureRegistry, useShippedRegistry } from "./fixtures/registry.js";

describe("the shipped registry", () => {
  it("parses under the strict schema", () => {
    const reg = loadRegistry();
    expect(reg.schemaVersion).toBe(1);
    expect(reg.reconciledAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The registry names no upstream repository: the chain is the only thing a row is checked against.
    expect(JSON.stringify(reg)).not.toMatch(/sourceRef|instance\.json|lifecycle/);
    expect(reg.vaults.length).toBeGreaterThan(0);
  });

  it("offers THREE Tempora vaults on Base, and the default is Cash Plus USDC (Test 2B) — open to any account", () => {
    const d = defaultVault();
    expect(listVaults().map((v) => v.symbol)).toEqual(["tlCashPlusUSDC2B", "tlCashPlusUSDC2", "tlCashPlusUSDC2A"]);
    expect(d.symbol).toBe("tlCashPlusUSDC2B");
    expect(d.name).toBe("Tempora Labs Cash Plus USDC (Test 2B)");
    expect(d.backend).toBe("tempora");
    expect(d.chainId).toBe(8453);
    expect(d.address).toBe("0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F");
    expect(d.chassis).toBe("morpho-v2");
    expect(resolveVault()).toBe(d);
    expect(listVaults().filter((v) => v.isDefault)).toHaveLength(1);
    for (const v of listVaults()) expect(v.backend).toBe("tempora");
  });

  it("carries MEASURED share decimals — 18 on both Morpho V2 vaults, 8 on the Fusion sibling, all against 6-decimal USDC", () => {
    const twoB = getVault("tlCashPlusUSDC2B");
    const two = getVault("tlCashPlusUSDC2");
    const twoA = getVault("tlCashPlusUSDC2A");
    expect(twoB.shareDecimals).toBe(18); // measured via decimals()
    expect(twoB.symbol).toBe("tlCashPlusUSDC2B");
    expect(two.shareDecimals).toBe(18);
    expect(two.symbol).toBe("tlCashPlusUSDC2");
    expect(twoA.shareDecimals).toBe(8);
    expect(twoA.symbol).toBe("tlCashPlusUSDC2A");
    for (const v of [twoB, two, twoA]) {
      expect(v.asset).toMatchObject({ symbol: "USDC", decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
      expect(v.shareDecimals).not.toBe(v.asset.decimals);
    }
  });

  it("🔴 the depositable set is the two Morpho V2 vaults: both open to any account, measured by a simulated deposit", () => {
    // Both Morpho V2 vaults take a deposit from anyone (a stranger's simulated deposit reached the
    // token pull on each). The Fusion sibling is whitelist-gated and stays out of the set — listed so
    // an admitted account's position can be read and exited, refused for everyone else before anything
    // is built.
    expect(depositableVaults().map((v) => v.symbol)).toEqual(["tlCashPlusUSDC2B", "tlCashPlusUSDC2"]);
    expect(defaultVault().depositOpen.open).toBe(true);
    expect(getVault("tlCashPlusUSDC2").depositOpen.open).toBe(true);
    expect(getVault("tlCashPlusUSDC2A").depositOpen).toMatchObject({ open: false, reason: "WHITELIST_GATED" });
  });

  it("access is a MEASUREMENT with a block on it, not a flag someone set", () => {
    const open = defaultVault().depositOpen;
    expect(open.method).toBe("simulated-deposit-from-stranger");
    expect(open.measuredAtBlock).toBeGreaterThan(51_436_870);
    expect(open.detail).toMatch(/0xe65b7a77/); // TransferFromReverted — reached the token pull, so access is open
    expect(defaultVault().deployedAtBlock).toBe(51_436_870);
    const gated = getVault("tlCashPlusUSDC2A").depositOpen;
    expect(gated.detail).toMatch(/0x068ca9d8/); // AccessManagedUnauthorized — the revert actually observed
    expect(getVault("tlCashPlusUSDC2A").deployedAtBlock).toBe(51_359_816);
    for (const v of listVaults()) expect(v.deployedAtBlock!).toBeLessThan(v.depositOpen.measuredAtBlock);
  });

  it("config/earn.ts and the registry name the SAME default — the config is the toggle, the registry the measurement", () => {
    expect(defaultVault().symbol).toBe(EARN.defaultVault);
    expect(loadRegistry().vaults.find((v) => v.isDefault)?.symbol).toBe(EARN.defaultVault);
    // and the round-trip target resolves — a typo'd ticker fails here, not in a fork run 20 minutes in
    expect(getVault(EARN.roundTripVault).symbol).toBe(EARN.roundTripVault);
  });

  it("names no depositor: who may deposit is on the chain, not in this repository", () => {
    // A whitelist member's address in the client would publish who the fund has onboarded and would
    // rot the moment the fund changes it. The fork tier discovers one from the AccessManager instead.
    expect(EARN).not.toHaveProperty("depositors");
    expect(JSON.stringify(loadRegistry())).not.toMatch(/depositor/i);
  });

  it("unknown slugs fail loudly and name what is known", () => {
    expect(() => getVault("nope")).toThrow(/unknown vault "nope"; known: /);
  });
});

describe("the registry schema refuses the mistakes a hand-edit would make", () => {
  // Synthetic rows, so these rules stay tested whatever the fund happens to offer.
  const base = () => JSON.parse(JSON.stringify(useFixtureRegistry())) as ReturnType<typeof loadRegistry>;
  afterAll(() => useShippedRegistry());

  it("the fixtures themselves parse — the control for every mutation below", () => {
    expect(() => registrySchema.parse(base())).not.toThrow();
    expect(base().vaults.map((v) => v.symbol)).toEqual(expect.arrayContaining([FIXTURE.morphoOpen, FIXTURE.fusionGated, FIXTURE.enzyme]));
  });

  it("a closed vault without a reason", () => {
    const r = base();
    const f = r.vaults.find((v) => v.symbol === FIXTURE.fusionGated)!;
    delete (f.depositOpen as { reason?: string }).reason;
    expect(() => registrySchema.parse(r)).toThrow(/closed vault must say why/);
  });

  it("an Enzyme vault marked open (it has no 4626 deposit path)", () => {
    const r = base();
    const e = r.vaults.find((v) => v.symbol === FIXTURE.enzyme)!;
    e.depositOpen = { open: true, method: "simulated-deposit-from-stranger", measuredAtBlock: 1, measuredAtIso: "2026-09-11T00:00:00Z" };
    expect(() => registrySchema.parse(r)).toThrow(/no ERC-4626 deposit path/);
  });

  it("a duplicated address", () => {
    const r = base();
    r.vaults[1]!.address = r.vaults[0]!.address;
    expect(() => registrySchema.parse(r)).toThrow(/duplicate address/);
  });

  it("a duplicated symbol", () => {
    const r = base();
    r.vaults[1]!.symbol = r.vaults[0]!.symbol;
    expect(() => registrySchema.parse(r)).toThrow(/duplicate symbol/);
  });

  it("an unchecksummed or malformed address", () => {
    const r = base();
    (r.vaults[0] as { address: string }).address = "0x1234";
    expect(() => registrySchema.parse(r)).toThrow(/not a checksummed EVM address/);
  });

  it("no default at all — a registry that answers nothing when a caller names no vault", () => {
    const r = base();
    r.vaults.find((v) => v.isDefault)!.isDefault = false;
    expect(() => registrySchema.parse(r)).toThrow(/exactly one vault must be isDefault; found 0/);
  });

  it("two defaults, or a default that is closed for a reason other than a whitelist", () => {
    const r = base();
    r.vaults.find((v) => v.symbol === FIXTURE.morphoOpen)!.isDefault = true;
    expect(() => registrySchema.parse(r)).toThrow(/exactly one vault must be isDefault; found 2/);

    const r2 = base();
    r2.vaults.find((v) => v.isDefault)!.isDefault = false;
    r2.vaults.find((v) => v.symbol === FIXTURE.enzyme)!.isDefault = true; // NOT_ERC4626
    expect(() => registrySchema.parse(r2)).toThrow(new RegExp(`default vault \\(${FIXTURE.enzyme}\\) must be ERC-4626 and either measured open or WHITELIST_GATED`));

    const r3 = base();
    r3.vaults.find((v) => v.isDefault)!.isDefault = false;
    const paused = r3.vaults.find((v) => v.symbol === FIXTURE.fusionGated)!;
    paused.isDefault = true;
    paused.depositOpen = { ...paused.depositOpen, reason: "PAUSED" };
    expect(() => registrySchema.parse(r3)).toThrow(new RegExp(`default vault \\(${FIXTURE.fusionGated}\\) must be ERC-4626 and either measured open or WHITELIST_GATED`));

    const r4 = base(); // a WHITELIST_GATED ERC-4626 default is accepted — which is what ships
    r4.vaults.find((v) => v.isDefault)!.isDefault = false;
    r4.vaults.find((v) => v.symbol === FIXTURE.fusionGated)!.isDefault = true;
    expect(() => registrySchema.parse(r4)).not.toThrow();
  });

  it("an unknown top-level key (strict)", () => {
    const r = base() as unknown as Record<string, unknown>;
    r["extra"] = 1;
    expect(() => registrySchema.parse(r)).toThrow();
  });
});

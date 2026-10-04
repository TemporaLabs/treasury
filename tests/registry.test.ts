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
import { registrySchema, vaultEntrySchema } from "../src/registry-schema.js";
import { loadRegistry, depositableVaults, getVault, listVaults, defaultVault, resolveVault, offeredChains, defaultChainId } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";
import { CHAIN_INFO, chainIdForKey, supportedChainIds } from "../src/client.js";
import { linksFor } from "../src/links.js";
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

  it("offers THREE Tempora vaults on Base, ONE on Arbitrum One and ONE on Robinhood Chain; with nothing named, the default is Cash Plus USDC (Test 2B) on Base — open to any account", () => {
    const d = defaultVault();
    expect(listVaults().map((v) => `${v.symbol}@${v.chainId}`)).toEqual(["tlCashPlusUSDC2@8453", "tlCashPlusUSDC2A@8453", "tlCashPlusUSDC2B@8453", "tlCashPlusUSDC2C@42161", "tlCashPlusUSDG2D@4663"]);
    expect(d.symbol).toBe("tlCashPlusUSDC2B");
    expect(d.name).toBe("Tempora Labs Cash Plus USDC (Test 2B)");
    expect(d.backend).toBe("tempora");
    expect(d.chainId).toBe(8453);
    expect(d.address).toBe("0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F");
    expect(d.chassis).toBe("morpho-v2");
    expect(resolveVault()).toBe(d);
    // One default per chain, and no more: the Base one above, and Test 2C on Arbitrum One.
    expect(listVaults().filter((v) => v.isDefault).map((v) => `${v.symbol}@${v.chainId}`)).toEqual(["tlCashPlusUSDC2B@8453", "tlCashPlusUSDC2C@42161", "tlCashPlusUSDG2D@4663"]);
    for (const v of listVaults()) expect(v.backend).toBe("tempora");
  });

  it("Test 2B is the Base default; Test 2 is the DEMO vault — listed, open, and chosen only by naming it", () => {
    const b = getVault("tlCashPlusUSDC2B");
    expect(b.name).toBe("Tempora Labs Cash Plus USDC (Test 2B)");
    expect([b.chainId, b.address, b.chassis, b.shareDecimals, b.isDefault]).toEqual([8453, "0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F", "morpho-v2", 18, true]);
    const demo = getVault("tlCashPlusUSDC2");
    expect(demo.isDefault).toBe(false);
    expect(demo.depositOpen.open).toBe(true);
    expect(demo.notes.join(" ")).toMatch(/DEMO vault/);
    expect(b.asset).toEqual(demo.asset); // the same USDC on the same chain
    expect(b.depositOpen).toMatchObject({ open: true, measuredAtBlock: 52_097_648 });
    expect(b.deployedAtBlock).toBe(51_436_870);
    expect(resolveVault()).toBe(b);
    expect(resolveVault(undefined, "base")).toBe(b);
    expect(resolveVault("tlCashPlusUSDC2")).toBe(demo); // the demo, by name
    expect(resolveVault("tlCashPlusUSDC2", "base")).toBe(demo);
    expect(() => resolveVault("tlCashPlusUSDC2B", "arbitrum")).toThrow(/is on base, not arbitrum/);
  });

  it("the Arbitrum One default is Cash Plus USDC (Test 2C): a Morpho Vault V2 over NATIVE USDC, measured open", () => {
    const c = defaultVault(42161);
    expect(c.symbol).toBe("tlCashPlusUSDC2C");
    expect(c.name).toBe("Tempora Labs Cash Plus USDC (Test 2C)");
    expect(c.chainId).toBe(42161);
    expect(c.address).toBe("0x4057a63953142Ac2b3E5dB1954Fc14d578662587");
    expect(c.chassis).toBe("morpho-v2");
    expect(c.shareDecimals).toBe(18); // measured via decimals()
    // Native USDC on Arbitrum One. Bridged USDC.e is a different token at a different address, and
    // Base's USDC address is not a token on Arbitrum at all — the asset is per chain, never copied.
    expect(c.asset).toEqual({ symbol: "USDC", decimals: 6, address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" });
    expect(c.asset.address).not.toBe(getVault("tlCashPlusUSDC2").asset.address);
    expect(c.depositOpen).toMatchObject({ open: true, method: "simulated-deposit-from-stranger", measuredAtBlock: 511_070_816 });
    expect(c.depositOpen.detail).toMatch(/0xe65b7a77/); // TransferFromReverted — reached the token pull
    expect(c.deployedAtBlock).toBe(510_270_114);
    expect(resolveVault(undefined, "arbitrum")).toBe(c);
  });

  it("the Robinhood Chain default is Cash Plus USDG (Test 2D): a Morpho Vault V2 over USDG, not USDC, measured open", () => {
    const d = defaultVault(4663);
    expect(d.symbol).toBe("tlCashPlusUSDG2D");
    expect(d.name).toBe("Tempora Labs Cash Plus USDG (Test 2D)");
    expect(d.chainId).toBe(4663);
    expect(d.address).toBe("0x758f00731943aA88e8C7fB709e0B727903B4F833");
    expect(d.chassis).toBe("morpho-v2");
    expect(d.shareDecimals).toBe(18); // measured via decimals()
    // The first asset in the registry that is not USDC. Amounts are parsed in the row's own decimals,
    // so the row must carry USDG's, measured via decimals() on the token.
    expect(d.asset).toEqual({ symbol: "USDG", decimals: 6, address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" });
    expect(d.depositOpen).toMatchObject({ open: true, method: "simulated-deposit-from-stranger", measuredAtBlock: 79_974_900 });
    expect(d.depositOpen.detail).toMatch(/0xe65b7a77/); // TransferFromReverted — reached the token pull
    expect(d.deployedAtBlock).toBe(79_381_803);
    expect(resolveVault(undefined, "robinhood")).toBe(d);
  });

  it("carries MEASURED share decimals — 18 on the Morpho V2 default, 8 on the Fusion sibling, both against 6-decimal USDC", () => {
    const two = getVault("tlCashPlusUSDC2");
    const twoA = getVault("tlCashPlusUSDC2A");
    expect(two.shareDecimals).toBe(18); // measured via decimals()
    expect(two.symbol).toBe("tlCashPlusUSDC2");
    expect(twoA.shareDecimals).toBe(8);
    expect(twoA.symbol).toBe("tlCashPlusUSDC2A");
    for (const v of [two, twoA]) {
      expect(v.asset).toMatchObject({ symbol: "USDC", decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
      expect(v.shareDecimals).not.toBe(v.asset.decimals);
    }
  });

  it("🔴 the depositable set is the three chain defaults and Test 2 — each open to any account: open to any account, measured by a simulated deposit", () => {
    // The Morpho V2 vault takes a deposit from anyone (a stranger's simulated deposit reached the token
    // pull). The Fusion sibling is whitelist-gated and stays out of the set — listed so an admitted
    // account's position can be read and exited, refused for everyone else before anything is built.
    expect(depositableVaults().map((v) => v.symbol)).toEqual(["tlCashPlusUSDC2", "tlCashPlusUSDC2B", "tlCashPlusUSDC2C", "tlCashPlusUSDG2D"]);
    expect(defaultVault().depositOpen.open).toBe(true);
    expect(getVault("tlCashPlusUSDC2A").depositOpen).toMatchObject({ open: false, reason: "WHITELIST_GATED" });
  });

  it("access is a MEASUREMENT with a block on it, not a flag someone set", () => {
    const open = defaultVault().depositOpen;
    expect(open.method).toBe("simulated-deposit-from-stranger");
    expect(open.measuredAtBlock).toBeGreaterThan(51_436_870);
    expect(open.detail).toMatch(/0xe65b7a77/); // TransferFromReverted — reached the token pull, so access is open
    expect(defaultVault().deployedAtBlock).toBe(51_436_870); // Test 2B, the Base default
    expect(getVault("tlCashPlusUSDC2").deployedAtBlock).toBe(51_371_133); // Test 2, the demo
    const gated = getVault("tlCashPlusUSDC2A").depositOpen;
    expect(gated.detail).toMatch(/0x068ca9d8/); // AccessManagedUnauthorized — the revert actually observed
    expect(getVault("tlCashPlusUSDC2A").deployedAtBlock).toBe(51_359_816);
    for (const v of listVaults()) expect(v.deployedAtBlock!).toBeLessThan(v.depositOpen.measuredAtBlock);
  });

  it("config/earn.ts and the registry name the SAME default on EVERY chain — the config is the toggle, the registry the measurement", () => {
    expect(EARN.defaultChain).toBe("base");
    expect(defaultChainId()).toBe(8453);
    // Every offered chain has a config entry, and it is the row the registry marks. A chain with a
    // vault and no config entry would make `chain: "<that chain>"` throw at the first call.
    const offered = offeredChains();
    expect(offered.map((c) => c.key)).toEqual(["base", "arbitrum", "robinhood"]); // the default chain first, then the order chains were added
    expect(Object.keys(EARN.defaultVaultByChain).sort()).toEqual(offered.map((c) => c.key).sort());
    for (const c of offered) {
      const named = EARN.defaultVaultByChain[c.key];
      expect(defaultVault(c.chainId).symbol, c.key).toBe(named);
      expect(loadRegistry().vaults.filter((v) => v.chainId === c.chainId && v.isDefault).map((v) => v.symbol), c.key).toEqual([named]);
    }
    // and the round-trip target resolves — a typo'd ticker fails here, not in a fork run 20 minutes in
    expect(getVault(EARN.roundTripVault).symbol).toBe(EARN.roundTripVault);
  });

  it("`chain` and `vault` resolve to ONE vault, and a disagreement between them is refused", () => {
    const base = getVault("tlCashPlusUSDC2B");
    const arb = getVault("tlCashPlusUSDC2C");
    expect(resolveVault()).toBe(base); // neither: the default chain's default
    expect(resolveVault(undefined, "base")).toBe(base); // chain only
    expect(resolveVault(undefined, "arbitrum")).toBe(arb);
    expect(resolveVault("tlCashPlusUSDC2C")).toBe(arb); // vault only: its own chain, whatever the default chain is
    expect(resolveVault("tlCashPlusUSDC2A", "base").symbol).toBe("tlCashPlusUSDC2A"); // both, agreeing
    expect(resolveVault("tlCashPlusUSDC2C", "arbitrum")).toBe(arb);
    // both, DISAGREEING — in each direction. Picking either one would build a call for a contract
    // on a chain the caller did not mean; the error names both readings so the caller can choose.
    expect(() => resolveVault("tlCashPlusUSDC2", "arbitrum")).toThrow(/"tlCashPlusUSDC2" is on base, not arbitrum.*tlCashPlusUSDC2C/s);
    expect(() => resolveVault("tlCashPlusUSDC2C", "base")).toThrow(/"tlCashPlusUSDC2C" is on arbitrum, not base.*tlCashPlusUSDC2B/s);
    expect(() => resolveVault("tlCashPlusUSDG2D", "arbitrum")).toThrow(/"tlCashPlusUSDG2D" is on robinhood, not arbitrum.*tlCashPlusUSDC2C/s);
    // an unknown chain names the ones that exist, and is never read as "the default chain"
    expect(() => resolveVault(undefined, "solana")).toThrow(/unknown chain "solana"; chains with a vault: base, arbitrum, robinhood/);
    expect(() => resolveVault("tlCashPlusUSDC2", "Base")).toThrow(/unknown chain "Base"/); // exact keys, no case-folding guess
    expect(() => resolveVault(undefined, " arbitrum")).toThrow(/unknown chain " arbitrum"/);
    // exact keys: a prefix or a longer name is not the chain
    for (const k of ["arb", "arbitrum-sepolia", "base-sepolia", "bas"]) expect(() => resolveVault(undefined, k), k).toThrow(/unknown chain/);
    expect(chainIdForKey("arbitrum-sepolia")).toBeUndefined();
    expect(chainIdForKey("arb")).toBeUndefined();
    // An EMPTY string is an omitted argument, for `chain` exactly as it always was for `vault`: a
    // host that sends "" for every optional it did not fill gets the default, not a refusal.
    expect(resolveVault("", "")).toBe(base);
    expect(resolveVault("tlCashPlusUSDC2C", "")).toBe(arb);
    expect(resolveVault("", "arbitrum")).toBe(arb);
  });

  it("the schema accepts exactly the chains the client supports, and every one has a table row and an explorer link", () => {
    // Three lists that must stay equal: the schema's literals, `chains`/CHAIN_INFO, and links.ts's
    // explorer map. The last one is not typed against the others, so it is exercised here.
    const row = (chainId: number) => ({ ...JSON.parse(JSON.stringify(getVault("tlCashPlusUSDC2"))), chainId });
    for (const id of supportedChainIds) {
      expect(vaultEntrySchema.safeParse(row(id)).success, `schema refuses supported chain ${id}`).toBe(true);
      expect(chainIdForKey(CHAIN_INFO[id].key)).toBe(id);
      const address = "0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf";
      expect(linksFor({ chainId: id, address, chassis: "fusion" }).explorer).toMatch(new RegExp(`^https://[a-z.]+/address/${address}$`));
    }
    expect(supportedChainIds).toEqual([8453, 42161, 4663]);
    for (const id of [1, 10, 137, 0]) expect(vaultEntrySchema.safeParse(row(id)).success, `schema accepts unsupported chain ${id}`).toBe(false);
    // A chain the explorer map does not know THROWS — it used to interpolate `undefined` into a URL.
    expect(() => linksFor({ chainId: 1 as never, address: "0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf", chassis: "fusion" })).toThrow(/no block explorer is recorded for chain 1/);
  });

  it("each vault links to ITS chain's explorer, and to the Morpho app only where that page exists", () => {
    expect(linksFor(getVault("tlCashPlusUSDC2"))).toEqual({
      explorer: "https://basescan.org/address/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf",
      app: "https://app.morpho.org/base/vault/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf",
    });
    // Measured 2026-10-02: Morpho's app answers 404 for Test 2C on Arbitrum and for Test 2B on Base,
    // so neither gets an app link — a dead link is not a verification path. Restate each when its
    // page exists. 2B is the case that needs the per-ADDRESS list: it is a Morpho V2 vault on Base.
    expect(linksFor(getVault("tlCashPlusUSDC2C"))).toEqual({ explorer: "https://arbiscan.io/address/0x4057a63953142Ac2b3E5dB1954Fc14d578662587" });
    expect(linksFor(getVault("tlCashPlusUSDC2B"))).toEqual({ explorer: "https://basescan.org/address/0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F" });
    expect(linksFor(getVault("tlCashPlusUSDG2D"))).toEqual({ explorer: "https://robinhoodchain.blockscout.com/address/0x758f00731943aA88e8C7fB709e0B727903B4F833" });
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
    expect(() => registrySchema.parse(r)).toThrow(/exactly one vault per chain must be isDefault; chain 8453 has 0/);
  });

  it("a chain with a vault and no default — the rule is per chain, so one chain's default does not cover another", () => {
    const r = base();
    const arb = r.vaults.filter((v) => v.chainId === 42161);
    expect(arb.length, "premise: the fixture registry carries a vault on a second chain").toBeGreaterThan(0);
    for (const v of arb) v.isDefault = false;
    expect(r.vaults.filter((v) => v.isDefault)).toHaveLength(2); // Base and Robinhood Chain still have theirs
    expect(() => registrySchema.parse(r)).toThrow(/exactly one vault per chain must be isDefault; chain 42161 has 0/);
  });

  it("two defaults, or a default that is closed for a reason other than a whitelist", () => {
    const r = base();
    r.vaults.find((v) => v.symbol === FIXTURE.morphoOpen)!.isDefault = true;
    expect(() => registrySchema.parse(r)).toThrow(/exactly one vault per chain must be isDefault; chain 8453 has 2/);

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

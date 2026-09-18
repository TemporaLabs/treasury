import { describe, it, expect } from "vitest";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { buildWithdraw } from "../src/build.js";
import { defaultVault } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";
import { FIXTURE, fixtureVault } from "./fixtures/registry.js";

const A = EARN.fixtures.stranger;

describe("buildWithdraw — USDC in, USDC out; shares never cross the caller's boundary", () => {
  it("amount path encodes withdraw(assets, receiver, owner) in 6-decimal USDC", () => {
    const [c] = buildWithdraw(defaultVault(), { receiver: A, owner: A, assetsHuman: "50" });
    expect(c!.data.slice(0, 10)).toBe(toFunctionSelector("withdraw(uint256,address,address)"));
    const d = decodeFunctionData({ abi: erc4626Abi, data: c!.data });
    expect(d.functionName).toBe("withdraw");
    expect(d.args).toEqual([50_000_000n, A, A]);
    expect(c!.gasAdvice).toMatch(/× 1\.5/);
    expect(c!.description).toMatch(/Withdraw 50 USDC/);
  });

  it("all path encodes redeem(sharesExact) with EXACT share units — 18 on Morpho V2, 8 on Fusion", () => {
    const exact = "96.141194918047218727"; // a real 18-decimal balance (observed on a Morpho V2 vault); > 2^53 in base units
    const [c] = buildWithdraw(fixtureVault(FIXTURE.morphoOpen), { receiver: A, owner: A, all: true, sharesExact: exact });
    const d = decodeFunctionData({ abi: erc4626Abi, data: c!.data });
    expect(d.functionName).toBe("redeem");
    expect(d.args).toEqual([96141194918047218727n, A, A]);
    expect(c!.description).toMatch(/EVERYTHING/);
    // Fusion has 8-decimal shares: the same human string is a different base-unit quantity
    const [f] = buildWithdraw(fixtureVault(FIXTURE.fusionGated), { receiver: A, owner: A, all: true, sharesExact: "1.5" });
    expect(decodeFunctionData({ abi: erc4626Abi, data: f!.data }).args).toEqual([150_000_000n, A, A]);
  });

  it("all path refuses a share string with more precision than the vault has (a float artefact)", () => {
    expect(() => buildWithdraw(fixtureVault(FIXTURE.morphoOpen), { receiver: A, owner: A, all: true, sharesExact: "96.1411949180472187271" })).toThrow(
      /19 fractional digits but the token has 18/,
    );
  });

  it("refuses Enzyme", () => {
    expect(() => buildWithdraw(fixtureVault(FIXTURE.enzyme), { receiver: A, owner: A, assetsHuman: "1" })).toThrow(/no ERC-4626/);
  });
});

// Every other test in this file — and in build.test.ts and fork.test.ts — passes the SAME address
// for both roles, so none of them can tell arg 1 from arg 2. Measured: transposing `args.receiver`
// and `args.owner` in BOTH exit encodings in src/build.ts leaves `tsc -b` clean and the suite
// byte-identical (46 passed / 11 skipped). Both parameters are the same type, so the compiler
// cannot help either. These are withdrawal destinations: a transposition pays out to the share
// owner instead of the intended receiver, or burns the wrong account's shares.
const RECEIVER = "0x1111111111111111111111111111111111111111" as const; // where the USDC lands
const OWNER = "0x2222222222222222222222222222222222222222" as const; // whose shares are burnt

describe("buildWithdraw — receiver and owner are DISTINCT slots and must not transpose", () => {
  it("withdraw(assets, receiver, owner): receiver is arg 1, owner is arg 2", () => {
    const [c] = buildWithdraw(defaultVault(), { receiver: RECEIVER, owner: OWNER, assetsHuman: "50" });
    const d = decodeFunctionData({ abi: erc4626Abi, data: c!.data });
    expect(d.functionName).toBe("withdraw");
    expect(d.args![1]).toBe(RECEIVER);
    expect(d.args![2]).toBe(OWNER);
    // the human-facing string names the payee, and must not drift from the calldata
    expect(c!.description).toContain(RECEIVER);
    expect(c!.description).not.toContain(OWNER);
  });

  it("redeem(shares, receiver, owner): receiver is arg 1, owner is arg 2", () => {
    const [c] = buildWithdraw(defaultVault(), { receiver: RECEIVER, owner: OWNER, all: true, sharesExact: "1.5" });
    const d = decodeFunctionData({ abi: erc4626Abi, data: c!.data });
    expect(d.functionName).toBe("redeem");
    expect(d.args![1]).toBe(RECEIVER);
    expect(d.args![2]).toBe(OWNER);
    expect(c!.description).toContain(RECEIVER);
    expect(c!.description).not.toContain(OWNER);
  });
});

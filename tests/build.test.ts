import { describe, it, expect } from "vitest";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { buildDeposit, buildWithdraw } from "../src/build.js";
import { parseAmount } from "../src/units.js";
import { EARN } from "../src/config/earn.js";
import { FIXTURE, fixtureVault } from "./fixtures/registry.js";

const RECEIVER = EARN.fixtures.stranger;
const ACCOUNT = EARN.fixtures.usdcWhale; // distinct from RECEIVER so a transposed slot fails
const morpho = () => fixtureVault(FIXTURE.morphoOpen); // 18-dec shares / 6-dec asset
const fusion = () => fixtureVault(FIXTURE.fusionGated); // 8-dec shares / 6-dec asset

describe("buildDeposit", () => {
  it("emits approve → deposit with the right selectors, targets, and 6-decimal asset units", () => {
    const calls = buildDeposit(morpho(), { assetsHuman: "25", receiver: RECEIVER, account: ACCOUNT });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.to).toBe(morpho().asset.address);
    expect(calls[0]!.data.slice(0, 10)).toBe(toFunctionSelector("approve(address,uint256)"));
    expect(calls[1]!.to).toBe(morpho().address);
    expect(calls[1]!.data.slice(0, 10)).toBe(toFunctionSelector("deposit(uint256,address)"));
    // the observed live selector for deposit(uint256,address) is 0x6e553f65
    expect(calls[1]!.data.slice(0, 10)).toBe("0x6e553f65");

    const dep = decodeFunctionData({ abi: erc4626Abi, data: calls[1]!.data });
    expect(dep.functionName).toBe("deposit");
    expect(dep.args).toEqual([25_000_000n, RECEIVER]); // 25 USDC = 25e6, NOT 25e18
    const appr = decodeFunctionData({ abi: erc4626Abi, data: calls[0]!.data });
    expect(appr.args).toEqual([morpho().address, 25_000_000n]);
    expect(calls.every((c) => c.value === "0x0")).toBe(true);
  });

  it("step 2 carries a machine-readable allowance precondition naming the ACCOUNT, the vault, and the raw amount; step 1 carries none", () => {
    const calls = buildDeposit(morpho(), { assetsHuman: "25", receiver: RECEIVER, account: ACCOUNT });
    expect(calls[0]!.precondition).toBeUndefined();
    const pre = calls[1]!.precondition;
    expect(pre).toBeDefined();
    expect(pre!.read).toBe("allowance");
    expect(pre!.contract).toBe(morpho().asset.address);
    expect(pre!.owner).toBe(ACCOUNT); // the signer — NOT the receiver, which is a different slot
    expect(pre!.spender).toBe(morpho().address);
    expect(pre!.minimum).toBe("25000000"); // raw units, string, 6 decimals
    expect(pre!.why).toMatch(/RPC you will send through/);
  });

  it("refuses more fractional digits than the asset has (no silent truncation)", () => {
    expect(() => buildDeposit(morpho(), { assetsHuman: "1.1234567", receiver: RECEIVER, account: ACCOUNT })).toThrow(/7 fractional digits but the token has 6/);
  });

  it("refuses zero, negative, and non-numeric amounts", () => {
    expect(() => buildDeposit(morpho(), { assetsHuman: "0", receiver: RECEIVER, account: ACCOUNT })).toThrow(/positive/);
    expect(() => buildDeposit(morpho(), { assetsHuman: "-1", receiver: RECEIVER, account: ACCOUNT })).toThrow(/not a plain decimal/);
    expect(() => buildDeposit(morpho(), { assetsHuman: "1e6", receiver: RECEIVER, account: ACCOUNT })).toThrow(/not a plain decimal/);
  });

  it("refuses an Enzyme vault outright", () => {
    expect(() => buildDeposit(fixtureVault(FIXTURE.enzyme), { assetsHuman: "1", receiver: RECEIVER, account: ACCOUNT })).toThrow(/no ERC-4626 deposit\/redeem path/);
  });
});

describe("buildWithdraw({ all }) redeems in SHARE decimals, which differ per chassis", () => {
  it("Morpho V2: 1 share = 1e18", () => {
    const [call] = buildWithdraw(morpho(), { all: true, sharesExact: "1", receiver: RECEIVER, owner: RECEIVER });
    const d = decodeFunctionData({ abi: erc4626Abi, data: call!.data });
    expect(d.functionName).toBe("redeem");
    expect(d.args).toEqual([10n ** 18n, RECEIVER, RECEIVER]);
  });

  it("Fusion: 1 share = 1e8 — the same human string encodes 10^10 fewer base units", () => {
    const [call] = buildWithdraw(fusion(), { all: true, sharesExact: "1", receiver: RECEIVER, owner: RECEIVER });
    const d = decodeFunctionData({ abi: erc4626Abi, data: call!.data });
    expect(d.args).toEqual([10n ** 8n, RECEIVER, RECEIVER]);
  });

  it("would be a 10^12 error if asset decimals were used for shares on an 18/6 vault", () => {
    const shares = parseAmount("1", morpho().shareDecimals, "shares");
    const wrong = parseAmount("1", morpho().asset.decimals, "assets");
    expect(shares / wrong).toBe(10n ** 12n);
  });
});

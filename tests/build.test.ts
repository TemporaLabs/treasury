import { describe, it, expect } from "vitest";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { buildDeposit, buildWithdraw } from "../src/build.js";
import { buildServer } from "../src/mcp/server.js";
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

/**
 * treasury#11 — an operator signing through a block explorer's "Write Contract" form needs named,
 * decoded parameters, not raw calldata. The field only earns its place if it cannot disagree with
 * the bytes, so the test that matters is the round trip: decode `data` INDEPENDENTLY and require it
 * to match what `function`/`args` claim. Production deliberately does not decode — this is the one
 * place that does, precisely so a drift between the two has somewhere to fail.
 */
describe("the decoded call agrees with the calldata it is shipped beside (#11)", () => {
  /** Every call any builder can produce, so a new builder that skips `encodeCall` shows up here. */
  const everyCall = () => [
    ...buildDeposit(morpho(), { assetsHuman: "25", receiver: RECEIVER, account: ACCOUNT }),
    ...buildDeposit(fusion(), { assetsHuman: "1.5", receiver: RECEIVER, account: ACCOUNT }),
    ...buildWithdraw(morpho(), { receiver: RECEIVER, owner: ACCOUNT, assetsHuman: "7" }),
    ...buildWithdraw(fusion(), { receiver: RECEIVER, owner: ACCOUNT, all: true, sharesExact: "3.25" }),
  ];

  it("🔴 every call's function name and named args round-trip against its own data", () => {
    for (const c of everyCall()) {
      const decoded = decodeFunctionData({ abi: erc4626Abi, data: c.data });
      expect(c.function, `${c.description}: a signature is present`).toMatch(/^[a-zA-Z0-9_]+\(.*\)$/);
      // the name in `function` is the name the bytes actually encode
      expect(c.function.slice(0, c.function.indexOf("("))).toBe(decoded.functionName);
      // and every value in `args`, in order, is the value the bytes carry
      const claimed = Object.values(c.args);
      const actual = (decoded.args as readonly unknown[]).map(String);
      expect(claimed, `${c.function}: ${claimed.join()} vs ${actual.join()}`).toEqual(actual);
    }
  });

  it("names every parameter — an explorer form is unfillable without them", () => {
    for (const c of everyCall()) {
      const inside = c.function.slice(c.function.indexOf("(") + 1, -1);
      const params = inside.split(", ");
      expect(params.length, c.function).toBe(Object.keys(c.args).length);
      for (const p of params) expect(p, `${c.function} has an unnamed parameter`).toMatch(/^[a-z0-9\[\]]+ [a-zA-Z_][a-zA-Z0-9_]*$/);
      expect(Object.keys(c.args).every((k) => !/^arg\d+$/.test(k)), `${c.function} fell back to positional names`).toBe(true);
    }
  });

  it("reads the exact shapes the issue asked for", () => {
    const [approve, deposit] = buildDeposit(morpho(), { assetsHuman: "1", receiver: RECEIVER, account: ACCOUNT });
    expect(approve!.function).toBe("approve(address spender, uint256 value)");
    expect(approve!.args).toEqual({ spender: morpho().address, value: "1000000" });
    expect(deposit!.function).toBe("deposit(uint256 assets, address receiver)");
    expect(deposit!.args).toEqual({ assets: "1000000", receiver: RECEIVER });
  });

  it("args are RAW contract units, matching the form — never the human decimals in `description`", () => {
    // 1.5 USDC is 1500000 to the contract. An operator pasting "1.5" into an explorer sends
    // 1.5 × 10^6 times too little... and pasting 1500000 where 1.5 was shown is the same bug the
    // other way. The `description` is the sentence; `args` is what goes in the form.
    const [approve] = buildDeposit(fusion(), { assetsHuman: "1.5", receiver: RECEIVER, account: ACCOUNT });
    expect(approve!.args.value).toBe("1500000");
    expect(approve!.description).toContain("1.5");
  });

  it("the withdraw-everything path is decoded too — redeem takes SHARES, in share decimals", () => {
    const [redeem] = buildWithdraw(fusion(), { receiver: RECEIVER, owner: ACCOUNT, all: true, sharesExact: "3.25" });
    expect(redeem!.function).toBe("redeem(uint256 shares, address receiver, address owner)");
    // 8-decimal shares: 3.25 shares = 325000000, NOT 3250000 (the asset's 6 decimals)
    expect(redeem!.args).toEqual({ shares: "325000000", receiver: RECEIVER, owner: ACCOUNT });
  });

  it("the existing envelope is unchanged — these are additions, not a reshape", () => {
    const calls = buildDeposit(morpho(), { assetsHuman: "25", receiver: RECEIVER, account: ACCOUNT });
    for (const c of calls) {
      expect(c).toHaveProperty("to");
      expect(c).toHaveProperty("data");
      expect(c.value).toBe("0x0");
      expect(c.description).toBeTypeOf("string");
      expect(c.gasAdvice).toBeTypeOf("string");
    }
    expect(calls[1]!.precondition?.read).toBe("allowance");
  });
});


/**
 * A response field an agent is expected to SURFACE has to be named in the tool's own description,
 * not only in `docs/tools.md`.
 *
 * The discriminator, which is the part worth keeping: **does an agent learn this field exists
 * without reading a file it never reads?** `docs/tools.md` is the human integrator's document; the
 * description is what reaches the model before it decides what to tell an operator. It bites
 * hardest here, because the entire point of `function`/`args` is helping an operator who cannot
 * read calldata — and the agent that would offer them is the one being told they exist.
 */
describe("the prepare tools tell an agent the decoded form exists (#11)", () => {
  type Registered = Record<string, { description?: string }>;
  const described = (name: string) =>
    ((buildServer() as unknown as { _registeredTools: Registered })._registeredTools[name] ?? {}).description ?? "";

  for (const name of ["earn_prepare_deposit", "earn_prepare_withdraw"]) {
    it(`${name}'s description names function and args`, () => {
      const d = described(name);
      expect(d, "the description must exist at all").not.toBe("");
      expect(d).toContain("`function`");
      expect(d).toContain("`args`");
      // the unit trap travels with the field, or an operator pastes "1.5" where 1500000 belongs
      expect(d).toMatch(/RAW contract units|raw contract units/);
    });
  }
});

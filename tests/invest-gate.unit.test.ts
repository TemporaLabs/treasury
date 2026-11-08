/**
 * The portfolio-withdrawal gate (`src/invest/gate.ts`), offline. Authorizations are built in the shape the
 * provider returns them (a sale is version "2", a plain USDT transfer version "1"), then altered one way at a
 * time. The bound under test throughout: amounts are held to the chain's balances, never to the service's plan.
 */
import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { admitWithdrawal, allowedOf, parseFraction, type WithdrawalAuthorization } from "../src/invest/gate.js";
import { BNB_USDT, BNB_USDT_ASSET_ID, assetIdOf, tokenOf } from "../src/invest/chain.js";
import { INVEST } from "../src/config/invest.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const SMART = getAddress("0x2222222222222222222222222222222222222222");
const STOCK = getAddress("0x3333333333333333333333333333333333333333");
const OTHER = getAddress("0x4444444444444444444444444444444444444444");
const NOW = Date.parse("2026-11-08T12:00:00Z");
const EXPIRES = Math.floor(NOW / 1000) + 600;

const types = (sale: boolean) => ({
  Withdrawal: [
    { name: "portfolioId", type: "string" },
    { name: "recipientAccountId", type: "string" },
    { name: "assets", type: "WithdrawalAsset[]" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    ...(sale ? [{ name: "liquidate", type: "bool" }, { name: "settlementAssetId", type: "string" }] : []),
  ],
  WithdrawalAsset: [
    { name: "assetId", type: "string" },
    { name: "amountRaw", type: "string" },
  ],
});

function auth(assets: { token: Address; amount: bigint }[], o: { sale?: boolean; nonce?: number } = {}): WithdrawalAuthorization {
  const sale = o.sale ?? true;
  return {
    domain: { name: "Glider Withdrawal Authorization", version: sale ? "2" : "1", chainId: 56, verifyingContract: SMART },
    types: types(sale),
    primaryType: "Withdrawal",
    message: {
      portfolioId: "P1",
      recipientAccountId: `eip155:56:${OWNER}`,
      assets: assets.map((a) => ({ assetId: assetIdOf(a.token), amountRaw: a.amount.toString() })),
      nonce: `0x${(o.nonce ?? 0).toString(16).padStart(64, "0")}`,
      expiresAt: EXPIRES,
      ...(sale ? { liquidate: true, settlementAssetId: BNB_USDT_ASSET_ID } : {}),
    },
  };
}

const holdings = new Map<Address, bigint>([
  [STOCK, 1000n],
  [BNB_USDT.address, 500n],
]);
const expectFor = (over: Partial<Parameters<typeof admitWithdrawal>[2]> = {}) => ({ owner: OWNER, smartAccount: SMART, portfolioId: "P1", holdings, now: NOW, ...over });
const ALL = parseFraction("all");
const QUARTER = parseFraction("0.25");

describe("parseFraction", () => {
  it("reads all, and decimals in (0, 1] with up to six places", () => {
    expect(parseFraction("all")).toEqual({ all: true });
    expect(parseFraction("1")).toEqual({ all: true });
    expect(parseFraction("1.000000")).toEqual({ all: true });
    expect(parseFraction("0.25")).toEqual({ all: false, num: 250000n, den: 1000000n });
    expect(allowedOf(1000n, QUARTER)).toBe(250n);
    expect(allowedOf(1001n, QUARTER)).toBe(250n); // rounded down
  });
  it.each(["0", "0.0", "1.5", "2", "-0.5", ".5", "0.1234567", "25%", "0x1", "", " "])("refuses %j", (t) => {
    expect(() => parseFraction(t)).toThrow(/refused/);
  });
});

describe("tokenOf", () => {
  it("reads a BNB Chain token id and nothing else", () => {
    expect(tokenOf(assetIdOf(STOCK))).toBe(STOCK);
    expect(tokenOf(`eip155:8453/erc20:${STOCK}`)).toBeNull();
    expect(tokenOf(`eip155:56/erc721:${STOCK}`)).toBeNull();
    expect(tokenOf(`eip155:56/erc20:0x123`)).toBeNull();
    expect(tokenOf(5)).toBeNull();
  });
});

describe("admitWithdrawal", () => {
  it("admits a sale within the fraction, summed from the signed amounts, with a digest over the batches", () => {
    const a = admitWithdrawal([auth([{ token: STOCK, amount: 250n }])], QUARTER, expectFor());
    expect(a.kind).toBe("sale");
    expect(a.totals).toEqual([{ token: STOCK, amount: 250n, held: 1000n }]);
    expect(a.expiresAt.getTime()).toBe(EXPIRES * 1000);
    expect(a.digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("admits `all` up to the full balance, and a USDT transfer", () => {
    expect(admitWithdrawal([auth([{ token: STOCK, amount: 1000n }])], ALL, expectFor()).totals[0]!.amount).toBe(1000n);
    expect(admitWithdrawal([auth([{ token: BNB_USDT.address, amount: 500n }], { sale: false })], ALL, expectFor()).kind).toBe("transfer");
  });

  // The acceptance test: a service that inflates both its plan and the authorizations is still refused,
  // because the bound comes from the chain. There is no plan argument at all.
  it("refuses an amount above the fraction of the on-chain balance, whatever the service planned", () => {
    expect(() => admitWithdrawal([auth([{ token: STOCK, amount: 251n }])], QUARTER, expectFor())).toThrow(/more than the asked fraction.*250 of 1000/);
    expect(() => admitWithdrawal([auth([{ token: STOCK, amount: 1001n }])], ALL, expectFor())).toThrow(/more than the account holds/);
  });

  it("sums one asset across batches before bounding it", () => {
    const split = [auth([{ token: STOCK, amount: 200n }], { nonce: 1 }), auth([{ token: STOCK, amount: 100n }], { nonce: 2 })];
    expect(() => admitWithdrawal(split, QUARTER, expectFor())).toThrow(/300 units.*250 of 1000/);
  });

  it("binds the digest to the full ordered set", () => {
    const one = auth([{ token: STOCK, amount: 100n }], { nonce: 1 });
    const two = auth([{ token: STOCK, amount: 100n }], { nonce: 2 });
    const ab = admitWithdrawal([one, two], ALL, expectFor()).digest;
    expect(admitWithdrawal([two, one], ALL, expectFor()).digest).not.toBe(ab);
    expect(admitWithdrawal([one], ALL, expectFor()).digest).not.toBe(ab);
  });

  it("refuses an asset the account does not hold", () => {
    expect(() => admitWithdrawal([auth([{ token: OTHER, amount: 1n }])], ALL, expectFor())).toThrow(/does not hold/);
  });

  const alter = (f: (a: WithdrawalAuthorization) => void) => {
    const a = auth([{ token: STOCK, amount: 100n }]);
    f(a);
    return () => admitWithdrawal([a], ALL, expectFor());
  };

  it.each<[string, (a: WithdrawalAuthorization) => void, RegExp]>([
    ["another smart account", (a) => (a.domain["verifyingContract"] = OTHER), /take funds from/],
    ["another recipient", (a) => (a.message["recipientAccountId"] = `eip155:56:${OTHER}`), /would pay/],
    ["the owner on another chain", (a) => (a.message["recipientAccountId"] = `eip155:1:${OWNER}`), /would pay/],
    ["another portfolio", (a) => (a.message["portfolioId"] = "P2"), /another portfolio/],
    ["another chain", (a) => (a.domain["chainId"] = 1), /chain 1/],
    ["settles in something else", (a) => (a.message["settlementAssetId"] = assetIdOf(OTHER)), /other than USDT/],
    ["expired", (a) => (a.message["expiresAt"] = Math.floor(NOW / 1000)), /expired/],
    ["a zero amount", (a) => ((a.message["assets"] as { amountRaw: string }[])[0]!.amountRaw = "0"), /whole number/],
    ["a hex amount", (a) => ((a.message["assets"] as { amountRaw: string }[])[0]!.amountRaw = "0x10"), /whole number/],
    ["an asset on another chain", (a) => ((a.message["assets"] as { assetId: string }[])[0]!.assetId = `eip155:8453/erc20:${STOCK}`), /not a token/],
    ["the same asset twice", (a) => (a.message["assets"] as unknown[]).push({ assetId: assetIdOf(STOCK), amountRaw: "1" }), /same asset twice/],
    ["no assets", (a) => (a.message["assets"] = []), /no asset/],
    ["an unsigned extra field", (a) => (a.message["memo"] = "x"), /not in the form/],
    ["an extra signed field", (a) => (a.types["Withdrawal"] as unknown[]).push({ name: "memo", type: "string" }), /not in the form/],
    ["a field retyped", (a) => ((a.types["Withdrawal"] as { name: string; type: string }[])[0]!.type = "bytes32"), /not in the form/],
    ["another primary type", (a) => (a.primaryType = "Transfer"), /not in the form/],
    ["another domain name", (a) => (a.domain["name"] = "Something Else"), /not in the form/],
    ["a sale under version 1", (a) => (a.domain["version"] = "1"), /not in the form/],
    ["an extra type", (a) => (a.types["Extra"] = [{ name: "x", type: "string" }]), /not in the form/],
    ["a domain type without the account", (a) => (a.types["EIP712Domain"] = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }]), /not in the form/],
    ["a malformed nonce", (a) => (a.message["nonce"] = "0x01"), /not in the form/],
    ["an unsigned key on an asset", (a) => ((a.message["assets"] as Record<string, string>[])[0]!["note"] = "x"), /not in the form/],
    ["an asset missing a field", (a) => delete (a.message["assets"] as Record<string, string>[])[0]!["amountRaw"], /whole number|not in the form/],
    ["an expiry past the ceiling", (a) => (a.message["expiresAt"] = Math.floor(NOW / 1000) + INVEST.maxAuthorizationLifetimeSeconds + 1), /stays valid for more than/],
  ])("refuses %s", (_why, f, msg) => {
    expect(alter(f)).toThrow(msg);
  });

  it("refuses a transfer that moves anything but USDT, and batches mixing a sale and a transfer", () => {
    expect(() => admitWithdrawal([auth([{ token: STOCK, amount: 1n }], { sale: false })], ALL, expectFor())).toThrow(/without selling/);
    const mixed = [auth([{ token: STOCK, amount: 1n }]), auth([{ token: BNB_USDT.address, amount: 1n }], { sale: false, nonce: 1 })];
    expect(() => admitWithdrawal(mixed, ALL, expectFor())).toThrow(/mix a sale/);
  });

  it("refuses nothing to sign", () => {
    expect(() => admitWithdrawal([], ALL, expectFor())).toThrow(/no authorization/);
  });
});

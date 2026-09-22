import { describe, it, expect } from "vitest";
import { encodeFunctionData, erc20Abi, getAddress, keccak256 as viemKeccak, maxUint256, toBytes, type Address, type Hex } from "viem";
import { erc4626Abi } from "../../src/abi/erc4626.js";
import { buildDeposit, buildWithdraw, type UnsignedCall } from "../../src/build.js";
import { loadRegistry, getVault } from "../../src/registry.js";
import { validatePayload, validateFollow, rebindPayload, validateThen, rebindThen, placeholderAccount, parseAmount, buildManualCalls, balanceOfCalldata, convertToAssetsCalldata, keccak256, toChecksumAddress, parseAddress, buildTransferCall, validateSend, decodeCall, encodePayload, decodePayload, slimPayload, SELECTORS } from "../validate.mjs";

// The page ships the real registry, so these tests read the real registry and the real builders:
// a control here is what an agent's `earn_prepare_*` call would actually hand over, and a mutation
// is one field of it changed. If the builder ever changes shape, the controls go red first.
const registry = loadRegistry();
const vault = getVault("tlCashPlusUSDC2");
const sibling = getVault("tlCashPlusUSDC2A");
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const FOREIGN = "0x3333333333333333333333333333333333333333" as Address;

const deposit = (amount = "25") => buildDeposit(vault, { assetsHuman: amount, receiver: ACCOUNT, account: ACCOUNT });
const withdraw = () => buildWithdraw(vault, { assetsHuman: "10", receiver: ACCOUNT, owner: ACCOUNT });
const redeemAll = () => buildWithdraw(vault, { all: true, sharesExact: "12.5", receiver: ACCOUNT, owner: ACCOUNT });
const payload = (calls: unknown[], account: string = ACCOUNT) => ({ account, calls });
const check = (calls: unknown[], account: string = ACCOUNT) => validatePayload(payload(calls, account), registry);

const enc = (functionName: "approve" | "deposit" | "withdraw" | "redeem", args: unknown[]): Hex =>
  encodeFunctionData({ abi: erc4626Abi, functionName, args } as never);
const withData = (c: UnsignedCall, data: Hex): UnsignedCall => ({ ...c, data });
const withTo = (c: UnsignedCall, to: string): UnsignedCall => ({ ...c, to: to as Address });

describe("controls: what the builders emit is accepted", () => {
  it.each([
    ["approve → deposit", deposit],
    ["withdraw", withdraw],
    ["redeem (withdraw everything)", redeemAll],
  ])("%s", (_name, make) => {
    const out = check(make());
    expect(out).toHaveLength(make().length);
    expect(out.every((c: { vault: { symbol: string } }) => c.vault.symbol === vault.symbol)).toBe(true);
  });

  it("the sibling vault is accepted the same way", () => {
    expect(() => check(buildDeposit(sibling, { assetsHuman: "1", receiver: ACCOUNT, account: ACCOUNT }))).not.toThrow();
  });

  it("the deposit's derived precondition is exactly the one the builder emits (they cannot drift)", () => {
    const calls = deposit("25.5");
    const out = check(calls);
    const p = calls[1]!.precondition!;
    expect(out[0].precondition).toBeUndefined();
    expect(out[1].precondition).toEqual({ read: p.read, contract: p.contract, owner: p.owner, spender: p.spender, minimum: p.minimum });
  });

  it("the decoded arguments are what the calldata says, not what the description says", () => {
    const out = check(deposit("25"));
    expect(out[0].decoded).toMatchObject({ fn: "approve", spender: vault.address.toLowerCase(), amount: 25_000_000n });
    expect(out[1].decoded).toMatchObject({ fn: "deposit", assets: 25_000_000n, receiver: ACCOUNT });
  });

  it("the four selectors are the ones the ABI produces", () => {
    for (const [sel, fn] of Object.entries(SELECTORS)) {
      const data = enc(fn as never, fn === "approve" ? [vault.address, 1n] : fn === "deposit" ? [1n, ACCOUNT] : [1n, ACCOUNT, ACCOUNT]);
      expect(data.slice(0, 10)).toBe(sel);
      expect(decodeCall(data).fn).toBe(fn);
    }
  });
});

describe("a poisoned envelope is refused, by name", () => {
  const cases: [string, () => unknown[], RegExp][] = [
    ["deposit into a vault the registry does not list", () => [deposit()[0], withTo(deposit()[1]!, FOREIGN)], /not exactly matched|not a registry vault/],
    ["withdraw from a vault the registry does not list", () => [withTo(withdraw()[0]!, FOREIGN)], /not a registry vault/],
    ["approve to a spender that is not a registry vault", () => [withData(deposit()[0]!, enc("approve", [FOREIGN, 25_000_000n])), deposit()[1]], /spender .* is not a registry vault/],
    ["approve on a token that is not the vault's asset", () => [withTo(deposit()[0]!, FOREIGN), deposit()[1]], /not the asset of/],
    ["an unlimited approval", () => [withData(deposit()[0]!, enc("approve", [vault.address, maxUint256])), deposit()[1]], /not exactly matched by a deposit of that amount/],
    ["an approval larger than the deposit", () => [withData(deposit()[0]!, enc("approve", [vault.address, 26_000_000n])), deposit()[1]], /not exactly matched/],
    ["an approval with no deposit after it", () => [deposit()[0]], /allowed sequences/],
    ["a deposit then an approval (wrong order)", () => [deposit()[1], deposit()[0]], /allowed sequences/],
    ["a deposit mixed with a withdrawal", () => [deposit()[1], withdraw()[0]], /allowed sequences/],
    ["three calls", () => [deposit()[0], deposit()[1], deposit()[1]], /at most two/],
    ["a transfer() of the asset", () => [withData(deposit()[0]!, ("0xa9059cbb" + "0".repeat(24) + OTHER.slice(2) + (25_000_000n).toString(16).padStart(64, "0")) as Hex)], /selector 0xa9059cbb is not/],
    ["a deposit whose receiver is someone else", () => [deposit()[0], withData(deposit()[1]!, enc("deposit", [25_000_000n, OTHER]))], /receiver .* is not the connected account/],
    ["a withdrawal paid to someone else", () => [withData(withdraw()[0]!, enc("withdraw", [10_000_000n, OTHER, ACCOUNT]))], /receiver .* is not the connected account/],
    ["a redeem whose owner is someone else", () => [withData(redeemAll()[0]!, enc("redeem", [1n, ACCOUNT, OTHER]))], /owner .* is not the connected account/],
    ["the wrong chain", () => [{ ...withdraw()[0]!, chainId: 1 }], /is not Base/],
    ["value attached to a call", () => [{ ...withdraw()[0]!, value: "0xde0b6b3a7640000" }], /value must be 0/],
    ["truncated calldata", () => [withData(withdraw()[0]!, withdraw()[0]!.data.slice(0, -2) as Hex)], /wrong length/],
    ["an address word with dirty upper bytes", () => [withData(withdraw()[0]!, (withdraw()[0]!.data.slice(0, 10 + 64) + "ff" + withdraw()[0]!.data.slice(10 + 64 + 2)) as Hex)], /not a clean address word/],
    ["a zero amount", () => [withData(withdraw()[0]!, enc("withdraw", [0n, ACCOUNT, ACCOUNT]))], /amount is zero/],
    ["a deposit whose precondition asks for less than it spends", () => [deposit()[0], { ...deposit()[1]!, precondition: { ...deposit()[1]!.precondition!, minimum: "1" } }], /not the allowance this deposit needs/],
    ["a deposit whose precondition reads someone else's allowance", () => [deposit()[0], { ...deposit()[1]!, precondition: { ...deposit()[1]!.precondition!, owner: OTHER } }], /not the allowance this deposit needs/],
    ["a description that is a wall of text", () => [{ ...withdraw()[0]!, description: "x".repeat(401) }], /description/],
    ["no calls", () => [], /calls is empty/],
    ["a call that is not an object", () => [null], /not an object/],
  ];
  it.each(cases)("%s", (_name, make, why) => {
    expect(() => check(make())).toThrow(why);
  });

  it("an account that is not an address", () => {
    expect(() => check(withdraw(), "0xnope")).toThrow(/not an address/);
  });

  it("a receiver that is the account only by case is accepted, and one that differs by a digit is not", () => {
    const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as Address;
    const ok = buildWithdraw(vault, { assetsHuman: "1", receiver: mixed.toLowerCase() as Address, owner: mixed.toLowerCase() as Address });
    expect(() => check(ok, mixed)).not.toThrow();
    const off = buildWithdraw(vault, { assetsHuman: "1", receiver: mixed.toLowerCase().replace(/1$/, "2") as Address, owner: mixed.toLowerCase() as Address });
    expect(() => check(off, mixed)).toThrow(/receiver/);
  });

  it("nothing in a refused envelope is returned: it is all-or-nothing", () => {
    expect(() => check([deposit()[0], withData(deposit()[1]!, enc("deposit", [25_000_000n, OTHER]))])).toThrow();
  });
});

describe("what crosses into the URL", () => {
  it("round-trips losslessly, including non-ASCII descriptions", () => {
    const p = slimPayload(ACCOUNT, deposit().map((c) => ({ ...c, description: "Déposer 25 USDC → 🏦" })));
    expect(decodePayload(encodePayload(p))).toEqual(p);
  });

  it("carries the display text and the call, and leaves behind everything the page re-derives", () => {
    const slim = slimPayload(ACCOUNT, deposit());
    for (const c of slim.calls) expect(Object.keys(c).sort()).toEqual(["chainId", "data", "description", "to", "value"]);
    expect(() => check(slim.calls)).not.toThrow();
  });

  it("is URL-safe", () => {
    expect(encodePayload(slimPayload(ACCOUNT, deposit()))).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});


describe("follow the wallet: an envelope for one account, re-aimed at the wallet that connects", () => {
  const follow = (calls: unknown[]) => ({ ...slimPayload(placeholderAccount(calls as never), calls as never), follow: true });

  it("the envelope names exactly one account, and that is the placeholder", () => {
    expect(placeholderAccount(deposit() as never)).toBe(ACCOUNT.toLowerCase());
    expect(placeholderAccount(withdraw() as never)).toBe(ACCOUNT.toLowerCase());
  });

  it("an envelope that names two accounts is refused (there is nothing single to re-aim)", () => {
    const [approve, dep] = deposit();
    const split = [approve!, withData(dep!, enc("deposit", [25_000_000n, OTHER]))];
    expect(() => placeholderAccount(split as never)).not.toThrow(); // one account: OTHER
    const mixed = withdraw().map((c) => withData(c, enc("withdraw", [10_000_000n, OTHER, ACCOUNT])));
    expect(() => placeholderAccount(mixed as never)).toThrow(/2 different accounts/);
  });

  it("a deposit is re-aimed: receiver becomes the connected wallet, and nothing else changes", () => {
    const calls = deposit();
    const out = rebindPayload(follow(calls), OTHER, registry);
    expect(out[0].data).toBe(calls[0]!.data); //                                 the approve does not name an account
    expect(out[1].decoded.receiver).toBe(OTHER.toLowerCase());
    expect(out[1].decoded.assets).toBe(25_000_000n); //                          same amount
    expect(out[1].to.toLowerCase()).toBe(calls[1]!.to.toLowerCase()); //         same vault
    expect(out[1].data.slice(0, 74)).toBe(calls[1]!.data.slice(0, 74)); //       selector + amount are byte-identical
    expect(out[1].precondition.owner).toBe(OTHER); //                            the allowance read follows the wallet
  });

  it("a withdrawal is re-aimed on both receiver and owner", () => {
    const out = rebindPayload(follow(withdraw()), OTHER, registry);
    expect(out[0].decoded.receiver).toBe(OTHER.toLowerCase());
    expect(out[0].decoded.owner).toBe(OTHER.toLowerCase());
    expect(out[0].decoded.assets).toBe(10_000_000n);
  });

  it("a redeem cannot follow: it is one account's exact share balance", () => {
    expect(() => validateFollow(follow(redeemAll()), registry)).toThrow(/cannot follow the connected wallet/);
    expect(() => rebindPayload(follow(redeemAll()), OTHER, registry)).toThrow(/cannot follow/);
  });

  it("re-aiming never widens what the strict check allows: a foreign vault, a bad selector or a zero amount still fail", () => {
    const [approve, dep] = deposit();
    expect(() => validateFollow(follow([approve, withTo(dep!, FOREIGN)]), registry)).toThrow();
    expect(() => validateFollow(follow([withData(dep!, "0xa9059cbb" + dep!.data.slice(10) as Hex)]), registry)).toThrow(/selector/);
    expect(() => rebindPayload(follow(deposit()), "not-an-address", registry)).toThrow(/not an address/);
  });

  it("the re-aimed calls pass the strict check for the new account, which is the invariant that matters", () => {
    const out = rebindPayload(follow(deposit()), OTHER, registry);
    expect(() => validatePayload({ account: OTHER, calls: out.map(({ decoded: _d, vault: _v, precondition: _p, ...c }: any) => c) }, registry)).not.toThrow();
    expect(() => validatePayload({ account: ACCOUNT, calls: out.map(({ decoded: _d, vault: _v, precondition: _p, ...c }: any) => c) }, registry)).toThrow(/is not the connected account/);
  });
});


describe("a follow-up withdrawal after a deposit", () => {
  const slim = (calls: unknown[]) => slimPayload(ACCOUNT, calls as never).calls;
  const withThen = (thenCalls: unknown[], first = deposit()) => ({ account: ACCOUNT, calls: slim(first), then: slim(thenCalls) });
  const firstOf = (p: { account: string; calls: unknown[] }) => validatePayload(p, registry);

  it("a withdraw of no more than the deposit, from the same vault, is accepted", () => {
    const p = withThen(withdraw()); // deposit 25, withdraw 10
    expect(validateThen(p, registry, firstOf(p))).toHaveLength(1);
  });

  it("no follow-up is fine, and yields nothing", () => {
    const p = { account: ACCOUNT, calls: slim(deposit()) };
    expect(validateThen(p, registry, firstOf(p))).toEqual([]);
  });

  it("it only follows a deposit: a withdraw cannot be the first thing, with a withdraw after it", () => {
    const p = withThen(withdraw(), withdraw());
    expect(() => validateThen(p, registry, firstOf(p))).toThrow(/only follows a deposit/);
  });

  it("it cannot withdraw more than was deposited", () => {
    const p = { account: ACCOUNT, calls: slim(deposit("5")), then: slim(withdraw()) }; // deposit 5, withdraw 10
    expect(() => validateThen(p, registry, firstOf(p))).toThrow(/more than the deposit/);
  });

  it("it cannot be a redeem, a second call, or a different vault", () => {
    const p1 = withThen(redeemAll());
    expect(() => validateThen(p1, registry, firstOf(p1))).toThrow(/must be a withdraw/);
    const p2 = withThen([...withdraw(), ...withdraw()]);
    expect(() => validateThen(p2, registry, firstOf(p2))).toThrow(/exactly one withdraw/);
    const p3 = withThen(buildWithdraw(sibling, { assetsHuman: "1", receiver: ACCOUNT, owner: ACCOUNT }));
    expect(() => validateThen(p3, registry, firstOf(p3))).toThrow(/different vault/);
  });

  it("it is checked like any call: a receiver that is not the account is refused", () => {
    const p = withThen(buildWithdraw(vault, { assetsHuman: "1", receiver: OTHER, owner: ACCOUNT }));
    expect(() => validateThen(p, registry, firstOf(p))).toThrow(/is not the connected account/);
  });

  it("it is re-aimed with the deposit when the page follows a wallet", () => {
    const p = { ...withThen(withdraw()), follow: true };
    const first = rebindPayload(p, OTHER, registry);
    const then = rebindThen(p, OTHER, registry, first);
    expect(then).toHaveLength(1);
    expect(then[0].decoded.receiver).toBe(OTHER.toLowerCase());
    expect(then[0].decoded.owner).toBe(OTHER.toLowerCase());
  });
});


describe("manual mode: the page builds the calls from a typed amount", () => {
  const v = vault as never;
  const strip = (calls: { to: string; data: string }[]) => calls.map((c) => ({ to: c.to.toLowerCase(), data: c.data.toLowerCase() }));

  it("its calldata is byte-identical to what Treasury's own builders emit, so the two cannot drift", () => {
    expect(strip(buildManualCalls("deposit", { vault: v, account: ACCOUNT, assets: 25_000_000n }))).toEqual(strip(deposit()));
    expect(strip(buildManualCalls("withdraw", { vault: v, account: ACCOUNT, assets: 10_000_000n }))).toEqual(strip(withdraw()));
    expect(strip(buildManualCalls("redeem", { vault: v, account: ACCOUNT, shares: 12_500_000_000_000_000_000n }))).toEqual(strip(redeemAll()));
  });

  it("everything it builds passes the same validator an agent's envelope does", () => {
    for (const kind of ["deposit", "withdraw"] as const) {
      const calls = buildManualCalls(kind, { vault: v, account: ACCOUNT, assets: 1_500_000n });
      expect(() => validatePayload({ account: ACCOUNT, calls }, registry)).not.toThrow();
    }
    const redeem = buildManualCalls("redeem", { vault: v, account: ACCOUNT, shares: 1n });
    expect(() => validatePayload({ account: ACCOUNT, calls: redeem }, registry)).not.toThrow();
  });

  it("a deposit is [approve, deposit], or just [deposit] when the allowance already covers it", () => {
    expect(buildManualCalls("deposit", { vault: v, account: ACCOUNT, assets: 5n })).toHaveLength(2);
    expect(buildManualCalls("deposit", { vault: v, account: ACCOUNT, assets: 5n, allowance: 4n })).toHaveLength(2);
    expect(buildManualCalls("deposit", { vault: v, account: ACCOUNT, assets: 5n, allowance: 5n })).toHaveLength(1);
  });

  it("the approve is exactly the deposit amount and names only the vault", () => {
    const [approve, dep] = buildManualCalls("deposit", { vault: v, account: ACCOUNT, assets: 7_000_000n });
    expect(decodeCall(approve!.data)).toMatchObject({ fn: "approve", amount: 7_000_000n });
    expect(decodeCall(approve!.data).spender).toBe(vault.address.toLowerCase());
    expect(decodeCall(dep!.data)).toMatchObject({ fn: "deposit", assets: 7_000_000n, receiver: ACCOUNT.toLowerCase() });
  });

  it("the receiver and owner are always the account it was built for, never anything else", () => {
    const [w] = buildManualCalls("withdraw", { vault: v, account: OTHER, assets: 1n });
    expect(decodeCall(w!.data)).toMatchObject({ receiver: OTHER.toLowerCase(), owner: OTHER.toLowerCase() });
    expect(() => validatePayload({ account: ACCOUNT, calls: [w] }, registry)).toThrow(/is not the connected account/);
  });

  it("an unknown action builds nothing", () => {
    expect(() => buildManualCalls("transfer" as never, { vault: v, account: ACCOUNT, assets: 1n })).toThrow(/unknown action/);
  });

  it.each([
    ["25", 25_000_000n], ["0.5", 500_000n], [" 1.25 ", 1_250_000n], ["0.000001", 1n], ["1000000", 1_000_000_000_000n],
  ])("parses %j as %s", (text, want) => expect(parseAmount(text, 6)).toBe(want));

  it.each(["", " ", "0", "0.0", "0.0000001", "1e3", "-5", "+5", "abc", "1,5", "1.", ".5", "0x10", "1 000", "9999999999999999"])(
    "refuses %j", (text) => expect(() => parseAmount(text, 6)).toThrow());

  it("the read helpers encode what the vault ABI expects", () => {
    expect(balanceOfCalldata(ACCOUNT)).toBe("0x70a08231" + "0".repeat(24) + "1".repeat(40));
    expect(convertToAssetsCalldata(255n)).toBe("0x07a2d13a" + "0".repeat(62) + "ff");
  });
});


describe("send (Privy mode): USDC out to an address the operator typed", () => {
  const RECIPIENT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as Address; // an EIP-55 test-vector address
  const v = vault as never;
  const sendCalls = (to: string = RECIPIENT, assets = 1_200_000n) => [buildTransferCall({ vault: v, to, assets })];
  const send = (calls: unknown[] = sendCalls(), account: string = ACCOUNT) => validateSend(calls, account, registry);

  it("keccak-256 agrees with viem on empty, short, block-boundary and long inputs", () => {
    for (const n of [0, 1, 3, 20, 31, 32, 55, 56, 135, 136, 137, 200, 272, 1000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(keccak256(bytes)).toBe(viemKeccak(bytes).slice(2));
    }
    expect(keccak256(toBytes("abc"))).toBe("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  });

  it("checksums match viem for many addresses, and the EIP-55 specification's own examples", () => {
    for (let i = 1; i <= 60; i++) {
      const a = ("0x" + (BigInt(i) * 0x9e3779b97f4a7c15f39cc0605cedc8341082276bn).toString(16).padStart(40, "0").slice(-40)) as Address;
      expect(toChecksumAddress(a)).toBe(getAddress(a));
    }
    for (const a of ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"]) {
      expect(toChecksumAddress(a.toLowerCase())).toBe(a);
    }
  });

  it("parseAddress: accepts the exact form, and one-case addresses; returns the checksummed form", () => {
    expect(parseAddress(RECIPIENT)).toBe(RECIPIENT);
    expect(parseAddress(" " + RECIPIENT.toLowerCase() + " ")).toBe(RECIPIENT);
    expect(parseAddress("0x" + RECIPIENT.slice(2).toUpperCase())).toBe(RECIPIENT);
  });

  it.each([
    ["", /enter the full address/], ["0x", /enter the full address/], ["5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", /enter the full address/],
    ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe", /enter the full address/], ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedd", /enter the full address/],
    ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg", /enter the full address/], ["vitalik.eth", /enter the full address/],
    ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd", /typo/], //  one capital flipped: the checksum catches it
    ["0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", /typo/],
  ])("parseAddress refuses %j", (text, why) => expect(() => parseAddress(text)).toThrow(why));

  it("the call it builds is byte-identical to USDC's transfer(address,uint256) as viem encodes it", () => {
    const [c] = sendCalls(RECIPIENT, 1_234_567n);
    expect(c!.data.toLowerCase()).toBe(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, 1_234_567n] }).toLowerCase());
    expect(c!.to.toLowerCase()).toBe(vault.asset.address.toLowerCase());
  });

  it("a well-formed send validates, and decodes to the recipient and amount that were asked for", () => {
    const [c] = send();
    expect(c.decoded).toEqual({ fn: "transfer", to: RECIPIENT.toLowerCase(), amount: 1_200_000n });
    expect(c.vault.asset.symbol).toBe("USDC");
  });

  it("it cannot go to the wallet itself, the zero address, the token, or any registry vault", () => {
    expect(() => send(sendCalls(ACCOUNT))).toThrow(/own address/);
    expect(() => send(sendCalls("0x" + "0".repeat(40)))).toThrow(/zero address/);
    expect(() => send(sendCalls(vault.asset.address))).toThrow(/token or vault contract/);
    expect(() => send(sendCalls(vault.address))).toThrow(/token or vault contract/);
    expect(() => send(sendCalls(sibling.address))).toThrow(/token or vault contract/);
  });

  it("it refuses a zero amount, any other token, a value, another chain, extra calls, or malformed data", () => {
    expect(() => send(sendCalls(RECIPIENT, 0n))).toThrow(/more than zero/);
    expect(() => send([{ ...sendCalls()[0]!, to: FOREIGN }])).toThrow(/not one/);
    expect(() => send([{ ...sendCalls()[0]!, value: "0x1" }])).toThrow(/no value/);
    expect(() => send([{ ...sendCalls()[0]!, chainId: 1 }])).toThrow(/on Base/);
    expect(() => send([...sendCalls(), ...sendCalls()])).toThrow(/exactly one call/);
    expect(() => send([{ ...sendCalls()[0]!, data: sendCalls()[0]!.data + "00" }])).toThrow(/exact shape/);
    expect(() => send([{ ...sendCalls()[0]!, data: "0x095ea7b3" + sendCalls()[0]!.data.slice(10) }])).toThrow(/exact shape/); // an approve is not a send
    expect(() => send(sendCalls(), "not-an-address")).toThrow(/not an address/);
  });

  it("an agent's envelope can never carry a transfer: the shared validator still refuses it, however it is shaped", () => {
    const evil = sendCalls(FOREIGN, 1_000_000n);
    expect(() => validatePayload({ account: ACCOUNT, calls: evil }, registry)).toThrow(/is not approve\/deposit\/withdraw\/redeem/);
    expect(() => validatePayload({ account: ACCOUNT, calls: [...deposit(), ...evil] }, registry)).toThrow();
    expect(() => validateFollow({ ...slimPayload(ACCOUNT, deposit() as never), calls: evil, follow: true }, registry)).toThrow();
    expect(Object.values(SELECTORS)).not.toContain("transfer");
  });
});

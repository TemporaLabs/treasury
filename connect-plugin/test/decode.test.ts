import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { BASE_USDC, describeCall } from "../src/decode.ts";

const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const VAULT = "0x3333333333333333333333333333333333333333";
const abi = parseAbi([
  "function approve(address spender, uint256 value)",
  "function transfer(address to, uint256 value)",
  "function deposit(uint256 assets, address receiver)",
  "function withdraw(uint256 assets, address receiver, address owner)",
  "function redeem(uint256 shares, address receiver, address owner)",
]);
const data = (functionName: "approve" | "transfer" | "deposit" | "withdraw" | "redeem", args: unknown[]) =>
  encodeFunctionData({ abi, functionName, args } as never);
const row = (d: ReturnType<typeof describeCall>, k: string) => d.rows.find((r) => r[0] === k)?.[1];

test("deposit to the account shows action, amount, vault, receiver and chain with no warnings", () => {
  const d = describeCall({ to: VAULT, data: data("deposit", [1_500_000n, ME]) }, ME);
  assert.equal(d.recognised, true);
  assert.equal(d.summary, "Deposit USDC into a vault");
  assert.equal(row(d, "Action"), "Deposit");
  assert.equal(row(d, "Amount"), "1.5 USDC (1500000 raw units)");
  assert.equal(row(d, "Vault"), VAULT);
  assert.equal(row(d, "Receiver"), ME);
  assert.equal(row(d, "Chain"), "Base (8453)");
  assert.deepEqual(d.warnings, []);
});

test("a deposit whose receiver is not the account is flagged", () => {
  const d = describeCall({ to: VAULT, data: data("deposit", [1_000_000n, OTHER]) }, ME);
  assert.ok(d.warnings.some((w) => w.includes("receiver is not your account")));
});

test("withdraw and redeem flag a foreign receiver or owner", () => {
  const w = describeCall({ to: VAULT, data: data("withdraw", [5n, ME, OTHER]) }, ME);
  assert.ok(w.warnings.some((x) => x.includes("owner is not your account")));
  const r = describeCall({ to: VAULT, data: data("redeem", [5n, OTHER, ME]) }, ME);
  assert.ok(r.warnings.some((x) => x.includes("receiver is not your account")));
  assert.equal(row(r, "Shares"), "5 raw units");
});

test("approve on USDC is formatted; an unlimited approve is flagged", () => {
  const ok = describeCall({ to: BASE_USDC, data: data("approve", [VAULT, 2_000_000n]) }, ME);
  assert.equal(row(ok, "Amount"), "2 USDC (2000000 raw units)");
  assert.equal(row(ok, "Spender"), VAULT);
  assert.deepEqual(ok.warnings, []);
  const unlimited = describeCall({ to: BASE_USDC, data: data("approve", [VAULT, 2n ** 256n - 1n]) }, ME);
  assert.ok(unlimited.warnings.some((x) => x.includes("unlimited")));
});

test("a plain transfer is decoded and warned about", () => {
  const d = describeCall({ to: BASE_USDC, data: data("transfer", [OTHER, 1_000_000n]) }, ME);
  assert.equal(row(d, "Action"), "Token transfer");
  assert.ok(d.warnings.some((x) => x.includes("recipient is not your account")));
});

test("unknown call data is flagged as unrecognised", () => {
  const d = describeCall({ to: VAULT, data: "0xdeadbeef" }, ME);
  assert.equal(d.recognised, false);
  assert.ok(d.warnings.some((x) => x.includes("Do not confirm")));
});

test("attached ETH value is called out", () => {
  const d = describeCall({ to: VAULT, data: data("deposit", [1n, ME]), value: "0xde0b6b3a7640000" }, ME);
  assert.ok(d.warnings.some((x) => x.includes("1 ETH")));
});

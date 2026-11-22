/**
 * `prepareDeposit` and `prepareWithdrawal`: a step the check let through that still lacks the field the page shows or
 * the wallet is asked for is refused by name, never turned into an undefined value or a crash.
 */
import { describe, expect, it } from "vitest";
import { prepareDeposit } from "../src/invest/deposit.js";
import { prepareWithdrawal, type Holding } from "../src/invest/withdraw.js";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const request = (steps: unknown[]) => ({ requestId: "r1", smartAccount: ACCOUNT, steps }) as never;
const holding = { smartAccount: ACCOUNT, holdings: [], decimals: new Map() } as unknown as Holding;

describe("prepareDeposit", () => {
  it("refuses an enrolment step that carries no code to sign", () => {
    const s = { kind: "sign_message", payload: {} };
    expect(() => prepareDeposit(request([s]), s as never, 1_000_000n, "p")).toThrow(/enrolment.*no code/);
  });
  it("refuses a transfer step that carries no calldata", () => {
    const s = { kind: "send_transaction", payload: {} };
    expect(() => prepareDeposit(request([s]), s as never, 1_000_000n, "p")).toThrow(/transfer.*no calldata/);
  });
  it("shows an enrolment step that carries its code", () => {
    const bytes = `0x${"ab".repeat(32)}`;
    const s = { kind: "sign_message", payload: { bytes } };
    expect(prepareDeposit(request([s]), s as never, 1_000_000n, "p").ask).toEqual({ kind: "sign_bytes", bytes });
  });
});

describe("prepareWithdrawal", () => {
  const step = (message: Record<string, unknown>) => ({ kind: "sign_typed_data", payload: { typedData: { message } } });
  it.each([["missing", {}], ["not a number", { expiresAt: "soon" }], ["zero", { expiresAt: 0 }]])("refuses an authorization whose expiry is %s", (_n, message) => {
    const s = step(message);
    expect(() => prepareWithdrawal(request([s]), s as never, OWNER, holding, "p")).toThrow(/refused: .*no expiry/);
  });
  it("shows the expiry of an authorization that carries one", () => {
    const s = step({ expiresAt: 1_800_000_000, assets: [] });
    const p = prepareWithdrawal(request([s]), s as never, OWNER, holding, "p");
    expect(p.view.facts).toContainEqual({ label: "Valid until", value: new Date(1_800_000_000_000).toISOString() });
  });
});

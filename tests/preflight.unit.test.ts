import { describe, it, expect } from "vitest";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError } from "viem";
import { erc4626Abi, knownRevertSelectors } from "../src/abi/erc4626.js";
import { registrySchema } from "../src/registry-schema.js";
import { classifyRevert, extractRevert, preflightDeposit } from "../src/preflight.js";
import { getVault, loadRegistry } from "../src/registry.js";
import { FIXTURE, fixtureVault } from "./fixtures/registry.js";
import { EARN } from "../src/config/earn.js";

const STRANGER = EARN.fixtures.stranger;

describe("classifyRevert names a cause only where the instrument discriminated", () => {
  it("0x068ca9d8 AccessManagedUnauthorized → WHITELIST_GATED (observed live on Fusion)", () => {
    const r = classifyRevert({
      selector: "0x068ca9d8",
      raw: "0x068ca9d8000000000000000000000000000000000000000000000000000000000000dead",
    });
    expect(r.status).toBe("WHITELIST_GATED");
    expect(r.note).toMatch(/role 800/);
  });

  it("0xe65b7a77 TransferFromReverted → NEEDS_APPROVAL (observed live on Morpho V2 — access is open)", () => {
    const r = classifyRevert({ selector: "0xe65b7a77", raw: "0xe65b7a77" });
    expect(r.status).toBe("NEEDS_APPROVAL");
    expect(r.note).toMatch(/access is OPEN/);
  });

  it("the whitelist refusal names the role that BLOCKED the depositor, and no admin role", () => {
    // What a depositor needs is why their deposit was refused: the role they lack. The vault's ADMIN
    // role is operator-side — it can never explain a depositor's refusal, and naming it describes how
    // the fund is administered to someone who cannot act on it.
    const r = classifyRevert({ selector: knownRevertSelectors.AccessManagedUnauthorized, raw: knownRevertSelectors.AccessManagedUnauthorized });
    expect(r.status).toBe("WHITELIST_GATED");
    expect(r.note).toMatch(/role 800/);
    expect(r.note).not.toMatch(/ATOMIST/i);
    expect(r.note).not.toMatch(/role 100/);
    expect(r.note).not.toMatch(/admin/i);
  });

  it("an Error(string) allowance revert → NEEDS_APPROVAL (observed on the public 4626 control vault)", () => {
    const r = classifyRevert({ selector: "0x08c379a0", reason: "ERC20: transfer amount exceeds allowance" });
    expect(r.status).toBe("NEEDS_APPROVAL");
  });

  it("anything else → REVERTED_OTHER, listing candidates and never diagnosing", () => {
    const r = classifyRevert({ selector: "0xdeadbeef", raw: "0xdeadbeef" });
    expect(r.status).toBe("REVERTED_OTHER");
    expect(r.note).toMatch(/does not name the cause/);
    expect(r.note).toMatch(/paused/);
    expect(r.note).toMatch(/cap/);
  });

  it("selector matching is case-insensitive", () => {
    expect(classifyRevert({ selector: "0x068CA9D8" }).status).toBe("WHITELIST_GATED");
  });
});

describe("extractRevert separates a definite revert from a transport failure", () => {
  it("returns undefined for a non-viem error (transport / programmer error)", () => {
    expect(extractRevert(new Error("ECONNRESET"))).toBeUndefined();
  });

  it("returns undefined for a viem BaseError with no ContractFunctionRevertedError in the chain", () => {
    expect(extractRevert(new BaseError("rpc timeout"))).toBeUndefined();
  });

  it("pulls selector + raw out of a ContractFunctionRevertedError inside an execution error", () => {
    const reverted = new ContractFunctionRevertedError({
      abi: erc4626Abi,
      functionName: "deposit",
      data: "0x068ca9d8000000000000000000000000000000000000000000000000000000000000dead",
    });
    const exec = new ContractFunctionExecutionError(reverted, {
      abi: erc4626Abi,
      functionName: "deposit",
      args: [1n, STRANGER],
    });
    const obs = extractRevert(exec);
    expect(obs?.selector).toBe("0x068ca9d8");
    expect(classifyRevert(obs!).status).toBe("WHITELIST_GATED");
  });
});

describe("preflightDeposit refuses before touching the chain when the registry already answers", () => {
  const neverCalled = new Proxy({}, { get: () => () => { throw new Error("client must not be called"); } }) as never;

  it("Enzyme → REFUSED_BY_CLIENT, no RPC", async () => {
    const r = await preflightDeposit({ vault: fixtureVault(FIXTURE.enzyme), depositor: STRANGER, client: neverCalled });
    expect(r.status).toBe("REFUSED_BY_CLIENT");
    expect(r.canDeposit).toBe(false);
    expect(r.findings.at(-1)).toMatch(/no ERC-4626 deposit path/);
  });

  it("the client has NO lifecycle concept — a row carrying a lifecycle-status field is rejected by the strict schema", () => {
    // The vault lifecycle is the fund's, not the client's; the client sees a live contract and
    // deposits into it. So the field is not tolerated-and-ignored, it is unknown: the schema is
    // .strict(), and this is the test that keeps it out.
    const raw = JSON.parse(JSON.stringify(loadRegistry())) as { vaults: Record<string, unknown>[] };
    expect(registrySchema.safeParse(raw).success).toBe(true); // premise: the shipped registry parses
    raw.vaults[0]!["lifecycle"] = "ACTIVE";
    const r = registrySchema.safeParse(raw);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? null : r.error.issues)).toMatch(/unrecognized_keys|lifecycle/);
  });
});

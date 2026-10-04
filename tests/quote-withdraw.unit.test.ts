/**
 * What `earn quote --direction withdraw` says when the simulated withdrawal reverts.
 *
 * The defect this closes (#78): any revert with the vault's idle balance below the amount was
 * explained as a liquidity shortfall in Fusion's terms. A Morpho Vault V2 holds almost no idle
 * asset and pays withdrawals out of its markets, so on that chassis every revert read as "the vault
 * holds 0 USDC liquid", the real reason was never shown, and the advice ("withdraw at most the liquid
 * amount") came to 0 USDC while 1 USDC passed. Measured on Test 2B, 2026-10-04: a 10 USDC withdraw
 * from a 10-share position reverted `UsdcVaultL2/insufficient-balance`, from a market beneath the
 * vault, while idle USDC read 0.
 */
import { describe, it, expect } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, type Hex } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { quoteWithdraw } from "../src/quote.js";
import { getVault } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";

const OWNER = EARN.fixtures.stranger;

/** The exact payload Base returned for the 10 USDC withdraw on Test 2B: Error("UsdcVaultL2/insufficient-balance"). */
const MARKET_INSUFFICIENT: Hex =
  "0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000020557364635661756c744c322f696e73756666696369656e742d62616c616e6365";
/** Error("ERC20: transfer amount exceeds balance"), what a Fusion vault without instant fuses reverts with. */
const TRANSFER_EXCEEDS: Hex = encodeErrorResult({
  abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }],
  errorName: "Error",
  args: ["ERC20: transfer amount exceeds balance"],
});

const reverted = (data: Hex) =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: erc4626Abi, functionName: "withdraw", data }), {
    abi: erc4626Abi,
    functionName: "withdraw",
    args: [1n, OWNER, OWNER],
  });

/** A vault where `owner` holds `held` shares, `toBurn` shares are needed, the vault holds `liquid` idle asset, and withdraw reverts with `data`. */
function client(o: { vaultSymbol: string; held: bigint; toBurn: bigint; liquid: bigint; data: Hex }) {
  const vault = getVault(o.vaultSymbol);
  return {
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      if (functionName === "balanceOf") return address.toLowerCase() === vault.asset.address.toLowerCase() ? o.liquid : o.held;
      if (functionName === "previewWithdraw") return o.toBurn;
      if (functionName === "maxWithdraw") return 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: async () => {
      throw reverted(o.data);
    },
  } as never;
}

describe("a reverted withdraw quote reports the chain's reason on the chassis it is on", () => {
  it("Morpho V2: idle balance below the amount does NOT produce the liquidity note, and the revert reason is shown", async () => {
    const vault = getVault("tlCashPlusUSDC2B");
    expect(vault.chassis).toBe("morpho-v2");
    const q = await quoteWithdraw({
      vault,
      owner: OWNER,
      assetsHuman: "10",
      client: client({ vaultSymbol: vault.symbol, held: 10n * 10n ** 18n, toBurn: 9_984_244_863_181_413_412n, liquid: 0n, data: MARKET_INSUFFICIENT }),
    });
    expect(q.simulated).toBe("REVERTED");
    expect(q.canProceed).toBe(false);
    expect(q.note).toContain("UsdcVaultL2/insufficient-balance");
    expect(q.note).not.toMatch(/liquid against/);
    expect(q.note).not.toMatch(/pays withdrawals from its own balance/);
    expect(q.note).toMatch(/smaller amount/);
  });

  it("Morpho V2: a transfer-exceeds-balance revert is still not explained as the vault's idle balance", async () => {
    const vault = getVault("tlCashPlusUSDC2B");
    const q = await quoteWithdraw({
      vault,
      owner: OWNER,
      assetsHuman: "10",
      client: client({ vaultSymbol: vault.symbol, held: 10n * 10n ** 18n, toBurn: 9n * 10n ** 18n, liquid: 0n, data: TRANSFER_EXCEEDS }),
    });
    expect(q.note).toContain("transfer amount exceeds balance");
    expect(q.note).not.toMatch(/liquid against/);
  });

  it("Fusion: idle balance below the amount keeps the liquidity note, and now also shows the revert reason", async () => {
    const vault = getVault("tlCashPlusUSDC2A");
    expect(vault.chassis).toBe("fusion");
    const q = await quoteWithdraw({
      vault,
      owner: OWNER,
      assetsHuman: "10",
      client: client({ vaultSymbol: vault.symbol, held: 10n * 10n ** 8n, toBurn: 9n * 10n ** 8n, liquid: 800_000n, data: TRANSFER_EXCEEDS }),
    });
    expect(q.note).toMatch(/0\.8 USDC liquid against 10 requested/);
    expect(q.note).toContain("transfer amount exceeds balance");
  });

  it("Fusion: a revert that is not a balance shortfall, with enough idle balance, is not given the liquidity note", async () => {
    const vault = getVault("tlCashPlusUSDC2A");
    const q = await quoteWithdraw({
      vault,
      owner: OWNER,
      assetsHuman: "1",
      client: client({ vaultSymbol: vault.symbol, held: 10n * 10n ** 8n, toBurn: 1n * 10n ** 8n, liquid: 5_000_000n, data: MARKET_INSUFFICIENT }),
    });
    expect(q.note).toContain("UsdcVaultL2/insufficient-balance");
    expect(q.note).toMatch(/not a balance or liquidity shortfall/);
    expect(q.note).not.toMatch(/liquid against/);
  });

  it("Morpho V2: when previewWithdraw reverts, the note says the shares needed are unknown instead of claiming they suffice", async () => {
    const vault = getVault("tlCashPlusUSDC2B");
    const c = client({ vaultSymbol: vault.symbol, held: 10n * 10n ** 18n, toBurn: 0n, liquid: 0n, data: MARKET_INSUFFICIENT }) as unknown as { readContract: (a: { address: string; functionName: string }) => Promise<bigint> };
    const read = c.readContract;
    c.readContract = async (a) => {
      if (a.functionName === "previewWithdraw") throw new Error("previewWithdraw reverted");
      return read(a);
    };
    const q = await quoteWithdraw({ vault, owner: OWNER, assetsHuman: "10", client: c as never });
    expect(q.note).toContain("UsdcVaultL2/insufficient-balance");
    expect(q.note).toMatch(/shares needed are unknown/);
    expect(q.note).not.toMatch(/holds enough shares/);
  });

  it("any chassis: too few shares is reported as too few shares, before any liquidity reading", async () => {
    for (const symbol of ["tlCashPlusUSDC2A", "tlCashPlusUSDC2B"]) {
      const vault = getVault(symbol);
      const q = await quoteWithdraw({
        vault,
        owner: OWNER,
        assetsHuman: "10",
        client: client({ vaultSymbol: symbol, held: 1n, toBurn: 2n, liquid: 0n, data: MARKET_INSUFFICIENT }),
      });
      expect(q.note, symbol).toMatch(/insufficient shares/);
    }
  });
});

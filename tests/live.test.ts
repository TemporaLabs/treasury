/**
 * Read-only against real Solana mainnet-beta, skipped unless a Solana RPC is configured
 * (`TREASURY_RPC_SOLANA` or `SOLANA_RPC_URL`). No transactions.
 *
 * The EVM vaults are reached through the Tempora API, which reads their chains itself; this tier
 * covers the one vault this client still reads from its own chain.
 */
import { describe, it, expect } from "vitest";

/**
 * Solana: the registry's Kamino vault read through this client's own decoders, and a stranger's pre-flight.
 * What these establish that the unit tier cannot: the decoders still read the program's CURRENT account
 * layout (a program upgrade that resized either account is refused here), and the vault the registry names is
 * the one on mainnet.
 */
const liveSolana = process.env["TREASURY_RPC_SOLANA"] || process.env["SOLANA_RPC_URL"] ? describe : describe.skip;
liveSolana("the Solana vault against live mainnet-beta (read-only)", () => {
  const STRANGER_SOLANA = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

  it("the configured endpoint IS mainnet-beta, and the vault reads with this client's decoders", async () => {
    const { makeSolanaRpc, solanaCluster } = await import("../src/solana/rpc.js");
    const { readVault } = await import("../src/solana/vault.js");
    const { solanaRpcUrlFromEnv } = await import("../src/client.js");
    const { listSolanaVaults } = await import("../src/registry.js");
    const rpc = makeSolanaRpc(solanaRpcUrlFromEnv());
    expect(await solanaCluster(rpc)).toBe("mainnet");
    const v = await readVault(rpc, listSolanaVaults()[0]!);
    expect(v.state.name).toBe(listSolanaVaults()[0]!.name);
    expect(v.state.sharesIssued).toBeGreaterThan(0n);
    expect(v.state.permissioningAuthority).toBe("11111111111111111111111111111111");
  }, 120_000);

  it("a stranger with no USDC is told it needs funds, not that the vault refused it", async () => {
    const { makeSolanaRpc } = await import("../src/solana/rpc.js");
    const { preflightDepositSolana } = await import("../src/solana/vault.js");
    const { solanaRpcUrlFromEnv } = await import("../src/client.js");
    const { listSolanaVaults } = await import("../src/registry.js");
    const r = await preflightDepositSolana(makeSolanaRpc(solanaRpcUrlFromEnv()), listSolanaVaults()[0]!, STRANGER_SOLANA, "1");
    expect(r.status, JSON.stringify(r.findings)).toBe("NEEDS_FUNDS");
    expect(r.canDeposit).toBe(true);
    expect(r.findings[0]).toMatch(/identity OK/);
  }, 120_000);
});

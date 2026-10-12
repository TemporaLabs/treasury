/**
 * One Solana registry row, checked against the chain: the verdicts `registry-check.ts` prints for it.
 *
 * The endpoint is proven to serve Solana MAINNET before the row is read. Devnet, testnet or a local
 * validator answers every read and holds none of the registry's vaults, so reading through one reports
 * "no account at" for a row that is right; that is a misconfigured variable, never a disagreement.
 */
import type { SolanaVaultEntry } from "../src/registry-schema.js";
import { describeError } from "../src/redact.js";
import { solanaCluster, type SolanaRpc } from "../src/solana/rpc.js";
import { readVault } from "../src/solana/vault.js";

export type RowVerdict = { verdict: "ok"; message: string } | { verdict: "fail"; message: string } | { verdict: "not_checked"; message: string; why: string };

export async function checkSolanaRow(rpc: SolanaRpc, v: SolanaVaultEntry): Promise<RowVerdict[]> {
  const cluster = await solanaCluster(rpc);
  if (cluster !== "mainnet") {
    const why = cluster === "other" ? "the endpoint serves a Solana cluster other than mainnet" : "the endpoint did not say which Solana cluster it serves";
    return [{ verdict: "not_checked", message: `${v.symbol}: vault state`, why }];
  }
  try {
    const read = await readVault(rpc, v);
    return [
      { verdict: "ok", message: `${v.symbol}: token mint, share mint and both decimals agree with the vault state at slot ${read.slot}` },
      read.state.name === v.name ? { verdict: "ok", message: `${v.symbol}: name = ${v.name}` } : { verdict: "fail", message: `${v.symbol}: registry name "${v.name}" != the vault state's "${read.state.name}"` },
    ];
  } catch (e) {
    const msg = describeError(e);
    if (/disagrees with the chain|no account at/.test(msg)) return [{ verdict: "fail", message: `${v.symbol}: ${msg}` }];
    return [{ verdict: "not_checked", message: `${v.symbol}: vault state`, why: msg }];
  }
}

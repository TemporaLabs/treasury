/**
 * `registry-check.ts` on a Solana row: an endpoint that is not Solana mainnet is a misconfigured variable,
 * reported as NOT CHECKED. Read through devnet, the row's vault has no account, and that used to be
 * reported as a disagreement with a row that is right.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkSolanaRow } from "../scripts/solana-row.js";
import { listSolanaVaults } from "../src/registry.js";
import type { SolanaRpc } from "../src/solana/rpc.js";

const SNAP = JSON.parse(readFileSync(new URL("./fixtures/solana/vault-snapshot.json", import.meta.url), "utf8")) as { slot: number; accounts: Record<string, { data: string }> };
const row = listSolanaVaults()[0]!;

/** An endpoint reporting `genesis`, holding the snapshot's accounts when `holds` is set and nothing otherwise. */
const endpoint = (genesis: string, holds: boolean) =>
  ({
    getGenesisHash: () => ({ send: async () => genesis }),
    getAccountInfo: (a: string) => ({ send: async () => ({ value: holds && SNAP.accounts[String(a)] ? { data: [SNAP.accounts[String(a)]!.data, "base64"] } : null, context: { slot: BigInt(SNAP.slot) } }) }),
    getMultipleAccounts: (ks: string[]) => ({ send: async () => ({ value: ks.map((k) => ({ data: [SNAP.accounts[String(k)]!.data, "base64"] })), context: { slot: BigInt(SNAP.slot) } }) }),
  }) as unknown as SolanaRpc;

const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

describe("checkSolanaRow", () => {
  it("control: on mainnet the row agrees with the vault state", async () => {
    const verdicts = await checkSolanaRow(endpoint(MAINNET, true), row);
    expect(verdicts[0]!.verdict).toBe("ok");
  });

  it("control: on mainnet, a vault-state account that is missing IS a disagreement", async () => {
    const verdicts = await checkSolanaRow(endpoint(MAINNET, false), row);
    expect(verdicts).toEqual([expect.objectContaining({ verdict: "fail" })]);
  });

  it("an endpoint on another cluster is NOT CHECKED, never a disagreement", async () => {
    const verdicts = await checkSolanaRow(endpoint(DEVNET, false), row);
    expect(verdicts).toEqual([{ verdict: "not_checked", message: `${row.symbol}: vault state`, why: "the endpoint serves a Solana cluster other than mainnet" }]);
  });
});

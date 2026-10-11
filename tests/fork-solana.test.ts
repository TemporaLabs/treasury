/**
 * Acceptance on Solana: a full deposit → withdraw round trip against every Solana vault in the registry, on a
 * local fork of mainnet-beta (Surfpool), using ONLY the transactions this package builds. Gated behind
 * TREASURY_FORK=1 because it spawns `surfpool` (from PATH), and behind a Solana RPC to fork from.
 *
 * The signer is a key generated for this run and funded on the fork alone (an airdrop and the fork's
 * token-account cheatcode). Nothing is read from any key file, and nothing touches mainnet.
 *
 * Both build paths are exercised: `earn prepare_deposit` / `prepare_withdraw` (what an agent hands a wallet)
 * and the confirm page's `buildForIntent` (what the page hands the wallet after the gate). Every landed
 * transaction is then checked by the same `verifySolanaLanded` the page uses.
 *
 * Process hygiene: a distinct port per run, the PID recorded, only that PID killed, and the port confirmed free.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signTransaction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { listSolanaVaults } from "../src/registry.js";
import { makeSolanaRpc, solanaCluster, type SolanaRpc } from "../src/solana/rpc.js";
import { tokenBalance } from "../src/solana/vault.js";
import { associatedTokenAccount, DISCRIMINATORS } from "../src/solana/kvault.js";
import { KVAULT_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "../src/solana/constants.js";
import { admitSolana } from "../src/connect/gate-solana.js";
import { buildForIntent, verifySolanaLanded } from "../src/connect/solana.js";
import { solanaBalance, solanaPrepareDeposit, solanaPrepareWithdraw } from "../src/earn/solana.js";
import { formatAmount, parseAmount } from "../src/units.js";

const upstream = process.env["TREASURY_RPC_SOLANA"] || process.env["SOLANA_RPC_URL"];
const enabled = process.env["TREASURY_FORK"] === "1" && !!upstream;
const fork = enabled ? describe : describe.skip;
const PORT = 28899 + (process.pid % 500) * 2;
const RPC_URL = `http://127.0.0.1:${PORT}`;

/** What the round trip deposits, and what the fork seeds the account with first. */
const DEPOSIT = "2";
const SEED = "10";

/** Kamino's GLOBAL config keeps up to this many base units of every withdraw instruction (measured on mainnet). */
const PENALTY_PER_WITHDRAW_IX = 1_000n;

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

async function waitForRpc(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await rpcCall("getSlot", []);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`surfpool on ${RPC_URL} did not come up in ${ms}ms`);
}

/** Signs a prepared wire transaction with the run's key and sends it; returns the signature. */
async function signAndSend(wire: string, signer: KeyPairSigner): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  const signed = await signTransaction([signer.keyPair], tx);
  // Sent as raw JSON-RPC so a refusal arrives with the node's whole error body, logs included. The fork loads
  // mainnet accounts lazily from the upstream, and a free upstream sometimes drops that fetch: the node then
  // refuses the transaction before it runs. Resending the SAME signed bytes is safe — one signature lands
  // at most once — so that one refusal is retried, a few times; any other refusal is the test's answer.
  const wire64 = getBase64EncodedWireTransaction(signed);
  for (let attempt = 1; ; attempt++) {
    try {
      return await rpcCall<string>("sendTransaction", [wire64, { encoding: "base64", preflightCommitment: "confirmed" }]);
    } catch (e) {
      if (attempt >= 4 || !/Failed to fetch accounts from remote/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

/** The number of kVault withdraw instructions in a wire transaction — what Kamino's per-instruction charge counts. */
function withdrawInstructionCount(wire: string): number {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const isWithdraw = (d: ReadonlyUint8Array | undefined) => d !== undefined && DISCRIMINATORS.withdraw.every((x, i) => d[i] === x);
  return msg.instructions.filter((ix) => msg.staticAccounts[ix.programAddressIndex] === KVAULT_PROGRAM_ID && isWithdraw(ix.data)).length;
}

for (const vault of listSolanaVaults()) {
  fork(`Solana fork round trip on ${vault.symbol}: deposit → withdraw through the package's own transactions`, () => {
    let surfpool: ChildProcess | undefined;
    let rpc: SolanaRpc;
    let signer: KeyPairSigner;
    let savedEnv: string | undefined;
    let workDir: string | undefined;
    const opts = () => ({ attempts: 30, delayMs: 500, deadline: Date.now() + 60_000 });

    beforeAll(async () => {
      // Surfpool writes its logs under its working directory: a scratch one, never the checkout.
      workDir = mkdtempSync(join(tmpdir(), "treasury-surfpool-"));
      surfpool = spawn("surfpool", ["start", "--rpc-url", upstream!, "--port", String(PORT), "--ws-port", String(PORT + 1), "--no-tui", "--no-studio", "--no-deploy", "-y", "--log-level", "warn"], { stdio: "ignore", cwd: workDir });
      await waitForRpc(60_000);
      // The package's own earn commands resolve their RPC from the environment: point them at the fork.
      savedEnv = process.env["TREASURY_RPC_SOLANA"];
      process.env["TREASURY_RPC_SOLANA"] = RPC_URL;
      rpc = makeSolanaRpc(RPC_URL);
      // The fork answers as mainnet-beta (it forks it), which is what the earn commands insist on.
      expect(await solanaCluster(rpc)).toBe("mainnet");
      signer = await generateKeyPairSigner();
      await rpcCall("requestAirdrop", [signer.address, 1_000_000_000]);
      await rpcCall("surfnet_setTokenAccount", [signer.address, vault.asset.address, { amount: Number(parseAmount(SEED, vault.asset.decimals, "seed")) }, SPL_TOKEN_PROGRAM_ID]);
      const usdc = await tokenBalance(rpc, await associatedTokenAccount(signer.address, vault.asset.address));
      expect(usdc.amount).toBe(parseAmount(SEED, vault.asset.decimals, "seed"));
    }, 120_000);

    afterAll(async () => {
      if (savedEnv === undefined) delete process.env["TREASURY_RPC_SOLANA"];
      else process.env["TREASURY_RPC_SOLANA"] = savedEnv;
      if (surfpool?.pid) {
        surfpool.kill("SIGTERM");
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            await rpcCall("getSlot", []);
            await new Promise((r) => setTimeout(r, 200));
          } catch {
            break;
          }
        }
        if (Date.now() >= deadline) surfpool.kill("SIGKILL");
      }
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    it(
      "prepare_deposit → signed and landed → matched; confirm-page partial withdrawal → matched; prepare_withdraw everything → matched, less at most Kamino's per-instruction charge",
      async () => {
        const account = signer.address;
        const usdcAta = await associatedTokenAccount(account, vault.asset.address);
        const sharesAta = await associatedTokenAccount(account, vault.sharesMint);
        const usdcStart = (await tokenBalance(rpc, usdcAta)).amount;
        const depositRaw = parseAmount(DEPOSIT, vault.asset.decimals, "deposit");

        // 1. Deposit through the agent path. The gate must admit what the agent path builds, too.
        const dep = await solanaPrepareDeposit(vault, account, DEPOSIT, account);
        const admitted = await admitSolana(dep.transaction.wire, account);
        expect(admitted).toMatchObject({ kind: "deposit", amount: depositRaw });
        const depSig = await signAndSend(dep.transaction.wire, signer);
        const depV = await verifySolanaLanded(rpc, depSig, { kind: "deposit", vault, raw: depositRaw }, account, opts());
        expect(depV.verified, depV.detail).toBe("matched");
        const shares = (await tokenBalance(rpc, sharesAta)).amount;
        expect(shares).toBeGreaterThan(0n);
        expect((await tokenBalance(rpc, usdcAta)).amount).toBe(usdcStart - depositRaw);
        expect(`${formatAmount(shares, vault.shareDecimals)} ${vault.symbol}`).toBe(dep.expected);

        // The position reads back through `earn balance`, worth the deposit less rounding.
        const bal = await solanaBalance(vault, account);
        expect(bal.sharesExact).toBe(formatAmount(shares, vault.shareDecimals));
        expect(Number(bal.usdcValue.split(" ")[0])).toBeCloseTo(Number(DEPOSIT), 4);

        // 2. A partial withdrawal through the confirm page's builder: read, build, gate, simulate — then sign.
        const half = shares / 2n;
        const built = await buildForIntent(rpc, { kind: "withdraw", vault, raw: half }, account);
        const partialIxs = withdrawInstructionCount(built.wire);
        const usdcBeforePartial = (await tokenBalance(rpc, usdcAta)).amount;
        const wSig = await signAndSend(built.wire, signer);
        const wV = await verifySolanaLanded(rpc, wSig, { kind: "withdraw", vault, raw: half }, account, opts());
        expect(wV.verified, wV.detail).toBe("matched");
        expect((await tokenBalance(rpc, sharesAta)).amount).toBe(shares - half);
        const paidPartial = (await tokenBalance(rpc, usdcAta)).amount - usdcBeforePartial;
        expect(paidPartial).toBeGreaterThan(0n);

        // 3. Everything else, through the agent path with the exact share string `earn balance` reports.
        const bal2 = await solanaBalance(vault, account);
        const rest = await solanaPrepareWithdraw(vault, account, account, { sharesExact: bal2.sharesExact });
        const restIxs = withdrawInstructionCount(rest.transaction.wire);
        const restRaw = parseAmount(bal2.sharesExact, vault.shareDecimals, "shares");
        const rSig = await signAndSend(rest.transaction.wire, signer);
        const rV = await verifySolanaLanded(rpc, rSig, { kind: "withdraw", vault, raw: restRaw }, account, opts());
        expect(rV.verified, rV.detail).toBe("matched");
        expect((await tokenBalance(rpc, sharesAta)).amount).toBe(0n);

        // What the round trip cost: Kamino keeps UP TO its charge on each withdraw instruction (two instructions
        // kept 1,929 base units on mainnet simulation and 1,939 here, not 2,000), plus a few units of share
        // rounding — never more. Measured, not assumed: the count comes from the transactions sent.
        const usdcEnd = (await tokenBalance(rpc, usdcAta)).amount;
        const cost = usdcStart - usdcEnd;
        const charged = PENALTY_PER_WITHDRAW_IX * BigInt(partialIxs + restIxs);
        console.info(`${vault.symbol}: ${partialIxs}+${restIxs} withdraw instruction(s); round trip of ${DEPOSIT} cost ${formatAmount(cost, vault.asset.decimals)} ${vault.asset.symbol}`);
        expect(partialIxs + restIxs).toBeGreaterThanOrEqual(2);
        expect(cost).toBeGreaterThanOrEqual(PENALTY_PER_WITHDRAW_IX);
        expect(cost).toBeLessThanOrEqual(charged + 10n);
      },
      240_000,
    );
  });
}


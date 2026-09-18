/**
 * Registry reconciliation: does every row agree with the CHAIN?
 *
 *   TREASURY_RPC_BASE=https://... npx tsx scripts/registry-check.ts
 *
 * The chain is the only source a row is checked against. A row is a claim about a contract at an
 * address; `symbol()`, `decimals()` and `asset()` are what the contract says about itself, and a
 * disagreement means the row is wrong — never the chain. There is no upstream repository, deploy
 * record or operator this script consults: the client knows an address and an RPC, nothing else.
 * Exits non-zero on any disagreement.
 *
 * `depositOpen` is NOT reconciled here — it is a measurement with a block on it, re-taken live by
 * `preflightDeposit` on every call, so a stale value is a note, not a defect.
 */
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { loadRegistry } from "../src/registry.js";

const reg = loadRegistry();
let failures = 0;
const ok = (m: string) => console.log(`✓ ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`✗ ${m}`);
};

const rpc = process.env["TREASURY_RPC_BASE"] || process.env["BASE_RPC_URL"] || "https://mainnet.base.org";
const client = createPublicClient({ chain: base, transport: http(rpc, { timeout: 30_000 }) });
const block = await client.getBlockNumber();
console.log(`registry reconciledAtIso=${reg.reconciledAtIso}; chain check at block ${block}, ${reg.vaults.length} rows`);

for (const v of reg.vaults) {
  if (v.chainId !== base.id) {
    fail(`${v.slug}: chainId ${v.chainId} is not Base (${base.id}) — this script only reaches Base`);
    continue;
  }
  const code = await client.getCode({ address: v.address });
  if (!code || code === "0x") {
    fail(`${v.slug}: no contract at ${v.address}`);
    continue;
  }
  // `deployedAtBlock` is what `earn_balance` scans from, so a row that is one block late silently
  // drops a first deposit. The chain settles it in two reads: code AT that block, none the block before.
  if (v.deployedAtBlock !== undefined) {
    const at = BigInt(v.deployedAtBlock);
    const [there, before] = await Promise.all([
      client.getCode({ address: v.address, blockNumber: at }),
      at > 0n ? client.getCode({ address: v.address, blockNumber: at - 1n }) : Promise.resolve(undefined),
    ]);
    if (!there || there === "0x") fail(`${v.slug}: deployedAtBlock ${at} has no code at ${v.address}`);
    else if (before && before !== "0x") fail(`${v.slug}: deployedAtBlock ${at} is LATE — code already exists at ${at - 1n}`);
    else ok(`${v.slug}: deployedAtBlock ${at} is the first block with code`);
  }
  try {
    const dec = await client.readContract({ address: v.address, abi: erc4626Abi, functionName: "decimals" });
    if (dec !== v.shareDecimals) fail(`${v.slug}: shareDecimals ${v.shareDecimals} != decimals() ${dec}`);
    else ok(`${v.slug}: decimals() = ${dec}`);
  } catch {
    fail(`${v.slug}: decimals() reverted`);
  }
  try {
    const sym = await client.readContract({ address: v.address, abi: erc4626Abi, functionName: "symbol" });
    if (sym !== v.shareSymbol) fail(`${v.slug}: shareSymbol "${v.shareSymbol}" != symbol() "${sym}"`);
    else ok(`${v.slug}: symbol() = ${sym}`);
  } catch {
    fail(`${v.slug}: symbol() reverted`);
  }
  if (v.chassis === "enzyme") {
    ok(`${v.slug}: enzyme — asset() expected to revert, skipped`);
    continue;
  }
  try {
    const asset = await client.readContract({ address: v.address, abi: erc4626Abi, functionName: "asset" });
    if (asset.toLowerCase() !== v.asset.address.toLowerCase()) fail(`${v.slug}: asset() ${asset} != registry ${v.asset.address}`);
    else ok(`${v.slug}: asset() matches`);
  } catch {
    fail(`${v.slug}: asset() reverted on a chassis marked ERC-4626`);
  }
}

if (failures) {
  console.error(`\n${failures} disagreement(s) — the chain is right; fix the row`);
  process.exit(1);
}
console.log("\nregistry agrees with the chain");

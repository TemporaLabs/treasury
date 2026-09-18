/**
 * Registry reconciliation: does every row agree with the CHAIN?
 *
 *   TREASURY_RPC_BASE=https://... npx tsx scripts/registry-check.ts
 *
 * The chain is the only source a row is checked against. A row is a claim about a contract at an
 * address; `symbol()`, `decimals()` and `asset()` are what the contract says about itself, and a
 * disagreement means the row is wrong — never the chain. There is no upstream repository, deploy
 * record or operator this script consults: the client knows an address and an RPC, nothing else.
 *
 * 🔴 THREE OUTCOMES, NOT TWO: agrees, disagrees, or COULD NOT BE CHECKED. A call can fail because
 * the contract reverted — which is a fact about the row — or because the endpoint refused, timed
 * out or rate-limited, which is a fact about the endpoint and says nothing about the row. A bare
 * `catch` cannot tell them apart and this script used to report both as "reverted", then conclude
 * "the chain is right; fix the row". Measured on the public fallback: three identical runs against
 * an unchanged registry produced 1, 6 and 6 "disagreements", while a keyed endpoint produced 0
 * every time. Every one of those was rate-limiting reported as bad data.
 *
 * Exits non-zero on either a disagreement or an incomplete check — silence is not a pass — but it
 * says which, because only one of them is something a contributor can fix.
 *
 * 🔴 EVERY ERROR PATH GOES THROUGH `describeError`. A keyed RPC URL is a secret, and viem puts the
 * full request URL in its error message: an unhandled throw here printed the key THREE times and
 * the host FIVE, straight to the terminal, into CI logs, and into whatever a contributor pastes
 * into an issue. This script is one CONTRIBUTING tells people to run with their own endpoint.
 *
 * `depositOpen` is NOT reconciled here — it is a measurement with a block on it, re-taken live by
 * `preflightDeposit` on every call, so a stale value is a note, not a defect.
 */
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { loadRegistry } from "../src/registry.js";
import { describeError } from "../src/redact.js";

const reg = loadRegistry();
let failures = 0;
let unresolved = 0;
const ok = (m: string) => console.log(`✓ ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`✗ ${m}`);
};
const cannotCheck = (m: string, why: string) => {
  unresolved++;
  console.log(`? ${m} — NOT CHECKED: ${why}`);
};

/**
 * Did the CONTRACT reject this call, or did the ENDPOINT? viem raises a distinct error for a
 * revert; anything else — HTTP, timeout, rate limit, a malformed response — is transport. Walk the
 * cause chain rather than matching one class, because viem wraps.
 */
const isRevert = (e: unknown): boolean => {
  for (let c: any = e, depth = 0; c && depth < 8; c = c.cause, depth++) {
    const n = String(c.name ?? "");
    if (n.includes("ContractFunctionRevertedError") || n === "ContractFunctionZeroDataError") return true;
    if (n === "ContractFunctionExecutionError" && typeof c.cause === "undefined") return true;
  }
  return false;
};
/** Redacted, always: the endpoint is a secret and viem puts it in the message. */
const why = (e: unknown): string => describeError(e, 120);

const rpc = process.env["TREASURY_RPC_BASE"] || process.env["BASE_RPC_URL"] || "https://mainnet.base.org";
const client = createPublicClient({ chain: base, transport: http(rpc, { timeout: 30_000 }) });
let block: bigint;
try {
  block = await client.getBlockNumber();
} catch (e) {
  // The endpoint is unreachable, so NOTHING was checked. Never a claim about the registry.
  console.error(`the endpoint did not answer — NOTHING was checked, and this says nothing about the registry.`);
  console.error(`  ${describeError(e, 160)}`);
  console.error(`\nRetry, or point TREASURY_RPC_BASE at a reachable endpoint.`);
  process.exit(1);
}
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
  } catch (e) {
    if (isRevert(e)) fail(`${v.slug}: decimals() reverted`);
    else cannotCheck(`${v.slug}: decimals()`, why(e));
  }
  try {
    const sym = await client.readContract({ address: v.address, abi: erc4626Abi, functionName: "symbol" });
    if (sym !== v.shareSymbol) fail(`${v.slug}: shareSymbol "${v.shareSymbol}" != symbol() "${sym}"`);
    else ok(`${v.slug}: symbol() = ${sym}`);
  } catch (e) {
    if (isRevert(e)) fail(`${v.slug}: symbol() reverted`);
    else cannotCheck(`${v.slug}: symbol()`, why(e));
  }
  if (v.chassis === "enzyme") {
    ok(`${v.slug}: enzyme — asset() expected to revert, skipped`);
    continue;
  }
  try {
    const asset = await client.readContract({ address: v.address, abi: erc4626Abi, functionName: "asset" });
    if (asset.toLowerCase() !== v.asset.address.toLowerCase()) fail(`${v.slug}: asset() ${asset} != registry ${v.asset.address}`);
    else ok(`${v.slug}: asset() matches`);
  } catch (e) {
    if (isRevert(e)) fail(`${v.slug}: asset() reverted on a chassis marked ERC-4626`);
    else cannotCheck(`${v.slug}: asset()`, why(e));
  }
}

if (failures) {
  console.error(`\n${failures} disagreement(s) — the chain is right; fix the row`);
  if (unresolved) console.error(`${unresolved} further check(s) could not be made at all; see below`);
}
if (unresolved) {
  console.error(
    `\n${unresolved} check(s) COULD NOT BE MADE — the endpoint failed, which says nothing about the registry.` +
      `\nThis is not a disagreement. Retry, or point TREASURY_RPC_BASE at an endpoint with headroom:` +
      `\n  TREASURY_RPC_BASE=https://... npx tsx scripts/registry-check.ts`,
  );
}
if (failures || unresolved) process.exit(1);
console.log("\nregistry agrees with the chain");

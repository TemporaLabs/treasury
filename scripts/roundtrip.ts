/**
 * The allocate → deallocate round trip, driven THROUGH THE SKILL — the MCP tools over stdio, the
 * same boundary an agent uses — and stopping exactly where the skill stops: at unsigned calls.
 *
 *   TREASURY_RPC_BASE=… npx tsx scripts/roundtrip.ts --account 0x… --receiver 0x… \
 *     [--vault <slug>] [--amount 0.05] [--out ./roundtrip-out] [--server dist|src]
 *
 * The round-trip harness. Vault and amount default from src/config/earn.ts (`roundTripVault`,
 * `roundTripAmountUsdc`) — the default vault; change `EARN.roundTripVault`, not this script. The
 * account has no default: no depositor address is configured anywhere in this package, by rule
 * (see config/earn.ts), so the operator names the account whose calls are being prepared.
 *
 * What it does: earn_vaults → earn_terms → earn_status (health, then preflight) →
 * earn_balance → earn_quote (both directions) → earn_prepare_deposit →
 * earn_prepare_withdraw. It decodes every unsigned call independently of the server and asserts
 * the argument slots (receiver vs owner — the transposition `build.test.ts` exists to catch), then writes the
 * two `calls` arrays for a signer that lives OUTSIDE this repository.
 *
 * What it never does: sign, send, read a key, or default the withdraw destination. `--receiver` is
 * required and has no default on purpose — an irreversible destination is typed by a human, not
 * inferred by a script. Nothing here moves funds; the exit code says whether the skill's outputs
 * were internally consistent, not whether anything happened on-chain.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { decodeFunctionData, getAddress, isAddress, parseUnits } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { EARN } from "../src/config/earn.js";

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const usage = (msg: string): never => {
  console.error(`roundtrip: ${msg}\nusage: --account <0x…> --receiver <0x…> [--vault <slug>] [--amount <usdc>] [--out dir] [--server dist|src]`);
  process.exit(2);
};
const vault = flag("vault") ?? EARN.roundTripVault;
const accountRaw = flag("account") ?? usage("--account is required — no depositor address is configured in this package, by rule");
const receiverRaw = flag("receiver") ?? usage("--receiver is required — the withdraw destination is never defaulted");
const amount = flag("amount") ?? EARN.roundTripAmountUsdc;
const out = resolve(flag("out") ?? "./roundtrip-out");
if (!isAddress(accountRaw)) usage(`--account is not an address: ${accountRaw}`);
if (!isAddress(receiverRaw)) usage(`--receiver is not an address: ${receiverRaw}`);
if (!/^\d+(\.\d+)?$/.test(amount)) usage(`--amount must be a decimal USDC string: ${amount}`);
const account = getAddress(accountRaw);
const receiver = getAddress(receiverRaw);

// ---- the server, over stdio — the artifact the plugin ships if built, the source otherwise ------
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const dist = resolve(pkg, "dist/mcp-server.mjs");
const useDist = (flag("server") ?? (existsSync(dist) ? "dist" : "src")) === "dist";
const child = useDist
  ? spawn("node", [dist], { cwd: pkg, stdio: ["pipe", "pipe", "pipe"] })
  : spawn("npx", ["tsx", "src/mcp/server.ts"], { cwd: pkg, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += String(d)));
const lines = createInterface({ input: child.stdout });
const pending = new Map<number, (v: unknown) => void>();
lines.on("line", (l) => {
  let msg: { id?: number; result?: unknown; error?: unknown };
  try {
    msg = JSON.parse(l);
  } catch {
    return;
  }
  if (typeof msg.id === "number") pending.get(msg.id)?.(msg.error ? { error: msg.error } : msg.result);
});
let nextId = 1;
function rpc(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => rej(new Error(`${method} timed out; server stderr: ${stderr.slice(-400)}`)), 120_000);
  });
}
async function tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await rpc("tools/call", { name, arguments: args })) as { content?: { text?: string }[]; isError?: boolean; error?: unknown };
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) {
    // A tool-level error is the skill saying it could not answer (most often the RPC: rate limit,
    // transient HTTP failure). That is a FAIL for this run, not a crash — say which step and stop.
    console.log(`  FAIL ${name} returned an error: ${text.slice(0, 300)}\n       (an RPC transient reads like this — re-run; if it persists, the vault or the RPC is the finding)`);
    child.kill();
    process.exit(1);
  }
  return JSON.parse(text) as T;
}

// ---- assertions that print what they checked --------------------------------------------------
let failures = 0;
function check(cond: boolean, what: string, detail?: unknown): void {
  console.log(`${cond ? "  ok " : "  FAIL"} ${what}${cond || detail === undefined ? "" : `\n       ${JSON.stringify(detail).slice(0, 600)}`}`);
  if (!cond) failures++;
}
type Precondition = { read: string; contract: string; owner: string; spender: string; minimum: string; why: string };
type Call = { to: string; data: `0x${string}`; value: string; description: string; step: number; of: number; precondition?: Precondition };
type Envelope = { requires_signature: boolean; status: string; next_step: string; calls: Call[] };
const decode = (c: Call) => decodeFunctionData({ abi: erc4626Abi, data: c.data });

// ---- the eight steps ----------------------------------------------------------------------------
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "roundtrip", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
console.log(`server: ${useDist ? "dist/mcp-server.mjs" : "src/mcp/server.ts (tsx)"}  vault: ${vault}  account: ${account}  amount: ${amount} USDC`);

console.log("\n1. earn_vaults");
const vaults = await tool<{ vaults: { slug: string; address: string; chassis: string; isDefault: boolean; asset: { address: string } }[] }>("earn_vaults");
const row = vaults.vaults.find((v) => v.slug === vault);
check(Boolean(row), `registry lists ${vault}`, vaults.vaults.map((v) => v.slug));
if (!row) process.exit(1);
console.log(`       ${row.address}  chassis=${row.chassis}  default=${row.isDefault}`);

console.log("\n2. earn_terms");
const terms = await tool("earn_terms");
check(Object.keys(terms).length > 0, "disclosures returned (an operator must acknowledge these before the first deposit)");

console.log("\n3. earn_status — health, then preflight");
const health = await tool<{ mode: string; rpcSource?: string; rpcConfigured?: boolean; chainId?: number }>("earn_status");
check(health.mode === "health" && health.chainId === 8453, "server up on chain 8453", health);
check(health.rpcConfigured === true, `RPC configured (source: ${health.rpcSource ?? "none"}) — on the public endpoint the steps below rate-limit`, health);
const pre = await tool<{ mode: string; status: string; canDeposit: boolean; findings: string[]; balances?: { asset: string; shares: string } }>("earn_status", { vault, account, amount_usdc: amount });
check(pre.mode === "preflight", "preflight mode", pre);
check(["NEEDS_APPROVAL", "OPEN_READY"].includes(pre.status), `deposit access is OPEN for ${account} (got ${pre.status})`, pre.findings);
console.log(`       balances: ${pre.balances?.asset ?? "?"}, ${pre.balances?.shares ?? "?"}`);

console.log("\n4. earn_balance");
// Default log budget (40 requests): a 200-request scan burned a keyed provider's rate budget fast enough
// that the NEXT steps failed with transient HTTP errors. Basis/yield are informative here, not asserted.
const bal = await tool<{ sharesExact: string; shares: string; usdcValue: string; scan: { complete: boolean; note?: string } }>("earn_balance", { vault, account });
check(/^\d+(\.\d+)?$/.test(bal.sharesExact), `sharesExact is an exact decimal string: ${bal.sharesExact} (${bal.usdcValue})`, bal);
if (!bal.scan.complete) console.log(`       note: event scan incomplete — ${bal.scan.note ?? "no note"}`);

console.log("\n5. earn_quote — both directions");
const qd = await tool<{ direction: string; canProceed: boolean; expectedShares?: string }>("earn_quote", { vault, account, amount_usdc: amount, direction: "deposit" });
check(qd.direction === "deposit", "deposit quote echoes direction=deposit", qd);
const qw = await tool<{ direction: string; canProceed: boolean; simulated: string; sharesToBurn?: string }>("earn_quote", { vault, account, amount_usdc: amount, direction: "withdraw" });
check(qw.direction === "withdraw", "withdraw quote echoes direction=withdraw", qw);
console.log(`       deposit: canProceed=${qd.canProceed} expectedShares=${qd.expectedShares ?? "?"}`);
console.log(`       withdraw: canProceed=${qw.canProceed} simulated=${qw.simulated} sharesToBurn=${qw.sharesToBurn ?? "?"}`);

console.log("\n6. earn_prepare_deposit — the ALLOCATE leg (shares land on the account itself)");
const dep = await tool<Envelope>("earn_prepare_deposit", { vault, account, amount_usdc: amount, receiver: account });
check(dep.requires_signature === true && dep.status === "unsigned", "envelope: requires_signature=true, status=unsigned", dep);
check(dep.calls.length === 2, "two calls: approve, then deposit", dep.calls.map((c) => c.description));
const raw = parseUnits(amount, 6);
{
  const [a, d] = dep.calls.map(decode);
  check(a?.functionName === "approve" && getAddress(String(a.args?.[0])) === getAddress(row.address) && a.args?.[1] === raw, `approve(vault, ${raw})`, a);
  check(d?.functionName === "deposit" && d.args?.[0] === raw && getAddress(String(d.args?.[1])) === account, `deposit(${raw}, receiver=account)`, d);
  check(getAddress(dep.calls[0]!.to) === getAddress(row.asset.address), `approve targets the asset ${row.asset.address}`, dep.calls[0]!.to);
  check(getAddress(dep.calls[1]!.to) === getAddress(row.address), `deposit targets the vault ${row.address}`, dep.calls[1]!.to);
  // The deposit step names what the signer must read before sending it; the approve step names nothing.
  const pre = dep.calls[1]!.precondition;
  check(dep.calls[0]!.precondition === undefined, "approve carries no precondition", dep.calls[0]);
  check(
    !!pre && pre.read === "allowance" && getAddress(pre.owner) === account && getAddress(pre.spender) === getAddress(row.address) && pre.minimum === raw.toString(),
    `deposit precondition: allowance(${account} → vault) >= ${raw} on the sending RPC`,
    pre,
  );
}

console.log("\n7. earn_prepare_withdraw — the DEALLOCATE leg");
const wd = await tool<Envelope>("earn_prepare_withdraw", { vault, account, receiver, amount_usdc: amount });
check(wd.requires_signature === true && wd.status === "unsigned", "envelope: requires_signature=true, status=unsigned", wd);
check(wd.calls.length === 1, "one call", wd.calls.map((c) => c.description));
{
  const w = decode(wd.calls[0]!);
  check(w.functionName === "withdraw", "withdraw(assets, receiver, owner)", w);
  check(w.args?.[0] === raw, `assets = ${raw}`, w.args);
  check(getAddress(String(w.args?.[1])) === receiver, `slot 2 (receiver) = ${receiver} — where the USDC lands`, w.args);
  check(getAddress(String(w.args?.[2])) === account, `slot 3 (owner) = ${account} — whose shares burn`, w.args);
  if (receiver === account)
    console.log("       note: receiver == account, so the two slot checks above cannot tell a transposition apart in THIS run; build.test.ts's two-distinct-address case is what covers that");
  check(getAddress(wd.calls[0]!.to) === getAddress(row.address), "targets the vault", wd.calls[0]!.to);
}

console.log("\n8. the handoff — calls written for a signer that is NOT this repository");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "allocate.calls.json"), JSON.stringify(dep.calls, null, 2));
writeFileSync(resolve(out, "deallocate.calls.json"), JSON.stringify(wd.calls, null, 2));
writeFileSync(
  resolve(out, "summary.json"),
  JSON.stringify({ vault, address: row.address, account, receiver, amount, preflight: pre.status, balance: bal, quotes: { deposit: qd, withdraw: qw }, failures }, null, 2),
);
const usdcHeld = Number((pre.balances?.asset ?? "0").split(" ")[0]);
const order = usdcHeld >= Number(amount) ? "allocate first (the account holds the USDC), then deallocate" : Number(bal.sharesExact) > 0 ? "DEALLOCATE first (the account holds shares, not USDC), then allocate the proceeds back" : "neither leg can run: the account holds neither USDC nor shares";
console.log(`       ${out}/allocate.calls.json, deallocate.calls.json, summary.json\n       recommended order: ${order}`);
console.log(`       sign per docs/runbooks/sign_and_send.md — the key never enters this process, and nothing has moved.`);

child.stdin.end();
child.kill();
console.log(`\n${failures === 0 ? "consistent" : `${failures} FAILED`}: the skill's outputs ${failures === 0 ? "agree with each other and with the calldata" : "disagree — do not hand these calls to a signer"}`);
process.exit(failures === 0 ? 0 : 1);

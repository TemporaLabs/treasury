// Runs the BUILT CLI the way a caller does — `node dist/treasury.mjs …` as a child process — and checks
// the exit code, how long the call took, and that the answer came from the chain. Issue #122: on
// Windows with Node 24 the health check printed a correct answer and still exited non-zero.
//
// Every case is checked and reported before the verdict, so a red run shows each command's real exit
// code, signal, duration and output rather than stopping at the first mismatch.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/treasury.mjs", import.meta.url));
const ACCOUNT = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"; // a Base address that holds USDC; read only
// Far longer than any of these calls takes when it exits at once, and far shorter than the request
// timer a lost race can leave behind, so a fix that waits for open handles shows up here.
const MAX_MS = Number(process.env.CLI_EXIT_MAX_MS ?? 20000);

const cases = [
  {
    name: "health check",
    args: ["earn", "status"],
    code: 0,
    // `latestBlock` comes from the RPC; a command that never reached the network has no block number.
    proof: (out) => out.rpc === "ok" && /^\d+$/.test(out.latestBlock ?? ""),
  },
  {
    name: "deposit quote",
    args: ["earn", "quote", "--direction", "deposit", "--account", ACCOUNT, "--amount_usdc", "1"],
    code: 0,
    // The share price and the pre-flight verdict are read from the vault and a simulated deposit.
    proof: (out) => /USDC per share$/.test(out.sharePriceInAssets ?? "") && out.preflight !== undefined,
  },
  {
    name: "refused argument",
    args: ["earn", "quote", "--direction", "sideways"],
    code: 1,
    // A real failure must still exit 1, with its error on stderr.
    proof: (_out, stderr) => typeof JSON.parse(stderr).error === "string",
  },
];

const rows = [];
for (const c of cases) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...c.args], { encoding: "utf8", timeout: 120000 });
  const ms = Date.now() - started;
  let proved = false;
  try {
    proved = Boolean(c.proof(r.stdout.trim() ? JSON.parse(r.stdout) : {}, r.stderr));
  } catch {
    proved = false;
  }
  const ok = r.status === c.code && proved && ms <= MAX_MS;
  rows.push({ case: c.name, expected: c.code, status: r.status, signal: r.signal, ms, proved, ok });
  console.log(`--- ${c.name}: exit ${r.status}${r.signal ? ` (signal ${r.signal})` : ""}, ${ms} ms, expected ${c.code}, answer proved: ${proved}`);
  if (r.stdout.trim()) console.log(`stdout:\n${r.stdout.trim().slice(0, 1500)}`);
  if (r.stderr.trim()) console.log(`stderr:\n${r.stderr.trim().slice(0, 3000)}`);
  if (r.error) console.log(`spawn error: ${r.error.message}`);
}
console.log(`\n${process.platform} ${process.version}`);
console.table(rows);
const bad = rows.filter((r) => !r.ok);
if (bad.length) {
  console.log(`FAILED: ${bad.map((r) => r.case).join(", ")}`);
  process.exit(1);
}
console.log("every case exited as expected, in time, with an answer read from the chain");

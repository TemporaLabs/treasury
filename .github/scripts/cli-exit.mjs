// Runs the BUILT CLI the way callers do and checks how it exits: the exit code, how long the call took,
// and that the answer came over the network (the Tempora API's health on the EVM chains, Solana's own chain).
// Issue #122: on Windows with Node 24 the health check printed a correct answer and still exited non-zero.
//
// On the EVM chains the earn commands call the Tempora API, and every read but the health check acts for a
// connected wallet, which CI has none of: the EVM cases are the health check and a refused argument. The reads
// that touch a chain run on Solana, which still reads its chain directly.
//
// Subjects: this tree's bundle, and optionally the published v0.1.2 package (where the failure was
// first seen), given as `--subject name=<install prefix>` (or `--subject=name=<install prefix>`). Each is run directly (`node dist/treasury.mjs`)
// and through the `treasury` bin npm installs: from cmd and PowerShell on Windows, from sh elsewhere.
// Every call is reported before the verdict, so a red run shows each one's real exit code (with its hex
// form, which names a Windows crash), duration and output instead of stopping at the first mismatch.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAX_MS = Number(process.env.CLI_EXIT_MAX_MS ?? 20000);
// The job's own Solana endpoint when the repository provides it (CI_RPC_SOLANA), so six matrix legs do not
// share the public endpoint's rate limits; the public endpoint otherwise, which is what a fork's pull request gets,
// since it is not given the repository's secrets.
const RPC_ENV = {
  ...(process.env.CI_RPC_SOLANA ? { TREASURY_RPC_SOLANA: process.env.CI_RPC_SOLANA } : {}),
};
const SOLANA_ACCOUNT = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"; // an unfunded Solana address; read only
// "0.1.10" sorts before "0.1.3" as a string; compare the numbers.
const versionAtLeast = (v, min) => {
  const [a, b] = [v, min].map((x) => x.split(".").map(Number));
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

const cases = [
  {
    name: "health check",
    args: ["earn", "status"],
    code: 0,
    since: "0.1.5",
    // A verdict either way: the API answered, or the check says it could not be reached. Both exit 0.
    proof: (o) => o.mode === "health" && (o.apiStatus === "ok" || o.apiStatus === "unreachable"),
  },
  {
    name: "Solana health",
    args: ["earn", "status", "--chain", "solana"],
    code: 0,
    since: "0.1.3",
    proof: (o) => o.mode === "health" && o.rpc === "ok" && /^\d+$/.test(String(o.latestSlot ?? "")),
  },
  {
    name: "Solana quote",
    args: ["earn", "quote", "--chain", "solana", "--direction", "deposit", "--account", SOLANA_ACCOUNT, "--amount_usdc", "1"],
    code: 0,
    since: "0.1.3",
    proof: (o) => o.chain === "solana" && JSON.stringify(o).includes("slot"),
  },
  {
    name: "Solana balance",
    args: ["earn", "balance", "--chain", "solana", "--account", SOLANA_ACCOUNT],
    code: 0,
    since: "0.1.3",
    proof: (o) => o.chain === "solana" && /^\d+(\.\d+)?$/.test(o.sharesExact ?? ""),
  },
  { name: "refused argument", args: ["earn", "quote", "--direction", "sideways"], code: 1, proof: (_o, err) => typeof JSON.parse(err).error === "string" },
];

// Subjects: this tree, plus any `--subject name=<prefix>` (an npm install prefix holding the package).
// A `--reference name=<prefix>` is run and reported the same way but does not decide the verdict: it is
// a published release kept beside this tree for comparison, and a release that shipped a defect this
// tree fixes would otherwise keep the job red for good. (A reference that is missing still fails.)
const subjects = [{ name: "this tree", version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version, file: join(ROOT, "dist", "treasury.mjs"), prefix: process.env.CLI_EXIT_PREFIX }];
// Each takes `name=<prefix>` as the next argument or after `=`. Any other argument stops the run: one that
// was silently skipped would leave its subject unchecked and the job green.
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = /^--(subject|reference)(?:=(.*))?$/.exec(args[i]);
  const value = flag ? (flag[2] ?? args[++i]) : undefined;
  const m = value === undefined ? null : /^([^=]+)=(.+)$/.exec(value);
  if (!flag || !m) {
    console.error(`cli-exit: unrecognised argument ${JSON.stringify(args[i] ?? args[i - 1])}; give --subject name=<install prefix> or --reference name=<install prefix>`);
    process.exit(2);
  }
  subjects.push({ name: m[1], version: m[1].replace(/^v/, ""), file: join(m[2], "node_modules", "@temporalabs", "treasury", "dist", "treasury.mjs"), prefix: m[2], reference: flag[1] === "reference" });
}

function launches(s) {
  const out = [{ how: "node", cmd: process.execPath, pre: [s.file], shell: false }];
  if (!s.prefix) return out;
  const bin = join(s.prefix, "node_modules", ".bin");
  if (WIN) {
    out.push({ how: "cmd + npm bin", cmd: join(bin, "treasury.cmd"), pre: [], shell: true });
    out.push({ how: "PowerShell + npm bin", cmd: "pwsh", pre: ["-NoProfile", "-Command"], shell: false, ps1: join(bin, "treasury.ps1") });
  } else {
    out.push({ how: "sh + npm bin", cmd: join(bin, "treasury"), pre: [], shell: true });
  }
  return out;
}

function call(l, args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    // PowerShell takes one command string: the npm shim, each argument single-quoted, then its exit code.
    const argv = l.ps1 ? [...l.pre, `& '${l.ps1}' ${args.map((a) => `'${a}'`).join(" ")}; exit $LASTEXITCODE`] : [...l.pre, ...args];
    const child = spawn(l.cmd, l.shell ? argv.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : argv, {
      env: { ...process.env, ...RPC_ENV, ...env },
      shell: l.shell,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const kill = setTimeout(() => child.kill(), 120000);
    child.on("error", (e) => (stderr += `\nspawn error: ${e.message}`));
    child.on("close", (status, signal) => {
      clearTimeout(kill);
      resolve({ status, signal, ms: Date.now() - started, stdout, stderr });
    });
  });
}

const rows = [];
for (const s of subjects) {
  if (!existsSync(s.file)) {
    console.log(`subject ${s.name}: ${s.file} is missing`);
    // A subject that did not install fails the job even when it is a reference: a comparison that
    // silently has nothing to compare against is a broken check, not a passing one.
    rows.push({ subject: s.name, launch: "-", case: "installed", ok: false, gates: true });
    continue;
  }
  for (const l of launches(s)) {
    for (const c of cases) {
      if (c.since && !versionAtLeast(s.version, c.since)) continue;
      const r = await call(l, c.args, c.env);
      let proved = false;
      try {
        proved = Boolean(c.proof(r.stdout.trim() ? JSON.parse(r.stdout) : {}, r.stderr));
      } catch {
        proved = false;
      }
      const hex = typeof r.status === "number" && r.status > 255 ? ` (0x${(r.status >>> 0).toString(16).toUpperCase()})` : "";
      const ok = r.status === c.code && proved && r.ms <= (c.maxMs ?? MAX_MS);
      rows.push({ subject: s.reference ? `${s.name} (reference)` : s.name, launch: l.how, case: c.name, expected: c.code, exit: `${r.status}${hex}`, signal: r.signal, ms: r.ms, proved, ok, gates: !s.reference });
      console.log(`--- [${s.name} | ${l.how}] ${c.name}: exit ${r.status}${hex}${r.signal ? ` signal ${r.signal}` : ""}, ${r.ms} ms, expected ${c.code}, answer proved: ${proved}`);
      if (!ok) {
        if (r.stdout.trim()) console.log(`stdout:\n${r.stdout.trim().slice(0, 1500)}`);
        if (r.stderr.trim()) console.log(`stderr:\n${r.stderr.trim().slice(0, 3000)}`);
      }
    }
  }
}
console.log(`\n${process.platform} ${process.arch} ${process.version}`);
console.table(rows);
const differs = rows.filter((r) => !r.ok && !r.gates);
if (differs.length) console.log(`reference, not gating: ${differs.map((r) => `${r.subject} | ${r.launch} | ${r.case}`).join("; ")}`);
const bad = rows.filter((r) => !r.ok && r.gates);
if (bad.length) {
  console.log(`FAILED: ${bad.map((r) => `${r.subject} | ${r.launch} | ${r.case}`).join("; ")}`);
  process.exit(1);
}
console.log("every call exited as expected, in time, with an answer read over the network");

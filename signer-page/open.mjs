#!/usr/bin/env node
/**
 * treasury-sign: serve the sign page on 127.0.0.1 and open the browser with a prepared envelope in
 * the URL fragment. Browsers never send a fragment, so the server sees four static GETs (the page,
 * its script, the validator, the registry) and nothing about the envelope.
 *
 *   <earn_prepare_deposit output> | node signer-page/open.mjs --account 0xYOUR_ACCOUNT
 *   node signer-page/open.mjs --account 0x… --file envelope.json [--no-open] [--port 41337] [--minutes 30]
 *   node signer-page/open.mjs --file envelope.json     (no --account: the page aims the calls at whichever wallet you connect)
 *   node signer-page/open.mjs --file deposit.json --then withdraw.json   (the withdraw appears on the page once the deposit confirms)
 *   node signer-page/open.mjs --manual [--vault tlCashPlusUSDC2]   (no envelope: deposit and withdraw any amount you type on the page)
 *
 * The envelope is validated here first with the module the page uses; a poisoned one never gets a
 * URL. This process holds no key and sends nothing: the wallet in your browser does both.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validatePayload, validateFollow, validateThen, placeholderAccount, encodePayload, slimPayload } from "./validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const USAGE = "usage: node signer-page/open.mjs [--account 0x…] [--file envelope.json] [--then withdraw.json] | --manual [--vault symbol]  [--no-open] [--port 41337] [--minutes 30]  (envelope on stdin if no --file)";

const account = opt("--account");
const file = opt("--file");
const thenFile = opt("--then");
const manual = args.includes("--manual");
const vaultSymbol = opt("--vault");
const minutes = Number(opt("--minutes", "30"));
const noOpen = args.includes("--no-open");
const port = Number(opt("--port", "41337")); // fixed by default so the wallet's per-site permission survives between runs
if (!Number.isInteger(port) || port < 0 || !(minutes > 0)) { console.error(USAGE); process.exit(2); }
if (manual && (account || file || thenFile)) { console.error(`--manual builds its own calls from what you type, so it takes no envelope. ${USAGE}`); process.exit(2); }
if (!manual && vaultSymbol) { console.error(`--vault only applies to --manual. ${USAGE}`); process.exit(2); }

let envelope, calls;
if (!manual) {
try { envelope = JSON.parse(readFileSync(file ?? 0, "utf8")); } catch (e) { console.error(`refusing to open: the envelope is not JSON (${e.message})`); process.exit(1); }
// `earn_prepare_*` returns an envelope; the library returns a bare array. Take either, but an
// envelope must say it is unsigned: anything else has not come from a prepare tool.
if (!Array.isArray(envelope) && (envelope?.requires_signature !== true || envelope?.status !== "unsigned")) {
  console.error('refusing to open: not an unsigned envelope (expected requires_signature: true, status: "unsigned")');
  process.exit(1);
}
calls = Array.isArray(envelope) ? envelope : envelope.calls;
}

const registry = JSON.parse(readFileSync(join(here, "..", "registry", "vaults.json"), "utf8"));
// With --account the envelope must be for exactly that account. Without it the page follows the wallet
// the operator connects: the envelope is checked here for the one account it names, and the page
// re-aims it (validate.mjs `rebindPayload`) once a wallet connects.
const unsignedCalls = (e, what) => {
  if (!Array.isArray(e) && (e?.requires_signature !== true || e?.status !== "unsigned")) throw new Error(`${what} is not an unsigned envelope`);
  return Array.isArray(e) ? e : e.calls;
};
let payload;
if (manual) {
  // No envelope: the page builds the calls from the amount the operator types. Only the vault is named
  // here, and it must be one the registry lists on Base; the page re-checks it and every call it builds.
  const v = (registry.vaults ?? []).find((x) => x.chainId === 8453 && (vaultSymbol ? x.symbol === vaultSymbol : x.isDefault));
  if (!v) { console.error(`refusing to open: the registry has no Base vault ${vaultSymbol ? `named ${vaultSymbol}` : "marked as the default"}`); process.exit(1); }
  payload = { manual: true, vault: v.symbol };
} else try {
  const list = Array.isArray(calls) ? calls : [];
  const then = thenFile ? unsignedCalls(JSON.parse(readFileSync(thenFile, "utf8")), "the --then file") : undefined;
  if (account) { payload = slimPayload(account, list); }
  else { payload = { ...slimPayload(placeholderAccount(list), list), follow: true }; }
  if (then) {
    // The follow-up must be for the same account the deposit is for, so the page has one account to re-aim.
    if (!account && placeholderAccount(then) !== payload.account) throw new Error("the --then envelope is for a different account than the first one");
    payload.then = slimPayload(payload.account, then).calls;
  }
  const first = account ? validatePayload(payload, registry) : validateFollow(payload, registry);
  validateThen(payload, registry, first);
} catch (e) { console.error(`refusing to open: ${e.message}`); process.exit(1); }

const files = {
  "/": ["text/html; charset=utf-8", readFileSync(join(here, "index.html"))],
  "/app.mjs": ["text/javascript; charset=utf-8", readFileSync(join(here, "app.mjs"))],
  "/validate.mjs": ["text/javascript; charset=utf-8", readFileSync(join(here, "validate.mjs"))],
  "/registry.json": ["application/json", Buffer.from(JSON.stringify(registry))],
};

// The page's own script must load, so `script-src` names 'self'. It also allows inline script, because
// a wallet extension may inject its provider that way and a stricter policy would make the page report
// "no wallet". That is safe here: the page builds no markup from the envelope, and what the policy
// does close is the way out. `connect-src 'self'` means nothing the page holds can be sent anywhere
// but back to this origin, and `frame-ancestors 'none'` means it cannot be embedded.
// (`default-src 'none'` alone is not enough: it is the fallback for script-src, and blocks the page.)
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";

const server = http.createServer((req, res) => {
  const addr = server.address();
  // A DNS-rebinding page reaches 127.0.0.1 under its own hostname; refuse any Host that is not loopback.
  const host = String(req.headers.host ?? "");
  const okHost = addr && (host === `127.0.0.1:${addr.port}` || host === `localhost:${addr.port}`);
  const hit = req.method === "GET" && okHost ? files[req.url.split("?")[0]] : undefined;
  if (!hit) { res.writeHead(!okHost ? 403 : req.method === "GET" ? 404 : 405); res.end(); return; }
  res.writeHead(200, { "content-type": hit[0], "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": CSP, "x-content-type-options": "nosniff" });
  res.end(hit[1]);
});
server.on("error", (e) => { console.error(`cannot listen on 127.0.0.1:${port}: ${e.code} — pass --port <n>`); process.exit(1); });
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/#${encodePayload(payload)}`;
  console.log(`open this in the browser that has your wallet extension:\n${url}\n`);
  console.log(`${manual ? `manual mode for ${payload.vault}: connect a wallet, then deposit or withdraw any amount you type` : `${payload.calls.length} call(s) for ${account ?? "whichever wallet you connect"}; ${account ? "the page checks the connected account against it" : "the page aims them at the wallet you connect and shows you the address before anything is sent"}`}. Serving for ${minutes} min or until Ctrl-C.`);
  if (!noOpen) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch { /* the URL is printed above */ }
  }
  setTimeout(() => { console.log("closing"); server.close(); }, minutes * 60_000).unref();
});

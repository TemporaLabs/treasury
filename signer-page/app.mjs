// The sign page. It renders the destination, connects the wallet extension, and hands each call to
// the wallet with eth_sendTransaction — the wallet's own confirmation is the signature. It holds no
// key and has no way to make one: the only wallet methods it calls are listed in the test that
// keeps them that way (tests/no-signing.test.ts).
//
// Text from the envelope reaches the DOM only through `textContent`. The agent's `description` is
// shown, labelled as the agent's, and never used to decide anything.
import { validatePayload, validateFollow, rebindPayload, validateThen, rebindThen, decodePayload, allowanceCalldata, parseAmount, parseAddress, buildTransferCall, validateSend, buildManualCalls, balanceOfCalldata, convertToAssetsCalldata, BASE_CHAIN_HEX } from "./validate.mjs";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const link = (href, text) => { const a = el("a", "", text); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const msgOf = (e) => (e && (e.message ?? e.toString())) || String(e);
const fatal = (msg) => { const f = $("#fatal"); f.hidden = false; f.textContent = "Stopped: " + msg; };

const units = (n, dec) => {
  const s = BigInt(n).toString().padStart(dec + 1, "0");
  const frac = s.slice(-dec).replace(/0+$/, "");
  return s.slice(0, -dec) + (frac ? "." + frac : "");
};
const basescan = (a) => `https://basescan.org/address/${a}`;
const morpho = (a) => `https://app.morpho.org/base/vault/${a}`;
const addr = (a) => el("span", "addr", a);

// ---- load and validate. Any failure here is final: nothing is rendered but the reason.
let account, calls, registry, payload;
let firstCount = 0; // calls before this index are asked for straight away; the rest (a follow-up withdrawal) wait for the deposit to confirm
let following = false; // no --account: the calls are re-aimed at whichever wallet the operator connects
let manual = false; //    --manual: no envelope; the operator types an amount and the page builds the calls
let manualVault = null;
let setWalletLater = ""; // the wallet card's first line, set once the card exists
try {
  const frag = location.hash.slice(1);
  if (!frag) throw new Error("there are no calls in the address. Open the full address the opener printed (it ends in a long #… part), or run: node signer-page/open.mjs --account 0x… --file envelope.json");
  payload = decodePayload(frag);
  const r = await fetch("./registry.json");
  if (!r.ok) throw new Error("the registry did not load");
  registry = await r.json();
  if (payload.manual === true) {
    manual = true;
    manualVault = (registry.vaults ?? []).find((v) => v.chainId === 8453 && v.symbol === payload.vault);
    if (!manualVault) throw new Error(`the registry has no Base vault named ${payload.vault}`);
    calls = [];
    account = null;
  } else {
    following = payload.follow === true;
    const first = following ? validateFollow(payload, registry) : validatePayload(payload, registry);
    calls = [...first, ...validateThen(payload, registry, first)];
    firstCount = first.length;
    account = following ? null : payload.account; // until a wallet connects there is no account to name
  }
} catch (e) { fatal(msgOf(e)); throw e; }

// ---- the destination check, rendered from the registry and the decoded calldata, not from prose
const fp = $("#fp");
const row = (k, ...nodes) => { const tr = el("tr"); tr.append(el("td", "", k)); const td = el("td"); td.append(...nodes); tr.append(td); fp.append(tr); };
const sentence = (c) => {
  const d = c.decoded, v = c.vault, dec = v.asset.decimals, sh = v.shareDecimals ?? 18;
  if (d.fn === "approve") return `Approve ${units(d.amount, dec)} ${v.asset.symbol} for ${v.name} to pull`;
  if (d.fn === "deposit") return `Deposit ${units(d.assets, dec)} ${v.asset.symbol} into ${v.name}`;
  if (d.fn === "withdraw") return `Withdraw ${units(d.assets, dec)} ${v.asset.symbol} from ${v.name}`;
  if (d.fn === "transfer") return `Send ${units(d.amount, dec)} ${v.asset.symbol} to ${parseAddress(d.to)}`;
  return `Redeem ${units(d.shares, sh)} ${v.symbol} from ${v.name} for ${v.asset.symbol}`;
};
// Drawn again once a wallet connects in follow mode, so the operator reads the real address here
// before any Send button exists.
function renderDestination() {
  fp.replaceChildren();
  if (account) row("account", addr(account), el("span", "muted", following ? " — the wallet you connected; every call below was re-aimed at it" : manual ? " — the wallet you connected; every call below is for it" : " — the wallet you connect must be this one"));
  else row("account", document.createTextNode("the wallet you connect"), el("span", "muted", " — its address appears here, and in every step below, once you connect and before anything can be sent"));
  row("registry", el("span", "muted", `vault data reconciled against the chain ${registry.reconciledAtIso ?? "at an unrecorded time"}`));
  const vaults = [...new Map(calls.filter((c) => c.decoded.fn !== "transfer").map((c) => [c.vault.address, c.vault])).values()];
  for (const c of calls.filter((c) => c.decoded.fn === "transfer")) { // a send: the token and the recipient, in full, before anything else
    row("token", document.createTextNode(`${c.vault.asset.symbol} `), addr(c.vault.asset.address), el("span", "muted", " on Base (8453)"));
    row("recipient", el("strong", "addr", parseAddress(c.decoded.to)), el("br"), el("span", "warn", "This is where the USDC goes. Check every character. It cannot be undone."));
  }
  for (const v of vaults) {
    row("vault", document.createTextNode(v.name + " "), el("span", "muted", `(${v.symbol}${v.isDefault ? ", the default" : ""})`));
    if (v.warning) row("warning", el("span", "warn", v.warning)); // the registry says to show this before any deposit
    const links = [link(basescan(v.address), "BaseScan")];
    if (String(v.chassis).startsWith("morpho")) links.push(document.createTextNode(" · "), link(morpho(v.address), "Morpho app"));
    row("address", addr(v.address), el("br"), ...links);
    row("token", document.createTextNode(`shares ${v.symbol}; asset ${v.asset.symbol} `), addr(v.asset.address), el("span", "muted", " on Base (8453)"));
    if (v.depositOpen?.measuredAtBlock) row("measured", el("span", "muted", `deposit access checked at block ${v.depositOpen.measuredAtBlock}`));
  }
  calls.forEach((c, i) => {
    const d = c.decoded;
    const paidTo = d.fn === "approve" || d.fn === "transfer" ? [] : [document.createTextNode(d.fn === "deposit" ? " → shares to " : " → paid to "), account ? addr(account) : document.createTextNode("the wallet you connect")];
    row(`step ${i + 1} · decoded`, document.createTextNode(sentence(c)), ...paidTo);
  });
  $("#destination").hidden = false;
}
if (manual) {
  document.body.classList.add("manual");
  $("#destination h2").textContent = "Destination — read this before you send";
  $("#intro").textContent = "Choose an amount to deposit or withdraw. This page builds the transaction for your connected wallet, shows you where the money goes, and your wallet asks you to confirm each one. Nothing here holds a key: your wallet signs.";
} else renderDestination();

// ---- wallet
// Either the browser's own extension, or (only when the opener was given --privy-app-id) an email login
// that Privy turns into a wallet. Both are handed to the rest of the page as the same kind of provider,
// and the page asks either one for the same fixed list of methods.
let eth;
if (payload.privyAppId !== undefined) {
  if (!/^[a-z0-9]{10,40}$/.test(String(payload.privyAppId))) { fatal("the Privy app id in the address is not an app id"); throw new Error("bad privy app id"); }
  try {
    const { connectPrivy } = await import("./privy-provider.js");
    eth = await connectPrivy(payload.privyAppId);
  } catch (e) { fatal(`Privy could not start: ${msgOf(e)}`); throw e; }
  $("#btn-connect").textContent = "Log in with email";
  setWalletLater = "Not logged in. Privy will email you a code and create a wallet for you on Base.";
} else {
  await new Promise((resolve) => {
    if (window.ethereum) return resolve();
    addEventListener("ethereum#initialized", resolve, { once: true });
    setTimeout(resolve, 1500);
  });
  eth = window.ethereum;
  if (!eth) {
    fatal("no wallet extension found in this browser (window.ethereum is missing). Open this page in the browser that has MetaMask, Rabby or Coinbase Wallet, or use the terminal hand-off.");
    throw new Error("no wallet");
  }
}
const rpc = (method, params = []) => eth.request({ method, params });
$("#connect").hidden = false;
const privyMode = payload.privyAppId !== undefined;

let connected = false; // the operator has connected once
let walletOk = false; //  connected, on Base, and the right account — kept current by the wallet's events
let next = 0; //         the one step that may be sent
let busy = false;
const steps = [];
const hashes = [];

const setWallet = (text, cls = "muted") => { const w = $("#wallet-status"); w.textContent = text; w.className = cls; };
if (setWalletLater) setWallet(setWalletLater);
const refresh = () => {
  steps.forEach((s, i) => { s.btn.disabled = !(walletOk && !busy && i === next && !s.hash && !s.blocked); });
  if (manual) updateManual();
};
let runDone = false; // the current set of steps has all confirmed
const inFlight = () => busy || (steps.some((s) => s.hash || s.blocked) && !runDone);
function resetRun() { //  drop the steps on screen; only ever called when nothing of them has been sent
  steps.length = 0; $("#steps").replaceChildren(); hashes.length = 0; next = 0; runDone = false; calls = []; firstCount = 0;
  fp.replaceChildren();
  for (const id of ["#destination", "#calls", "#done"]) $(id).hidden = true;
}

async function assertWallet() {
  const chain = await rpc("eth_chainId");
  if (chain !== BASE_CHAIN_HEX) throw new Error(`the wallet is on chain ${chain}, not Base (${BASE_CHAIN_HEX})`);
  const [acct] = await rpc("eth_accounts");
  if (!acct || !same(acct, account)) throw new Error(`the wallet's selected account is ${acct ?? "none"}, not ${account}`);
}

$("#btn-connect").onclick = async () => {
  try {
    const [acct] = await rpc("eth_requestAccounts");
    // Follow mode: the calls are aimed at the wallet the operator connects. A click on Connect is the
    // operator's explicit choice, so a different account re-aims them (the destination card and the
    // steps are redrawn for the operator to read) until the first transaction has been handed to a
    // wallet. After that the approval and the deposit would belong to different accounts, so it stops.
    if (manual && acct && !same(acct, account ?? "")) {
      if (inFlight()) {
        setWallet(`The wallet offered ${acct}, but a transaction has already been sent from ${account} and has not finished. Select ${account} in the wallet and connect again, or reload the address.`, "status bad");
        return;
      }
      account = acct; pos = null;
      resetRun();
    }
    if (following && acct && !same(acct, account ?? "")) {
      if (steps.some((s) => s.hash || s.blocked) || busy) {
        setWallet(`The wallet offered ${acct}, but a transaction has already been sent from ${account}, so these calls cannot move to another account. Select ${account} in the wallet and connect again, or reload the address to start over.`, "status bad");
        return;
      }
      const first = rebindPayload(payload, acct, registry); // throws unless every call is valid for this account
      calls = [...first, ...rebindThen(payload, acct, registry, first)];
      account = acct;
      steps.length = 0; $("#steps").replaceChildren(); next = 0; // nothing has been sent, so start the steps over for this account
      renderDestination();
    }
    if (!acct || !same(acct, account)) {
      setWallet(`The wallet offered ${acct ?? "no account"}, but these calls are for ${account}. Select that account in the wallet and connect again. This page will not adapt the calls to a different account.`, "status bad");
      return;
    }
    if ((await rpc("eth_chainId")) !== BASE_CHAIN_HEX) await rpc("wallet_switchEthereumChain", [{ chainId: BASE_CHAIN_HEX }]);
    await assertWallet();
    connected = walletOk = true;
    setWallet(`Connected ${acct} on Base. The account matches.`, "status ok");
    $("#btn-connect").disabled = true;
    if (manual) { $("#manual").hidden = false; await readPosition(); }
    else if (!steps.length) renderSteps();
    refresh();
  } catch (e) { setWallet(`Could not connect: ${msgOf(e)}`, "status bad"); }
};
// A step is sent from the account and chain the wallet has *now*, so a change between steps pauses
// the page rather than sending to somewhere the operator did not read. The handlers do not trust the
// event's payload: they read the wallet's state again, so switching back resumes the page.
async function recheck() {
  if (!connected) return;
  try { await assertWallet(); walletOk = true; setWallet(`Connected ${account} on Base. The account matches.`, "status ok"); }
  catch (e) {
    walletOk = false;
    setWallet(`Paused: ${msgOf(e)}. Put it right in the wallet${following || manual ? ", or click Connect wallet to use the account it has now" : ", or connect again"}, to continue.`, "status bad");
    $("#btn-connect").disabled = false; // a wallet that was disconnected can be reconnected without reloading
  }
  refresh();
}
eth.on?.("accountsChanged", recheck);
eth.on?.("chainChanged", recheck);

// ---- steps
function renderSteps() {
  const box = $("#steps");
  calls.forEach((c, i) => {
    const s = { i, hash: null, blocked: false };
    const box1 = el("div", "step");
    box1.hidden = i >= firstCount; // the follow-up withdrawal appears once the deposit has confirmed
    s.box = box1;
    const head = el("div", "head");
    head.append(el("strong", "", `${i + 1} of ${calls.length}: ${sentence(c)}`));
    s.btn = el("button", "", "Send to wallet");
    s.btn.disabled = true;
    s.btn.onclick = () => run(i);
    head.append(s.btn);
    s.status = el("div", "status", i === 0 ? "ready" : "waiting for the step before");
    s.setStatus = (m, cls = "") => { s.status.textContent = m; s.status.className = "status " + cls; };
    s.again = el("button", "secondary", "Check the receipt again");
    s.again.hidden = true;
    s.again.onclick = () => watch(s);
    const said = el("div", "muted");
    if (manual) said.append("Built by this page from the amount you entered and your connected wallet, and checked against the vault registry before it was shown to you.");
    else said.append("The agent's description (not verified): ", el("span", "", c.description ?? "none"));
    const raw = el("details");
    const sum = el("summary", "", "raw call");
    const body = el("div", "addr");
    body.append(`to ${c.to}`, el("br"), `data ${c.data}`);
    raw.append(sum, body);
    box1.append(head, s.status, s.again, said, raw);
    box.append(box1);
    steps.push(s);
  });
  $("#calls").hidden = false;
}

async function waitAllowance(p, s) {
  for (let n = 0; n < 40; n++) {
    const r = await rpc("eth_call", [{ to: p.contract, data: allowanceCalldata(p.owner, p.spender) }, "latest"]);
    if (BigInt(r) >= BigInt(p.minimum)) { s.setStatus(`allowance is ${p.minimum} or more on your wallet's RPC`); return; }
    s.setStatus(`waiting for an allowance of ${p.minimum} on your wallet's RPC (${n + 1}/40)…`);
    await sleep(3000);
  }
  throw new Error("the allowance never became visible on the wallet's RPC; the approve may not have confirmed");
}

async function run(i) {
  if (busy || i !== next) return;
  const s = steps[i], c = calls[i];
  busy = true; refresh();
  try {
    await assertWallet();
    if (c.precondition) await waitAllowance(c.precondition, s);
    s.setStatus("estimating gas…");
    const estimate = await rpc("eth_estimateGas", [{ from: account, to: c.to, data: c.data, value: "0x0" }]);
    const gas = "0x" + ((BigInt(estimate) * 3n) / 2n).toString(16); // estimate × 1.5, per the envelope's gas advice
    const nonceBefore = await rpc("eth_getTransactionCount", [account, "pending"]);
    s.nonceBefore = nonceBefore;
    s.setStatus(`confirm in your wallet (gas limit ${BigInt(gas)}, the estimate × 1.5)…`);
    let hash;
    try {
      hash = await rpc("eth_sendTransaction", [{ from: account, to: c.to, data: c.data, value: "0x0", gas }]);
    } catch (e) {
      if (e?.code === 4001) { s.setStatus("You rejected it in the wallet. Nothing was sent; you can try again.", "bad"); return; }
      // Any other error may or may not have followed a broadcast. The account's nonce says which.
      const after = await rpc("eth_getTransactionCount", [account, "pending"]).catch(() => null);
      if (after !== null && BigInt(after) === BigInt(nonceBefore)) { s.setStatus(`Not sent: ${msgOf(e)}. Nothing left your account; you can try again.`, "bad"); return; }
      s.blocked = true;
      s.setStatus(`The wallet reported an error (${msgOf(e)}) and ${after === null ? "the account's nonce could not be read" : "the account's nonce moved"}, so the transaction may have been sent. Check your wallet's activity or BaseScan before doing anything. This page will not send it again.`, "bad");
      return;
    }
    s.hash = hash; // from here on this step is never sent again, whatever happens to the receipt
    await watch(s);
  } catch (e) {
    if (!s.hash) s.setStatus(`Not sent: ${msgOf(e)}`, "bad"); // nothing was handed to the wallet; a retry is safe
  } finally { busy = false; refresh(); }
}

// Poll for the receipt. A failed poll is not a failed transaction, so errors are swallowed and the
// loop goes on; the only outcomes are a receipt, or "still pending" with a way to look again.
//
// One case is not "still pending": a wallet can hand back a hash for a transaction its node then never
// accepts (the wallet shows it as failed; nothing reaches the chain). Twice, some 40 seconds apart, the
// page asks whether the network knows the hash and whether the account's pending nonce moved. Only if
// the hash is unknown both times AND the nonce is exactly what it was before the send does it say so
// and let the step be sent again, because an accepted transaction would have used that nonce.
async function neverReached(s) {
  const seen = await rpc("eth_getTransactionByHash", [s.hash]).catch(() => "unknown");
  const nonce = await rpc("eth_getTransactionCount", [account, "pending"]).catch(() => null);
  return seen === null && nonce !== null && s.nonceBefore !== undefined && BigInt(nonce) === BigInt(s.nonceBefore);
}

async function watch(s) {
  s.again.hidden = true;
  s.setStatus(`sent ${s.hash} — waiting for the receipt…`);
  let votes = 0;
  for (let n = 0; n < 90; n++) {
    const rcpt = await rpc("eth_getTransactionReceipt", [s.hash]).catch(() => null);
    if (rcpt) {
      if (rcpt.status !== "0x1") { s.setStatus(`REVERTED in block ${BigInt(rcpt.blockNumber)}: ${s.hash}. The later steps stay disabled.`, "bad"); runDone = true; return; } // over: a manual review can start again
      s.setStatus(`confirmed in block ${BigInt(rcpt.blockNumber)}: ${s.hash}`, "ok");
      hashes.push(`step ${s.i + 1}: ${s.hash} (block ${BigInt(rcpt.blockNumber)})`);
      next = s.i + 1;
      if (steps[next]) { steps[next].box.hidden = false; steps[next].setStatus("ready"); }
      else finish();
      refresh();
      return;
    }
    if (n === 20 || n === 40) {
      votes = (await neverReached(s)) ? votes + 1 : 0;
      if (votes >= 2) {
        const lost = s.hash;
        s.hash = null; s.blocked = false; // safe: no node has it and the nonce is unused, so nothing was sent
        s.setStatus(`Your wallet returned ${lost}, but that transaction never reached Base: no node knows it and the account's nonce has not moved. Nothing was sent and no funds moved, so it is safe to send this step again. If your wallet shows it as failed, this is why; check that it has enough ETH on Base for gas.`, "bad");
        refresh();
        return;
      }
    }
    await sleep(2000);
  }
  s.setStatus(`no receipt yet for ${s.hash} after 3 minutes. It may still confirm; check BaseScan. This step will not be sent again.`, "bad");
  s.again.hidden = false;
}

function finish() {
  runDone = true;
  if (manual) readPosition().catch(() => {}); // the position on screen follows what just happened
  $("#summary").textContent = hashes.join("\n");
  $("#done").hidden = false;
  $("#btn-copy").onclick = () => navigator.clipboard.writeText($("#summary").textContent);
}

// ---- manual mode: the operator types an amount, the page builds the calls
let pos = null; // { usdc, shares, value } in smallest units, read through the wallet's own RPC
const say = (m, cls = "") => { const p = $("#manual-msg"); p.textContent = m; p.className = "status " + cls; };
const ask = async (to, data) => BigInt(await rpc("eth_call", [{ to, data }, "latest"]));

async function readPosition() {
  const v = manualVault;
  const usdc = await ask(v.asset.address, balanceOfCalldata(account));
  const shares = await ask(v.address, balanceOfCalldata(account));
  const value = shares > 0n ? await ask(v.address, convertToAssetsCalldata(shares)) : 0n;
  const gasEth = BigInt(await rpc("eth_getBalance", [account, "latest"]));
  pos = { usdc, shares, value, gasEth };
  const t = $("#position");
  t.replaceChildren();
  const r = (k, ...nodes) => { const tr = el("tr"); tr.append(el("td", "", k)); const td = el("td"); td.append(...nodes); tr.append(td); t.append(tr); };
  r("vault", document.createTextNode(v.name + " "), link(basescan(v.address), "BaseScan"));
  if (v.warning) r("warning", el("span", "warn", v.warning));
  r("wallet", addr(account));
  r(`${v.asset.symbol} in your wallet`, document.createTextNode(units(usdc, v.asset.decimals)));
  r(`${v.symbol} you hold`, document.createTextNode(units(shares, v.shareDecimals ?? 18)));
  r("worth", document.createTextNode(`${units(value, v.asset.decimals)} ${v.asset.symbol}`));
  // A vault transaction asks the wallet to reserve gas for a limit of about 2.4 million, far more than it
  // uses, so a wallet holding only a sliver of ETH can be refused even though the cost would be a cent.
  if (privyMode && usdc === 0n) r("fund this wallet", el("span", "muted", "This wallet is new. To deposit, send USDC and a little ETH (for gas) on Base to the address above."));
    r("ETH for gas (Base)", document.createTextNode(`${units(gasEth, 18)} ETH`), ...(gasEth < 100_000_000_000_000n ? [el("br"), el("span", "muted", "low: a vault transaction can be refused with less than about 0.0001 ETH; add a little ETH on Base")] : []));
  updateManual();
}

function updateManual() {
  const on = walletOk && !busy && pos !== null;
  $("#btn-deposit").disabled = !on || !manualVault.depositOpen?.open;
  $("#max-deposit").disabled = !on;
  $("#btn-withdraw").disabled = !on || pos.shares === 0n;
  $("#max-withdraw").disabled = !on || pos.shares === 0n;
  if (privyMode) { $("#btn-send").disabled = !on || pos.usdc === 0n; $("#max-send").disabled = !on || pos.usdc === 0n; }
}

async function review(kind) {
  say("");
  if (inFlight()) { say("A transaction from the current review has been sent; let it finish, or reload the address, before starting another.", "bad"); return; }
  try {
    await assertWallet();
    await readPosition(); // amounts are checked against the chain as it is now, not the screen a minute ago
    const v = manualVault, dec = v.asset.decimals;
    let built;
    if (kind === "deposit") {
      const assets = parseAmount($("#amt-deposit").value, dec);
      if (!v.depositOpen?.open) throw new Error(`${v.name} does not take deposits from every account`);
      if (assets > pos.usdc) throw new Error(`you have ${units(pos.usdc, dec)} ${v.asset.symbol} in this wallet`);
      const allowance = await ask(v.asset.address, allowanceCalldata(account, v.address));
      built = buildManualCalls("deposit", { vault: v, account, assets, allowance });
    } else if (kind === "withdraw") {
      const assets = parseAmount($("#amt-withdraw").value, dec);
      if (assets > pos.value) throw new Error(`your position is worth ${units(pos.value, dec)} ${v.asset.symbol}`);
      built = buildManualCalls("withdraw", { vault: v, account, assets });
    } else if (kind === "send") {
      if (!privyMode) throw new Error("sending is only offered with a Privy wallet");
      const assets = parseAmount($("#amt-send").value, dec);
      if (assets > pos.usdc) throw new Error(`you have ${units(pos.usdc, dec)} ${v.asset.symbol} in this wallet`);
      const to = parseAddress($("#send-to").value);
      built = [buildTransferCall({ vault: v, to, assets })];
    } else {
      if (pos.shares === 0n) throw new Error("you hold no shares in this vault");
      built = buildManualCalls("redeem", { vault: v, account, shares: pos.shares }); // the exact balance, never a rounded figure
    }
    // This page's own output gets a check before it is shown: an agent's envelope has validatePayload, and a
    // send, which no envelope may ever be, has its own stricter one.
    const checked = kind === "send" ? validateSend(built, account, registry) : validatePayload({ account, calls: built }, registry);
    resetRun();
    calls = checked;
    firstCount = checked.length;
    renderDestination();
    renderSteps();
    refresh();
  } catch (e) { say(msgOf(e), "bad"); }
}
if (manual) {
  if (privyMode) {
    $("#send-panel").hidden = false;
    $("#btn-send").onclick = () => review("send");
    $("#max-send").onclick = () => { if (pos) $("#amt-send").value = units(pos.usdc, manualVault.asset.decimals); };
  }
  $("#btn-deposit").onclick = () => review("deposit");
  $("#btn-withdraw").onclick = () => review("withdraw");
  $("#max-withdraw").onclick = () => review("redeem");
  $("#max-deposit").onclick = () => { if (pos) $("#amt-deposit").value = units(pos.usdc, manualVault.asset.decimals); };
}

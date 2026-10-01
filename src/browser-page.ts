/**
 * The one page browser sign-in serves. It is static: nothing from a request is ever interpolated
 * into it. Everything dynamic (the account a call is for, the decoded calldata) arrives as JSON
 * from `/info` and is written with `textContent` only, so no value an MCP caller or a vault can
 * influence is ever parsed as markup.
 *
 * Two modes share it, picked by the path it was served from: `/connect` (prove control of an
 * address with a gasless signature) and `/sign` (hand ONE prepared call to the wallet). Like
 * `claude login`, it is a one-shot: when the wallet has answered, it says so and tells the operator
 * to go back to the terminal. There is no dashboard, nothing to keep open.
 *
 * Wallet discovery is EIP-6963 (every installed wallet announces itself, so two extensions do not
 * fight over `window.ethereum`), with `window.ethereum` as the fallback for wallets that predate it.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tempora Treasury</title>
<style>
  :root { --bg:#fbfaf7; --ink:#1c1b18; --mute:#6b675e; --line:#dedad0; --ok:#1d6b3a; --bad:#9b2c1f; --accent:#2b4c7e; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141412; --ink:#ebe8e0; --mute:#a39e93; --line:#33312c; --ok:#5fbf7f; --bad:#e0705f; --accent:#8fb0e0; --card:#1d1c19; } }
  html,body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:560px; margin:0 auto; padding:48px 16px; display:flex; flex-direction:column; gap:16px; }
  h1 { font-size:20px; margin:0; }
  .muted { color:var(--mute); margin:0; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; word-break:break-all; }
  table { border-collapse:collapse; width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; }
  td { padding:8px 12px; vertical-align:top; border-top:1px solid var(--line); }
  tr:first-child td { border-top:0; }
  td:first-child { color:var(--mute); white-space:nowrap; width:7em; }
  #wallets { display:flex; flex-direction:column; gap:8px; }
  button { font:inherit; padding:12px 16px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; text-align:left; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  #msg { margin:0; min-height:1.5em; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
</style>
</head>
<body>
<main>
  <h1 id="h">Tempora Treasury</h1>
  <p class="muted" id="lead">Loading…</p>
  <table id="facts" hidden></table>
  <div id="wallets"></div>
  <p id="msg" role="status"></p>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var s = new URLSearchParams(location.search).get("s") || "";
  var BASE = "0x2105";
  var info = null, providers = [], finished = false, busy = false;

  function msgOf(e) { return (e && (e.message || e.reason)) || String(e); }
  function say(t, cls) { var m = $("msg"); m.textContent = t; m.className = cls || ""; }
  function row(k, v) {
    var tr = document.createElement("tr"), a = document.createElement("td"), b = document.createElement("td");
    a.textContent = k; b.textContent = v; b.className = "mono"; tr.append(a, b); $("facts").append(tr); $("facts").hidden = false;
  }
  function post(path, body) {
    body.s = s;
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.reason || ("HTTP " + r.status)); return j; }); });
  }
  function done(title, text) { finished = true; $("h").textContent = title; $("lead").textContent = text; $("wallets").replaceChildren(); say(""); }
  function abort(reason) {
    finished = true;
    post("/result", { rejected: true, reason: reason }).catch(function () {});
    $("wallets").replaceChildren();
    say(reason + " Nothing was sent. Go back to your terminal and run it again.", "bad");
  }
  async function ensureBase(p) {
    var c = await p.request({ method: "eth_chainId" });
    if (c !== BASE) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE }] });
    c = await p.request({ method: "eth_chainId" });
    if (c !== BASE) throw new Error("The wallet is not on Base.");
  }

  async function runConnect(p) {
    var accts = await p.request({ method: "eth_requestAccounts" });
    var addr = accts && accts[0];
    if (!addr) throw new Error("The wallet returned no account.");
    await ensureBase(p);
    var ch = await post("/challenge", { address: addr });
    var sig = await p.request({ method: "personal_sign", params: [ch.message, addr] });
    await post("/result", { address: addr, signature: sig, chainId: BASE });
    done("Wallet connected", addr + " is connected on Base. You can close this tab and go back to your terminal.");
  }
  async function runSign(p) {
    var accts = await p.request({ method: "eth_requestAccounts" });
    var want = info.account.toLowerCase();
    if (!(accts || []).some(function (a) { return a.toLowerCase() === want; })) {
      throw new Error("Your wallet does not have " + info.account + ". Select that account in the wallet and try again.");
    }
    await ensureBase(p);
    var hash = await p.request({ method: "eth_sendTransaction", params: [{ from: info.account, to: info.call.to, data: info.call.data, value: info.call.value }] });
    await post("/result", { hash: hash });
    done("Submitted", "The wallet signed and sent it. You can close this tab and go back to your terminal.");
  }

  async function pick(p) {
    if (busy || finished) return;
    busy = true; say("Check your wallet…");
    try { await (info.mode === "connect" ? runConnect(p) : runSign(p)); }
    catch (e) { busy = false; abort(msgOf(e)); }
  }

  function renderWallets() {
    var box = $("wallets"); box.replaceChildren();
    providers.forEach(function (w) {
      var b = document.createElement("button");
      b.textContent = (info && info.mode === "sign" ? "Approve in " : "Connect ") + w.name;
      b.onclick = function () { pick(w.provider); };
      box.append(b);
    });
  }
  function discover() {
    addEventListener("eip6963:announceProvider", function (e) {
      var d = e.detail || {};
      if (!d.provider || !d.info) return;
      if (providers.some(function (w) { return w.id === d.info.uuid; })) return;
      providers.push({ id: d.info.uuid, name: d.info.name, provider: d.provider });
      renderWallets();
    });
    dispatchEvent(new Event("eip6963:requestProvider"));
    return new Promise(function (r) { setTimeout(r, 500); }).then(function () {
      if (!providers.length && window.ethereum) { providers.push({ id: "injected", name: "browser wallet", provider: window.ethereum }); renderWallets(); }
    });
  }

  fetch("/info?s=" + encodeURIComponent(s)).then(function (r) { return r.json(); }).then(function (j) {
    info = j;
    if (j.mode === "connect") {
      $("h").textContent = "Connect your wallet";
      $("lead").textContent = "Pick your wallet, then sign one message. It costs no gas and cannot move funds.";
    } else {
      $("h").textContent = "Approve in your wallet";
      $("lead").textContent = "Your agent prepared one transaction. Check it below. Your wallet will ask you to confirm; that confirmation is the signature.";
      row("From", j.account);
      row("To", j.call.to);
      row("Does", j.decoded ? j.decoded : "Unrecognised call data. Do not approve unless you know what this is.");
      row("Value", j.call.value === "0x0" ? "0 ETH" : j.call.value + " (wei)");
    }
    return discover();
  }).then(function () {
    if (!providers.length && !finished) {
      $("lead").textContent = "No wallet extension was found in this browser.";
      say("Open this link in a browser that has MetaMask, Rabby or Coinbase Wallet. Or go back to your terminal and use the WalletConnect option.", "bad");
    }
  }).catch(function (e) { say("This link is no longer valid: " + msgOf(e), "bad"); });
})();
</script>
</body>
</html>
`;

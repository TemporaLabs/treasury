// The plain (no Privy SDK) pages the plugin serves: the connect page with its two separate
// buttons, and the confirmation page every send goes through. They render server-provided strings
// with textContent only. The Privy sign-in page is a separate React bundle served at /privy.

export const PLAIN_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";

export const PRIVY_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "child-src https://auth.privy.io",
  "frame-src https://auth.privy.io https://challenges.cloudflare.com",
  "connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

const STYLE = `
  :root { --bg:#fbfaf7; --ink:#1c1b18; --mute:#6b675e; --line:#dedad0; --ok:#1d6b3a; --bad:#9b2c1f; --warn:#8a5a00; --accent:#2b4c7e; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141412; --ink:#ebe8e0; --mute:#a39e93; --line:#33312c; --ok:#5fbf7f; --bad:#e0705f; --warn:#e0b04f; --accent:#8fb0e0; --card:#1d1c19; } }
  .tl-ground { background:
    radial-gradient(ellipse 48% 60% at 72% 60%, rgba(255,255,255,.9), rgba(255,255,255,0) 72%),
    radial-gradient(ellipse 60% 75% at 0% 0%, rgba(118,166,213,.16), rgba(118,166,213,0) 70%),
    radial-gradient(ellipse 55% 65% at 100% 100%, rgba(185,167,214,.17), rgba(185,167,214,0) 70%),
    linear-gradient(90deg, #e9f1f9 0%, #eff1f6 50%, #efecf6 100%); }
  @media (prefers-color-scheme: dark) { .tl-ground { background:var(--bg); } }
  html,body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:560px; margin:0 auto; padding:48px 16px; display:flex; flex-direction:column; gap:16px; }
  h1 { font-size:20px; margin:0; }
  .muted { color:var(--mute); margin:0; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; word-break:break-all; }
  table { border-collapse:collapse; width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; }
  td { padding:8px 12px; vertical-align:top; border-top:1px solid var(--line); }
  tr:first-child td { border-top:0; }
  td:first-child { color:var(--mute); white-space:nowrap; width:7em; }
  .stack { display:flex; flex-direction:column; gap:8px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  button { font:inherit; padding:12px 16px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; text-align:left; }
  button.secondary { background:transparent; color:var(--accent); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .warn { border:1px solid var(--warn); color:var(--warn); border-radius:8px; padding:8px 12px; margin:0; }
  #msg { margin:0; min-height:1.5em; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
`;

// Shared by both pages: secret, POST helper, EIP-6963 wallet discovery, Base switch.
const COMMON_JS = `
  var $ = function (id) { return document.getElementById(id); };
  var s = new URLSearchParams(location.search).get("s") || "";
  var BASE = "0x2105";
  var providers = [], finished = false, busy = false;
  function msgOf(e) { return (e && (e.message || e.reason)) || String(e); }
  function say(t, cls) { var m = $("msg"); m.textContent = t; m.className = cls || ""; }
  function post(path, body) {
    body.s = s;
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.reason || ("HTTP " + r.status)); return j; }); });
  }
  async function ensureBase(p) {
    var c = await p.request({ method: "eth_chainId" });
    if (c !== BASE) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE }] });
    c = await p.request({ method: "eth_chainId" });
    if (c !== BASE) throw new Error("The wallet is not on Base.");
  }
  function discover(onChange) {
    addEventListener("eip6963:announceProvider", function (e) {
      var d = e.detail || {};
      if (!d.provider || !d.info) return;
      if (providers.some(function (w) { return w.id === d.info.uuid; })) return;
      providers.push({ id: d.info.uuid, name: d.info.name, provider: d.provider });
      onChange();
    });
    dispatchEvent(new Event("eip6963:requestProvider"));
    return new Promise(function (r) { setTimeout(r, 500); }).then(function () {
      if (!providers.length && window.ethereum) { providers.push({ id: "injected", name: "browser wallet", provider: window.ethereum }); onChange(); }
    });
  }
`;

const shell = (title: string, body: string, script: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body class="tl-ground">
${body}
<script>
(function () {
${COMMON_JS}
${script}
})();
</script>
</body>
</html>
`;

export const CONFIRM_HTML = shell(
  "Confirm — Tempora Treasury",
  `<main>
  <h1 id="h">Confirm this transaction</h1>
  <p class="muted" id="lead">Loading…</p>
  <div id="warnings" class="stack"></div>
  <table id="facts" hidden></table>
  <div class="stack" id="actions" hidden></div>
  <p id="msg" role="status"></p>
</main>`,
  `
  var info = null;
  function row(k, v) {
    var tr = document.createElement("tr"), a = document.createElement("td"), b = document.createElement("td");
    a.textContent = k; b.textContent = v; b.className = "mono"; tr.append(a, b); $("facts").append(tr); $("facts").hidden = false;
  }
  function done(title, text) { finished = true; $("h").textContent = title; $("lead").textContent = text; $("actions").replaceChildren(); $("actions").hidden = true; say(""); }
  function stop(reason) { finished = true; $("actions").replaceChildren(); $("actions").hidden = true; say(reason + " Nothing was signed. Go back to your terminal.", "bad"); }
  function reject() {
    if (finished) return;
    post("/result", { rejected: true, reason: "rejected on the confirmation page" }).catch(function () {});
    done("Rejected", "Nothing was signed. You can close this tab.");
  }
  async function viaService() {
    if (busy || finished) return;
    busy = true; say("Signing\\u2026");
    try {
      var r = await post("/result", { confirmed: true });
      done("Submitted", "Transaction " + r.hash + " was signed and sent. You can close this tab and go back to your terminal.");
    } catch (e) { busy = false; stop(msgOf(e)); }
  }
  async function viaWallet(p) {
    if (busy || finished) return;
    busy = true; say("Check your wallet\\u2026");
    try {
      var accts = await p.request({ method: "eth_requestAccounts" });
      var want = info.account.toLowerCase();
      if (!(accts || []).some(function (a) { return a.toLowerCase() === want; })) throw new Error("Your wallet does not have " + info.account + ". Select that account in the wallet and try again.");
      await ensureBase(p);
      var hash = await p.request({ method: "eth_sendTransaction", params: [{ from: info.account, to: info.call.to, data: info.call.data, value: info.call.value }] });
      await post("/result", { hash: hash });
      done("Submitted", "The wallet signed and sent it. You can close this tab and go back to your terminal.");
    } catch (e) { busy = false; stop(msgOf(e)); }
  }
  function button(label, fn, secondary) {
    var b = document.createElement("button");
    b.textContent = label; if (secondary) b.className = "secondary"; b.onclick = fn; $("actions").append(b);
  }
  function renderActions() {
    $("actions").replaceChildren(); $("actions").hidden = false;
    if (info.signer === "service") button("Confirm and sign", viaService);
    else providers.forEach(function (w) { button("Confirm in " + w.name, function () { viaWallet(w.provider); }); });
    button("Reject", reject, true);
  }
  fetch("/info?s=" + encodeURIComponent(s)).then(function (r) { return r.json(); }).then(function (j) {
    info = j;
    $("h").textContent = j.decoded.summary;
    $("lead").textContent = j.signer === "service"
      ? "Your agent prepared this transaction. Check it below. It is signed only after you confirm here."
      : "Your agent prepared this transaction. Check it below, confirm here, then your wallet asks for the signature.";
    j.decoded.warnings.forEach(function (w) { var p = document.createElement("p"); p.className = "warn"; p.textContent = w; $("warnings").append(p); });
    j.decoded.rows.forEach(function (r) { row(r[0], r[1]); });
    if (j.signer === "service") { renderActions(); return; }
    return discover(renderActions).then(function () {
      if (!providers.length) { say("No wallet extension was found in this browser. Open this link in a browser that has your wallet.", "bad"); button("Reject", reject, true); $("actions").hidden = false; }
    });
  }).catch(function (e) { say("This link is no longer valid: " + msgOf(e), "bad"); });
  `,
);

export const privyShell = (secret: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect — Tempora Treasury</title></head><body><div id="root"></div><script src="/app.js?s=${secret}"></script></body></html>`;

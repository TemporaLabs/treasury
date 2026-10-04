// The one Privy page, served at /connect (sign in) and, for an embedded wallet only, at /confirm
// (send one call). One "Connect" button opens a single Privy modal with email, Google and the browser
// wallets Privy detects.
//  - connect: whichever wallet results signs the server's free challenge and the server checks the
//    signature locally. The plugin never trusts Privy's login for who controls an address.
//  - confirm: the embedded wallet sends the one call from this page. Privy's own modal is the
//    signature; no service and no key outside the browser is involved.
// WalletConnect is never offered.
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { base } from "viem/chains";

const secret = new URLSearchParams(location.search).get("s") ?? "";

interface Info {
  mode: "connect" | "confirm";
  appId: string;
  account?: string;
  call?: { to: string; data: string; value: string };
  decoded?: { summary: string; warnings: string[]; rows: string[][] };
}

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; message?: string; hash?: string }> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: secret, ...body }) });
  return r.json();
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Phase = { kind: "idle" } | { kind: "working"; text: string } | { kind: "done"; text: string } | { kind: "error"; text: string };

function Status({ phase }: { phase: Phase }) {
  if (phase.kind === "working" || phase.kind === "done") return <p className={phase.kind === "done" ? "status ok" : "status"}>{phase.text}</p>;
  if (phase.kind === "error") return <p className="status err">{phase.text}</p>;
  return null;
}

function SignIn() {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const started = useRef(false);
  const cleared = useRef(false);
  // How this login happened. "siwe" is Privy's name for a browser wallet; anything else is
  // email / Google and lands on the embedded wallet.
  const [method, setMethod] = useState<string | null>(null);

  const fail = useCallback(async (text: string) => {
    setPhase({ kind: "error", text });
    await post("/result", { rejected: true, reason: text }).catch(() => {});
  }, []);

  // Both kinds of wallet prove the address the same way: sign the server's free challenge.
  const prove = useCallback(
    async (wallet: ConnectedWallet, kind: "external" | "embedded") => {
      try {
        setPhase({ kind: "working", text: kind === "external" ? "Check your wallet to sign the free sign-in message…" : "Opening your wallet…" });
        await wallet.switchChain(base.id);
        const provider = await wallet.getEthereumProvider();
        const ch = await post("/challenge", { address: wallet.address });
        if (!ch.ok || !ch.message) throw new Error(ch.reason ?? "no sign-in message was issued");
        const signature = await provider.request({ method: "personal_sign", params: [ch.message, wallet.address] });
        const r = await post("/result", { kind, address: wallet.address, signature, chainId: "0x2105", walletName: kind === "external" ? wallet.meta?.name ?? "" : "" });
        if (!r.ok) throw new Error(r.reason ?? "the sign-in was refused");
        setPhase({ kind: "done", text: "Connected. You can close this tab and return to the terminal." });
      } catch (e) {
        await fail(msgOf(e) || "sign-in failed");
      }
    },
    [fail],
  );

  // A Privy session left over from an earlier run must never resume silently: clear it once.
  useEffect(() => {
    if (!ready || cleared.current) return;
    cleared.current = true;
    if (authenticated) void logout();
  }, [ready, authenticated, logout]);

  const { login } = useLogin({
    onComplete: ({ loginMethod, wasAlreadyAuthenticated }) => {
      if (wasAlreadyAuthenticated) return;
      setMethod(loginMethod ?? "unknown");
    },
    onError: (code) => {
      // Closing the modal is not a failure the terminal needs to hear about.
      if (String(code) !== "exited_auth_flow") void fail(`Privy sign-in failed: ${String(code)}`);
    },
  });

  useEffect(() => {
    if (!ready || !walletsReady || !authenticated || !method || started.current) return;
    const external = method === "siwe";
    // A browser wallet is any wallet that is not Privy's own; an email/Google login uses the embedded one.
    const wallet = wallets.find((w) => (w.walletClientType === "privy") !== external);
    if (!wallet) return;
    started.current = true;
    void prove(wallet, external ? "external" : "embedded");
  }, [ready, walletsReady, authenticated, method, wallets, prove]);

  const working = phase.kind === "working";
  return (
    <main>
      <h1>Connect to Tempora Treasury</h1>
      <p className="sub">Use Google or email, or a browser wallet such as MetaMask or Rabby. Each deposit or withdrawal still shows a confirmation page first.</p>
      {phase.kind === "idle" && !authenticated && (
        <button disabled={!ready} onClick={() => login()}>
          {ready ? "Connect" : "Loading…"}
        </button>
      )}
      {phase.kind === "idle" && authenticated && <p className="status">Preparing your wallet…</p>}
      <Status phase={phase} />
      {phase.kind === "error" && <p className="sub">The terminal was told this sign-in failed. Run connect again to retry.</p>}
      {authenticated && !working && phase.kind !== "done" && (
        <button className="link" onClick={() => void logout()}>
          Use a different account
        </button>
      )}
    </main>
  );
}

// The one-shot confirmation for an embedded wallet. The decoded call comes from the server, never from
// an agent's prose. The Privy session from the connect step lives in this origin's storage, so the
// operator is normally already logged in; if not, Privy's modal asks.
function Confirm({ info }: { info: Info }) {
  const { ready, authenticated } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = useRef(false);
  const { login } = useLogin();

  const stop = useCallback(async (reason: string) => {
    setPhase({ kind: "error", text: `${reason} Nothing was signed. Go back to your terminal.` });
    await post("/result", { rejected: true, reason }).catch(() => {});
  }, []);

  const confirm = useCallback(async () => {
    if (busy.current || !info.call || !info.account) return;
    const wallet = wallets.find((w) => w.walletClientType === "privy" && w.address.toLowerCase() === info.account!.toLowerCase());
    if (!wallet) {
      setPhase({ kind: "error", text: `Log in as ${info.account} first (Google or email), then confirm again.` });
      return;
    }
    busy.current = true;
    try {
      setPhase({ kind: "working", text: "Confirm in the Privy window…" });
      await wallet.switchChain(base.id);
      const provider = await wallet.getEthereumProvider();
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: wallet.address, to: info.call.to, data: info.call.data, value: info.call.value }] });
      const r = await post("/result", { hash });
      if (!r.ok) throw new Error(r.reason ?? "the result was refused");
      setPhase({ kind: "done", text: "Submitted. You can close this tab and go back to your terminal." });
    } catch (e) {
      busy.current = false;
      await stop(msgOf(e));
    }
  }, [info, wallets, stop]);

  const reject = useCallback(async () => {
    await post("/result", { rejected: true, reason: "rejected on the confirmation page" }).catch(() => {});
    setPhase({ kind: "done", text: "Rejected. Nothing was signed. You can close this tab." });
  }, []);

  const d = info.decoded;
  const hasWallet = authenticated && walletsReady && wallets.some((w) => w.walletClientType === "privy");
  const finished = phase.kind === "done" || phase.kind === "error";
  return (
    <main>
      <h1>{d?.summary}</h1>
      <p className="sub">Your agent prepared this transaction. Check it below, confirm here, then Privy asks you to approve it.</p>
      {d?.warnings.map((w, i) => (
        <p key={i} className="status err">{w}</p>
      ))}
      <table>
        <tbody>
          {d?.rows.map((r, i) => (
            <tr key={i}>
              <td>{r[0]}</td>
              <td className="mono">{r[1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Status phase={phase} />
      {!finished && phase.kind !== "working" && (
        <div className="row">
          {hasWallet ? (
            <button onClick={() => void confirm()}>Confirm and sign</button>
          ) : (
            <button disabled={!ready} onClick={() => login()}>{ready ? "Log in to confirm" : "Loading…"}</button>
          )}
          <button className="link" onClick={() => void reject()}>Reject</button>
        </div>
      )}
    </main>
  );
}

function App() {
  const [info, setInfo] = useState<Info>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetch(`/info?s=${encodeURIComponent(secret)}`)
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setError("This link is not valid. Run the command again."));
  }, []);
  if (error) return <main><p className="status err">{error}</p></main>;
  if (!info) return <main><p className="status">Loading…</p></main>;
  const confirming = info.mode === "confirm";
  return (
    <PrivyProvider
      appId={info.appId}
      config={{
        // `loginMethods: [..., "wallet"]` hides wallets behind a "Continue with a wallet" click.
        // `loginMethodsAndOrder.primary` puts email, Google and every installed browser wallet
        // (MetaMask, Rabby, Phantom, OKX...) on the first screen, as in the reference. No
        // wallet_connect entry: the plugin never offers WalletConnect.
        loginMethodsAndOrder: { primary: ["email", "google", "detected_ethereum_wallets"] },
        appearance: {
          theme: "light",
          accentColor: "#4f6ef7",
          landingHeader: "Log in or sign up",
          walletChainType: "ethereum-only",
        },
        // Signing the free sign-in challenge needs no popup; a real send always shows Privy's modal.
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: confirming },
        // The plugin never uses or offers WalletConnect; stop the SDK from initializing it.
        externalWallets: { walletConnect: { enabled: false } },
        defaultChain: base,
        supportedChains: [base],
      }}
    >
      {confirming ? <Confirm info={info} /> : <SignIn />}
    </PrivyProvider>
  );
}

const style = document.createElement("style");
style.textContent = `
  :root{color-scheme:light dark;--fg:#111827;--bg:#fff;--mut:#6b7280;--ok:#047857;--err:#b91c1c}
  @media (prefers-color-scheme:dark){:root{--fg:#f3f4f6;--bg:#0b0f14;--mut:#9ca3af;--ok:#34d399;--err:#f87171}}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
  :root{--privy-border-radius-sm:12px;--privy-border-radius-md:16px;--privy-border-radius-lg:24px;--privy-border-radius-full:999px}
  .tl-ground{background:
    radial-gradient(ellipse 48% 60% at 72% 60%,rgba(255,255,255,.9),rgba(255,255,255,0) 72%),
    radial-gradient(ellipse 60% 75% at 0% 0%,rgba(118,166,213,.16),rgba(118,166,213,0) 70%),
    radial-gradient(ellipse 55% 65% at 100% 100%,rgba(185,167,214,.17),rgba(185,167,214,0) 70%),
    linear-gradient(90deg,#e9f1f9 0%,#eff1f6 50%,#efecf6 100%)}
  @media (prefers-color-scheme:dark){.tl-ground{background:var(--bg)}}
  main{max-width:26rem;margin:12vh auto;padding:0 16px}
  h1{font-size:1.4rem;margin:0 0 .25rem}.sub{color:var(--mut);margin:.25rem 0 1.25rem}
  button{font:inherit;padding:.65rem 1.1rem;border-radius:.5rem;border:0;background:var(--fg);color:var(--bg);cursor:pointer}
  button:disabled{opacity:.5;cursor:default}button.link{background:none;color:var(--mut);text-decoration:underline;padding:.5rem 0}
  table{border-collapse:collapse;width:100%;margin:.5rem 0 1rem;background:#fff;border:1px solid #dedad0;border-radius:8px}td{padding:8px 12px;vertical-align:top;border-top:1px solid #dedad0}.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all}.row{display:flex;gap:12px;align-items:center}
  .status{margin:.5rem 0}.ok{color:var(--ok)}.err{color:var(--err)}`;
document.head.appendChild(style);
document.body.classList.add("tl-ground");
document.title = "Connect — Tempora Treasury";
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

// The one sign-in page, served at /connect. One "Connect" button opens a single Privy modal with
// email, Google and the browser wallets Privy detects. Two outcomes:
//  - email / Google: Privy's EMBEDDED wallet, then the signing service delegation (kind "embedded").
//  - a browser wallet: Privy is only the picker. The plugin does not trust Privy's login for who
//    controls the address; the wallet signs the server's challenge and the server checks it locally
//    (kind "external"), the same as before.
// WalletConnect is never offered.
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, useLogin, usePrivy, useSigners, useWallets } from "@privy-io/react-auth";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { base } from "viem/chains";

const secret = new URLSearchParams(location.search).get("s") ?? "";

interface Info {
  appId: string;
  signerId: string | null;
  policyIds: string[];
}

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: secret, ...body }) });
  return r.json();
}

type Phase = { kind: "idle" } | { kind: "working"; text: string } | { kind: "done"; text: string } | { kind: "error"; text: string };

function SignIn({ info }: { info: Info }) {
  const { ready, authenticated, logout, user, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { addSigners } = useSigners();
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

  const finish = useCallback(
    async (wallet: ConnectedWallet) => {
      try {
        if (!info.signerId) throw new Error("the signing service is not configured (no signer id) — ask the operator to set PRIVY_SIGNER_ID");
        setPhase({ kind: "working", text: "Allowing the signing service to act within its limits…" });
        const delegated = user?.linkedAccounts.some((a) => a.type === "wallet" && "delegated" in a && a.delegated === true && a.address.toLowerCase() === wallet.address.toLowerCase());
        if (!delegated) await addSigners({ address: wallet.address, signers: [{ signerId: info.signerId, policyIds: info.policyIds }] });
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error("Privy returned no access token");
        const r = await post("/result", { kind: "embedded", address: wallet.address, accessToken });
        if (!r.ok) throw new Error(r.reason ?? "the sign-in was refused");
        setPhase({ kind: "done", text: "Signed in. You can close this tab and return to the terminal." });
      } catch (e) {
        await fail(e instanceof Error ? e.message : "sign-in failed");
      }
    },
    [info, user, addSigners, getAccessToken, fail],
  );

  const finishExternal = useCallback(
    async (wallet: ConnectedWallet) => {
      try {
        setPhase({ kind: "working", text: "Check your wallet to sign the free sign-in message…" });
        await wallet.switchChain(base.id);
        const provider = await wallet.getEthereumProvider();
        const ch = await post("/challenge", { address: wallet.address });
        if (!ch.ok || !ch.message) throw new Error(ch.reason ?? "no sign-in message was issued");
        const signature = await provider.request({ method: "personal_sign", params: [ch.message, wallet.address] });
        const r = await post("/result", { kind: "external", address: wallet.address, signature, chainId: "0x2105" });
        if (!r.ok) throw new Error(r.reason ?? "the sign-in was refused");
        setPhase({ kind: "done", text: "Wallet connected. You can close this tab and return to the terminal." });
      } catch (e) {
        await fail(e instanceof Error ? e.message : "sign-in failed");
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
    if (method === "siwe") {
      // A browser wallet: any wallet that is not Privy's own embedded one.
      const external = wallets.find((w) => w.walletClientType !== "privy");
      if (!external) return;
      started.current = true;
      void finishExternal(external);
      return;
    }
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    if (!embedded) return;
    started.current = true;
    void finish(embedded);
  }, [ready, walletsReady, authenticated, method, wallets, finish, finishExternal]);

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
      {(phase.kind === "working" || phase.kind === "done") && <p className={phase.kind === "done" ? "status ok" : "status"}>{phase.text}</p>}
      {phase.kind === "error" && (
        <>
          <p className="status err">{phase.text}</p>
          <p className="sub">The terminal was told this sign-in failed. Run connect again to retry.</p>
        </>
      )}
      {authenticated && !working && phase.kind !== "done" && (
        <button className="link" onClick={() => void logout()}>
          Use a different account
        </button>
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
      .catch(() => setError("This sign-in link is not valid. Run connect again."));
  }, []);
  if (error) return <main><p className="status err">{error}</p></main>;
  if (!info) return <main><p className="status">Loading…</p></main>;
  return (
    <PrivyProvider
      appId={info.appId}
      config={{
        loginMethods: ["email", "google", "wallet"],
        // Detected extensions (Rabby and others) plus the two named ones; no wallet_connect entry.
        appearance: { theme: "light", accentColor: "#111827", walletChainType: "ethereum-only", walletList: ["detected_wallets", "metamask", "coinbase_wallet"] as never },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        // The plugin never uses or offers WalletConnect; stop the SDK from initializing it.
        externalWallets: { walletConnect: { enabled: false } },
        defaultChain: base,
        supportedChains: [base],
      }}
    >
      <SignIn info={info} />
    </PrivyProvider>
  );
}

const style = document.createElement("style");
style.textContent = `
  :root{color-scheme:light dark;--fg:#111827;--bg:#fff;--mut:#6b7280;--ok:#047857;--err:#b91c1c}
  @media (prefers-color-scheme:dark){:root{--fg:#f3f4f6;--bg:#0b0f14;--mut:#9ca3af;--ok:#34d399;--err:#f87171}}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
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
  .status{margin:.5rem 0}.ok{color:var(--ok)}.err{color:var(--err)}`;
document.head.appendChild(style);
document.body.classList.add("tl-ground");
document.title = "Connect — Tempora Treasury";
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

// The Google/email sign-in page. Served only at /privy, after the operator chose "Continue with
// Google or email". It signs in to Privy for an EMBEDDED wallet and nothing else: an external wallet
// is connected on the plain /connect page and never reaches this bundle.
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useSigners, useWallets } from "@privy-io/react-auth";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { base } from "viem/chains";

const secret = new URLSearchParams(location.search).get("s") ?? "";

interface Info {
  appId: string;
  signerId: string | null;
  policyIds: string[];
}

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: secret, ...body }) });
  return r.json();
}

type Phase = { kind: "idle" } | { kind: "working"; text: string } | { kind: "done"; text: string } | { kind: "error"; text: string };

function SignIn({ info }: { info: Info }) {
  const { ready, authenticated, login, logout, user, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { addSigners } = useSigners();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const started = useRef(false);

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

  useEffect(() => {
    if (!ready || !walletsReady || !authenticated || started.current) return;
    // Only Privy's own embedded wallet is accepted here. A linked external wallet is ignored.
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    if (!embedded) return;
    started.current = true;
    void finish(embedded);
  }, [ready, walletsReady, authenticated, wallets, finish]);

  const working = phase.kind === "working";
  return (
    <main>
      <h1>Sign in with Google or email</h1>
      <p className="sub">Privy opens or creates your embedded wallet. Each deposit or withdrawal still shows a confirmation page first.</p>
      {phase.kind === "idle" && !authenticated && (
        <button disabled={!ready} onClick={() => login()}>
          {ready ? "Sign in" : "Loading…"}
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
        loginMethods: ["email", "google"],
        appearance: { theme: "light", accentColor: "#111827" },
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
  main{max-width:26rem;margin:12vh auto;padding:0 16px}
  h1{font-size:1.4rem;margin:0 0 .25rem}.sub{color:var(--mut);margin:.25rem 0 1.25rem}
  button{font:inherit;padding:.65rem 1.1rem;border-radius:.5rem;border:0;background:var(--fg);color:var(--bg);cursor:pointer}
  button:disabled{opacity:.5;cursor:default}button.link{background:none;color:var(--mut);text-decoration:underline;padding:.5rem 0}
  .status{margin:.5rem 0}.ok{color:var(--ok)}.err{color:var(--err)}`;
document.head.appendChild(style);
document.title = "Connect — Tempora Treasury";
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

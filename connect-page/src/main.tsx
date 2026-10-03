/**
 * The page behind `treasury connect`. Two views, chosen by the local process's /info:
 *
 *   connect  One Connect button → Privy's window (email, Google, Apple, X, browser wallets). The
 *            chosen wallet signs a free sign-in message the local process issued; the process checks
 *            the signature. An email/social login gets a Privy embedded wallet, which signs the same
 *            message — so both paths prove the account the same way.
 *   confirm  The calls the process built and admitted, shown decoded. The operator confirms each one;
 *            the wallet (their extension, or Privy's own confirmation for an embedded wallet) sends
 *            it; the process reads the receipt and says whether the next step may go.
 *
 * Nothing here holds a key. Every request back to the process carries the flow's secret.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, useLogin, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { arbitrum, base } from "viem/chains";
import logo from "./logo.svg";

const secret = new URLSearchParams(location.search).get("s") ?? "";

type Call = {
  step: number;
  of: number;
  kind: string;
  description: string;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  vault: { symbol: string; name: string; address: string; links: { explorer: string; app?: string } };
};
type Info =
  | { mode: "connect"; appId: string }
  | { mode: "confirm"; appId: string; account: string; walletType: "external" | "embedded"; chainId: number; chainName: string; next: number; calls: Call[] };

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> & { ok: boolean; reason?: string }> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: secret, ...body }) });
  return r.json();
}
const reject = (reason: string) => post("/result", { rejected: true, reason }).catch(() => undefined);
const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

const S = {
  main: { maxWidth: 560, margin: "0 auto", padding: "48px 20px", display: "flex", flexDirection: "column", gap: 18 } as React.CSSProperties,
  logo: { height: 22, alignSelf: "flex-start" } as React.CSSProperties,
  card: { background: "rgba(255,255,255,.85)", border: "1px solid var(--hair)", borderRadius: 16, padding: 24, boxShadow: "0 1px 2px rgba(15,35,64,.04), 0 12px 32px -20px rgba(15,35,64,.18)", display: "flex", flexDirection: "column", gap: 14 } as React.CSSProperties,
  eyebrow: { fontFamily: '"IBM Plex Mono",ui-monospace,Menlo,monospace', fontSize: 11.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--slate)", margin: 0 } as React.CSSProperties,
  h1: { fontSize: 22, margin: 0, color: "var(--steel)", fontWeight: 600 } as React.CSSProperties,
  p: { margin: 0, color: "var(--slate)" } as React.CSSProperties,
  btn: { font: "inherit", fontWeight: 500, padding: "14px 22px", borderRadius: 10, border: "1px solid var(--navy)", background: "var(--navy)", color: "#fff", cursor: "pointer" } as React.CSSProperties,
  ghost: { font: "inherit", padding: "14px 22px", borderRadius: 10, border: "1px solid var(--hair)", background: "#fff", color: "var(--ink)", cursor: "pointer" } as React.CSSProperties,
  mono: { fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 13, wordBreak: "break-all" } as React.CSSProperties,
  row: { display: "grid", gridTemplateColumns: "7.5em 1fr", gap: "6px 12px", fontSize: 14 } as React.CSSProperties,
};

function Frame({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <main style={S.main}>
      <img src={logo} alt="Tempora Labs" style={S.logo} />
      <section style={S.card}>
        <p style={S.eyebrow}>{eyebrow}</p>
        <h1 style={S.h1}>{title}</h1>
        {children}
      </section>
    </main>
  );
}

function Status({ text, tone }: { text: string; tone?: "ok" | "bad" }) {
  return <p style={{ ...S.p, color: tone === "ok" ? "var(--ok)" : tone === "bad" ? "var(--bad)" : "var(--slate)" }} aria-live="polite">{text}</p>;
}

/** The wallet that matches how the operator just signed in: a browser wallet for a wallet login, Privy's embedded one otherwise. */
function pick(wallets: ConnectedWallet[], method: string | null): ConnectedWallet | undefined {
  if (method === "siwe") return wallets.find((w) => w.walletClientType !== "privy");
  return wallets.find((w) => w.walletClientType === "privy");
}

function Connect() {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [method, setMethod] = useState<string | null>(null);
  const [phase, setPhase] = useState<{ text: string; tone?: "ok" | "bad"; busy?: boolean; done?: boolean }>({ text: "" });
  const cleared = useRef(false);
  const started = useRef(false);

  // A Privy session left from an earlier run must never connect silently: start from a clean login.
  useEffect(() => {
    if (!ready || cleared.current) return;
    cleared.current = true;
    if (authenticated) void logout();
  }, [ready, authenticated, logout]);

  const { login } = useLogin({
    onComplete: ({ loginMethod, wasAlreadyAuthenticated }) => {
      if (!wasAlreadyAuthenticated) setMethod(loginMethod ?? "unknown");
    },
    onError: (code) => {
      if (String(code) !== "exited_auth_flow") setPhase({ text: `Sign-in failed: ${String(code)}`, tone: "bad" });
    },
  });

  const prove = useCallback(async (wallet: ConnectedWallet, walletType: "external" | "embedded") => {
    try {
      setPhase({ text: walletType === "external" ? "Check your wallet: sign the free sign-in message." : "Approve the free sign-in message.", busy: true });
      const ch = await post("/challenge", { address: wallet.address });
      if (!ch.ok || typeof ch["message"] !== "string") throw new Error(ch.reason ?? "no sign-in message was issued");
      const provider = await wallet.getEthereumProvider();
      const signature = await provider.request({ method: "personal_sign", params: [ch["message"], wallet.address] });
      const r = await post("/result", { address: wallet.address, signature, walletType });
      if (!r.ok) throw new Error(r.reason ?? "the sign-in was refused");
      setPhase({ text: "Connected. You can close this tab and go back to your agent.", tone: "ok", done: true });
    } catch (e) {
      const text = errText(e);
      setPhase({ text: `Not connected: ${text}`, tone: "bad", done: true });
      await reject(text);
    }
  }, []);

  useEffect(() => {
    if (!ready || !walletsReady || !authenticated || !method || started.current) return;
    const wallet = pick(wallets, method);
    if (!wallet) return;
    started.current = true;
    void prove(wallet, wallet.walletClientType === "privy" ? "embedded" : "external");
  }, [ready, walletsReady, authenticated, method, wallets, prove]);

  return (
    <Frame eyebrow="Tempora Treasury" title="Connect a wallet">
      <p style={S.p}>Use a browser wallet such as MetaMask, or continue with email, Google, Apple or X. Connecting costs nothing and moves no money; every deposit or withdrawal is shown to you and confirmed separately.</p>
      {!phase.done && (
        <button style={{ ...S.btn, opacity: ready && !phase.busy ? 1 : 0.5 }} disabled={!ready || phase.busy} onClick={() => login()}>
          Connect
        </button>
      )}
      <Status text={phase.text} tone={phase.tone} />
    </Frame>
  );
}

function Confirm({ info }: { info: Extract<Info, { mode: "confirm" }> }) {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { login } = useLogin();
  const [next, setNext] = useState(info.next);
  const [phase, setPhase] = useState<{ text: string; tone?: "ok" | "bad"; busy?: boolean; done?: boolean }>({ text: "" });
  const wallet = wallets.find((w) => w.address.toLowerCase() === info.account.toLowerCase());
  const call = info.calls[next];

  const send = useCallback(async () => {
    if (!wallet || !call) return;
    try {
      setPhase({ text: "Check your wallet and confirm.", busy: true });
      await wallet.switchChain(info.chainId);
      const provider = await wallet.getEthereumProvider();
      const tx = { from: wallet.address, to: call.to, data: call.data, value: call.value };
      // Gas: the estimate × 1.5. A Morpho Vault V2 call can run out of gas on an unbuffered estimate.
      const est = BigInt((await provider.request({ method: "eth_estimateGas", params: [tx] })) as string);
      const hash = (await provider.request({ method: "eth_sendTransaction", params: [{ ...tx, gas: `0x${((est * 3n) / 2n).toString(16)}` }] })) as string;
      setPhase({ text: "Sent. Waiting for it to land…", busy: true });
      const r = await post("/result", { index: next, hash });
      if (!r.ok) throw new Error(r.reason ?? "refused");
      const verdict = (r["verdict"] ?? {}) as { verified?: string; detail?: string };
      if (r["stop"]) return setPhase({ text: `Stopped: ${verdict.detail ?? String(r["reason"] ?? "the step did not land as confirmed")}`, tone: "bad", done: true });
      if (r["finished"]) {
        return setPhase({ text: verdict.verified === "extra_transfer" ? `Done — but note: ${verdict.detail}` : "Done. You can close this tab and go back to your agent.", tone: "ok", done: true });
      }
      setNext(Number(r["next"]));
      setPhase({ text: "Step confirmed on chain. Review the next one." });
    } catch (e) {
      const text = errText(e);
      setPhase({ text: `Not sent: ${text}`, tone: "bad", done: true });
      await reject(text);
    }
  }, [wallet, call, info.chainId, next]);

  const cancel = async () => {
    setPhase({ text: "Cancelled. Nothing more will be sent.", tone: "bad", done: true });
    await reject("cancelled by the operator on the confirm page");
  };

  return (
    <Frame eyebrow={`Tempora Treasury · ${info.chainName}`} title={call ? `Confirm step ${call.step} of ${call.of}` : "Confirm"}>
      {call && !phase.done && (
        <>
          <p style={S.p}>{call.description}</p>
          <div style={S.row}>
            <span style={S.p}>Vault</span>
            <span>
              {call.vault.name} ({call.vault.symbol}) ·{" "}
              <a href={call.vault.links.explorer} target="_blank" rel="noreferrer">explorer</a>
            </span>
            <span style={S.p}>Vault address</span>
            <span style={S.mono}>{call.vault.address}</span>
            <span style={S.p}>Calls</span>
            <span style={S.mono}>{call.to}</span>
            <span style={S.p}>Account</span>
            <span style={S.mono}>{info.account}</span>
            <span style={S.p}>Chain</span>
            <span>{info.chainName} ({info.chainId})</span>
          </div>
          {!ready ? (
            <Status text="Loading…" />
          ) : !authenticated || !wallet ? (
            <>
              <p style={S.p}>Sign in with the connected account ({info.walletType === "embedded" ? "the same email or social login" : "the same browser wallet"}) to continue.</p>
              <button style={S.btn} onClick={() => login()}>Sign in</button>
            </>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button style={{ ...S.btn, opacity: phase.busy ? 0.5 : 1 }} disabled={phase.busy} onClick={() => void send()}>
                Confirm in wallet
              </button>
              <button style={S.ghost} disabled={phase.busy} onClick={() => void cancel()}>Cancel</button>
            </div>
          )}
        </>
      )}
      <Status text={phase.text} tone={phase.tone} />
    </Frame>
  );
}

function App({ info }: { info: Info }) {
  return info.mode === "connect" ? <Connect /> : <Confirm info={info} />;
}

async function main() {
  const root = createRoot(document.getElementById("root")!);
  const info = (await (await fetch(`/info?s=${encodeURIComponent(secret)}`)).json()) as Info;
  root.render(
    <PrivyProvider
      appId={info.appId}
      config={{
        appearance: { theme: "light", accentColor: "#1E3553", logo, landingHeader: "Connect to Tempora Treasury", walletChainType: "ethereum-only", walletList: ["detected_ethereum_wallets"] },
        // Every option on the first screen; only wallets already installed in this browser (no WalletConnect).
        loginMethodsAndOrder: { primary: ["email", "google", "apple", "twitter", "detected_ethereum_wallets"] },
        externalWallets: { walletConnect: { enabled: false } },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        supportedChains: [base, arbitrum],
        defaultChain: base,
      }}
    >
      <App info={info} />
    </PrivyProvider>,
  );
}

void main();

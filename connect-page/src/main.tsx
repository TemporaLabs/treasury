/**
 * The page behind `treasury connect`. Two views, chosen by the local process's /info:
 *
 *   connect  One button → Privy's window (email, Google, Apple, X, browser wallets). The chosen
 *            wallet signs a free sign-in message the local process issued; the process checks the
 *            signature. An email/social login gets a Privy wallet, which signs the same message — so
 *            both paths prove the account the same way.
 *   confirm  The calls the process built and admitted, shown decoded. The operator confirms each one;
 *            the wallet (their extension, or Privy's own confirmation for a Privy wallet) sends it;
 *            the process reads the receipt and says whether the next step may go.
 *
 * Nothing here holds a key. Every request back to the process carries the flow's secret.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, useLogin, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { arbitrum, base, robinhood } from "viem/chains";
import { CSS } from "./styles";

const secret = new URLSearchParams(location.search).get("s") ?? "";

type WalletType = "external" | "embedded";
type Call = {
  step: number;
  of: number;
  kind: "approve" | "deposit" | "withdraw" | "redeem";
  description: string;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  vault: { symbol: string; name: string; address: string; asset: string; links: { explorer: string; app?: string } };
};
type Info =
  | { mode: "connect"; appId: string }
  | { mode: "confirm"; appId: string; account: string; walletType: WalletType; chainId: number; chainName: string; next: number; calls: Call[] };

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> & { ok: boolean; reason?: string }> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: secret, ...body }) });
  return r.json();
}
const reject = (reason: string, sent?: { hash: string; index: number }) => post("/result", { rejected: true, reason, ...sent }).catch(() => undefined);
const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

type Phase = { text: string; tone?: "ok" | "bad"; busy?: boolean; done?: boolean };

const actionName = (c: Call) =>
  c.kind === "approve" ? `Approve ${c.vault.asset}` : c.kind === "deposit" ? `Deposit ${c.vault.asset}` : c.kind === "withdraw" ? `Withdraw ${c.vault.asset}` : "Withdraw everything";

const actionLede = (c: Call) =>
  c.kind === "approve"
    ? `Allow the vault to take this deposit from your wallet. It covers this amount only.`
    : c.kind === "deposit"
      ? `Move your ${c.vault.asset} into the vault. Your wallet receives vault shares in return.`
      : `Take ${c.vault.asset} out of the vault, back to your wallet.`;

/** How a Privy login method reads to a person; a wallet login has no "signed in with". */
const methodName = (m: string | null): string | undefined =>
  ({ email: "email", google: "Google", apple: "Apple", twitter: "X" } as Record<string, string>)[m ?? ""];

/** One centred column: a mark, what is being asked, and the one action. */
function Page({ mark, title, lede, children }: { mark: React.ReactNode; title: string; lede: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="oat-wrap">
      <div className="oat-intro">
        <span className="oat-mark">{mark}</span>
        <h1 className="oat-h1">{title}</h1>
        <p className="oat-lede">{lede}</p>
      </div>
      {children}
    </main>
  );
}

const Tick = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#2f6fb0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 9.5 3.2 3.2L14 5.8" />
  </svg>
);

function Status({ phase }: { phase: Phase }) {
  return phase.text ? (
    <p className="oat-status" data-tone={phase.tone} aria-live="polite">
      {phase.text}
    </p>
  ) : null;
}

/** The connected wallet: which kind it is, and its address in full. */
function WalletBox({ address, walletType, name, signedInWith, network }: { address: string; walletType: WalletType; name?: string; signedInWith?: string; network?: string }) {
  const [copied, setCopied] = useState(false);
  const kind = walletType === "embedded" ? "Privy wallet" : name ? `${name} · browser wallet` : "Browser wallet";
  const foot = signedInWith ? `Signed in with ${signedInWith}` : network ? `Network: ${network}` : walletType === "embedded" ? "Created by Privy for your login" : "Your own wallet";
  return (
    <div className="oat-wallet">
      <div className="oat-wallet-top">
        <span className="oat-label">Connected wallet</span>
        <span className="oat-badge" data-kind={walletType}>
          {kind}
        </span>
      </div>
      <p className="oat-addr">{address}</p>
      <div className="oat-wallet-foot">
        <span>{foot}</span>
        <button
          className="oat-copy"
          onClick={() => {
            void navigator.clipboard.writeText(address).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy address"}
        </button>
      </div>
    </div>
  );
}

const WalletMark = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1E3553" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17a2 2 0 0 1 2 2v1" />
    <rect x="4" y="8" width="16" height="11" rx="2.5" />
    <path d="M16 13.5h1.5" />
  </svg>
);
const CheckMark = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1F7A4A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
const ButtonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h2.5M10 5l3 3-3 3M13 8H6.5" />
  </svg>
);

/** The wallet that matches how the operator just signed in: a browser wallet for a wallet login, the Privy wallet otherwise. */
function pick(wallets: ConnectedWallet[], method: string | null): ConnectedWallet | undefined {
  if (method === "siwe") return wallets.find((w) => w.walletClientType !== "privy");
  return wallets.find((w) => w.walletClientType === "privy");
}

function Connect() {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [method, setMethod] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ text: "" });
  const [connected, setConnected] = useState<{ address: string; walletType: WalletType; name?: string } | null>(null);
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

  const prove = useCallback(async (wallet: ConnectedWallet, walletType: WalletType) => {
    try {
      setPhase({ text: walletType === "external" ? "Check your wallet and sign the sign-in message. It is free." : "Approve the sign-in message. It is free.", busy: true });
      const ch = await post("/challenge", { address: wallet.address });
      if (!ch.ok || typeof ch["message"] !== "string") throw new Error(ch.reason ?? "no sign-in message was issued");
      const provider = await wallet.getEthereumProvider();
      const signature = await provider.request({ method: "personal_sign", params: [ch["message"], wallet.address] });
      const r = await post("/result", { address: wallet.address, signature, walletType });
      if (!r.ok) throw new Error(r.reason ?? "the sign-in was refused");
      setConnected({ address: wallet.address, walletType, ...(walletType === "external" && wallet.meta?.name ? { name: wallet.meta.name } : {}) });
      setPhase({ text: "", done: true });
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

  if (connected) {
    return (
      <Page mark={<CheckMark />} title="Wallet connected" lede="You can close this tab and go back to your agent.">
        <WalletBox address={connected.address} walletType={connected.walletType} name={connected.name} signedInWith={connected.walletType === "embedded" ? methodName(method) : undefined} />
        <p className="oat-fine">Each deposit or withdrawal will open a page like this one for you to confirm.</p>
      </Page>
    );
  }

  return (
    <Page mark={<WalletMark />} title="Connect wallet" lede="Open Agent Treasury would like to connect to your wallet.">
      <section className="oat-panel" aria-labelledby="used-to">
        <h2 className="oat-label" id="used-to">
          Your wallet will be used to
        </h2>
        <ul className="oat-points">
          <li>
            <Tick />
            Show your agent your address and balance
          </li>
          <li>
            <Tick />
            Deposit into Tempora vaults, once you confirm
          </li>
          <li>
            <Tick />
            Withdraw back to this wallet, once you confirm
          </li>
        </ul>
      </section>
      {!phase.done && (
        <button className="oat-btn" disabled={!ready || phase.busy} onClick={() => login()}>
          <ButtonIcon />
          Connect
        </button>
      )}
      <Status phase={phase} />
      <p className="oat-fine">Connecting is free. Sign in through Privy with a browser wallet, email, Google, Apple or X.</p>
    </Page>
  );
}

function Confirm({ info }: { info: Extract<Info, { mode: "confirm" }> }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { login } = useLogin();
  const [next, setNext] = useState(info.next);
  const [phase, setPhase] = useState<Phase>({ text: "" });
  const wallet = wallets.find((w) => w.address.toLowerCase() === info.account.toLowerCase());
  const call = info.calls[next];
  const shown = call ?? info.calls[info.calls.length - 1]!;

  const send = useCallback(async () => {
    if (!wallet || !call) return;
    let hash: string | undefined;
    try {
      setPhase({ text: "Check your wallet and confirm.", busy: true });
      await wallet.switchChain(info.chainId);
      const provider = await wallet.getEthereumProvider();
      const tx = { from: wallet.address, to: call.to, data: call.data, value: call.value };
      // Gas: the estimate × 1.5. A Morpho Vault V2 call can run out of gas on an unbuffered estimate.
      const est = BigInt((await provider.request({ method: "eth_estimateGas", params: [tx] })) as string);
      // The page may have sat open past the flow's time limit; ask before the wallet is asked, and
      // leave a minute for the wallet's own prompt.
      const live = (await fetch(`/info?s=${secret}`).then((r) => (r.ok ? r.json() : undefined), () => undefined)) as { msLeft?: number } | undefined;
      if (!live) throw new Error("this page has expired; run the command again");
      if ((live.msLeft ?? 0) < 60_000) throw new Error("less than a minute is left on this page; run the command again");
      hash = (await provider.request({ method: "eth_sendTransaction", params: [{ ...tx, gas: `0x${((est * 3n) / 2n).toString(16)}` }] })) as string;
      setPhase({ text: "Sent. Waiting for it to land.", busy: true });
      const r = await post("/result", { index: next, hash });
      if (!r.ok) throw new Error(r.reason ?? "refused");
      const verdict = (r["verdict"] ?? {}) as { verified?: string; detail?: string };
      if (r["stop"]) return setPhase({ text: `Stopped: ${verdict.detail ?? String(r["reason"] ?? "the step did not land as confirmed")}`, tone: "bad", done: true });
      if (r["finished"]) {
        setNext(info.calls.length);
        return setPhase({ text: verdict.verified === "extra_transfer" ? `Done, with a note: ${verdict.detail}` : "Done. You can close this tab and go back to your agent.", tone: "ok", done: true });
      }
      setNext(Number(r["next"]));
      setPhase({ text: "Confirmed on chain. Review the next step." });
    } catch (e) {
      const text = errText(e);
      // Once the wallet has returned a hash the transaction is out, whatever failed afterwards.
      if (hash) {
        setPhase({ text: `Sent, but not confirmed here: ${hash}. Look it up before trying again. (${text})`, tone: "bad", done: true });
        return void (await reject(text, { hash, index: next }));
      }
      setPhase({ text: `Not sent: ${text}`, tone: "bad", done: true });
      await reject(text);
    }
  }, [wallet, call, info.chainId, info.calls.length, next]);

  const cancel = async () => {
    setPhase({ text: "Cancelled. Nothing more will be sent.", tone: "bad", done: true });
    await reject("cancelled by the operator on the confirm page");
  };

  return (
    <Page mark={phase.tone === "ok" ? <CheckMark /> : <WalletMark />} title={actionName(shown)} lede={actionLede(shown)}>
      {info.calls.length > 1 && (
        <ol className="oat-steps">
          {info.calls.map((c, i) => (
            <li key={c.step} data-state={i < next ? "done" : i === next ? "current" : "upcoming"}>
              <span className="oat-step-mark" aria-hidden="true">
                {i < next ? "✓" : c.step}
              </span>
              <span>{actionName(c)}</span>
            </li>
          ))}
        </ol>
      )}
      <WalletBox address={info.account} walletType={info.walletType} network={info.chainName} />
      <section className="oat-panel">
        <p className="oat-what">{shown.description}</p>
        <dl className="oat-dl">
          <dt>Vault</dt>
          <dd>
            {shown.vault.name} ({shown.vault.symbol})
          </dd>
          <dt>Vault address</dt>
          <dd>
            <a className="oat-mono" href={shown.vault.links.explorer} target="_blank" rel="noreferrer">
              {shown.vault.address}
            </a>
          </dd>
          <dt>Contract called</dt>
          <dd className="oat-mono">{shown.to}</dd>
          <dt>Network</dt>
          <dd>
            {info.chainName} (chain {info.chainId})
          </dd>
        </dl>
      </section>
      {!phase.done &&
        (!ready ? (
          <>
            <p className="oat-status">Loading.</p>
            <button className="oat-text" onClick={() => void cancel()}>
              Cancel
            </button>
          </>
        ) : !authenticated || !wallet ? (
          <>
            <button className="oat-btn" onClick={() => void (authenticated ? logout().then(() => login(), (e: unknown) => setPhase({ text: `Could not sign out: ${errText(e)}`, tone: "bad" })) : login())}>
              <ButtonIcon />
              {authenticated ? "Sign out and sign in again" : "Sign in with Privy"}
            </button>
            <p className="oat-fine">
              {authenticated
                ? `The connected wallet ${info.account} is not available here. Unlock it or select it in your wallet, or sign out and sign in with it.`
                : `Sign in again with the connected wallet (${info.walletType === "embedded" ? "the same email or social login" : "the same browser wallet"}) to continue.`}
            </p>
            <button className="oat-text" onClick={() => void cancel()}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="oat-btn" disabled={phase.busy} onClick={() => void send()}>
              Confirm in wallet
            </button>
            <button className="oat-text" disabled={phase.busy} onClick={() => void cancel()}>
              Cancel
            </button>
          </>
        ))}
      <Status phase={phase} />
    </Page>
  );
}

function App({ info }: { info: Info }) {
  return info.mode === "connect" ? <Connect /> : <Confirm info={info} />;
}

async function main() {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = createRoot(document.getElementById("root")!);
  const res = await fetch(`/info?s=${encodeURIComponent(secret)}`).catch(() => undefined);
  if (!res?.ok) {
    return root.render(
      <Page mark={<WalletMark />} title="This page has expired" lede="Run the command again from your agent to get a new one.">
        {null}
      </Page>,
    );
  }
  const info = (await res.json()) as Info;
  root.render(
    <PrivyProvider
      appId={info.appId}
      config={{
        appearance: { theme: "light", accentColor: "#1E3553", landingHeader: "Connect wallet", walletChainType: "ethereum-only", walletList: ["detected_ethereum_wallets", "metamask", "coinbase_wallet"] },
        // One window: Google, email, X, Apple, and "Continue with a wallet", which lists only the
        // wallets already installed in this browser (no WalletConnect).
        loginMethods: ["google", "email", "twitter", "apple", "wallet"],
        externalWallets: { walletConnect: { enabled: false } },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: true },
        supportedChains: [base, arbitrum, robinhood],
        defaultChain: base,
      }}
    >
      <App info={info} />
    </PrivyProvider>,
  );
}

void main();

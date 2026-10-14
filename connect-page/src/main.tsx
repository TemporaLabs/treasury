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
import {
  defaultSolanaRpcsPlugin,
  toSolanaWalletConnectors,
  useSignAndSendTransaction,
  useSignMessage as useSolanaSignMessage,
  useWallets as useSolanaWallets,
  type ConnectedStandardSolanaWallet,
} from "@privy-io/react-auth/solana";
import { arbitrum, base, mainnet, monad, robinhood } from "viem/chains";
import { CSS } from "./styles";
import { secret, type WalletType, post, reject, errText, type Phase, rejected, fmt, Page, Status, WalletMark, CheckMark, ButtonIcon } from "./shared";
import { Plan, type PlanInfo } from "./plan";


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
type SolanaConfirm = {
  mode: "confirm";
  chain: "solana";
  appId: string;
  account: string;
  walletType: WalletType;
  chainName: string;
  kind: "deposit" | "withdraw";
  description: string;
  next: number;
  txBase: string;
  asset: { symbol: string; decimals: number };
  nativeSymbol: string;
  balances?: { asset: string; native?: string };
  needs?: string;
  vault: { symbol: string; name: string; address: string; asset: string; links: { explorer: string } };
};
type Info =
  | { mode: "connect"; appId: string; chain?: "solana" }
  | SolanaConfirm
  | {
      mode: "confirm";
      appId: string;
      account: string;
      walletType: WalletType;
      chainId: number;
      chainName: string;
      next: number;
      calls: Call[];
      /** Prefix of a transaction's explorer page; the hash goes on the end. */
      txBase: string;
      asset: { symbol: string; decimals: number };
      nativeSymbol: string;
      /** Raw units, read when the page opened; absent when the read failed. */
      balances?: { asset: string; native?: string };
      /** Raw units of the asset the deposit pulls; absent for a withdrawal. */
      needs?: string;
      chain?: undefined;
    };





const actionName = (c: Call) =>
  c.kind === "approve" ? `Approve ${c.vault.asset}` : c.kind === "deposit" ? `Deposit ${c.vault.asset}` : c.kind === "withdraw" ? `Withdraw ${c.vault.asset}` : `Redeem ${c.vault.symbol} shares`;

const actionLede = (c: Call) =>
  c.kind === "approve"
    ? `Allow the vault to take this deposit from your wallet. It covers this amount only.`
    : c.kind === "deposit"
      ? `Move your ${c.vault.asset} into the vault. Your wallet receives vault shares in return.`
      : `Take ${c.vault.asset} out of the vault, back to your wallet.`;

/** How a Privy login method reads to a person; a wallet login has no "signed in with". */
const methodName = (m: string | null): string | undefined =>
  ({ email: "email", google: "Google", apple: "Apple", twitter: "X" } as Record<string, string>)[m ?? ""];


const Tick = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#2f6fb0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 9.5 3.2 3.2L14 5.8" />
  </svg>
);


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
      // The server keeps the flow open after a refused proof, so the operator can sign in again,
      // with the same account or another one, or cancel.
      setPhase({ text: `Not connected: ${rejected(e) ? "the sign-in message was declined in the wallet" : errText(e)}.`, tone: "bad", retry: true });
    }
  }, []);

  // Sign out, then open Privy's window once the sign-out has reached Privy's own state: calling
  // login() while it still reads as signed in does nothing.
  const [relogin, setRelogin] = useState(false);
  const again = useCallback(async () => {
    setPhase({ text: "", busy: true });
    started.current = false;
    setMethod(null);
    setRelogin(true);
    try {
      await logout();
    } catch {
      // a session that will not end is replaced by the next login anyway
    }
  }, [logout]);
  useEffect(() => {
    if (!relogin || !ready || authenticated) return;
    setRelogin(false);
    setPhase({ text: "" });
    login();
  }, [relogin, ready, authenticated, login]);

  const giveUp = async () => {
    setPhase({ text: "Cancelled. No wallet was connected.", tone: "bad", done: true });
    await reject("cancelled by the operator on the sign-in page");
  };

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
            Deposit into Tempora Labs vaults, once you confirm
          </li>
          <li>
            <Tick />
            Withdraw back to this wallet, once you confirm
          </li>
        </ul>
      </section>
      {phase.retry ? (
        <>
          <button className="oat-btn" onClick={() => void again()}>
            <ButtonIcon />
            Sign in again
          </button>
          <button className="oat-text" onClick={() => void giveUp()}>
            Cancel
          </button>
        </>
      ) : (
        !phase.done && (
          <button className="oat-btn" disabled={!ready || phase.busy} onClick={() => login()}>
            <ButtonIcon />
            Connect
          </button>
        )
      )}
      <Status phase={phase} />
      <p className="oat-fine">Connecting is free. Sign in through Privy with a browser wallet, email, Google, Apple or X.</p>
    </Page>
  );
}

function Confirm({ info }: { info: Extract<Info, { mode: "confirm"; chain?: undefined }> }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { login } = useLogin();
  const [next, setNext] = useState(info.next);
  const [phase, setPhase] = useState<Phase>({ text: "" });
  const wallet = wallets.find((w) => w.address.toLowerCase() === info.account.toLowerCase());
  const call = info.calls[next];
  const shown = call ?? info.calls[info.calls.length - 1]!;
  const [sent, setSent] = useState<{ step: number; hash: string }[]>([]);

  // What the wallet held when the page opened, and what that means for the steps still to go.
  const held = info.balances ? BigInt(info.balances.asset) : undefined;
  const amount = (raw: string | bigint) => `${fmt(raw, info.asset.decimals)} ${info.asset.symbol}`;
  const depositAhead = info.needs !== undefined && info.calls.slice(next).some((c) => c.kind === "deposit");
  const shortfall =
    held === undefined
      ? undefined
      : depositAhead && held < BigInt(info.needs!)
        ? held === 0n && info.balances?.native === "0" && info.walletType === "embedded"
          ? `This is a new wallet with nothing in it yet: send ${amount(info.needs!)} and a little ${info.nativeSymbol} on ${info.chainName} to ${info.account} first.`
          : `The deposit needs ${amount(info.needs!)}; this wallet holds ${amount(held)} on ${info.chainName}. Add ${info.asset.symbol} to it first.`
        : info.balances?.native === "0"
          ? `This wallet has no ${info.nativeSymbol} on ${info.chainName} for the network fee. Add a little first, unless your wallet pays fees another way.`
          : undefined;

  const send = useCallback(async () => {
    if (!wallet || !call) return;
    let hash: string | undefined;
    // How far it got decides what an error means: before "send" nothing can have gone out.
    let stage: "prepare" | "estimate" | "send" = "prepare";
    try {
      setPhase({ text: "Check your wallet and confirm.", busy: true });
      await wallet.switchChain(info.chainId);
      const provider = await wallet.getEthereumProvider();
      const tx = { from: wallet.address, to: call.to, data: call.data, value: call.value };
      // Gas: the estimate × 1.5. A Morpho Vault V2 call can run out of gas on an unbuffered estimate.
      stage = "estimate";
      const est = BigInt((await provider.request({ method: "eth_estimateGas", params: [tx] })) as string);
      stage = "prepare";
      // The page may have sat open past the flow's time limit; ask before the wallet is asked, and
      // leave a minute for the wallet's own prompt.
      const live = (await fetch(`/info?s=${secret}`).then((r) => (r.ok ? r.json() : undefined), () => undefined)) as { msLeft?: number; next?: number } | undefined;
      if (!live) throw new Error("this page has expired; run the command again");
      // Another tab of this page may have handled this step already: never send it twice. Only this
      // tab is stale, so it stops here without reporting a rejection, which would end the whole flow.
      if (live.next !== next) {
        return setPhase({ text: "This step was already handled, perhaps in another tab. Close this tab and use the other one.", tone: "bad", done: true });
      }
      if ((live.msLeft ?? 0) < 60_000) throw new Error("less than a minute is left on this page; run the command again");
      stage = "send";
      hash = (await provider.request({ method: "eth_sendTransaction", params: [{ ...tx, chainId: `0x${info.chainId.toString(16)}`, gas: `0x${((est * 3n) / 2n).toString(16)}` }] })) as string;
      const sentHash = hash;
      setSent((s) => [...s, { step: call.step, hash: sentHash }]);
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
        setPhase({ text: `Sent, but not confirmed here. Look it up before trying again. (${text})`, tone: "bad", done: true });
        return void (await reject(text, { hash, index: next }));
      }
      // A "no" in the wallet sends nothing: the page stays open to confirm again or cancel.
      if (rejected(e)) return setPhase({ text: "You declined it in your wallet. Nothing was sent. Confirm again, or cancel.", tone: "bad" });
      // The wallet could not prepare it, most often for want of funds: fix that and try again here.
      if (stage === "estimate") {
        return setPhase({ text: `Your wallet could not prepare this transaction: ${text}.${shortfall ? ` ${shortfall}` : ""} Fix that and confirm again, or cancel.`, tone: "bad" });
      }
      // The wallet was asked to send and failed without a hash: whether it went out is not known here.
      if (stage === "send") {
        setPhase({ text: `Your wallet returned an error without a transaction hash, so this page cannot tell whether it was sent: ${text}. Check your wallet's activity before running the command again.`, tone: "bad", done: true });
        return void (await reject(`the wallet returned an error without a transaction hash; it may or may not have been sent: ${text}`));
      }
      setPhase({ text: `Not sent: ${text}`, tone: "bad", done: true });
      await reject(text);
    }
  }, [wallet, call, info.chainId, info.calls.length, next, shortfall]);

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
      {held !== undefined && !phase.done && (
        <p className="oat-fine">
          When this page opened, this wallet held {amount(held)}
          {info.balances?.native !== undefined ? ` and ${fmt(info.balances.native, 18)} ${info.nativeSymbol}` : ""} on {info.chainName}.
        </p>
      )}
      {shortfall && !phase.done && (
        <p className="oat-status" data-tone="bad">
          {shortfall}
        </p>
      )}
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
      {sent.length > 0 && (
        <ul className="oat-fine oat-sent" aria-label="Transactions sent">
          {sent.map((t) => (
            <li key={t.hash}>
              {info.calls.length > 1 ? `Step ${t.step}: ` : "Transaction: "}
              <a className="oat-mono" href={`${info.txBase}${t.hash}`} target="_blank" rel="noreferrer">
                {t.hash}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}


/** Base58, as Solana writes signatures: the page needs only the encoder, so it carries one rather than a dependency. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const solanaKind = (w: ConnectedStandardSolanaWallet): WalletType => ((w.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet ? "embedded" : "external");

/**
 * Privy's Solana connectors, less WalletConnect. `toSolanaWalletConnectors()` always appends a WalletConnect
 * connector, and this page carries no WalletConnect code (`connect-page/build.mjs` stubs it out for its
 * licence), so that connector fails as soon as Privy initialises it — measured in a headless browser on
 * 2026-10-11. The Solana wallets installed in the browser (Phantom, Solflare, Backpack) and Privy's own
 * wallet are what this page offers, as on the EVM side.
 */
type SolanaConnectors = ReturnType<typeof toSolanaWalletConnectors>;
function solanaConnectorsWithoutWalletConnect(): SolanaConnectors {
  const base = toSolanaWalletConnectors({ shouldAutoConnect: false });
  const isWalletConnect = (c: unknown) => {
    const w = (c as { wallet?: { isWalletConnectSolana?: boolean } }).wallet;
    return Boolean(w && "isWalletConnectSolana" in w && w.isWalletConnectSolana);
  };
  const keep = <T,>(list: T[]) => list.filter((c) => !isWalletConnect(c));
  const b = base as unknown as { get: () => unknown[]; _setOnConnectorsUpdated: (cb: (l: unknown[]) => void) => void };
  return { ...base, get: () => keep(b.get()), _setOnConnectorsUpdated: (cb: (l: unknown[]) => void) => b._setOnConnectorsUpdated((l) => cb(keep(l))) } as unknown as SolanaConnectors;
}

/** The Solana sign-in: the same page, a Solana wallet, an ed25519 signature over the same kind of message. */
function ConnectSolana() {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useSolanaWallets();
  const { signMessage } = useSolanaSignMessage();
  const [phase, setPhase] = useState<Phase>({ text: "" });
  const [connected, setConnected] = useState<{ address: string; walletType: WalletType; name?: string } | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const cleared = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (!ready || cleared.current) return;
    cleared.current = true;
    if (authenticated) void logout();
  }, [ready, authenticated, logout]);

  const { login } = useLogin({
    onComplete: ({ wasAlreadyAuthenticated }) => {
      if (!wasAlreadyAuthenticated) setSignedIn(true);
    },
    onError: (code) => {
      if (String(code) !== "exited_auth_flow") setPhase({ text: `Sign-in failed: ${String(code)}`, tone: "bad" });
    },
  });

  const prove = useCallback(
    async (wallet: ConnectedStandardSolanaWallet) => {
      const walletType = solanaKind(wallet);
      try {
        setPhase({ text: walletType === "external" ? "Check your wallet and sign the sign-in message. It is free." : "Approve the sign-in message. It is free.", busy: true });
        const ch = await post("/challenge", { address: wallet.address });
        if (!ch.ok || typeof ch["message"] !== "string") throw new Error(ch.reason ?? "no sign-in message was issued");
        const { signature } = await signMessage({ message: new TextEncoder().encode(ch["message"]), wallet });
        const r = await post("/result", { address: wallet.address, signature: base64(signature), walletType });
        if (!r.ok) throw new Error(r.reason ?? "the sign-in was refused");
        setConnected({ address: wallet.address, walletType, ...(walletType === "external" ? { name: wallet.standardWallet.name } : {}) });
        setPhase({ text: "", done: true });
      } catch (e) {
        setPhase({ text: `Not connected: ${rejected(e) ? "the sign-in message was declined in the wallet" : errText(e)}.`, tone: "bad", retry: true });
      }
    },
    [signMessage],
  );

  useEffect(() => {
    if (!ready || !walletsReady || !authenticated || !signedIn || started.current) return;
    const wallet = wallets[0];
    if (!wallet) return;
    started.current = true;
    void prove(wallet);
  }, [ready, walletsReady, authenticated, signedIn, wallets, prove]);

  const giveUp = async () => {
    setPhase({ text: "Cancelled. No wallet was connected.", tone: "bad", done: true });
    await reject("cancelled by the operator on the sign-in page");
  };

  if (connected) {
    return (
      <Page mark={<CheckMark />} title="Solana wallet connected" lede="You can close this tab and go back to your agent.">
        <WalletBox address={connected.address} walletType={connected.walletType} name={connected.name} network="Solana" />
        <p className="oat-fine">Each deposit or withdrawal will open a page like this one for you to confirm.</p>
      </Page>
    );
  }
  return (
    <Page mark={<WalletMark />} title="Connect Solana wallet" lede="Open Agent Treasury would like to connect to your Solana wallet.">
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
            Deposit into Tempora Labs vaults on Solana, once you confirm
          </li>
          <li>
            <Tick />
            Withdraw back to this wallet, once you confirm
          </li>
        </ul>
      </section>
      {phase.retry ? (
        <>
          <button
            className="oat-btn"
            onClick={() => {
              started.current = false;
              setPhase({ text: "" });
              const w = wallets[0];
              if (w) void prove(w);
              else void logout().then(() => login());
            }}
          >
            <ButtonIcon />
            Sign in again
          </button>
          <button className="oat-text" onClick={() => void giveUp()}>
            Cancel
          </button>
        </>
      ) : (
        !phase.done && (
          <button className="oat-btn" disabled={!ready || phase.busy} onClick={() => login()}>
            <ButtonIcon />
            Connect
          </button>
        )
      )}
      <Status phase={phase} />
      <p className="oat-fine">Connecting is free. Sign in through Privy with a Solana wallet (Phantom, Solflare, Backpack), email, Google, Apple or X.</p>
    </Page>
  );
}

/**
 * The Solana confirm view: one transaction. It is fetched from the local process when the operator presses
 * Confirm — a Solana transaction lands only within about a minute of being built — and the wallet signs and
 * sends it. The process then reads the signature's status and the account's balances.
 */
function ConfirmSolana({ info }: { info: SolanaConfirm }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useSolanaWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { login } = useLogin();
  const [phase, setPhase] = useState<Phase>({ text: "" });
  const [sent, setSent] = useState<string | null>(null);
  const wallet = wallets.find((w) => w.address === info.account);
  const amount = (raw: string | bigint) => `${fmt(raw, info.asset.decimals)} ${info.asset.symbol}`;
  const held = info.balances ? BigInt(info.balances.asset) : undefined;
  const shortfall =
    held === undefined
      ? undefined
      : info.needs !== undefined && held < BigInt(info.needs)
        ? `The deposit needs ${amount(info.needs)}; this wallet holds ${amount(held)} on Solana. Add ${info.asset.symbol} to it first.`
        : info.balances?.native === "0"
          ? "This wallet has no SOL for the network fee. Add a little first."
          : undefined;

  const send = useCallback(async () => {
    if (!wallet) return;
    let signature: string | undefined;
    let stage: "prepare" | "send" = "prepare";
    try {
      setPhase({ text: "Preparing the transaction.", busy: true });
      const live = (await fetch(`/info?s=${secret}`).then((r) => (r.ok ? r.json() : undefined), () => undefined)) as { msLeft?: number; next?: number } | undefined;
      if (!live) throw new Error("this page has expired; run the command again");
      if (live.next !== 0) return setPhase({ text: "This transaction was already handled, perhaps in another tab. Close this tab.", tone: "bad", done: true });
      if ((live.msLeft ?? 0) < 60_000) throw new Error("less than a minute is left on this page; run the command again");
      const built = await post("/result", { build: true });
      if (!built.ok || typeof built["wire"] !== "string") throw new Error(built.reason ?? "the transaction could not be prepared");
      setPhase({ text: "Check your wallet and confirm.", busy: true });
      stage = "send";
      const out = await signAndSendTransaction({ transaction: fromBase64(built["wire"]), wallet, chain: "solana:mainnet" });
      signature = base58(out.signature);
      setSent(signature);
      setPhase({ text: "Sent. Waiting for it to land.", busy: true });
      const r = await post("/result", { hash: signature });
      if (!r.ok) throw new Error(r.reason ?? "refused");
      const verdict = (r["verdict"] ?? {}) as { verified?: string; detail?: string };
      if (r["stop"]) return setPhase({ text: `Stopped: ${verdict.detail ?? "the transaction did not land as confirmed"}`, tone: "bad", done: true });
      setPhase({ text: verdict.verified === "extra_transfer" ? `Done, with a note: ${verdict.detail}` : "Done. You can close this tab and go back to your agent.", tone: "ok", done: true });
    } catch (e) {
      const text = errText(e);
      if (signature) {
        setPhase({ text: `Sent, but not confirmed here. Look it up before trying again. (${text})`, tone: "bad", done: true });
        return void (await reject(text, { hash: signature, index: 0 }));
      }
      if (rejected(e)) return setPhase({ text: "You declined it in your wallet. Nothing was sent. Confirm again, or cancel.", tone: "bad" });
      if (stage === "send") {
        setPhase({ text: `Your wallet returned an error without a signature, so this page cannot tell whether it was sent: ${text}. Check your wallet's activity before running the command again.`, tone: "bad", done: true });
        return void (await reject(`the wallet returned an error without a signature; it may or may not have been sent: ${text}`));
      }
      // Nothing reached the wallet: the operator can fix what is wrong (funds, most often) and confirm again.
      setPhase({ text: `Not sent: ${text}.${shortfall ? ` ${shortfall}` : ""} Fix that and confirm again, or cancel.`, tone: "bad" });
    }
  }, [wallet, signAndSendTransaction, shortfall]);

  const cancel = async () => {
    setPhase({ text: "Cancelled. Nothing more will be sent.", tone: "bad", done: true });
    await reject("cancelled by the operator on the confirm page");
  };

  return (
    <Page mark={phase.tone === "ok" ? <CheckMark /> : <WalletMark />} title={info.kind === "deposit" ? `Deposit ${info.asset.symbol}` : `Withdraw ${info.asset.symbol}`} lede={info.kind === "deposit" ? `Move your ${info.asset.symbol} into the vault. Your wallet receives vault shares in return.` : `Take ${info.asset.symbol} out of the vault, back to your wallet.`}>
      <WalletBox address={info.account} walletType={info.walletType} network="Solana" />
      {held !== undefined && !phase.done && (
        <p className="oat-fine">
          When this page opened, this wallet held {amount(held)}
          {info.balances?.native !== undefined ? ` and ${fmt(info.balances.native, 9)} SOL` : ""} on Solana.
        </p>
      )}
      {shortfall && !phase.done && (
        <p className="oat-status" data-tone="bad">
          {shortfall}
        </p>
      )}
      <section className="oat-panel">
        <p className="oat-what">{info.description}</p>
        <dl className="oat-dl">
          <dt>Vault</dt>
          <dd>
            {info.vault.name} ({info.vault.symbol})
          </dd>
          <dt>Vault address</dt>
          <dd>
            <a className="oat-mono" href={info.vault.links.explorer} target="_blank" rel="noreferrer">
              {info.vault.address}
            </a>
          </dd>
          <dt>Network</dt>
          <dd>Solana (mainnet-beta)</dd>
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
                : `Sign in again with the connected wallet (${info.walletType === "embedded" ? "the same email or social login" : "the same Solana wallet"}) to continue.`}
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
      {sent && (
        <ul className="oat-fine oat-sent" aria-label="Transactions sent">
          <li>
            Transaction:{" "}
            <a className="oat-mono" href={`${info.txBase}${sent}`} target="_blank" rel="noreferrer">
              {sent}
            </a>
          </li>
        </ul>
      )}
    </Page>
  );
}

function App({ info }: { info: Info | PlanInfo }) {
  if (info.mode === "plan") return <Plan info={info} />;
  if (info.chain === "solana") return info.mode === "connect" ? <ConnectSolana /> : <ConfirmSolana info={info as SolanaConfirm} />;
  return info.mode === "connect" ? <Connect /> : <Confirm info={info as Extract<Info, { mode: "confirm"; chain?: undefined }>} />;
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
  const info = (await res.json()) as Info | PlanInfo;
  // A Solana flow gets Privy's Solana side: Solana wallets on the first screen, a Privy Solana wallet for an
  // email or social login, and Privy's own Solana RPC for that wallet to send through. An EVM flow is unchanged.
  if (info.mode !== "plan" && info.chain === "solana") {
    return root.render(
      <PrivyProvider
        appId={info.appId}
        config={{
          appearance: { theme: "light", accentColor: "#1E3553", landingHeader: "Connect Solana wallet", walletChainType: "solana-only", walletList: ["detected_solana_wallets", "phantom", "solflare", "backpack"] },
          loginMethodsAndOrder: { primary: ["detected_solana_wallets", "email", "google"], overflow: ["apple", "twitter", "phantom", "solflare", "backpack"] },
          externalWallets: { walletConnect: { enabled: false }, solana: { connectors: solanaConnectorsWithoutWalletConnect() } },
          embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, showWalletUIs: true },
          plugins: [defaultSolanaRpcsPlugin()],
        }}
      >
        <App info={info} />
      </PrivyProvider>,
    );
  }
  root.render(
    <PrivyProvider
      appId={info.appId}
      config={{
        appearance: { theme: "light", accentColor: "#1E3553", landingHeader: "Connect wallet", walletChainType: "ethereum-only", walletList: ["detected_ethereum_wallets", "metamask", "coinbase_wallet"] },
        // One window. Its first screen lists the wallets already installed in this browser (MetaMask,
        // Rabby, any EIP-6963 wallet), then email and Google, up to four entries in all: each installed
        // wallet takes one, so with three or more Google moves to "More options", and with four or
        // more email does too. Apple, X and Coinbase Wallet are always there. No WalletConnect.
        // `loginMethodsAndOrder` is marked deprecated in Privy 3.47 (pinned exactly); `loginMethods`
        // does not set an order, so check this screen again when upgrading Privy.
        loginMethodsAndOrder: { primary: ["detected_ethereum_wallets", "email", "google"], overflow: ["apple", "twitter", "coinbase_wallet"] },
        externalWallets: { walletConnect: { enabled: false } },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: true },
        supportedChains: [base, arbitrum, robinhood, mainnet, monad],
        defaultChain: base,
      }}
    >
      <App info={info} />
    </PrivyProvider>,
  );
}

void main();

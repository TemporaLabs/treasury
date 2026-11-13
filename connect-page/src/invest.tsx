/**
 * The invest page: the owner's own wallet signs or sends each step a `treasury invest` command puts here, one at a
 * time. The command decides the steps and checks each one before it reaches this page; this page shows the step as the
 * command described it and hands it to the wallet. It asks the command for the current step every two seconds.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import { ButtonIcon, CheckMark, errText, Page, post, reject, rejected, secret, Status, WalletMark, type Phase } from "./shared";

type View = { title: string; description: string; facts: { label: string; value: string }[]; warning?: string };
type Ask =
  | { kind: "sign_text"; message: string }
  | { kind: "sign_bytes"; bytes: string }
  | { kind: "sign_typed"; typedData: Record<string, unknown> }
  | { kind: "send"; to: string; data: string; value: "0" };
export type InvestInfo = {
  mode: "invest";
  appId: string;
  title: string;
  owner: string;
  chainId: number;
  chainName: string;
  step?: { index: number; view: View; ask: Ask };
  ending?: { ok: boolean; text: string };
};

const POLL_MS = 2_000;

export function Invest({ info: first }: { info: InvestInfo }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { login } = useLogin();
  const [info, setInfo] = useState<InvestInfo>(first);
  const [phase, setPhase] = useState<Phase>({ text: "" });
  const [handled, setHandled] = useState<number>(-1);
  const wallet = wallets.find((w) => w.address.toLowerCase() === info.owner.toLowerCase());
  const step = info.step && info.step.index > handled ? info.step : undefined;

  // The command puts the next step here when it is ready: ask for it until the page ends.
  useEffect(() => {
    if (phase.done) return;
    const t = setInterval(() => {
      void fetch(`/info?s=${secret}`)
        .then((r) => (r.ok ? (r.json() as Promise<InvestInfo>) : undefined))
        .then((v) => {
          if (!v) return setPhase((p) => (p.done ? p : { text: "This page has ended. Go back to your agent.", done: true }));
          setInfo(v);
          if (v.ending) setPhase({ text: v.ending.text, tone: v.ending.ok ? "ok" : "bad", done: true });
        }, () => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [phase.done]);

  const act = useCallback(async () => {
    if (!wallet || !step) return;
    const { ask, index } = step;
    let hash: string | undefined;
    try {
      setPhase({ text: "Check your wallet.", busy: true });
      const provider = await wallet.getEthereumProvider();
      let value: string;
      if (ask.kind === "sign_text") {
        value = (await provider.request({ method: "personal_sign", params: [ask.message, wallet.address] })) as string;
      } else if (ask.kind === "sign_bytes") {
        // Hex, so the wallet signs these exact bytes, never their text.
        value = (await provider.request({ method: "personal_sign", params: [ask.bytes, wallet.address] })) as string;
      } else if (ask.kind === "sign_typed") {
        value = (await provider.request({ method: "eth_signTypedData_v4", params: [wallet.address, JSON.stringify(ask.typedData)] })) as string;
      } else {
        await wallet.switchChain(info.chainId);
        const tx = { from: wallet.address, to: ask.to, data: ask.data, value: "0x0" };
        const est = BigInt((await provider.request({ method: "eth_estimateGas", params: [tx] })) as string);
        hash = (await provider.request({ method: "eth_sendTransaction", params: [{ ...tx, chainId: `0x${info.chainId.toString(16)}`, gas: `0x${((est * 3n) / 2n).toString(16)}` }] })) as string;
        value = hash;
      }
      const r = await post("/result", { index, value });
      if (!r.ok) throw new Error(r.reason ?? "refused");
      setHandled(index);
      setPhase({ text: ask.kind === "send" ? "Sent. Waiting for the next step." : "Signed. Waiting for the next step.", busy: true });
    } catch (e) {
      const text = errText(e);
      if (hash) {
        setPhase({ text: `Sent, but not recorded here. Look it up before trying again. (${text})`, tone: "bad", done: true });
        return void (await reject(text, { hash, index }));
      }
      if (rejected(e)) return setPhase({ text: "You declined it in your wallet. Nothing was signed or sent. Try again, or cancel.", tone: "bad" });
      setPhase({ text: `Not done: ${text}`, tone: "bad", done: true });
      await reject(text);
    }
  }, [wallet, step, info.chainId]);

  const cancel = async () => {
    setPhase({ text: "Cancelled. Nothing more will be signed or sent.", tone: "bad", done: true });
    await reject("cancelled by the owner on the invest page");
  };

  const shown = step?.view;
  return (
    <Page mark={phase.tone === "ok" ? <CheckMark /> : <WalletMark />} title={shown?.title ?? info.title} lede={shown?.description ?? "Waiting for the next step from your agent."}>
      <p className="oat-fine">
        Wallet: <span className="oat-mono">{info.owner}</span> on {info.chainName}
      </p>
      {shown && !phase.done && (
        <section className="oat-panel">
          <dl className="oat-dl">
            {shown.facts.map((f) => (
              <React.Fragment key={f.label}>
                <dt>{f.label}</dt>
                <dd className="oat-mono">{f.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </section>
      )}
      {shown?.warning && !phase.done && (
        <p className="oat-status" data-tone="bad">
          {shown.warning}
        </p>
      )}
      {!phase.done &&
        (!ready ? (
          <p className="oat-status">Loading.</p>
        ) : !authenticated || !wallet ? (
          <>
            <button className="oat-btn" onClick={() => void (authenticated ? logout().then(() => login(), () => undefined) : login())}>
              <ButtonIcon />
              {authenticated ? "Sign out and sign in again" : "Sign in with Privy"}
            </button>
            <p className="oat-fine">Sign in with the wallet {info.owner}. No other wallet can act on this page.</p>
            <button className="oat-text" onClick={() => void cancel()}>
              Cancel
            </button>
          </>
        ) : step ? (
          <>
            <button className="oat-btn" disabled={phase.busy} onClick={() => void act()}>
              {step.ask.kind === "send" ? "Send in wallet" : "Sign in wallet"}
            </button>
            <button className="oat-text" disabled={phase.busy} onClick={() => void cancel()}>
              Cancel
            </button>
          </>
        ) : (
          <button className="oat-text" onClick={() => void cancel()}>
            Cancel
          </button>
        ))}
      <Status phase={phase} />
    </Page>
  );
}

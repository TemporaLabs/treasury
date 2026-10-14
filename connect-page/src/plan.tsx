/**
 * A whole plan on one page (`connect plan --run`, #174). Every leg is a row: what it does, on which chain, where
 * the money goes, and how far it got. One button starts the plan; from then on the page walks the legs in order,
 * switching the wallet to each leg's chain, and the wallet asks for each transaction as it always does (a deposit:
 * approve, then deposit). The local process admits and checks every transaction exactly as for a single leg.
 *
 * What moves a leg: the wallet's own answer (a "no" sends nothing), or the process's verdict on a receipt. The page
 * never ends a leg while the wallet may still be asking. Between runs of the command (the shell's time limit) the
 * process is briefly away; the page waits, then carries on where it was.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import { secret, post, reject, errText, rejected, Page, WalletMark, CheckMark, ButtonIcon, type WalletType } from "./shared";

type PlanCall = { step: number; of: number; kind: "approve" | "deposit" | "withdraw" | "redeem"; description: string; to: `0x${string}`; data: `0x${string}`; value: string };
type LegView = {
  leg: number;
  action: "deposit" | "withdraw";
  amount: string;
  chainId: number;
  chainName: string;
  vault: { symbol: string; name: string; address: string; asset: string; assetAddress: string; links: { explorer: string } };
  receiver?: string;
  status: "pending" | "running" | "completed" | "stopped" | "not_reported";
  reason?: string;
  txs: { hash: string; verified: string }[];
  txBase: string;
};
export type PlanInfo = {
  mode: "plan";
  appId: string;
  account: string;
  walletType: WalletType;
  code: string;
  expiresAtIso: string;
  legMinMs: number;
  msLeft: number;
  legs: LegView[];
  current: null | { leg: number; next: number; chainId: number; calls: PlanCall[] };
};

/** What the operator sees for a leg. */
type LegState = "waiting" | "wallet" | "sent" | "confirmed" | "declined" | "maybe" | "failed" | "mismatch" | "stopped" | "notrun";
const LABEL: Record<LegState, string> = {
  waiting: "Waiting",
  wallet: "In your wallet",
  sent: "Sent · confirming",
  confirmed: "Confirmed",
  declined: "Declined · nothing sent",
  maybe: "May have been sent",
  failed: "Failed on chain",
  mismatch: "Didn't match",
  stopped: "Stopped",
  notrun: "Did not run",
};

/** A leg's state from the plan file, refined by what this page is doing with the current leg right now. */
function legState(l: LegView, local: { leg: number; phase: "wallet" | "sent" | "declined" } | null, planOver: boolean): LegState {
  if (local && local.leg === l.leg && l.status === "running") return local.phase;
  if (l.status === "completed") return "confirmed";
  if (l.status === "not_reported") return "maybe";
  if (l.status === "stopped") {
    const last = l.txs[l.txs.length - 1]?.verified;
    if (last === "reverted") return "failed";
    if (last === "mismatch") return "mismatch";
    if (/^declined|the operator stopped/.test(l.reason ?? "")) return "declined";
    return "stopped";
  }
  if (l.status === "running") return "sent";
  return planOver ? "notrun" : "waiting";
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const confirmations = (l: LegView) => (l.action === "deposit" ? "2 confirmations in your wallet: approve, then deposit" : "1 confirmation in your wallet");
const mmss = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

async function readInfo(): Promise<PlanInfo | "gone"> {
  try {
    const r = await fetch(`/info?s=${encodeURIComponent(secret)}`, { cache: "no-store" });
    if (!r.ok) return "gone";
    const v = (await r.json()) as PlanInfo;
    return v.mode === "plan" ? v : "gone";
  } catch {
    return "gone";
  }
}

export function Plan({ info: first }: { info: PlanInfo }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { login } = useLogin();
  const [info, setInfo] = useState<PlanInfo>(first);
  const [away, setAway] = useState(false);
  const [local, setLocal] = useState<{ leg: number; phase: "wallet" | "sent" | "declined" } | null>(null);
  const [note, setNote] = useState<{ text: string; tone?: "bad" | "ok" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [stopAfter, setStopAfter] = useState(false);
  const [deadlineAt] = useState(() => Date.parse(first.expiresAtIso));
  const [now, setNow] = useState(Date.now());
  const running = useRef(false);
  const stopAfterRef = useRef(false);
  stopAfterRef.current = stopAfter;
  const wallet = wallets.find((w) => w.address.toLowerCase() === info.account.toLowerCase());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    const v = await readInfo();
    if (v === "gone") return setAway(true), undefined;
    setAway(false);
    setInfo(v);
    return v;
  }, []);

  // While the process is away (between runs), check every few seconds and carry on when it is back.
  useEffect(() => {
    if (!away) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [away, refresh]);

  const legs = info.legs;
  const failedLeg = legs.find((l) => l.status === "stopped" || l.status === "not_reported");
  const allDone = legs.every((l) => l.status === "completed");
  const expired = now > deadlineAt && legs.some((l) => l.status === "pending") && !failedLeg;
  const planOver = Boolean(failedLeg) || allDone || expired;
  const nextLeg = legs.find((l) => l.status === "pending");
  const landed = legs.filter((l) => l.status === "completed").length;

  /** Sends one call of the current leg; resolves with the process's reply, or undefined once the plan stopped here. */
  const sendCall = useCallback(
    async (leg: LegView, call: PlanCall, index: number): Promise<Record<string, unknown> | undefined> => {
      if (!wallet) throw new Error("the connected wallet is not available on this page");
      let hash: string | undefined;
      let stage: "prepare" | "estimate" | "send" = "prepare";
      try {
        setLocal({ leg: leg.leg, phase: "wallet" });
        await wallet.switchChain(leg.chainId);
        const provider = await wallet.getEthereumProvider();
        const tx = { from: wallet.address, to: call.to, data: call.data, value: call.value };
        stage = "estimate";
        const est = BigInt((await provider.request({ method: "eth_estimateGas", params: [tx] })) as string);
        stage = "prepare";
        const live = await readInfo();
        if (live === "gone") throw new Error("the page lost its connection to your agent before this was sent; nothing was sent");
        if (live.current?.leg !== leg.leg || live.current.next !== index) {
          setNote({ text: "This step was already handled, perhaps in another tab. Close this tab and use the other one.", tone: "bad" });
          return undefined;
        }
        stage = "send";
        hash = (await provider.request({ method: "eth_sendTransaction", params: [{ ...tx, chainId: `0x${leg.chainId.toString(16)}`, gas: `0x${((est * 3n) / 2n).toString(16)}` }] })) as string;
        setLocal({ leg: leg.leg, phase: "sent" });
        const r = await post("/result", { index, hash });
        if (!r.ok) throw new Error(r.reason ?? "refused");
        return r;
      } catch (e) {
        const text = errText(e);
        if (hash) {
          // The wallet returned a hash: the transaction is out, whatever failed after.
          await reject(`sent, but the page could not finish checking it: ${text}`, { hash, index });
          throw Object.assign(new Error(`Step ${leg.leg} was sent but not confirmed here. Look it up before doing anything else.`), { ended: true });
        }
        if (rejected(e)) {
          setLocal({ leg: leg.leg, phase: "declined" });
          throw Object.assign(new Error("You declined it in your wallet. Nothing was sent."), { declined: true });
        }
        if (stage === "send") {
          await reject(`the wallet returned an error without a transaction hash; it may or may not have been sent: ${text}`);
          throw Object.assign(new Error(`Your wallet returned an error without a transaction hash, so this page cannot tell whether step ${leg.leg} was sent. Check your wallet's activity.`), { ended: true });
        }
        setLocal({ leg: leg.leg, phase: "declined" });
        throw Object.assign(new Error(`Your wallet could not prepare this transaction: ${text}. Nothing was sent.`), { declined: true });
      }
    },
    [wallet],
  );

  /** Runs legs from the next pending one until the plan is done, stopped, paused, or the operator said stop. */
  const go = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNote(null);
    try {
      for (;;) {
        let cur = await refresh();
        if (!cur) return;
        // Resume a leg this page already started (the wallet said no, then "ask again"); otherwise start the next.
        if (!cur.current) {
          const leg = cur.legs.find((l) => l.status === "pending");
          if (!leg) return;
          if (stopAfterRef.current) {
            await reject("the operator stopped the plan after the previous step");
            await refresh();
            return setNote({ text: "Stopped. Nothing else will be sent." });
          }
          const s = await post("/result", { start: leg.leg });
          if (!s.ok) return setNote({ text: s.reason ?? "This step could not start.", tone: "bad" });
          if (s["paused"]) return setAway(true);
          cur = await refresh();
          if (!cur?.current) return;
        }
        const leg = cur.legs.find((l) => l.leg === cur!.current!.leg)!;
        let r: Record<string, unknown> | undefined;
        for (let i = cur.current!.next; i < cur.current!.calls.length; i++) {
          r = await sendCall(leg, cur.current!.calls[i]!, i);
          if (!r || r["stop"]) break;
        }
        setLocal(null);
        await refresh();
        if (!r || r["stop"] || r["planDone"]) return;
        if (r["paused"]) return setAway(true);
      }
    } catch (e) {
      const err = e as Error & { declined?: boolean; ended?: boolean };
      setNote({ text: err.message, tone: "bad" });
      if (err.ended) {
        setLocal(null);
        await refresh();
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [refresh, sendCall]);

  const stopHere = async () => {
    await post("/result", { rejected: true, declined: true, reason: "declined in the wallet; the operator stopped the plan" }).catch(() => undefined);
    setLocal(null);
    setNote({ text: "Stopped. Nothing else will be sent." });
    await refresh();
  };

  const msLeft = Math.max(0, deadlineAt - now);
  const current = local ? legs.find((l) => l.leg === local.leg) : undefined;
  const title = allDone
    ? "Plan complete"
    : failedLeg
      ? "Plan stopped"
      : expired
        ? "Plan expired"
        : local?.phase === "wallet"
          ? `Step ${local.leg} of ${legs.length} is in your wallet`
          : local?.phase === "sent"
            ? `Step ${local.leg} of ${legs.length} is confirming`
            : "Confirm your plan";
  const lede = allDone ? (
    <>
      All {landed} steps landed and matched what you approved. You can close this page; your agent reports the transactions in the chat.
    </>
  ) : failedLeg ? (
    <>
      {failedLeg.status === "not_reported"
        ? `Step ${failedLeg.leg} may have been sent; check your wallet before doing anything else.`
        : `Step ${failedLeg.leg} ${legState(failedLeg, null, true) === "declined" ? "was declined, and nothing was sent for it" : "did not land as approved"}.`}{" "}
      {landed} of {legs.length} steps landed; the steps after it did not run, and nothing else will be sent.
    </>
  ) : expired ? (
    <>The plan expired. Steps that had not started did not run, and nothing else will be sent. For what is left, ask your agent for a new plan.</>
  ) : local?.phase === "wallet" && current ? (
    <>
      Your wallet is on <b>{current.chainName}</b>. Check the amount and that the money goes to your wallet, then confirm. To skip it, reject it in your wallet.
    </>
  ) : local?.phase === "sent" && current ? (
    <>Sent on {current.chainName}. Waiting for it to land before anything else is sent.</>
  ) : (
    <>
      <b>{legs.length}</b> step{legs.length === 1 ? "" : "s"} on <b>{new Set(legs.map((l) => l.chainId)).size}</b> chain{new Set(legs.map((l) => l.chainId)).size === 1 ? "" : "s"}. Nothing has been sent.
    </>
  );

  const signInNeeded = ready && (!authenticated || !wallet);

  return (
    <Page mark={allDone ? <CheckMark /> : <WalletMark />} title={title} lede={lede}>
      <div className="oat-plan-head">
        <span className="oat-plan-wallet">
          <span className="oat-dot" aria-hidden="true" />
          {info.walletType === "embedded" ? "Privy wallet" : "Your wallet"} <span className="oat-mono">{short(info.account)}</span>
        </span>
        {!planOver && <span className="oat-plan-timer">{msLeft < 10 * 60_000 ? `Plan expires in ${mmss(msLeft)}` : `expires in ${mmss(msLeft)}`}</span>}
      </div>
      {away && !planOver && (
        <p className="oat-status" aria-live="polite">
          Waiting for your agent to continue. This page carries on by itself; keep it open.
        </p>
      )}
      <ol className="oat-legs" aria-label="The steps in this plan">
        {legs.map((l) => {
          const st = legState(l, local, planOver);
          const lands = l.action === "deposit" ? "Shares go to" : "Funds go to";
          return (
            <li key={l.leg} className="oat-leg" data-state={st}>
              <div className="oat-leg-row">
                <span className="oat-leg-num" aria-hidden="true">
                  {l.leg}
                </span>
                <div className="oat-leg-what">
                  <p className="oat-leg-sentence">
                    {l.action === "deposit" ? "Deposit" : "Withdraw"} <b>{l.amount}</b> {l.action === "deposit" ? "into" : "from"} {l.vault.name} on {l.chainName}
                  </p>
                  <p className="oat-leg-meta">
                    <span className="oat-leg-status" data-state={st}>
                      {LABEL[st]}
                    </span>
                    <span>{confirmations(l)}</span>
                    <button type="button" className="oat-linkbtn" aria-expanded={Boolean(open[l.leg])} onClick={() => setOpen((o) => ({ ...o, [l.leg]: !o[l.leg] }))}>
                      {open[l.leg] ? "Hide" : "Show"} what you'll sign
                    </button>
                  </p>
                  {l.txs.map((t) => (
                    <p key={t.hash} className="oat-leg-tx">
                      <a className="oat-mono" href={`${l.txBase}${t.hash}`} target="_blank" rel="noreferrer">
                        {short(t.hash)}
                      </a>
                    </p>
                  ))}
                </div>
              </div>
              {open[l.leg] && (
                <dl className="oat-dl oat-leg-detail">
                  <dt>Vault contract</dt>
                  <dd className="oat-mono">{l.vault.address}</dd>
                  {l.action === "deposit" && (
                    <>
                      <dt>{l.vault.asset} token</dt>
                      <dd className="oat-mono">{l.vault.assetAddress}</dd>
                    </>
                  )}
                  <dt>Network</dt>
                  <dd>
                    {l.chainName} (chain {l.chainId})
                  </dd>
                  <dt>{lands}</dt>
                  <dd>
                    <span className="oat-mono">{l.receiver ?? info.account}</span>
                    <br />
                    {(l.receiver ?? info.account).toLowerCase() === info.account.toLowerCase() ? "✓ your connected wallet" : "NOT your connected wallet: do not confirm"}
                  </dd>
                </dl>
              )}
            </li>
          );
        })}
      </ol>
      {!planOver && (
        <p className="oat-now">
          Every step runs in order; your wallet asks you to confirm each transaction. If a step fails or you reject it in your wallet, the steps after it do not run. The
          plan expires {new Date(deadlineAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; a step not started by then does not run. If you close this page,
          a step already in your wallet can still go through if you confirm it there, and no further steps start.
        </p>
      )}
      {note && (
        <p className="oat-status" data-tone={note.tone} aria-live="polite">
          {note.text}
        </p>
      )}
      {!planOver &&
        (!ready ? (
          <p className="oat-status">Loading.</p>
        ) : signInNeeded ? (
          <>
            <button className="oat-btn" onClick={() => void (authenticated ? logout().then(() => login()) : login())}>
              <ButtonIcon />
              Connect
            </button>
            <p className="oat-fine">Connect with the same wallet you signed in with before ({short(info.account)}).</p>
          </>
        ) : local?.phase === "declined" ? (
          <>
            <button className="oat-btn" disabled={busy} onClick={() => void go()}>
              Ask my wallet again
            </button>
            <button className="oat-text" disabled={busy} onClick={() => void stopHere()}>
              Stop the plan here
            </button>
          </>
        ) : (
          <>
            <button className="oat-btn" disabled={busy || away || !nextLeg} onClick={() => void go()}>
              {busy ? "Working through your plan…" : landed === 0 ? "Start" : `Continue with step ${nextLeg?.leg}`}
            </button>
            {busy && (
              <button className="oat-text" disabled={stopAfter} onClick={() => setStopAfter(true)}>
                {stopAfter ? "Stopping after this step" : "Stop after this step"}
              </button>
            )}
          </>
        ))}
      <p className="oat-fine">Each transaction is checked against what you approved before your wallet sees it, and checked again from its receipt once it lands. This page never holds your keys.</p>
    </Page>
  );
}

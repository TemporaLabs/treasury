/**
 * A whole plan on one page (`connect plan --run`, #174, #184). Every leg is a row: what it does, on which chain, where
 * the money goes, and how far it got. One button starts the plan; from then on the page walks the legs in order,
 * switching the wallet to each EVM leg's chain, and the wallet asks for each transaction as it always does (a deposit:
 * approve, then deposit; a Solana leg: one transaction, built when its turn comes). The local process admits and
 * checks every transaction exactly as for a single leg.
 *
 * A Solana leg uses the wallet the operator signed in with, never another: on a plan that also has EVM legs, the
 * Solana account of that same wallet (the Wallet Standard wallet of the same name, or the Privy login's own Solana
 * wallet), connected and checked against the connected Solana account when the plan starts, before any leg runs. A
 * wallet that cannot, ends the plan there with nothing sent.
 *
 * What moves a leg: the wallet's own answer (a "no" sends nothing), or the process's verdict on a receipt. The page
 * never ends a leg while the wallet may still be asking. Between runs of the command (the shell's time limit) the
 * process is briefly away; the page waits, then carries on where it was.
 *
 * A leg this tab did not drive (a reload, or another tab) is never resumed: the wallet may already have been asked for
 * its next call, and the page stores nothing in the browser that could say otherwise, so it offers only to end the
 * plan there, on record as "may have been sent".
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import { useSignAndSendTransaction, useStandardWallets, useWallets as useSolanaWallets, type ConnectedStandardSolanaWallet, type SolanaStandardWallet } from "@privy-io/react-auth/solana";
import { secret, post, reject, errText, rejected, base58, fromBase64, Page, WalletMark, CheckMark, ButtonIcon, type WalletType } from "./shared";

type PlanCall = { step: number; of: number; kind: "approve" | "deposit" | "withdraw" | "redeem"; description: string; to: `0x${string}`; data: `0x${string}`; value: string };
type LegView = {
  leg: number;
  action: "deposit" | "withdraw";
  amount: string;
  family: "evm" | "solana";
  /** `null` for a Solana leg, which has no chain id. */
  chainId: number | null;
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
  /** The connected EVM account, when the plan has an EVM leg. */
  account?: string;
  walletType?: WalletType;
  /** The connected Solana account, when the plan has a Solana leg. */
  solanaAccount?: string;
  solanaWalletType?: WalletType;
  code: string;
  expiresAtIso: string;
  legMinMs: number;
  msLeft: number;
  legs: LegView[];
  current: null | { leg: number; next: number; chain?: undefined; chainId: number; calls: PlanCall[] } | { leg: number; next: number; chain: "solana" };
};

/** What a plan with a Solana leg adds to the page: the Solana account, connected and checked, and its wallet's prompt. */
type SolanaSide = {
  /** A Solana-only plan: the Privy login's wallet for the connected Solana account is on this page. */
  signedIn: boolean;
  /** Connects the Solana account the Solana legs pay, if it is not yet, and checks it; says why not when it cannot. */
  ensure: () => Promise<string | undefined>;
  /** Asks the wallet to sign and send one transaction; resolves with its base58 signature. */
  send: (wire: string) => Promise<string>;
};

/** What the operator sees for a leg. */
type LegState = "waiting" | "wallet" | "sent" | "confirmed" | "declined" | "unprepared" | "partial" | "maybe" | "failed" | "mismatch" | "stopped" | "notrun";
/** This tab's own phase of the running leg. "declined" and "unprepared" have nothing outstanding in the wallet. */
type Phase = "wallet" | "sent" | "declined" | "unprepared";
const LABEL: Record<LegState, string> = {
  waiting: "Waiting",
  wallet: "In your wallet",
  sent: "Sent · confirming",
  confirmed: "Confirmed",
  declined: "Declined · nothing sent",
  unprepared: "Couldn't prepare · nothing sent",
  partial: "Approved · deposit not sent",
  maybe: "May have been sent",
  failed: "Failed on chain",
  mismatch: "Didn't match",
  stopped: "Stopped",
  notrun: "Did not run",
};

/** A leg's state from the plan file, refined by what this page is doing with the current leg right now. */
function legState(l: LegView, local: { leg: number; phase: Phase } | null, planOver: boolean): LegState {
  if (local && local.leg === l.leg && l.status === "running") return local.phase;
  if (l.status === "completed") return "confirmed";
  if (l.status === "not_reported") return "maybe";
  if (l.status === "stopped") {
    const last = l.txs[l.txs.length - 1]?.verified;
    if (last === "reverted") return "failed";
    if (last === "mismatch") return "mismatch";
    // A receipt that was never read: that transaction may have gone out.
    if (last === "unverified") return "maybe";
    // A deposit stopped after its approval landed (the deposit was declined, or never asked for): the approval was
    // sent, so never "nothing sent".
    if (l.action === "deposit" && (last === "matched" || last === "extra_transfer")) return "partial";
    if (/^not prepared/.test(l.reason ?? "")) return "unprepared";
    if (/^declined|the operator stopped/.test(l.reason ?? "")) return "declined";
    return "stopped";
  }
  if (l.status === "running") return "sent";
  return planOver ? "notrun" : "waiting";
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isSolana = (l: LegView) => l.family === "solana";
const confirmations = (l: LegView) => (l.action === "deposit" && !isSolana(l) ? "2 confirmations in your wallet: approve, then deposit" : "1 confirmation in your wallet");
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

/** A plan of EVM legs only renders exactly as before; one with a Solana leg also carries the Solana side. */
export function Plan({ info }: { info: PlanInfo }) {
  return info.legs.some(isSolana) ? <PlanWithSolana info={info} /> : <PlanPage info={info} />;
}

/**
 * The Solana side, on a plan with a Solana leg. A plan of only Solana legs signs in as a single Solana confirmation does,
 * and uses the login's wallet for the connected Solana account. A plan that also has EVM legs signs in with the EVM
 * wallet, and uses that same wallet's Solana account: the Wallet Standard wallet whose name is the EVM wallet's, or the
 * Privy login's own Solana wallet. The name only picks which wallet to ask; the account it gives must be the connected
 * Solana account. There is no fallback to any other wallet.
 */
function PlanWithSolana({ info }: { info: PlanInfo }) {
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { wallets: standard } = useStandardWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const target = useRef<{ kind: "privy"; wallet: ConnectedStandardSolanaWallet } | { kind: "standard"; wallet: SolanaStandardWallet; account: SolanaStandardWallet["accounts"][number] } | null>(null);
  const expected = info.solanaAccount ?? "";
  const privyWallet = solanaWallets.find((w) => w.address === expected);
  const evmLegs = info.legs.some((l) => !isSolana(l));

  const ensure = useCallback(async (): Promise<string | undefined> => {
    if (privyWallet) {
      target.current = { kind: "privy", wallet: privyWallet };
      return undefined;
    }
    if (target.current?.kind === "standard") return undefined;
    if (!evmLegs) return `the connected Solana wallet ${short(expected)} is not available on this page`;
    const evm = wallets.find((w) => w.address.toLowerCase() === (info.account ?? "").toLowerCase());
    if (!evm) return "the connected wallet is not available on this page";
    if (info.walletType === "embedded") return `your Privy login has no Solana wallet ${short(expected)} on this page`;
    const name = evm.meta?.name;
    const std = name ? standard.find((w) => w.name === name && w.features["solana:signAndSendTransaction"]) : undefined;
    if (!name || !std) return `${name ?? "The wallet you signed in with"} shows no Solana account on this page, and the plan's Solana legs need its Solana account ${short(expected)}`;
    let accounts = std.accounts;
    if (!accounts.some((a) => a.address === expected)) {
      try {
        const connect = std.features["standard:connect"];
        if (!connect) return `${name} cannot connect a Solana account on this page`;
        accounts = (await connect.connect()).accounts;
      } catch (e) {
        return rejected(e) ? `connecting ${name}'s Solana account was declined in the wallet` : `${name} could not connect its Solana account: ${errText(e)}`;
      }
    }
    const account = accounts.find((a) => a.address === expected);
    if (!account) {
      const got = accounts[0]?.address;
      return `${name}'s Solana account${got ? ` ${short(got)}` : ""} is not the connected Solana account ${short(expected)}`;
    }
    target.current = { kind: "standard", wallet: std, account };
    return undefined;
  }, [privyWallet, evmLegs, expected, wallets, info.account, info.walletType, standard]);

  const send = useCallback(
    async (wire: string): Promise<string> => {
      const t = target.current;
      if (!t) throw new Error("the Solana wallet is not connected on this page");
      const transaction = fromBase64(wire);
      if (t.kind === "privy") return base58((await signAndSendTransaction({ transaction, wallet: t.wallet, chain: "solana:mainnet" })).signature);
      const feature = t.wallet.features["solana:signAndSendTransaction"];
      if (!feature) throw new Error(`${t.wallet.name} cannot send a Solana transaction`);
      const [out] = await feature.signAndSendTransaction({ account: t.account, transaction, chain: "solana:mainnet" });
      if (!out) throw new Error(`${t.wallet.name} returned no signature`);
      return base58(out.signature);
    },
    [signAndSendTransaction],
  );

  return <PlanPage info={info} solana={{ signedIn: Boolean(privyWallet), ensure, send }} />;
}

function PlanPage({ info: first, solana }: { info: PlanInfo; solana?: SolanaSide }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { login } = useLogin();
  const [info, setInfo] = useState<PlanInfo>(first);
  const [away, setAway] = useState(false);
  const [awayPolls, setAwayPolls] = useState(0);
  const [local, setLocal] = useState<{ leg: number; phase: Phase } | null>(null);
  const [note, setNote] = useState<{ text: string; tone?: "bad" | "ok" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [stopAfter, setStopAfter] = useState(false);
  const [deadlineAt] = useState(() => Date.parse(first.expiresAtIso));
  const [now, setNow] = useState(Date.now());
  const running = useRef(false);
  const whyRef = useRef<string | undefined>(undefined);
  // Too little of the run was left to ask the wallet: asking again cannot help before the run ends, so only Stop is offered.
  const lateRef = useRef(false);
  // The leg this tab is driving: the only running leg it may ask the wallet about.
  const owned = useRef<number | null>(null);
  // This tab was walking the plan when the process went away between runs: carry on when it is back.
  const resumeOnReturn = useRef(false);
  const againRef = useRef<HTMLButtonElement>(null);
  const stopAfterRef = useRef(false);
  stopAfterRef.current = stopAfter;
  const evmLegs = first.legs.some((l) => !isSolana(l));
  const wallet = wallets.find((w) => w.address.toLowerCase() === (info.account ?? "").toLowerCase());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    const v = await readInfo();
    if (v === "gone") return setAway(true), undefined;
    setAway(false);
    setAwayPolls(0);
    setInfo(v);
    return v;
  }, []);

  // While the process is away (between runs), check every few seconds.
  useEffect(() => {
    if (!away) return;
    const t = setInterval(() => {
      setAwayPolls((n) => n + 1);
      void refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [away, refresh]);

  const legs = info.legs;
  const failedLeg = legs.find((l) => l.status === "stopped" || l.status === "not_reported");
  const allDone = legs.every((l) => l.status === "completed");
  const runningLeg = legs.find((l) => l.status === "running");
  // Never "expired" while a leg is still running: a step may be in the wallet, and the process decides that leg.
  const expired = now > deadlineAt && legs.some((l) => l.status === "pending") && !failedLeg && !runningLeg && !local;
  // A running leg this tab is not driving (a reload or another tab): it may have been sent, and is never resumed here.
  const orphan = runningLeg && owned.current !== runningLeg.leg && !running.current ? runningLeg : undefined;
  const planOver = Boolean(failedLeg) || allDone || expired;
  const nextLeg = legs.find((l) => l.status === "pending");
  const landed = legs.filter((l) => l.status === "completed").length;

  /** What a failure to send means, and what the page does next: shared by an EVM call and a Solana transaction. */
  const failed = useCallback(async (leg: LegView, e: unknown, stage: "prepare" | "estimate" | "send", hash: string | undefined, index: number): Promise<never> => {
    const text = errText(e);
    if (hash) {
      // The wallet returned a hash: the transaction is out, whatever failed after.
      await reject(`sent, but the page could not finish checking it: ${text}`, { hash, index });
      throw Object.assign(new Error(`Step ${leg.leg} was sent but not confirmed here. Look it up before doing anything else.`), { ended: true });
    }
    if (rejected(e)) {
      setLocal({ leg: leg.leg, phase: "declined" });
      throw Object.assign(new Error("You declined it in your wallet. Nothing was sent."), { idle: true });
    }
    if (stage === "send") {
      await reject(`the wallet returned an error without a transaction hash; it may or may not have been sent: ${text}`);
      throw Object.assign(new Error(`Your wallet returned an error without a transaction hash, so this page cannot tell whether step ${leg.leg} was sent. Check your wallet's activity.`), { ended: true });
    }
    // Before the wallet was asked: nothing was sent.
    if ((e as { late?: boolean }).late) {
      lateRef.current = true;
      setLocal({ leg: leg.leg, phase: "unprepared" });
      throw Object.assign(
        new Error(`Less than a minute is left before your agent's run pauses, too little to confirm step ${leg.leg} in your wallet. Nothing more was sent. Stop the plan here; your agent reports what landed and can make a new plan for the rest.`),
        { idle: true, why: text },
      );
    }
    setLocal({ leg: leg.leg, phase: "unprepared" });
    throw Object.assign(new Error(`This page could not prepare step ${leg.leg}: ${text}. Nothing was sent.`), { idle: true, why: text });
  }, []);

  /** Sends one call of the current leg; resolves with the process's reply, or undefined once the plan stopped here. */
  const sendCall = useCallback(
    async (leg: LegView, call: PlanCall, index: number, chainId: number): Promise<Record<string, unknown> | undefined> => {
      if (!wallet) throw new Error("the connected wallet is not available on this page");
      let hash: string | undefined;
      let stage: "prepare" | "estimate" | "send" = "prepare";
      try {
        setLocal({ leg: leg.leg, phase: "wallet" });
        if (chainId !== leg.chainId) throw new Error(`this step's calls are for chain ${chainId}, not ${leg.chainName}`);
        await wallet.switchChain(leg.chainId);
        const provider = await wallet.getEthereumProvider();
        const tx = { from: wallet.address, to: call.to, data: call.data, value: call.value };
        stage = "estimate";
        const est = BigInt((await provider.request({ method: "eth_estimateGas", params: [tx] })) as string);
        stage = "prepare";
        const live = await readInfo();
        if (live === "gone") throw new Error("the page lost its connection to your agent");
        if (live.current?.leg !== leg.leg || live.current.next !== index) {
          setNote({ text: "This step was already handled, perhaps in another tab. Close this tab and use the other one.", tone: "bad" });
          return undefined;
        }
        // A wallet prompt must not outlive the run: the process would then end this leg as "may have been sent".
        if (live.msLeft < 60_000) {
          throw Object.assign(new Error("less than a minute is left before your agent's run pauses, too little to confirm in your wallet"), { late: true });
        }
        stage = "send";
        hash = (await provider.request({ method: "eth_sendTransaction", params: [{ ...tx, chainId: `0x${leg.chainId.toString(16)}`, gas: `0x${((est * 3n) / 2n).toString(16)}` }] })) as string;
        setLocal({ leg: leg.leg, phase: "sent" });
        const r = await post("/result", { index, hash });
        if (!r.ok) throw new Error(r.reason ?? "refused");
        return r;
      } catch (e) {
        return failed(leg, e, stage, hash, index);
      }
    },
    [wallet, failed],
  );

  /**
   * A Solana leg's one transaction: built by the process when it is asked for here (a blockhash lasts about a minute),
   * then signed and sent by the wallet. Resolves with the process's verdict, or undefined once the plan stopped here.
   */
  const sendSolana = useCallback(
    async (leg: LegView): Promise<Record<string, unknown> | undefined> => {
      let signature: string | undefined;
      let stage: "prepare" | "send" = "prepare";
      try {
        if (!solana) throw new Error("this page has no Solana wallet");
        setLocal({ leg: leg.leg, phase: "wallet" });
        const live = await readInfo();
        if (live === "gone") throw new Error("the page lost its connection to your agent");
        if (live.current?.leg !== leg.leg || live.current.next !== 0) {
          setNote({ text: "This step was already handled, perhaps in another tab. Close this tab and use the other one.", tone: "bad" });
          return undefined;
        }
        if (live.msLeft < 60_000) {
          throw Object.assign(new Error("less than a minute is left before your agent's run pauses, too little to confirm in your wallet"), { late: true });
        }
        const built = await post("/result", { build: true });
        if (!built.ok || typeof built["wire"] !== "string") throw new Error(built.reason ?? "the transaction could not be prepared");
        stage = "send";
        signature = await solana.send(built["wire"]);
        setLocal({ leg: leg.leg, phase: "sent" });
        const r = await post("/result", { hash: signature });
        if (!r.ok) throw new Error(r.reason ?? "refused");
        return r;
      } catch (e) {
        return failed(leg, e, stage, signature, 0);
      }
    },
    [solana, failed],
  );

  /** Runs legs from the next pending one until the plan is done, stopped, paused, or the operator said stop. */
  const go = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNote(null);
    lateRef.current = false;
    try {
      for (;;) {
        let cur = await refresh();
        if (!cur) return;
        // Resume only a leg this tab is driving (the wallet said no, then "ask again"); otherwise start the next.
        if (cur.current && owned.current !== cur.current.leg) return;
        if (!cur.current) {
          const leg = cur.legs.find((l) => l.status === "pending");
          if (!leg) return;
          if (stopAfterRef.current) {
            await reject("the operator stopped the plan after the previous step");
            await refresh();
            return setNote({ text: "Stopped. Nothing else will be sent." });
          }
          // Before any leg of a plan with a Solana leg still to run: the Solana account, connected and checked. It runs
          // again after a reload, so it can fail after earlier steps sent transactions; then only this step and the
          // ones after it are stopped, and the note says so.
          if (solana && cur.legs.some((l) => l.status === "pending" && isSolana(l))) {
            const why = await solana.ensure();
            if (why) {
              const first = !cur.legs.some((l) => l.txs.length > 0);
              await post("/result", { rejected: true, unprepared: true, reason: `the Solana wallet check before ${first ? "the plan started" : `step ${leg.leg}`}: ${why}` }).catch(() => undefined);
              await refresh();
              return setNote({
                text: first
                  ? `The plan was stopped before any step ran, and nothing was sent: ${why}.`
                  : `The plan was stopped before step ${leg.leg}, and nothing more was sent: ${why}. The steps before it are as shown.`,
                tone: "bad",
              });
            }
          }
          const s = await post("/result", { start: leg.leg });
          if (!s.ok) return setNote({ text: s.reason ?? "This step could not start.", tone: "bad" });
          if (s["paused"]) return (resumeOnReturn.current = true), setAway(true);
          owned.current = leg.leg;
          cur = await refresh();
          if (!cur?.current) return;
        }
        const step = cur.current!;
        const leg = cur.legs.find((l) => l.leg === step.leg)!;
        let r: Record<string, unknown> | undefined;
        if (step.chain === "solana") {
          r = await sendSolana(leg);
        } else {
          for (let i = step.next; i < step.calls.length; i++) {
            r = await sendCall(leg, step.calls[i]!, i, step.chainId);
            if (!r || r["stop"]) break;
          }
        }
        setLocal(null);
        owned.current = null;
        await refresh();
        if (!r || r["stop"] || r["planDone"]) return;
        if (r["paused"]) return (resumeOnReturn.current = true), setAway(true);
      }
    } catch (e) {
      const err = e as Error & { idle?: boolean; ended?: boolean; why?: string };
      setNote({ text: err.message, tone: "bad" });
      if (err.ended) {
        setLocal(null);
        owned.current = null;
        await refresh();
      }
      if (err.idle) whyRef.current = err.why;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [refresh, sendCall, sendSolana, solana]);

  // Nothing is outstanding in the wallet for this leg: the operator ends the plan here, and the leg sent nothing.
  const stopHere = async () => {
    const reason =
      local?.phase === "unprepared"
        ? `not prepared: this page could not prepare the step${whyRef.current ? ` (${whyRef.current})` : ""}; the operator stopped the plan`
        : "declined in the wallet; the operator stopped the plan";
    await post("/result", { rejected: true, declined: true, reason }).catch(() => undefined);
    setLocal(null);
    owned.current = null;
    setNote({ text: "Stopped. Nothing else will be sent." });
    await refresh();
  };

  // A leg this tab cannot vouch for: end the plan there, on record as "may have been sent".
  const endOrphan = async () => {
    await post("/result", { rejected: true, reason: "ended from a tab that was not running this step (a reload or another tab); it may have been sent" }).catch(() => undefined);
    await refresh();
  };

  // Back from between runs, and this tab was walking the plan: carry on (only ever between legs).
  useEffect(() => {
    if (away || !resumeOnReturn.current || info.current || running.current) return;
    resumeOnReturn.current = false;
    void go();
  }, [away, info.current, go]);

  // A decline or a failed prepare replaces the focused button: put focus on the way forward.
  useEffect(() => {
    if (local?.phase === "declined" || local?.phase === "unprepared") againRef.current?.focus();
  }, [local?.phase]);

  const msLeft = Math.max(0, deadlineAt - now);
  const current = local ? legs.find((l) => l.leg === local.leg) : undefined;
  const title = allDone
    ? "Plan complete"
    : failedLeg
      ? "Plan stopped"
      : expired
        ? "Plan expired"
        : orphan
          ? `Step ${orphan.leg} may have been sent`
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
        : `Step ${failedLeg.leg} ${
            {
              declined: "was declined, and nothing was sent for it",
              unprepared: "could not be prepared, and nothing was sent for it",
              partial: "stopped after its approval landed: the approval is in place, and the deposit was not sent",
              maybe: "may have been sent; check your wallet before doing anything else",
            }[legState(failedLeg, null, true) as string] ?? "did not land as approved"
          }.`}{" "}
      {landed} of {legs.length} steps landed; the steps after it did not run, and nothing else will be sent.
    </>
  ) : expired ? (
    <>The plan expired. Steps that had not started did not run, and nothing else will be sent. For what is left, ask your agent for a new plan.</>
  ) : orphan ? (
    <>
      Step {orphan.leg} is in progress in another tab, or was when this page was reloaded, so your wallet may already have sent it. Check your wallet's activity. This
      page will not ask your wallet for it. If another tab is still working on it, use that tab. Otherwise end the plan here (this ends it in every tab), and your agent
      reports what landed.
    </>
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

  // The sign-in a plan needs: the EVM wallet when it has an EVM leg (its Solana account is connected at Start), else the
  // login's Solana wallet.
  const signInNeeded = ready && (!authenticated || (evmLegs ? !wallet : !solana?.signedIn));
  const progress = runningLeg && !orphan ? `Step ${runningLeg.leg} of ${legs.length}: ${LABEL[legState(runningLeg, local, planOver)]}.` : "";
  const statusLine =
    away && !planOver
      ? `Waiting for your agent to continue. This page carries on by itself once it does; keep it open.${awayPolls >= 20 ? " If your agent opened a new page, use that one." : ""}`
      : (note?.text ?? progress);
  const ownAccount = (l: LegView) => (isSolana(l) ? info.solanaAccount : info.account);
  const signInWith = evmLegs ? info.account : info.solanaAccount;

  return (
    <Page mark={allDone ? <CheckMark /> : <WalletMark />} title={title} lede={lede}>
      <div className="oat-plan-head">
        <span className="oat-plan-wallet">
          <span className="oat-dot" aria-hidden="true" />
          {info.account && (
            <>
              {info.walletType === "embedded" ? "Privy wallet" : "Your wallet"} <span className="oat-mono">{short(info.account)}</span>
            </>
          )}
          {info.account && info.solanaAccount && " · "}
          {info.solanaAccount && (
            <>
              {info.account ? "Solana" : info.solanaWalletType === "embedded" ? "Privy wallet (Solana)" : "Your wallet (Solana)"} <span className="oat-mono">{short(info.solanaAccount)}</span>
            </>
          )}
        </span>
        {!planOver && <span className="oat-plan-timer">{msLeft < 10 * 60_000 ? `Plan expires in ${mmss(msLeft)}` : `expires in ${mmss(msLeft)}`}</span>}
      </div>
      <ol className="oat-legs" aria-label="The steps in this plan">
        {legs.map((l) => {
          const st = orphan?.leg === l.leg ? "maybe" : legState(l, local, planOver);
          const lands = l.action === "deposit" ? "Shares go to" : "Funds go to";
          const own = ownAccount(l) ?? "";
          const to = l.receiver ?? own;
          const mine = isSolana(l) ? to === own : to.toLowerCase() === own.toLowerCase();
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
                  <dt>Vault {isSolana(l) ? "account" : "contract"}</dt>
                  <dd className="oat-mono">{l.vault.address}</dd>
                  {l.action === "deposit" && (
                    <>
                      <dt>
                        {l.vault.asset} {isSolana(l) ? "mint" : "token"}
                      </dt>
                      <dd className="oat-mono">{l.vault.assetAddress}</dd>
                    </>
                  )}
                  <dt>Network</dt>
                  <dd>{l.chainId === null ? `${l.chainName} (mainnet-beta)` : `${l.chainName} (chain ${l.chainId})`}</dd>
                  <dt>{lands}</dt>
                  <dd>
                    <span className="oat-mono">{to}</span>
                    <br />
                    {mine ? "✓ your connected wallet" : "NOT your connected wallet: do not confirm"}
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
          {evmLegs && solana && " At Start, your wallet may ask you to connect its Solana account to this page: the Solana steps use that account, and no other wallet."}
        </p>
      )}
      {/* One live region, always mounted, so each change of its line is announced. */}
      <p className="oat-status" role="status" aria-live="polite" data-tone={note?.tone}>
        {statusLine}
      </p>
      {!planOver &&
        (orphan ? (
          // Ending the plan needs no wallet: it asks the wallet for nothing.
          <button className="oat-btn" onClick={() => void endOrphan()}>
            End the plan here
          </button>
        ) : !ready ? (
          <p className="oat-status">Loading.</p>
        ) : signInNeeded ? (
          <>
            <button className="oat-btn" onClick={() => void (authenticated ? logout().then(() => login()) : login())}>
              <ButtonIcon />
              Connect
            </button>
            <p className="oat-fine">Connect with the same wallet you signed in with before ({short(signInWith ?? "")}).</p>
          </>
        ) : local?.phase === "declined" || local?.phase === "unprepared" ? (
          <>
            {local.phase === "unprepared" && lateRef.current ? (
              <button ref={againRef} className="oat-btn" disabled={busy} onClick={() => void stopHere()}>
                Stop the plan here
              </button>
            ) : (
              <>
                <button ref={againRef} className="oat-btn" disabled={busy} onClick={() => void go()}>
                  {local.phase === "declined" ? "Ask my wallet again" : "Try again"}
                </button>
                <button className="oat-text" disabled={busy} onClick={() => void stopHere()}>
                  Stop the plan here
                </button>
              </>
            )}
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

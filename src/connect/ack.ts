/**
 * The operator's acknowledgement, which `connect deposit` and `connect withdraw` require before the
 * signing page opens.
 *
 * Run without `--ack`, either command builds and gate-checks its calls, records them as pending, and
 * returns `acknowledgement`: one fixed text, written here and not by the agent, naming the action,
 * amount, chain, vault, its explorer link, the receiver, the vault's warning and the disclosures in
 * plain words (`DISCLOSURES.plain`; the full text stays in `earn terms`). The agent posts it to the
 * operator and waits for an explicit yes. Run again
 * with `--ack <code>`, the page opens only if the code names the pending acknowledgement, it has not
 * expired, and the calls are exactly the ones it described. The code is then spent, so every page
 * open is preceded by its own acknowledgement.
 *
 * The code is not a secret and does not need to be: it ties the second run to the text the operator
 * read. An amount, vault, chain, receiver or account that changes in between gives different calls,
 * and the code no longer matches them.
 */
import { formatUnits, keccak256, stringToHex, type Address } from "viem";
import type { UnsignedCall } from "../build.js";
import { CHAIN_INFO } from "../client.js";
import { DISCLOSURES } from "../disclosures.js";
import { linksFor } from "../links.js";
import type { Admitted } from "./gate.js";
import type { SolanaVaultEntry } from "../registry-schema.js";

/** How long an acknowledgement stays usable: long enough to read it and answer, not long enough to forget it. */
export const ACK_TTL_MS = 15 * 60_000;

export interface PendingAck {
  code: string;
  digest: string;
  issuedAtIso: string;
  expiresAtIso: string;
}

/** What the calls ARE: the connected account and each call's chain, destination, calldata and value. */
export function callsDigest(calls: UnsignedCall[], account: Address): string {
  return keccak256(stringToHex(JSON.stringify([account, calls.map((c) => [c.chainId, c.to, c.data, c.value])])));
}

export function issueAck(calls: UnsignedCall[], account: Address, now: Date): PendingAck {
  return issueAckForDigest(callsDigest(calls, account), now);
}

/**
 * What a Solana intent IS: the connected account, the vault, the action and its raw amount. Not the
 * transaction's bytes — those name a blockhash that expires in about a minute, so the page builds a fresh
 * transaction for the same intent, and the gate holds every one of them to it. A withdrawal by amount is
 * `withdraw-assets` with the asset's raw amount: the shares worth it change as the vault earns, so they are
 * worked out only once the acknowledgement is accepted.
 */
export function solanaIntentDigest(account: string, vault: string, action: "deposit" | "withdraw" | "withdraw-assets", raw: bigint): string {
  return keccak256(stringToHex(JSON.stringify(["solana", account, vault, action, raw.toString()])));
}

export function issueAckForDigest(digest: string, now: Date): PendingAck {
  const issuedAtIso = now.toISOString();
  return {
    code: keccak256(stringToHex(`${digest}|${issuedAtIso}`)).slice(2, 10),
    digest,
    issuedAtIso,
    expiresAtIso: new Date(now.getTime() + ACK_TTL_MS).toISOString(),
  };
}

/** Throws unless `code` names `pending`, it is unexpired, and it was issued for exactly these calls. */
export function checkAck(code: string, pending: PendingAck | undefined, calls: UnsignedCall[], account: Address, now: Date): void {
  checkAckDigest(code, pending, callsDigest(calls, account), now);
}

/** `checkAck` against a digest computed by the caller (a Solana intent's). */
export function checkAckDigest(code: string, pending: PendingAck | undefined, digest: string, now: Date): void {
  const again = "run the same command without --ack, post its `acknowledgement` to the operator, and wait for their yes";
  if (!pending) throw new Error(`refused: no acknowledgement is pending; ${again}`);
  if (code.trim().toLowerCase() !== pending.code) throw new Error(`refused: --ack ${code} is not the pending acknowledgement's code; ${again}`);
  const expires = Date.parse(pending.expiresAtIso);
  // A missing or unreadable expiry counts as expired, never as no expiry.
  if (!Number.isFinite(expires) || now.getTime() > expires) throw new Error(`refused: the acknowledgement expired at ${pending.expiresAtIso}; ${again}`);
  if (digest !== pending.digest) {
    throw new Error(`refused: these calls are not the ones the operator acknowledged (the amount, vault, chain, receiver or connected account changed); ${again}`);
  }
}

export interface AckSummary {
  action: "deposit" | "withdraw";
  amount: string;
  /** The vault's asset (USDC; USDG on Robinhood Chain): what a withdrawal pays out. */
  asset: string;
  chain: string;
  /** `null` on Solana, which has no chain id; the text then names the cluster. */
  chainId: number | null;
  vault: { symbol: string; name: string; address: string; explorer: string };
  /** What the wallet will ask; the EVM default (approve then deposit, or one withdrawal) when absent. */
  prompts?: string;
  receiver: string;
  warning: string;
  disclosures: string[];
}

/**
 * The registry's `warning` is written for both audiences, so it ends with an instruction to the agent
 * ("Show this warning before preparing any deposit."). The operator is reading the warning itself, so
 * that sentence is dropped here. The registry text is unchanged: `earn` output and the registry check use it.
 */
export function operatorWarning(w: string, action: "deposit" | "withdraw" = "deposit"): string {
  const s = w.replace(/\s*Show this warning before preparing any deposit\.\s*$/, "").trim();
  // Before a withdrawal, advice on how much to deposit does not apply.
  return action === "withdraw" ? s.replace(/\s*Deposit only .*?\.(?=\s|$)/g, "").trim() : s;
}

export function summarize(action: "deposit" | "withdraw", calls: UnsignedCall[], admitted: Admitted[], receiver: Address): AckSummary {
  const main = admitted.find((a) => a.kind !== "approve")!;
  const v = main.vault;
  const chainId = calls[0]!.chainId as keyof typeof CHAIN_INFO;
  const amount =
    main.kind === "redeem"
      ? `${formatUnits(main.amount, v.shareDecimals)} ${v.symbol} shares (the amount given; it is the whole position only if it equals the account's share balance, which is not checked here)`
      : `${formatUnits(main.amount, v.asset.decimals)} ${v.asset.symbol}`;
  return {
    action,
    amount,
    asset: v.asset.symbol,
    chain: CHAIN_INFO[chainId].name,
    chainId,
    vault: { symbol: v.symbol, name: v.name, address: v.address, explorer: linksFor(v).explorer },
    receiver,
    warning: operatorWarning(v.warning, action),
    // The disclosures in plain words (`DISCLOSURES.plain`): the operator reads this before every page,
    // so it is the short form. Before a withdrawal, only what holds for every action.
    disclosures:
      action === "deposit"
        ? [...DISCLOSURES.plain.deposit, ...(v.depositOpen.open ? [] : [DISCLOSURES.plain.gatedDeposit]), ...DISCLOSURES.plain.always]
        : [...DISCLOSURES.plain.always],
  };
}

/** The summary for a Solana intent: one transaction, no approve, and shares only ever to the account itself. */
export function summarizeSolana(action: "deposit" | "withdraw", v: SolanaVaultEntry, amountText: string, account: string): AckSummary {
  return {
    action,
    amount: amountText,
    asset: v.asset.symbol,
    chain: "Solana",
    chainId: null,
    vault: { symbol: v.symbol, name: v.name, address: v.address, explorer: `https://solscan.io/account/${v.address}` },
    receiver: account,
    warning: operatorWarning(v.warning, action),
    prompts:
      action === "deposit"
        ? "Your wallet will ask you once, to make the deposit. A first deposit also opens your share account, which takes about 0.002 SOL of rent."
        : "Your wallet will ask you once, to make the withdrawal. Kamino keeps up to 0.001 USDC of each withdraw instruction in the vault, a charge it sets and can change.",
    disclosures:
      action === "deposit"
        ? [...DISCLOSURES.plain.deposit, ...(v.depositOpen.open ? [] : [DISCLOSURES.plain.gatedDeposit]), ...DISCLOSURES.plain.always]
        : [...DISCLOSURES.plain.always],
  };
}

/** The text the operator reads. Generated, never paraphrased: the same calls always produce the same words. */
export function acknowledgementText(s: AckSummary): string {
  const lands = s.action === "deposit" ? "Shares go to" : `${s.asset} goes to`;
  const prompts =
    s.prompts ??
    (s.action === "deposit"
      ? `Your wallet will ask you twice: first to approve ${s.amount} to the vault, then to make the deposit.`
      : `Your wallet will ask you once, to make the withdrawal.`);
  return [
    `Confirm before the signing page opens. Nothing has been sent.`,
    ``,
    `  ${s.action === "deposit" ? "Deposit" : "Withdraw"}: ${s.amount}`,
    s.chainId === null ? `  Chain: ${s.chain} (mainnet-beta)` : `  Chain: ${s.chain} (chainId ${s.chainId})`,
    `  Vault: ${s.vault.name} (${s.vault.symbol})`,
    `         ${s.vault.explorer}`,
    `  ${lands}: ${s.receiver} (the connected wallet)`,
    `  ${prompts}`,
    ``,
    `WARNING: ${s.warning}`,
    ``,
    `Before you agree:`,
    ...s.disclosures.map((d) => `  - ${d}`),
    `  ${DISCLOSURES.plain.fullTerms}`,
    ``,
    `Do you acknowledge and want the signing page opened for exactly this ${s.action}? Reply yes or no.`,
  ].join("\n");
}

/**
 * A plan: one acknowledgement for several deposits and withdrawals, across vaults and chains (`connect plan`).
 *
 * Each leg is bound to the same digest its own `--ack` would be (`callsDigest`, `solanaIntentDigest`), so a
 * leg run rebuilds its calls exactly as a single acknowledgement does and is held to them. The plan's code
 * is spent leg by leg, in order: a leg that does not complete ends the plan, and the legs after it never run.
 */
export const PLAN_TTL_MS = 60 * 60_000;
/** Past this many legs, the operator is better served by more than one plan. */
export const PLAN_MAX_LEGS = 8;

export type PlanLegStatus = "pending" | "running" | "completed" | "stopped" | "not_reported";

export interface PlanLeg {
  leg: number;
  action: "deposit" | "withdraw";
  vault: string;
  chain: string;
  amount: string;
  digest: string;
  /** The exact command that runs this leg once the plan is acknowledged. */
  command: string;
  /** What that command builds the leg's calls from: how `connect plan --run` rebuilds them for its one page. */
  args?: PlanLegArgs;
  status: PlanLegStatus;
  txs?: PlanTx[];
  reason?: string;
}

/** A leg's transaction as the plan keeps it: its hash, its verdict, and anything else the wallet moved with it. */
export interface PlanTx {
  hash: string;
  verified: string;
  alsoMoved?: { to: string; amountRaw: string }[];
}

export interface PlanLegArgs {
  vault: string;
  receiver: string;
  amount_usdc?: string;
  all?: boolean;
  shares_exact?: string;
}

export interface PendingPlan {
  code: string;
  issuedAtIso: string;
  expiresAtIso: string;
  acknowledged: boolean;
  legs: PlanLeg[];
  /**
   * The one page `connect plan --run` serves for this plan: its secret and port, kept so a run that stops at the
   * shell's time limit and the run after it serve the same page, and the operator's open tab carries on.
   */
  page?: { secret: string; port: number };
}

/** What a plan IS: its legs' digests, in order. Reordering, adding or dropping a leg changes it. */
export function planDigest(digests: string[]): string {
  return keccak256(stringToHex(JSON.stringify(["plan", digests])));
}

export function issuePlan(legs: Omit<PlanLeg, "status">[], now: Date): PendingPlan {
  const a = issueAckForDigest(planDigest(legs.map((l) => l.digest)), now);
  return {
    code: a.code,
    issuedAtIso: a.issuedAtIso,
    expiresAtIso: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    acknowledged: false,
    legs: legs.map((l) => ({ ...l, status: "pending" })),
  };
}

export const planExpired = (p: PendingPlan, now: Date) => {
  const expires = Date.parse(p.expiresAtIso);
  // A missing or unreadable expiry counts as expired, never as no expiry.
  return !Number.isFinite(expires) || now.getTime() > expires;
};

/** Throws unless `code` names the pending plan, it is unexpired and not yet acknowledged, and its legs are exactly `digests`. */
export function checkPlanAck(code: string, plan: PendingPlan | undefined, digests: string[], now: Date): void {
  const again = "run the same `connect plan` without --ack, post its `acknowledgement` to the operator, and wait for their yes";
  if (!plan) throw new Error(`refused: no plan is pending; ${again}`);
  if (code.trim().toLowerCase() !== plan.code) throw new Error(`refused: --ack ${code} is not the pending plan's code; ${again}`);
  if (planExpired(plan, now)) throw new Error(`refused: the plan expired at ${plan.expiresAtIso}; ${again}`);
  if (plan.acknowledged) throw new Error(`refused: this plan was already acknowledged; run its legs (\`connect plan --status\` lists them)`);
  if (planDigest(digests) !== planDigest(plan.legs.map((l) => l.digest))) {
    throw new Error(`refused: these legs are not the ones the operator acknowledged (a leg, its order, amount, vault, or a share balance changed); ${again}`);
  }
}

/**
 * Throws unless leg `leg` of the acknowledged plan `code` may run now, for exactly `digest`: the plan is
 * acknowledged and unexpired, every earlier leg completed, and this leg has not run. Returns its index.
 */
export function checkPlanLeg(code: string, leg: number, plan: PendingPlan | undefined, digest: string, now: Date): number {
  const again = "acknowledge a new plan with `connect plan`";
  if (!plan) throw new Error(`refused: no plan is pending; ${again}`);
  if (code.trim().toLowerCase() !== plan.code) throw new Error(`refused: --plan ${code} is not the pending plan's code; ${again}`);
  if (!plan.acknowledged) throw new Error(`refused: plan ${plan.code} has not been acknowledged; post its acknowledgement and, on the operator's yes, run \`connect plan\` with --ack ${plan.code}`);
  if (planExpired(plan, now)) throw new Error(`refused: the plan expired at ${plan.expiresAtIso}; legs that have not started do not run; ${again}`);
  const i = plan.legs.findIndex((l) => l.leg === leg);
  if (i < 0) throw new Error(`refused: plan ${plan.code} has no leg ${leg}; it has legs 1 to ${plan.legs.length}`);
  const ended = plan.legs.find((l) => l.status !== "pending" && l.status !== "completed");
  if (ended && ended.leg !== leg) {
    throw new Error(
      ended.status === "running"
        ? `refused: leg ${ended.leg} is still running, or its run never finished; no later leg runs until it has completed`
        : `refused: the plan ended at leg ${ended.leg} (${ended.status}), so no later leg runs; ${again}`,
    );
  }
  if (plan.legs[i]!.status !== "pending") throw new Error(`refused: leg ${leg} has already run (${plan.legs[i]!.status})`);
  const before = plan.legs.slice(0, i).find((l) => l.status !== "completed");
  if (before) throw new Error(`refused: legs run in order, and leg ${before.leg} has not completed; run it first`);
  if (digest !== plan.legs[i]!.digest) {
    throw new Error(`refused: these calls are not leg ${leg} as the operator acknowledged it (the amount, vault, chain, receiver or connected account changed); ${again}`);
  }
  return i;
}

/** The text the operator reads for a plan: every leg, then each warning and the disclosures once. */
export function planAcknowledgementText(legs: AckSummary[], totals: string[]): string {
  const n = legs.length;
  // One warning per text, naming every vault it covers. A withdrawal's warning is the deposit's without its advice on
  // how much to deposit (`operatorWarning`), so the two are one warning, with that advice named for the deposits only.
  const advice = (w: string) => w.match(/Deposit only .*?\.(?=\s|$)/g)?.join(" ") ?? "";
  const warnings: { text: string; vaults: string[]; advice: string; depositVaults: string[] }[] = [];
  for (const s of legs) {
    const base = operatorWarning(s.warning, "withdraw");
    const w = warnings.find((x) => x.text === base) ?? warnings[warnings.push({ text: base, vaults: [], advice: "", depositVaults: [] }) - 1]!;
    if (!w.vaults.includes(s.vault.symbol)) w.vaults.push(s.vault.symbol);
    if (s.action === "deposit" && advice(s.warning)) {
      w.advice = advice(s.warning);
      if (!w.depositVaults.includes(s.vault.symbol)) w.depositVaults.push(s.vault.symbol);
    }
  }
  const several = new Set(legs.map((s) => s.vault.symbol)).size > 1;
  const fees = DISCLOSURES.plain.deposit.find((d) => d.startsWith("Tempora Labs runs this vault"));
  const disclosures = [...new Set(legs.flatMap((s) => s.disclosures))].map((d) => (several && d === fees ? DISCLOSURES.plain.feesSeveral : d));
  const minutes = Math.round(PLAN_TTL_MS / 60_000);
  const legLines = legs.flatMap((s, i) => {
    const lands = s.action === "deposit" ? "Shares go to" : `${s.asset} goes to`;
    const prompts =
      s.prompts ??
      (s.action === "deposit"
        ? `Your wallet will ask you twice: first to approve ${s.amount} to the vault, then to make the deposit.`
        : `Your wallet will ask you once, to make the withdrawal.`);
    return [
      `  ${i + 1}. ${s.action === "deposit" ? "Deposit" : "Withdraw"}: ${s.amount}`,
      s.chainId === null ? `     Chain: ${s.chain} (mainnet-beta)` : `     Chain: ${s.chain} (chainId ${s.chainId})`,
      `     Vault: ${s.vault.name} (${s.vault.symbol})`,
      `            ${s.vault.explorer}`,
      `     ${lands}: ${s.receiver} (the connected wallet)`,
      `     ${prompts}`,
      ``,
    ];
  });
  return [
    `Confirm before any signing page opens. Nothing has been sent.`,
    ``,
    `This plan has ${n} ${n === 1 ? "leg" : "legs"}, run in this order on one signing page, where your wallet asks you to confirm each transaction. If a leg does not complete, the legs after it do not run.`,
    `The plan lasts ${minutes} minutes: a leg not started by then does not run, and connecting a wallet again cancels it. To stop partway, reject a transaction in your wallet, or stop the plan on the signing page; the legs after it then do not run.`,
    ``,
    ...legLines,
    ...(totals.length ? [`In total: ${totals.join("; ")}.`, ``] : []),
    ...warnings.flatMap((w) => [
      `WARNING (${w.vaults.join(", ")}): ${w.text}`,
      ...(w.advice ? [`  For the ${w.depositVaults.length === 1 ? "deposit" : "deposits"} (${w.depositVaults.join(", ")}): ${w.advice}`] : []),
    ]),
    ``,
    `Before you agree:`,
    ...disclosures.map((d) => `  - ${d}`),
    `  ${DISCLOSURES.plain.fullTerms}`,
    ``,
    `Do you acknowledge and want the signing page opened for exactly these ${n} ${n === 1 ? "leg" : "legs"}, run one leg at a time? Reply yes or no.`,
  ].join("\n");
}

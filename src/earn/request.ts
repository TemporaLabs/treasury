/**
 * A vault request from the Tempora API, as `earn` hands it on: every step checked first by the client's own
 * `checkSteps` against what the operator asked for, and only then shown with what to send.
 *
 * The API prepares each step; nothing it says about a step is trusted. A step is handed out to sign only after the whole
 * request passed the check: an approval only to the vault's asset, for exactly the deposit's amount, with the vault as
 * spender; a deposit only into the vault, for exactly that amount, paying the shares to the owner; a withdrawal or
 * redeem only from the vault, paid to and owned by the owner, for exactly the amount asked. A step the API has not
 * prepared yet (`waiting`) has nothing to send, and says when it will.
 */
import { checkSteps, type Request, type VaultIntent } from "@temporalabs/client";
import { decodeFunctionData, formatUnits, type Address, type Hex } from "viem";
import { erc4626Abi } from "../abi/erc4626.js";
import { CHAIN_INFO } from "../client.js";
import { FINAL_STATES } from "../invest/flow.js";
import { chainOf, type VaultProduct } from "./api.js";

/** A withdrawal's amount, in the form the check takes it. */
export type WithdrawAmount = { kind: "assets"; raw: string } | { kind: "shares"; raw: string } | { kind: "all" };

const onChainOf = (p: VaultProduct) => ({ chain: p.vault.chain, vaultAddress: p.vault.vaultAddress, assetAddress: p.vault.assetAddress });

export const depositIntent = (p: VaultProduct, owner: Address, raw: bigint): VaultIntent => ({ action: "deposit", vault: onChainOf(p), owner, assets: raw.toString() });
export const withdrawIntent = (p: VaultProduct, owner: Address, amount: WithdrawAmount): VaultIntent => ({ action: "withdraw", vault: onChainOf(p), owner, amount });

/**
 * The intent a request read again is held to: its own recorded choice, for the connected owner and the vault the API
 * lists. `undefined` when the request records no amount this client can hold a step to.
 */
export function intentOf(r: Request, p: VaultProduct, owner: Address): VaultIntent | undefined {
  const a = r.chose.amount;
  if (r.action === "deposit" && a?.kind === "assets") return depositIntent(p, owner, BigInt(a.raw));
  if (r.action === "withdraw" && (a?.kind === "assets" || a?.kind === "shares")) return withdrawIntent(p, owner, { kind: a.kind, raw: a.raw });
  if (r.action === "withdraw" && a?.kind === "all") return withdrawIntent(p, owner, { kind: "all" });
  return undefined;
}

type Step = Request["steps"][number];
type Sendable = { to: Address; data: Hex; value: string };
const payloadOf = (s: Step): Sendable | undefined => (s as { payload?: Sendable }).payload;

/** A checked call in plain words, read from its own calldata, never from the API's words. */
function describeCall(p: VaultProduct, to: string, data: Hex): string {
  const d = decodeFunctionData({ abi: erc4626Abi, data });
  const asset = (raw: unknown) => formatUnits(raw as bigint, p.vault.assetDecimals);
  const args = (d.args ?? []) as readonly unknown[];
  switch (d.functionName) {
    case "approve":
      return `approve the vault (${String(args[0])}) to take ${asset(args[1])} of the vault's asset (${to})`;
    case "deposit":
      return `deposit ${asset(args[0])} of the asset into the vault (${to}); the shares go to ${String(args[1])}`;
    case "withdraw":
      return `withdraw ${asset(args[0])} of the asset from the vault (${to}), paid to ${String(args[1])}`;
    case "redeem":
      return `redeem ${formatUnits(args[0] as bigint, p.vault.shareDecimals)} shares of the vault (${to}), paid to ${String(args[1])}`;
    default:
      return `${d.functionName} on ${to}`;
  }
}

/**
 * The same call `data` encodes, decoded: its signature and its arguments by name, in RAW contract units, so an operator
 * without a command-line signer can fill a block explorer's Write Contract form directly.
 */
function decoded(data: Hex): { function: string; args: Record<string, string> } {
  const d = decodeFunctionData({ abi: erc4626Abi, data });
  const item = erc4626Abi.find((x) => x.type === "function" && x.name === d.functionName) as { inputs: readonly { name: string; type: string }[] };
  const values = (d.args ?? []) as readonly unknown[];
  return {
    function: `${d.functionName}(${item.inputs.map((i) => `${i.type} ${i.name}`).join(", ")})`,
    args: Object.fromEntries(item.inputs.map((i, n) => [i.name, String(values[n])])),
  };
}

/** A checked step's call, read from its own calldata: which call, a sentence, and the decoded form. */
export function describeStep(p: VaultProduct, to: string, data: Hex): { call: string; description: string; function: string; args: Record<string, string> } {
  const d = decoded(data);
  return { call: d.function.slice(0, d.function.indexOf("(")), description: describeCall(p, to, data), ...d };
}

/** One step as the operator reads it: its state, and what to send only when it was checked and has something to send. */
function stepOut(s: Step, p: VaultProduct | undefined) {
  const payload = p ? payloadOf(s) : undefined;
  const after = (s as { after?: string }).after;
  const purpose = (s as { purpose?: string }).purpose;
  const verification = (s as { verification?: unknown }).verification;
  return {
    stepId: s.stepId,
    state: s.state,
    ...(after !== undefined && { after }),
    ...(purpose !== undefined && { purpose }),
    ...(payload
      ? { to: payload.to, data: payload.data, value: payload.value, ...decoded(payload.data), description: describeCall(p!, payload.to, payload.data) }
      : { description: after !== undefined ? `prepared by the API once step ${after} is submitted: read it with \`treasury earn request\`` : "nothing to send from this step yet" }),
    ...(verification !== undefined && { verification }),
  };
}

/**
 * Every step of the request, checked against `intent` first. A refused check hands nothing out: the request is named
 * so it can be cancelled.
 */
export function checkedSteps(r: Request, p: VaultProduct, intent: VaultIntent) {
  const c = checkSteps(r.steps as never, intent);
  if (!c.ok) {
    throw new Error(
      `refused${c.step !== null ? ` (step ${c.step + 1} of ${r.steps.length})` : ""}: ${c.reason}. Nothing from request ${r.requestId} is handed out to sign; ` +
        `cancel it with \`treasury earn request --request_id ${r.requestId} --cancel\``,
    );
  }
  return r.steps.map((s) => stepOut(s, p));
}

/** The steps of a request this client cannot hold to an intent: states only, never anything to send. */
export const uncheckedSteps = (r: Request) => r.steps.map((s) => stepOut(s, undefined));

/** What to do next with a checked request: send the one step that is ready, and submit its hash. */
export function nextStep(r: Request, p: VaultProduct, owner: Address, prepared: boolean): string {
  const rid = r.requestId;
  if (FINAL_STATES.includes(r.state)) return `Request ${rid} is ${r.state}: there is nothing more to send for it.`;
  const c = chainOf(p);
  const where = c.chainId !== null ? `${CHAIN_INFO[c.chainId as keyof typeof CHAIN_INFO].name} (chainId ${c.chainId})` : c.caip2;
  const ready = r.steps.find((s) => s.state === "ready" && payloadOf(s) !== undefined);
  const untouched = prepared ? " Nothing has been submitted; no funds have moved." : "";
  if (!ready) return `Nothing to send now: read the request again with \`treasury earn request --request_id ${rid}\` until a step is \`ready\`.${untouched}`;
  const later = r.steps.filter((s) => s !== ready && s.state === "waiting");
  return (
    `Send step ${ready.stepId}, and only it, from the connected wallet (${owner}) on ${where}, following \`signer_rules\`. ` +
    `Then run \`treasury earn submit --request_id ${rid} --step_id ${ready.stepId} --tx_hash <its transaction hash>\`.` +
    (later.length > 0
      ? ` Step ${later.map((s) => s.stepId).join(", ")} is prepared after that: read the request with \`treasury earn request --request_id ${rid}\` until it is \`ready\`, then send it and submit its hash the same way.`
      : "") +
    untouched
  );
}

/**
 * What a signer must do for each step to land exactly once. These commands never sign, so they cannot enforce any of
 * them; they state them with every step they hand out. The nonce and receipt rules are failures measured on real
 * sends, not precautions (2026-09-13 and 2026-09-14, Base).
 */
export const SIGNER_RULES = [
  "Send each step on the chain the envelope's `chainId` names, and on no other: check the signer's network before signing. Sent on a different chain, a step can be mined there without doing anything — the approve or the deposit never happened, and gas was still spent.",
  "Send only a step that is `ready`, one at a time, in order, from the connected wallet. A `waiting` step has nothing to send yet.",
  "Set the nonce explicitly from eth_getTransactionCount(account, \"pending\") immediately before each send. A load-balanced RPC can hand a signing library a stale nonce, and the send is then rejected as \"nonce too low\" (measured 2026-09-14, mainnet.base.org).",
  "Wait for each receipt before sending the next step, and poll for it on a provider that serves receipts: a public endpoint may refuse eth_getTransactionReceipt (measured 2026-09-14, publicnode). A failed receipt poll does not mean the transaction failed.",
  "If a send or receipt poll fails for any reason other than an on-chain revert, read the account's nonce on a DIFFERENT provider before re-sending. A nonce that moved means the transaction was accepted; re-sending it would repeat the deposit or withdrawal. Submit the hash you have with `treasury earn submit` instead.",
] as const;

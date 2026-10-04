/**
 * The operator's acknowledgement, which `connect deposit` and `connect withdraw` require before the
 * signing page opens.
 *
 * Run without `--ack`, either command builds and gate-checks its calls, records them as pending, and
 * returns `acknowledgement`: one fixed text, written here and not by the agent, naming the action,
 * amount, chain, vault, its explorer link, the receiver, the vault's warning and (for a deposit) the
 * pre-deposit disclosures. The agent posts it to the operator and waits for an explicit yes. Run again
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
  const digest = callsDigest(calls, account);
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
  const again = "run the same command without --ack, post its `acknowledgement` to the operator, and wait for their yes";
  if (!pending) throw new Error(`refused: no acknowledgement is pending; ${again}`);
  if (code.trim().toLowerCase() !== pending.code) throw new Error(`refused: --ack ${code} is not the pending acknowledgement's code; ${again}`);
  if (now.getTime() > Date.parse(pending.expiresAtIso)) throw new Error(`refused: the acknowledgement expired at ${pending.expiresAtIso}; ${again}`);
  if (callsDigest(calls, account) !== pending.digest) {
    throw new Error(`refused: these calls are not the ones the operator acknowledged (the amount, vault, chain, receiver or connected account changed); ${again}`);
  }
}

export interface AckSummary {
  action: "deposit" | "withdraw";
  amount: string;
  /** The vault's asset (USDC; USDG on Robinhood Chain): what a withdrawal pays out. */
  asset: string;
  chain: string;
  chainId: number;
  vault: { symbol: string; name: string; address: string; explorer: string };
  receiver: string;
  warning: string;
  disclosures: string[];
}

export function summarize(action: "deposit" | "withdraw", calls: UnsignedCall[], admitted: Admitted[], receiver: Address): AckSummary {
  const main = admitted.find((a) => a.kind !== "approve")!;
  const v = main.vault;
  const chainId = calls[0]!.chainId as keyof typeof CHAIN_INFO;
  const amount =
    main.kind === "redeem"
      ? `${formatUnits(main.amount, v.shareDecimals)} ${v.symbol} (every share the account holds)`
      : `${formatUnits(main.amount, v.asset.decimals)} ${v.asset.symbol}`;
  return {
    action,
    amount,
    asset: v.asset.symbol,
    chain: CHAIN_INFO[chainId].name,
    chainId,
    vault: { symbol: v.symbol, name: v.name, address: v.address, explorer: linksFor(v).explorer },
    receiver,
    warning: v.warning,
    // Before a deposit, the full pre-deposit disclosures; before a withdrawal, what the client is.
    disclosures: action === "deposit" ? [...DISCLOSURES.items, ...DISCLOSURES.clientNotes] : [...DISCLOSURES.clientNotes],
  };
}

/** The text the operator reads. Generated, never paraphrased: the same calls always produce the same words. */
export function acknowledgementText(s: AckSummary): string {
  const lands = s.action === "deposit" ? "Shares go to" : `${s.asset} goes to`;
  return [
    `Confirm before the signing page opens. Nothing has been sent.`,
    ``,
    `  ${s.action === "deposit" ? "Deposit" : "Withdraw"}: ${s.amount}`,
    `  Chain: ${s.chain} (chainId ${s.chainId})`,
    `  Vault: ${s.vault.name} (${s.vault.symbol})`,
    `         ${s.vault.explorer}`,
    `  ${lands}: ${s.receiver} (the connected wallet)`,
    ``,
    `WARNING: ${s.warning}`,
    ``,
    `Before you agree:`,
    ...s.disclosures.map((d) => `  - ${d}`),
    ``,
    `Do you acknowledge and want the signing page opened for exactly this ${s.action}? Reply yes or no.`,
  ].join("\n");
}

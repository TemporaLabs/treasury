/**
 * Did the transaction on chain do what was confirmed? Read from the RECEIPT, never from the
 * transaction envelope, because a smart-account wallet does not send the call itself: it wraps it in
 * a batch that a relayer submits, so `tx.from` and `tx.to` name the relayer and a delegation contract
 * (measured 2026-10-03 on Base: a MetaMask 7702 account, its call executed inside DelegationManager,
 * plus a 0.06 USDC transfer to a third address in the same batch).
 *
 * So the evidence is the event the vault or token itself emits for the connected account — exactly
 * one `Approval`, `Deposit` or `Withdraw` naming that account and that amount — and every OTHER
 * movement of the asset out of the account in the same transaction is reported beside it, never
 * folded into a "matched".
 */
import { getAddress, parseAbiItem, parseEventLogs, type Address, type Hex } from "viem";
import type { ReadClient } from "../client.js";
import type { Admitted } from "./gate.js";

const approvalEvent = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const depositEvent = parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)");
const withdrawEvent = parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)");

export interface Verdict {
  /**
   * `matched`: the expected event is there and nothing else left the account.
   * `extra_transfer`: the expected event is there AND the account also sent the asset elsewhere in
   *   the same transaction (`alsoMoved`) — tell the operator; it was not part of the call.
   * `mismatch`: the transaction succeeded but the expected event is missing.
   * `reverted`: the transaction failed on chain; nothing it was meant to do happened.
   * `unverified`: no receipt within the wait.
   */
  verified: "matched" | "extra_transfer" | "mismatch" | "reverted" | "unverified";
  detail?: string;
  alsoMoved?: { to: string; amountRaw: string }[];
}

const same = (a: string, b: string) => getAddress(a) === getAddress(b);

export async function verifyLanded(
  client: Pick<ReadClient, "getTransactionReceipt">,
  hash: Hex,
  call: Admitted,
  account: Address,
  opts: { attempts?: number; delayMs?: number; deadline?: number } = {},
): Promise<Verdict> {
  const attempts = opts.attempts ?? 30;
  const delayMs = opts.delayMs ?? 2_000;
  let receipt: Awaited<ReturnType<ReadClient["getTransactionReceipt"]>> | undefined;
  // `deadline` (epoch ms) stops the wait when the flow's own time limit is up.
  for (let i = 0; i < attempts && !receipt && (opts.deadline === undefined || Date.now() < opts.deadline); i++) {
    try {
      receipt = await client.getTransactionReceipt({ hash });
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (!receipt) return { verified: "unverified", detail: `no receipt for ${hash} in time; look it up on the explorer before retrying anything` };
  if (receipt.status !== "success") return { verified: "reverted", detail: `${hash} reverted on chain; nothing it was meant to do happened` };

  const vault = call.vault.address;
  const asset = call.vault.asset.address;
  const logs = receipt.logs;
  const fromAsset = logs.filter((l) => same(l.address, asset));
  const fromVault = logs.filter((l) => same(l.address, vault));

  let found = false;
  if (call.kind === "approve") {
    found = parseEventLogs({ abi: [approvalEvent], logs: fromAsset }).some(
      (e) => same(e.args.owner, account) && same(e.args.spender, vault) && e.args.value === call.amount,
    );
  } else if (call.kind === "deposit") {
    found = parseEventLogs({ abi: [depositEvent], logs: fromVault }).some((e) => same(e.args.owner, account) && e.args.assets === call.amount);
  } else {
    found = parseEventLogs({ abi: [withdrawEvent], logs: fromVault }).some(
      (e) =>
        same(e.args.owner, account) &&
        same(e.args.receiver, account) &&
        (call.kind === "withdraw" ? e.args.assets === call.amount : e.args.shares === call.amount),
    );
  }

  // Every movement of the asset OUT of the account that the call itself does not explain. A deposit
  // legitimately moves exactly `amount` to the vault; nothing else should move.
  const expectedPull = call.kind === "deposit" ? call.amount : 0n;
  let pullSeen = false;
  const alsoMoved: { to: string; amountRaw: string }[] = [];
  for (const t of parseEventLogs({ abi: [transferEvent], logs: fromAsset })) {
    if (!same(t.args.from, account)) continue;
    if (!pullSeen && expectedPull > 0n && same(t.args.to, vault) && t.args.value === expectedPull) {
      pullSeen = true;
      continue;
    }
    alsoMoved.push({ to: getAddress(t.args.to), amountRaw: t.args.value.toString() });
  }

  const what = `${call.kind} ${call.amount} raw units on ${call.vault.symbol}`;
  if (!found) {
    return {
      verified: "mismatch",
      detail: `${hash} succeeded, but carries no ${call.kind === "approve" ? "Approval" : call.kind === "deposit" ? "Deposit" : "Withdraw"} event for ${account} matching ${what}. Stop: what landed is not what was confirmed.`,
      ...(alsoMoved.length ? { alsoMoved } : {}),
    };
  }
  if (alsoMoved.length) {
    return {
      verified: "extra_transfer",
      detail: `${what} landed as confirmed, and in the same transaction the account also sent ${call.vault.asset.symbol} elsewhere (alsoMoved). That was not part of the call — often a wallet's own fee for paying gas in tokens. Tell the operator.`,
      alsoMoved,
    };
  }
  return { verified: "matched" };
}

/**
 * How a sent transaction landed, in the words every confirm flow reports it in. On an EVM chain the Tempora API reads
 * the receipt and says how each step landed (`vault-request.ts` maps its answer onto this); on Solana the flow reads
 * the chain itself (`solana.ts`). Either way the evidence is what the vault or token did for the connected account,
 * never the transaction envelope, and every other movement of the asset out of the account is reported beside it.
 */
export interface Verdict {
  /**
   * `matched`: the expected effect is there and nothing else left the account.
   * `extra_transfer`: the expected effect is there AND the account also sent the asset elsewhere in
   *   the same transaction (`alsoMoved`) — tell the operator; it was not part of the call.
   * `mismatch`: the transaction succeeded but the expected effect is missing.
   * `reverted`: the transaction failed on chain; nothing it was meant to do happened.
   * `unverified`: no answer within the wait.
   */
  verified: "matched" | "extra_transfer" | "mismatch" | "reverted" | "unverified";
  detail?: string;
  alsoMoved?: { to: string; amountRaw: string }[];
}

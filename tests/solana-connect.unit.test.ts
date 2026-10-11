/**
 * `treasury connect` on Solana, offline: the sign-in signature check, the landed-transaction check against a
 * scripted RPC, and the acknowledgement for a Solana intent.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, signBytes, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { solanaSignInMessage, verifySolanaLanded, verifySolanaSignIn, type SolanaIntent } from "../src/connect/solana.js";
import { acknowledgementText, solanaIntentDigest, summarizeSolana } from "../src/connect/ack.js";
import { listSolanaVaults } from "../src/registry.js";

const vault = listSolanaVaults()[0]!;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

describe("the Solana sign-in", () => {
  const sign = async (signer: KeyPairSigner, message: string) => b64(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message)));
  const message = solanaSignInMessage({ address: "x", origin: "http://localhost:53682", nonce: "abc", issuedAt: "2026-10-11T00:00:00Z" });

  it("accepts the account's own ed25519 signature over the issued message", async () => {
    const me = await generateKeyPairSigner();
    expect(await verifySolanaSignIn(me.address, message, await sign(me, message))).toBe(true);
  });

  it("refuses another key's signature, a different message, and malformed bytes", async () => {
    const me = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    expect(await verifySolanaSignIn(me.address, message, await sign(other, message))).toBe(false);
    expect(await verifySolanaSignIn(me.address, message, await sign(me, `${message} `))).toBe(false);
    expect(await verifySolanaSignIn(me.address, message, "AAAA")).toBe(false);
  });

  it("the message names the cluster and costs nothing", () => {
    expect(message).toMatch(/sign in with your Solana account/);
    expect(message).toMatch(/Chain ID: mainnet/);
    expect(message).toMatch(/costs no fee and authorizes no transaction/);
  });
});

/** A scripted RPC: the signature's status, then the transaction's token balances. */
function rpc(status: { err?: unknown; confirmationStatus?: string } | null, tx?: { err?: unknown; pre: Bal[]; post: Bal[] }) {
  return {
    getSignatureStatuses: () => ({ send: async () => ({ value: [status] }) }),
    getTransaction: () => ({ send: async () => (tx ? { meta: { err: tx.err ?? null, preTokenBalances: tx.pre, postTokenBalances: tx.post } } : null) }),
  } as never;
}
type Bal = { owner: string; mint: string; uiTokenAmount: { amount: string } };
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const bal = (mint: string, amount: string): Bal => ({ owner: ACCOUNT, mint, uiTokenAmount: { amount } });
const SIG = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const deposit: SolanaIntent = { kind: "deposit", vault, raw: 2_000_000n };
const withdraw: SolanaIntent = { kind: "withdraw", vault, raw: 1_000_000n };
const opts = { attempts: 2, delayMs: 1, deadline: Date.now() + 60_000 };

describe("whether a Solana transaction landed as acknowledged", () => {
  it("a deposit that minted shares and took exactly the amount: matched", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.asset.address, "5000000")], post: [bal(vault.asset.address, "3000000"), bal(vault.sharesMint, "1999999")] }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("matched");
  });

  it("a deposit that took more of the asset than acknowledged: extra_transfer", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "finalized" }, { pre: [bal(vault.asset.address, "5000000")], post: [bal(vault.asset.address, "2500000"), bal(vault.sharesMint, "1999999")] }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("extra_transfer");
  });

  it("a deposit that minted nothing: mismatch", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [], post: [] }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
  });

  it("a withdrawal that burned a different number of shares: mismatch", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.sharesMint, "3000000")], post: [bal(vault.sharesMint, "1000000"), bal(vault.asset.address, "1998000")] }), SIG, withdraw, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
  });

  it("a withdrawal that burned exactly the shares and paid the asset: matched", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.sharesMint, "3000000")], post: [bal(vault.sharesMint, "2000000"), bal(vault.asset.address, "999000")] }), SIG, withdraw, ACCOUNT, opts);
    expect(v.verified).toBe("matched");
  });

  it("a failed transaction: reverted; no status within the wait: unverified, never 'not sent'", async () => {
    expect((await verifySolanaLanded(rpc({ err: { InstructionError: [2, { Custom: 1 }] } }), SIG, deposit, ACCOUNT, opts)).verified).toBe("reverted");
    const v = await verifySolanaLanded(rpc(null), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("unverified");
    expect(v.detail).toMatch(/look the signature up/);
  });
});

describe("the acknowledgement for a Solana intent", () => {
  it("covers the intent, not the bytes: account, vault, action and amount each change it", () => {
    const d = solanaIntentDigest(ACCOUNT, vault.address, "deposit", 1n);
    expect(solanaIntentDigest(ACCOUNT, vault.address, "deposit", 1n)).toBe(d);
    for (const other of [
      solanaIntentDigest("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", vault.address, "deposit", 1n),
      solanaIntentDigest(ACCOUNT, "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", "deposit", 1n),
      solanaIntentDigest(ACCOUNT, vault.address, "withdraw", 1n),
      solanaIntentDigest(ACCOUNT, vault.address, "deposit", 2n),
    ]) {
      expect(other).not.toBe(d);
    }
  });

  it("names Solana's cluster, one wallet prompt, and where the shares go", () => {
    const text = acknowledgementText(summarizeSolana("deposit", vault, "2 USDC", ACCOUNT));
    expect(text).toMatch(/Chain: Solana \(mainnet-beta\)/);
    expect(text).toMatch(/Your wallet will ask you once/);
    expect(text).toMatch(new RegExp(`Shares go to: ${ACCOUNT}`));
    expect(text).toMatch(/WARNING: TEST VAULT/);
    expect(acknowledgementText(summarizeSolana("withdraw", vault, "1 tlCashPlusUSDC2G shares", ACCOUNT))).toMatch(/keeps up to 0\.001 USDC of each withdraw instruction/);
  });
});

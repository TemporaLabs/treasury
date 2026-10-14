/**
 * `treasury connect` on Solana, offline: the sign-in signature check, the landed-transaction check against a
 * scripted RPC, and the acknowledgement for a Solana intent.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, signBytes, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { solanaSignInMessage, verifySolanaLanded, verifySolanaSignIn, type SolanaIntent } from "../src/connect/solana.js";
import { acknowledgementText, solanaIntentDigest, summarizeSolana } from "../src/connect/ack.js";
import { listSolanaVaults } from "../src/registry.js";
import { DISCRIMINATORS } from "../src/solana/kvault.js";
import { KVAULT_PROGRAM_ID } from "../src/solana/constants.js";

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

/** The blockhash the page was handed, and one it was not. */
const BUILT = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const OTHER_BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

/** A scripted RPC: the signature's status, then the transaction's message and token balances. */
function rpc(
  status: { err?: unknown; confirmationStatus?: string } | null,
  tx?: { err?: unknown; pre: Bal[]; post: Bal[]; blockhash?: string; feePayer?: string; withdrawLegs?: number },
) {
  return {
    getSignatureStatuses: () => ({ send: async () => ({ value: [status] }) }),
    getTransaction: () => ({
      send: async () =>
        tx
          ? {
              transaction: {
                message: {
                  recentBlockhash: tx.blockhash ?? BUILT,
                  accountKeys: [tx.feePayer ?? ACCOUNT, KVAULT_PROGRAM_ID],
                  // Each withdraw leg: the kVault program, with the withdraw discriminator and an amount after it.
                  instructions: Array.from({ length: tx.withdrawLegs ?? 0 }, () => ({ programIdIndex: 1, data: getBase58Decoder().decode(new Uint8Array([...DISCRIMINATORS.withdraw, 1, 0, 0, 0, 0, 0, 0, 0])) })),
                },
              },
              meta: { err: tx.err ?? null, preTokenBalances: tx.pre, postTokenBalances: tx.post },
            }
          : null,
    }),
  } as never;
}
type Bal = { accountIndex: number; owner: string; mint: string; uiTokenAmount: { amount: string } };
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
/** The vault's side of a withdrawal (its token vault, or a reserve's supply), and an owner the vault does not pay. */
const VAULT_SIDE = "D6hDbSjoZ7mJ4u2UtsD5X1h9WyTWsZbqdMahLkcmGpmn";
const STRANGER = "8r3bmH59Lp2r5AhfMgKSkXoBf4JFbiwkxa6Uw2ZrxGRp";
/** One token account per owner and mint, so its records before and after the transaction share an index. */
const indexes = new Map<string, number>();
const bal = (mint: string, amount: string, owner = ACCOUNT): Bal => {
  const key = `${owner}:${mint}`;
  if (!indexes.has(key)) indexes.set(key, indexes.size + 2);
  return { accountIndex: indexes.get(key)!, owner, mint, uiTokenAmount: { amount } };
};
const SIG = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const deposit: SolanaIntent = { kind: "deposit", vault, raw: 2_000_000n };
const withdraw: SolanaIntent = { kind: "withdraw", vault, raw: 1_000_000n };
const opts = { attempts: 2, delayMs: 1, deadline: Date.now() + 60_000, built: new Set([BUILT]) };

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
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.sharesMint, "3000000"), bal(vault.asset.address, "5000000", VAULT_SIDE)], post: [bal(vault.sharesMint, "1000000"), bal(vault.asset.address, "1998000"), bal(vault.asset.address, "3002000", VAULT_SIDE)] }), SIG, withdraw, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
  });

  it("a withdrawal that burned exactly the shares and paid the asset: matched", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.sharesMint, "3000000"), bal(vault.asset.address, "5000000", VAULT_SIDE)], post: [bal(vault.sharesMint, "2000000"), bal(vault.asset.address, "999000"), bal(vault.asset.address, "4001000", VAULT_SIDE)] }), SIG, withdraw, ACCOUNT, opts);
    expect(v.verified).toBe("matched");
  });

  it("a deposit that took LESS of the asset than acknowledged: mismatch (a 1-unit mint is not the deposit)", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.asset.address, "5000000")], post: [bal(vault.asset.address, "4999999"), bal(vault.sharesMint, "1")] }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
    expect(v.detail).toMatch(/not the 2 USDC acknowledged/);
  });

  it("a deposit the program rounded down by less than one share's worth: matched (measured on a fork: 1,999,999 of 2,000,000)", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.asset.address, "5000000")], post: [bal(vault.asset.address, "3000001"), bal(vault.sharesMint, "1999679")] }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified, v.detail).toBe("matched");
  });

  it("a deposit short by more than one share's worth: mismatch", async () => {
    // At a share price of 1, ten base units short is ten shares' worth.
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.asset.address, "5000000")], post: [bal(vault.asset.address, "3000010"), bal(vault.sharesMint, "1999990")] }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
    expect(v.detail).toMatch(/fell by 1\.99999 USDC, not the 2 USDC acknowledged/);
  });

  it("a withdrawal short by up to one share unit per withdraw instruction is rounding: matched; by more, or with no withdraw instruction, mismatch", async () => {
    const landed = (burnedTo: string, withdrawLegs: number) =>
      verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.sharesMint, "3000000"), bal(vault.asset.address, "5000000", VAULT_SIDE)], post: [bal(vault.sharesMint, burnedTo), bal(vault.asset.address, "999000"), bal(vault.asset.address, "4001000", VAULT_SIDE)], withdrawLegs }), SIG, withdraw, ACCOUNT, opts);
    expect((await landed("2000001", 1)).verified).toBe("matched");
    expect((await landed("2000002", 2)).verified).toBe("matched");
    expect((await landed("2000002", 1)).verified).toBe("mismatch");
    expect((await landed("2000001", 0)).verified).toBe("mismatch");
    expect((await landed("1999999", 1)).verified).toBe("mismatch");
  });

  it("shares arriving with no asset leaving (a plain share transfer in): mismatch", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.sharesMint, "0")], post: [bal(vault.sharesMint, "5")] }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
  });

  it("a transaction this page did not build (another blockhash): mismatch, whatever its balances say", async () => {
    const exact = { pre: [bal(vault.asset.address, "5000000")], post: [bal(vault.asset.address, "3000000"), bal(vault.sharesMint, "1999999")] };
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { ...exact, blockhash: OTHER_BLOCKHASH }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
    expect(v.detail).toMatch(/not the transaction this page built/);
    // The same balances under the built blockhash are the deposit.
    expect((await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, exact), SIG, deposit, ACCOUNT, opts)).verified).toBe("matched");
    // With nothing built yet, nothing can match.
    expect((await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, exact), SIG, deposit, ACCOUNT, { ...opts, built: new Set<string>() })).verified).toBe("mismatch");
  });

  it("a transaction paid for by another account: mismatch", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.asset.address, "5000000")], post: [bal(vault.asset.address, "3000000"), bal(vault.sharesMint, "1999999")], feePayer: "11111111111111111111111111111112" }), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
  });

  it("a withdrawal this page did not build: mismatch, even with the exact burn", async () => {
    const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [bal(vault.sharesMint, "3000000"), bal(vault.asset.address, "5000000", VAULT_SIDE)], post: [bal(vault.sharesMint, "2000000"), bal(vault.asset.address, "999000"), bal(vault.asset.address, "4001000", VAULT_SIDE)], blockhash: OTHER_BLOCKHASH }), SIG, withdraw, ACCOUNT, opts);
    expect(v.verified).toBe("mismatch");
  });

  it("a failed transaction: reverted; no status within the wait: unverified, never 'not sent'", async () => {
    expect((await verifySolanaLanded(rpc({ err: { InstructionError: [2, { Custom: 1 }] } }), SIG, deposit, ACCOUNT, opts)).verified).toBe("reverted");
    const v = await verifySolanaLanded(rpc(null), SIG, deposit, ACCOUNT, opts);
    expect(v.verified).toBe("unverified");
    expect(v.detail).toMatch(/look the signature up/);
  });

  describe("what a landed withdrawal paid, from every account of the asset", () => {
    /** A one-leg withdrawal of 1,000,000 shares: the vault's side falls by `paid`, the account and anyone else rise. */
    const landed = (o: { paid: string; own: string; others?: [string, string][]; vaultAfter?: string; intent?: SolanaIntent; simulated?: bigint }) => {
      const vaultBefore = 5_000_000n;
      const pre = [bal(vault.sharesMint, "3000000"), bal(vault.asset.address, "0"), bal(vault.asset.address, vaultBefore.toString(), VAULT_SIDE), ...(o.others ?? []).map(([owner]) => bal(vault.asset.address, "0", owner))];
      const post = [
        bal(vault.sharesMint, "2000000"),
        bal(vault.asset.address, o.own),
        bal(vault.asset.address, o.vaultAfter ?? (vaultBefore - BigInt(o.paid)).toString(), VAULT_SIDE),
        ...(o.others ?? []).map(([owner, amount]) => bal(vault.asset.address, amount, owner)),
      ];
      return verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre, post, withdrawLegs: 1 }), SIG, o.intent ?? withdraw, ACCOUNT, { ...opts, ...(o.simulated !== undefined ? { simulated: new Map([[BUILT, o.simulated]]) } : {}) });
    };

    it("all of it reaching the account: matched, and the detail names what it received", async () => {
      const v = await landed({ paid: "999000", own: "999000" });
      expect(v.verified, v.detail).toBe("matched");
      expect(v.detail).toMatch(/received 0\.999 USDC/);
      expect(v.detail).toMatch(/SOL the transaction moved is not checked/);
    });

    it("part of it sent on to another owner in the same transaction: extra_transfer, naming the owner and the amount", async () => {
      const v = await landed({ paid: "999000", own: "994000", others: [[STRANGER, "5000"]] });
      expect(v.verified).toBe("extra_transfer");
      expect(v.alsoMoved).toEqual([{ to: STRANGER, amountRaw: "5000" }]);
      expect(v.detail).toMatch(/paid 0\.999 USDC, and in the same transaction 0\.005 USDC of it went to another owner/);
    });

    it("balances that do not add up (the account rose by more than the vault's side fell): mismatch", async () => {
      const v = await landed({ paid: "500000", own: "999000" });
      expect(v.verified).toBe("mismatch");
      expect(v.detail).toMatch(/do not add up: they rose by 0\.499 USDC in total/);
    });

    it("a withdrawal by amount paid less than acknowledged, beyond the 0.001 USDC Kamino keeps per instruction: mismatch; within it, or more: matched", async () => {
      const byAmount: SolanaIntent = { ...withdraw, assets: 1_000_000n };
      expect((await landed({ paid: "999000", own: "999000", intent: byAmount })).verified).toBe("matched");
      expect((await landed({ paid: "1000700", own: "1000700", intent: byAmount })).verified).toBe("matched");
      const short = await landed({ paid: "998999", own: "998999", intent: byAmount });
      expect(short.verified).toBe("mismatch");
      expect(short.detail).toMatch(/paid 0\.998999 USDC, less than the 1 USDC acknowledged/);
      // What went on to another owner counts as paid: the shortfall is not hidden as a smaller withdrawal.
      expect((await landed({ paid: "999000", own: "994000", others: [[STRANGER, "5000"]], intent: byAmount })).verified).toBe("extra_transfer");
    });

    it("paying less than the simulation of this same transaction, beyond rounding: mismatch; as much or more: matched", async () => {
      expect((await landed({ paid: "999000", own: "999000", simulated: 999_001n })).verified).toBe("matched");
      expect((await landed({ paid: "999100", own: "999100", simulated: 999_000n })).verified).toBe("matched");
      const v = await landed({ paid: "999000", own: "999000", simulated: 999_002n });
      expect(v.verified).toBe("mismatch");
      expect(v.detail).toMatch(/less than the 0\.999002 USDC its simulation before sending paid/);
    });

    it("an account that held the asset before and has no record after: unverified, never a balance that fell to 0", async () => {
      const pre = [bal(vault.sharesMint, "3000000"), bal(vault.asset.address, "0"), bal(vault.asset.address, "5000000", VAULT_SIDE), bal(vault.asset.address, "7000", STRANGER)];
      const post = [bal(vault.sharesMint, "2000000"), bal(vault.asset.address, "999000"), bal(vault.asset.address, "4001000", VAULT_SIDE)];
      const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre, post, withdrawLegs: 1 }), SIG, withdraw, ACCOUNT, opts);
      expect(v.verified).toBe("unverified");
      expect(v.detail).toMatch(/no balance after it for an account of 8r3bmH59/);
    });

    it("an empty account closed in the transaction is not a payment: matched", async () => {
      const pre = [bal(vault.sharesMint, "3000000"), bal(vault.asset.address, "0"), bal(vault.asset.address, "5000000", VAULT_SIDE), bal(vault.asset.address, "0", STRANGER)];
      const post = [bal(vault.sharesMint, "2000000"), bal(vault.asset.address, "999000"), bal(vault.asset.address, "4001000", VAULT_SIDE)];
      const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre, post, withdrawLegs: 1 }), SIG, withdraw, ACCOUNT, opts);
      expect(v.verified, v.detail).toBe("matched");
    });

    it("records with no owner, or none at all: unverified, never matched", async () => {
      const noOwner = { ...bal(vault.asset.address, "4001000", VAULT_SIDE), owner: undefined as unknown as string };
      const pre = [bal(vault.sharesMint, "3000000"), bal(vault.asset.address, "0"), bal(vault.asset.address, "5000000", VAULT_SIDE)];
      const v = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: pre.slice(0, 2), post: [bal(vault.sharesMint, "2000000"), bal(vault.asset.address, "999000"), noOwner], withdrawLegs: 1 }), SIG, withdraw, ACCOUNT, opts);
      expect(v.verified).toBe("unverified");
      // A record that does not name its account cannot be paired with its other half: before or after.
      const unindexed = ({ accountIndex: _i, ...rest }: Bal) => rest as Bal;
      const post = [bal(vault.sharesMint, "2000000"), bal(vault.asset.address, "999000"), bal(vault.asset.address, "4001000", VAULT_SIDE)];
      for (const [p, q] of [[pre.map((b, i) => (i === 2 ? unindexed(b) : b)), post], [pre, post.map((b, i) => (i === 2 ? unindexed(b) : b))]] as const) {
        const u = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: [...p], post: [...q], withdrawLegs: 1 }), SIG, withdraw, ACCOUNT, opts);
        expect(u.verified).toBe("unverified");
        expect(u.detail).toMatch(/do not name their accounts/);
      }
      const none = await verifySolanaLanded(rpc({ confirmationStatus: "confirmed" }, { pre: undefined as never, post: undefined as never, withdrawLegs: 1 }), SIG, withdraw, ACCOUNT, opts);
      expect(none.verified).toBe("unverified");
      expect(none.detail).toMatch(/no token-balance records/);
    });
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

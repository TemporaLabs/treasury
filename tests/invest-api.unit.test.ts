/**
 * `src/invest/api.ts` and `invest products`, against a stand-in client: no network, no wallet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import type { Client } from "@temporalabs/client";
import { apiHost, apiUrl, asOwner, tokenKeyFor } from "../src/invest/api.js";
import { buildInvestCommands } from "../src/invest/commands.js";
import { readOwnerToken } from "../src/connect/owner-tokens.js";

const OWNER = getAddress("0x52908400098527886e0f7030069857d2e4169ee7");
const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const HOST = "api-test.temporalabs.com";
const iso = (ms: number) => new Date(ms).toISOString();
const message = (o: { host?: string; owner?: string; client?: string } = {}) =>
  [
    "Tempora gateway sign-in",
    `Host: ${o.host ?? HOST}`,
    `Client: ${o.client ?? "treasury-cli"}`,
    `Owner: ${o.owner ?? OWNER}`,
    "Nonce: 0123456789abcdef0123456789abcdef",
    `Issued: ${iso(NOW)}   Expires: ${iso(NOW + 300_000)}`,
  ].join("\n");

type Calls = { challenges: number; verifies: { audience?: string }[]; positions: string[] };

/** A stand-in for the client: answers sign-in and `positions`, refusing a token it did not issue. */
function stub(o: { message?: string; issued?: string[] } = {}) {
  const calls: Calls = { challenges: 0, verifies: [], positions: [] };
  const issued = [...(o.issued ?? ["tok-1", "tok-2"])];
  const valid = new Set<string>();
  const client = {
    sign_in_challenge: async () => {
      calls.challenges += 1;
      return { ok: true, status: 200, body: { message: o.message ?? message(), nonce: "n", expiresAt: iso(NOW + 300_000) } };
    },
    sign_in_verify: async (input: { body: { audience?: string } }) => {
      calls.verifies.push({ audience: input.body.audience });
      const token = issued.shift()!;
      valid.add(token);
      return { ok: true, status: 200, body: { token, tokenType: "Bearer", expiresAt: iso(NOW + 12 * 3_600_000) } };
    },
    positions: async (_i: unknown, opts: { ownerToken?: string }) => {
      calls.positions.push(opts.ownerToken ?? "");
      return valid.has(opts.ownerToken ?? "")
        ? { ok: true, status: 200, body: { positions: [] } }
        : { ok: false, status: 401, error: { code: "wallet_proof_required", message: "Sign in with your wallet again.", outcome: "failed" } };
    },
  } as unknown as Client;
  return { client, calls, valid };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "treasury-invest-"));
  process.env["TREASURY_CONNECT_HOME"] = home;
  process.env["TREASURY_API_URL"] = `https://${HOST}`;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env["TREASURY_CONNECT_HOME"];
  delete process.env["TREASURY_API_URL"];
});

describe("the API address", () => {
  it("is the pinned one unless TREASURY_API_URL names another, and the sign-in host follows it", () => {
    delete process.env["TREASURY_API_URL"];
    expect(apiUrl()).toBe("https://api.temporalabs.com");
    expect(apiHost()).toBe("api.temporalabs.com");
    process.env["TREASURY_API_URL"] = `https://${HOST}`;
    expect(apiHost()).toBe(HOST);
  });
});

describe("an owner call", () => {
  const signer = (signed: string[]) => async (_owner: string, m: string) => {
    signed.push(m);
    return "0xsig";
  };
  const positions = (c: Client, t: string) => c.positions({}, { ownerToken: t });

  it("signs in when no token is kept, asks for an HTTP token, keeps it, and reuses it next time", async () => {
    const { client, calls } = stub();
    const signed: string[] = [];
    expect((await asOwner(OWNER, signer(signed), positions, { client, now: () => NOW })).ok).toBe(true);
    expect(signed).toHaveLength(1);
    expect(calls.verifies).toEqual([{ audience: "http" }]);
    expect(readOwnerToken(tokenKeyFor(OWNER), NOW)).toBe("tok-1");
    expect((await asOwner(OWNER, signer(signed), positions, { client, now: () => NOW })).ok).toBe(true);
    expect(signed).toHaveLength(1);
    expect(calls.positions).toEqual(["tok-1", "tok-1"]);
  });

  it("signs in once more when the API refuses the kept token, and keeps the new one", async () => {
    const first = stub();
    await asOwner(OWNER, signer([]), positions, { client: first.client, now: () => NOW });
    const second = stub({ issued: ["tok-9"] }); // a server that no longer knows tok-1
    const signed: string[] = [];
    expect((await asOwner(OWNER, signer(signed), positions, { client: second.client, now: () => NOW })).ok).toBe(true);
    expect(second.calls.positions).toEqual(["tok-1", "tok-9"]);
    expect(signed).toHaveLength(1);
    expect(readOwnerToken(tokenKeyFor(OWNER), NOW)).toBe("tok-9");
  });

  it("forgets a token the API refused, even when signing in again does not complete", async () => {
    await asOwner(OWNER, signer([]), positions, { client: stub().client, now: () => NOW });
    expect(readOwnerToken(tokenKeyFor(OWNER), NOW)).toBe("tok-1");
    // A server that no longer knows tok-1, whose new sign-in message names another host: nothing is signed.
    const { client } = stub({ message: message({ host: "api.example.com" }) });
    const r = await asOwner(OWNER, signer([]), positions, { client, now: () => NOW });
    expect(r).toMatchObject({ ok: false, error: { code: "challenge_refused" } });
    expect(readOwnerToken(tokenKeyFor(OWNER), NOW)).toBeUndefined();
  });

  it.each([
    ["another host", message({ host: "api.example.com" })],
    ["another owner", message({ owner: "0x0000000000000000000000000000000000000001" })],
    ["another client", message({ client: "acme" })],
  ])("never asks the wallet to sign a sign-in message naming %s", async (_n, m) => {
    const { client, calls } = stub({ message: m });
    const signed: string[] = [];
    const r = await asOwner(OWNER, signer(signed), positions, { client, now: () => NOW });
    expect(r).toMatchObject({ ok: false, error: { code: "challenge_refused" } });
    expect(signed).toEqual([]);
    expect(calls.verifies).toEqual([]);
    expect(readOwnerToken(tokenKeyFor(OWNER), NOW)).toBeUndefined();
  });
});

describe("invest products", () => {
  it("lists only the portfolios, with what the API says about each", async () => {
    const product = (id: string, kind: string) => ({ id, kind, name: id, status: "live", chains: ["eip155:56"], tokens: ["USDT"], minimum: { firstDepositUsd: "100", topUpUsd: "50" }, amountForms: { deposit: ["assets"], withdraw: ["all"] }, steps: { deposit: ["send_transaction"], withdraw: ["sign_typed_data+"] } });
    const client = { products: async () => ({ ok: true, status: 200, body: { products: [product("sg-1", "portfolio"), product("vault-1", "vault")] } }) } as unknown as Client;
    const out = JSON.parse(await buildInvestCommands({ client })["invest_products"]!.handler({} as never));
    expect(out.api).toBe(`https://${HOST}`);
    expect(out.portfolios.map((p: { id: string }) => p.id)).toEqual(["sg-1"]);
    expect(out.portfolios[0].minimum).toEqual({ firstDepositUsd: "100", topUpUsd: "50" });
  });

  it("reports an API refusal as an error, never as an empty list", async () => {
    const client = { products: async () => ({ ok: false, status: 503, error: { code: "upstream_unavailable", message: "down", outcome: "failed" }, retryAfter: 5 }) } as unknown as Client;
    await expect(buildInvestCommands({ client })["invest_products"]!.handler({} as never)).rejects.toThrow(/upstream_unavailable.*Try again in 5 s/);
  });
});

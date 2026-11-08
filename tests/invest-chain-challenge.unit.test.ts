/**
 * `src/invest/chain.ts` (BNB Chain holdings) and `src/invest/challenge.ts` (the sign-in challenge), offline.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { BNB_INFO, BNB_USDT, bnbRpcUrlFromEnv, readHoldings, type BalanceReader } from "../src/invest/chain.js";
import { checkChallenge } from "../src/invest/challenge.js";

const OWNER = getAddress("0x52908400098527886e0f7030069857d2e4169ee7"); // mixed case once checksummed
const STOCK = getAddress("0x3333333333333333333333333333333333333333");

describe("BNB Chain holdings", () => {
  afterEach(() => {
    for (const k of BNB_INFO.rpcEnv) delete process.env[k];
  });

  it("reads each token's balance once, after the endpoint says it is chain 56", async () => {
    const asked: Address[] = [];
    const client: BalanceReader = {
      getChainId: async () => 56,
      readContract: async ({ address, args }) => {
        asked.push(address);
        expect(args[0]).toBe(OWNER);
        return address === STOCK ? 7n : 3n;
      },
    };
    const h = await readHoldings(client, OWNER, [STOCK, BNB_USDT.address, STOCK.toLowerCase() as Address]);
    expect(asked).toEqual([STOCK, BNB_USDT.address]);
    expect([...h]).toEqual([
      [STOCK, 7n],
      [BNB_USDT.address, 3n],
    ]);
  });

  it("refuses an endpoint for another chain before reading any balance", async () => {
    let reads = 0;
    const client: BalanceReader = { getChainId: async () => 1, readContract: async () => (reads++, 0n) };
    await expect(readHoldings(client, OWNER, [STOCK])).rejects.toThrow(/answered chain 1/);
    expect(reads).toBe(0);
  });

  it("takes its own variables first, then the public endpoint", () => {
    expect(bnbRpcUrlFromEnv()).toBe(BNB_INFO.publicRpc);
    process.env["BNB_RPC_URL"] = "https://second.example";
    expect(bnbRpcUrlFromEnv()).toBe("https://second.example");
    process.env["TREASURY_RPC_BNB"] = "https://first.example";
    expect(bnbRpcUrlFromEnv()).toBe("https://first.example");
  });
});

describe("the sign-in challenge", () => {
  const HOST = "mcp.example.com";
  const NOW = Date.parse("2026-11-08T12:00:00Z");
  const good = (o: Partial<Record<"first" | "host" | "client" | "owner" | "nonce" | "times", string>> = {}) =>
    [
      o.first ?? "Tempora gateway sign-in",
      o.host ?? `Host: ${HOST}`,
      o.client ?? "Client: treasury-cli",
      o.owner ?? `Owner: ${OWNER}`,
      o.nonce ?? "Nonce: abcDEF0123456789",
      o.times ?? "Issued: 2026-11-08T11:59:00Z   Expires: 2026-11-08T12:04:00Z",
    ].join("\n");
  const check = (text: unknown) => checkChallenge(text, { host: HOST, owner: OWNER, now: NOW });

  it("admits the exact six-line message", () => {
    expect(check(good())).toEqual({
      nonce: "abcDEF0123456789",
      issuedAt: new Date("2026-11-08T11:59:00Z"),
      expiresAt: new Date("2026-11-08T12:04:00Z"),
    });
  });

  it.each<[string, unknown, RegExp]>([
    ["not text", 5, /not text/],
    ["a seventh line", `${good()}\nextra`, /six-line/],
    ["a trailing newline", `${good()}\n`, /six-line/],
    ["CRLF line ends", good().replace(/\n/g, "\r\n"), /six-line|sign-in line/],
    ["another first line", good({ first: "Sign in to example.com" }), /sign-in line/],
    ["another host", good({ host: "Host: evil.example" }), /another host|host other/],
    ["another client", good({ client: "Client: browser" }), /another client/],
    ["another owner", good({ owner: "Owner: 0x2222222222222222222222222222222222222222" }), /connected wallet/],
    ["the owner not checksummed", good({ owner: `Owner: ${OWNER.toLowerCase()}` }), /connected wallet/],
    ["a short nonce", good({ nonce: "Nonce: abc" }), /nonce/],
    ["a nonce with symbols", good({ nonce: "Nonce: abcdefghijklmno!" }), /nonce/],
    ["a lifetime over 5 minutes", good({ times: "Issued: 2026-11-08T11:59:00Z   Expires: 2026-11-08T12:04:01Z" }), /longer than 5 minutes/],
    ["expiry before issue", good({ times: "Issued: 2026-11-08T12:01:00Z   Expires: 2026-11-08T12:00:30Z" }), /before it is issued/],
    ["issued in the future", good({ times: "Issued: 2026-11-08T12:02:00Z   Expires: 2026-11-08T12:05:00Z" }), /future/],
    ["expired", good({ times: "Issued: 2026-11-08T11:54:00Z   Expires: 2026-11-08T11:59:00Z" }), /expired/],
    ["a local time", good({ times: "Issued: 2026-11-08T11:59:00+01:00   Expires: 2026-11-08T12:04:00+01:00" }), /times/],
  ])("refuses %s", (_why, text, msg) => {
    expect(() => check(text)).toThrow(msg);
  });
});

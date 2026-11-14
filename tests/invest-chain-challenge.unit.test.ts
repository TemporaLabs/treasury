/**
 * `src/invest/chain.ts` (BNB Chain's fixed facts) and `src/invest/challenge.ts` (the sign-in challenge), offline.
 */
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { assetIdOf, BNB_USDT, BNB_USDT_ASSET_ID } from "../src/invest/chain.js";
import { checkChallenge } from "../src/invest/challenge.js";

const OWNER = getAddress("0x52908400098527886e0f7030069857d2e4169ee7"); // mixed case once checksummed

describe("BNB Chain's fixed facts", () => {
  it("names USDT in the CAIP-19 form an authorization and the API use", () => {
    expect(BNB_USDT_ASSET_ID).toBe("eip155:56/erc20:0x55d398326f99059fF775485246999027B3197955");
    expect(assetIdOf(BNB_USDT.address.toLowerCase() as `0x${string}`)).toBe(BNB_USDT_ASSET_ID);
  });
});

describe("the sign-in challenge", () => {
  const HOST = "mcp.example.com";
  const NOW = Date.parse("2026-11-08T12:00:00Z");
  const good = (o: Partial<Record<"first" | "host" | "client" | "owner" | "nonce" | "times", string>> = {}) =>
    [
      o.first ?? "Tempora sign-in",
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
    // The API's earlier first line: a message of the old form is refused too, never read as the same message.
    ["the earlier first line", good({ first: "Tempora gateway sign-in" }), /sign-in line/],
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

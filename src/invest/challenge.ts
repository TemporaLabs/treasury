/**
 * The sign-in challenge the owner signs with `personal_sign` to prove they hold the wallet, before
 * any `invest` call that acts for them. It is a fixed plain-text message, not Sign-In with Ethereum:
 * a wallet compares a SIWE domain with the page's origin, and treasury's signing page is a loopback
 * page, so every SIWE message would warn.
 *
 * A server could hand over any text to be signed, including a message that is valid somewhere else.
 * So the page signs only a challenge of exactly this shape, every line checked:
 *
 *     Tempora sign-in
 *     Host: <the pinned host>
 *     Client: treasury-cli
 *     Owner: <the connected address, checksummed>
 *     Nonce: <16 to 64 letters or digits>
 *     Issued: <ISO time>   Expires: <ISO time, at most 5 minutes after Issued>
 *
 * Six lines joined by "\n", nothing before or after. The host is the one this release pins, never one
 * the server names.
 */
import { getAddress, type Address } from "viem";

export const CHALLENGE_FIRST_LINE = "Tempora sign-in";
export const CHALLENGE_CLIENT = "treasury-cli";
/** The longest a challenge may stay valid. */
export const CHALLENGE_MAX_LIFETIME_MS = 5 * 60_000;
/** How far a challenge's issue time may sit ahead of this machine's clock. */
const CLOCK_SKEW_MS = 60_000;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface Challenge {
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function checkChallenge(text: unknown, expect: { host: string; owner: Address; now: number }): Challenge {
  const refuse = (why: string): never => {
    throw new Error(`refused: the sign-in challenge ${why}; nothing was signed`);
  };
  if (typeof text !== "string") return refuse("is not text");
  const lines = text.split("\n");
  if (lines.length !== 6) refuse("is not the six-line sign-in message");
  const [first, host, client, owner, nonce, times] = lines as [string, string, string, string, string, string];
  if (first !== CHALLENGE_FIRST_LINE) refuse("does not start with the sign-in line");
  if (host !== `Host: ${expect.host}`) refuse(`names a host other than ${expect.host}`);
  if (client !== `Client: ${CHALLENGE_CLIENT}`) refuse("names another client");
  if (owner !== `Owner: ${getAddress(expect.owner)}`) refuse(`is not for the connected wallet ${getAddress(expect.owner)}`);
  const n = /^Nonce: ([A-Za-z0-9]{16,64})$/.exec(nonce);
  if (!n) refuse("carries no valid nonce");
  const t = /^Issued: (\S+) {3}Expires: (\S+)$/.exec(times);
  if (!t || !ISO.test(t[1]!) || !ISO.test(t[2]!)) refuse("carries no valid issue and expiry times");
  const issued = Date.parse(t![1]!);
  const expires = Date.parse(t![2]!);
  if (!(expires > issued)) refuse("expires before it is issued");
  if (expires - issued > CHALLENGE_MAX_LIFETIME_MS) refuse("is valid for longer than 5 minutes");
  if (issued > expect.now + CLOCK_SKEW_MS) refuse("is issued in the future");
  if (expires <= expect.now) refuse("has expired");
  return { nonce: n![1]!, issuedAt: new Date(issued), expiresAt: new Date(expires) };
}

/**
 * The one place `invest` reaches the Tempora API: through `@temporalabs/client`, never through a second HTTP client.
 *
 * `invest` calls the API with no client key: the caller is a wallet owner using this command line on their own
 * machine. The API's address is pinned (`INVEST.apiUrl`); `TREASURY_API_URL` points it at another deployment, such
 * as the test one, and must still be https (the client refuses plain http to any host but this machine). The host it
 * names is the one the sign-in message must carry, so a message naming any other host is never signed.
 */
import { createClient, signIn, withOwnerRetry, type Client, type Result, type SignedIn } from "@temporalabs/client";
import { getAddress, type Address } from "viem";
import { INVEST } from "../config/invest.js";
import { checkChallenge, CHALLENGE_CLIENT } from "./challenge.js";
import { clearOwnerToken, readOwnerToken, writeOwnerToken, type TokenKey } from "../connect/owner-tokens.js";

/** The API's base URL: the pinned one, or `TREASURY_API_URL`. */
export function apiUrl(): string {
  const v = (process.env["TREASURY_API_URL"] ?? "").trim();
  return v.length > 0 && !v.includes("${") ? v : INVEST.apiUrl;
}

/** The host the sign-in message must name: the host of the URL the calls go to. */
export const apiHost = (): string => new URL(apiUrl()).host;

/** A client for the API, with no client key. Throws a TypeError for a URL the client refuses. */
export const apiClient = (): Client => createClient({ baseUrl: apiUrl(), timeoutMs: INVEST.apiTimeoutMs });

/**
 * The key an owner's token is kept under: this host, no client key, this owner, and both of the API's doors. One sign-in
 * serves `invest` (the HTTP routes) and `earn` (the MCP endpoint).
 */
export const tokenKeyFor = (owner: Address): TokenKey => ({ host: apiHost(), clientId: CHALLENGE_CLIENT, owner, audience: "both" });

/** Why a call to the API did not answer as asked, as one line for the operator. Never contains a token. */
export function failure(what: string, r: Extract<Result<unknown>, { ok: false }>): Error {
  const e = r.error;
  const retry = r.retryAfter !== undefined ? ` Try again in ${r.retryAfter} s.` : "";
  const trace = r.traceId ? ` (trace ${r.traceId})` : "";
  return new Error(`${what}: ${e.code}: ${e.message}${retry}${trace}`);
}

/** The refusal for an owner call with no wallet connected: the connected wallet is the only owner either command acts for. */
export const notConnected = (): Error => new Error("no wallet is connected — run `treasury connect wallet` first, and let the operator sign in");

/** Has the owner's wallet sign a message, and returns the signature. The connect page provides it. */
export type MessageSigner = (owner: Address, message: string) => Promise<string>;

/**
 * Runs one owner call with the owner's kept token. When there is none, or the API answers `wallet_proof_required`
 * (expired, signed out, or made for another door or client), it signs in once and runs the call once more: the
 * client's `withOwnerRetry`. The sign-in message is checked line by line (`checkChallenge`) against this host and
 * this owner before the wallet is asked to sign anything.
 */
export async function asOwner<T>(
  ownerInput: string,
  signMessage: MessageSigner,
  call: (client: Client, token: string) => Promise<Result<T>>,
  deps: { client?: Client; now?: () => number } = {},
): Promise<Result<T>> {
  const client = deps.client ?? apiClient();
  return withOwner(ownerInput, signMessage, (token) => call(client, token), { ...deps, client });
}

/**
 * `asOwner` for a call made through any of the API's clients (the MCP one, for `earn`): `call` gets the owner's token.
 * The sign-in itself always goes through the HTTP client, `deps.client`, since it is not an MCP tool.
 */
export async function withOwner<T>(
  ownerInput: string,
  signMessage: MessageSigner,
  call: (token: string) => Promise<Result<T>>,
  deps: { client?: Client; now?: () => number } = {},
): Promise<Result<T>> {
  const owner = getAddress(ownerInput);
  const client = deps.client ?? apiClient();
  const now = deps.now ?? Date.now;
  const key = tokenKeyFor(owner);
  const host = apiHost();
  const kept = readOwnerToken(key, now());
  const fresh = (): Promise<Result<SignedIn>> => {
    // A token the API refused is forgotten before the new sign-in, so a failed sign-in never leaves it to be tried again.
    clearOwnerToken(key);
    return signIn(client, {
      owner,
      signMessage: (message: string) => signMessage(owner, message),
      // The client goes on only when this returns true; `checkChallenge` throws on anything it refuses.
      check: (message: string) => {
        checkChallenge(message, { host, owner, now: now() });
        return true;
      },
      audience: "both",
    });
  };
  return withOwnerRetry(
    {
      ...(kept !== undefined && { token: kept }),
      signIn: fresh,
      onSignIn: (s) => writeOwnerToken(key, { token: s.token, expiresAtIso: s.expiresAt }, now()),
    },
    call,
  );
}

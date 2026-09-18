/**
 * Describe an error for a tool result WITHOUT leaking the RPC endpoint.
 *
 * viem's error messages embed the transport URL (`URL: https://…/v2/<key>`) and the request body. A
 * keyed provider URL (Alchemy, Infura) IS a secret, and every tool handler's failure path would
 * otherwise paste it into the model's context — measured in the first review of this package:
 * `preflightDeposit` with a fake Alchemy key → `findings[]` contained the key verbatim.
 *
 * Preference order: viem's own `shortMessage` (never carries the URL), followed by viem's `details`
 * when present — that is where a JSON-RPC error body's own sentence lives (a provider at its monthly
 * cap says "Monthly capacity limit exceeded" there, and `shortMessage` alone is the useless
 * "RPC Request failed."; measured in review) → the first line of the message with any `URL:` /
 * `Request body:` / `http(s)://…` content masked → the error's name.
 */
export function describeError(e: unknown, max = 200): string {
  const anyE = e as { shortMessage?: unknown; details?: unknown; message?: unknown; name?: unknown } | null;
  let s: string;
  if (anyE && typeof anyE.shortMessage === "string" && anyE.shortMessage.length > 0) {
    s = anyE.shortMessage;
    if (typeof anyE.details === "string" && anyE.details.length > 0 && !s.includes(anyE.details)) s = `${s} ${anyE.details}`;
  } else if (anyE && typeof anyE.message === "string" && anyE.message.length > 0) s = anyE.message;
  else s = String(e);
  s = redactEndpoints(s);
  const firstLine = s.split("\n").find((l) => l.trim().length > 0) ?? s;
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

/**
 * The VALUES we are protecting, supplied by whoever resolved them. Registered rather than passed,
 * so every existing `redactEndpoints`/`describeError` call site is covered without threading a
 * parameter through the library. A FUNCTION, not an array: the environment can change inside a
 * process (tests do it), and a snapshot taken at import time would go stale.
 */
let secretSource: () => readonly string[] = () => [];

/** Register the source of known-secret values. Called by the MCP server at build time. */
export function registerSecretSource(f: () => readonly string[]): void {
  secretSource = f;
}

/**
 * Mask literal secret VALUES wherever they appear, in any shape.
 *
 * 🔴 This is the PRIMARY defence and the pattern rules below are the backstop — the inverse of the
 * original design, which had only a backstop. Measured by review against a real viem client
 * and a real HTTP server: a provider that rejects a key and ECHOES IT BACK in the response body
 * puts it in viem's `Details:` line as prose inside JSON — no scheme, no errno, no header keyword,
 * so every shape rule misses it and the key reaches tool output. Patterns chase shapes forever;
 * that was the third new shape in one day. We KNOW the value (`rpcUrlFromEnv` resolved it), so we
 * match on the literal we are protecting instead of on where we guessed it would sit.
 *
 * Short values are ignored: a 2-character path segment like `v2` is not a secret and masking it
 * would destroy every message it appears in.
 *
 * ⚠️ THE BOUNDARY IS CHOSEN, NOT MISSED. Value matching masks the literal and its percent-decoded
 * form. It does NOT mask an arbitrary re-encoding — an upper-cased key, a base64 of the key, or one
 * split across whitespace. No implementation can, and attempting it would over-redact wildly; those
 * are the residual the shape rules below exist for (review).
 *
 * ⚠️ VALUE MASKING IS A PROPERTY OF THE SERVER, NOT OF THIS LIBRARY. `registerSecretSource` is
 * called by the MCP server in `buildServer()`. A consumer importing `describeError`/`redactEndpoints`
 * directly gets `secretSource = () => []` and therefore the shape rules only — which degrades safely
 * and is the documented backstop, but is not inherited.
 */
export function redactSecrets(s: string, secrets: readonly string[] = secretSource()): string {
  let out = s;
  for (const sec of secrets) {
    if (!sec || sec.length < 8) continue;
    out = out.split(sec).join("<redacted>"); // split/join: no regex escaping hazard
  }
  return out;
}

/** Mask every http(s) URL and the viem `URL:` / `Request body:` lines in a string. Exported for the tool boundary. */
export function redactEndpoints(s: string): string {
  return redactSecrets(s)
    // ANY scheme://… — not just http(s). A ws:// or wss:// endpoint carries the same key.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)\]]+/gi, "<rpc endpoint>")
    // DNS and socket failures name a BARE host, sometimes with the keyed path still attached
    // (`getaddrinfo ENOTFOUND base-mainnet.g.alchemy.com/v2/KEY`) — no scheme for the rule above.
    // ⚠️ The token after an errno must be HOST-SHAPED. `\S+` ate whatever followed: `ETIMEDOUT
    // after 30000ms` became `ETIMEDOUT <rpc endpoint> 30000ms`, fabricating a redaction in a
    // message containing no endpoint at all (review). Loopback and private ranges are
    // never secrets and are exactly what a developer needs to see (anvil not running).
    .replace(
      /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\s+((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?)/gi,
      (m, errno: string, host: string) =>
        /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host) ? m : `${errno} <rpc endpoint>`,
    )
    // a key can travel as a header rather than in the URL
    .replace(/\b(x-api-key|api[-_]?key|authorization)\b\s*[:=]\s*.*/gi, "$1: <redacted>")
    .replace(/^\s*(URL|Request body|Raw Call Arguments):.*$/gim, "")
    .replace(/\n{2,}/g, "\n");
}

import { createPublicClient, http, type HttpTransport, type PublicClient } from "viem";
import { base } from "viem/chains";

export const chains = { 8453: base } as const;
export type SupportedChainId = keyof typeof chains;

export function isSupportedChainId(id: number): id is SupportedChainId {
  return id in chains;
}

/**
 * Read-only client. This module constructs exactly one kind of thing — a public (unsigned)
 * client from an RPC URL. It never constructs a wallet client: the signer is the consumer's,
 * handed in from outside if at all (see `build.ts`, which emits unsigned calls only).
 */
export type ReadClient = PublicClient<HttpTransport, (typeof chains)[SupportedChainId]>;

/** The public endpoint used when nothing is configured, and the fallback for event scans. */
export const PUBLIC_RPC: Record<SupportedChainId, string> = { 8453: "https://mainnet.base.org" };

/**
 * A `fetch` that waits out HTTP 429 instead of failing the tool. Measured 2026-09-14: a free-tier
 * keyed Base RPC answered an `earn_quote` read with 429 and the tool failed outright, because viem's
 * own retries (3, from 150 ms) are spent in under a second. Only a 429 is retried here, up to 5 times,
 * honouring `Retry-After` when present and otherwise backing off from 500 ms, with the sleeps capped at
 * `RATE_LIMIT_WAIT_MS` in total whatever the headers say.
 *
 * The transport's deadline (`RPC_TIMEOUT_MS`, viem's own 10 s) wraps this whole loop and is enforced by
 * ABORT: viem only reports its `TimeoutError` when the fetch throws an abort error, and resolves a value
 * returned after the abort as-is. So the sleep races the abort signal, and on abort the LAST 429 is
 * handed back — the caller then sees the provider's 429, never "The request took too long to respond".
 * Measured 2026-09-17 before this: a keyed provider at its monthly cap answered 429 in 77 ms, the loop
 * slept through the deadline, and a whole live tier read as "the RPC is slow" when the key was out of
 * quota. The deadline itself is NOT raised: a host that accepts and never answers must still fail at
 * 10 s (measured in review: 25.5 s made `earn_status` 2.5× slower on exactly that case).
 *
 * A 429 whose body carries the one measured exhausted-plan sentence is returned at once — it resets
 * next period, not in seconds. ONLY that sentence: a bare /capacity/ also matched Alchemy's per-second
 * throttle body ("exceeded its compute units per second capacity") and a "temporarily at capacity"
 * message, and would have disabled the wait on the exact case it exists for (measured in review).
 * An unrecognised body is waited out and then reported plainly — the safe direction.
 * An unreachable host is deliberately NOT stretched out: that is a fault to report, not a limit to
 * wait for, and `earn_status` must answer quickly when the RPC is down.
 */
export const RATE_LIMIT_WAIT_MS = 15_500;
/** The transport's whole-call deadline — viem's default, set explicitly because the wrapper's design depends on it. */
export const RPC_TIMEOUT_MS = 10_000;
/** Measured 2026-09-17 on a keyed provider at its cap: `Monthly capacity limit exceeded. … billing …`. */
const QUOTA_EXHAUSTED = /\b(monthly|daily) capacity limit exceeded\b/i;

export function makeRateLimitedFetch(
  base: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? null;
    const aborted = new Promise<void>((r) => {
      if (!signal) return;
      if (signal.aborted) r();
      else signal.addEventListener("abort", () => r(), { once: true });
    });
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const res = await base(input, init);
      if (res.status !== 429 || attempt >= 5 || waited >= RATE_LIMIT_WAIT_MS) return res;
      // Read a COPY of the body: the caller (viem) still needs the original to report the provider's message.
      if (QUOTA_EXHAUSTED.test(await res.clone().text().catch(() => ""))) return res;
      const after = Number(res.headers.get("retry-after"));
      const want = Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 500 * 2 ** attempt;
      const ms = Math.min(want, RATE_LIMIT_WAIT_MS - waited);
      waited += ms;
      await Promise.race([sleep(ms), aborted]);
      if (signal?.aborted) return res; // the deadline passed while waiting: report the 429, not a timeout
    }
  };
}

export function makePublicClient(chainId: SupportedChainId, rpcUrl: string): ReadClient {
  // `retryCount: 0` because THIS wrapper owns the retry policy. viem's own retry sits OUTSIDE the
  // transport's fetchFn and also retries 429, so the two multiply — measured in review: one
  // persistently rate-limited request made 24 underlying fetch calls, not 6, and took ~62 s instead of
  // the ~15 s this file claimed.
  // `timeout` is viem's default, named so the wrapper's abort-race above is pinned to it (see above).
  //
  // 🔴 `ccipRead: false` closes the one path by which this client could contact a host the operator
  // never configured. viem enables CCIP-read by default: a contract that reverts with
  // `OffchainLookup` hands back a URL and viem fetches it — an arbitrary host, chosen by the
  // contract, outside the RPC. Treasury reads only registry vaults and needs no off-chain
  // resolution, so the capability is pure exposure here, and "the RPC you configure and nothing
  // else" is only true with it off. A test pins it.
  return createPublicClient({ chain: chains[chainId], ccipRead: false, transport: http(rpcUrl, { fetchFn: makeRateLimitedFetch(), retryCount: 0, timeout: RPC_TIMEOUT_MS }) });
}

/**
 * An env value counts as an RPC URL only if it parses as one with an http(s) scheme. Anything else —
 * empty, whitespace, a non-URL, and in particular an UNEXPANDED placeholder like `${TREASURY_RPC_BASE}` —
 * is treated as unset. Measured 2026-09-12: Claude Code forwards the plugin's `.mcp.json` value
 * `${TREASURY_RPC_BASE}` verbatim when the host variable is unset, and with the old `if (v)` test every
 * RPC-touching tool died on "Failed to parse URL from ${TREASURY_RPC_BASE}". `.mcp.json` now also uses
 * `${VAR:-}`, but this guard is what makes the server independent of any host's expansion rules.
 */
export function rpcUrlFromEnvValue(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (t.length === 0 || t.includes("${")) return undefined;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the RPC URL for a chain from the environment. ⚠️ A keyed provider URL IS a secret: it must
 * never appear in tool output — every error crossing the tool boundary goes through `describeError`
 * (`src/redact.ts`), which strips endpoints. Fallback names after `TREASURY_RPC_BASE`:
 * `BASE_RPC_URL`; the plugin's `.mcp.json` passes only the `TREASURY_*` pair through, so under the
 * packaged path the fallback is unreachable.
 * `TREASURY_LOGS_RPC_BASE`, if set, is preferred for log scans (providers cap eth_getLogs ranges very
 * differently: Alchemy free 10 blocks, Base public 2,000) — see `position.ts`.
 */
export function rpcUrlFromEnv(chainId: SupportedChainId): string {
  const candidates = chainId === 8453 ? ["TREASURY_RPC_BASE", "BASE_RPC_URL"] : [];
  for (const k of candidates) {
    const v = rpcUrlFromEnvValue(process.env[k]);
    if (v) return v;
  }
  return PUBLIC_RPC[chainId];
}

/**
 * The endpoint an event scan falls back to when the configured logs RPC cannot cover the range — and
 * the operator's opt-out from it. `TREASURY_LOGS_FALLBACK` unset ⇒ Base's public endpoint; an http(s)
 * URL ⇒ that endpoint; ANY other value — `off`, `none`, `disabled`, a typo — ⇒ no fallback at all, and
 * the scan degrades to a cut-short window as it did before the fallback existed. It exists because the fallback
 * otherwise sends a query to a third party the operator never named, which some
 * deployments cannot accept — and it fails CLOSED for the same reason.
 */
export function logsFallbackUrlFromEnv(chainId: SupportedChainId, logsUrl: string): string | undefined {
  const raw = (process.env["TREASURY_LOGS_FALLBACK"] ?? "").trim();
  // Unset, empty, or an unexpanded `${VAR}` placeholder: the default fallback.
  // ⚠️ The placeholder is THE ONE DELIBERATE EXCEPTION to fail-closed below.
  // An MCP host forwards `${TREASURY_LOGS_FALLBACK}` verbatim when the host variable is unset, so a
  // placeholder means the operator never set it — and unset must behave exactly as absent, or every
  // plugin install without the variable silently loses its fallback. The function cannot tell "the
  // host did not expand it" from "someone typed it"; the second reading is treated as implausible on
  // purpose, and this comment is the record of that choice.
  if (raw.length === 0 || raw.includes("${")) return sameOrUndefined(PUBLIC_RPC[chainId], logsUrl);
  // 🔴 An operator who set this variable at all was constraining where this process talks. Reading an
  // unrecognised value as "use the default third party" is the one outcome they cannot have meant
  // (measured in review: `disabled` silently kept the public fallback until this failed closed).
  const url = rpcUrlFromEnvValue(raw);
  return url === undefined ? undefined : sameOrUndefined(url, logsUrl);
}

/** A fallback that is the same endpoint as the primary is not a fallback. */
function sameOrUndefined(url: string, logsUrl: string): string | undefined {
  return url === logsUrl ? undefined : url;
}

/** RPC to use for eth_getLogs scans: a dedicated one if configured, else the general one. */
export function logsRpcUrlFromEnv(chainId: SupportedChainId): string {
  return rpcUrlFromEnvValue(process.env["TREASURY_LOGS_RPC_BASE"]) ?? rpcUrlFromEnv(chainId);
}

/**
 * Which environment variable supplied the RPC URL — the NAME only, never the value. A keyed provider
 * URL is a secret, so `earn_status` reports provenance and nothing else. `configured: false` means
 * no variable resolved and the public endpoint is in use (rate-limited, never a failure).
 */
export function rpcSourceForEnv(chainId: SupportedChainId): { source: string; configured: boolean } {
  const candidates = chainId === 8453 ? ["TREASURY_RPC_BASE", "BASE_RPC_URL"] : [];
  for (const k of candidates) {
    if (rpcUrlFromEnvValue(process.env[k])) return { source: k, configured: true };
  }
  return { source: "public default", configured: false };
}

/**
 * Every RPC secret VALUE this process could be holding — the resolved URLs plus the parts of them
 * that carry the credential (path segments, query values, and a subdomain-keyed provider's first
 * label). Fed to `registerSecretSource` so the redactor masks the literal wherever it appears,
 * including inside a provider's own error body, where no shape rule can reach it.
 *
 * ⚠️ Returns VALUES, and is used only to mask them. It must never be logged or returned by a tool.
 */
export function resolvedRpcSecrets(): string[] {
  const out = new Set<string>();
  // 🔴 BOTH FORMS. A credential sits in the URL percent-ENCODED; a provider echoes the DECODED one.
  // Measured by review: for `sk-Live_a+b/c=d9f8e7` the URL carries
  // `sk-Live_a%2Bb%2Fc%3Dd9f8e7`, only that was registered, and the plain key leaked. The earlier
  // test missed it because `SECRETKEY123` percent-encodes to ITSELF — the transformation was the
  // identity function, so the test could not tell the two forms apart.
  const add = (v: string | undefined) => {
    if (!v || v.length < 8) return;
    out.add(v);
    try {
      const decoded = decodeURIComponent(v);
      if (decoded !== v && decoded.length >= 8) out.add(decoded);
    } catch {
      /* a malformed percent-sequence is not a second form */
    }
  };

  const urls = new Set<string>();
  // Every variable that can name a URL the package will CALL — the logs fallback included: it builds a
  // real client, and a provider's error body can echo its key exactly as the primary's (measured in
  // review; dormant until describeError began reporting the body).
  for (const k of ["TREASURY_RPC_BASE", "TREASURY_LOGS_RPC_BASE", "BASE_RPC_URL", "TREASURY_LOGS_FALLBACK"]) {
    const v = rpcUrlFromEnvValue(process.env[k]);
    if (v) urls.add(v);
  }
  for (const u of urls) {
    add(u);
    try {
      const p = new URL(u);
      for (const seg of p.pathname.split("/")) add(seg); // raw: the usual place a key sits
      // ⚠️ Query values need BOTH readings. `searchParams` decodes `+` as a SPACE (form-encoding),
      // so for `?apikey=sk+Live_abcdefgh` it yields `sk Live_abcdefgh` while the provider echoes
      // the literal `sk+Live_abcdefgh` — the same defect as the path form, on the other branch
      // (review). Register the raw token as well as what searchParams parsed.
      for (const [, val] of p.searchParams) add(val);
      for (const pair of p.search.replace(/^\?/, "").split("&")) {
        const eq = pair.indexOf("=");
        if (eq >= 0) add(pair.slice(eq + 1));
      }
      add(p.hostname.split(".")[0]); // QuickNode-style subdomain keys
    } catch {
      /* rpcUrlFromEnvValue already parsed it; unreachable */
    }
  }
  return [...out];
}

/**
 * The one sentence a caller needs when the public endpoint is what broke them.
 *
 * 🔴 Measured 2026-09-12 through the installed plugin with no configuration: the deposit pre-flight
 * returns UNRESOLVED 3/3 on `mainnet.base.org` ("RPC Request failed") and NEEDS_APPROVAL 3/3 on a
 * keyed URL. So zero-config can browse vaults and read terms but CANNOT complete a deposit — and the
 * message it fails with reads as "this product is broken" rather than "you need a key". Returns
 * undefined when a keyed RPC resolved, so a real chain fault is never mislabelled as a setup problem.
 */
export function publicRpcHint(chainId: SupportedChainId): string | undefined {
  if (rpcSourceForEnv(chainId).configured) return undefined;
  return (
    "No RPC was configured, so this used the public endpoint (mainnet.base.org), which rate-limits " +
    "after a handful of calls — that is the most likely cause of the failure above, not the vault. " +
    "Set TREASURY_RPC_BASE to a keyed Base RPC URL (Alchemy, Infura, QuickNode or your own node) and " +
    "retry. Reads like the vault list and the disclosures work without one; quotes, pre-flight and " +
    "position history generally do not."
  );
}

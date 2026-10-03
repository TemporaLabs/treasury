import { createPublicClient, http, type HttpTransport, type PublicClient } from "viem";
import { arbitrum, base } from "viem/chains";

export const chains = { 8453: base, 42161: arbitrum } as const;
export type SupportedChainId = keyof typeof chains;

export function isSupportedChainId(id: number): id is SupportedChainId {
  return id in chains;
}

/**
 * Everything this client knows about a chain besides viem's own definition: the name a tool caller
 * uses for it (`chain: "arbitrum"`), the name shown to an operator, the environment variables that
 * configure its RPC, and the public endpoint used when none is set.
 *
 * ONE TABLE, so a chain cannot be half-added: `rpcUrlFromEnv`, `logsRpcUrlFromEnv`,
 * `rpcSourceForEnv`, `resolvedRpcSecrets` and `publicRpcHint` all read it, and `Record<
 * SupportedChainId, …>` makes a chain present in `chains` and absent here a compile error.
 * `links.ts` holds the explorer map and is the one place this table does not reach; it fails loudly
 * on a chain it does not know.
 *
 * `rpcEnv` is tried in order. The second name of each pair is the conventional one an operator may
 * already have set. The CLI reads the whole environment it was started in, so both names reach it.
 */
export interface ChainInfo {
  key: string;
  name: string;
  rpcEnv: readonly string[];
  logsRpcEnv: string;
  publicRpc: string;
}
export const CHAIN_INFO = {
  8453: { key: "base", name: "Base", rpcEnv: ["TREASURY_RPC_BASE", "BASE_RPC_URL"], logsRpcEnv: "TREASURY_LOGS_RPC_BASE", publicRpc: "https://mainnet.base.org" },
  42161: {
    key: "arbitrum",
    name: "Arbitrum One",
    rpcEnv: ["TREASURY_RPC_ARBITRUM", "ARBITRUM_RPC_URL"],
    logsRpcEnv: "TREASURY_LOGS_RPC_ARBITRUM",
    publicRpc: "https://arb1.arbitrum.io/rpc",
  },
} as const satisfies Record<SupportedChainId, ChainInfo>;

/** The name a tool caller uses for a chain: `"base"`, `"arbitrum"`. */
export type ChainKey = (typeof CHAIN_INFO)[SupportedChainId]["key"];

export const supportedChainIds = Object.keys(chains).map(Number) as SupportedChainId[];

/** `"arbitrum"` → 42161. `undefined` for a name this client does not know — the caller says so. */
export function chainIdForKey(key: string): SupportedChainId | undefined {
  return supportedChainIds.find((id) => CHAIN_INFO[id].key === key);
}

/**
 * Read-only client. This module constructs exactly one kind of thing — a public (unsigned)
 * client from an RPC URL. It never constructs a wallet client: the signer is the consumer's,
 * handed in from outside if at all (see `build.ts`, which emits unsigned calls only).
 */
export type ReadClient = PublicClient<HttpTransport, (typeof chains)[SupportedChainId]>;

/** The public endpoint used when nothing is configured, and the fallback for event scans. */
export const PUBLIC_RPC: Record<SupportedChainId, string> = { 8453: CHAIN_INFO[8453].publicRpc, 42161: CHAIN_INFO[42161].publicRpc };

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
 * is treated as unset. Measured 2026-09-12, when the plugin still declared an MCP server: Claude Code
 * forwarded the server declaration's value `${TREASURY_RPC_BASE}` verbatim when the host variable was
 * unset, and with the old `if (v)` test every RPC-touching tool died on "Failed to parse URL from
 * ${TREASURY_RPC_BASE}". The plugin now runs the CLI through the shell and declares nothing, but any
 * host or wrapper can still pass a placeholder through, and this guard is what makes the client
 * independent of anyone's expansion rules.
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
 * (`src/redact.ts`), which strips endpoints. The names come from `CHAIN_INFO`: on Base,
 * `TREASURY_RPC_BASE` then `BASE_RPC_URL`; on Arbitrum One, `TREASURY_RPC_ARBITRUM` then
 * `ARBITRUM_RPC_URL`. The CLI inherits its shell's whole environment, so on every path, the plugin's
 * included, the second name of each pair is used when the first is unset.
 * The chain's logs variable (`TREASURY_LOGS_RPC_BASE`, `TREASURY_LOGS_RPC_ARBITRUM`), if set, is
 * preferred for log scans (providers cap eth_getLogs ranges very differently: Alchemy free 10 blocks,
 * Base public 2,000, Infura 10,000 on Arbitrum) — see `position.ts`.
 *
 * 🔴 A chain reads ONLY its own variables. An Arbitrum call never falls back to a Base endpoint: a
 * vault's address has no contract on the other chain, so reads fail with "returned no data" — which
 * reads as a broken vault rather than as a misconfiguration.
 */
export function rpcUrlFromEnv(chainId: SupportedChainId): string {
  for (const k of CHAIN_INFO[chainId].rpcEnv) {
    const v = rpcUrlFromEnvValue(process.env[k]);
    if (v) return v;
  }
  return PUBLIC_RPC[chainId];
}

/**
 * The endpoint an event scan falls back to when the configured logs RPC cannot cover the range — and
 * the operator's opt-out from it. `TREASURY_LOGS_FALLBACK` unset ⇒ the chain's public endpoint; an
 * http(s) URL ⇒ that endpoint, ON BASE ONLY; ANY other value — `off`, `none`, `disabled`, a typo — ⇒ no
 * fallback at all, and the scan degrades to a cut-short window as it did before the fallback existed. It exists because the fallback
 * otherwise sends a query to a third party the operator never named, which some
 * deployments cannot accept — and it fails CLOSED for the same reason.
 *
 * 🔴 The variable names ONE endpoint, and that endpoint is on Base. On any other chain a URL there
 * cannot serve the scan — it would answer for the wrong chain — so a SET variable means no fallback
 * on that chain, whatever it holds: either the operator opted out, or they named a Base endpoint and
 * so constrained where this process talks. An operator who wants history on another chain points that
 * chain's logs variable (`TREASURY_LOGS_RPC_ARBITRUM`) at a provider with a wide eth_getLogs range.
 */
export function logsFallbackUrlFromEnv(chainId: SupportedChainId, logsUrl: string): string | undefined {
  const raw = (process.env["TREASURY_LOGS_FALLBACK"] ?? "").trim();
  // Unset, empty, or an unexpanded `${VAR}` placeholder: the default fallback.
  // ⚠️ The placeholder is THE ONE DELIBERATE EXCEPTION to fail-closed below.
  // A host can forward `${TREASURY_LOGS_FALLBACK}` verbatim when the variable is unset, so a
  // placeholder means the operator never set it — and unset must behave exactly as absent, or every
  // plugin install without the variable silently loses its fallback. The function cannot tell "the
  // host did not expand it" from "someone typed it"; the second reading is treated as implausible on
  // purpose, and this comment is the record of that choice.
  if (raw.length === 0 || raw.includes("${")) return sameOrUndefined(PUBLIC_RPC[chainId], logsUrl);
  // 🔴 An operator who set this variable at all was constraining where this process talks. Reading an
  // unrecognised value as "use the default third party" is the one outcome they cannot have meant
  // (measured in review: `disabled` silently kept the public fallback until this failed closed).
  if (chainId !== 8453) return undefined; // set, and this chain is not the one the variable names an endpoint for
  const url = rpcUrlFromEnvValue(raw);
  return url === undefined ? undefined : sameOrUndefined(url, logsUrl);
}

/** A fallback that is the same endpoint as the primary is not a fallback. */
function sameOrUndefined(url: string, logsUrl: string): string | undefined {
  return url === logsUrl ? undefined : url;
}

/** RPC to use for eth_getLogs scans: a dedicated one if configured, else the general one. */
export function logsRpcUrlFromEnv(chainId: SupportedChainId): string {
  return rpcUrlFromEnvValue(process.env[CHAIN_INFO[chainId].logsRpcEnv]) ?? rpcUrlFromEnv(chainId);
}

/**
 * Which environment variable supplied the RPC URL — the NAME only, never the value. A keyed provider
 * URL is a secret, so `earn_status` reports provenance and nothing else. `configured: false` means
 * no variable resolved and the public endpoint is in use (rate-limited, never a failure).
 */
export function rpcSourceForEnv(chainId: SupportedChainId): { source: string; configured: boolean } {
  for (const k of CHAIN_INFO[chainId].rpcEnv) {
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
  // 🔴 A chain's own key is NOT a secret, and it is long enough to be taken for one. Providers put
  // the chain in the URL — `rpc.example/arbitrum/<key>`, `arbitrum.example.org` — and a path segment
  // or first host label of 8+ characters is registered below. "arbitrum" is exactly 8, so with such a
  // URL configured every refusal that names the chain read `chains with a vault: base, <redacted>`
  // (measured in review). "base" is 4 characters, which is why one chain never showed it.
  const chainWords = new Set<string>(supportedChainIds.map((id) => CHAIN_INFO[id].key));
  const add = (v: string | undefined) => {
    if (!v || v.length < 8) return;
    if (chainWords.has(v.toLowerCase())) return;
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
  // Derived from the chain table, so a chain added there cannot be left out of the redactor.
  const names = [...supportedChainIds.flatMap((id) => [...CHAIN_INFO[id].rpcEnv, CHAIN_INFO[id].logsRpcEnv]), "TREASURY_LOGS_FALLBACK"];
  for (const k of names) {
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
  const info = CHAIN_INFO[chainId];
  return (
    `No RPC was configured for ${info.name}, so this used the public endpoint (${new URL(info.publicRpc).hostname}), which rate-limits ` +
    "after a handful of calls — that is the most likely cause of the failure above, not the vault. " +
    `Set ${info.rpcEnv[0]} to a keyed ${info.name} RPC URL (Alchemy, Infura, QuickNode or your own node) and ` +
    "retry. Reads like the vault list and the disclosures work without one; quotes, pre-flight and " +
    "position history generally do not."
  );
}

/** How long a chain-identity probe may take before the endpoint counts as "did not say". */
export const CHAIN_PROBE_MS = 3_000;

/** Endpoints that have already said which chain they are. An endpoint does not change chain. */
const reportedChain = new Map<string, number>();

/**
 * Which chain does this endpoint say it is? `undefined` when it did not say within
 * `CHAIN_PROBE_MS` — an error, a rate limit, a hang — which is NOT a statement about the chain: the
 * caller reports that as "not verified", never as a match and never as a mismatch.
 *
 * It exists because two chains mean two RPC variables, and the likeliest mistake is one pointed at
 * the other chain. Nothing then errors usefully: a vault's address has no code there, so reads fail
 * with "returned no data" and the failure reads as a broken vault.
 *
 * Bounded on purpose. The transport's own deadline is 10 s and a rate-limited `eth_chainId` is waited
 * out for all of it, which would make a health check that already has its answer wait ten seconds
 * for a second one (measured in review). An answer is remembered per endpoint URL, so a process asks
 * each endpoint once.
 */
export async function endpointChainId(client: ReadClient, rpcUrl: string, timeoutMs: number = CHAIN_PROBE_MS): Promise<number | undefined> {
  const known = reportedChain.get(rpcUrl);
  if (known !== undefined) return known;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), timeoutMs);
    timer.unref?.();
  });
  try {
    const got = await Promise.race([client.getChainId().catch(() => undefined), timedOut]);
    if (got !== undefined) reportedChain.set(rpcUrl, got);
    return got;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** An endpoint a tool is about to read through, and the NAME of the variable that supplied it. */
export interface Endpoint {
  client: ReadClient;
  url: string;
  source: string;
}

/**
 * The first of these endpoints that answers for a chain other than `chainId`, or `undefined`.
 * A chain's public endpoint is never asked: it is this client's own constant, so the question
 * would be a request to a third party with a known answer. An endpoint that does not say is not a
 * mismatch.
 */
export async function firstEndpointOnWrongChain(chainId: SupportedChainId, endpoints: Endpoint[]): Promise<{ source: string; answersFor: number } | undefined> {
  const asked = endpoints.filter((e) => e.url !== PUBLIC_RPC[chainId]);
  const said = await Promise.all(asked.map((e) => endpointChainId(e.client, e.url)));
  for (const [i, id] of said.entries()) {
    if (id !== undefined && id !== chainId) return { source: asked[i]!.source, answersFor: id };
  }
  return undefined;
}

/** TEST SEAM — forgets what every endpoint said, so one test's mock port cannot answer for the next. NOT re-exported from index.ts. */
export function __forgetEndpointChainsForTests(): void {
  reportedChain.clear();
}

/**
 * Which variable supplied the endpoint `earn_balance` scans events through — the chain's logs
 * variable when it resolves, otherwise whatever supplied the general RPC. The NAME only.
 */
export function logsRpcSourceForEnv(chainId: SupportedChainId): { source: string; configured: boolean } {
  const k = CHAIN_INFO[chainId].logsRpcEnv;
  return rpcUrlFromEnvValue(process.env[k]) ? { source: k, configured: true } : rpcSourceForEnv(chainId);
}

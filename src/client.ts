import { createPublicClient, http, type HttpTransport, type PublicClient } from "viem";
import { arbitrum, base, mainnet, monad, robinhood } from "viem/chains";

export const chains: {
  readonly 8453: typeof base;
  readonly 42161: typeof arbitrum;
  readonly 4663: typeof robinhood;
  readonly 1: typeof mainnet;
  readonly 143: typeof monad;
} = { 8453: base, 42161: arbitrum, 4663: robinhood, 1: mainnet, 143: monad };
// Annotated per key, so the declaration build need not name viem's internal chain type (TS2742, viem
// 2.57.8 and later) while each chain keeps its own type for consumers of the published declarations.
export type SupportedChainId = keyof typeof chains;

export function isSupportedChainId(id: number): id is SupportedChainId {
  return id in chains;
}

/**
 * Everything this client knows about a chain besides viem's own definition: the name a tool caller
 * uses for it (`chain: "arbitrum"`), the name shown to an operator, the environment variables that
 * configure its RPC, and the public endpoint used when none is set.
 *
 * ONE TABLE, so a chain cannot be half-added: `rpcUrlFromEnv`, `rpcSourceForEnv`,
 * `resolvedRpcSecrets` and `publicRpcHint` all read it, and `Record<
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
  publicRpc: string;
}
export const CHAIN_INFO = {
  8453: { key: "base", name: "Base", rpcEnv: ["TREASURY_RPC_BASE", "BASE_RPC_URL"], publicRpc: "https://mainnet.base.org" },
  42161: {
    key: "arbitrum",
    name: "Arbitrum One",
    rpcEnv: ["TREASURY_RPC_ARBITRUM", "ARBITRUM_RPC_URL"],
    publicRpc: "https://arb1.arbitrum.io/rpc",
  },
  4663: {
    key: "robinhood",
    name: "Robinhood Chain",
    rpcEnv: ["TREASURY_RPC_ROBINHOOD", "ROBINHOOD_RPC_URL"],
    publicRpc: "https://rpc.mainnet.chain.robinhood.com",
  },
  1: {
    key: "ethereum",
    name: "Ethereum",
    rpcEnv: ["TREASURY_RPC_ETHEREUM", "ETHEREUM_RPC_URL"],
    publicRpc: "https://ethereum.reth.rs/rpc",
  },
  143: {
    key: "monad",
    name: "Monad",
    rpcEnv: ["TREASURY_RPC_MONAD", "MONAD_RPC_URL"],
    publicRpc: "https://rpc.monad.xyz",
  },
} as const satisfies Record<SupportedChainId, ChainInfo>;

/**
 * Solana — the one chain here that is not an EVM chain. It has no chain id, no `viem` chain and no
 * `eth_getLogs`, so it is not a row of `CHAIN_INFO`; everything else about it follows the same rules:
 * its own variables only, then its public endpoint. An endpoint is checked for the right cluster by its
 * genesis hash (`src/solana/rpc.ts`), the counterpart of an EVM endpoint's chain id.
 */
export const SOLANA_INFO = {
  key: "solana",
  name: "Solana",
  rpcEnv: ["TREASURY_RPC_SOLANA", "SOLANA_RPC_URL"],
  publicRpc: "https://api.mainnet-beta.solana.com",
} as const;

/** The Solana RPC URL: `TREASURY_RPC_SOLANA`, then `SOLANA_RPC_URL`, then the public mainnet endpoint. */
export function solanaRpcUrlFromEnv(): string {
  for (const k of SOLANA_INFO.rpcEnv) {
    const v = rpcUrlFromEnvValue(process.env[k]);
    if (v) return v;
  }
  return SOLANA_INFO.publicRpc;
}

/** Which variable supplied the Solana RPC URL — the NAME only, never the value. */
export function solanaRpcSourceForEnv(): { source: string; configured: boolean } {
  for (const k of SOLANA_INFO.rpcEnv) {
    if (rpcUrlFromEnvValue(process.env[k])) return { source: k, configured: true };
  }
  return { source: "public default", configured: false };
}

/** `publicRpcHint` for Solana: the sentence for a failure on the unconfigured public endpoint. */
export function solanaPublicRpcHint(): string | undefined {
  if (solanaRpcSourceForEnv().configured) return undefined;
  return (
    `No RPC was configured for Solana, so this used the public endpoint (${new URL(SOLANA_INFO.publicRpc).hostname}), which rate-limits ` +
    "after a handful of calls — that is the most likely cause of the failure above, not the vault. " +
    `Set ${SOLANA_INFO.rpcEnv[0]} to a keyed Solana RPC URL (Helius, QuickNode, Alchemy or your own node) and retry.`
  );
}

/** The name a tool caller uses for a chain: `"base"`, `"arbitrum"`, `"robinhood"`, `"ethereum"`, `"monad"`. */
export type ChainKey = (typeof CHAIN_INFO)[SupportedChainId]["key"];

/**
 * Every supported chain, in the order chains were added: Base first, then Arbitrum One, Robinhood
 * Chain, Ethereum and Monad. Listed rather than read from `Object.keys(chains)`, whose integer keys
 * enumerate in numeric order and would put Ethereum (1) ahead of Base everywhere a list of chains is shown.
 * `client.unit.test.ts` holds this list equal to the keys of `chains`.
 */
export const supportedChainIds: SupportedChainId[] = [8453, 42161, 4663, 1, 143];

/** `"arbitrum"` → 42161. `undefined` for a name this client does not know — the caller says so. */
export function chainIdForKey(key: string): SupportedChainId | undefined {
  return supportedChainIds.find((id) => CHAIN_INFO[id].key === key);
}

/**
 * Read-only client. This module constructs exactly one kind of thing — a public (unsigned)
 * client from an RPC URL. It never constructs a wallet client: every transaction is signed by the
 * operator's own wallet, outside this package.
 */
export type ReadClient = PublicClient<HttpTransport, (typeof chains)[SupportedChainId]>;

/** The public endpoint used when nothing is configured. */
export const PUBLIC_RPC: Record<SupportedChainId, string> = {
  8453: CHAIN_INFO[8453].publicRpc,
  42161: CHAIN_INFO[42161].publicRpc,
  4663: CHAIN_INFO[4663].publicRpc,
  1: CHAIN_INFO[1].publicRpc,
  143: CHAIN_INFO[143].publicRpc,
};

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
 * never appear in tool output — every error crossing the tool boundary goes through `redactEndpoints`
 * (`src/redact.ts`), which strips endpoints. The names come from `CHAIN_INFO`: on Base,
 * `TREASURY_RPC_BASE` then `BASE_RPC_URL`; on Arbitrum One, `TREASURY_RPC_ARBITRUM` then
 * `ARBITRUM_RPC_URL`; on Robinhood Chain, `TREASURY_RPC_ROBINHOOD` then `ROBINHOOD_RPC_URL`; on Ethereum,
 * `TREASURY_RPC_ETHEREUM` then `ETHEREUM_RPC_URL`; on Monad, `TREASURY_RPC_MONAD` then `MONAD_RPC_URL`.
 * The CLI inherits its shell's whole environment, so on every path, the plugin's
 * included, the second name of each pair is used when the first is unset.
 *
 * What reads an EVM chain from here now: `connect wallet`'s check of a smart-contract wallet's sign-in
 * (ERC-1271 / ERC-6492, on Base), and `scripts/registry-check.ts` (every chain). The earn and connect
 * commands reach the EVM vaults through the Tempora API, which reads their chains itself.
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
 * Which environment variable supplied the RPC URL — the NAME only, never the value. A keyed provider
 * URL is a secret, so a setup hint or `scripts/registry-check.ts` reports provenance and nothing else. `configured: false` means
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
  const chainWords = new Set<string>([...supportedChainIds.map((id) => CHAIN_INFO[id].key), SOLANA_INFO.key]);
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
  // Every variable that can name a URL the package will CALL: a provider's error body can echo its key
  // (measured in review; dormant until describeError began reporting the body).
  // Derived from the chain table, so a chain added there cannot be left out of the redactor.
  const names = [...supportedChainIds.flatMap((id) => CHAIN_INFO[id].rpcEnv), ...SOLANA_INFO.rpcEnv];
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

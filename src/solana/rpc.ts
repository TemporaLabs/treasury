/**
 * The Solana RPC: one client per command run, on the endpoint `solanaRpcUrlFromEnv` resolves, and the cluster
 * check that is the counterpart of an EVM endpoint's chain id.
 */
import { createDefaultRpcTransport, createSolanaRpcFromTransport, isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, type Rpc, type RpcTransport, type SolanaRpcApi } from "@solana/kit";
import { MAINNET_GENESIS_HASH } from "./constants.js";

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** The longest a single request waits out HTTP 429 before the 429 is reported (the EVM client's limit too). */
const RATE_LIMIT_WAIT_MS = 15_000;

/**
 * A transport that waits out HTTP 429 instead of failing the command. Solana's public endpoint rate-limits
 * after a handful of requests (measured 2026-10-11: a burst of about twenty reads answered 429), and one
 * command makes several. Up to five retries, backing off from half a second, never past the limit above.
 */
/**
 * The wait between retries. The timer keeps the process alive: while a command waits out a 429 nothing else
 * may be pending, and an unref'd timer let Node end mid-retry — exit 0 with no output at all.
 */
export const retrySleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function withRateLimitRetry(base: RpcTransport, sleep: (ms: number) => Promise<void> = retrySleep): RpcTransport {
  return (async (req: Parameters<RpcTransport>[0]) => {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await base(req);
      } catch (e) {
        const is429 = isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && e.context.statusCode === 429;
        if (!is429 || attempt >= 5 || waited >= RATE_LIMIT_WAIT_MS) throw e;
        const ms = Math.min(500 * 2 ** attempt, RATE_LIMIT_WAIT_MS - waited);
        waited += ms;
        await sleep(ms);
      }
    }
  }) as RpcTransport;
}

export function makeSolanaRpc(url: string): SolanaRpc {
  return createSolanaRpcFromTransport(withRateLimitRetry(createDefaultRpcTransport({ url: url as never }))) as SolanaRpc;
}

/**
 * Which cluster an endpoint serves, by its genesis hash: `"mainnet"`, `"other"` (devnet, testnet, a local
 * validator — any of them answers every read, and none of them holds the registry's vault), or `undefined`
 * when it did not say within `ms`.
 */
export async function solanaCluster(rpc: SolanaRpc, ms = 3000): Promise<"mainnet" | "other" | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const hash = await Promise.race([
      rpc.getGenesisHash().send(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
    if (hash === undefined) return undefined;
    return hash === MAINNET_GENESIS_HASH ? "mainnet" : "other";
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

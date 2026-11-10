/**
 * BNB Chain, for `invest` only. It is not a row of `CHAIN_INFO` (`src/client.ts`): those are the
 * chains `earn` has vaults on, and BNB Chain has none. It follows the same rules as every chain
 * here: its own variables first, then its public endpoint, and the endpoint must say it is this
 * chain before any read is trusted.
 *
 * What `invest` reads here is the owner's own holdings, by `balanceOf` on each asset, through the
 * owner's own RPC. That is what bounds a withdrawal (`src/invest/gate.ts`): the bound comes from the
 * chain, never from the service that prepared the withdrawal.
 */
import { createPublicClient, getAddress, http, type Address } from "viem";
import { bsc } from "viem/chains";
import { rpcUrlFromEnvValue } from "../client.js";

export const BNB_INFO = {
  key: "bnb",
  name: "BNB Chain",
  chainId: 56,
  rpcEnv: ["TREASURY_RPC_BNB", "BNB_RPC_URL"],
  publicRpc: "https://bsc-dataseed.bnbchain.org",
} as const;

/** USDT on BNB Chain. 18 decimals, measured live (`decimals()` = 18, `symbol()` = "USDT"). */
export const BNB_USDT = {
  address: getAddress("0x55d398326f99059fF775485246999027B3197955"),
  decimals: 18,
  symbol: "USDT",
} as const;

/** The CAIP-19 form a withdrawal authorization names an asset by: `eip155:56/erc20:<address>`. */
export const assetIdOf = (token: Address): string => `eip155:${BNB_INFO.chainId}/erc20:${getAddress(token)}`;

export const BNB_USDT_ASSET_ID = assetIdOf(BNB_USDT.address);

/**
 * The token a CAIP-19 asset id names on BNB Chain, or null for anything else: another chain, another
 * namespace, or an address that is not exactly 20 bytes of hex.
 */
export function tokenOf(assetId: unknown): Address | null {
  if (typeof assetId !== "string") return null;
  const m = /^eip155:(\d+)\/erc20:(0x[0-9a-fA-F]{40})$/.exec(assetId);
  if (!m || Number(m[1]) !== BNB_INFO.chainId) return null;
  return getAddress(m[2]!);
}

/** The BNB Chain RPC URL: `TREASURY_RPC_BNB`, then `BNB_RPC_URL`, then the public endpoint. */
export function bnbRpcUrlFromEnv(): string {
  // Each name written out, so the environment boundary test sees every variable this file reads.
  return rpcUrlFromEnvValue(process.env["TREASURY_RPC_BNB"]) ?? rpcUrlFromEnvValue(process.env["BNB_RPC_URL"]) ?? BNB_INFO.publicRpc;
}

/** What `readHoldings` needs from a client; a viem public client is one, and tests pass a stub. */
export interface BalanceReader {
  getChainId(): Promise<number>;
  readContract(args: { address: Address; abi: typeof balanceOfAbi; functionName: "balanceOf"; args: readonly [Address] }): Promise<bigint>;
}

const balanceOfAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** A client for BNB Chain. viem's own retries are off, as for every chain here (`makePublicClient`). */
export function makeBnbClient(rpcUrl: string = bnbRpcUrlFromEnv()): BalanceReader {
  return createPublicClient({ chain: bsc, transport: http(rpcUrl, { retryCount: 0 }) }) as unknown as BalanceReader;
}

/**
 * The account's balance of each token, read from the chain. The endpoint must answer chain 56 first:
 * a balance read on another chain would be a number about a different account.
 */
export async function readHoldings(client: BalanceReader, account: Address, tokens: readonly Address[]): Promise<Map<Address, bigint>> {
  const chainId = await client.getChainId();
  if (chainId !== BNB_INFO.chainId) {
    throw new Error(`refused: the RPC endpoint answered chain ${chainId}, not ${BNB_INFO.name} (${BNB_INFO.chainId}); point ${BNB_INFO.rpcEnv[0]} at a ${BNB_INFO.name} endpoint`);
  }
  const unique = [...new Set(tokens.map((t) => getAddress(t)))];
  const out = new Map<Address, bigint>();
  for (const token of unique) {
    out.set(token, await client.readContract({ address: token, abi: balanceOfAbi, functionName: "balanceOf", args: [getAddress(account)] }));
  }
  return out;
}

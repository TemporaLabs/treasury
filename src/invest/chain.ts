/**
 * BNB Chain, for `invest` only. It is not a row of `CHAIN_INFO` (`src/client.ts`): those are the chains `earn` has
 * vaults on, and BNB Chain has none. Nothing here reads the chain: these are the fixed facts `invest` holds the API's
 * steps to (the USDT contract a deposit must be sent to, the asset a withdrawal must settle in) and the public RPC the
 * signing page's wallet uses for BNB Chain.
 */
import { getAddress, type Address } from "viem";

export const BNB_INFO = {
  key: "bnb",
  name: "BNB Chain",
  chainId: 56,
  publicRpc: "https://bsc-dataseed.bnbchain.org",
} as const;

/** USDT on BNB Chain. 18 decimals, measured live (`decimals()` = 18, `symbol()` = "USDT"). */
export const BNB_USDT = {
  address: getAddress("0x55d398326f99059fF775485246999027B3197955"),
  decimals: 18,
  symbol: "USDT",
} as const;

/** The CAIP-19 form an authorization and the API name an asset by: `eip155:56/erc20:<address>`. */
export const assetIdOf = (token: Address): string => `eip155:${BNB_INFO.chainId}/erc20:${getAddress(token)}`;

export const BNB_USDT_ASSET_ID = assetIdOf(BNB_USDT.address);

// Operator-chosen settings, all read from the environment. None of these is a secret. This plugin
// never holds a Privy app secret or authorization key; it needs neither.
export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = "0x2105";

const DEFAULT_PRIVY_APP_ID = "cmubfegl2028d0ci3n0f2u6z5";

export const privyAppId = (): string => process.env.PRIVY_APP_ID || DEFAULT_PRIVY_APP_ID;

// Privy lists allowed origins by exact string, so the connect page needs a fixed port.
export const connectPort = (): number => {
  const n = Number(process.env.TREASURY_CONNECT_PORT);
  return Number.isInteger(n) && n > 1023 && n < 65536 ? n : 53682;
};

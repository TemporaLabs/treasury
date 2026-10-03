// Operator-chosen settings, all read from the environment. None of these is a secret: a Privy app
// secret or authorization key belongs only to the separately hosted signing service.
export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = "0x2105";

const DEFAULT_PRIVY_APP_ID = "cmubpge0v00a10cjnb11u973n";

export const privyAppId = (): string => process.env.PRIVY_APP_ID || DEFAULT_PRIVY_APP_ID;

export const signerUrl = (): string | undefined => {
  const u = process.env.TREASURY_SIGNER_URL?.trim();
  return u ? u.replace(/\/+$/, "") : undefined;
};

export const signerId = (): string | undefined => process.env.PRIVY_SIGNER_ID?.trim() || undefined;

export const signerPolicyIds = (): string[] =>
  (process.env.PRIVY_SIGNER_POLICY_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// Privy lists allowed origins by exact string, so the connect page needs a fixed port.
export const connectPort = (): number => {
  const n = Number(process.env.TREASURY_CONNECT_PORT);
  return Number.isInteger(n) && n > 1023 && n < 65536 ? n : 53682;
};

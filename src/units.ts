import { formatUnits, parseUnits } from "viem";

/**
 * Amount parsing that refuses to guess. A human-readable decimal string is converted with the
 * caller-supplied decimals; a string with more fractional digits than the token has is an error,
 * not a silent truncation. `redeem` takes SHARES (shareDecimals); `deposit` takes ASSETS
 * (asset.decimals). Mixing them is a 10^12 error on an 18/6 vault, and an easy one to ship.
 */
export function parseAmount(human: string, decimals: number, label: string): bigint {
  const s = human.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${label}: "${human}" is not a plain decimal amount`);
  const frac = s.split(".")[1] ?? "";
  if (frac.length > decimals) {
    throw new Error(`${label}: "${human}" has ${frac.length} fractional digits but the token has ${decimals} decimals`);
  }
  const v = parseUnits(s, decimals);
  if (v <= 0n) throw new Error(`${label}: amount must be positive`);
  return v;
}

export function formatAmount(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

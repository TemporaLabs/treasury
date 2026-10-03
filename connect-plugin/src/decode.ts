import { decodeFunctionData, formatUnits } from "viem";
import { decodeAbi } from "./abi.ts";
import { BASE_CHAIN_ID } from "./config.ts";

export interface Call {
  to: string;
  data: string;
  value?: string;
}

export interface Decoded {
  recognised: boolean;
  summary: string;
  rows: [label: string, value: string][];
  warnings: string[];
}

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const UNLIMITED = 2n ** 255n;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const usdc = (raw: bigint) => `${formatUnits(raw, USDC_DECIMALS)} USDC (${raw} raw units)`;

// Turns one prepared call into what the operator should read before confirming. The confirmation
// page renders these strings as text only; nothing here is trusted as HTML.
export function describeCall(call: Call, account: string): Decoded {
  const rows: Decoded["rows"] = [
    ["Chain", `Base (${BASE_CHAIN_ID})`],
    ["From", account],
    ["To", eq(call.to, BASE_USDC) ? `${call.to} (USDC)` : call.to],
  ];
  const warnings: string[] = [];
  const value = BigInt(call.value ?? "0x0");
  if (value !== 0n) warnings.push(`This call also sends ${formatUnits(value, 18)} ETH.`);

  let summary: string;
  let recognised = true;
  try {
    const d = decodeFunctionData({ abi: decodeAbi, data: call.data as `0x${string}` });
    switch (d.functionName) {
      case "approve": {
        const [spender, amount] = d.args;
        summary = "Approve a vault to spend USDC";
        rows.push(["Action", "Approve spending"], ["Spender", spender], ["Amount", eq(call.to, BASE_USDC) ? usdc(amount) : `${amount} raw units`]);
        if (amount >= UNLIMITED) warnings.push("This is an unlimited approval.");
        if (!eq(call.to, BASE_USDC)) warnings.push("The token being approved is not Base USDC.");
        break;
      }
      case "transfer": {
        const [to, amount] = d.args;
        summary = "Transfer tokens to another address";
        rows.push(["Action", "Token transfer"], ["Recipient", to], ["Amount", eq(call.to, BASE_USDC) ? usdc(amount) : `${amount} raw units`]);
        warnings.push("A plain transfer moves funds out of your account. Earn never builds one for a deposit or withdrawal.");
        if (!eq(to, account)) warnings.push("The recipient is not your account.");
        break;
      }
      case "deposit": {
        const [assets, receiver] = d.args;
        summary = "Deposit USDC into a vault";
        rows.push(["Action", "Deposit"], ["Vault", call.to], ["Amount", usdc(assets)], ["Receiver", receiver]);
        if (!eq(receiver, account)) warnings.push("The receiver is not your account.");
        break;
      }
      case "withdraw": {
        const [assets, receiver, owner] = d.args;
        summary = "Withdraw USDC from a vault";
        rows.push(["Action", "Withdraw"], ["Vault", call.to], ["Amount", usdc(assets)], ["Receiver", receiver], ["Owner", owner]);
        if (!eq(receiver, account)) warnings.push("The receiver is not your account.");
        if (!eq(owner, account)) warnings.push("The owner is not your account.");
        break;
      }
      case "redeem": {
        const [shares, receiver, owner] = d.args;
        summary = "Redeem vault shares for USDC";
        rows.push(["Action", "Redeem"], ["Vault", call.to], ["Shares", `${shares} raw units`], ["Receiver", receiver], ["Owner", owner]);
        if (!eq(receiver, account)) warnings.push("The receiver is not your account.");
        if (!eq(owner, account)) warnings.push("The owner is not your account.");
        break;
      }
    }
  } catch {
    recognised = false;
    summary = "Unrecognised call";
    rows.push(["Action", "Unrecognised call data"]);
    warnings.push("This call is not a deposit, withdrawal or approval. Do not confirm unless you know what it is.");
  }
  rows.push(["Raw data", call.data]);
  return { recognised, summary: summary!, rows, warnings };
}

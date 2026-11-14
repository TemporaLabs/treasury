/**
 * A Smart Growth deposit: USDT on BNB Chain, from the owner's own wallet to the owner's own smart account.
 *
 * The API returns a request of one or two steps: the enrolment signature, when this wallet has no account on the
 * portfolio yet, then the transfer. Before either reaches the wallet, the whole request is held to what the owner asked
 * for by the client's own check (`checkPortfolioDeposit`): the transfer is a plain `transfer(smartAccount, amount)` on
 * the USDT contract pinned here (never one the API names), for exactly the amount asked, and pays the smart account the
 * request names, with no value attached. The enrolment signature is 32 bytes and nothing else.
 *
 * What this cannot check: the smart account itself is the API's word (it is opened by the enrolment, and only the
 * portfolio provider knows it). The transfer still pays exactly that account, and the API verifies on chain that it
 * left the owner's wallet for it.
 */
import { checkPortfolioDeposit, type Request } from "@temporalabs/client";
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem";
import { BNB_INFO, BNB_USDT, BNB_USDT_ASSET_ID } from "./chain.js";
import type { Prepared } from "./flow.js";

export const INVEST_CHAIN_ID = `eip155:${BNB_INFO.chainId}`;
/** What the API takes: at most six decimal places, so the amount is exactly what was typed. */
const AMOUNT_PLACES = 6;
const ZERO = "0x0000000000000000000000000000000000000000";

/** A USDT amount as typed (`100`, `12.5`), in raw units. Refuses zero, a sign, and more than six places. */
export function parseUsdt(text: string): bigint {
  const t = text.trim();
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${AMOUNT_PLACES}})?$`).test(t)) {
    throw new Error(`refused: --amount_usdt must be a number of USDT with at most ${AMOUNT_PLACES} decimal places, not "${text}"`);
  }
  const raw = parseUnits(t, BNB_USDT.decimals);
  if (raw === 0n) throw new Error("refused: --amount_usdt must be above zero");
  return raw;
}

export const depositBody = (product: string, raw: bigint) => ({
  product,
  amount: { kind: "assets" as const, assetId: BNB_USDT_ASSET_ID, raw: raw.toString() },
  chain: INVEST_CHAIN_ID,
  token: BNB_USDT.symbol,
});

/** The request held to the deposit asked for. A transfer with no smart account to pay is refused. */
export function checkDeposit(r: Request, raw: bigint) {
  const account = r.smartAccount;
  const transferReady = r.steps.some((s) => s.kind === "send_transaction" && (s as { payload?: unknown }).payload !== undefined);
  if (transferReady && (typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account))) {
    return { ok: false as const, step: null, reason: "the request names no smart account for the transfer to pay" };
  }
  return checkPortfolioDeposit(r.steps as never, { chain: INVEST_CHAIN_ID, tokenAddress: BNB_USDT.address, smartAccount: account ?? ZERO, amount: raw.toString() });
}

/** What the page shows for a deposit step, from the checked request and the owner's own numbers, never the API's words. */
export function prepareDeposit(r: Request, s: Request["steps"][number], raw: bigint, product: string): Prepared {
  const p = (s as { payload?: { bytes?: string; to?: string; data?: string } }).payload ?? {};
  if (s.kind === "sign_message") {
    return {
      view: {
        title: "Open your Smart Growth account",
        description: `Your wallet signs once to open your own account on ${product}. Nothing moves with this signature.`,
        facts: [
          { label: "Portfolio", value: product },
          { label: "What you sign", value: p.bytes ?? "" },
        ],
        warning:
          "Your wallet will show a 32-byte code, not words: the portfolio provider's enrolment code for this account. It cannot be read on its own. Sign it only if you started this deposit just now.",
      },
      ask: { kind: "sign_bytes", bytes: p.bytes as Hex },
    };
  }
  return {
    view: {
      title: "Send USDT to your Smart Growth account",
      description: `Your wallet sends ${formatUnits(raw, BNB_USDT.decimals)} USDT on ${BNB_INFO.name} to your own smart account for ${product}.`,
      facts: [
        { label: "Amount", value: `${formatUnits(raw, BNB_USDT.decimals)} USDT` },
        { label: "To your smart account", value: getAddress(r.smartAccount as Address) },
        { label: "Token contract", value: BNB_USDT.address },
        { label: "Network", value: BNB_INFO.name },
      ],
    },
    // The contract is the pinned one, which the check has held `to` to; the calldata is the checked transfer.
    ask: { kind: "send", to: BNB_USDT.address, data: p.data as Hex, value: "0" },
  };
}

/**
 * The `invest` commands: Smart Growth portfolios, through the Tempora API. Every fact about a portfolio (its status,
 * chain, deposit token, minimums and the forms a withdrawal may take) is read from the API when the command runs;
 * nothing about a portfolio is kept here.
 *
 *   invest_products   the portfolios the API offers, with their minimums and steps
 *   invest_balance    the connected wallet's positions
 *   invest_deposit    USDT from the connected wallet into a portfolio
 *   invest_withdraw   everything in a portfolio, back to the connected wallet in USDT
 *   invest_request    one request read again, or cancelled
 *
 * Nothing here signs. Owner calls sign in through the connect page (`api.ts`), and every step the owner's wallet is
 * asked to sign or send is checked first by the client's own checks.
 */
import { z } from "zod";
import type { Client, Request, Result } from "@temporalabs/client";
import { getAddress, type Address } from "viem";
import { INVEST } from "../config/invest.js";
import type { Command } from "../earn/commands.js";
import { readSession } from "../connect/session.js";
import { redactEndpoints } from "../redact.js";
import { apiClient, apiUrl, asOwner, failure, notConnected } from "./api.js";
import { BNB_USDT } from "./chain.js";
import { checkDeposit, depositBody, INVEST_CHAIN_ID, parseUsdt, prepareDeposit } from "./deposit.js";
import { drive, ownerWallet, summary, type DriveDeps, type OwnerWallet, type WalletDeps } from "./flow.js";
import { checkWithdrawal, holdingOf, prepareWithdrawal } from "./withdraw.js";

/** One JSON document, the way every treasury command answers. */
const text = (v: unknown) => JSON.stringify(v, null, 2);

const guarded =
  <A extends unknown[]>(fn: (...a: A) => Promise<string>) =>
  async (...a: A): Promise<string> => {
    try {
      return await fn(...a);
    } catch (e) {
      throw new Error(redactEndpoints(e instanceof Error ? e.message : String(e)));
    }
  };

export interface InvestDeps {
  client?: Client;
  /** The owner's wallet for one command (tests pass one that answers without a page). */
  wallet?: (owner: Address, title: string) => OwnerWallet;
  walletDeps?: WalletDeps;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  watchMs?: number;
  pollMs?: number;
}

const productArg = z.string().min(1).describe("the portfolio's `id`, as `invest products` lists them");

export function buildInvestCommands(deps: InvestDeps = {}): Record<string, Command> {
  const commands: Record<string, Command> = {};
  const register = <S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
  ): void => {
    commands[name] = { ...meta, inputSchema: z.object(meta.inputSchema), handler: handler as Command["handler"] };
  };
  const client = () => deps.client ?? apiClient();
  const now = deps.now ?? Date.now;

  /** The connected wallet: the only owner `invest` acts for. */
  const owner = (): Address => {
    const s = readSession();
    if (!s) throw notConnected();
    return getAddress(s.account);
  };

  /**
   * Runs one command for the connected owner, with the signing page opened only if the wallet is needed, and closed
   * with the command's ending.
   */
  const withWallet = async <T>(title: string, run: (o: Address, w: OwnerWallet, c: Client) => Promise<T>, ending: (v: T) => string): Promise<T> => {
    const o = owner();
    const w = deps.wallet ? deps.wallet(o, title) : ownerWallet(o, title, deps.walletDeps);
    const c = client();
    try {
      const v = await run(o, w, c);
      await w.finish({ ok: true, text: ending(v) });
      return v;
    } catch (e) {
      await w.finish({ ok: false, reason: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
      throw e;
    }
  };
  const call = <T>(o: Address, w: OwnerWallet, c: Client, fn: (c: Client, token: string) => Promise<Result<T>>) => asOwner(o, w.signIn, fn, { client: c, now });
  const driveDeps = (w: OwnerWallet, c: Client): DriveDeps => ({
    client: c,
    wallet: w,
    now,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    watchMs: deps.watchMs ?? INVEST.watchMs,
    pollMs: deps.pollMs ?? INVEST.pollMs,
  });

  /** The portfolio, as the API lists it now; refused when it is not a portfolio taking USDT on BNB Chain. */
  const portfolio = async (c: Client, product: string) => {
    const r = await c.products({});
    if (!r.ok) throw failure("The product list could not be read", r);
    const p = r.body.products.find((x) => x.id === product);
    if (!p || p.kind !== "portfolio") throw new Error(`refused: ${product} is not a portfolio the API offers; run \`treasury invest products\``);
    if (!p.chains.includes(INVEST_CHAIN_ID) || !p.tokens.includes(BNB_USDT.symbol)) {
      throw new Error(`refused: ${product} does not take ${BNB_USDT.symbol} on BNB Chain, the only deposit this command makes`);
    }
    return p;
  };

  const settledText = (r: { request: Request; settled: boolean }) =>
    r.settled ? `Request ${r.request.requestId}: ${r.request.state}.` : `Request ${r.request.requestId} is still ${r.request.state}. Read it later with \`treasury invest request\`.`;

  register(
    "invest_products",
    {
      title: "List Smart Growth portfolios",
      description:
        "The Smart Growth portfolios the Tempora API offers, read from the API now: each one's `id` (the value every other invest command takes as `product`), name, status, chain and deposit token, its minimums (`minimum.firstDepositUsd` for a first deposit, `minimum.topUpUsd` for a later one), the forms a deposit and a withdrawal may take (`amountForms`), and the steps the owner's wallet will be asked for (`steps`). A portfolio whose status is not `live` may refuse a deposit: say so to the operator. No sign-in is needed.",
      inputSchema: {},
    },
    guarded(async () => {
      const r = await client().products({});
      if (!r.ok) throw failure("The product list could not be read", r);
      const portfolios = r.body.products.filter((p) => p.kind === "portfolio");
      return text({
        api: apiUrl(),
        portfolios: portfolios.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          chains: p.chains,
          tokens: p.tokens,
          minimum: p.minimum,
          amountForms: p.amountForms,
          steps: p.steps,
        })),
      });
    }),
  );

  register(
    "invest_balance",
    {
      title: "Smart Growth positions",
      description:
        "The connected wallet's Smart Growth positions, read from the API now: per portfolio its `stage` (`not_enrolled`, `enrolled`, `awaiting_first_rebalance`, `below_minimum`, `invested`), its `smartAccount`, its value in USD and how that value was read (`value.state`), what it holds (`balances`, raw units with their decimals), idle USDT, profit and loss, and drift. When no sign-in is kept, a local page opens for the operator's wallet to sign in to the API (no gas, nothing moves).",
      inputSchema: {},
    },
    guarded(async () => {
      const out = await withWallet(
        "Invest: sign in",
        async (o, w, c) => {
          const r = await call(o, w, c, (cl, token) => cl.positions({}, { ownerToken: token }));
          if (!r.ok) throw failure("The positions could not be read", r);
          return { owner: o, positions: r.body.positions.filter((p) => p.kind === "portfolio") };
        },
        () => "Signed in. You can close this page.",
      );
      return text({ api: apiUrl(), ...out });
    }),
  );

  register(
    "invest_deposit",
    {
      title: "Deposit USDT into a Smart Growth portfolio",
      description:
        "Deposits USDT on BNB Chain from the connected wallet into its own smart account for a Smart Growth portfolio. A local page opens; the operator's own wallet signs in to the API if needed, signs the enrolment when this wallet has no account on the portfolio yet (a 32-byte code from the portfolio provider, which the page says cannot be read on its own), then sends the transfer. Every step is checked before the wallet sees it: the transfer must be exactly the amount asked, on the USDT contract this command pins, to the smart account the request names, with no value attached. Ask the operator for the amount; never suggest one. The portfolio's minimums are in `invest products`. Answers with the request and its state: `completed` once the transfer has landed and been verified by the API. A request still settling is read again with `invest request`. Never repeat a deposit whose transfer was sent: read its request first.",
      inputSchema: {
        product: productArg,
        amount_usdt: z.string().describe('the USDT amount the operator chose, as a plain decimal with at most 6 places, e.g. "100" or "12.5"'),
      },
    },
    guarded(async ({ product, amount_usdt }) => {
      const raw = parseUsdt(amount_usdt);
      const out = await withWallet(
        `Invest: deposit into ${product}`,
        async (o, w, c) => {
          await portfolio(c, product);
          const r = await call(o, w, c, (cl, token) => cl.deposit({ body: depositBody(product, raw) }, { ownerToken: token }));
          if (!r.ok) throw failure("The API did not start the deposit", r);
          return drive(r.body, o, { check: (q) => checkDeposit(q, raw), prepare: (q, s) => prepareDeposit(q, s, raw, product) }, driveDeps(w, c));
        },
        settledText,
      );
      return text({ api: apiUrl(), settled: out.settled, request: summary(out.request), acted: out.acted });
    }),
  );

  register(
    "invest_withdraw",
    {
      title: "Withdraw everything from a Smart Growth portfolio",
      description:
        "Withdraws everything in the connected wallet's smart account for a Smart Growth portfolio, paid to the connected wallet in USDT on BNB Chain: idle USDT is moved, the rest is sold. `all` must be true; a part withdrawal is not offered here. A local page opens; the operator's own wallet signs in to the API if needed, then signs each withdrawal authorization in turn. Every authorization is checked before the wallet sees it: it must debit the smart account the positions name, pay the connected wallet, settle in USDT, expire within the hour, and ask in total for no more of any asset than the account holds. Answers with the request and its state; a withdrawal still running is read again with `invest request`.",
      inputSchema: {
        product: productArg,
        all: z.literal(true).describe("must be true: the whole position is withdrawn"),
      },
    },
    guarded(async ({ product }) => {
      const out = await withWallet(
        `Invest: withdraw from ${product}`,
        async (o, w, c) => {
          await portfolio(c, product);
          const pos = await call(o, w, c, (cl, token) => cl.positions({}, { ownerToken: token }));
          if (!pos.ok) throw failure("The positions could not be read", pos);
          const h = holdingOf(pos.body.positions, product);
          const r = await call(o, w, c, (cl, token) => cl.withdraw({ body: { product, amount: { kind: "all" } } }, { ownerToken: token }));
          if (!r.ok) throw failure("The API did not start the withdrawal", r);
          return drive(r.body, o, { check: (q) => checkWithdrawal(q, o, h, now()), prepare: (q, s) => prepareWithdrawal(q, s, o, h, product) }, driveDeps(w, c));
        },
        settledText,
      );
      return text({ api: apiUrl(), settled: out.settled, request: summary(out.request), acted: out.acted });
    }),
  );

  register(
    "invest_request",
    {
      title: "Read or cancel an invest request",
      description:
        "Reads one of the connected wallet's requests again, by `request_id` (from `invest deposit` or `invest withdraw`) or by the `tx_hash` of a transfer the wallet sent for it: its state and each step's state, with the API's on-chain verification of a transfer. Give exactly one. With `cancel` true, cancels a request still waiting on the owner (nothing has moved for it); an earlier request that has not settled holds back a new one on the same portfolio. A page opens only when the wallet must sign in to the API.",
      inputSchema: {
        request_id: z.string().optional().describe("the request's id"),
        tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("the transaction hash of a transfer sent for the request"),
        cancel: z.boolean().optional().describe("true to cancel the request; it must be given by `request_id`"),
      },
    },
    guarded(async ({ request_id, tx_hash, cancel }) => {
      if ((request_id === undefined) === (tx_hash === undefined)) throw new Error("give exactly one of --request_id or --tx_hash");
      if (cancel && request_id === undefined) throw new Error("--cancel needs --request_id");
      const out = await withWallet(
        "Invest: sign in",
        async (o, w, c) => {
          const r =
            cancel && request_id !== undefined
              ? await call(o, w, c, (cl, token) => cl.cancel({ path: { requestId: request_id } }, { ownerToken: token }))
              : request_id !== undefined
                ? await call(o, w, c, (cl, token) => cl.status({ path: { requestId: request_id } }, { ownerToken: token }))
                : await call(o, w, c, (cl, token) => cl.status_lookup({ query: { txHash: tx_hash! } }, { ownerToken: token }));
          if (!r.ok) throw failure(cancel ? "The request could not be cancelled" : "The request could not be read", r);
          return r.body;
        },
        () => "Signed in. You can close this page.",
      );
      return text({ api: apiUrl(), request: summary(out) });
    }),
  );

  return commands;
}

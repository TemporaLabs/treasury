/**
 * `invest deposit`, `invest withdraw`, `invest balance` and `invest request`, against a stand-in API and a stand-in
 * wallet: no network, no browser. Each test keeps its own temporary connect directory, with a connected wallet and a
 * kept owner token, so no sign-in is asked for unless a test asks for one.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, getAddress, hashTypedData, type Address, type TypedDataDefinition } from "viem";
import type { Client, Request } from "@temporalabs/client";
import { buildInvestCommands } from "../src/invest/commands.js";
import { ownerWallet, type OwnerWallet } from "../src/invest/flow.js";
import { withDomainType } from "../src/invest/withdraw.js";
import { tokenKeyFor } from "../src/invest/api.js";
import { writeOwnerToken } from "../src/connect/owner-tokens.js";
import { writeSession } from "../src/connect/session.js";
import { BNB_USDT, BNB_USDT_ASSET_ID } from "../src/invest/chain.js";
import type { Answer, StepView, WalletAsk } from "../src/invest/page.js";

const OWNER = getAddress("0x52908400098527886e0f7030069857d2e4169ee7");
const ACCOUNT = getAddress("0x2222222222222222222222222222222222222222");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const STOCK = "eip155:56/erc20:0x3333333333333333333333333333333333333333";
const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const HOST = "api.staging.example";
const PRODUCT = "smart-growth-20";
const RAW_100 = 100n * 10n ** 18n;
const ENROL_BYTES = `0x${"ab".repeat(32)}`;
const HASH = `0x${"7".repeat(64)}`;

const transferData = (to: Address, raw: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, raw] });

const product = { id: PRODUCT, kind: "portfolio", name: "Smart Growth 20", status: "live", chains: ["eip155:56"], tokens: ["USDT"], minimum: { firstDepositUsd: "100", topUpUsd: "50" } };

function request(o: Partial<Request> & { steps: Request["steps"] }): Request {
  return { requestId: "req_1", action: "deposit", state: "requires_action", chose: { product: PRODUCT }, expiresAt: new Date(NOW + 3_600_000).toISOString(), ...o } as Request;
}
const enrol = (state = "ready") => ({ stepId: "s1", chainId: "eip155:56", state, checks: [], kind: "sign_message", purpose: "enrol", payload: { generation: 1, expiresAt: "x", bytes: ENROL_BYTES } });
const transfer = (o: { state?: string; to?: string; data?: string; value?: string; payload?: boolean } = {}) => ({
  stepId: "s2",
  chainId: "eip155:56",
  state: o.state ?? "ready",
  checks: [],
  kind: "send_transaction",
  purpose: "deposit",
  ...(o.payload !== false && { payload: { generation: 1, expiresAt: "x", to: o.to ?? BNB_USDT.address, data: o.data ?? transferData(ACCOUNT, RAW_100), value: o.value ?? "0" } }),
});

type Log = string[];

/** A stand-in API: answers each operation from the test's own table, and logs every call. */
function api(log: Log, handlers: Partial<Record<keyof Client, (input: any) => unknown>>): Client {
  const ok = (body: unknown) => ({ ok: true, status: 200, body });
  return new Proxy({} as Client, {
    get: (_t, name: string) => async (input: any) => {
      log.push(`api:${name}${input?.path?.stepId ? `:${input.path.stepId}` : ""}`);
      if (name === "products") return ok({ products: [product, { ...product, id: "a-vault", kind: "vault" }] });
      const h = handlers[name as keyof Client];
      if (!h) throw new Error(`unexpected call ${name}`);
      const v = h(input) as any;
      return v && v.ok === false ? v : ok(v);
    },
  });
}

/** A stand-in wallet: logs what it is asked, answers from the test's own function. */
function wallet(log: Log, answer: (a: WalletAsk) => Answer | Promise<Answer>, seen: { view: StepView; ask: WalletAsk }[] = []): OwnerWallet {
  return {
    signIn: async () => {
      log.push("wallet:sign-in");
      return "0xsig";
    },
    ask: async (view, a) => {
      log.push(`wallet:${a.kind}`);
      seen.push({ view, ask: a });
      return answer(a);
    },
    finish: async () => undefined,
    url: () => undefined,
  };
}

const signs = (a: WalletAsk): Answer => ({ kind: "answered", value: a.kind === "send" ? HASH : `0x${"5".repeat(130)}` });

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "treasury-invest-flow-"));
  process.env["TREASURY_CONNECT_HOME"] = home;
  process.env["TREASURY_API_URL"] = `https://${HOST}`;
  writeSession({ account: OWNER, walletType: "external", connectedAtIso: new Date(NOW).toISOString() });
  writeOwnerToken(tokenKeyFor(OWNER), { token: "tok", expiresAtIso: new Date(NOW + 3_600_000).toISOString() }, NOW);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env["TREASURY_CONNECT_HOME"];
  delete process.env["TREASURY_API_URL"];
});

/** A clock that moves only when the command waits, so a watch that runs out does so after one read. */
const commands = (client: Client, w: OwnerWallet) => {
  let t = NOW;
  return buildInvestCommands({ client, wallet: () => w, now: () => t, sleep: async (ms) => void (t += ms + 1), watchMs: 1, pollMs: 0 });
};
const run = async (client: Client, w: OwnerWallet, name: string, args: Record<string, unknown>) => JSON.parse(await commands(client, w)[name]!.handler(args as never));

describe("invest deposit", () => {
  it("enrols, then sends exactly the asked transfer to the smart account, and hands each result to the API", async () => {
    const log: Log = [];
    const bodies: unknown[] = [];
    const client = api(log, {
      deposit: (i) => (bodies.push(i.body), request({ steps: [enrol(), transfer({ state: "waiting", payload: false })] as never })),
      submit: (i) => {
        bodies.push(i.body);
        return i.path.stepId === "s1"
          ? request({ smartAccount: ACCOUNT, steps: [enrol("completed"), transfer()] as never })
          : request({ state: "completed", smartAccount: ACCOUNT, steps: [enrol("completed"), transfer({ state: "landed" })] as never });
      },
    });
    const seen: { view: StepView; ask: WalletAsk }[] = [];
    const out = await run(client, wallet(log, signs, seen), "invest_deposit", { product: PRODUCT, amount_usdt: "100" });
    expect(log).toEqual(["api:products", "api:deposit", "wallet:sign_bytes", "api:submit:s1", "wallet:send", "api:submit:s2"]);
    expect(bodies[0]).toEqual({ product: PRODUCT, amount: { kind: "assets", assetId: BNB_USDT_ASSET_ID, raw: RAW_100.toString() }, chain: "eip155:56", token: "USDT" });
    expect(bodies[2]).toEqual({ kind: "transaction", txHash: HASH, wallet: null });
    expect(seen[0]!.ask).toEqual({ kind: "sign_bytes", bytes: ENROL_BYTES });
    expect(seen[0]!.view.warning).toMatch(/cannot be read on its own/);
    expect(seen[1]!.ask).toEqual({ kind: "send", to: BNB_USDT.address, data: transferData(ACCOUNT, RAW_100), value: "0" });
    expect(out).toMatchObject({ settled: true, request: { requestId: "req_1", state: "completed" }, acted: [{ stepId: "s1" }, { stepId: "s2", value: HASH }] });
  });

  it.each([
    ["another amount", { data: transferData(ACCOUNT, RAW_100 + 1n) }, /amount/],
    ["another recipient", { data: transferData(STRANGER, RAW_100) }, /not the smart account/],
    ["another token contract", { to: STRANGER }, /deposit token's contract/],
    ["value attached", { value: "1" }, /sends value/],
  ])("refuses a transfer with %s before the wallet sees it, and sends nothing", async (_n, t, why) => {
    const log: Log = [];
    const client = api(log, {
      deposit: () => request({ steps: [enrol(), transfer({ state: "waiting", payload: false })] as never }),
      submit: () => request({ smartAccount: ACCOUNT, steps: [enrol("completed"), transfer(t)] as never }),
    });
    await expect(run(client, wallet(log, signs), "invest_deposit", { product: PRODUCT, amount_usdt: "100" })).rejects.toThrow(why);
    expect(log).not.toContain("wallet:send");
  });

  it("refuses a transfer when the request names no smart account to pay", async () => {
    const log: Log = [];
    const client = api(log, { deposit: () => request({ steps: [transfer()] as never }) });
    await expect(run(client, wallet(log, signs), "invest_deposit", { product: PRODUCT, amount_usdt: "100" })).rejects.toThrow(/names no smart account/);
    expect(log.filter((l) => l.startsWith("wallet:"))).toEqual([]);
  });

  it("refuses an amount with more than six places, or zero, before anything is asked", async () => {
    const log: Log = [];
    const client = api(log, {});
    await expect(run(client, wallet(log, signs), "invest_deposit", { product: PRODUCT, amount_usdt: "1.0000001" })).rejects.toThrow(/at most 6/);
    await expect(run(client, wallet(log, signs), "invest_deposit", { product: PRODUCT, amount_usdt: "0" })).rejects.toThrow(/above zero/);
    expect(log).toEqual([]);
  });

  it("refuses a product that is not a portfolio", async () => {
    const log: Log = [];
    await expect(run(api(log, {}), wallet(log, signs), "invest_deposit", { product: "a-vault", amount_usdt: "100" })).rejects.toThrow(/not a portfolio/);
  });

  it("a transfer the page could not record is still handed to the API by its hash, and never sent again", async () => {
    const log: Log = [];
    const bodies: unknown[] = [];
    const client = api(log, {
      deposit: () => request({ smartAccount: ACCOUNT, steps: [transfer()] as never }),
      submit: (i) => (bodies.push(i.body), request({ state: "processing", smartAccount: ACCOUNT, steps: [transfer({ state: "confirming" })] as never })),
      status: () => request({ state: "completed", smartAccount: ACCOUNT, steps: [transfer({ state: "landed" })] as never }),
    });
    const out = await run(client, wallet(log, () => ({ kind: "sent_unrecorded", hash: HASH, reason: "the result could not be posted" })), "invest_deposit", { product: PRODUCT, amount_usdt: "100" });
    expect(log.filter((l) => l === "wallet:send")).toHaveLength(1);
    expect(bodies).toEqual([{ kind: "transaction", txHash: HASH, wallet: null }]);
    expect(out.request.state).toBe("completed");
  });

  it("a sent transfer the API refused to record stops the command with its hash, and is not sent again", async () => {
    const log: Log = [];
    const client = api(log, {
      deposit: () => request({ smartAccount: ACCOUNT, steps: [transfer()] as never }),
      submit: () => ({ ok: false, status: 503, error: { code: "upstream_unavailable", message: "down", outcome: "unknown" } }),
    });
    await expect(run(client, wallet(log, signs), "invest_deposit", { product: PRODUCT, amount_usdt: "100" })).rejects.toThrow(new RegExp(`${HASH}.*Do not send it again`));
    expect(log.filter((l) => l === "wallet:send")).toHaveLength(1);
  });

  const reissued = () => ({ ...transfer(), payload: { ...(transfer().payload as object), generation: 2 } });
  it("a transfer the API asks for again after its answer to the send is refused, and never sent twice", async () => {
    const log: Log = [];
    const client = api(log, {
      deposit: () => request({ smartAccount: ACCOUNT, steps: [transfer()] as never }),
      submit: () => request({ smartAccount: ACCOUNT, steps: [reissued()] as never }),
    });
    await expect(run(client, wallet(log, signs), "invest_deposit", { product: PRODUCT, amount_usdt: "100" })).rejects.toThrow(
      new RegExp(`asks for transfer s2 again after a transfer was sent \\(transaction ${HASH}\\); not sent twice.*req_1`),
    );
    expect(log.filter((l) => l === "wallet:send")).toHaveLength(1);
  });

  it("a transfer re-issued in a later read of the request, after the send was recorded, is refused too", async () => {
    const log: Log = [];
    const client = api(log, {
      deposit: () => request({ smartAccount: ACCOUNT, steps: [transfer()] as never }),
      submit: () => request({ state: "processing", smartAccount: ACCOUNT, steps: [transfer({ state: "confirming" })] as never }),
      status: () => request({ smartAccount: ACCOUNT, steps: [reissued()] as never }),
    });
    await expect(run(client, wallet(log, () => ({ kind: "sent_unrecorded", hash: HASH, reason: "x" })), "invest_deposit", { product: PRODUCT, amount_usdt: "100" })).rejects.toThrow(/not sent twice/);
    expect(log.filter((l) => l === "wallet:send")).toHaveLength(1);
  });

  it("a signature asked for again under a new generation is given again", async () => {
    const log: Log = [];
    const enrol2 = () => ({ ...enrol(), payload: { ...(enrol().payload as object), generation: 2 } });
    let n = 0;
    const client = api(log, {
      deposit: () => request({ steps: [enrol(), transfer({ state: "waiting", payload: false })] as never }),
      submit: () =>
        ++n === 1
          ? request({ steps: [enrol2(), transfer({ state: "waiting", payload: false })] as never })
          : request({ state: "cancelled", steps: [enrol("completed"), transfer({ state: "cancelled", payload: false })] as never }),
    });
    await run(client, wallet(log, signs), "invest_deposit", { product: PRODUCT, amount_usdt: "100" });
    expect(log.filter((l) => l === "wallet:sign_bytes")).toHaveLength(2);
  });

  it("a send that ended without a hash names the request to read before anything is retried", async () => {
    const log: Log = [];
    const client = api(log, { deposit: () => request({ smartAccount: ACCOUNT, steps: [transfer()] as never }) });
    const failing = wallet(log, () => {
      throw new Error("not confirmed sent: network error. Check your wallet's activity on BNB Chain before trying again");
    });
    await expect(run(client, failing, "invest_deposit", { product: PRODUCT, amount_usdt: "100" })).rejects.toThrow(/not confirmed sent.*request req_1.*before trying again/);
    expect(log).not.toContain("api:submit:s2");
  });

  it("checks the whole request again before every step reaches the wallet", async () => {
    const log: Log = [];
    let checks = 0;
    const client = api(log, {
      deposit: () => request({ steps: [enrol(), transfer({ state: "waiting", payload: false })] as never }),
      // The second answer changes the enrolment step too: the second check sees it before the transfer is asked.
      submit: () => request({ smartAccount: ACCOUNT, steps: [{ ...enrol("completed"), purpose: "other" }, transfer()] as never }),
    });
    const w = wallet(log, (a) => (checks++, signs(a)));
    await expect(run(client, w, "invest_deposit", { product: PRODUCT, amount_usdt: "100" })).rejects.toThrow(/not the enrol signature/);
    expect(checks).toBe(1);
    expect(log).not.toContain("wallet:send");
  });

  it("reports a request still settling when the watch runs out, without failing it", async () => {
    const log: Log = [];
    const client = api(log, {
      deposit: () => request({ smartAccount: ACCOUNT, steps: [transfer()] as never }),
      submit: () => request({ state: "processing", smartAccount: ACCOUNT, steps: [transfer({ state: "confirming" })] as never }),
      status: () => request({ state: "processing", smartAccount: ACCOUNT, steps: [transfer({ state: "confirming" })] as never }),
    });
    const out = await run(client, wallet(log, signs), "invest_deposit", { product: PRODUCT, amount_usdt: "100" });
    expect(out).toMatchObject({ settled: false, request: { state: "processing" } });
  });
});

describe("invest withdraw", () => {
  const expiresAt = Math.floor(NOW / 1000) + 600;
  const typed = (o: { sale: boolean; assets: { assetId: string; amountRaw: string }[]; recipient?: string; account?: string; chainId?: number }) => ({
    domain: { name: "Glider Withdrawal Authorization", version: o.sale ? "2" : "1", chainId: o.chainId ?? 56, verifyingContract: o.account ?? ACCOUNT },
    types: {
      Withdrawal: [
        { name: "portfolioId", type: "string" },
        { name: "recipientAccountId", type: "string" },
        { name: "assets", type: "WithdrawalAsset[]" },
        { name: "nonce", type: "bytes32" },
        { name: "expiresAt", type: "uint256" },
        ...(o.sale
          ? [
              { name: "liquidate", type: "bool" },
              { name: "settlementAssetId", type: "string" },
            ]
          : []),
      ],
      WithdrawalAsset: [
        { name: "assetId", type: "string" },
        { name: "amountRaw", type: "string" },
      ],
    },
    primaryType: "Withdrawal",
    message: {
      portfolioId: "pf_1",
      recipientAccountId: `eip155:56:${o.recipient ?? OWNER}`,
      assets: o.assets,
      nonce: `0x${(o.sale ? "2" : "1").repeat(64)}`,
      expiresAt,
      ...(o.sale && { liquidate: true, settlementAssetId: BNB_USDT_ASSET_ID }),
    },
  });
  const batch = (i: number, t: ReturnType<typeof typed>) => ({
    stepId: `b${i}`,
    chainId: "eip155:56",
    state: "ready",
    checks: [],
    kind: "sign_typed_data",
    manifest: { index: i, of: 2 },
    plan: { liquidate: t.message.liquidate === true, assets: t.message.assets },
    payload: { generation: 1, expiresAt: "x", typedData: t },
  });
  const idle = [{ assetId: BNB_USDT_ASSET_ID, amountRaw: "5000000000000000000" }];
  const stock = [{ assetId: STOCK, amountRaw: "7" }];
  const positions = (account: string = ACCOUNT) => ({
    positions: [
      {
        product: PRODUCT,
        kind: "portfolio",
        stage: "invested",
        smartAccount: account,
        value: { usd: 12, state: "read", asOf: null },
        balances: [
          { assetId: BNB_USDT_ASSET_ID, raw: "5000000000000000000", decimals: 18 },
          { assetId: STOCK, raw: "7", decimals: 0 },
        ],
        idleUsd: 5,
        pnlUsd: null,
        driftPct: null,
      },
    ],
  });
  const withdrawal = (batches: ReturnType<typeof batch>[]) => request({ action: "withdraw", smartAccount: ACCOUNT, steps: batches as never });

  it("signs each checked authorization with its domain type added, and hands each signature to the API", async () => {
    const log: Log = [];
    const bodies: unknown[] = [];
    const t1 = typed({ sale: false, assets: idle });
    const t2 = typed({ sale: true, assets: stock });
    let signed = 0;
    const client = api(log, {
      positions: () => positions(),
      withdraw: (i) => (bodies.push(i.body), withdrawal([batch(0, t1), batch(1, t2)])),
      submit: () => {
        signed++;
        return signed === 1
          ? withdrawal([{ ...batch(0, t1), state: "completed" }, batch(1, t2)])
          : { ...withdrawal([{ ...batch(0, t1), state: "completed" }, { ...batch(1, t2), state: "completed" }]), state: "completed" };
      },
    });
    const seen: { view: StepView; ask: WalletAsk }[] = [];
    const out = await run(client, wallet(log, signs, seen), "invest_withdraw", { product: PRODUCT, all: true });
    expect(bodies[0]).toEqual({ product: PRODUCT, amount: { kind: "all" } });
    // Both authorizations are ready together: both are signed first, then handed back one after another.
    expect(log).toEqual(["api:products", "api:positions", "api:withdraw", "wallet:sign_typed", "wallet:sign_typed", "api:submit:b0", "api:submit:b1"]);
    for (const s of seen) {
      const td = (s.ask as { typedData: { types: Record<string, unknown> } }).typedData;
      expect(td.types["EIP712Domain"]).toEqual([
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ]);
    }
    expect(seen[0]!.view.facts).toContainEqual({ label: "Move", value: "5 USDT" });
    expect(seen[1]!.view.facts).toContainEqual({ label: "Paid to your wallet", value: OWNER });
    expect(out).toMatchObject({ settled: true, request: { state: "completed" } });
  });

  it.each([
    ["pays another wallet", [batch(0, typed({ sale: false, assets: idle, recipient: STRANGER }))], /would pay/],
    ["debits another account", [batch(0, typed({ sale: false, assets: idle, account: STRANGER }))], /would take funds from/],
    ["is for another chain", [batch(0, typed({ sale: false, assets: idle, chainId: 1 }))], /chain/],
    ["asks for more than the account holds", [batch(0, typed({ sale: true, assets: [{ assetId: STOCK, amountRaw: "8" }] }))], /more than the account holds/],
  ])("refuses an authorization that %s before the wallet sees it", async (_n, batches, why) => {
    const log: Log = [];
    const client = api(log, { positions: () => positions(), withdraw: () => withdrawal(batches) });
    await expect(run(client, wallet(log, signs), "invest_withdraw", { product: PRODUCT, all: true })).rejects.toThrow(why);
    expect(log.filter((l) => l.startsWith("wallet:"))).toEqual([]);
  });

  it("refuses a withdrawal whose second authorization names another portfolio, before anything is signed", async () => {
    const log: Log = [];
    const other = { ...typed({ sale: true, assets: stock }), message: { ...typed({ sale: true, assets: stock }).message, portfolioId: "pf_2" } };
    const client = api(log, { positions: () => positions(), withdraw: () => withdrawal([batch(0, typed({ sale: false, assets: idle })), batch(1, other as never)]) });
    await expect(run(client, wallet(log, signs), "invest_withdraw", { product: PRODUCT, all: true })).rejects.toThrow(/another portfolio/);
    expect(log.filter((l) => l.startsWith("wallet:"))).toEqual([]);
  });

  it("shows what the withdrawal leaves in the account before the first signature, and reports it", async () => {
    const log: Log = [];
    const seen: { view: StepView; ask: WalletAsk }[] = [];
    const left = [{ assetId: STOCK, raw: "1", valueUsd: 0.4, reason: "below the swap minimum" }];
    const client = api(log, {
      positions: () => positions(),
      withdraw: () => ({ ...withdrawal([batch(0, typed({ sale: false, assets: idle }))]), leftBehind: left }),
      submit: () => ({ ...withdrawal([{ ...batch(0, typed({ sale: false, assets: idle })), state: "completed" }]), state: "completed", leftBehind: left }),
    });
    const out = await run(client, wallet(log, signs, seen), "invest_withdraw", { product: PRODUCT, all: true });
    expect(seen[0]!.view.warning).toMatch(/leaves these in your account.*1 of eip155:56\/erc20:0x3333.*below the swap minimum/);
    expect(out.request.leftBehind).toEqual(left);
  });

  it("says to run the command again when the request expired before it was signed", async () => {
    const log: Log = [];
    const client = api(log, {
      positions: () => positions(),
      withdraw: () => withdrawal([batch(0, typed({ sale: false, assets: idle }))]),
      submit: () => ({ ok: false, status: 410, error: { code: "request_expired", message: "This request has expired.", outcome: "failed" } }),
    });
    await expect(run(client, wallet(log, signs), "invest_withdraw", { product: PRODUCT, all: true })).rejects.toThrow(/request_expired.*run the command again/);
  });

  it("refuses a request that debits another smart account than the positions name", async () => {
    const log: Log = [];
    const client = api(log, { positions: () => positions(STRANGER), withdraw: () => withdrawal([batch(0, typed({ sale: false, assets: idle }))]) });
    await expect(run(client, wallet(log, signs), "invest_withdraw", { product: PRODUCT, all: true })).rejects.toThrow(/your positions name/);
    expect(log.filter((l) => l.startsWith("wallet:"))).toEqual([]);
  });

  it("refuses when the wallet has no position in the portfolio, before a withdrawal is started", async () => {
    const log: Log = [];
    const client = api(log, { positions: () => ({ positions: [] }) });
    await expect(run(client, wallet(log, signs), "invest_withdraw", { product: PRODUCT, all: true })).rejects.toThrow(/no position/);
    expect(log).not.toContain("api:withdraw");
  });
});

describe("the domain type added to an authorization", () => {
  const td = (chainId: number, account: string) => ({
    domain: { name: "Glider Withdrawal Authorization", version: "1", chainId, verifyingContract: account },
    types: { Thing: [{ name: "n", type: "uint256" }] },
    primaryType: "Thing",
    message: { n: 1n },
  });
  const hash = (t: Record<string, unknown>) => hashTypedData(t as unknown as TypedDataDefinition);

  it("binds the signature to the chain and the account, which an empty domain type (what eth_signTypedData_v4 signs when the type is missing) does not", () => {
    const a = td(56, ACCOUNT);
    const b = td(1, STRANGER);
    // The wallet's behaviour, reproduced: with the type missing it signs an empty domain, the same for any chain and account.
    const asWalletWithoutType = (t: Record<string, unknown>) => hash({ ...t, types: { ...(t["types"] as object), EIP712Domain: [] } });
    expect(asWalletWithoutType(a)).toBe(asWalletWithoutType(b));
    // With the type added, the two differ, and the hash is the one the API's own checks compute.
    expect(hash(withDomainType(a))).not.toBe(hash(withDomainType(b)));
    expect(hash(withDomainType(a))).toBe(hash(a));
  });

  it("keeps a domain type already present", () => {
    const t = { ...td(56, ACCOUNT), types: { Thing: [], EIP712Domain: [{ name: "name", type: "string" }] } };
    expect((withDomainType(t)["types"] as Record<string, unknown>)["EIP712Domain"]).toEqual([{ name: "name", type: "string" }]);
  });
});

describe("invest balance and invest request", () => {
  it("reads the positions with the kept token, and opens no page when nothing needs signing", async () => {
    const log: Log = [];
    let opened = 0;
    const client = api(log, { positions: () => ({ positions: [{ product: PRODUCT, kind: "portfolio" }, { product: "v", kind: "vault" }] }) });
    const cmds = buildInvestCommands({
      client,
      now: () => NOW,
      walletDeps: {
        openPage: (async () => {
          opened++;
          throw new Error("no page in this test");
        }) as never,
      },
    });
    const out = JSON.parse(await cmds["invest_balance"]!.handler({} as never));
    expect(out.positions).toEqual([{ product: PRODUCT, kind: "portfolio" }]);
    expect(opened).toBe(0);
  });

  it("reads a request by id or by hash, cancels only by id, and takes exactly one of them", async () => {
    const log: Log = [];
    const client = api(log, {
      status: () => request({ steps: [] as never }),
      status_lookup: (i) => (log.push(`hash:${i.query.txHash}`), request({ steps: [] as never })),
      cancel: () => request({ state: "cancelled", steps: [] as never }),
    });
    const w = wallet(log, signs);
    expect((await run(client, w, "invest_request", { request_id: "req_1" })).request.state).toBe("requires_action");
    expect((await run(client, w, "invest_request", { tx_hash: HASH })).request.requestId).toBe("req_1");
    expect((await run(client, w, "invest_request", { request_id: "req_1", cancel: true })).request.state).toBe("cancelled");
    await expect(run(client, w, "invest_request", {})).rejects.toThrow(/exactly one/);
    await expect(run(client, w, "invest_request", { request_id: "req_1", tx_hash: HASH })).rejects.toThrow(/exactly one/);
    await expect(run(client, w, "invest_request", { tx_hash: HASH, cancel: true })).rejects.toThrow(/needs --request_id/);
    expect(log).toContain(`hash:${HASH}`);
  });

  it("refuses with no connected wallet", async () => {
    rmSync(join(home, "connect-session.json"));
    await expect(run(api([], {}), wallet([], signs), "invest_balance", {})).rejects.toThrow(/no wallet is connected/);
  });
});

describe("where the wallet is asked", () => {
  it("only the flow puts anything to the wallet: every step goes through the request's check first", () => {
    const dir = join(__dirname, "..", "src", "invest");
    const askers = readdirSync(dir).filter((f) => /\.ask\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(askers.sort()).toEqual(["flow.ts"]);
    const flow = readFileSync(join(dir, "flow.ts"), "utf8");
    const driveBody = flow.slice(flow.indexOf("export async function drive"));
    // In `drive`, the check comes before the step is prepared, and the step is prepared before the wallet is asked.
    const check = driveBody.indexOf("o.check(request)");
    const prepare = driveBody.indexOf("o.prepare(request, step)");
    const ask = driveBody.indexOf("deps.wallet.ask(");
    expect(check).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(check);
    expect(ask).toBeGreaterThan(prepare);
  });

  it("the sign-in shows facts read from the checked message, and refuses one for another owner", async () => {
    process.env["TREASURY_API_URL"] = `https://${HOST}`;
    const asks: { view: StepView; ask: WalletAsk }[] = [];
    const w = ownerWallet(OWNER, "t", {
      now: () => NOW,
      openPage: (async () => ({ url: "u", opened: true, done: Promise.resolve(), finish: () => undefined, ask: async (view: StepView, ask: WalletAsk) => (asks.push({ view, ask }), { kind: "answered", value: "0xsig" }) })) as never,
    });
    const msg = (owner: string) =>
      ["Tempora sign-in", `Host: ${HOST}`, "Client: treasury-cli", `Owner: ${owner}`, "Nonce: 0123456789abcdef0123456789abcdef", `Issued: ${new Date(NOW).toISOString()}   Expires: ${new Date(NOW + 300_000).toISOString()}`].join("\n");
    expect(await w.signIn(OWNER, msg(OWNER))).toBe("0xsig");
    expect(asks[0]!.view.facts).toContainEqual({ label: "API", value: HOST });
    await expect(w.signIn(OWNER, msg(STRANGER))).rejects.toThrow(/refused/);
    expect(asks).toHaveLength(1);
  });
});

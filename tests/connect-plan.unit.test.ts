import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbiItem, type Address, type Hex } from "viem";
import { buildConnectCommands, type ConnectDeps } from "../src/connect/commands.js";
import { pendingAckPath, planPath, readPlan, writeSession } from "../src/connect/session.js";
import { PLAN_MAX_LEGS, PLAN_TTL_MS, operatorWarning } from "../src/connect/ack.js";
import { DISCLOSURES } from "../src/disclosures.js";
import { defaultVault, listSolanaVaults, listVaults } from "../src/registry.js";

/**
 * `connect plan` (#155): one acknowledgement for several deposits and withdrawals, then each leg run in order
 * through the same page and gate as a single acknowledgement. Offline: the tests play the page over its HTTP
 * protocol and stub the chain reads, as `connect.unit.test.ts` does.
 */

const ACCOUNT = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const SOL_ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const vault = defaultVault();
const other = listVaults().find((v) => v.chainId !== vault.chainId && v.depositOpen.open)!;
const sol = listSolanaVaults()[0]!;

const ev = {
  approval: parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)"),
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  deposit: parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)"),
  withdraw: parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"),
};
const log = (address: Address, topics: Hex[], data: Hex) => ({ address, topics, data, blockHash: "0x" as Hex, blockNumber: 1n, logIndex: 0, transactionHash: "0x" as Hex, transactionIndex: 0, removed: false });
const u256 = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);
const approvalLog = (value: bigint) => log(vault.asset.address, encodeEventTopics({ abi: [ev.approval], eventName: "Approval", args: { owner: ACCOUNT, spender: vault.address } }) as Hex[], u256(value));
const transferLog = (value: bigint) => log(vault.asset.address, encodeEventTopics({ abi: [ev.transfer], eventName: "Transfer", args: { from: ACCOUNT, to: vault.address } }) as Hex[], u256(value));
const depositLog = (assets: bigint) =>
  log(vault.address, encodeEventTopics({ abi: [ev.deposit], eventName: "Deposit", args: { sender: ACCOUNT, owner: ACCOUNT } }) as Hex[], encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [assets, assets]));
const withdrawLog = (assets: bigint) =>
  log(vault.address, encodeEventTopics({ abi: [ev.withdraw], eventName: "Withdraw", args: { sender: ACCOUNT, receiver: ACCOUNT, owner: ACCOUNT } }) as Hex[], encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [assets, 1n]));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

let home: string;
let clock: Date;
let opened: string[];
/** What `balanceOf` returns for an account's vault shares (an EVM `withdraw … all` leg reads it). */
let shares: bigint;
/** The Solana share account's raw balance (a Solana `withdraw … all` leg reads it). */
let solShares: bigint;
/** Receipts by hash, for legs whose page the test plays to the end. */
let receipts: Record<string, unknown>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "treasury-plan-"));
  process.env["TREASURY_CONNECT_HOME"] = home;
  process.env["TREASURY_CONNECT_PORT"] = String(await freePort());
  clock = new Date("2026-10-13T12:00:00Z");
  opened = [];
  shares = 5n * 10n ** BigInt(other.shareDecimals);
  solShares = 3_000_000n;
  receipts = {};
  writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "2026-10-13T11:59:00Z" });
  writeFileSync(join(home, "connect-session-solana.json"), JSON.stringify({ account: SOL_ACCOUNT, walletType: "external", connectedAtIso: "2026-10-13T11:59:00Z" }));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env["TREASURY_CONNECT_HOME"];
  delete process.env["TREASURY_CONNECT_PORT"];
});

const tokenAccount = (amount: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return [b.toString("base64"), "base64"];
};
const deps = (over: Partial<ConnectDeps> = {}): ConnectDeps => ({
  open: (u) => (opened.push(u), true),
  client: () => ({
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => (receipts[hash] ?? new Promise<never>(() => {})) as never,
    readContract: async (q: { functionName: string }) => (q.functionName === "balanceOf" ? shares : q.functionName === "allowance" ? 10n ** 30n : 0n) as never,
  }),
  solanaRpc: { getAccountInfo: () => ({ send: async () => ({ value: { data: tokenAccount(solShares) } }) }) } as never,
  ttlMs: 150,
  balanceTimeoutMs: 20,
  verifyOpts: { attempts: 1, delayMs: 1 },
  now: () => clock,
  ...over,
});
const cmd = async (name: string, args: Record<string, unknown>, d: ConnectDeps = deps()) => {
  const c = buildConnectCommands(d)[name]!;
  return JSON.parse(await c.handler(c.inputSchema.parse(args) as never)) as Record<string, unknown>;
};
const plan = (args: Record<string, unknown>, d?: ConnectDeps) => cmd("connect_plan", args, d);

/** Runs a leg's command, as `connect plan` gave it, through the command it names. */
const runLeg = async (command: string, d?: ConnectDeps) => {
  const t = command.split(" ");
  const args: Record<string, unknown> = {};
  for (let i = 2; i < t.length; i++) {
    const flag = t[i]!.replace(/^--/, "");
    if (flag === "all") args["all"] = true;
    else args[flag] = flag === "leg" ? Number(t[++i]) : t[++i];
  }
  return cmd(`connect_${t[1]}`, args, d);
};

/** Plays the confirm page: waits for a page beyond the `before` already opened, then reports each hash in order. */
async function play(hashes: Hex[], before = 0) {
  for (let i = 0; i < 100 && opened.length <= before; i++) await new Promise((r) => setTimeout(r, 10));
  const u = new URL(opened.at(-1)!);
  for (const [index, hash] of hashes.entries()) {
    await fetch(`${u.origin}/result`, { method: "POST", headers: { "content-type": "application/json", origin: u.origin }, body: JSON.stringify({ s: u.searchParams.get("s"), index, hash }) });
  }
}

const LEGS = `deposit ${vault.symbol} 1; withdraw ${other.symbol} all; deposit ${sol.symbol} 2.5`;

describe("connect plan without --ack: one acknowledgement for every leg, and nothing opens", () => {
  it("names every leg in order, the totals, each warning once, the disclosures once, and the closing question", async () => {
    const r = await plan({ legs: LEGS });
    expect(r["status"]).toBe("needs_acknowledgement");
    expect(r["opened"]).toBe(false);
    expect(opened).toEqual([]);
    expect(r["ack"]).toMatch(/^[0-9a-f]{8}$/);
    expect(r["expiresAtIso"]).toBe(new Date(clock.getTime() + PLAN_TTL_MS).toISOString());
    const text = String(r["acknowledgement"]);
    const i1 = text.indexOf(`1. Deposit: 1 ${vault.asset.symbol}`);
    const i2 = text.indexOf(`2. Withdraw: 5 ${other.symbol} shares`);
    const i3 = text.indexOf(`3. Deposit: 2.5 ${sol.asset.symbol}`);
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(text).toContain(`Vault: ${vault.name} (${vault.symbol})`);
    expect(text).toContain(`Vault: ${sol.name} (${sol.symbol})`);
    expect(text).toContain(`Shares go to: ${ACCOUNT} (the connected wallet)`);
    expect(text).toContain(`Shares go to: ${SOL_ACCOUNT} (the connected wallet)`);
    expect(text).toContain("Chain: Solana (mainnet-beta)");
    expect(text).toContain("In total: deposit");
    expect(text).toContain("withdraw the whole position in 1 vault");
    expect(text).toContain(`WARNING (${vault.symbol}`);
    expect(text).toContain(operatorWarning(other.warning, "withdraw"));
    for (const d of [...DISCLOSURES.plain.deposit, ...DISCLOSURES.plain.always]) expect(text.split(d).length - 1).toBe(1);
    expect(text).toContain("If a leg does not complete, the legs after it do not run.");
    expect(text.trimEnd().endsWith("for exactly these 3 legs? Reply yes or no.")).toBe(true);
  });

  it("records the plan as pending, unacknowledged, and leaves a single acknowledgement untouched", async () => {
    const single = await cmd("connect_deposit", { vault: vault.symbol, amount_usdc: "1", receiver: ACCOUNT });
    const r = await plan({ legs: LEGS });
    const p = readPlan()!;
    expect(p.code).toBe(r["ack"]);
    expect(p.acknowledged).toBe(false);
    expect(p.legs.map((l) => [l.leg, l.action, l.vault, l.status])).toEqual([
      [1, "deposit", vault.symbol, "pending"],
      [2, "withdraw", other.symbol, "pending"],
      [3, "deposit", sol.symbol, "pending"],
    ]);
    expect(JSON.parse(readFileSync(pendingAckPath(), "utf8")).code).toBe(single["ack"]);
  });

  it("withdraw … all binds the share balance read now", async () => {
    await plan({ legs: `withdraw ${other.symbol} all; withdraw ${sol.symbol} all` });
    expect(readPlan()!.legs.map((l) => l.command)).toEqual([expect.stringContaining("--all --shares_exact 5 "), expect.stringContaining("--all --shares_exact 3 ")]);
  });

  const refused: [string, string, RegExp][] = [
    ["an empty plan", " ; ", /names no leg/],
    ["an unknown action", `swap ${vault.symbol} 1`, /"deposit" or "withdraw"/],
    ["a deposit of all", `deposit ${vault.symbol} all`, /a deposit takes an amount/],
    ["an amount that is not a plain decimal", `deposit ${vault.symbol} 1e3`, /not a plain decimal/],
    ["a leg with a missing amount", `deposit ${vault.symbol}`, /write each leg as/],
    ["a vault that is not listed", `deposit tlNOPE 1`, /tlNOPE/],
    ["a withdraw-all of a vault an earlier leg deposits into", `deposit ${vault.symbol} 1; withdraw ${vault.symbol} all`, /an earlier leg deposits into/],
    ["more legs than a plan holds", Array.from({ length: PLAN_MAX_LEGS + 1 }, () => `deposit ${vault.symbol} 1`).join(";"), /at most/],
  ];
  for (const [what, legs, why] of refused) {
    it(`refuses ${what}, writing no plan`, async () => {
      await expect(plan({ legs })).rejects.toThrow(why);
      expect(existsSync(planPath())).toBe(false);
    });
  }

  it("refuses a withdraw-all of a position that holds no shares", async () => {
    shares = 0n;
    await expect(plan({ legs: `withdraw ${other.symbol} all` })).rejects.toThrow(/holds no shares/);
  });

  it("refuses a leg on a chain family whose wallet is not connected", async () => {
    rmSync(join(home, "connect-session-solana.json"));
    await expect(plan({ legs: LEGS })).rejects.toThrow(/no Solana wallet is connected/);
  });
});

describe("connect plan --ack: records the operator's yes, opens nothing", () => {
  it("the plan's code acknowledges it and returns each leg's exact command", async () => {
    const { ack } = await plan({ legs: LEGS });
    const r = await plan({ legs: LEGS, ack });
    expect(r["status"]).toBe("acknowledged");
    expect(opened).toEqual([]);
    const legs = r["legs"] as { leg: number; command: string }[];
    expect(legs.map((l) => l.command)).toEqual([
      `connect deposit --vault ${vault.symbol} --amount_usdc 1 --receiver ${ACCOUNT} --plan ${ack} --leg 1`,
      `connect withdraw --vault ${other.symbol} --all --shares_exact 5 --receiver ${ACCOUNT} --plan ${ack} --leg 2`,
      `connect deposit --vault ${sol.symbol} --amount_usdc 2.5 --receiver ${SOL_ACCOUNT} --plan ${ack} --leg 3`,
    ]);
    expect(String(r["next_step"])).toContain("do not ask again between legs");
    expect(readPlan()!.acknowledged).toBe(true);
  });

  const cases: [string, (ack: string) => Promise<unknown>, RegExp][] = [
    ["a code that is not the plan's", () => plan({ legs: LEGS, ack: "00000000" }), /not the pending plan's code/],
    ["different legs", (ack) => plan({ legs: LEGS.replace("2.5", "3"), ack }), /not the ones the operator acknowledged/],
    ["the same legs in another order", (ack) => plan({ legs: LEGS.split(";").reverse().join(";"), ack }), /not the ones the operator acknowledged/],
    ["a share balance that moved", (ack) => ((shares = 6n * 10n ** BigInt(other.shareDecimals)), plan({ legs: LEGS, ack })), /not the ones the operator acknowledged/],
    ["an expired plan", (ack) => ((clock = new Date(clock.getTime() + PLAN_TTL_MS + 1)), plan({ legs: LEGS, ack })), /expired/],
  ];
  for (const [what, run, why] of cases) {
    it(`refuses ${what}`, async () => {
      const { ack } = await plan({ legs: LEGS });
      await expect(run(String(ack))).rejects.toThrow(why);
      expect(readPlan()!.acknowledged).toBe(false);
    });
  }

  it("refuses a second --ack of the same plan", async () => {
    const { ack } = await plan({ legs: LEGS });
    await plan({ legs: LEGS, ack });
    await expect(plan({ legs: LEGS, ack })).rejects.toThrow(/already acknowledged/);
  });

  it("refuses with no plan pending", async () => {
    await expect(plan({ legs: LEGS, ack: "0123abcd" })).rejects.toThrow(/no plan is pending/);
  });

  it("a newer plan replaces the older one, whose code then acknowledges nothing", async () => {
    const first = await plan({ legs: LEGS });
    clock = new Date(clock.getTime() + 1_000);
    await plan({ legs: LEGS });
    await expect(plan({ legs: LEGS, ack: first["ack"] })).rejects.toThrow(/not the pending plan's code/);
  });
});

describe("a plan's legs: in order, each held to what was acknowledged, and a leg that does not complete ends the plan", () => {
  async function acknowledged(legs = LEGS) {
    const { ack } = await plan({ legs });
    const r = await plan({ legs, ack });
    return { code: String(ack), commands: (r["legs"] as { command: string }[]).map((l) => l.command) };
  }

  it("refuses a leg before the plan is acknowledged, and opens nothing", async () => {
    const { ack } = await plan({ legs: LEGS });
    await expect(cmd("connect_deposit", { vault: vault.symbol, amount_usdc: "1", receiver: ACCOUNT, plan: ack, leg: 1 })).rejects.toThrow(/has not been acknowledged/);
    expect(opened).toEqual([]);
  });

  it("refuses leg 2 before leg 1 has run", async () => {
    const { commands } = await acknowledged();
    await expect(runLeg(commands[1]!)).rejects.toThrow(/legs run in order, and leg 1 has not completed/);
    expect(opened).toEqual([]);
  });

  it("refuses a leg whose amount, vault or receiver is not the one acknowledged", async () => {
    const { commands } = await acknowledged();
    await expect(runLeg(commands[0]!.replace("--amount_usdc 1", "--amount_usdc 2"))).rejects.toThrow(/not leg 1 as the operator acknowledged it/);
    await expect(runLeg(commands[0]!.replace(`--vault ${vault.symbol}`, `--vault ${listVaults().find((v) => v.chainId === vault.chainId && v.symbol !== vault.symbol && v.depositOpen.open)!.symbol}`))).rejects.toThrow(
      /not leg 1 as the operator acknowledged it/,
    );
    await expect(runLeg(commands[0]!.replace(`--receiver ${ACCOUNT}`, "--receiver 0x2222222222222222222222222222222222222222"))).rejects.toThrow(/not the connected account/);
    expect(opened).toEqual([]);
  });

  it("refuses a leg run under another plan's code, or a leg the plan does not have", async () => {
    const { commands } = await acknowledged();
    await expect(runLeg(commands[0]!.replace(/--plan \w+/, "--plan 00000000"))).rejects.toThrow(/not the pending plan's code/);
    await expect(runLeg(commands[0]!.replace("--leg 1", "--leg 9"))).rejects.toThrow(/has no leg 9/);
  });

  it("refuses --plan with --ack, and --plan without --leg", async () => {
    const { code } = await acknowledged();
    await expect(cmd("connect_deposit", { vault: vault.symbol, amount_usdc: "1", receiver: ACCOUNT, plan: code, leg: 1, ack: "0123abcd" })).rejects.toThrow(/not both/);
    await expect(cmd("connect_deposit", { vault: vault.symbol, amount_usdc: "1", receiver: ACCOUNT, plan: code })).rejects.toThrow(/go together/);
  });

  it("refuses a leg that has not started by the plan's expiry", async () => {
    const { commands } = await acknowledged();
    clock = new Date(clock.getTime() + PLAN_TTL_MS + 1);
    await expect(runLeg(commands[0]!)).rejects.toThrow(/expired/);
    expect(opened).toEqual([]);
  });

  it("a leg whose page reports nothing ends the plan: it is not_reported, and no later leg runs", async () => {
    const { commands } = await acknowledged();
    const r = await runLeg(commands[0]!);
    expect(opened).toHaveLength(1);
    expect(r["status"]).toBe("not_reported");
    expect(r["plan"]).toMatchObject({ leg: 1, of: 3 });
    expect(String(r["next_step"])).toMatch(/^The plan ended at leg 1 of 3/);
    expect(readPlan()!.legs.map((l) => l.status)).toEqual(["not_reported", "pending", "pending"]);
    await expect(runLeg(commands[1]!)).rejects.toThrow(/the plan ended at leg 1/);
    await expect(runLeg(commands[0]!)).rejects.toThrow(/already run/);
    expect(opened).toHaveLength(1);
  });

  it("a leg is marked running before its page opens: it cannot be started twice, and no later leg starts meanwhile", async () => {
    const { commands } = await acknowledged();
    const first = runLeg(commands[0]!, deps({ ttlMs: 400 }));
    for (let i = 0; i < 100 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(readPlan()!.legs[0]!.status).toBe("running");
    await expect(runLeg(commands[0]!)).rejects.toThrow(/leg 1 has already run \(running\)/);
    await expect(runLeg(commands[1]!)).rejects.toThrow(/leg 1 is still running/);
    expect((await first)["status"]).toBe("not_reported");
    expect(opened).toHaveLength(1);
  });

  it("two EVM legs run end to end: each page, each receipt matched, the plan completed, then nothing reruns", async () => {
    const legs = `deposit ${vault.symbol} 0.6; withdraw ${vault.symbol} 0.25`;
    const { commands } = await acknowledged(legs);
    const [h1, h2, h3] = ([1, 2, 3] as const).map((n) => `0x${String(n).padStart(2, "0").repeat(32)}` as Hex);
    receipts = {
      [h1]: { status: "success", logs: [approvalLog(600_000n)] },
      [h2]: { status: "success", logs: [transferLog(600_000n), depositLog(600_000n)] },
      [h3]: { status: "success", logs: [withdrawLog(250_000n)] },
    };
    const d = deps({ ttlMs: 5_000 });
    const leg1 = runLeg(commands[0]!, d);
    await play([h1, h2]);
    const r1 = await leg1;
    expect(r1["status"]).toBe("completed");
    expect(String(r1["next_step"])).toContain(commands[1]!);
    // A real leg runs in its own process after the last one exited; here the first page's server may still hold its port.
    process.env["TREASURY_CONNECT_PORT"] = String(await freePort());
    const leg2 = runLeg(commands[1]!, d);
    await play([h3], 1);
    const r2 = await leg2;
    expect(r2["status"]).toBe("completed");
    expect(r2["plan"]).toMatchObject({ leg: 2, of: 2 });
    expect(String(r2["next_step"])).toContain("the whole plan");
    const status = await plan({ status: true });
    expect((status["legs"] as { status: string; txs: { hash: string; verified: string }[] }[]).map((l) => [l.status, l.txs.map((t) => [t.hash, t.verified])])).toEqual([
      ["completed", [[h1, "matched"], [h2, "matched"]]],
      ["completed", [[h3, "matched"]]],
    ]);
    await expect(runLeg(commands[1]!, d)).rejects.toThrow(/already run/);
    expect(opened).toHaveLength(2);
  });

  it("reconnecting a wallet voids the plan", async () => {
    const { commands } = await acknowledged();
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "2026-10-13T12:01:00Z" });
    expect(existsSync(planPath())).toBe(false);
    await expect(runLeg(commands[0]!)).rejects.toThrow(/no plan is pending/);
    expect(opened).toEqual([]);
  });

  it("a single acknowledgement still works beside a plan, and cannot run a plan's leg", async () => {
    const { code } = await acknowledged();
    const single = await cmd("connect_deposit", { vault: vault.symbol, amount_usdc: "7", receiver: ACCOUNT });
    expect(single["status"]).toBe("needs_acknowledgement");
    await expect(cmd("connect_deposit", { vault: vault.symbol, amount_usdc: "7", receiver: ACCOUNT, ack: code })).rejects.toThrow(/not the pending acknowledgement's code/);
    expect(readPlan()!.legs.every((l) => l.status === "pending")).toBe(true);
  });
});

describe("connect plan --status", () => {
  it("reports no plan, then the pending plan and its legs", async () => {
    expect((await plan({ status: true }))["status"]).toBe("none");
    const { ack } = await plan({ legs: LEGS });
    const s = await plan({ status: true });
    expect(s).toMatchObject({ status: "needs_acknowledgement", code: ack });
    expect((s["legs"] as unknown[]).length).toBe(3);
  });

  it("takes no other flag", async () => {
    await expect(plan({ status: true, legs: LEGS })).rejects.toThrow(/takes no other flag/);
  });
});

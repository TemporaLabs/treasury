import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbiItem, type Address, type Hex } from "viem";
import { buildConnectCommands, type ConnectDeps } from "../src/connect/commands.js";
import { clearSession, pendingAckPath, planPath, readPlan, writeSession, writeSolanaSession } from "../src/connect/session.js";
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
    // Three vaults: the fee sentence speaks of all of them, once; every other disclosure appears once as written.
    const fees = DISCLOSURES.plain.deposit.find((d) => d.startsWith("Tempora Labs runs this vault"))!;
    expect(text).not.toContain(fees);
    expect(text.split(DISCLOSURES.plain.feesSeveral).length - 1).toBe(1);
    for (const d of [...DISCLOSURES.plain.deposit, ...DISCLOSURES.plain.always].filter((d) => d !== fees)) expect(text.split(d).length - 1).toBe(1);
    expect(text).toContain("If a leg does not complete, the legs after it do not run.");
    expect(text).toContain("The plan lasts 60 minutes: a leg not started by then does not run, and connecting a wallet again cancels it.");
    // The withdraw-all leg says its balance was read, and not the single acknowledgement's "not checked here".
    expect(text).toContain(`2. Withdraw: 5 ${other.symbol} shares (your whole position, read when this plan was made;`);
    expect(text).not.toContain("not checked here");
    // One warning for the family, naming all three vaults, with the deposit advice named for the deposits only.
    const warningLines = text.split("\n").filter((l) => l.startsWith("WARNING"));
    expect(warningLines).toEqual([`WARNING (${vault.symbol}, ${other.symbol}, ${sol.symbol}): ${operatorWarning(other.warning, "withdraw")}`]);
    expect(text).toContain(`  For the deposits (${vault.symbol}, ${sol.symbol}): Deposit only`);
    expect(text.trimEnd().endsWith("for exactly these 3 legs, run one leg at a time? Reply yes or no.")).toBe(true);
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

  it("a plan on one vault keeps the fee sentence as a single acknowledgement words it", async () => {
    const r = await plan({ legs: `deposit ${vault.symbol} 1; withdraw ${vault.symbol} 0.5` });
    const text = String(r["acknowledgement"]);
    expect(text).toContain(DISCLOSURES.plain.deposit.find((d) => d.startsWith("Tempora Labs runs this vault"))!);
    expect(text).not.toContain(DISCLOSURES.plain.feesSeveral);
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
    ["a withdraw-all of a vault an earlier leg withdraws from", `withdraw ${other.symbol} 1; withdraw ${other.symbol} all`, /an earlier leg withdraws from/],
    ["two withdraw-alls of one vault", `withdraw ${other.symbol} all; withdraw ${other.symbol} all`, /an earlier leg withdraws from/],
    ["a leg on a vault after a withdraw-all of it", `withdraw ${other.symbol} all; deposit ${other.symbol} 1`, /an earlier leg withdraws in full/],
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
    // This plan has a Solana leg, so its legs run one at a time; `--run` serves EVM legs only.
    expect(String(r["next_step"])).toContain(`Start with leg 1: ${legs[0]!.command}`);
    expect(String(r["next_step"])).not.toContain("--run");
    expect(readPlan()!.acknowledged).toBe(true);
  });

  it("a plan of EVM legs points at `connect plan --run`, one page for every leg", async () => {
    const evm = `deposit ${vault.symbol} 1; withdraw ${other.symbol} all`;
    const { ack } = await plan({ legs: evm });
    const r = await plan({ legs: evm, ack });
    expect(String(r["next_step"])).toContain("Run `connect plan --run`");
    expect(String(r["next_step"])).not.toContain("Start with leg 1");
    expect(opened).toEqual([]);
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

  it("a Solana leg runs under the plan, held to its acknowledged intent; a changed amount is refused before anything opens", async () => {
    const { commands } = await acknowledged(`deposit ${sol.symbol} 2.5`);
    await expect(runLeg(commands[0]!.replace("--amount_usdc 2.5", "--amount_usdc 3"))).rejects.toThrow(/not leg 1 as the operator acknowledged it/);
    expect(opened).toEqual([]);
    // Past the plan's check the flow goes on to read the vault, which this stub RPC cannot serve (as in the single
    // acknowledgement's Solana tests): what matters is that the leg was accepted, marked, and cannot run again.
    const err = await runLeg(commands[0]!).then(() => "", (e: Error) => e.message);
    expect(err).not.toMatch(/acknowledged|plan/);
    // A leg whose run throws is not_reported, with the error as its reason: never left "running".
    expect(readPlan()!.legs[0]).toMatchObject({ status: "not_reported", reason: err });
    await expect(runLeg(commands[0]!)).rejects.toThrow(/already run/);
  });

  it("a leg that lands but does not match (here, reverted) is stopped, and ends the plan: the next leg never runs", async () => {
    const legs = `withdraw ${vault.symbol} 0.25; deposit ${vault.symbol} 0.6`;
    const { commands } = await acknowledged(legs);
    const h = `0x${"07".repeat(32)}` as Hex;
    receipts = { [h]: { status: "reverted", logs: [] } };
    const leg1 = runLeg(commands[0]!, deps({ ttlMs: 5_000 }));
    await play([h]);
    const r1 = await leg1;
    expect(r1["status"]).toBe("stopped");
    expect(String(r1["next_step"])).toMatch(/^The plan ended at leg 1 of 2/);
    expect(readPlan()!.legs.map((l) => l.status)).toEqual(["stopped", "pending"]);
    process.env["TREASURY_CONNECT_PORT"] = String(await freePort());
    await expect(runLeg(commands[1]!)).rejects.toThrow(/the plan ended at leg 1 \(stopped\)/);
    expect(opened).toHaveLength(1);
  });

  it("an expiry that cannot be read counts as expired, for the leg and for the acknowledgement", async () => {
    const { commands } = await acknowledged();
    writeFileSync(planPath(), JSON.stringify({ ...readPlan()!, expiresAtIso: "not a date" }));
    await expect(runLeg(commands[0]!)).rejects.toThrow(/expired/);
    const { ack } = await plan({ legs: LEGS });
    writeFileSync(planPath(), JSON.stringify({ ...readPlan()!, expiresAtIso: "not a date" }));
    await expect(plan({ legs: LEGS, ack })).rejects.toThrow(/expired/);
    expect(opened).toEqual([]);
  });

  it("a plan file with a leg that does not read back whole is no plan", async () => {
    const { commands } = await acknowledged();
    const p = readPlan()!;
    writeFileSync(planPath(), JSON.stringify({ ...p, legs: [{ ...p.legs[0]!, digest: undefined }, ...p.legs.slice(1)] }));
    expect(readPlan()).toBeUndefined();
    await expect(runLeg(commands[0]!)).rejects.toThrow(/no plan is pending/);
  });

  it("reconnecting the Solana wallet voids the plan too", async () => {
    await acknowledged();
    writeSolanaSession({ account: SOL_ACCOUNT, walletType: "external", connectedAtIso: "2026-10-13T12:01:00Z" });
    expect(existsSync(planPath())).toBe(false);
  });

  it("disconnecting voids the plan", async () => {
    await acknowledged();
    clearSession();
    expect(existsSync(planPath())).toBe(false);
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

describe("connect plan --run: one page for every leg (#174)", () => {
  const EVM_LEGS = `deposit ${vault.symbol} 0.6; withdraw ${vault.symbol} 0.25`;
  const [h1, h2, h3] = ([1, 2, 3] as const).map((n) => `0x${String(n).padStart(2, "0").repeat(32)}` as Hex);
  const landedReceipts = () => ({
    [h1]: { status: "success", logs: [approvalLog(600_000n)] },
    [h2]: { status: "success", logs: [transferLog(600_000n), depositLog(600_000n)] },
    [h3]: { status: "success", logs: [withdrawLog(250_000n)] },
  });
  async function acked(legs = EVM_LEGS) {
    const { ack } = await plan({ legs });
    await plan({ legs, ack });
  }
  /** The plan page this run opened (or the one already open): where to post, and its secret. */
  async function pageOf(before = 0) {
    for (let i = 0; i < 200 && opened.length <= before; i++) await new Promise((r) => setTimeout(r, 10));
    const u = new URL(opened.at(-1)!);
    return { u, s: u.searchParams.get("s")! };
  }
  const send = async (u: URL, s: string, body: Record<string, unknown>) =>
    (await fetch(`${u.origin}/result`, { method: "POST", headers: { "content-type": "application/json", origin: u.origin }, body: JSON.stringify({ s, ...body }) })).json() as Promise<Record<string, unknown>>;
  const info = async (u: URL, s: string) => (await fetch(`${u.origin}/info?s=${s}`)).json() as Promise<Record<string, unknown>>;

  it("walks every leg on ONE page: each leg started in order, each call checked from its receipt, the plan completed", async () => {
    await acked();
    receipts = landedReceipts();
    const run = plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 0 }));
    const { u, s } = await pageOf();
    expect(u.pathname).toBe("/plan");
    // Leg 2 cannot start before leg 1.
    expect((await send(u, s, { start: 2 }))["ok"]).toBe(false);
    expect(await send(u, s, { start: 1 })).toMatchObject({ ok: true, started: 1 });
    const i1 = await info(u, s);
    expect((i1["current"] as { leg: number; calls: unknown[] }).leg).toBe(1);
    expect((i1["current"] as { calls: unknown[] }).calls).toHaveLength(2);
    expect(await send(u, s, { index: 0, hash: h1 })).toMatchObject({ ok: true, next: 1 });
    expect(await send(u, s, { index: 1, hash: h2 })).toMatchObject({ ok: true, finished: true, legDone: true });
    expect(await send(u, s, { start: 2 })).toMatchObject({ ok: true, started: 2 });
    expect(await send(u, s, { index: 0, hash: h3 })).toMatchObject({ ok: true, finished: true, planDone: true });
    const r = await run;
    expect(r["status"]).toBe("completed");
    expect((r["legs"] as { status: string }[]).map((l) => l.status)).toEqual(["completed", "completed"]);
    expect(opened).toHaveLength(1);
    // Nothing is left to run: a second --run opens nothing.
    expect((await plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 0 })))["status"]).toBe("completed");
    expect(opened).toHaveLength(1);
  });

  it("a leg the wallet declined, then stopped on the page, ends the plan: nothing sent for it, later legs never run", async () => {
    await acked();
    const run = plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 0 }));
    const { u, s } = await pageOf();
    await send(u, s, { start: 1 });
    await send(u, s, { rejected: true, declined: true, reason: "declined in the wallet; the operator stopped the plan" });
    const r = await run;
    expect(r["status"]).toBe("stopped");
    expect(readPlan()!.legs.map((l) => [l.status, l.reason ?? ""])).toEqual([
      ["stopped", "declined in the wallet; the operator stopped the plan"],
      ["pending", ""],
    ]);
    expect((await plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 0 })))["status"]).toBe("stopped");
    expect(opened).toHaveLength(1);
  });

  it("a hash the page could not hand over leaves its leg 'may have been sent' (not_reported), never 'nothing sent'", async () => {
    await acked();
    const run = plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 0 }));
    const { u, s } = await pageOf();
    await send(u, s, { start: 1 });
    await send(u, s, { rejected: true, reason: "the page lost its connection", hash: h1, index: 0 });
    const r = await run;
    expect(r["status"]).toBe("not_reported");
    const leg1 = readPlan()!.legs[0]!;
    expect(leg1.status).toBe("not_reported");
    expect(leg1.reason).toMatch(/^may have been sent/);
    expect(leg1.txs).toEqual([{ hash: h1, verified: "unverified" }]);
  });

  it("one leg at a time: no second start while a leg is in the wallet; a page that ends the leg without a decline is not_reported", async () => {
    await acked();
    const run = plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 0 }));
    const { u, s } = await pageOf();
    await send(u, s, { start: 1 });
    expect(await send(u, s, { start: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/already in progress/) });
    // No declined flag and no hash: the page cannot say the wallet sent nothing, so the leg is not "stopped".
    await send(u, s, { rejected: true, reason: "the page was closed" });
    expect((await run)["status"]).toBe("not_reported");
    expect(readPlan()!.legs.map((l) => [l.status, l.reason ?? ""])).toEqual([
      ["not_reported", "the page was closed"],
      ["pending", ""],
    ]);
  });

  it("a leg that finishes near the time limit hands over: the run returns in_progress before the next leg starts", async () => {
    await acked();
    receipts = landedReceipts();
    const run = plan({ run: true }, deps({ ttlMs: 20_000, legMinMs: 19_000 }));
    const { u, s } = await pageOf();
    expect(await send(u, s, { start: 1 })).toMatchObject({ ok: true, started: 1 });
    await send(u, s, { index: 0, hash: h1 });
    await new Promise((r) => setTimeout(r, 1200));
    expect(await send(u, s, { index: 1, hash: h2 })).toMatchObject({ ok: true, legDone: true, paused: true });
    expect((await run)["status"]).toBe("in_progress");
    expect(readPlan()!.legs.map((l) => l.status)).toEqual(["completed", "pending"]);
  });

  it("stopping between legs ends the plan before the next leg", async () => {
    await acked();
    receipts = landedReceipts();
    const run = plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 0 }));
    const { u, s } = await pageOf();
    await send(u, s, { start: 1 });
    await send(u, s, { index: 0, hash: h1 });
    await send(u, s, { index: 1, hash: h2 });
    await send(u, s, { rejected: true, reason: "the operator stopped the plan after the previous step" });
    expect((await run)["status"]).toBe("stopped");
    expect(readPlan()!.legs.map((l) => l.status)).toEqual(["completed", "stopped"]);
    expect(readPlan()!.legs[1]!.reason).toMatch(/^the operator stopped the plan before this leg/);
  });

  it("near the time limit no leg starts: the run returns in_progress, and the next run serves the same page", async () => {
    await acked();
    const run1 = plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 60_000 }));
    const { u, s } = await pageOf();
    expect(await send(u, s, { start: 1 })).toMatchObject({ ok: true, paused: true });
    const r1 = await run1;
    expect(r1["status"]).toBe("in_progress");
    expect(String(r1["next_step"])).toMatch(/run `connect plan --run` again/);
    expect(readPlan()!.legs.map((l) => l.status)).toEqual(["pending", "pending"]);
    expect(readPlan()!.page).toEqual({ secret: s, port: Number(u.port) });
    // The second run serves the same secret on the same port, and opens no second tab.
    await new Promise((r) => setTimeout(r, 1600));
    const run2 = plan({ run: true }, deps({ ttlMs: 10_000, legMinMs: 0 }));
    let ok = false;
    for (let i = 0; i < 200 && !ok; i++) {
      ok = await fetch(`${u.origin}/info?s=${s}`).then((r) => r.ok, () => false);
      if (!ok) await new Promise((r) => setTimeout(r, 20));
    }
    expect(ok).toBe(true);
    expect(opened).toHaveLength(1);
    await send(u, s, { start: 1 });
    await send(u, s, { rejected: true, declined: true, reason: "declined" });
    expect((await run2)["status"]).toBe("stopped");
  });

  it("refuses before the plan is acknowledged, a plan with a Solana leg, and a leg that no longer rebuilds to what was acknowledged", async () => {
    await plan({ legs: EVM_LEGS });
    await expect(plan({ run: true })).rejects.toThrow(/has not been acknowledged/);
    const { ack } = await plan({ legs: LEGS });
    await plan({ legs: LEGS, ack });
    await expect(plan({ run: true })).rejects.toThrow(/EVM legs only/);
    await acked();
    const p = readPlan()!;
    writeFileSync(planPath(), JSON.stringify({ ...p, legs: p.legs.map((l, i) => (i === 1 ? { ...l, args: { ...l.args!, amount_usdc: "9" } } : l)) }));
    await expect(plan({ run: true })).rejects.toThrow(/leg 2 is not what the operator acknowledged/);
    expect(opened).toEqual([]);
  });

  it("takes no other flag", async () => {
    await expect(plan({ run: true, status: true })).rejects.toThrow(/--run takes no other flag/);
  });
});

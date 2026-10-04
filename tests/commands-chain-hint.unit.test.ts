/**
 * The setup hint on a FAILED Arbitrum call names Arbitrum's variable — on the pre-flight verdict path
 * and on the thrown path — with Arbitrum unconfigured and Base configured. A hint keyed on the default
 * chain would tell this operator to set the Base variable for a call that failed on Arbitrum.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dead = {
  getBlockNumber: async () => { throw new Error("HTTP request failed. fetch failed"); },
  readContract: async () => { throw new Error("HTTP request failed. fetch failed"); },
  simulateContract: async () => { throw new Error("HTTP request failed. fetch failed"); },
  getLogs: async () => { throw new Error("HTTP request failed. fetch failed"); },
  getChainId: async () => { throw new Error("HTTP request failed. fetch failed"); },
};
vi.mock("../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client.js")>();
  return { ...actual, makePublicClient: () => dead };
});

type Handler = (a: unknown, extra: unknown) => Promise<string>;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
let savedBase: string | undefined, savedBaseUrl: string | undefined, savedArb: string | undefined, savedArbUrl: string | undefined;
beforeEach(() => {
  savedBase = process.env["TREASURY_RPC_BASE"]; savedBaseUrl = process.env["BASE_RPC_URL"];
  savedArb = process.env["TREASURY_RPC_ARBITRUM"]; savedArbUrl = process.env["ARBITRUM_RPC_URL"];
  delete process.env["BASE_RPC_URL"]; delete process.env["TREASURY_RPC_ARBITRUM"]; delete process.env["ARBITRUM_RPC_URL"];
  process.env["TREASURY_RPC_BASE"] = "https://base.example.invalid/v2/BASEKEY12345";
});
afterEach(() => {
  const put = (k: "TREASURY_RPC_BASE" | "BASE_RPC_URL" | "TREASURY_RPC_ARBITRUM" | "ARBITRUM_RPC_URL", v: string | undefined) => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  put("TREASURY_RPC_BASE", savedBase); put("BASE_RPC_URL", savedBaseUrl); put("TREASURY_RPC_ARBITRUM", savedArb); put("ARBITRUM_RPC_URL", savedArbUrl);
});

describe("a failed Arbitrum call hints at ARBITRUM's variable when only Base is configured", () => {
  it("preflight verdict path (returned payload)", async () => {
    const { buildCommands } = await import("../src/earn/commands.js");
    const tools = buildCommands() as unknown as Record<string, { handler: Handler }>;
    const out = await tools["earn_status"]!.handler({ chain: "arbitrum", account: ACCOUNT }, {});
    const d = JSON.parse(out);
    expect(d.status).toBe("UNRESOLVED");
    expect(d.setup_required).toMatch(/TREASURY_RPC_ARBITRUM/);
    expect(out).not.toMatch(/TREASURY_RPC_BASE/);
  });
  it("thrown path (guarded)", async () => {
    const { buildCommands } = await import("../src/earn/commands.js");
    const tools = buildCommands() as unknown as Record<string, { handler: Handler }>;
    const err = await tools["earn_balance"]!.handler({ chain: "arbitrum", account: ACCOUNT }, {}).then(() => "", (e: Error) => e.message);
    expect(err).toMatch(/HTTP request failed/);
    expect(err).toMatch(/TREASURY_RPC_ARBITRUM/);
    expect(err).not.toMatch(/TREASURY_RPC_BASE/);
  });
});

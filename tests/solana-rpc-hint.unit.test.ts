/**
 * A Solana call that fails on the public endpoint's rate limit carries the setup hint that names
 * TREASURY_RPC_SOLANA. The Solana client reports it as `HTTP error (429): …`, which the transport-failure
 * shapes did not include, so the hint never attached on Solana.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SOLANA_INFO } from "../src/client.js";

let failure = "HTTP error (429): Too Many Requests";
const dead = new Proxy({}, { get: () => () => ({ send: async () => { throw new Error(failure); } }) });
vi.mock("../src/solana/rpc.js", async (load) => ({ ...(await load<typeof import("../src/solana/rpc.js")>()), makeSolanaRpc: () => dead }));

type Handler = (a: unknown, extra: unknown) => Promise<string>;
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

beforeEach(() => {
  for (const k of SOLANA_INFO.rpcEnv) delete process.env[k];
});

async function status(): Promise<{ status?: string; setup_required?: string }> {
  const { buildCommands } = await import("../src/earn/commands.js");
  const tools = buildCommands() as unknown as Record<string, { handler: Handler }>;
  return JSON.parse(await tools["earn_status"]!.handler({ chain: "solana", account: ACCOUNT }, {}));
}

describe("the Solana setup hint", () => {
  it("attaches to a 429 from the public endpoint", async () => {
    failure = "HTTP error (429): Too Many Requests";
    const d = await status();
    expect(d.status).toBe("UNRESOLVED");
    expect(d.setup_required).toMatch(/TREASURY_RPC_SOLANA/);
  });

  it("attaches to a 5xx", async () => {
    failure = "HTTP error (503): Service Unavailable";
    expect((await status()).setup_required).toMatch(/TREASURY_RPC_SOLANA/);
  });

  it("does not attach to a 4xx that is not a rate limit: that is not a setup problem", async () => {
    failure = "HTTP error (404): Not Found";
    expect((await status()).setup_required).toBeUndefined();
  });
});

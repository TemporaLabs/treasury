import { describe, expect, it, vi, afterEach } from "vitest";
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type RpcTransport } from "@solana/kit";
import { retrySleep, withRateLimitRetry } from "../src/solana/rpc.js";

/**
 * The Solana transport waits out HTTP 429. A command that is waiting has nothing else pending, so the wait
 * itself must keep the process alive: with an unref'd timer Node ended mid-retry, and every Solana command
 * against a rate-limiting endpoint exited 0 with no output at all.
 */

const http429 = () => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: {} as never, message: "Too Many Requests", statusCode: 429 });

afterEach(() => vi.restoreAllMocks());

describe("the Solana rate-limit retry", () => {
  it("waits on a timer that keeps the process alive", async () => {
    const timers: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      timers.push(t);
      return t;
    }) as typeof setTimeout);
    await retrySleep(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.hasRef()).toBe(true);
  });

  it("retries a 429 and returns the answer that follows", async () => {
    let calls = 0;
    const base = (async () => {
      calls++;
      if (calls < 3) throw http429();
      return { result: "ok" };
    }) as unknown as RpcTransport;
    const waits: number[] = [];
    const t = withRateLimitRetry(base, async (ms) => void waits.push(ms));
    await expect(t({ payload: {} } as never)).resolves.toEqual({ result: "ok" });
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("gives up after five retries and reports the 429", async () => {
    let calls = 0;
    const base = (async () => {
      calls++;
      throw http429();
    }) as unknown as RpcTransport;
    const t = withRateLimitRetry(base, async () => {});
    await expect(t({ payload: {} } as never)).rejects.toThrow();
    expect(calls).toBe(6);
  });
});

/**
 * `src/invest/page.ts`: the invest signing page's server side, played the way the browser bundle plays it, with a
 * throwaway key standing in for the owner's wallet. No network beyond this machine's loopback.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { openInvestPage, type StepView } from "../src/invest/page.js";

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const VIEW: StepView = { title: "Sign in", description: "Sign in to the Tempora API.", facts: [{ label: "Host", value: "api-test.temporalabs.com" }] };
const TYPED = {
  domain: { name: "Example", version: "1", chainId: 56, verifyingContract: "0x1111111111111111111111111111111111111111" as const },
  types: { Thing: [{ name: "n", type: "uint256" }] },
  primaryType: "Thing" as const,
  message: { n: 1n },
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

let home: string;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "treasury-invest-page-"));
  process.env["TREASURY_CONNECT_HOME"] = home;
  process.env["TREASURY_CONNECT_PORT"] = String(await freePort());
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env["TREASURY_CONNECT_HOME"];
  delete process.env["TREASURY_CONNECT_PORT"];
});

async function open() {
  let url = "";
  const page = await openInvestPage(owner.address, "Invest", { open: (u) => ((url = u), true), ttlMs: 60_000 });
  const u = new URL(url);
  const s = u.searchParams.get("s")!;
  const origin = u.origin;
  return {
    page,
    info: async () => (await fetch(`${origin}/info?s=${s}`)).json() as Promise<Record<string, unknown> & { step?: { index: number; ask: { kind: string } } }>,
    result: async (body: Record<string, unknown>) =>
      fetch(`${origin}/result`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ s, ...body }) }),
  };
}

describe("the invest page", () => {
  it("shows one step at a time and hands back the owner's signature, after checking it is the owner's", async () => {
    const p = await open();
    expect((await p.info()).step).toBeUndefined();
    const asked = p.page.ask(VIEW, { kind: "sign_text", message: "hello" });
    const info = await p.info();
    expect(info).toMatchObject({ mode: "invest", owner: owner.address, chainId: 56, step: { index: 0, view: VIEW, ask: { kind: "sign_text", message: "hello" } } });
    // Another wallet's signature is refused, and the step stays.
    const theirs = await stranger.signMessage({ message: "hello" });
    expect((await p.result({ index: 0, value: theirs })).status).toBe(400);
    expect((await p.info()).step?.index).toBe(0);
    const mine = await owner.signMessage({ message: "hello" });
    expect((await p.result({ index: 0, value: mine })).status).toBe(200);
    expect(await asked).toBe(mine);
    expect((await p.info()).step).toBeUndefined();
    p.page.finish({ ok: true, text: "done" });
    await p.page.done;
  });

  it("checks raw bytes as bytes and typed data as typed data", async () => {
    const p = await open();
    const bytes = `0x${"ab".repeat(32)}` as const;
    const a = p.page.ask(VIEW, { kind: "sign_bytes", bytes });
    // A signature over the bytes' text is not a signature over the bytes.
    expect((await p.result({ index: 0, value: await owner.signMessage({ message: bytes }) })).status).toBe(400);
    const raw = await owner.signMessage({ message: { raw: bytes } });
    expect((await p.result({ index: 0, value: raw })).status).toBe(200);
    expect(await a).toBe(raw);
    const t = p.page.ask(VIEW, { kind: "sign_typed", typedData: JSON.parse(JSON.stringify(TYPED, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
    expect((await p.result({ index: 1, value: await stranger.signTypedData(TYPED) })).status).toBe(400);
    const sig = await owner.signTypedData(TYPED);
    expect((await p.result({ index: 1, value: sig })).status).toBe(200);
    expect(await t).toBe(sig);
    p.page.finish({ ok: true, text: "done" });
    await p.page.done;
  });

  it("takes a transaction hash for a send, and refuses a result for a step that is not waiting", async () => {
    const p = await open();
    const s = p.page.ask(VIEW, { kind: "send", to: "0x55d398326f99059fF775485246999027B3197955", data: "0xa9059cbb", value: "0" });
    expect((await p.result({ index: 1, value: `0x${"1".repeat(64)}` })).status).toBe(400);
    expect((await p.result({ index: 0, value: "0x12" })).status).toBe(400);
    const hash = `0x${"2".repeat(64)}`;
    expect((await p.result({ index: 0, value: hash })).status).toBe(200);
    expect(await s).toBe(hash);
    p.page.finish({ ok: true, text: "done" });
    await p.page.done;
  });

  it("a decline in the browser fails the waiting step and ends the page", async () => {
    const p = await open();
    const a = expect(p.page.ask(VIEW, { kind: "sign_text", message: "hello" })).rejects.toThrow(/cancelled by the owner/);
    await p.result({ rejected: true, reason: "cancelled by the owner" });
    await a;
    expect(await p.page.done).toEqual({ ok: false, reason: "cancelled by the owner" });
  });

  it("tells the page how it ended before it closes", async () => {
    const p = await open();
    p.page.finish({ ok: false, reason: "the API refused the deposit" });
    expect((await p.info())["ending"]).toEqual({ ok: false, text: "the API refused the deposit" });
    expect(await p.page.done).toEqual({ ok: false, reason: "the API refused the deposit" });
  });
});

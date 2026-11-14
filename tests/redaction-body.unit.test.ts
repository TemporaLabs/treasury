/**
 * Unit — a keyed RPC URL must not reach tool output even when the PROVIDER echoes it back.
 *
 * 🔴 Measured by review against a real viem client and a real HTTP server, and reproduced
 * here: a provider that rejects a key and repeats it in its response body puts the key in viem's
 * `Details:` line, as prose inside JSON. No scheme, no errno, no header keyword — every shape rule
 * misses it, and the key crossed the tool boundary. That is the class: a keyed provider URL IS
 * a secret.
 *
 * The fix is not another pattern. `rpcUrlFromEnv` resolved the value, so the redactor masks the
 * literal wherever it appears. These tests drive a REAL viem failure through the endpoint the
 * operator configured, and redact it the way every command and the command line do: the secret source
 * registered (`buildCommands()` and `src/cli.ts` both register it), then `redactEndpoints`. The earn
 * reads that once carried this path read through the Tempora API on an EVM chain now; the redactor and
 * the reads that still go through a keyed endpoint are what remain to hold.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { makePublicClient, resolvedRpcSecrets, rpcUrlFromEnv } from "../src/client.js";
import { redactEndpoints, registerSecretSource } from "../src/redact.js";

// 🔴 A key whose percent-ENCODED and DECODED forms DIFFER. The earlier key here was
// `SECRETKEY123abc`, which encodes to itself — so the test could not distinguish the two forms and
// passed while the decoded form leaked (review). Any test of an encoding boundary must use
// an input that makes the transformation real.
const KEY = "sk-Live_a+b/c=d9f8e7";
const PORT = 59997;
let srv: Server | undefined;

const start = (body: string, status = 401) =>
  new Promise<void>((resolve) => {
    srv = createServer((_q, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    srv.listen(PORT, "127.0.0.1", () => resolve());
  });

afterEach(async () => {
  await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
  srv = undefined;
  delete process.env["TREASURY_RPC_BASE"];
  delete process.env["TREASURY_LOGS_RPC_BASE"];
});

/** A real read through the configured Base endpoint, and its failure as a command would print it. */
const readThroughBase = async (): Promise<string> => {
  registerSecretSource(resolvedRpcSecrets);
  try {
    await makePublicClient(8453, rpcUrlFromEnv(8453)).getBlockNumber();
    return "no error";
  } catch (e) {
    return redactEndpoints(e instanceof Error ? e.message : String(e));
  }
};

describe("a provider that echoes the rejected key back in its BODY", () => {
  it("a failed read says it failed, and the key is not in it", async () => {
    await start(JSON.stringify({ error: { message: `invalid api key: ${KEY}` } }));
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/${encodeURIComponent(KEY)}`;
    const out = await readThroughBase();
    expect(out).not.toContain(KEY); // the whole point
    expect(out).not.toBe("no error"); // and it did fail
  });

  it("the key is masked even in a shape with no scheme, errno or header keyword", async () => {
    await start(JSON.stringify({ error: `auth failed for token ${KEY}` }));
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/${encodeURIComponent(KEY)}`;
    const out = await readThroughBase();
    expect(out).not.toContain(KEY);
  });

  it("the ENCODED form in the URL and the DECODED form a provider prints are BOTH masked", async () => {
    await start(JSON.stringify({ error: { message: `invalid api key: ${KEY}` } }));
    const enc = encodeURIComponent(KEY);
    expect(enc).not.toBe(KEY); // the guard on this test: the transformation must be real
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/${enc}`;
    const out = await readThroughBase();
    expect(out).not.toContain(KEY); // decoded — what the provider echoes
    expect(out).not.toContain(enc); // encoded — what sits in the URL
  });

  it("a key in a QUERY parameter carrying a literal + is masked in both readings", async () => {
    // URL.searchParams decodes `+` as a SPACE, so trusting it alone leaves the form the provider
    // actually echoes unregistered (review). Same defect as the path form, other branch.
    const QKEY = "sk+Live_abcdefgh";
    expect(new URL(`http://x/y?k=${QKEY}`).searchParams.get("k")).not.toBe(QKEY); // premise is real
    await start(JSON.stringify({ error: { message: `invalid api key: ${QKEY}` } }));
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/rpc?apikey=${QKEY}`;
    const out = await readThroughBase();
    expect(out).not.toContain(QKEY);
  });
});

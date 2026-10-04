import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_CSP } from "../src/connect/page.js";

/**
 * The confirm page runs in the operator's browser next to their wallet, and nothing else tests its
 * source. These checks read it as text and pin what it may ask a wallet for, where it may talk to,
 * and the Content-Security-Policy (that the server sends exactly this one is in connect.unit.test.ts). A new wallet method, a new network
 * destination or a widened policy fails here first, so it gets a reviewer's eyes on purpose.
 */

const dir = join(import.meta.dirname, "..", "connect-page", "src");
const files = readdirSync(dir).filter((f) => /\.(tsx?|jsx?)$/.test(f));
const source = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
const main = readFileSync(join(dir, "main.tsx"), "utf8");

describe("the connect page's source", () => {
  it("control: the scan reads the page", () => {
    expect(files).toContain("main.tsx");
    expect(main).toContain("eth_sendTransaction");
  });

  it("asks a wallet only for a sign-in signature, a gas estimate, a transaction and a chain switch", () => {
    const requests = [...source.matchAll(/\.request\(/g)].length;
    const methods = [...source.matchAll(/\.request\(\{\s*method:\s*"([^"]+)"/g)].map((m) => m[1]);
    // Every request names its method as a literal, so this list is complete.
    expect(methods).toHaveLength(requests);
    expect(new Set(methods)).toEqual(new Set(["personal_sign", "eth_estimateGas", "eth_sendTransaction"]));
    const walletCalls = new Set([...source.matchAll(/\bwallet\.(\w+)\(/g)].map((m) => m[1]));
    expect(walletCalls).toEqual(new Set(["switchChain", "getEthereumProvider"]));
  });

  it("never signs typed data, signs or sends raw transactions, or reaches for key material", () => {
    for (const banned of [
      /eth_sign"/,
      /signTypedData/i,
      /eth_signTransaction|signTransaction/,
      /eth_sendRawTransaction/,
      /useSendTransaction|useSignMessage|useSignTypedData/,
      /exportWallet|privateKey|mnemonic|seed ?phrase/i,
    ]) {
      expect(source).not.toMatch(banned);
    }
  });

  it("writes no HTML from strings, evaluates no code, and stores nothing in the browser", () => {
    for (const banned of [/dangerouslySetInnerHTML/, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, /\beval\(|new Function\(/, /localStorage|sessionStorage|indexedDB|document\.cookie/]) {
      expect(source).not.toMatch(banned);
    }
  });

  it("talks only to its own local server, by relative path", () => {
    const fetches = [...source.matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1]!.trim());
    expect(fetches.length).toBeGreaterThan(0);
    for (const target of fetches) expect(target === "path" || /^[`"']\//.test(target)).toBe(true);
    const posts = [...source.matchAll(/(?<!function )\bpost\(\s*([^,)]+)/g)].map((m) => m[1]!.trim());
    expect(posts.length).toBeGreaterThan(0);
    for (const target of posts) expect(target).toMatch(/^"\/(challenge|result)"$/);
    expect(source).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  });

  it("keeps WalletConnect off", () => {
    expect(main).toMatch(/walletConnect:\s*\{\s*enabled:\s*false\s*\}/);
  });
});

describe("the page's Content-Security-Policy", () => {
  const directives = new Map(PAGE_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

  it("admits scripts, frames and connections only from the page itself and the hosts Privy's window needs", () => {
    expect(Object.fromEntries(directives)).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://challenges.cloudflare.com"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "font-src": ["'self'", "data:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'none'"],
      "frame-ancestors": ["'none'"],
      "child-src": ["https://auth.privy.io"],
      "frame-src": ["https://auth.privy.io", "https://challenges.cloudflare.com"],
      "connect-src": ["'self'", "https://auth.privy.io", "https://*.rpc.privy.systems"],
      "worker-src": ["'self'"],
      "manifest-src": ["'self'"],
    });
    expect(directives.get("script-src")).not.toContain("'unsafe-inline'");
    expect(PAGE_CSP).not.toContain("'unsafe-eval'");
  });
});

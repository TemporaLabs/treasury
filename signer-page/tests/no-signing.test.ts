import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The repository's first rule is that nothing in it holds a key, signs or sends. This directory is
 * the one place that talks to a wallet, so it gets the same rule in the form that fits it: the page
 * may ask the operator's wallet to send a transaction (the wallet signs, after the operator's
 * confirm) and may read; it may not take, make, or use a key; and it may not grow a second write
 * path without this test going red and a reviewer reading why.
 */
const root = resolve(import.meta.dirname, "..", "..");
const dir = join(root, "signer-page");
const SHIPPED = ["open.mjs", "app.mjs", "validate.mjs", "index.html"];
const source = Object.fromEntries(SHIPPED.map((f) => [f, readFileSync(join(dir, f), "utf8")]));

/** Every wallet method the page may call, and the subset that changes anything. */
const READS = ["eth_chainId", "eth_accounts", "eth_call", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBalance"];
const WRITES = ["eth_requestAccounts", "wallet_switchEthereumChain", "eth_sendTransaction"];

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // comments are prose, not calls

describe("the page can ask a wallet to send, and can do nothing else with one", () => {
  it("calls only the listed wallet methods, each by a literal name", () => {
    const app = strip(source["app.mjs"]!);
    const named = [...app.matchAll(/\brpc\(\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named).difference(new Set([...READS, ...WRITES]))).toEqual(new Set());
    expect([...app.matchAll(/\brpc\(\s*(?!")/g)]).toEqual([]); // a computed method name is unauditable
    expect(app.match(/\.request\(/g)).toHaveLength(1); //         and every call goes through the one helper
  });

  it("the write methods are exactly connect, switch-to-Base, and send", () => {
    const app = strip(source["app.mjs"]!);
    const used = new Set([...app.matchAll(/\brpc\(\s*"([^"]+)"/g)].map((m) => m[1]!));
    expect([...used].filter((m) => !READS.includes(m)).sort()).toEqual([...WRITES].sort());
  });

  it("no source can take, make or use a key, sign a message, or broadcast a raw transaction", () => {
    const forbidden = /eth_sign\b|eth_signTransaction|eth_signTypedData|personal_sign|eth_sendRawTransaction|privateKey|private_key|mnemonic|seed ?phrase|secp256k1|signMessage|signTransaction|wallet_addEthereumChain/i;
    for (const [name, text] of Object.entries(source)) expect({ name, hit: strip(text).match(forbidden)?.[0] ?? null }).toEqual({ name, hit: null });
  });

  it("the page has no field a key could be typed or pasted into, and stores nothing", () => {
    for (const [name, text] of Object.entries(source)) expect({ name, hit: strip(text).match(/<textarea|contenteditable|type="password"|localStorage|sessionStorage|indexedDB|document\.cookie|createElement\(\s*["'`](input|textarea)/i)?.[0] ?? null }).toEqual({ name, hit: null });
    for (const name of ["app.mjs", "validate.mjs", "open.mjs"]) expect({ name, hit: strip(source[name]!).match(/<input/i)?.[0] ?? null }).toEqual({ name, hit: null });
  });

  it("the only inputs are three amount fields and one address field: short, no autofill, and nothing else", () => {
    // Manual mode needs somewhere to type an amount, and Privy mode's send needs somewhere to paste an
    // address. It is an allow-list, not an exception: an input of any other shape (another type, a longer
    // field, a fifth field) fails here and needs a reviewer.
    const inputs = [...source["index.html"]!.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]);
    const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
    const seen = inputs.map(attrs);
    expect(seen.map((a) => a["id"]).sort()).toEqual(["amt-deposit", "amt-send", "amt-withdraw", "send-to"]);
    for (const a of seen) {
      expect(a["type"]).toBe("text");
      expect(a["autocomplete"]).toBe("off");
      if (a["id"] === "send-to") {
        expect(a["spellcheck"]).toBe("false");
        expect(Number(a["maxlength"])).toBeLessThanOrEqual(42); // an address (0x + 40) fits; a private key (64 hex, 66 with 0x) does not
      } else {
        expect(a["inputmode"]).toBe("decimal");
        expect(Number(a["maxlength"])).toBeLessThanOrEqual(20); // an amount fits; a key or a phrase does not
      }
    }
  });

  it("what the operator types is only ever parsed as an amount, never sent or stored", () => {
    const app = strip(source["app.mjs"]!);
    const reads = [...app.matchAll(/\$\("#amt-[a-z]+"\)\.value(?!\s*=[^=])/g)].length; // a write (the Max button) is not a read
    const parsed = [...app.matchAll(/parseAmount\(\$\("#amt-[a-z]+"\)\.value/g)].length;
    expect(reads).toBeGreaterThan(0);
    expect(parsed).toBe(reads); // every read of a field goes straight into parseAmount
    const addrReads = [...app.matchAll(/\$\("#send-to"\)\.value/g)].length;
    const addrParsed = [...app.matchAll(/parseAddress\(\$\("#send-to"\)\.value\)/g)].length;
    expect(addrReads).toBeGreaterThan(0);
    expect(addrParsed).toBe(addrReads); // the address field goes straight into parseAddress and nowhere else
  });

  it("text from the envelope never becomes markup, and no code is built from a string", () => {
    for (const [name, text] of Object.entries(source)) expect({ name, hit: strip(text).match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setTimeout\(\s*["'`]/)?.[0] ?? null }).toEqual({ name, hit: null });
  });

  it("the page's only network request is for the registry it ships with", () => {
    expect([...strip(source["app.mjs"]!).matchAll(/\bfetch\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"./registry.json"']);
    for (const name of ["validate.mjs", "open.mjs"]) expect(strip(source[name]!)).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
    expect(source["index.html"]).not.toMatch(/<script[^>]+src="https?:|<link[^>]+href="https?:|<img[^>]+src="https?:/i);
  });
});

describe("the core does not know this exists", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

  it("nothing under src/ or scripts/ mentions it", () => {
    for (const f of [...walk(join(root, "src")), ...walk(join(root, "scripts"))]) {
      expect({ f, hit: /signer-page|treasury-sign/.test(readFileSync(f, "utf8")) }).toEqual({ f, hit: false });
    }
  });

  it("the core package neither depends on it nor publishes it", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(JSON.stringify(pkg.dependencies) + JSON.stringify(pkg.devDependencies)).not.toMatch(/treasury-sign|signer-page/);
    expect(pkg.files.some((f: string) => f.includes("signer-page"))).toBe(false);
    expect(pkg.workspaces).toBeUndefined();
  });

  it("this package has no dependencies of its own", () => {
    const own = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(own.dependencies ?? {}).toEqual({});
  });
});

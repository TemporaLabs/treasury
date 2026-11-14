/**
 * A stand-in for the Tempora API's MCP endpoint, for the connect tests: it lists the registry's EVM vaults as products
 * (the same address, name, warning, asset and explorer link, so the acknowledgement texts read as before, under a
 * neutral product id that no caller types and no output shows) and runs vault
 * requests the way the API does. A deposit is an approve that is `ready`, then a deposit that is `waiting` until the
 * approve's hash is submitted; a withdrawal is one step. Each step's calldata is what the request asked for, so it
 * passes the client's `checkSteps`; a test bends the request with `bend` to see a refusal.
 *
 * No address here is a contract treasury holds: they are the registry rows the tests already read.
 */
import type { Product, Request } from "@temporalabs/client";
import type { McpClient } from "@temporalabs/client/mcp";
import { encodeFunctionData, erc20Abi, getAddress, sha256, stringToBytes, type Address, type Hex } from "viem";
import { erc4626Abi } from "../../src/abi/erc4626.js";
import { linksFor } from "../../src/links.js";
import { listVaults } from "../../src/registry.js";

export const TERMS_TEXT = "Cash Plus terms, as the test API publishes them.";
export const TERMS = { text: TERMS_TEXT, version: "2026-11-01", sha256: sha256(stringToBytes(TERMS_TEXT)) };

/** The neutral product id the stand-in lists a registry vault under: `vault-<chain id>-<n>`, opaque like the API's own. */
export const productIdOf = (symbol: string): string => {
  const all = listVaults();
  const v = all.find((x) => x.symbol === symbol)!;
  return `vault-${v.chainId}-${all.filter((x) => x.chainId === v.chainId).indexOf(v) + 1}`;
};

/** Every EVM vault of the registry, as the API would list it: by its address, under a neutral product id. */
export function registryProducts(): Product[] {
  return listVaults().map(
    (v) =>
      ({
        id: productIdOf(v.symbol),
        kind: "vault",
        name: v.name,
        status: "live",
        tokens: [v.asset.symbol],
        // A whitelist-gated registry row is a vault the API gates by an allowlist.
        gates: v.depositOpen.open ? ["vault-live", "vault-terms"] : ["allowlist", "vault-live", "vault-terms"],
        warnings: [v.warning],
        vault: { standard: "erc4626", chain: `eip155:${v.chainId}`, vaultAddress: v.address, assetAddress: v.asset.address, assetDecimals: v.asset.decimals, shareDecimals: v.shareDecimals },
        vaultTerms: TERMS,
        vaultLinks: { explorer: linksFor(v).explorer, venue: null },
      }) as unknown as Product,
  );
}

/** Where an `extra` landing says the wallet also sent the asset. */
export const EXTRA_TO = getAddress("0x1111111111111111111111111111111111111111");

/** How a sent step lands, by its hash: `landed` unless the test says otherwise. `pending` never lands. */
export type Landing = "landed" | "pending" | "reverted" | "mismatch" | "extra";

export interface StandIn {
  mcp: McpClient;
  /** Every tool called, in order, with the step id for a submit. */
  log: string[];
  /** Every submit's body, by `requestId/stepId`. */
  submits: { requestId: string; stepId: string; body: unknown }[];
  landing: Record<string, Landing>;
  requests: Map<string, Request>;
  /** Bends every request the API returns (a test's way to make one fail the check, or re-issue a step). */
  bend?: (r: Request, event: "start" | "submit" | "status") => Request;
  /** Refuses the next submit with this error. */
  refuseSubmit?: { code: string; message: string };
}

export function standInApi(o: { owner: Address; products?: Product[]; shares?: () => bigint }): StandIn {
  const products = o.products ?? registryProducts();
  const owner = getAddress(o.owner);
  let n = 0;
  const s: StandIn = { mcp: undefined as never, log: [], submits: [], landing: {}, requests: new Map() };
  const ok = (body: unknown) => ({ ok: true, status: 200, body });
  const send = (stepId: string, to: string, data: Hex, purpose: string, extra: Record<string, unknown> = {}) => ({
    stepId,
    chainId: "",
    state: "ready",
    checks: [],
    kind: "send_transaction",
    purpose,
    payload: { generation: 1, expiresAt: "2099-01-01T00:00:00Z", to, data, value: "0" },
    ...extra,
  });
  const out = (r: Request, event: "start" | "submit" | "status") => {
    const bent = s.bend ? s.bend(structuredClone(r), event) : r;
    return ok(structuredClone(bent));
  };
  const start = (action: "deposit" | "withdraw", body: { product: string; amount: { kind: string; raw?: string } }) => {
    const p = products.find((x) => x.id === body.product);
    if (!p?.vault) return { ok: false, status: 404, error: { code: "unknown_product", message: `no product ${body.product}`, outcome: "refused" } };
    const v = p.vault;
    const chain = v.chain;
    const id = `req_${++n}`;
    let steps: unknown[];
    if (action === "deposit") {
      const raw = BigInt(body.amount.raw!);
      steps = [
        { ...send("s1", v.assetAddress, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [v.vaultAddress as Address, raw] }), "approve"), chainId: chain },
        { stepId: "s2", chainId: chain, state: "waiting", after: "s1", checks: [], kind: "send_transaction", purpose: "deposit" },
      ];
    } else {
      const k = body.amount.kind;
      const raw = k === "all" ? (o.shares?.() ?? 5n * 10n ** BigInt(v.shareDecimals)) : BigInt(body.amount.raw!);
      const fn = k === "assets" ? "withdraw" : "redeem";
      steps = [{ ...send("s1", v.vaultAddress, encodeFunctionData({ abi: erc4626Abi, functionName: fn, args: [raw, owner, owner] }), fn), chainId: chain }];
    }
    const r = { requestId: id, action, state: "requires_action", chose: { product: p.id, amount: body.amount }, expiresAt: "2099-01-01T00:00:00Z", steps } as unknown as Request;
    s.requests.set(id, r);
    return out(r, "start");
  };
  const land = (r: Request, stepId: string, hash: string) => {
    const steps = r.steps as unknown as Record<string, unknown>[];
    const i = steps.findIndex((x) => x["stepId"] === stepId);
    const step = steps[i]!;
    const how = s.landing[hash] ?? "landed";
    step["payload"] = step["payload"];
    if (how === "pending") step["state"] = "confirming";
    else if (how === "reverted" || how === "mismatch") {
      step["state"] = how;
      step["verification"] = { hash, message: `the step ${how}` };
      (r as { state: string }).state = "failed";
      return;
    } else {
      step["state"] = "landed";
      step["verification"] = { hash, ...(how === "extra" ? { alsoMoved: [{ to: EXTRA_TO, amountRaw: "5" }] } : {}) };
    }
    if (how === "pending") return;
    const next = steps[i + 1];
    if (next && next["state"] === "waiting") {
      // The deposit, prepared once the approval is recorded: exactly the amount, the shares to the owner.
      const p = products.find((x) => x.id === r.chose.product)!;
      const raw = BigInt((r.chose.amount as { raw: string }).raw);
      Object.assign(next, send(next["stepId"] as string, p.vault!.vaultAddress, encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [raw, owner] }), "deposit"), { chainId: p.vault!.chain, after: stepId });
    } else if (!next) (r as { state: string }).state = "completed";
  };
  s.mcp = new Proxy({} as McpClient, {
    get: (_t, name: string) => async (input: any) => {
      s.log.push(`${name}${input?.path?.stepId ? `:${input.path.stepId}` : ""}`);
      if (name === "products") return ok({ products });
      if (name === "positions") return ok({ positions: [] });
      if (name === "deposit" || name === "withdraw") return start(name, input.body);
      const r = s.requests.get(input?.path?.requestId);
      if (!r) return { ok: false, status: 404, error: { code: "not_found", message: "no such request", outcome: "refused" } };
      if (name === "status") return out(r, "status");
      if (name === "cancel") {
        (r as { state: string }).state = "cancelled";
        return out(r, "status");
      }
      if (name === "submit") {
        s.submits.push({ requestId: r.requestId, stepId: input.path.stepId, body: input.body });
        if (s.refuseSubmit) {
          const e = s.refuseSubmit;
          s.refuseSubmit = undefined;
          return { ok: false, status: 409, error: { ...e, outcome: "refused" } };
        }
        land(r, input.path.stepId, input.body.txHash);
        return out(r, "submit");
      }
      throw new Error(`the stand-in API has no ${name}`);
    },
  });
  return s;
}

/** A stand-in for the API's HTTP client: a sign-in is never expected here (each test keeps a token). */
export const noHttp = new Proxy({}, { get: (_t, name: string) => async () => { throw new Error(`no HTTP call expected: ${String(name)}`); } }) as never;

/** A stand-in owner wallet that is never asked to sign in (each test keeps a token), and closes at once. */
export const keptTokenWallet = () => ({
  signIn: async () => {
    throw new Error("a sign-in was asked for, with a token kept");
  },
  ask: async () => {
    throw new Error("the sign-in page was asked for a step");
  },
  finish: async () => undefined,
  url: () => undefined,
});

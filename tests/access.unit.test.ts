/**
 * The discovery helper's own guards, driven by stub clients.
 *
 * 🔴 WHY THIS FILE EXISTS. `findRoleHolder` is used only by the fork and live tiers, both of which
 * SKIP without an RPC — so every guard inside it shipped green while being deleted. Measured
 * 2026-09-15: removing the `hasRole` filter, and
 * removing the window narrowing, each leave 163 passed / 0 red. A docstring calling a step
 * "not a formality" is a claim; this is the test.
 *
 * The stubs are deliberately crude — a `getLogs` that enforces a window the way a provider does,
 * and a `hasRole` that answers from a set. Nothing here reaches a chain.
 */
import { describe, it, expect } from "vitest";
import { getAddress, type Address } from "viem";
import type { VaultEntry } from "../src/registry-schema.js";
import { findRoleHolder, FUSION_DEPOSIT_ROLE } from "./access.js";
import { FIXTURE, fixtureVault } from "./fixtures/registry.js";

const MANAGER = "0x00000000000000000000000000000000000AcAc1" as const;
/** Granted at deploy, revoked afterwards — the account that ran the deployment. */
const REVOKED = getAddress("0x1000000000000000000000000000000000000001");
/** Granted later, still a member — the account a deposit must actually come from. */
const LIVE = getAddress("0x2000000000000000000000000000000000000002");

const DEPLOYED = 51_359_816n;
const HEAD = DEPLOYED + 3_000n;

type Grant = { account: Address; block: bigint };
type Stub = {
  /** Grants in the order the chain emitted them; the revoked one FIRST, which is the trap. */
  grants?: Grant[];
  members?: Address[];
  /** The widest range the "provider" will serve; anything wider throws, as a capped RPC does. */
  window?: bigint;
  /** A failure that is NOT a window cap — narrowing must not swallow it. */
  alwaysFail?: string;
  /** Refuse EVERY request with this stated limit, however narrow the caller goes. */
  alwaysRefuseWith?: bigint;
  /** Head block, for the cases where the DISTANCE from deployment is the thing under test. */
  head?: bigint;
};

/** A hang never throws, so every stub counts calls and fails loudly instead of running forever. */
const CALL_CAP = 200;

function client(s: Stub) {
  const calls: { from: bigint; to: bigint }[] = [];
  const members = new Set((s.members ?? []).map((m) => getAddress(m)));
  return {
    calls,
    client: {
      getBlockNumber: async () => s.head ?? HEAD,
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "getAccessManagerAddress") return MANAGER;
        if (functionName === "hasRole") return [members.has(getAddress(args![1] as Address)), 0];
        throw new Error(`unexpected ${functionName}`);
      },
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ from: fromBlock, to: toBlock });
        if (calls.length > CALL_CAP) throw new Error(`STUB CAP: ${calls.length} calls — the walk is not terminating`);
        if (s.alwaysRefuseWith !== undefined) {
          throw new Error(`Under the Free tier plan, you can make eth_getLogs requests with up to a ${s.alwaysRefuseWith} block range.`);
        }
        if (s.alwaysFail) throw new Error(s.alwaysFail);
        if (s.window !== undefined && toBlock - fromBlock + 1n > s.window) {
          throw new Error(`Under the Free tier plan, you can make eth_getLogs requests with up to a ${s.window} block range.`);
        }
        return (s.grants ?? [])
          .filter((g) => g.block >= fromBlock && g.block <= toBlock)
          .map((g) => ({ args: { roleId: FUSION_DEPOSIT_ROLE, account: g.account } }));
      },
    } as never,
  };
}

/** A gated vault shaped like the shipped one, with the deployment block the walk starts from. */
const vault = (): VaultEntry => ({ ...fixtureVault(FIXTURE.fusionGated), deployedAtBlock: Number(DEPLOYED) });

describe("findRoleHolder — the events are history, hasRole is the state", () => {
  it("🔴 SKIPS a grant that was later revoked and returns the account that still holds the role", async () => {
    // The measured shape on Cash Plus 2A: the deploying account is granted FIRST and revoked; a log-only
    // lookup returns it, its deposit reverts AccessManagedUnauthorized, and the tier reads as broken.
    const s = client({ grants: [{ account: REVOKED, block: DEPLOYED + 11n }, { account: LIVE, block: DEPLOYED + 26n }], members: [LIVE] });
    expect(await findRoleHolder(s.client, vault())).toBe(LIVE);
  });

  it("CONTROL: with the revoked account still a member, the SAME logs return it first — so the test above is about hasRole, not about ordering", async () => {
    const s = client({ grants: [{ account: REVOKED, block: DEPLOYED + 11n }, { account: LIVE, block: DEPLOYED + 26n }], members: [REVOKED, LIVE] });
    expect(await findRoleHolder(s.client, vault())).toBe(REVOKED);
  });

  it("returns undefined when every grant has been revoked — an empty whitelist is an answer, not an address", async () => {
    const s = client({ grants: [{ account: REVOKED, block: DEPLOYED + 11n }], members: [] });
    expect(await findRoleHolder(s.client, vault())).toBeUndefined();
  });

  it("never returns the vault itself, which holds roles on its own AccessManager", async () => {
    const v = vault();
    const s = client({ grants: [{ account: v.address, block: DEPLOYED + 1n }, { account: LIVE, block: DEPLOYED + 26n }], members: [v.address, LIVE] });
    expect(await findRoleHolder(s.client, v)).toBe(LIVE);
  });

  it("a vault with no deployedAtBlock is refused rather than scanned from block 0", async () => {
    const s = client({ grants: [{ account: LIVE, block: DEPLOYED }], members: [LIVE] });
    const { deployedAtBlock: _drop, ...rest } = vault();
    expect(await findRoleHolder(s.client, rest as VaultEntry)).toBeUndefined();
    expect(s.calls).toHaveLength(0);
  });
});

describe("findRoleHolder — a provider's window is not ours to assume", () => {
  it("🔴 narrows until the provider accepts the range, and still finds the member", async () => {
    // 10 blocks is what the keyed Base RPC serves on the free tier; through an anvil fork the
    // refusal arrives as a bare InternalRpcError, which is why this cannot be special-cased on text.
    const s = client({ window: 10n, grants: [{ account: LIVE, block: DEPLOYED + 26n }], members: [LIVE] });
    expect(await findRoleHolder(s.client, vault())).toBe(LIVE);
    const oversize = s.calls.filter((c) => c.to - c.from + 1n > 10n);
    // Exactly ONE call exceeds the window: the opening probe. After the provider states its limit,
    // every later call respects it — a narrowing that kept guessing would show up as several.
    expect(oversize, "one oversize probe, then the stated limit is respected").toHaveLength(1);
    expect(s.calls[0]!.to - s.calls[0]!.from + 1n, "it starts wide — narrowing is a response, not the default").toBeGreaterThan(10n);
    expect(s.calls.at(-1)!.to - s.calls.at(-1)!.from + 1n).toBeLessThanOrEqual(10n);
  });

  it("does not re-walk ground it already covered: the cursor only moves forward", async () => {
    const s = client({ window: 100n, grants: [{ account: LIVE, block: DEPLOYED + 2_500n }], members: [LIVE] });
    expect(await findRoleHolder(s.client, vault())).toBe(LIVE);
    const served = s.calls.filter((c) => c.to - c.from + 1n <= 100n);
    for (let i = 1; i < served.length; i++) expect(served[i]!.from).toBe(served[i - 1]!.to + 1n);
  });

  it("🔴 a failure that is NOT a window cap is RETHROWN, never narrowed away into 'no member found'", async () => {
    // Otherwise a dead provider and an empty whitelist are the same answer, and the tier skips an
    // arm it should have failed on.
    const s = client({ alwaysFail: "connect ECONNREFUSED" });
    await expect(findRoleHolder(s.client, vault())).rejects.toThrow(/ECONNREFUSED/);
    // ONE call, then out. "Eventually rethrows" is not the property: a helper that narrows first and
    // gives up later still hammers a dead provider, and still reports the failure as the wrong shape.
    expect(s.calls, "a failure with no stated window must not be retried at all").toHaveLength(1);
  });

  it("🔴 one transient failure does not downgrade the REST of the scan (the monotonic-shrink defect)", async () => {
    // The old walk narrowed on ANY error and never widened again, so a single
    // blip on the first window pinned every later call to the narrower size — measured 22 getLogs
    // calls instead of ~4 on a 40,000-block scan. The fix is not "reset after a success": it is that
    // a transient failure is not a window refusal at all, so it never shrinks anything. It is
    // rethrown on the spot, and the caller sees a provider failure instead of a slow silent scan.
    let first = true;
    const s = client({ grants: [{ account: LIVE, block: DEPLOYED + 26n }], members: [LIVE] });
    const inner = s.client as unknown as { getLogs: (a: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown> };
    const real = inner.getLogs.bind(inner);
    inner.getLogs = async (a) => {
      if (first) {
        first = false;
        s.calls.push({ from: a.fromBlock, to: a.toBlock });
        throw new Error("socket hang up"); // no stated range — transient
      }
      return real(a);
    };
    await expect(findRoleHolder(s.client, vault())).rejects.toThrow(/socket hang up/);
    expect(s.calls, "no narrowed retry follows a transient failure").toHaveLength(1);
  });

  it("adopts a stated cap ONCE and does not compound it — every served call is the provider's own limit", async () => {
    const s = client({ window: 1_000n, grants: [{ account: LIVE, block: DEPLOYED + 2_500n }], members: [LIVE] });
    expect(await findRoleHolder(s.client, vault())).toBe(LIVE);
    const served = s.calls.slice(1); // the first is the oversize probe the provider refused
    expect(served.length).toBeGreaterThan(1);
    for (const c of served) expect(c.to - c.from + 1n, "a cap adopted twice would show up as 100, then 10").toBe(1_000n);
  });

  it("🔴 TERMINATES when a provider refuses a window it already permits — the clause that prevents an infinite loop", async () => {
    // Measured: dropping `limit >= chunk` left 178 passed / 0 red, and a
    // stub refusing every window with the same stated limit was still running at 301 calls. chunk is
    // set to a limit it already equals, the cursor never moves, nothing throws. 🔴 A HANG CANNOT BE
    // CAUGHT BY "eventually throws" — it never throws. The assertion has to be the call count.
    const s = client({ alwaysRefuseWith: 10n });
    await expect(findRoleHolder(s.client, vault())).rejects.toThrow(/10 block range/);
    expect(s.calls.length, "one probe, one narrowed attempt, then out").toBeLessThanOrEqual(3);
  });

  it("the head sweep walks BACKWARDS from head and finds a recently-onboarded member in its first request", async () => {
    // The sweep exists for a member onboarded long after deployment — i.e. recently. Forward from
    // the deployment block is the slowest possible order for exactly that case: on a 10-block window
    // a year of Base is ~1.6M requests. 🔴 The head must be FAR from deployment or this test cannot
    // tell the directions apart: within one 10,000-block chunk a forward sweep also reaches the head
    // on its first request, and an earlier version of this test passed against a forward mutant.
    const FAR = DEPLOYED + 60_000n;
    const s = client({ head: FAR, grants: [{ account: LIVE, block: FAR - 3n }], members: [LIVE] });
    expect(await findRoleHolder(s.client, vault(), FUSION_DEPOSIT_ROLE, 100n)).toBe(LIVE);
    const sweep = s.calls.slice(1); // after the deployment-run walk
    expect(sweep[0]!.to, "the sweep's first request must touch the head, not the deployment block").toBe(FAR);
    expect(sweep.length, "and it should not have needed a second").toBe(1);
  });

  it("🔴 the head sweep is BOUNDED, and exhausting it is an ERROR, never a quiet 'no member'", async () => {
    // Otherwise "nobody holds the role" and "I stopped looking" arrive as the same answer, and the
    // caller skips an arm it should have failed on — the same distinction the rethrow above protects.
    const s = client({ window: 10n, head: DEPLOYED + 400_000n, grants: [], members: [] });
    await expect(findRoleHolder(s.client, vault(), FUSION_DEPOSIT_ROLE, 100n)).rejects.toThrow(/is NOT "no member holds the role"/);
    expect(s.calls.length).toBeLessThan(CALL_CAP);
  });

  it("🔴 the bound is in BLOCKS, so how far back 'we looked' does not depend on the provider's window", async () => {
    // A request-only budget reaches 600 blocks on a 10-block provider and 600,000 unrefused — the
    // provider would decide the lookback. Same vault, same bound, two providers: both must refuse to
    // answer about the same distance, and the narrow one must say it was the WINDOW that stopped it.
    const far = { head: DEPLOYED + 400_000n, grants: [], members: [] } as const;
    const wide = client({ ...far }); // no window cap: blocks run out first
    await expect(findRoleHolder(wide.client, vault(), FUSION_DEPOSIT_ROLE, 100n)).rejects.toThrow(/scanned 250000 blocks back/);
    const narrow = client({ ...far, window: 10n }); // requests run out first, and it says so
    await expect(findRoleHolder(narrow.client, vault(), FUSION_DEPOSIT_ROLE, 100n)).rejects.toThrow(/provider's window is too narrow/);
    // …and neither is allowed to crawl: the narrow one stops at its request bound, not at the blocks.
    expect(narrow.calls.length).toBeLessThan(CALL_CAP);
  });

  it("🔴 each walk gets its OWN request budget — the deployment walk cannot spend the sweep's", async () => {
    // Measured with a shared counter: on a 10-block provider the
    // deployment walk made 502 requests and the sweep made ZERO, throwing on its first iteration —
    // so the sweep's entire purpose, looking near the head for a recently-onboarded member, could
    // not happen on the provider it was written for. And the message named 120 when 502 were made.
    const DEEP = DEPLOYED + 6_000n;
    const s = client({ window: 10n, head: DEEP, grants: [{ account: LIVE, block: DEEP - 5n }], members: [LIVE] });
    // The deployment walk exhausts its own bound and says so, naming the count it actually made.
    await expect(findRoleHolder(s.client, vault(), FUSION_DEPOSIT_ROLE, 5_000n)).rejects.toThrow(/gave up after 120 eth_getLogs requests \(bound 120\)/);
    // …and it stopped AT its bound rather than running 500 deep, which is what a shared counter hid.
    expect(s.calls.length).toBeLessThanOrEqual(122);
  });

  it("🔴 an EXPENSIVE deployment walk still leaves the sweep its full budget — the discriminating case", async () => {
    // Sharing only changes the outcome when the first walk is costly AND the second needs more than
    // what is left: here ~102 + ~25 requests, each under the 120 bound but over it combined. A
    // cheap-first-walk control cannot tell the two apart, and an earlier version of this test used
    // one — the shared-counter mutant passed it.
    const to = DEPLOYED + 1_000n;
    const s = client({ window: 10n, head: to + 240n, grants: [{ account: LIVE, block: to + 8n }], members: [LIVE] });
    expect(await findRoleHolder(s.client, vault(), FUSION_DEPOSIT_ROLE, 1_000n)).toBe(LIVE);
    expect(s.calls.length, "both walks ran to completion, which a shared budget would have prevented").toBeGreaterThan(120);
  });

  it("scans to head when the windowed scan finds no live member — a member onboarded long after deployment is still a member", async () => {
    const late = DEPLOYED + 2_900n; // long past the deployment run, still below head
    const s = client({ grants: [{ account: LIVE, block: late }], members: [LIVE] });
    expect(await findRoleHolder(s.client, vault(), FUSION_DEPOSIT_ROLE, 100n)).toBe(LIVE);
    expect(s.calls.at(-1)!.to, "the fallback sweep must reach the head").toBe(HEAD);
  });
});

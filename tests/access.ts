/**
 * Who may deposit into a gated vault is READ FROM THE CHAIN, never configured.
 *
 * The fork tier needs one account that holds the vault's deposit role so it can impersonate it.
 * Writing such an address into the repository would publish a member of the fund's whitelist and
 * would rot the moment the fund changes it — so this discovers one instead, from the vault's own
 * AccessManager, in two steps that must BOTH pass:
 *
 *   1. `RoleGranted(roleId, account, …)` events from the vault's deployment block — the candidates;
 *   2. `hasRole(roleId, account)` at the head — the survivors.
 *
 * 🔴 STEP 2 IS NOT A FORMALITY. Measured on Cash Plus 2A (Base, 2026-09-15): role 800 was granted
 * to TWO accounts at deployment, and the FIRST of them — the account that ran the deployment — had
 * it REVOKED afterwards. A log-only discovery returns that revoked account, its deposit reverts
 * `AccessManagedUnauthorized`, and the failure reads like a broken test rather than a stale answer.
 * `RoleRevoked` is not scanned for the same reason: `hasRole` is the state, the events are history.
 *
 * This reads addresses. It never reads, derives or is handed a key.
 */
import { getAddress, parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import type { VaultEntry } from "../src/registry-schema.js";
import { rangeLimitFromError } from "../src/position.js";

/** IPOR Fusion: the vault names its own AccessManager; the manager answers `hasRole`. */
const vaultAbi = parseAbi(["function getAccessManagerAddress() view returns (address)"]);
const managerAbi = parseAbi(["function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)"]);
const roleGranted = parseAbiItem("event RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)");

/** The Fusion deposit role. `getTargetFunctionRole(vault, deposit)` returned 800 on Cash Plus 2A at block 51361109. */
export const FUSION_DEPOSIT_ROLE = 800n;

export async function accessManagerOf(client: PublicClient, vault: VaultEntry): Promise<Address> {
  return client.readContract({ address: vault.address, abi: vaultAbi, functionName: "getAccessManagerAddress" });
}

/**
 * An account that holds `roleId` on `vault` right now, or `undefined` if the chain names none.
 * `undefined` is a real answer — a caller skips the arm and says so, rather than inventing an address.
 */
export async function findRoleHolder(
  client: PublicClient,
  vault: VaultEntry,
  roleId: bigint = FUSION_DEPOSIT_ROLE,
  /** How far past deployment to look. Roles are granted in the deployment run; this is slack, not a guess. */
  scanBlocks = 5_000n,
): Promise<Address | undefined> {
  if (vault.deployedAtBlock === undefined) return undefined;
  const manager = await accessManagerOf(client, vault);
  const head = await client.getBlockNumber();
  const from = BigInt(vault.deployedAtBlock);
  const to = head < from + scanBlocks ? head : from + scanBlocks;

  const seen = new Set<string>();

  /**
   * Walks a range and returns the first account the chain still confirms.
   * `back` walks newest-first; `budget` bounds the requests so that "nobody holds the role" and
   * "I stopped looking" can never arrive as the same answer.
   */
  const walk = async (start: bigint, end: bigint, opts: { back?: boolean; maxBlocks?: bigint; maxRequests?: number } = {}): Promise<Address | undefined> => {
    // 🔴 CHUNKED, because a provider's eth_getLogs window is not ours to assume. Measured
    // 2026-09-15: a keyed Base RPC on a free tier answers a whole-range
    // query with "up to a 10 block range", and through an anvil fork that arrives wrapped, which is
    // why the range is parsed out of the message rather than matched on a provider name.
    let chunk = 10_000n;
    let lo = start;
    let hi = end;
    // 🔴 PER WALK. A counter shared across both walks lets the first spend the second's budget:
    // measured with a 10-block window, the deployment walk made 502
    // requests and the sweep made ZERO, throwing on its first iteration — so the sweep's whole
    // purpose, looking near the head, could not happen on the provider it was written for. A budget
    // is only meaningful against the walk it bounds, which is the denomination argument one level down.
    let requests = 0;
    while (lo <= hi) {
      const a = opts.back ? (hi - chunk + 1n < lo ? lo : hi - chunk + 1n) : lo;
      const b = opts.back ? hi : (lo + chunk - 1n > hi ? hi : lo + chunk - 1n);
      let logs;
      requests++;
      // 🔴 BOUNDED IN BLOCKS FIRST, REQUESTS SECOND. A request budget alone means different things on
      // different providers: 60 requests reaches 600 blocks (~20 minutes of Base) on the 10-block
      // free tier, 120,000 (~2.8 days) at a 2,000-block window, 600,000 (~2 weeks) unrefused — so the
      // provider, not the caller, would decide how far back "we looked" goes. Blocks make the reach provider-independent; the request count stays as the guard
      // against a tiny window turning that reach into tens of thousands of serial round trips
      // (measured: 50,003 serial calls on a 500,000-block gap at a 10-block cap).
      const scanned = opts.back ? end - hi : lo - start;
      if (opts.maxBlocks !== undefined && scanned >= opts.maxBlocks) {
        throw new Error(
          `findRoleHolder: scanned ${opts.maxBlocks} blocks back from ${end} without finding a live member of role ${roleId}, and stopped there — this is NOT "no member holds the role"; raise the bound if the vault is older than that`,
        );
      }
      if (opts.maxRequests !== undefined && requests > opts.maxRequests) {
        throw new Error(
          `findRoleHolder: gave up after ${requests - 1} eth_getLogs requests (bound ${opts.maxRequests}) having reached only block ${opts.back ? hi : lo} of ${opts.back ? `[${lo}, ${end}]` : `[${start}, ${hi}]`} — this is NOT "no member holds the role". The provider's window is too narrow for this range; point TREASURY_LOGS_RPC_BASE at one with a wider eth_getLogs range`,
        );
      }
      try {
        logs = await client.getLogs({ address: manager, event: roleGranted, args: { roleId }, fromBlock: a, toBlock: b });
      } catch (e) {
        // 🔴 NARROW ONLY ON A STATED WINDOW LIMIT. Anything else — a dead node, a bad URL, a
        // rate limit — is rethrown, or "the provider is down" and "nobody holds the role" become
        // the same answer and the caller skips an arm it should have failed on.
        const limit = rangeLimitFromError(e);
        // 🔴 AND ONLY WHEN IT IS NARROWER THAN WHAT WE ALREADY ASKED FOR. A provider that refuses a
        // window it already permits would otherwise have us re-send the identical request forever:
        // chunk is set to a limit it already equals, the cursor never moves, and nothing throws.
        // Measured: without this clause a stub refusing every window
        // with the same stated limit was still running at 301 calls; with it, it throws after 2.
        // A hang cannot be caught by a test that asserts "eventually throws" — only by a call bound.
        if (limit === undefined || limit >= chunk) throw e;
        chunk = limit;
        continue; // same cursor, the window the provider said it would serve
      }
      for (const log of logs) {
        const account = log.args.account;
        if (!account) continue;
        const addr = getAddress(account);
        // The vault holds roles on itself; impersonating it would test the contract calling itself.
        if (seen.has(addr) || addr === getAddress(vault.address)) continue;
        seen.add(addr);
        const [isMember] = await client.readContract({ address: manager, abi: managerAbi, functionName: "hasRole", args: [roleId, addr] });
        if (isMember) return addr;
      }
      if (opts.back) hi = a - 1n;
      else lo = b + 1n;
    }
    return undefined;
  };

  // The deployment run first — that is where roles are granted, and it is a few dozen blocks. It is
  // bounded too: `scanBlocks` terminates it, but on a 10-block provider 5,000 blocks is 501 serial
  // round trips, which is the cost the sweep's guard exists to avoid and not worth paying twice.
  const found = await walk(from, to, { maxRequests: 120 });
  if (found) return found;

  // Then, only if nobody there is still a member, the rest of the chain — BACKWARDS FROM HEAD and
  // under BOUNDS. A member onboarded after the deployment run was onboarded recently, so newest-first
  // finds them in a request or two, where forward-from-deployment is the slowest possible order for
  // exactly the case this sweep exists to serve. 250,000 blocks is ~6 days of Base — past any onboarding
  // someone is waiting on, short of an unbounded crawl — and the request cap stops a narrow-window
  // provider turning that reach into thousands of round trips. Exhausting either THROWS: "nobody
  // holds the role" and "I stopped looking" must never arrive as the same answer.
  if (to < head) return walk(to + 1n, head, { back: true, maxBlocks: 250_000n, maxRequests: 120 });
  return undefined;
}

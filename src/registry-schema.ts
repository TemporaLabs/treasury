import { z } from "zod";
import { getAddress, isAddress } from "viem";

// `strict: true` refuses a lowercase or otherwise mis-cased address — the registry is a hand-edited
// artifact and a checksum is the one typo detector an address carries.
const address = z
  .string()
  .refine((s) => isAddress(s, { strict: true }), { message: "not a checksummed EVM address" })
  .transform((s) => getAddress(s));

export const chassisSchema = z.enum(["morpho-v2", "fusion", "enzyme"]);
export type Chassis = z.infer<typeof chassisSchema>;

/**
 * Which chassis expose a standard ERC-4626 `deposit`/`redeem` to a depositor. Enzyme does not
 * (`buyShares` via the comptroller), which is what every refusal path in this client is measured
 * against: build, pre-flight, the MCP boundary and the default-vault rule all discriminate on it.
 */
export const erc4626Chassis: ReadonlySet<Chassis> = new Set<Chassis>(["morpho-v2", "fusion"]);


/**
 * Whose contract the depositor's USDC actually enters.
 * - `morpho`: a public third-party Morpho vault, reached directly. No row uses it today (Tempora vaults only).
 * - `tempora`: a Tempora fund vault (the product; each fund joins as it goes live).
 */
export const backendSchema = z.enum(["morpho", "tempora"]);
export type Backend = z.infer<typeof backendSchema>;

/**
 * Whether a third party can deposit is a MEASUREMENT, not a config flag. `maxDeposit()` lies on
 * two of the three live chassis (Fusion returns uint256.max behind a whitelist; Morpho V2 returns 0
 * on an open vault), so the only honest value is the result of a simulated `deposit` from a
 * stranger, stamped with when and how it was taken.
 */
export const depositOpenSchema = z.object({
  open: z.boolean(),
  method: z.literal("simulated-deposit-from-stranger"),
  measuredAtBlock: z.number().int().positive(),
  measuredAtIso: z.string().datetime(),
  /** Present iff `open` is false. The observed revert, named only where the instrument discriminated. */
  reason: z.enum(["WHITELIST_GATED", "NOT_ALLOWLISTED", "NOT_ERC4626", "PAUSED", "REVERTED_OTHER"]).optional(),
  detail: z.string().optional(),
});

export const vaultEntrySchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    displayName: z.string().min(1),
    /**
     * What a depositor must be told about THIS vault before any deposit is prepared. REQUIRED,
     * and deliberately not defaulted: a vault cannot enter the registry without someone stating
     * its risk posture in words, and a production vault's text will not read like a test
     * vault's. `earn_vaults` returns it per row; the skill shows it to the depositor rather
     * than summarising it.
     */
    warning: z.string().min(1),
    chainId: z.literal(8453),
    address,
    chassis: chassisSchema,
    backend: backendSchema,
    /** Exactly one vault in the registry carries this; it is what the tools use when no `vault` is given. */
    isDefault: z.boolean().default(false),
    asset: z.object({ address, symbol: z.string().min(1), decimals: z.number().int().min(0).max(36) }),
    /** Measured on-chain via `decimals()`. 18 on Morpho V2 and Enzyme, 8 on Fusion — never assume. */
    shareDecimals: z.number().int().min(0).max(36),
    shareSymbol: z.string().min(1),
    depositOpen: depositOpenSchema,
    /**
     * The first block at which the vault contract has code (measured by bisecting `eth_getCode`). A
     * position's Deposit/Withdraw history cannot predate it, so a scan from here is the WHOLE history —
     * `earn_balance` starts here instead of guessing a lookback.
     */
    deployedAtBlock: z.number().int().positive().optional(),
    notes: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.depositOpen.open && !v.depositOpen.reason) {
      ctx.addIssue({ code: "custom", path: ["depositOpen", "reason"], message: "a closed vault must say why" });
    }
    if (v.depositOpen.open && v.depositOpen.reason) {
      ctx.addIssue({ code: "custom", path: ["depositOpen", "reason"], message: "an open vault carries no reason" });
    }
    if (!erc4626Chassis.has(v.chassis) && v.depositOpen.open) {
      ctx.addIssue({
        code: "custom",
        path: ["depositOpen"],
        message: `${v.chassis} has no ERC-4626 deposit path; it cannot be marked open for this client`,
      });
    }
  });

export type VaultEntry = z.infer<typeof vaultEntrySchema>;

export const registrySchema = z
  .object({
    schemaVersion: z.literal(1),
    /**
     * When the rows were last reconciled against the chain (`scripts/registry-check.ts`). The chain is
     * the only source a row is checked against; there is no upstream repository the client knows of.
     */
    reconciledAtIso: z.string().datetime(),
    vaults: z.array(vaultEntrySchema).min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    const slugs = new Set<string>();
    const addrs = new Set<string>();
    const defaults = r.vaults.filter((v) => v.isDefault);
    if (defaults.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["vaults"], message: `exactly one vault must be isDefault; found ${defaults.length}` });
    }
    const d = defaults[0];
    // A default may be WHITELIST_GATED. The
    // pre-flight re-measures access live on every call and refuses a non-member, so
    // a gated default costs an agent a clear refusal, never funds. It must still be a chassis this client
    // can build for, and it may not be closed for any other reason.
    if (d && !(erc4626Chassis.has(d.chassis) && (d.depositOpen.open || d.depositOpen.reason === "WHITELIST_GATED"))) {
      ctx.addIssue({ code: "custom", path: ["vaults"], message: `the default vault (${d.slug}) must be ERC-4626 and either measured open or WHITELIST_GATED` });
    }
    r.vaults.forEach((v, i) => {
      if (slugs.has(v.slug)) ctx.addIssue({ code: "custom", path: ["vaults", i, "slug"], message: `duplicate slug ${v.slug}` });
      if (addrs.has(v.address)) ctx.addIssue({ code: "custom", path: ["vaults", i, "address"], message: `duplicate address ${v.address}` });
      slugs.add(v.slug);
      addrs.add(v.address);
    });
  });

export type Registry = z.infer<typeof registrySchema>;

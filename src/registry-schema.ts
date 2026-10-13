import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { isAddress as isSolanaAddress } from "@solana/kit";

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
 * against: build, pre-flight, the command boundary and the default-vault rule all discriminate on it.
 */
export const erc4626Chassis: ReadonlySet<Chassis> = new Set<Chassis>(["morpho-v2", "fusion"]);


/**
 * Whose contract the depositor's USDC actually enters.
 * - `morpho`: a public third-party Morpho vault, reached directly. No row uses it today (Tempora Labs vaults only).
 * - `tempora`: a Tempora Labs fund vault (the product; each fund joins as it goes live).
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
    /**
     * The vault's own ERC-20 ticker, from `symbol()` — the identifier every tool takes and returns.
     * It is the chain's name for this vault rather than one this repository assigns, so anyone
     * holding the address can check it, and `scripts/registry-check.ts` reconciles it.
     */
    symbol: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    /** The vault's own `name()`, reconciled the same way. */
    name: z.string().min(1),
    /**
     * What a depositor must be told about THIS vault before any deposit is prepared. REQUIRED,
     * and deliberately not defaulted: a vault cannot enter the registry without someone stating
     * its risk posture in words, and a production vault's text will not read like a test
     * vault's. `earn_vaults` returns it per row; the skill shows it to the depositor rather
     * than summarising it.
     */
    warning: z.string().min(1),
    /**
     * The chain the vault is on. One literal per chain in `chains` (`src/client.ts`), spelled out so
     * `VaultEntry["chainId"]` stays a union of literals — `registry.test.ts` holds the two lists equal.
     * 🔴 Adding a chain here also needs its row in `CHAIN_INFO` (a compile error until it has one) and
     * in `links.ts`'s explorer map (which throws on a chain it does not know).
     */
    chainId: z.union([z.literal(8453), z.literal(42161), z.literal(4663), z.literal(1), z.literal(143)]),
    address,
    chassis: chassisSchema,
    backend: backendSchema,
    /**
     * Exactly one vault PER CHAIN carries this: the vault the tools use when a caller names a chain
     * and no vault. Which chain is used when the caller names neither is `EARN.defaultChain`.
     */
    isDefault: z.boolean().default(false),
    asset: z.object({ address, symbol: z.string().min(1), decimals: z.number().int().min(0).max(36) }),
    /** Measured on-chain via `decimals()`. 18 on Morpho V2 and Enzyme, 8 on Fusion — never assume. */
    shareDecimals: z.number().int().min(0).max(36),
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

/** A Solana account address: base58, exactly as written — base58 is case-sensitive, so it is never normalised. */
const solanaAddress = z.string().refine((s) => isSolanaAddress(s), { message: "not a Solana address" });

/**
 * A vault on Solana. Not an EVM row with different values: there is no chain id, no ERC-4626, no
 * checksummed address, and the depositor's shares are an SPL token of their own (`sharesMint`). So it is a
 * schema of its own, in its own list (`solanaVaults`), and `family` says so in the file as well.
 *
 * `depositOpen` is measured the same way as on EVM — a stranger's SIMULATED deposit, here
 * `simulateTransaction` — and stamped with the slot it was taken at.
 */
export const solanaVaultEntrySchema = z
  .object({
    family: z.literal("solana"),
    /**
     * The ticker every tool takes as `vault`. A Kamino vault's share mint carries no token metadata, so
     * there is no on-chain ticker to read: this one is ASSIGNED here, in the same form as the EVM rows'.
     * `name` IS read on chain (the vault state stores it), and `scripts/registry-check.ts` reconciles it.
     */
    symbol: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    name: z.string().min(1),
    warning: z.string().min(1),
    chain: z.literal("solana"),
    /** The vault's state account: the address every instruction names, and the one an explorer opens. */
    address: solanaAddress,
    chassis: z.literal("kamino-vault"),
    backend: backendSchema,
    isDefault: z.boolean().default(false),
    /** The SPL mint the vault takes and pays (`tokenMint` in the vault state). */
    asset: z.object({ address: solanaAddress, symbol: z.string().min(1), decimals: z.number().int().min(0).max(36) }),
    /** The vault's share mint, a PDA of the vault (`sharesMint` in the vault state). */
    sharesMint: solanaAddress,
    shareDecimals: z.number().int().min(0).max(36),
    depositOpen: z
      .object({
        open: z.boolean(),
        method: z.literal("simulated-deposit-from-stranger"),
        measuredAtSlot: z.number().int().positive(),
        measuredAtIso: z.string().datetime(),
        reason: z.enum(["PERMISSIONED", "REVERTED_OTHER"]).optional(),
        detail: z.string().optional(),
      })
      .strict(),
    /** The slot of the transaction that created the vault state. */
    deployedAtSlot: z.number().int().positive(),
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
  });

export type SolanaVaultEntry = z.infer<typeof solanaVaultEntrySchema>;

export const registrySchema = z
  .object({
    schemaVersion: z.literal(1),
    /**
     * When the rows were last reconciled against the chain (`scripts/registry-check.ts`). The chain is
     * the only source a row is checked against; there is no upstream repository the client knows of.
     */
    reconciledAtIso: z.string().datetime(),
    vaults: z.array(vaultEntrySchema).min(1),
    /** Vaults on Solana; see `solanaVaultEntrySchema`. One default among them, like any chain. */
    solanaVaults: z.array(solanaVaultEntrySchema).default([]),
  })
  .strict()
  .superRefine((r, ctx) => {
    const symbols = new Set<string>();
    const addrs = new Set<string>();
    // One default PER CHAIN that has a vault: a caller who names a chain and no vault must get an
    // answer on every chain the registry offers, and exactly one.
    for (const chainId of [...new Set(r.vaults.map((v) => v.chainId))]) {
      const defaults = r.vaults.filter((v) => v.chainId === chainId && v.isDefault);
      if (defaults.length !== 1) {
        ctx.addIssue({ code: "custom", path: ["vaults"], message: `exactly one vault per chain must be isDefault; chain ${chainId} has ${defaults.length}` });
      }
      // A default may be WHITELIST_GATED. The
      // pre-flight re-measures access live on every call and refuses a non-member, so
      // a gated default costs an agent a clear refusal, never funds. It must still be a chassis this client
      // can build for, and it may not be closed for any other reason.
      for (const d of defaults) {
        if (!(erc4626Chassis.has(d.chassis) && (d.depositOpen.open || d.depositOpen.reason === "WHITELIST_GATED"))) {
          ctx.addIssue({ code: "custom", path: ["vaults"], message: `the default vault (${d.symbol}) must be ERC-4626 and either measured open or WHITELIST_GATED` });
        }
      }
    }
    if (r.solanaVaults.length > 0) {
      const defaults = r.solanaVaults.filter((v) => v.isDefault);
      if (defaults.length !== 1) {
        ctx.addIssue({ code: "custom", path: ["solanaVaults"], message: `exactly one vault per chain must be isDefault; chain solana has ${defaults.length}` });
      }
      for (const d of defaults) {
        if (!d.depositOpen.open) ctx.addIssue({ code: "custom", path: ["solanaVaults"], message: `the default vault (${d.symbol}) on solana must be measured open` });
      }
    }
    r.solanaVaults.forEach((v, i) => {
      if (symbols.has(v.symbol)) ctx.addIssue({ code: "custom", path: ["solanaVaults", i, "symbol"], message: `duplicate symbol ${v.symbol}` });
      if (addrs.has(v.address)) ctx.addIssue({ code: "custom", path: ["solanaVaults", i, "address"], message: `duplicate address ${v.address}` });
      symbols.add(v.symbol);
      addrs.add(v.address);
    });
    r.vaults.forEach((v, i) => {
      if (symbols.has(v.symbol)) ctx.addIssue({ code: "custom", path: ["vaults", i, "symbol"], message: `duplicate symbol ${v.symbol}` });
      if (addrs.has(v.address)) ctx.addIssue({ code: "custom", path: ["vaults", i, "address"], message: `duplicate address ${v.address}` });
      symbols.add(v.symbol);
      addrs.add(v.address);
    });
  });

export type Registry = z.infer<typeof registrySchema>;

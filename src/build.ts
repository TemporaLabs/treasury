import { encodeFunctionData, type Address, type Hex } from "viem";
import { erc4626Abi } from "./abi/erc4626.js";
import { erc4626Chassis, type VaultEntry } from "./registry-schema.js";
import { parseAmount, formatAmount } from "./units.js";

/**
 * An unsigned call. This is the only thing this package ever produces on the write side.
 * Whoever holds the key decides whether to sign it — a wallet, an operator, a policy-engine
 * signer, a token-bound account. The skill supplies intent; the consumer supplies verification.
 */
export interface UnsignedCall {
  chainId: number;
  to: Address;
  data: Hex;
  value: "0x0";
  /** What a human should read before anyone signs this. */
  description: string;
  /** Which step this is in a multi-call intent (approve → deposit). */
  step: number;
  of: number;
  /**
   * How to set the gas limit. Measured on Morpho Vault V2: deposit/redeem gas depends on the time
   * elapsed since the vault's last interest accrual, so an estimate taken now under-counts the
   * storage writes the mined block will do — the tx dies out-of-gas while every simulation
   * succeeds. Buffer the estimate; do not sign an unbuffered one.
   */
  gasAdvice: string;
  /**
   * A read the signer must see satisfied — THROUGH THE RPC IT WILL SEND THROUGH — before it
   * estimates or sends this call. Present only where a step depends on an earlier step's state.
   *
   * Why this is a field and not a sentence: the provider answering `eth_estimateGas` can be
   * a replica one block behind the one that served the previous step's receipt. Measured on both
   * real Cash-Plus round trips (2026-09-13, blocks 51253xxx and 51266819→51266821): approve
   * confirmed, deposit's estimate reverted "ERC20: transfer amount exceeds allowance", the
   * allowance was on-chain. A signer that reads this precondition until it holds is
   * deterministic; a signer that retries on a string match is guessing.
   */
  precondition?: Precondition;
}

/** `read(contract).call(args) >= minimum` (raw units) on the sending RPC before this call goes out. */
export interface Precondition {
  read: "allowance";
  contract: Address;
  owner: Address;
  spender: Address;
  /** Raw token units, as a decimal string — compare as integers, never as floats. */
  minimum: string;
  why: string;
}

const GAS_ADVICE = "Set gas limit = eth_estimateGas × 1.5. Measured: an unbuffered estimate ran out of gas on a Morpho Vault V2 redeem (310,505 gas) while simulation and prior-block re-simulation both succeeded — accrual work grows with elapsed time between estimate and inclusion.";

function assert4626(vault: VaultEntry): void {
  if (!erc4626Chassis.has(vault.chassis)) {
    throw new Error(
      `${vault.symbol} is on ${vault.chassis}, which has no ERC-4626 deposit/redeem path; this client does not build calls for it`,
    );
  }
}

/**
 * `approve(vault, assets)` on the asset token, then `deposit(assets, receiver)` on the vault.
 * `account` is the depositor — the address that signs both calls and whose allowance step 2
 * depends on; it is what the precondition names.
 */
export function buildDeposit(vault: VaultEntry, args: { assetsHuman: string; receiver: Address; account: Address }): UnsignedCall[] {
  assert4626(vault);
  const assets = parseAmount(args.assetsHuman, vault.asset.decimals, `deposit amount (${vault.asset.symbol})`);
  const pretty = `${formatAmount(assets, vault.asset.decimals)} ${vault.asset.symbol}`;
  return [
    {
      chainId: vault.chainId,
      to: vault.asset.address,
      data: encodeFunctionData({ abi: erc4626Abi, functionName: "approve", args: [vault.address, assets] }),
      value: "0x0",
      description: `Approve ${vault.symbol} vault (${vault.address}) to pull ${pretty}`,
      step: 1,
      of: 2,
      gasAdvice: GAS_ADVICE,
    },
    {
      chainId: vault.chainId,
      to: vault.address,
      data: encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [assets, args.receiver] }),
      value: "0x0",
      description: `Deposit ${pretty} into ${vault.name}; shares minted to ${args.receiver}`,
      step: 2,
      of: 2,
      gasAdvice: GAS_ADVICE,
      precondition: {
        read: "allowance",
        contract: vault.asset.address,
        owner: args.account,
        spender: vault.address,
        minimum: assets.toString(),
        why: "Do not estimate or send this until allowance(owner, spender) >= minimum reads back on the RPC you will send through. The receipt for step 1 can come from a node ahead of the one that simulates step 2 (measured twice on real funds).",
      },
    },
  ];
}

/**
 * USDC-denominated withdrawal — the caller never handles share amounts.
 *
 * - `{ assetsHuman }` → ERC-4626 `withdraw(assets, receiver, owner)`: the vault burns whatever
 *   shares that many assets cost at the time of inclusion.
 * - `{ all: true, sharesExact }` → `redeem(shares, receiver, owner)` with the EXACT share balance
 *   the caller read from `earn_balance` (as a string, never through a float): the only way to
 *   empty an account without leaving dust or asking for more than is owned.
 */
export function buildWithdraw(
  vault: VaultEntry,
  args: { receiver: Address; owner: Address } & ({ assetsHuman: string; all?: false } | { all: true; sharesExact: string }),
): UnsignedCall[] {
  assert4626(vault);
  if (args.all) {
    const shares = parseAmount(args.sharesExact, vault.shareDecimals, `share balance (${vault.symbol})`);
    return [
      {
        chainId: vault.chainId,
        to: vault.address,
        data: encodeFunctionData({ abi: erc4626Abi, functionName: "redeem", args: [shares, args.receiver, args.owner] }),
        value: "0x0",
        description: `Withdraw EVERYTHING from ${vault.name}: redeem ${formatAmount(shares, vault.shareDecimals)} ${vault.symbol} (the exact balance) for ${vault.asset.symbol}, paid to ${args.receiver}`,
        step: 1,
        of: 1,
        gasAdvice: GAS_ADVICE,
      },
    ];
  }
  const assets = parseAmount(args.assetsHuman, vault.asset.decimals, `withdraw amount (${vault.asset.symbol})`);
  return [
    {
      chainId: vault.chainId,
      to: vault.address,
      data: encodeFunctionData({ abi: erc4626Abi, functionName: "withdraw", args: [assets, args.receiver, args.owner] }),
      value: "0x0",
      description: `Withdraw ${formatAmount(assets, vault.asset.decimals)} ${vault.asset.symbol} from ${vault.name}, paid to ${args.receiver}; the vault burns the shares that costs at inclusion`,
      step: 1,
      of: 1,
      gasAdvice: GAS_ADVICE,
    },
  ];
}


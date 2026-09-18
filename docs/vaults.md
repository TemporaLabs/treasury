# Vaults

Treasury offers Tempora's own vaults, and only those. Every row in the registry
(`registry/vaults.json`) is a claim about a contract at an address, and every claim
carries the block it was measured at. `scripts/registry-check.ts` reconciles each row against the
chain — `symbol()`, `decimals()`, `asset()`, and the first block with code — and a disagreement means
the row is wrong, never the chain.

## Offered today

### Tempora Labs Cash Plus USDC (Test 2) — the default

| | |
|---|---|
| slug | `cash-plus-usdc-2` |
| chain | Base (8453) |
| vault | [`0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf`](https://basescan.org/address/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf) |
| asset | USDC [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), 6 decimals |
| shares | `tlCashPlusUSDC2`, **18 decimals** — a share amount is never an asset amount |
| chassis | Morpho Vault V2 (ERC-4626) |
| deployed | block 51,371,133 (first block with code) |
| deposits | **open to any account**. A stranger's simulated `deposit()` reaches the USDC pull and reverts `TransferFromReverted` only for lack of funds (measured at block 51,372,415). `maxDeposit()` reads `0` to every caller on this chassis by design and is not consulted |
| withdrawals | **public**. Served from idle USDC, then through the vault's liquidity adapter; a withdrawal larger than that reverts until positions are unwound — `earn_balance` reports `exit.exitableNow` by simulating it. `maxWithdraw()` also reads `0` by design |
| fees | none set: `performanceFee()` and `managementFee()` read `0` at block 51,372,415. The curator can introduce one, and the vault's fee timelocks are **0** (`timelock(setPerformanceFee)` and `timelock(setManagementFee)` both read `0` at block 51,404,161), so a change needs no notice; Morpho Vault V2's protocol constants cap them at 50% performance and 5%/yr management. Read both fees on-chain before depositing |
| positions | Morpho vaults on Base through the vault's adapters — readable on-chain; Treasury does not model the fund's allocation. One of the fund's positions lends against a stablecoin whose Morpho oracle is fixed at par; a depeg is not priced by the fund's loss model. Read the vault's positions on-chain before a first deposit |

### Tempora Labs Cash Plus USDC (Test 2A)

| | |
|---|---|
| slug | `cash-plus-usdc-2a` |
| chain | Base (8453) |
| vault | [`0x1516D2c082b9cc9af852B1Ebc828f168F27299ef`](https://basescan.org/address/0x1516D2c082b9cc9af852B1Ebc828f168F27299ef) |
| asset | USDC [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), 6 decimals |
| shares | `tlCashPlusUSDC2A`, **8 decimals** — a share amount is never an asset amount |
| chassis | IPOR Fusion PlasmaVault (ERC-4626) |
| deployed | block 51,359,816 (first block with code) |
| deposits | **whitelist-gated**: `deposit()` needs a role on the vault's AccessManager. A stranger's simulated deposit reverts `AccessManagedUnauthorized` (measured at block 51,361,109) |
| withdrawals | **public**: an account that holds shares can always leave |
| exit | instant-withdrawal fuses are configured, so a withdrawal is served from the vault's liquid balance and then by unwinding positions in the same transaction. A withdrawal larger than what those positions can release in-block still reverts — `earn_balance` reports `exit.exitableNow` by simulating it |
| fees | a management fee and a performance fee, both readable on-chain from the vault (`getManagementFeeData`, `getPerformanceFeeData`) |
| positions | ERC-4626 leaf vaults on Base — readable on-chain; Treasury does not model the fund's allocation |

**"Test" is in both names on purpose.** These are test-series vaults: real contracts, real USDC, real
positions, operated by Tempora while the product is proven. Read [`risks.md`](risks.md).

## Getting access to a whitelist-gated vault

Admission is a fund-side action: the vault's operator grants the deposit role to your account on the
vault's AccessManager. Treasury cannot do it, request it, or work around it, and the skill instructs
an agent to stop rather than substitute a different vault. Until you are admitted, `earn_status`
returns `WHITELIST_GATED` for your account and the vault is not in `depositable`. Contact Tempora to be admitted.

Who is admitted is on the chain, in the AccessManager's `hasRole`. Treasury writes no member address
anywhere in this repository; its own test tiers discover one from the chain when they need it.

## Why the default is what it is

**The default is a Tempora-curated destination, and Tempora can set fees on it as curator.** Treasury offers it
because it is Tempora's — not because it is the best-yielding vault available, and Treasury makes no
such claim. A fork of this client may point its default anywhere; the official distribution points
here, and says so.

## What a registry row is not

A row is not a recommendation, a yield forecast, or a promise of liquidity. `depositOpen` is a
measurement with a block on it and is re-taken live by the pre-flight on every call; a yield figure,
where one is shown, is somebody's measurement over some window and is labelled with its source.

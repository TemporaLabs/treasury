# Vaults

Treasury offers Tempora's own vaults, and only those. Every row in the registry
(`registry/vaults.json`) is a claim about a contract at an address, and every claim
carries the block it was measured at. `scripts/registry-check.ts` reconciles each row against the
chain — `symbol()`, `decimals()`, `asset()`, and the first block with code — and a disagreement means
the row is wrong, never the chain.

## Offered today

Two chains: Base, which is the default, and Arbitrum One. Each chain has its own default vault (Test 2B on Base, Test 2C on Arbitrum One); a
tool called with no vault and no chain uses Base's. Test 2, the demo vault, is also on Base and is chosen by naming it. A vault's ticker names exactly one vault on
exactly one chain.

### Tempora Labs Cash Plus USDC (Test 2) — the demo vault

| | |
|---|---|
| ticker | `tlCashPlusUSDC2` |
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

The demo vault: open and depositable, listed so the product can be exercised end to end, but it is not what a call with no vault uses. Name it with `vault: "tlCashPlusUSDC2"`.

### Tempora Labs Cash Plus USDC (Test 2A)

| | |
|---|---|
| ticker | `tlCashPlusUSDC2A` |
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

### Tempora Labs Cash Plus USDC (Test 2B) — the default on Base

| | |
|---|---|
| ticker | `tlCashPlusUSDC2B` |
| chain | Base (8453) |
| vault | [`0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F`](https://basescan.org/address/0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F) |
| asset | USDC [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), 6 decimals |
| shares | `tlCashPlusUSDC2B`, **18 decimals** — a share amount is never an asset amount |
| chassis | Morpho Vault V2 (ERC-4626) |
| deployed | block 51,436,870 (first block with code) |
| deposits | **open to any account**. A stranger's simulated `deposit()` reaches the USDC pull and reverts `TransferFromReverted` only for lack of funds (measured at block 52,097,648). `maxDeposit()` reads `0` to every caller on this chassis by design and is not consulted |
| withdrawals | **public**. Served from idle USDC, then through the vault's liquidity adapter; a withdrawal larger than that reverts until positions are unwound — `earn_balance` reports `exit.exitableNow` by simulating it. `maxWithdraw()` also reads `0` by design |
| fees | none set: `performanceFee()` and `managementFee()` read `0` at block 51,372,415. The curator can introduce one, and the vault's fee timelocks are **0** (`timelock(setPerformanceFee)` and `timelock(setManagementFee)` both read `0` at block 52,097,648), so a change needs no notice; Morpho Vault V2's protocol constants cap them at 50% performance and 5%/yr management. Read both fees on-chain before depositing |
| positions | three adapters on Base — readable on-chain; Treasury does not model the fund's allocation. Read the vault's positions on-chain before a first deposit |
| links | BaseScan only. Morpho's app has no page for this vault (`app.morpho.org/base/vault/…` answered 404 on 2026-10-02, and Morpho's API does not list it), so `earn_vaults` offers no `app` link for it |

### Tempora Labs Cash Plus USDC (Test 2C) — the default on Arbitrum One

| | |
|---|---|
| ticker | `tlCashPlusUSDC2C` |
| chain | Arbitrum One (42161) |
| vault | [`0x4057a63953142Ac2b3E5dB1954Fc14d578662587`](https://arbiscan.io/address/0x4057a63953142Ac2b3E5dB1954Fc14d578662587) |
| asset | native USDC [`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`](https://arbiscan.io/address/0xaf88d065e77c8cC2239327C5EDb3A432268e5831), 6 decimals — not bridged USDC.e, which is a different token this vault does not take |
| shares | `tlCashPlusUSDC2C`, **18 decimals** — a share amount is never an asset amount |
| chassis | Morpho Vault V2 (ERC-4626) |
| deployed | block 510,270,114 (first block with code) |
| deposits | **open to any account**. A stranger's simulated `deposit()` reaches the USDC pull and reverts `TransferFromReverted` only for lack of an allowance (measured at block 511,070,816). `maxDeposit()` reads `0` to every caller on this chassis by design and is not consulted |
| withdrawals | **public**. Served from idle USDC, then through the vault's liquidity adapter; a withdrawal larger than that reverts until positions are unwound — `earn_balance` reports `exit.exitableNow` by simulating it. `maxWithdraw()` also reads `0` by design |
| fees | none set: `performanceFee()` and `managementFee()` read `0` at block 511,070,816. The curator can introduce one, and the vault's fee timelocks are **0** (`timelock(setPerformanceFee)` and `timelock(setManagementFee)` both read `0` at that block), so a change needs no notice; Morpho Vault V2's protocol constants cap them at 50% performance and 5%/yr management. Read both fees on-chain before depositing |
| positions | through the vault's three adapters on Arbitrum One — readable on-chain; Treasury does not model the fund's allocation. Read the vault's positions on-chain before a first deposit |
| links | Arbiscan only. Morpho's app has no page for this vault yet (`app.morpho.org/arbitrum/vault/…` answered 404 on 2026-10-02), so `earn_vaults` offers no `app` link for it |

**"Test" is in every name on purpose.** These are test-series vaults: real contracts, real USDC, real
positions, operated by Tempora while the product is proven. Read [`risks.md`](risks.md).

## Getting access to a whitelist-gated vault

Admission is a fund-side action: the vault's operator grants the deposit role to your account on the
vault's AccessManager. Treasury cannot do it, request it, or work around it, and the skill instructs
an agent to stop rather than substitute a different vault. Until you are admitted, `earn_status`
returns `WHITELIST_GATED` for your account and the vault is not in `depositable`. Contact Tempora to be admitted.

Who is admitted is on the chain, in the AccessManager's `hasRole`. Treasury writes no member address
anywhere in this repository; its own test tiers discover one from the chain when they need it.

## Why the default is what it is

**Each chain's default is a Tempora-curated destination, and Tempora can set fees on it as curator.** Treasury offers it
because it is Tempora's — not because it is the best-yielding vault available, and Treasury makes no
such claim. A fork of this client may point its default anywhere; the official distribution points
here, and says so.

## What a registry row is not

A row is not a recommendation, a yield forecast, or a promise of liquidity. `depositOpen` is a
measurement with a block on it and is re-taken live by the pre-flight on every call; a yield figure,
where one is shown, is somebody's measurement over some window and is labelled with its source.

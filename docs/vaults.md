# Vaults

Treasury offers Tempora Labs' own vaults, and only those. Every row in the registry
(`registry/vaults.json`) is a claim about a contract at an address, and every claim
carries the block it was measured at. `scripts/registry-check.ts` reconciles each row against the
chain — `symbol()`, `decimals()`, `asset()`, and the first block with code — and a disagreement means
the row is wrong, never the chain.

## Offered today

Eight vaults on six chains. **A call that names no vault and no chain uses the default: Test 2B on Base.**
Naming `--chain arbitrum` uses Test 2C, `--chain robinhood` Test 2D, `--chain ethereum` Test 2E, `--chain monad` Test 2F and `--chain solana` Test 2G. Test 2 is the demo vault: chosen by naming it. A vault's ticker
names exactly one vault on exactly one chain.

| vault | ticker | chain | role | how to choose it | where to look |
|---|---|---|---|---|---|
| Cash Plus USDC (Test 2B) | `tlCashPlusUSDC2B` | Base | **the default** | name nothing, or `--chain base` | [BaseScan](https://basescan.org/address/0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F). Morpho's app has no page for it |
| Cash Plus USDC (Test 2) | `tlCashPlusUSDC2` | Base | **the demo** | `--vault tlCashPlusUSDC2` | [Morpho app](https://app.morpho.org/base/vault/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf/tempora-labs-cash-plus-usdc-test-2#overview), [BaseScan](https://basescan.org/address/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf) |
| Cash Plus USDC (Test 2C) | `tlCashPlusUSDC2C` | Arbitrum One | the default on Arbitrum One | `--chain arbitrum` | [Arbiscan](https://arbiscan.io/address/0x4057a63953142Ac2b3E5dB1954Fc14d578662587). Morpho's app has no page for it |
| Cash Plus USDG (Test 2D) | `tlCashPlusUSDG2D` | Robinhood Chain | the default on Robinhood Chain; its asset is **USDG**, not USDC | `--chain robinhood` | [Blockscout](https://robinhoodchain.blockscout.com/address/0x758f00731943aA88e8C7fB709e0B727903B4F833) |
| Cash Plus USDC (Test 2E) | `tlCashPlusUSDC2E` | Ethereum | the default on Ethereum; gas costs far more there | `--chain ethereum` | [Etherscan](https://etherscan.io/address/0x2AA9B1F12bbFE1E01dcb4DD52E6836d68416e3B6) |
| Cash Plus USDC (Test 2F) | `tlCashPlusUSDC2F` | Monad | the default on Monad | `--chain monad` | [MonadScan](https://monadscan.com/address/0x163295A4d4381745A205DC5E9A436a3f51791593) |
| Cash Plus USDC (Test 2G) | `tlCashPlusUSDC2G` | Solana | the default on Solana; a Kamino vault, not ERC-4626 | `--chain solana` | [Solscan](https://solscan.io/account/8qV54zrW2piQgBbVaUUtGajf4KuVDKLUDquHv9VZBfS7) |
| Cash Plus USDC (Test 2A) | `tlCashPlusUSDC2A` | Base | whitelist-gated; listed so an admitted account can read and exit its position | `--vault tlCashPlusUSDC2A` | [BaseScan](https://basescan.org/address/0x1516D2c082b9cc9af852B1Ebc828f168F27299ef) |

**How the open EVM vaults differ** (Test 2G on Solana is described in its own section). Each holds three positions, in three other ERC-4626 vaults (Morpho, Spark, Fluid, Aave, Euler and Curvance vaults), and no
two hold the same three contracts. Read from each vault's adapters on 2026-10-02 (the
underlying vaults, by address, in adapter order):

| vault | position 1 | position 2 | position 3 |
|---|---|---|---|
| Test 2B (Base) | Spark USDC Vault `0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858` (sUSDC, the savings-rate token) | Steakhouse Prime USDC `0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9` | Gauntlet USDC Frontier `0x1deEfABEe758AAbdC29a542B24ca3b75aFD56765` |
| Test 2 (Base) | Steakhouse High Yield USDC v1.1 `0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F` | Gauntlet USDC Prime `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` | Spark USDC Vault `0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A` (a lending vault) |
| Test 2C (Arbitrum One) | Spark USDC Vault `0x940098b108fB7D0a7E374f6eDED7760787464609` (sUSDC) | Gauntlet USDC Prime `0x610D151aE40662AE148cdBaaE1Ea5904b6AFAE78` | Fluid USD Coin `0x1A996cb54bb95462040408C06122D45D6Cdb6096` |
| Test 2D (Robinhood Chain), read 2026-10-04 | Spark Savings USDG `0xde770c84FE66E063336b31737cFE9790f18c4087` (spUSDG) | Steakhouse USDG `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` | Grove x Steakhouse USDG `0xBEEff039907422219Fb367e525954DDC092854d9` |
| Test 2E (Ethereum), read 2026-10-11 | Spark USDC Vault `0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE` (sUSDC) | Steakhouse Prime USDC `0xbeef088055857739C12CD3765F20b7679Def0f51` | Gauntlet USDC Frontier `0x9a1D6bd5b8642C41F25e0958129B85f8E1176F3e` |
| Test 2F (Monad), read 2026-10-11 | Wrapped Aave Monad USDC `0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2` (waMonUSDC) | EVK Vault eUSDC-12 `0x1905EDDF5943ef6C92Ccf1469bd40fC2cB4A77b0` (Euler) | Curvance USDC `0x9891178A1178E4C740Fa61Fd6e30A9D92D897590` (cUSDC) |

The same rule allocates the first four; Test 2C is that rule over Arbitrum One's vaults, and Test 2D over Robinhood Chain's USDG vaults. Test 2E
holds Ethereum's counterparts of Test 2B's three positions (same names, different contracts), and Test 2F holds Monad lending vaults. The most visible
difference between Test 2B and Test 2 is their Spark position: Test 2B's (its first) is the
savings-rate token, and Test 2's (its third) is a lending vault, which carries that book's credit risk. The two Base anchors have the same
name on-chain (`Spark USDC Vault`) and are different contracts, so Treasury names them by address.

**Why Test 2 is the demo.** It is the vault that Morpho's own app lists, so it can be shown there; it is
open to any account and exercises every path. It is not what an agent uses unless asked.

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
| fees | none set: `performanceFee()` and `managementFee()` read `0` at block 52,097,648. The curator can introduce one, and the vault's fee timelocks are **0** (`timelock(setPerformanceFee)` and `timelock(setManagementFee)` both read `0` at block 52,097,648), so a change needs no notice; Morpho Vault V2's protocol constants cap them at 50% performance and 5%/yr management. Read both fees on-chain before depositing |
| positions | three adapters on Base — readable on-chain; Treasury does not model the fund's allocation. Whether any of them lends against a stablecoin whose oracle assumes par is not measured here for this vault (see [`risks.md`](risks.md)). Read the vault's positions on-chain before a first deposit |
| links | BaseScan only. Morpho's app has no page for this vault (`app.morpho.org/base/vault/…` answered 404 on 2026-10-02, and Morpho's API does not list it), so `earn_vaults` offers no `app` link for it |

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
| positions | ERC-4626 vaults on Base through the vault's adapters — readable on-chain; Treasury does not model the fund's allocation. One of the fund's positions lends against a stablecoin whose Morpho oracle is fixed at par; a depeg is not priced by the fund's loss model. Read the vault's positions on-chain before a first deposit |

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
| positions | through the vault's three adapters on Arbitrum One — readable on-chain; Treasury does not model the fund's allocation. Whether any of them lends against a stablecoin whose oracle assumes par is not measured here for this vault (see [`risks.md`](risks.md)). Read the vault's positions on-chain before a first deposit |
| links | Arbiscan only. Morpho's app has no page for this vault yet (`app.morpho.org/arbitrum/vault/…` answered 404 on 2026-10-02), so `earn_vaults` offers no `app` link for it |

### Tempora Labs Cash Plus USDG (Test 2D) — the default on Robinhood Chain

| | |
|---|---|
| ticker | `tlCashPlusUSDG2D` |
| chain | Robinhood Chain (4663) |
| vault | [`0x758f00731943aA88e8C7fB709e0B727903B4F833`](https://robinhoodchain.blockscout.com/address/0x758f00731943aA88e8C7fB709e0B727903B4F833) |
| asset | **USDG** (Global Dollar) [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168), 6 decimals — **not USDC**. Every amount in and out of this vault is USDG; a tool argument or result field named for USDC (`amount_usdc`, `usdcValue`) carries USDG here |
| shares | `tlCashPlusUSDG2D`, **18 decimals** — a share amount is never an asset amount |
| chassis | Morpho Vault V2 (ERC-4626) |
| deployed | block 79,381,803 (the block of the factory call that created it; its `CreateVaultV2` event names this vault) |
| deposits | **open to any account**. A stranger's simulated `deposit()` reaches the USDG pull and reverts `TransferFromReverted` only for lack of an allowance (measured at block 79,974,900). `maxDeposit()` reads `0` to every caller on this chassis by design and is not consulted |
| withdrawals | **public**. Served from idle USDG, then through the vault's liquidity adapter; a withdrawal larger than that reverts until positions are unwound — `earn_balance` reports `exit.exitableNow` by simulating it. `maxWithdraw()` also reads `0` by design |
| fees | none set: `performanceFee()` and `managementFee()` read `0` at block 79,974,900. The curator can introduce one, and the vault's fee timelocks are **0** (`timelock(setPerformanceFee)` and `timelock(setManagementFee)` both read `0` at that block), so a change needs no notice; Morpho Vault V2's protocol constants cap them at 50% performance and 5%/yr management. Read both fees on-chain before depositing |
| positions | through the vault's three adapters on Robinhood Chain — readable on-chain; Treasury does not model the fund's allocation. Whether any of them lends against a stablecoin whose oracle assumes par is not measured here for this vault (see [`risks.md`](risks.md)). Read the vault's positions on-chain before a first deposit |
| links | Blockscout only; `earn_vaults` offers no `app` link for it |

### Tempora Labs Cash Plus USDC (Test 2E) — the default on Ethereum

| | |
|---|---|
| ticker | `tlCashPlusUSDC2E` |
| chain | Ethereum (1) |
| vault | [`0x2AA9B1F12bbFE1E01dcb4DD52E6836d68416e3B6`](https://etherscan.io/address/0x2AA9B1F12bbFE1E01dcb4DD52E6836d68416e3B6) |
| asset | USDC [`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`](https://etherscan.io/address/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48), 6 decimals |
| shares | `tlCashPlusUSDC2E`, **18 decimals** — a share amount is never an asset amount |
| chassis | Morpho Vault V2 (ERC-4626) |
| deployed | block 26,164,268 (first block with code) |
| deposits | **open to any account**. A stranger's simulated `deposit()` reaches the USDC pull and reverts `TransferFromReverted` only for lack of an allowance (measured at block 26,166,799). `maxDeposit()` reads `0` to every caller on this chassis by design and is not consulted |
| withdrawals | **public**. Served from idle USDC, then through the vault's liquidity adapter; a withdrawal larger than that reverts until positions are unwound — `earn_balance` reports `exit.exitableNow` by simulating it. `maxWithdraw()` also reads `0` by design |
| fees | none set: `performanceFee()` and `managementFee()` read `0` at block 26,166,799. The curator can introduce one, and the vault's fee timelocks are **0** (`timelock(setPerformanceFee)` and `timelock(setManagementFee)` both read `0` at that block), so a change needs no notice; Morpho Vault V2's protocol constants cap them at 50% performance and 5%/yr management. Read both fees on-chain before depositing |
| gas | **far higher than on the other chains.** The approve, the deposit and a later withdrawal each pay Ethereum gas in ETH, which can be a large share of a small deposit; the skill says so when an operator picks Ethereum for a small amount |
| positions | three adapters on Ethereum (listed above) — readable on-chain; Treasury does not model the fund's allocation. Whether any of them lends against a stablecoin whose oracle assumes par is not measured here for this vault (see [`risks.md`](risks.md)). Read the vault's positions on-chain before a first deposit |
| links | Etherscan only; `earn_vaults` offers no `app` link for it |

### Tempora Labs Cash Plus USDC (Test 2F) — the default on Monad

| | |
|---|---|
| ticker | `tlCashPlusUSDC2F` |
| chain | Monad (143) |
| vault | [`0x163295A4d4381745A205DC5E9A436a3f51791593`](https://monadscan.com/address/0x163295A4d4381745A205DC5E9A436a3f51791593) |
| asset | USDC [`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`](https://monadscan.com/address/0x754704Bc059F8C67012fEd69BC8A327a5aafb603), 6 decimals |
| shares | `tlCashPlusUSDC2F`, **18 decimals** — a share amount is never an asset amount |
| chassis | Morpho Vault V2 (ERC-4626) |
| deployed | block 112,273,210 (first block with code) |
| deposits | **open to any account**. A stranger's simulated `deposit()` reaches the USDC pull and reverts `TransferFromReverted` only for lack of an allowance (measured at block 112,372,495). `maxDeposit()` reads `0` to every caller on this chassis by design and is not consulted |
| withdrawals | **public**. Served from idle USDC, then through the vault's liquidity adapter; a withdrawal larger than that reverts until positions are unwound — `earn_balance` reports `exit.exitableNow` by simulating it. `maxWithdraw()` also reads `0` by design |
| fees | none set: `performanceFee()` and `managementFee()` read `0` at block 112,372,495. The curator can introduce one, and the vault's fee timelocks are **0** (`timelock(setPerformanceFee)` and `timelock(setManagementFee)` both read `0` at that block), so a change needs no notice; Morpho Vault V2's protocol constants cap them at 50% performance and 5%/yr management. Read both fees on-chain before depositing |
| history | Monad's public endpoint serves `eth_getLogs` over at most **100 blocks** per request, and Monad makes about three blocks a second, so `earn_balance`'s history scan through it covers under an hour and says it was cut short. Set `TREASURY_LOGS_RPC_MONAD` to a provider with a wider range for entry basis and yield |
| positions | three adapters on Monad (listed above) — readable on-chain; Treasury does not model the fund's allocation. Whether any of them lends against a stablecoin whose oracle assumes par is not measured here for this vault (see [`risks.md`](risks.md)). Read the vault's positions on-chain before a first deposit |
| links | MonadScan only; `earn_vaults` offers no `app` link for it |

### Tempora Labs Cash Plus USDC (Test 2G) — the default on Solana

| | |
|---|---|
| ticker | `tlCashPlusUSDC2G` — assigned by this registry: the share mint carries no token metadata, so there is no on-chain ticker. The name below is read from the vault's own state |
| chain | Solana mainnet-beta |
| vault | the Kamino vault state [`8qV54zrW2piQgBbVaUUtGajf4KuVDKLUDquHv9VZBfS7`](https://solscan.io/account/8qV54zrW2piQgBbVaUUtGajf4KuVDKLUDquHv9VZBfS7), owned by Kamino's vault program `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd` |
| asset | USDC, mint [`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`](https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v), 6 decimals |
| shares | an SPL token, mint [`pxUHrn6sFsnZiLToD9hQa5p6vXRFx7h8dCjZr7LXp7Z`](https://solscan.io/token/pxUHrn6sFsnZiLToD9hQa5p6vXRFx7h8dCjZr7LXp7Z), **6 decimals**, minted only by the vault's own authority |
| chassis | Kamino vault (not ERC-4626): `deposit` and `withdraw` instructions, no approve step |
| deployed | slot 455,493,127 (the transaction that created the vault state, 2026-10-11) |
| deposits | **open to any account**: the vault's permissioning authority is unset, and a simulated 1 USDC deposit from an unrelated account succeeded at slot 455,531,367. Deposit cap: 1,000 USDC in total |
| withdrawals | **public while no co-signer is set** (see below). Paid from idle USDC first, then from one named reserve per instruction; a withdrawal needing more is split across reserves, and each leg is limited by its reserve's available liquidity, so while a reserve is highly utilised a large withdrawal can be refused or need more than one transaction — `earn_balance` simulates the exit. **Each withdraw instruction keeps up to 0.001 USDC in the vault**: Kamino's global withdrawal penalty for every vault on its program (`withdrawalPenaltyLamports` = 1000 in the program's global config, read 2026-10-11), not this vault's own setting (0), and Kamino can change it at any time without notice. A withdrawal that needs two reserves is two instructions: measured by simulation, 2,000,000 shares kept 1,000 as one instruction and 1,929 as two. A withdrawal worth 0.001 USDC or less is refused (program error 7049). Quotes report exactly what the account receives |
| fees | none set: performance and management fees read 0 (2026-10-11). The vault admin can set them, and this vault's own withdrawal penalty, with **no timelock**: a change takes effect in the transaction that makes it. The vault admin or Kamino's global admin can also set a per-reserve crank fee taken from each deposit, and minimum deposit and withdrawal amounts; all read 0 (2026-10-11) |
| co-signer | Kamino's program can require a co-signer (a permissioning authority) on **every deposit and every withdrawal**; set by Kamino's global admin, with no delay, that is a power to stop exits. Unset (read 2026-10-11); Treasury refuses to build a deposit or withdrawal while one is set |
| positions | idle USDC, Kamino's main-market USDC reserve [`D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59`](https://solscan.io/account/D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59) and its OnRe-market USDC reserve [`AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z`](https://solscan.io/account/AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z) — readable on-chain; Treasury does not model the allocation |
| programs | both Kamino programs are upgradeable by their upgrade authority; a later upgrade can change any behaviour described here. Treasury's decoders refuse an account of the wrong size or type rather than read it |
| what it needs | a Solana wallet, and SOL for each transaction's fee and, on a first deposit, about 0.002 SOL of rent for the share account |
| links | Solscan |

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
| withdrawals | **public**: not gated by the whitelist, so an account that holds shares can leave, subject to the liquidity described under exit |
| exit | instant-withdrawal fuses are configured, so a withdrawal is served from the vault's liquid balance and then by unwinding positions in the same transaction. A withdrawal larger than what those positions can release in-block still reverts — `earn_balance` reports `exit.exitableNow` by simulating it |
| fees | a management fee and a performance fee, both readable on-chain from the vault (`getManagementFeeData`, `getPerformanceFeeData`) |
| positions | ERC-4626 leaf vaults on Base — readable on-chain; Treasury does not model the fund's allocation |

**"Test" is in every name on purpose.** These are test-series vaults: real contracts, real USDC or USDG, real
positions, operated by Tempora Labs while the product is proven. Read [`risks.md`](risks.md).

## Getting access to a whitelist-gated vault

Admission is a fund-side action: the vault's operator grants the deposit role to your account on the
vault's AccessManager. Treasury cannot do it, request it, or work around it, and the skill instructs
an agent to stop rather than substitute a different vault. Until you are admitted, `earn_status`
returns `WHITELIST_GATED` for your account and the vault is not in `depositable`. Test 2A, the only gated
vault listed, is listed so an account that already holds it can read and exit its position; it is not
offered for new deposits.

Who is admitted is on the chain, in the AccessManager's `hasRole`. Treasury writes no member address
anywhere in this repository; its own test tiers discover one from the chain when they need it.

## Why the default is what it is

**Each chain's default is a destination curated by Tempora Labs, and Tempora Labs can set fees on it as curator.** Treasury offers it
because it is a Tempora Labs vault — not because it is the best-yielding vault available, and Treasury makes no
such claim. A fork of this client may point its default anywhere; the official distribution points
here, and says so.

## What a registry row is not

A row is not a recommendation, a yield forecast, or a promise of liquidity. `depositOpen` is a
measurement with a block on it and is re-taken live by the pre-flight on every call; a yield figure,
where one is shown, is somebody's measurement over some window and is labelled with its source.

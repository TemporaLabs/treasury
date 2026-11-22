# The vault registry

`registry/vaults.json` is the list of vaults the library knows, and the one the Solana commands read; on the EVM
chains the commands list and reach the vaults the Tempora API lists instead
([`../earn-api/`](../earn-api/README.md)): a `--vault` goes to the API as typed, and the EVM rows only give a
response its `ticker` and back each chain's default address. This topic is
how it is validated, embedded, resolved and reconciled. Which vaults it lists today, and why, is
[`../../vaults.md`](../../vaults.md); the checklist for adding a vault or a chain is the "Adding or
changing a vault" section of [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

| guide | read it when |
|---|---|
| [`01-the-vault-registry.md`](01-the-vault-registry.md) | you add or change a row, add a chain, or touch how a vault or default is chosen |

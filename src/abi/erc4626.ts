/**
 * The ERC-4626 + ERC-20 fragment this client still reads, and nothing else — no admin, allocator or
 * operator entry points. Two users: `src/earn/request.ts` decodes each step the Tempora API prepares
 * (approve, deposit, withdraw, redeem) to describe it, and its `function` and `args`, from its own calldata; and
 * `scripts/registry-check.ts` reads a registry row's `name`, `symbol`, `decimals` and `asset` on chain.
 */
export const erc4626Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      // `value`, not `amount`: these names are USER-VISIBLE as a step's `args` (`src/earn/request.ts`), and an
      // operator reads them next to a block explorer's own form, which is labelled from the
      // verified contract's ABI. EIP-20 and OpenZeppelin's implementation both name this `value`.
      // Encoding is unaffected — a parameter binds by position and type, never by name.
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

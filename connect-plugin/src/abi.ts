import { parseAbi } from "viem";

// Only what the confirmation page needs to decode: ERC-4626 vault writes, ERC-20 approve, and
// ERC-20 transfer (decoded so a stray transfer is shown for what it is, never to build one).
// Parameter names are user-visible on the confirmation page; they follow EIP-20 / EIP-4626.
export const decodeAbi = parseAbi([
  "function approve(address spender, uint256 value)",
  "function transfer(address to, uint256 value)",
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
]);

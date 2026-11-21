// The acknowledgement for an EVM leg: its warning and explorer line come from the Tempora API's product. A product
// that carries none still tells the operator the vault is a test vault, and prints no empty explorer line.
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { acknowledgementText } from "../src/connect/ack.js";
import { vaultLeg } from "../src/connect/vault-request.js";
import type { VaultProduct } from "../src/earn/api.js";
import { registryProducts } from "./fixtures/api.js";

const OWNER = getAddress("0x00000000000000000000000000000000000000aa");
const base = () => registryProducts().find((p) => (p as unknown as VaultProduct).vault.chain === "eip155:8453") as unknown as VaultProduct;

describe("an EVM leg's acknowledgement", () => {
  for (const action of ["deposit", "withdraw"] as const) {
    it(`a product with no warnings and no explorer link still warns of a test vault, with no empty line (${action})`, () => {
      const p = { ...base(), warnings: [], vaultLinks: undefined } as unknown as VaultProduct;
      const ask = action === "deposit" ? { action, amount_usdc: "1" } : { action, all: true };
      const text = acknowledgementText(vaultLeg(p, OWNER, ask).summary);
      expect(text).toMatch(/^WARNING: \S.*TEST VAULT/m);
      expect(text).not.toMatch(/^ +$/m);
    });
  }
});

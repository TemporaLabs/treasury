/**
 * The hard gate every call passes before a page opens: what `treasury connect` will put in front of
 * the operator's wallet at all. It re-derives everything from the calldata and the registry and
 * trusts nothing the call's own fields say about themselves (`description`, `args`, `function`).
 *
 * Allowed, and nothing else:
 *   - `approve(vault, n)` on a registry vault's own asset, for exactly the amount the deposit after
 *     it pulls — never unlimited, never to anything but that vault;
 *   - `deposit(assets, receiver)` on a registry vault, receiver = the connected account;
 *   - `withdraw(assets, receiver, owner)` / `redeem(shares, receiver, owner)` on a registry vault,
 *     receiver = owner = the connected account.
 * Every call carries no value and names a supported chain that matches its vault.
 *
 * And one batch is one operation on one vault, on one chain, in one of the shapes the builders
 * emit: `[approve, deposit]`, `[withdraw]` or `[redeem]`. Calldata must be exactly the canonical
 * encoding of what it decodes to: no trailing bytes, no stray bits in an address word.
 *
 * This is the rule of AGENTS.md / CONTRIBUTING.md that the relay refuses any destination outside
 * the registry, made executable. Paying an address other than the
 * connected account is refused here on purpose: that is what the prepare commands are for, with the
 * operator's own signer.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { erc4626Abi } from "../abi/erc4626.js";
import { isSupportedChainId } from "../client.js";
import { listVaults } from "../registry.js";
import type { VaultEntry } from "../registry-schema.js";

export interface GateCall {
  chainId: number;
  to: Address;
  data: Hex;
  value: string;
}

export interface Admitted {
  kind: "approve" | "deposit" | "withdraw" | "redeem";
  vault: VaultEntry;
  /** Raw units: the approved/deposited/withdrawn assets, or the redeemed shares. */
  amount: bigint;
}

/** Anything at or above this is an "unlimited" approval, which the gate never admits. */
const UNLIMITED = 2n ** 128n;

const same = (a: string, b: string) => getAddress(a) === getAddress(b);

/** The only batches the builders emit; anything else is refused whole. */
const SHAPES = new Set(["approve,deposit", "withdraw", "redeem"]);

export function admit(calls: GateCall[], account: Address): Admitted[] {
  if (calls.length === 0) throw new Error("refused: there is nothing to confirm");
  // The page switches the wallet to one chain for the whole batch, so a batch never spans two.
  if (calls.some((c) => c.chainId !== calls[0]!.chainId)) throw new Error("refused: the calls are on more than one chain");
  const vaults = listVaults();
  const out: Admitted[] = [];
  calls.forEach((c, i) => {
    const at = `call ${i + 1} of ${calls.length}`;
    if (!isSupportedChainId(c.chainId)) throw new Error(`refused (${at}): chain ${c.chainId} is not supported`);
    if (BigInt(c.value) !== 0n) throw new Error(`refused (${at}): it attaches native value, which no vault call needs`);
    let decoded: ReturnType<typeof decodeFunctionData<typeof erc4626Abi>>;
    try {
      decoded = decodeFunctionData({ abi: erc4626Abi, data: c.data });
    } catch {
      throw new Error(`refused (${at}): its calldata is not an approve, deposit, withdraw or redeem`);
    }
    const name = decoded.functionName;
    const args = (decoded.args ?? []) as readonly unknown[];
    // Decoding forgives trailing bytes and keeps only the low 20 bytes of an address word; the
    // wallet would sign the bytes as sent. Admit only calldata that is its own canonical encoding.
    const canonical = encodeFunctionData({ abi: erc4626Abi, functionName: name, args } as Parameters<typeof encodeFunctionData>[0]);
    if (canonical !== c.data) throw new Error(`refused (${at}): its calldata is not the canonical encoding of ${name} (trailing bytes, stray bits in an address, or hex not in lowercase)`);

    if (name === "approve") {
      const vault = vaults.find((v) => v.chainId === c.chainId && same(v.asset.address, c.to));
      if (!vault) throw new Error(`refused (${at}): approve on ${c.to}, which is not the asset of a listed vault on chain ${c.chainId}`);
      const [spender, value] = args as [Address, bigint];
      const target = vaults.find((v) => v.chainId === c.chainId && same(v.address, spender) && same(v.asset.address, c.to));
      if (!target) throw new Error(`refused (${at}): the approval goes to ${spender}, not to a listed vault for this asset`);
      if (value === 0n) throw new Error(`refused (${at}): an approval of 0`);
      if (value >= UNLIMITED) throw new Error(`refused (${at}): an unlimited approval`);
      out.push({ kind: "approve", vault: target, amount: value });
      return;
    }

    const vault = vaults.find((v) => v.chainId === c.chainId && same(v.address, c.to));
    if (!vault) throw new Error(`refused (${at}): ${c.to} is not a listed vault on chain ${c.chainId}`);
    if (name === "deposit") {
      const [assets, receiver] = args as [bigint, Address];
      if (assets === 0n) throw new Error(`refused (${at}): a deposit of 0`);
      if (!same(receiver, account)) throw new Error(`refused (${at}): the shares would go to ${receiver}, not the connected account ${account}`);
      out.push({ kind: "deposit", vault, amount: assets });
      return;
    }
    if (name === "withdraw" || name === "redeem") {
      const [amount, receiver, owner] = args as [bigint, Address, Address];
      if (amount === 0n) throw new Error(`refused (${at}): a ${name} of 0`);
      if (!same(receiver, account)) throw new Error(`refused (${at}): the funds would go to ${receiver}, not the connected account ${account}`);
      if (!same(owner, account)) throw new Error(`refused (${at}): it burns the shares of ${owner}, not the connected account ${account}`);
      out.push({ kind: name, vault, amount });
      return;
    }
    throw new Error(`refused (${at}): ${name} is not something this page hands to a wallet`);
  });

  // An approval only ever precedes the deposit it pays for: same vault, same amount, next call.
  out.forEach((a, i) => {
    if (a.kind !== "approve") return;
    const next = out[i + 1];
    if (!next || next.kind !== "deposit" || next.vault.address !== a.vault.address || next.amount !== a.amount) {
      throw new Error(`refused (call ${i + 1}): an approval must be followed by a deposit of exactly that amount into the same vault`);
    }
  });

  const shape = out.map((a) => a.kind).join(",");
  // With the pairing above, these shapes also mean one vault per batch.
  if (!SHAPES.has(shape)) throw new Error(`refused: ${shape} is not a batch this page confirms (only approve+deposit, withdraw, or redeem)`);
  return out;
}

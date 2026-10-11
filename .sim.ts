import { address } from "@solana/kit";
import { makeSolanaRpc } from "./src/solana/rpc.js";
import { decodeVaultState, decodeReserve } from "./src/solana/layout.js";
import { associatedTokenAccount, createAtaIdempotentIx, depositIx, withdrawIx, compileUnsigned, setComputeUnitLimitIx } from "./src/solana/kvault.js";
const rpc = makeSolanaRpc("https://api.mainnet-beta.solana.com");
const V = "8qV54zrW2piQgBbVaUUtGajf4KuVDKLUDquHv9VZBfS7";
const HOLDER = process.argv[2]!; const STRANGER = process.argv[3]!;
const b = async (a: string) => new Uint8Array(Buffer.from(((await rpc.getAccountInfo(address(a), { encoding: "base64" }).send()).value as any).data[0], "base64"));
const v = decodeVaultState(await b(V));
const rs = new Map(); for (const a of v.allocations) rs.set(a.reserve, decodeReserve(await b(a.reserve)));
const vr = v.allocations.map((a) => ({ reserve: a.reserve, lendingMarket: rs.get(a.reserve).lendingMarket }));
const common = { vaultState: V, tokenVault: v.tokenVault, tokenMint: v.tokenMint, baseVaultAuthority: v.baseVaultAuthority, sharesMint: v.sharesMint, vaultReserves: vr };
const { value: bh } = await rpc.getLatestBlockhash().send();
async function sim(label: string, user: string, ixs: any[]) {
  const tx = compileUnsigned(ixs, user, { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
  const r = await rpc.simulateTransaction(tx.base64 as never, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send();
  console.log(label, "bytes", tx.bytes, "err", JSON.stringify(r.value.err, (_, x) => typeof x === "bigint" ? x.toString() : x), "units", r.value.unitsConsumed, "\n  ", (r.value.logs ?? []).filter((l: string) => l.startsWith("Program log")).slice(-30).join("\n   "));
}
for (const user of [HOLDER, STRANGER]) {
  const uT = await associatedTokenAccount(user, v.tokenMint), uS = await associatedTokenAccount(user, v.sharesMint);
  const r0 = v.allocations[0]!.reserve, r = rs.get(r0);
  await sim(`deposit 0.01 as ${user === HOLDER ? "holder" : "stranger"}`, user, [setComputeUnitLimitIx(400_000), await createAtaIdempotentIx(user, v.sharesMint), await depositIx({ ...common, user, userTokenAta: uT, userSharesAta: uS, maxAmount: 10_000n })]);
  await sim(`withdraw shares as ${user === HOLDER ? "holder" : "stranger"}`, user, [setComputeUnitLimitIx(400_000), await withdrawIx({ ...common, user, userTokenAta: uT, userSharesAta: uS, sharesAmount: BigInt(process.argv[4] ?? "10000"), reserve: { reserve: r0, lendingMarket: r.lendingMarket, liquiditySupplyVault: r.liquiditySupplyVault, collateralMint: r.collateralMint } })]);
}

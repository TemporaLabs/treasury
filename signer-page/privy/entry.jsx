// The Privy side of signer-page. Bundled by build.mjs into ../vendor/privy-provider.js and loaded only
// when the opener is given --privy-app-id; the default page never loads it.
//
// What it does: mounts Privy's own login (email code, in Privy's modal), makes sure the user has an
// embedded wallet on Base, and hands the page an EIP-1193 provider for it. The page treats that provider
// exactly as it treats a browser extension's: it calls the same fixed list of methods and no others.
//
// What it must not do, and a test reads this file to check: hold or export a key, sign a message, or
// forward any wallet method that is not in ALLOWED. The list is enforced here as well as in the page, so
// a page bug cannot widen what the wallet is asked to do.
import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useWallets, useCreateWallet } from "@privy-io/react-auth";
import { base } from "viem/chains";

const ALLOWED = new Set([
  "eth_chainId", "eth_accounts", "eth_call", "eth_estimateGas", "eth_getTransactionCount",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBalance",
  "eth_requestAccounts", "wallet_switchEthereumChain", "eth_sendTransaction",
]);
const BASE_HEX = "0x" + base.id.toString(16);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });

// React owns the hooks, so a tiny component copies their current values here for the provider below.
const live = { privy: null, wallets: null, createWallet: null };
function Bridge() {
  live.privy = usePrivy();
  live.wallets = useWallets();
  live.createWallet = useCreateWallet().createWallet;
  return null;
}

async function until(test, ms, why) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const v = test();
    if (v) return v;
  }
  throw fail(4900, why);
}

export async function connectPrivy(appId) {
  const host = document.createElement("div");
  document.body.append(host);
  createRoot(host).render(
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        defaultChain: base,
        supportedChains: [base],
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
        appearance: { theme: "light" },
      }}
    >
      <Bridge />
    </PrivyProvider>,
  );
  await until(() => live.privy?.ready, 30_000, "Privy did not start. Check the app id, and that this page's origin is listed under allowed origins in the Privy dashboard.");

  let inner = null; //  the embedded wallet's own EIP-1193 provider, once there is one
  const handlers = []; // [event, fn] the page registered; attached to the wallet once it exists

  async function ensureWallet() {
    if (!live.privy.authenticated) {
      live.privy.login({ loginMethods: ["email"] });
      await until(() => live.privy.authenticated, 10 * 60_000, "login was not completed");
    }
    await until(() => live.wallets?.ready, 30_000, "Privy's wallets did not load");
    const find = () => live.wallets.wallets.find((w) => w.walletClientType === "privy");
    let wallet = find();
    if (!wallet) {
      await live.createWallet();
      wallet = await until(find, 30_000, "the wallet Privy created did not appear");
    }
    inner = await wallet.getEthereumProvider();
    for (const [ev, fn] of handlers) inner.on?.(ev, fn);
    return inner;
  }

  return {
    isPrivy: true,
    async request({ method, params }) {
      if (!ALLOWED.has(method)) throw fail(4200, `${method} is not something this page asks a wallet to do`);
      if (method === "eth_requestAccounts") {
        const p = await ensureWallet();
        // Signing and sending happen on Base only: make sure of that before the page asks for anything.
        if ((await p.request({ method: "eth_chainId" })) !== BASE_HEX) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_HEX }] });
        return p.request({ method: "eth_accounts" });
      }
      if (!inner) {
        if (method === "eth_accounts") return []; // not logged in yet: no accounts, as an extension that is not connected says
        throw fail(4100, "log in first");
      }
      return inner.request({ method, params });
    },
    on(ev, fn) { handlers.push([ev, fn]); inner?.on?.(ev, fn); },
    removeListener(ev, fn) { inner?.removeListener?.(ev, fn); },
  };
}

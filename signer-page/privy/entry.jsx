// The Privy side of signer-page. Bundled by build.mjs into ../vendor/privy-provider.js and loaded only
// when the opener is given --privy-app-id; the default page never loads it.
//
// What it does: mounts Privy's own login modal — email code, Google, or connecting an existing wallet
// (a browser extension, or WalletConnect's QR code for a phone wallet) — all inside Privy's own UI, and
// hands the page an EIP-1193 provider for whichever wallet results. If the login was email or Google and
// the person has no wallet yet, Privy creates an embedded one. The page treats the provider exactly as it
// treats a browser extension's: it calls the same fixed list of methods and no others.
//
// What it must not do, and a test reads this file to check: hold or export a key, sign a message, or
// forward any wallet method that is not in ALLOWED. The list is enforced here as well as in the page, so
// a page bug cannot widen what the wallet is asked to do.
import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useWallets, useCreateWallet } from "@privy-io/react-auth";
import { base } from "viem/chains";

// Every login method this page offers in Privy's modal, and the order they render in. `primary` (at most
// four) renders on the modal's first screen, together — email, Google, and (as wallet tiles, not a button
// that has to be clicked first) any wallet extension Privy detects installed, plus a WalletConnect QR
// option for one it did not — so there is no second click needed to find "connect a wallet" the way
// there was when this only listed an unordered `loginMethods` and let Privy's own default put it behind
// one. Each method must ALSO be turned on for this app in the Privy dashboard, or Privy refuses it there;
// this only limits and arranges what the modal is allowed to show.
const LOGIN_METHODS_AND_ORDER = { primary: ["email", "google", "detected_ethereum_wallets", "wallet_connect"] };

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
        loginMethodsAndOrder: LOGIN_METHODS_AND_ORDER,
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
      // No options here: `login()`'s own options only take an unordered `loginMethods`, which would
      // discard the provider's `loginMethodsAndOrder` above and put "connect a wallet" behind a second
      // click again. Calling it bare keeps the provider's arrangement.
      live.privy.login();
      await until(() => live.privy.authenticated, 10 * 60_000, "login was not completed");
    }
    await until(() => live.wallets?.ready, 30_000, "Privy's wallets did not load");
    // An external wallet (extension or WalletConnect's QR) is already in this list once connected — used
    // as-is, never re-wrapped as an embedded one.
    // Email or Google login carries no wallet yet, so one is created the first time.
    let wallet = live.wallets.wallets[0];
    if (!wallet) {
      await live.createWallet();
      wallet = await until(() => live.wallets.wallets[0], 30_000, "no wallet appeared for this login");
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
    // Not an EIP-1193 method — an extra the page calls directly, so whoever is logged in to Privy in this
    // browser can end that session and let someone else log in as themselves. Ends Privy's own session
    // (its cookie/storage, so a reload does not silently return as the same person) and drops the wallet
    // provider this bridge was holding; the next `eth_requestAccounts` starts over from `login()`.
    async logout() {
      inner = null;
      await live.privy.logout();
    },
  };
}

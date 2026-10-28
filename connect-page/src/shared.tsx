/**
 * What every view of the connect page shares: the flow's secret, the calls back to the local process, how a
 * wallet's error reads, and the page frame. The views live in main.tsx (sign-in, one confirmation) and plan.tsx
 * (a whole plan on one page).
 */
import React from "react";

export const secret = new URLSearchParams(location.search).get("s") ?? "";

export type WalletType = "external" | "embedded";

export async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> & { ok: boolean; reason?: string }> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: secret, ...body }) });
  return r.json();
}

export const reject = (reason: string, sent?: { hash: string; index: number }) => post("/result", { rejected: true, reason, ...sent }).catch(() => undefined);

export const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

export type Phase = { text: string; tone?: "ok" | "bad"; busy?: boolean; done?: boolean; retry?: boolean };

/** A wallet's "no": EIP-1193 code 4001, or the words wallets use for it. Nothing was sent. */
export const rejected = (e: unknown) => {
  const code = typeof e === "object" && e && "code" in e ? (e as { code: unknown }).code : undefined;
  return code === 4001 || code === "ACTION_REJECTED" || /user (rejected|denied|cancel+ed)|rejected the request|request rejected/i.test(errText(e));
};

/** Base58, as Solana writes signatures: the page needs only the encoder, so it carries one rather than a dependency. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Raw units as a person reads them: no trailing zeros, at most six decimals. */
export function fmt(raw: string | bigint, decimals: number): string {
  const v = BigInt(raw);
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** One centred column: a mark, what is being asked, and the one action. */
export function Page({ mark, title, lede, children }: { mark: React.ReactNode; title: string; lede: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="oat-wrap">
      <div className="oat-intro">
        <span className="oat-mark">{mark}</span>
        <h1 className="oat-h1">{title}</h1>
        <p className="oat-lede">{lede}</p>
      </div>
      {children}
    </main>
  );
}

export function Status({ phase }: { phase: Phase }) {
  return phase.text ? (
    <p className="oat-status" data-tone={phase.tone} aria-live="polite">
      {phase.text}
    </p>
  ) : null;
}

export const WalletMark = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1E3553" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17a2 2 0 0 1 2 2v1" />
    <rect x="4" y="8" width="16" height="11" rx="2.5" />
    <path d="M16 13.5h1.5" />
  </svg>
);

export const CheckMark = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1F7A4A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const ButtonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h2.5M10 5l3 3-3 3M13 8H6.5" />
  </svg>
);

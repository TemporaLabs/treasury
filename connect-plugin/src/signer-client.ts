import { signerUrl } from "./config.ts";
import type { Call } from "./decode.ts";

const SEND_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 30_000;
const REVOKE_TIMEOUT_MS = 15_000;

export type SendResult = { status: "submitted"; hash: string } | { status: "rejected"; reason: string };

// Asks the separately hosted signing service to sign one call for a delegated embedded wallet. The
// service enforces its own policy (approve/deposit/withdraw/redeem to the account only, capped);
// that is a backstop behind the confirmation page, not a replacement for it.
export async function sendViaSigner(call: Call, account: string, sessionToken: string): Promise<SendResult> {
  const base = signerUrl();
  if (!base) throw new Error("TREASURY_SIGNER_URL is not set — signing an embedded wallet needs the signing service's URL. Use switch_wallet and connect a wallet directly instead.");
  let res: Response;
  try {
    res = await fetch(`${base}/v1/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ account, chainId: 8453, call: { to: call.to, data: call.data, value: call.value ?? "0x0" } }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    return { status: "rejected", reason: `the signing service could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = (await res.json().catch(() => ({}))) as { hash?: unknown; error?: unknown };
  if (res.ok && typeof body.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.hash)) return { status: "submitted", hash: body.hash };
  return { status: "rejected", reason: `the signing service refused the call: ${typeof body.error === "string" ? body.error : `HTTP ${res.status}`}` };
}

export async function createSignerSession(accessToken: string, address: string): Promise<{ ok: true; token: string; account: string } | { ok: false; reason: string }> {
  const base = signerUrl();
  if (!base) return { ok: false, reason: "TREASURY_SIGNER_URL is not set, so signing an embedded wallet is not available. Connect a wallet directly instead." };
  let res: Response;
  try {
    res = await fetch(`${base}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken, address }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: `the signing service could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = (await res.json().catch(() => ({}))) as { token?: unknown; account?: unknown; error?: unknown };
  if (res.ok && typeof body.token === "string" && typeof body.account === "string") return { ok: true, token: body.token, account: body.account };
  return { ok: false, reason: `the signing service refused the sign-in: ${typeof body.error === "string" ? body.error : `HTTP ${res.status}`}` };
}

export async function revokeSigner(sessionToken: string): Promise<void> {
  const base = signerUrl();
  if (!base) return;
  try {
    await fetch(`${base}/v1/revoke`, { method: "POST", headers: { authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) });
  } catch {
    // Best effort: the local record is cleared either way.
  }
}

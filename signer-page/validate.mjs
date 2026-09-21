/**
 * The envelope check the sign page runs before it lets a wallet see anything, and `open.mjs` runs
 * before it serves the page at all. One module in both places on purpose: a poisoned envelope must
 * fail identically whether it is fed to the opener or pasted into a URL by hand.
 *
 * The page is the last thing between an agent's output and a wallet's confirm button. An agent can
 * be wrong, or prompted into being wrong, so the page trusts nothing in the envelope that it cannot
 * re-derive from the calldata, the registry it ships with, and the account the wallet proves. Only
 * four selectors are accepted, in four shapes, and every address the calldata names must be the
 * account or a registry vault. Anything else is a hard stop, not a warning.
 *
 * `description` is the agent's prose: it is carried through for display and never relied on.
 * `precondition` is not carried at all. It is derived here from the deposit's own calldata, so a
 * poisoned one has nothing to poison.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = "0x2105";
export const ALLOWANCE_SELECTOR = "0xdd62ed3e"; // allowance(address owner, address spender)

export const SELECTORS = {
  "0x095ea7b3": "approve", //  approve(address spender, uint256 amount)
  "0x6e553f65": "deposit", //  deposit(uint256 assets, address receiver)
  "0xb460af94": "withdraw", // withdraw(uint256 assets, address receiver, address owner)
  "0xba087652": "redeem", //   redeem(uint256 shares, address receiver, address owner)
};

/** The only sequences an envelope may be. Anything longer, shorter or mixed is refused. */
const SHAPES = new Set(["deposit", "approve,deposit", "withdraw", "redeem"]);
const WORDS = { approve: 2, deposit: 2, withdraw: 3, redeem: 3 };
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const MAX_DESCRIPTION = 400;

const lower = (a) => String(a).toLowerCase();

function word(data, i) {
  // ABI word i of the calldata after the 4-byte selector, lowercase hex without 0x.
  const start = 10 + i * 64;
  return data.slice(start, start + 64).toLowerCase();
}
function addressWord(data, i, what) {
  const w = word(data, i);
  // A real address word is 12 zero bytes then 20 address bytes. Anything in the top 12 bytes is
  // not an address a contract would accept, and not one a human read.
  if (!/^0{24}[0-9a-f]{40}$/.test(w)) throw new Error(`${what} is not a clean address word`);
  return "0x" + w.slice(24);
}
const uintWord = (data, i) => BigInt("0x" + word(data, i));

/** Decode one call into `{fn, ...args}`. Throws on anything outside the four selectors. */
export function decodeCall(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) throw new Error("calldata is not hex");
  const fn = SELECTORS[data.slice(0, 10).toLowerCase()];
  if (!fn) throw new Error(`selector ${data.slice(0, 10)} is not approve/deposit/withdraw/redeem`);
  if (data.length !== 10 + 64 * WORDS[fn]) throw new Error(`${fn} calldata has the wrong length`);
  if (fn === "approve") return { fn, spender: addressWord(data, 0, "approve spender"), amount: uintWord(data, 1) };
  if (fn === "deposit") return { fn, assets: uintWord(data, 0), receiver: addressWord(data, 1, "deposit receiver") };
  const amount = uintWord(data, 0);
  const receiver = addressWord(data, 1, `${fn} receiver`);
  const owner = addressWord(data, 2, `${fn} owner`);
  return fn === "withdraw" ? { fn, assets: amount, receiver, owner } : { fn, shares: amount, receiver, owner };
}

/** `allowance(owner, spender)` calldata, for the page's read before a deposit. */
export function allowanceCalldata(owner, spender) {
  return ALLOWANCE_SELECTOR + lower(owner).slice(2).padStart(64, "0") + lower(spender).slice(2).padStart(64, "0");
}

/**
 * Validate `{account, calls[]}` against a registry. Returns the calls in order, each carrying the
 * decoded arguments, the registry vault it concerns, and (for a deposit) the allowance read the
 * page must see satisfied first — or throws naming the first thing wrong. Never partial: one bad
 * call fails the whole envelope, because the calls are meant to be sent in order.
 */
export function validatePayload(payload, registry) {
  if (!payload || typeof payload !== "object") throw new Error("payload is not an object");
  const { account, calls } = payload;
  if (!ADDR.test(account ?? "")) throw new Error("payload.account is not an address");
  if (!Array.isArray(calls) || calls.length === 0) throw new Error("payload.calls is empty");
  if (calls.length > 2) throw new Error(`payload has ${calls.length} calls; a deposit is at most two (approve, deposit)`);

  const onBase = (registry?.vaults ?? []).filter((v) => v.chainId === BASE_CHAIN_ID);
  const vaults = new Map(onBase.map((v) => [lower(v.address), v]));
  const me = lower(account);

  const decoded = calls.map((c, i) => {
    const at = `call ${i + 1}`;
    if (!c || typeof c !== "object") throw new Error(`${at}: not an object`);
    if (c.chainId !== BASE_CHAIN_ID) throw new Error(`${at}: chainId ${c.chainId} is not Base (${BASE_CHAIN_ID})`);
    if (!ADDR.test(c.to ?? "")) throw new Error(`${at}: to is not an address`);
    if (c.value !== undefined && c.value !== "0x0" && c.value !== "0") throw new Error(`${at}: value must be 0`);
    if (c.description !== undefined && (typeof c.description !== "string" || c.description.length > MAX_DESCRIPTION)) {
      throw new Error(`${at}: description is not a string of at most ${MAX_DESCRIPTION} characters`);
    }
    return { ...c, decoded: decodeCall(c.data) };
  });

  const shape = decoded.map((c) => c.decoded.fn).join(",");
  if (!SHAPES.has(shape)) throw new Error(`the calls are [${shape}]; allowed sequences are ${[...SHAPES].map((s) => `[${s}]`).join(" ")}`);

  return decoded.map((c, i) => {
    const at = `call ${i + 1}`;
    const d = c.decoded;
    const to = lower(c.to);
    if ((d.assets ?? d.shares ?? d.amount) === 0n) throw new Error(`${at}: ${d.fn} amount is zero`);

    if (d.fn === "approve") {
      const vault = vaults.get(d.spender);
      if (!vault) throw new Error(`${at}: approve spender ${d.spender} is not a registry vault`);
      if (to !== lower(vault.asset.address)) throw new Error(`${at}: approve targets ${c.to}, which is not the asset of ${vault.symbol}`);
      // The next call must be the deposit this approve is for: same vault, exactly the approved amount.
      const next = decoded[i + 1].decoded;
      if (lower(decoded[i + 1].to) !== lower(vault.address) || next.assets !== d.amount) {
        throw new Error(`${at}: approve ${d.amount} is not exactly matched by a deposit of that amount into ${vault.symbol}`);
      }
      return { ...c, vault };
    }

    const vault = vaults.get(to);
    if (!vault) throw new Error(`${at}: ${d.fn} targets ${c.to}, which is not a registry vault`);
    if (d.receiver !== me) throw new Error(`${at}: ${d.fn} receiver ${d.receiver} is not the connected account ${account}`);
    if (d.owner !== undefined && d.owner !== me) throw new Error(`${at}: ${d.fn} owner ${d.owner} is not the connected account ${account}`);

    if (d.fn !== "deposit") return { ...c, vault };
    // A deposit waits on the allowance it will spend. Derived from the calldata, never taken from
    // the envelope: an envelope that carries a `precondition` must carry exactly this one.
    const precondition = { read: "allowance", contract: vault.asset.address, owner: account, spender: vault.address, minimum: d.assets.toString() };
    if (c.precondition !== undefined) {
      const p = c.precondition;
      const same = p && lower(p.contract) === lower(precondition.contract) && lower(p.owner) === me && lower(p.spender) === lower(vault.address) && p.read === "allowance" && String(p.minimum) === precondition.minimum;
      if (!same) throw new Error(`${at}: the envelope's precondition is not the allowance this deposit needs`);
    }
    return { ...c, vault, precondition };
  });
}

/**
 * "Follow the wallet" envelopes. An operator who has not chosen an account yet passes no --account:
 * the envelope was prepared for some account X, and the page re-aims it at whichever wallet the
 * operator connects, A. Only the words that name an account change (a deposit's receiver, a
 * withdrawal's receiver and owner), and they change to A, the signer, which is the same thing the
 * strict check demands. Everything else, the vault, the amounts and the approve, is untouched and
 * validated exactly as before. A redeem is one account's exact share balance, so it cannot follow.
 */
export function placeholderAccount(calls) {
  const seen = new Set();
  for (const c of calls ?? []) {
    const d = decodeCall(c?.data);
    for (const a of [d.receiver, d.owner]) if (a !== undefined) seen.add(a);
  }
  if (seen.size !== 1) throw new Error(`the calls name ${seen.size} different accounts; a follow-the-wallet envelope must name exactly one`);
  return [...seen][0];
}

export function validateFollow(payload, registry) {
  const out = validatePayload(payload, registry);
  if (out.some((c) => c.decoded.fn === "redeem")) {
    throw new Error("a redeem is one account's exact share balance, so it cannot follow the connected wallet; prepare it for that account and pass --account");
  }
  return out;
}

/** The envelope's calls with every account word set to `account`, then validated for it. Never partial. */
export function rebindPayload(payload, account, registry) {
  if (!ADDR.test(account ?? "")) throw new Error("the wallet's account is not an address");
  const pad = "0".repeat(24) + lower(account).slice(2);
  const calls = payload.calls.map((c) => {
    const d = decodeCall(c.data);
    if (d.fn === "redeem") throw new Error("a redeem cannot follow the connected wallet");
    if (d.fn === "approve") return { ...c };
    const words = c.data.slice(10).match(/.{64}/g);
    words[1] = pad; //                                     receiver
    if (d.fn === "withdraw") words[2] = pad; //             owner
    return { ...c, data: c.data.slice(0, 10) + words.join("") };
  });
  return validatePayload({ account, calls }, registry); // decoded, with each call's vault and the deposit's allowance read
}

/**
 * An optional second stage, `payload.then`: exactly one withdraw from the vault that was just deposited
 * into, for no more than was deposited. The page holds it back until the deposit has confirmed and then
 * offers it, so an operator can deposit and take money out in one sitting. It is validated by the same
 * rules as any other call (registry vault, receiver and owner are the account, nothing else), and it can
 * only follow a deposit, so it can never be the first thing an operator is asked to sign.
 */
export function validateThen(payload, registry, first) {
  if (payload.then === undefined) return [];
  const dep = first.find((c) => c.decoded.fn === "deposit");
  if (!dep) throw new Error("a follow-up withdrawal only follows a deposit");
  if (!Array.isArray(payload.then) || payload.then.length !== 1) throw new Error("the follow-up must be exactly one withdraw call");
  const out = validatePayload({ account: payload.account, calls: payload.then }, registry);
  const w = out[0];
  if (w.decoded.fn !== "withdraw") throw new Error("the follow-up must be a withdraw (a redeem is one account's exact share balance)");
  if (lower(w.vault.address) !== lower(dep.vault.address)) throw new Error("the follow-up withdraws from a different vault than the deposit");
  if (w.decoded.assets > dep.decoded.assets) throw new Error("the follow-up withdraws more than the deposit puts in");
  return out;
}

/** The follow-up re-aimed at `account`, exactly as `rebindPayload` does for the first stage. */
export function rebindThen(payload, account, registry, first) {
  if (payload.then === undefined) return [];
  const out = rebindPayload({ ...payload, calls: payload.then }, account, registry);
  return validateThen({ ...payload, account, then: out.map(({ decoded: _d, vault: _v, precondition: _p, ...c }) => c) }, registry, first);
}

/**
 * Manual mode: the operator types an amount and the page builds the calls. The builders below only
 * assemble calldata; the page then runs their output through `validatePayload` like any envelope, so a
 * mistake here cannot reach a wallet as anything the validator would refuse (a foreign vault, a
 * receiver that is not the connected account, an approve that is not exactly the deposit after it).
 */
export const BALANCE_OF_SELECTOR = "0x70a08231"; //       balanceOf(address)
export const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a"; // convertToAssets(uint256)
const hex64 = (n) => BigInt(n).toString(16).padStart(64, "0");
const addr64 = (a) => "0".repeat(24) + lower(a).slice(2);
export const balanceOfCalldata = (owner) => BALANCE_OF_SELECTOR + addr64(owner);
export const convertToAssetsCalldata = (shares) => CONVERT_TO_ASSETS_SELECTOR + hex64(shares);

/** A typed decimal amount as an integer in the token's smallest unit. Strict: digits, one point, no more places than the token has. */
export function parseAmount(text, decimals) {
  const t = String(text ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("enter an amount as digits, for example 25 or 0.5");
  const [whole, frac = ""] = t.split(".");
  if (whole.length > 15) throw new Error("that amount is too large");
  if (frac.length > decimals) throw new Error(`no more than ${decimals} decimal places`);
  const n = BigInt(whole + frac.padEnd(decimals, "0"));
  if (n === 0n) throw new Error("the amount must be more than zero");
  return n;
}

/**
 * The calls for one manual action, for `account`. `deposit` is [approve, deposit], or just [deposit]
 * when the allowance already covers it; `withdraw` is USDC out; `redeem` burns an exact share balance.
 */
export function buildManualCalls(kind, { vault, account, assets, shares, allowance = 0n }) {
  const call = (to, data) => ({ chainId: BASE_CHAIN_ID, to, data, value: "0x0" });
  if (kind === "deposit") {
    const dep = call(vault.address, "0x6e553f65" + hex64(assets) + addr64(account));
    if (BigInt(allowance) >= BigInt(assets)) return [dep];
    return [call(vault.asset.address, "0x095ea7b3" + addr64(vault.address) + hex64(assets)), dep];
  }
  if (kind === "withdraw") return [call(vault.address, "0xb460af94" + hex64(assets) + addr64(account) + addr64(account))];
  if (kind === "redeem") return [call(vault.address, "0xba087652" + hex64(shares) + addr64(account) + addr64(account))];
  throw new Error(`unknown action ${kind}`);
}

/** base64url of a UTF-8 JSON payload, shared by the opener (encode) and the page (decode). */
export function encodePayload(obj) {
  let bin = "";
  for (const b of new TextEncoder().encode(JSON.stringify(obj))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodePayload(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
}

/** What crosses into the URL: only what the page displays or checks. `step`, `of`, `gasAdvice` and `precondition` stay behind. */
export function slimPayload(account, calls) {
  return { account, calls: calls.map((c) => ({ chainId: c.chainId, to: c.to, data: c.data, value: c.value ?? "0x0", description: c.description })) };
}

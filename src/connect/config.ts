/**
 * Settings for `treasury connect`. Every value has a working default; each environment variable
 * here is optional and documented in docs/configuration.md.
 */

/**
 * The Privy app the sign-in page uses. A Privy app ID is a PUBLIC identifier — it ships inside the
 * page every browser downloads — so it is committed here. A fork or self-host can point at its own
 * Privy app with `PRIVY_APP_ID`. The app SECRET is never used anywhere in this package.
 */
export const DEFAULT_PRIVY_APP_ID = "cmubfegl2028d0ci3n0f2u6z5";

/**
 * The local ports the page may be served on, tried in this order. Privy accepts sign-in only from
 * origins listed in its dashboard, by exact string, so every one of them is listed there as
 * `http://localhost:<port>`. The first stays 53682, the only port earlier versions used, so an
 * operator who signed in before keeps the same origin. `TREASURY_CONNECT_PORT` replaces the list with
 * one port, which must then be listed in the Privy app's allowed domains.
 */
export const DEFAULT_CONNECT_PORTS: readonly number[] = [53682, 53683, 53684, 53685, 53686];

export const privyAppId = (): string => {
  const v = (process.env["PRIVY_APP_ID"] ?? "").trim();
  return v.length > 0 && !v.includes("${") ? v : DEFAULT_PRIVY_APP_ID;
};

export const connectPorts = (): readonly number[] => {
  const raw = (process.env["TREASURY_CONNECT_PORT"] ?? "").trim();
  const n = Number(raw);
  return raw.length > 0 && Number.isInteger(n) && n > 0 && n < 65536 ? [n] : DEFAULT_CONNECT_PORTS;
};

/** Where the session file lives; `TREASURY_CONNECT_HOME` moves it (tests use a temporary directory). */
export const connectHome = (): string | undefined => {
  const v = (process.env["TREASURY_CONNECT_HOME"] ?? "").trim();
  return v.length > 0 && !v.includes("${") ? v : undefined;
};

/** Set to anything to stop the CLI opening a browser itself (it prints the URL instead). */
export const noOpen = (): boolean => (process.env["TREASURY_CONNECT_NO_OPEN"] ?? "").trim().length > 0;

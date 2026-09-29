// Build-time-only shim. @walletconnect/keyvaluestorage's own Node storage backend lazily
// `require("unstorage")` / `require("unstorage/drivers/fs-lite")` — but wallet-session.ts always
// passes its own explicit `storage:` (a plain-file IKeyValueStorage, see FileKeyValueStorage
// there), so this path is never exercised at runtime. It still gets pulled into the bundle by
// static analysis, and unstorage's dynamic driver loading breaks esbuild's CJS-interop shim once
// bundled to ESM (measured: "Dynamic require of \"fs\" is not supported", live-tested against the
// real bundle — the unbundled TypeScript source, run directly, never hits it). A throwing stub
// costs nothing if the path is truly dead, and fails loudly rather than silently if it isn't.
const unreachable = () => {
  throw new Error("unstorage was stubbed out at build time — wallet-session.ts's own storage: option should make this unreachable");
};
export default { createStorage: unreachable };
export const createStorage = unreachable;

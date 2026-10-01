// Build-time-only shim. @walletconnect/keyvaluestorage's Node storage backend lazily
// `require("unstorage")` / `require("unstorage/drivers/fs-lite")`, but wallet-session.ts always
// passes its own explicit `storage:` (a plain-file store, see FileKeyValueStorage there), so this
// path is never exercised at runtime. It is still pulled into the bundle by static analysis, and
// unstorage's dynamic driver loading breaks esbuild's CJS-interop once bundled to ESM. A throwing
// stub costs nothing if the path is truly dead and fails loudly if it is not.
const unreachable = () => {
  throw new Error("unstorage was stubbed out at build time — wallet-session.ts's own storage: option should make this unreachable");
};
export default { createStorage: unreachable };
export const createStorage = unreachable;

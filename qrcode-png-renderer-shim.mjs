// qrcode/lib/server.js unconditionally `require("./renderer/png")` at module load, even though
// wallet-session.ts only ever calls `QRCode.toString(uri, { type: "terminal" })`. The PNG
// renderer's own `require("fs")` (for writing image files) hits the same esbuild CJS-interop
// limitation as the other shims in this file's directory — measured directly against the built
// bundle: "Dynamic require of \"fs\" is not supported", from inside renderQr() in
// wallet-session.ts, only reachable once a real WalletConnect pairing actually succeeds (nothing
// in this repo's test suite or earlier live checks had a real WALLETCONNECT_PROJECT_ID before now,
// so nothing ever reached this code path). This stub keeps the module's real export shape
// (`render`/`renderToDataURL`/`renderToFile` functions) so qrcode/lib/server.js's own requiring
// code still gets something callable — just one that fails loudly if the terminal-only path ever
// actually calls into it, which it doesn't.
const unreachable = () => {
  throw new Error("qrcode's PNG renderer was stubbed out at build time — only the terminal renderer is used here");
};
export const render = unreachable;
export const renderToDataURL = unreachable;
export const renderToFile = unreachable;
export const renderToFileStream = unreachable;
export default { render: unreachable, renderToDataURL, renderToFile, renderToFileStream };

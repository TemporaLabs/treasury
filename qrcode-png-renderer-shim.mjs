// Build-time-only shim. qrcode/lib/server.js unconditionally `require("./renderer/png")` at module
// load, though wallet-session.ts only ever calls `QRCode.toString(uri, { type: "terminal" })`. The
// PNG renderer's own `require("fs")` (for writing image files) hits the esbuild CJS-interop limit
// described in tsup.config.ts. This stub keeps the module's export shape (`render`,
// `renderToDataURL`, `renderToFile`) so qrcode's own requiring code still gets something callable,
// and fails loudly if the terminal-only path ever calls into it, which it does not.
const unreachable = () => {
  throw new Error("qrcode's PNG renderer was stubbed out at build time — only the terminal renderer is used here");
};
export const render = unreachable;
export const renderToDataURL = unreachable;
export const renderToFile = unreachable;
export const renderToFileStream = unreachable;
export default { render: unreachable, renderToDataURL, renderToFile, renderToFileStream };

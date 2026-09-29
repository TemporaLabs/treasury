// See unstorage-shim.mjs — same reasoning, for the "unstorage/drivers/fs-lite" driver specifically
// (its default export is a callable factory, a different shape than unstorage's own default).
export default () => {
  throw new Error("unstorage/drivers/fs-lite was stubbed out at build time — wallet-session.ts's own storage: option should make this unreachable");
};

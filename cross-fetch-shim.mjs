// Build-time-only shim: replaces `cross-fetch` in the bundled MCP servers with Node's own global
// fetch/Headers/Request/Response (native since Node 18, and this package targets Node 22+), in the
// exact shape cross-fetch's own node-ponyfill exports. cross-fetch's "main" entry pulls in
// node-fetch -> whatwg-url -> a runtime `require("punycode")` that esbuild's CJS-interop cannot
// satisfy once bundled into ESM output. Node's native fetch needs none of that dependency chain.
export const fetch = globalThis.fetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export default fetch;

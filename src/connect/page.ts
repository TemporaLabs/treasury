/**
 * The page shell both flows serve, and the browser bundle it loads.
 *
 * The bundle (`dist/connect-page.js`) is the React + Privy page built from `connect-page/` — one
 * Connect button, one Privy modal, and the confirm view. It sits beside the CLI bundle at runtime,
 * so it is found next to this module once bundled, and at `../../dist/` when run from source.
 *
 * The shell carries the visual tokens (temporalabs.com's palette) so the page is styled before the
 * bundle runs, and a CSP that admits exactly what Privy's modal needs and nothing else.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Privy's own hosts: its auth and embedded-wallet iframe, its RPC, and the Cloudflare check it uses. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "child-src https://auth.privy.io",
  "frame-src https://auth.privy.io https://challenges.cloudflare.com",
  "connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

const here = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));

export function readPageBundle(): Buffer {
  for (const rel of ["./connect-page.js", "../../dist/connect-page.js"]) {
    try {
      return readFileSync(new URL(rel, here));
    } catch {
      // try the next layout
    }
  }
  throw new Error("the connect page is not built (dist/connect-page.js is missing) — run `npm run build`");
}

/** The HTML shell. `secret` authorises every request the page makes back to this process. */
export function shell(secret: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { --ink:#22303F; --navy:#1E3553; --navy-700:#2A456A; --steel:#465569; --slate:#5F6B7B; --paper:#FFFFFF; --ground:#F3F6F9;
    --hair:rgba(34,48,63,.12); --blue:#76A6D5; --lavender:#B9A7D6; --grey:#B2B2B2; --ok:#2E8B57; --bad:#B4362A; --warn:#8A5A00; }
  html,body { margin:0; min-height:100%; color:var(--ink); font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  body { background:
    radial-gradient(ellipse 48% 60% at 72% 60%, rgba(255,255,255,.9), rgba(255,255,255,0) 72%),
    radial-gradient(ellipse 60% 75% at 0% 0%, rgba(118,166,213,.16), rgba(118,166,213,0) 70%),
    radial-gradient(ellipse 55% 65% at 100% 100%, rgba(185,167,214,.17), rgba(185,167,214,0) 70%),
    linear-gradient(90deg, #e9f1f9 0%, #eff1f6 50%, #efecf6 100%); min-height:100vh; }
  :focus-visible { outline:2px solid #266cad; outline-offset:2px; }
</style>
</head>
<body>
<div id="root"></div>
<script src="/app.js?s=${secret}"></script>
</body>
</html>
`;
}

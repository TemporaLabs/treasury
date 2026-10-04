/**
 * The page's styles, following temporalabs.com's visual system: Inter for text, IBM Plex Mono for
 * labels and addresses, steel headlines, navy actions, hairline cards on the light ground.
 *
 * Fonts are embedded (data: URLs from the two @fontsource packages) because the page's CSP admits no
 * font host: Google Fonts is not reachable from here by design.
 */
import inter from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2";
import plex400 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2";
import plex500 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2";

export const CSS = `
@font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(${inter}) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url(${plex400}) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 500; font-display: swap; src: url(${plex500}) format("woff2"); }

*, *::before, *::after { box-sizing: border-box; }
body { font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.55; color: var(--ink); }

/* One centred column, as a sign-in or consent screen reads: a mark, the ask, what it means, one action. */
.oat-wrap { max-width: 520px; margin: 0 auto; padding: clamp(48px, 14vh, 160px) 20px 64px; display: grid; gap: 20px; animation: oat-pop .75s cubic-bezier(.22, 1, .36, 1) both; }
@keyframes oat-pop { from { opacity: 0; transform: translateY(18px) scale(.98); filter: blur(5px); } to { opacity: 1; transform: none; filter: none; } }
@media (prefers-reduced-motion: reduce) { .oat-wrap { animation: none; } }

.oat-intro { display: grid; justify-items: center; text-align: center; gap: 0; margin-bottom: 8px; }
.oat-mark { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: #fff; border: 1px solid var(--hair);
  box-shadow: 0 1px 2px rgba(15, 35, 64, .04), 0 12px 32px -20px rgba(15, 35, 64, .22); margin-bottom: 24px; }
.oat-h1 { font-size: clamp(28px, 3.4vw, 36px); line-height: 1.12; letter-spacing: -.022em; font-weight: 600; color: var(--steel); margin: 0 0 10px; text-wrap: balance; }
.oat-lede { font-size: 17px; line-height: 1.5; color: var(--slate); margin: 0; max-width: 40ch; text-wrap: balance; }

/* The panel: what connecting means, or what a transaction does. */
.oat-panel { background: rgba(255, 255, 255, .88); border: 1px solid var(--hair); border-radius: 16px; padding: 22px 24px; display: grid; gap: 16px;
  box-shadow: 0 1px 2px rgba(15, 35, 64, .04), 0 12px 32px -20px rgba(15, 35, 64, .18); }
.oat-points { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; font-size: 15.5px; color: var(--ink); }
.oat-points li { display: grid; grid-template-columns: 18px 1fr; gap: 14px; align-items: start; }
.oat-points svg { margin-top: 3px; }

.oat-steps { list-style: none; margin: 0; padding: 0; display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; font-size: 14px; }
.oat-steps li { display: flex; gap: 8px; align-items: center; color: var(--slate); }
.oat-steps li[data-state="current"] { color: var(--ink); font-weight: 600; }
.oat-step-mark { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 600; border: 1px solid var(--hair); background: #fff; color: var(--slate); }
li[data-state="current"] .oat-step-mark { background: var(--navy); border-color: var(--navy); color: #fff; }
li[data-state="done"] .oat-step-mark { background: rgba(31, 122, 74, .12); border-color: transparent; color: var(--ok); }

.oat-btn { font: inherit; font-size: 16px; font-weight: 500; line-height: 1; width: 100%; padding: 18px 22px; border-radius: 12px; border: 1px solid var(--navy); background: var(--navy); color: #fff; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 10px; transition: background-color .2s; }
.oat-btn:hover:not(:disabled) { background: var(--navy-700); }
.oat-btn:disabled { opacity: .5; cursor: default; }
.oat-text { font: inherit; font-size: 15px; font-weight: 500; padding: 8px; border: 0; background: none; color: var(--slate); cursor: pointer; justify-self: center; }
.oat-text:hover:not(:disabled) { color: var(--ink); }
.oat-fine { font-size: 13.5px; line-height: 1.5; color: var(--slate); margin: 0; text-align: center; text-wrap: balance; }

/* The connected wallet: which kind it is, and its address in full. */
.oat-wallet { border: 1px solid var(--hair); border-radius: 16px; background: rgba(255, 255, 255, .88); padding: 18px 20px; display: grid; gap: 10px;
  box-shadow: 0 1px 2px rgba(15, 35, 64, .04), 0 12px 32px -20px rgba(15, 35, 64, .18); }
.oat-wallet-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.oat-label { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 11.5px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--slate); margin: 0; }
.oat-badge { font-size: 12.5px; font-weight: 500; line-height: 1; padding: 6px 10px; border-radius: 999px; }
.oat-badge[data-kind="embedded"] { background: rgba(185, 167, 214, .3); color: #4a3d6e; }
.oat-badge[data-kind="external"] { background: rgba(118, 166, 213, .26); color: var(--navy); }
.oat-addr { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 14px; line-height: 1.5; color: var(--ink); word-break: break-all; margin: 0; }
.oat-wallet-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: var(--slate); }
.oat-copy { font: inherit; font-size: 13px; font-weight: 500; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--hair); background: #fff; color: var(--ink); cursor: pointer; }

.oat-what { margin: 0; font-size: 15px; line-height: 1.5; color: var(--ink); overflow-wrap: anywhere; }
.oat-dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 0; font-size: 14px; }
.oat-dl dt { color: var(--slate); }
.oat-dl dd { margin: 0; color: var(--ink); min-width: 0; }
.oat-mono { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 13px; word-break: break-all; }
.oat-dl a { color: var(--navy); }

.oat-status { margin: 0; font-size: 14.5px; color: var(--slate); text-align: center; }
.oat-sent { list-style: none; padding: 0; display: grid; gap: 4px; }
.oat-status[data-tone="ok"] { color: var(--ok); }
.oat-status[data-tone="bad"] { color: var(--bad); }
`;

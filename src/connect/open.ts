/**
 * Opens a URL in the operator's browser. Refuses — returning false, so the caller prints the URL
 * instead — when there is evidently no browser to open: over SSH, on Linux with no display, or when
 * `TREASURY_CONNECT_NO_OPEN` is set.
 */
import { spawn } from "node:child_process";
import { noOpen } from "./config.js";

export function canOpenBrowser(): boolean {
  if (noOpen()) return false;
  if (process.env["SSH_CONNECTION"] || process.env["SSH_TTY"]) return false;
  if (process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"]) return false;
  return true;
}

export function openBrowser(url: string): boolean {
  if (!canOpenBrowser()) return false;
  try {
    // One literal program per platform: the boundary test pins what this file may start.
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], { stdio: "ignore", detached: true })
        : process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

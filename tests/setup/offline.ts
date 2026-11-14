/**
 * Every test starts offline and unconnected: an empty connect directory, so no test can act for a wallet connected on
 * the machine running it, and a Tempora API address on this machine's discard port, so a command that reaches for the
 * API is refused at once instead of reaching a real deployment. Both are ASSIGNED, never defaulted: a value exported in
 * the developer's shell is exactly the real wallet or API this exists to keep out. A test that needs its own value sets
 * it in its own `beforeEach` or inside the test, which run after this. No live or fork tier reads either variable; one
 * that ever needs a real endpoint must set it in its own hooks, on purpose.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const home = mkdtempSync(join(tmpdir(), "treasury-test-connect-"));
const offline = () => {
  process.env["TREASURY_CONNECT_HOME"] = home;
  process.env["TREASURY_API_URL"] = "http://127.0.0.1:9";
};
offline();
beforeEach(offline);
afterAll(() => rmSync(home, { recursive: true, force: true }));

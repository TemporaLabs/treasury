/**
 * THE BOUNDARY GATE.
 *
 * The first standing rule for this repo: the client knows nothing of the fund — the only
 * things it can see are what it pulls from an RPC and from the given smart contracts. Two earlier
 * changes removed every dependency on the fund's own tooling; this file is what stops one coming back. It is NOT a grep for
 * the string "FUND_" (a rename defeats that) and, since its first review, it is not a regex over
 * source text either.
 *
 * 🔴 WHY AN AST AND NOT A REGEX. Two reviewers broke the regex version three ways, and the three
 * share one root cause: anything not spelled as a literal-quoted `import`
 * statement is invisible to a text scan.
 *   · `import(`../../../fund/src/instance.js`)` — a TEMPLATE literal, not a quoted one: GREEN.
 *   · `require("../../../fund/…")` / `createRequire` — same blind spot.
 *   · `execFileSync("git", ["-C", fundRepo, "show", "<commit>:<path>"])` — reaches a whole checkout
 *     with no import a dependency check can see and no environment variable.
 *   · and the walked surface was only the runtime graph, so `scripts/` — where the old
 *     `FUND_REPO` + `git show` shape actually lived — was not audited at all.
 * So: the TypeScript compiler parses every audited file, and a specifier it cannot resolve to a
 * string constant is itself a failure. An unanalysable reach is not a pass.
 *
 * 🔴 AND THE ROOT OF THAT ROOT CAUSE — found in review, and it is the finding that shaped
 * this file: builtins were WHOLESALE EXEMPT from the allowlist (`if (spec.startsWith("node:") ||
 * builtins.has(spec)) return false`), so the dangerous ones had to be policed by hand-written
 * DENIALS — and a denial must enumerate every spelling (`child_process` vs `node:child_process`),
 * every AST node kind (a dynamic `import()` is not an `ImportDeclaration`), and every aliasing
 * path. Their measurement across nine reproductions by two reviewers: **denial rules 9 of 9
 * evaded, allowlist rules 0 of 9.** The two halves fail in opposite directions by construction.
 * So builtins are now under the SAME exact-membership allowlist as everything else — per file
 * where it matters — which is one rule instead of three and closes the tenth spelling nobody has
 * thought of (`node:worker_threads`, `node:vm`, `process.getBuiltinModule("child_process")`).
 *
 * ⚠️ AND THE INVERSION NEEDED ONE MORE STEP THAN THE ARGUMENT FOR IT DID: a module-level allowlist cannot say "this
 * export but not that one", and `node:module` is both the capability (`createRequire`) and the
 * need (`builtinModules`) — this very file imported it. So permitting the module for this file
 * would have permitted the factory, and two findings would have stayed open under a green table.
 * The fix is that classification is now by EXCLUSION — a specifier is a declared dependency, or on
 * the builtin allowlist, or a failure — which means `builtinModules` is not needed to ask "is this
 * a builtin?" at all. With that import deleted, `node:module` has zero legitimate importers and is
 * simply absent from every allowlist. No export-level rule, no dataflow tracking, and one rule
 * fewer: the hand-written `createRequire` denial this file used to carry is gone with it.
 *
 * 🔴 WHAT THIS GATE DOES NOT CLOSE, AND WHY THAT IS A BOUNDARY RATHER THAN A HOLE.
 * The threat model is the rule's own words — "a future session that does not know why it mattered" —
 * i.e. ACCIDENT AND DRIFT. It is not an adversary with commit access, and it structurally cannot
 * be: this gate lives inside the repo it guards, so anyone willing to write a reflection call to
 * evade it can, in the same commit and with less effort, delete the assertion or add themselves to
 * a table above. Hardening against that is impossible here, not merely hard.
 *
 * So: Node's REFLECTION surface reaches a builtin with no import of any kind —
 * `process.getBuiltinModule("child_process")` (Node 22, the version CI runs),
 * `process.binding(…)`, and whatever the next release adds. Both are treated as module reaches
 * below and therefore die on the allowlist — but that closes TWO KNOWN INSTANCES OF AN UNBOUNDED
 * CLASS, not the class. A future reflection API will not be caught, and no static rule in this file
 * can promise otherwise. Both reviewers reached this independently; one argued for documenting it rather than checking
 * it, on the grounds that a named check restores false confidence. The check is kept because it is
 * two lines and costs nothing — and this paragraph is the price of keeping it, so nobody reads a
 * green run as "the capability is unreachable" when it means "no ordinary route reaches it".
 *
 * Where the findings sort on that threat model — and the sort is the decision:
 *   ABOVE the line, closed here: the `scripts/` tree (literally where the dependency lived
 *   before), bare `"child_process"` (the commonest spelling in the ecosystem), a template-literal
 *   specifier, `createRequire`, a dynamic import. Every one of those is a plausible accident.
 *   BELOW it: reflection. Nobody reaches for `process.getBuiltinModule` by mistake. *
 * What is asserted:
 *   A. the RUNTIME graph from the real entry points stays inside `src/`, on declared dependencies;
 *   B. the ENVIRONMENT surface — the exact names any audited file READS, plus a live poisoning run
 *      so a RENAMED fund variable fails on the property rather than the prefix;
 *   C. the REGISTRY source — the shipped JSON, parsed with fund-shaped variables poisoned;
 *   D. ENZYME refused at build and at the MCP boundary;
 *   E. the AUDITED surface — every `.ts` under `src/`, `scripts/` and `tests/` (the rule's wording is
 *      "no code path, test, script, env var or doc"), including who may start a process and what.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { rpcUrlFromEnv } from "../src/client.js";
import { loadRegistry, getVault, depositableVaults } from "../src/registry.js";
import { buildDeposit, buildWithdraw } from "../src/build.js";
import { buildServer } from "../src/mcp/server.js";
import { FIXTURE, fixtureVault, useFixtureRegistry, useShippedRegistry } from "./fixtures/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const srcRoot = resolve(pkgRoot, "src");
const rel = (f: string) => relative(pkgRoot, f).split(sep).join("/");
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
// One manifest since the package IS the repository root: the same file supplies the runtime
// dependencies below and the devDependencies the tooling graph is checked against.
const rootPkg = pkg as { devDependencies?: Record<string, string> };

/** The two ways this package is entered: the library root, and the MCP server the plugin runs. */
const ENTRY_POINTS = ["src/index.ts", "src/mcp/server.ts"];

/** Variable names any audited file may READ. A write (the poisoning runs below) is not a read. */
// TREASURY_LOGS_FALLBACK: the event scan's fallback endpoint, or `off` to forbid the fallback
// entirely — an operator who may not reach a third party they did not name.
const ENV_READS_ALLOWED = ["BASE_RPC_URL", "TREASURY_FORK", "TREASURY_LOGS_FALLBACK", "TREASURY_LOGS_RPC_BASE", "TREASURY_RPC_BASE"];

/**
 * Files that may compute an env key instead of writing it literally, and every uppercase string
 * constant they contain (so a name moved out of the `candidates` array is still caught).
 */
const MAY_COMPUTE_ENV_KEY = ["src/client.ts", "tests/client.unit.test.ts"];

/**
 * The only files that may reach `node:child_process`, and the only programs they may start.
 * Exact membership, like the dependency assertion. A flat ban would be wrong — `roundtrip.ts`
 * legitimately spawns the MCP server over stdio — and a flat allow is the hole.
 */
/**
 * 🔴 BUILTINS ARE ALLOWLISTED, NOT DENIED. Normalised, so `x` and `node:x` are one entry. Anything
 * not listed — for any file, or for a file not named in the per-file map — is a failure. This is
 * the same exact-membership shape as the dependency assertion, which is the one rule in this file
 * no reviewer has evaded in nine attempts.
 */
const BUILTINS_ALLOWED = ["fs", "path", "url", "http", "util", "readline"];
const BUILTINS_ALLOWED_PER_FILE: Record<string, string[]> = {
  "scripts/roundtrip.ts": ["child_process"], //            spawns the MCP server under test, over stdio
  "tests/fork.test.ts": ["child_process"], //              spawns anvil; anvil holds the keys, this repo never does
  "tests/registry-check.chain.test.ts": ["child_process"], // runs scripts/registry-check.ts against a mock chain
  "tests/licence.unit.test.ts": ["crypto"], //             pins the sha256 of the canonical Apache-2.0 text
};

const MAY_SPAWN: Record<string, string[]> = {
  "scripts/roundtrip.ts": ["node", "npx"],
  "tests/fork.test.ts": ["anvil"],
  "tests/registry-check.chain.test.ts": ["npx"],
};

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

const eachNode = (sf: ts.SourceFile, fn: (n: ts.Node) => void) => {
  const walk = (n: ts.Node) => { fn(n); n.forEachChild(walk); };
  walk(sf);
};

/** Every module specifier a file reaches, and every one it reaches UNANALYSABLY. */
function moduleReaches(file: string): { specs: string[]; opaque: string[]; nonDeclaration: string[] } {
  const sf = parse(file);
  const specs: string[] = [];
  const opaque: string[] = [];
  /** Specifiers reached by something other than a readable import DECLARATION — a dynamic
   *  `import()`, a `require()`, an `import =`. For a guarded builtin these are unverifiable by
   *  construction: there is no named binding to check the call sites against. */
  const nonDeclaration: string[] = [];
  const take = (e: ts.Expression | undefined, what: string, declaration = true) => {
    if (!e) return;
    if (ts.isStringLiteral(e) || (ts.isNoSubstitutionTemplateLiteral(e))) {
      specs.push(e.text);
      if (!declaration) nonDeclaration.push(e.text);
    } else opaque.push(`${what}: ${e.getText(sf).slice(0, 60)}`);
  };
  eachNode(sf, (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) take(n.moduleSpecifier, "import/export");
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) take(n.moduleReference.expression, "import =", false);
    else if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword || callee === "require" || /\brequire$/.test(callee) || callee === "createRequire")
        take(n.arguments[0], callee === "createRequire" ? "createRequire" : "dynamic import/require", false);
      // Node 22: `process.getBuiltinModule("child_process")` reaches a builtin with no import at
      // all. Treated as a reach so the SAME allowlist governs it (a computed argument is opaque).
      // Matched on the PROPERTY NAME, not on the object's source text: `(process as any)
      // .getBuiltinModule(…)` is the same reach, and a cast defeats any pattern over the receiver.
      else if (ts.isPropertyAccessExpression(n.expression) && ["getBuiltinModule", "binding"].includes(n.expression.name.text))
        take(n.arguments[0], `${n.expression.name.text}()`, false);
    }
  });
  return { specs, opaque, nonDeclaration };
}

/** Modules a file reaches by a form that carries no checkable binding (dynamic, require, import =). */
const unreadableReaches = (file: string): string[] =>
  [...new Set(moduleReaches(file).nonDeclaration.filter((s) => !s.startsWith(".")).map(bare))];

/**
 * A specifier's BUILTIN identity, or null if it is not a builtin. `"child_process"` and
 * `"node:child_process"` are the same module to Node — measured, not read — so a rule that compares
 * against one spelling is not a rule about the module. Both membership rules below go through this; neither compares a raw string.
 */
const bare = (spec: string): string => spec.replace(/^node:/, "");

/** Every non-relative module a file reaches, normalised (`x` and `node:x` collapse). */
function modulesReached(file: string): Set<string> {
  return new Set(moduleReaches(file).specs.filter((s) => !s.startsWith(".")).map(bare));
}

const resolveTs = (from: string, spec: string): string | null => {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
  for (const cand of [`${base}.ts`, resolve(base, "index.ts")]) if (existsSync(cand)) return cand;
  return null;
};

/** Walk the runtime import graph from the entry points. */
function reachable(): { files: Set<string>; external: Set<string>; escapes: string[] } {
  const files = new Set<string>();
  const external = new Set<string>();
  const escapes: string[] = [];
  const queue = ENTRY_POINTS.map((p) => resolve(pkgRoot, p));
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const { specs, opaque } = moduleReaches(file);
    for (const o of opaque) escapes.push(`${rel(file)}: unanalysable module reach — ${o}`);
    for (const spec of specs) {
      if (!spec.startsWith(".")) { external.add(spec); continue; }
      const target = resolveTs(file, spec);
      if (!target) escapes.push(`${rel(file)} → ${spec} (does not resolve to a file in this package)`);
      else if (!target.startsWith(srcRoot + sep)) escapes.push(`${rel(file)} → ${spec} resolves OUTSIDE src/`);
      else queue.push(target);
    }
  }
  return { files, external, escapes };
}

/** Every `.ts` this repo ships or runs. */
function auditedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts")) out.push(full);
    }
  };
  for (const d of ["src", "scripts", "tests"]) walk(resolve(pkgRoot, d));
  return out.sort();
}

/** Names READ from process.env, and any access whose key is computed rather than literal. */
function envReads(file: string): { names: string[]; computed: string[] } {
  const sf = parse(file);
  const names: string[] = [];
  const computed: string[] = [];
  const isProcessEnv = (e: ts.Expression) => /^process\s*\.\s*env$/.test(e.getText(sf).replace(/\s+/g, " ").trim());
  eachNode(sf, (n) => {
    // a WRITE (`process.env.X = …`, `process.env["X"] = …`) is not a read
    const isWriteTarget = (node: ts.Node) =>
      node.parent && ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    if (ts.isPropertyAccessExpression(n) && isProcessEnv(n.expression)) {
      if (!isWriteTarget(n)) names.push(n.name.text);
    } else if (ts.isElementAccessExpression(n) && isProcessEnv(n.expression)) {
      if (isWriteTarget(n)) return;
      const arg = n.argumentExpression;
      if (ts.isStringLiteral(arg)) names.push(arg.text);
      else if (n.parent && ts.isDeleteExpression(n.parent)) return; // `delete process.env[k]` is a teardown, not a read
      else computed.push(arg.getText(sf).slice(0, 40));
    }
  });
  return { names, computed };
}

/** Uppercase string constants in a file — what an env name looks like wherever it is stored. */
function envLikeLiterals(file: string): string[] {
  const sf = parse(file);
  const out: string[] = [];
  eachNode(sf, (n) => {
    if (ts.isStringLiteral(n) && /^[A-Z][A-Z0-9_]{3,}$/.test(n.text)) out.push(n.text);
  });
  return out;
}

describe("A. the runtime module graph cannot leave this package", () => {
  const { files, external, escapes } = reachable();

  it("reaches a real graph (positive control — without this every assertion below is vacuous)", () => {
    expect(files.size).toBeGreaterThan(8);
    expect(external.size).toBeGreaterThan(3);
  });

  it("every module reach resolves INSIDE src/, and none is unanalysable", () => {
    expect(escapes).toEqual([]);
  });

  it("every external import is a DECLARED dependency or a node: builtin", () => {
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    // By EXCLUSION, so nothing is exempt: a specifier is a declared dependency, or it is on the
    // builtin allowlist, or it is a failure. There is no "is this a builtin in general?" question
    // any more — that question is what created the denial half.
    const undeclared = [...external].filter((s) => {
      const name = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]!;
      return !declared.has(name) && !BUILTINS_ALLOWED.includes(bare(s));
    });
    expect(undeclared).toEqual([]);
  });

  it("the dependency set is EXACTLY these three — membership, so a swap holding the count fails too", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@modelcontextprotocol/sdk",
      "viem",
      "zod",
    ]);
  });
});

describe("B. the environment surface, statically and at runtime", () => {
  it("the exact set of names the RUNTIME graph reads", () => {
    const names = new Set<string>();
    for (const f of reachable().files) {
      for (const n of envReads(f).names) names.add(n);
      // A file that reads through a computed key (`process.env[k]` over a candidate list) hides its
      // names from the access itself, so every env-shaped constant in it counts as a name it reads.
      // This is why moving a name out of the `candidates` array does not move it out of this set.
      if (MAY_COMPUTE_ENV_KEY.includes(rel(f))) for (const lit of envLikeLiterals(f)) names.add(lit);
    }
    expect([...names].sort()).toEqual(["BASE_RPC_URL", "TREASURY_LOGS_FALLBACK", "TREASURY_LOGS_RPC_BASE", "TREASURY_RPC_BASE"]);
  });

  it("a fund variable in the environment is not used, WHATEVER it is called — the property, not the prefix", () => {
    const saved = { ...process.env };
    try {
      for (const k of ["TREASURY_RPC_BASE", "TREASURY_LOGS_RPC_BASE", "TREASURY_LOGS_FALLBACK", "BASE_RPC_URL"]) delete process.env[k];
      // Three DISTINCT naming conventions, because the title's claim is "whatever it is called". A
      // mechanical rename once collapsed two of these into one line — the test still passed, and
      // proved one convention fewer than it said (caught in review of the public release).
      process.env["SIBLING_RPC_BASE"] = "https://sibling.example/KEY";
      process.env["FUND_RPC_BASE"] = "https://fund.example/KEY";
      process.env["RPC_URL"] = "https://generic.example/KEY";
      const url = rpcUrlFromEnv(8453); // a throw here fails the test, it does not pass it
      expect(url).toBe("https://mainnet.base.org");
      expect(url).not.toMatch(/sibling|fund|generic/i);
    } finally {
      for (const k of ["SIBLING_RPC_BASE", "FUND_RPC_BASE", "RPC_URL"]) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("C. the registry is a local file read with no network and no fund environment", () => {
  it("loads with every fund-shaped variable set to something that would break if it were used", () => {
    const saved = { ...process.env };
    try {
      process.env["FUND_REPO"] = "/nonexistent/fund";
      process.env["FUND_RPC_BASE"] = "not-a-url";
      process.env["FUND_REGISTRY"] = "/nonexistent/instance.json";
      const reg = loadRegistry();
      expect(reg.vaults.length).toBeGreaterThan(0);
      expect(JSON.stringify(reg)).not.toMatch(/sourceRef|instance\.json|lifecycle/i);
    } finally {
      for (const k of ["FUND_REPO", "FUND_RPC_BASE", "FUND_REGISTRY"]) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("C2. The test-only registry seam is unreachable from an installed package", () => {
  // `__setRegistryForTests` swaps where EVERY vault address comes from. It is unreachable today for
  // two independent reasons and, measured 2026-09-15, NEITHER was pinned: adding it
  // to index.ts's export line left the suite green. Both are asserted here, because either one
  // failing alone would be enough to expose it.
  const pkgJson = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as { exports?: Record<string, unknown> };

  it("it is not re-exported from the package entry point", () => {
    const index = readFileSync(resolve(pkgRoot, "src/index.ts"), "utf8");
    expect(index).not.toMatch(/__setRegistryForTests/);
  });

  it("and the exports map publishes ONE entry, so a deep import into src/registry.js cannot resolve", () => {
    // Without this, a consumer reaches the seam by path even though index.ts never names it.
    expect(Object.keys(pkgJson.exports ?? {})).toEqual(["."]);
  });

  it("CONTROL: the seam really is there to be reached — this test would be vacuous if the name were gone", () => {
    expect(readFileSync(resolve(pkgRoot, "src/registry.ts"), "utf8")).toMatch(/export function __setRegistryForTests/);
  });

  it("no SHIPPED source calls it — src/ and scripts/ only, since tests/ is where it belongs", () => {
    // Scoped to what ships: this test file names the function itself, and a check that counted its
    // own text would fail for the one reason that proves nothing.
    const shipped = auditedFiles().filter((f) => {
      const rel = relative(pkgRoot, f);
      return (rel.startsWith(`src${sep}`) || rel.startsWith(`scripts${sep}`)) && rel !== `src${sep}registry.ts`;
    });
    expect(shipped.length, "the filter must actually select files").toBeGreaterThan(5);
    expect(shipped.filter((f) => readFileSync(f, "utf8").includes("__setRegistryForTests")).map((f) => relative(pkgRoot, f))).toEqual([]);
  });
});

describe("D. Enzyme stays refused at BUILD — the boundary, not a note in a doc", () => {
  // A chassis with no ERC-4626 path is a code path, not a product offering: the shipped registry
  // need not carry such a vault for the refusal to be worth pinning. `fixtures/registry.ts` says why.
  beforeAll(() => useFixtureRegistry());
  afterAll(() => useShippedRegistry());
  const enzyme = () => fixtureVault(FIXTURE.enzyme);
  const ADDR = "0x000000000000000000000000000000000000dEaD" as const;

  it("buildDeposit and buildWithdraw both refuse it, naming the reason", () => {
    expect(() => buildDeposit(enzyme(), { assetsHuman: "1", receiver: ADDR, account: ADDR })).toThrow(/no ERC-4626 deposit\/redeem path/);
    expect(() => buildWithdraw(enzyme(), { assetsHuman: "1", receiver: ADDR, owner: ADDR })).toThrow(/no ERC-4626 deposit\/redeem path/);
  });

  it("the refusal survives the MCP boundary — no calls array reaches a caller", async () => {
    const tools = (buildServer() as unknown as { _registeredTools: Record<string, { handler: (a: unknown, b: unknown) => Promise<unknown> }> })._registeredTools;
    await expect(
      tools["earn_prepare_deposit"]!.handler({ vault: FIXTURE.enzyme, account: ADDR, receiver: ADDR, amount_usdc: "1" }, {}),
    ).rejects.toThrow(/no ERC-4626 deposit\/redeem path/);
  });

  it("and it is not in the depositable set", () => {
    expect(depositableVaults().map((v) => v.slug)).not.toContain(FIXTURE.enzyme);
    // The control: the same call DOES return the open fixtures, so "not in the set" is a fact about
    // this chassis and not about an empty set. (The SHIPPED registry's depositable set is asserted
    // in registry.test.ts, not here.)
    expect(depositableVaults().map((v) => v.slug)).toEqual(expect.arrayContaining([FIXTURE.morphoOpen, FIXTURE.morphoOpen2]));
  });
});

describe("E. the AUDITED surface is every .ts under src/, scripts/ and tests/", () => {
  const files = auditedFiles();

  it("the enumeration reaches what the runtime graph cannot see (positive control)", () => {
    expect(files.length).toBeGreaterThan(15);
    const names = files.map(rel);
    expect(names).toContain("scripts/registry-check.ts"); // the tree the round-1 finding was about
    expect(names).toContain("scripts/roundtrip.ts");
    expect(names.filter((n) => n.startsWith("tests/")).length).toBeGreaterThan(10);
  });

  it("no audited file reaches outside this package, and no reach is unanalysable", () => {
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(rootPkg.devDependencies ?? {})]);
    const bad: string[] = [];
    for (const f of files) {
      const { specs, opaque } = moduleReaches(f);
      for (const o of opaque) bad.push(`${rel(f)}: unanalysable module reach — ${o}`);
      for (const spec of specs) {
        if (spec.startsWith(".")) {
          const target = resolveTs(f, spec);
          if (!target || !target.startsWith(pkgRoot + sep)) bad.push(`${rel(f)} → ${spec} (escapes this package)`);
        } else {
          const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
          const allowed = [...BUILTINS_ALLOWED, ...(BUILTINS_ALLOWED_PER_FILE[rel(f)] ?? [])];
          if (!declared.has(name) && !allowed.includes(bare(spec)))
            bad.push(`${rel(f)} → ${spec} (neither a declared dependency nor an allowed builtin for this file)`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("no audited file READS a variable outside the allowed set, and only named files may compute a key", () => {
    const badNames: string[] = [];
    const badComputed: string[] = [];
    for (const f of files) {
      const { names, computed } = envReads(f);
      for (const n of names) if (!ENV_READS_ALLOWED.includes(n)) badNames.push(`${rel(f)} reads ${n}`);
      if (computed.length && !MAY_COMPUTE_ENV_KEY.includes(rel(f))) badComputed.push(`${rel(f)} computes an env key: ${computed.join(", ")}`);
      // In a file allowed to compute its key, EVERY env-shaped constant must be an allowed name —
      // so moving a name out of the `candidates` array does not move it out of this assertion.
      if (MAY_COMPUTE_ENV_KEY.includes(rel(f)))
        for (const lit of envLikeLiterals(f)) if (!ENV_READS_ALLOWED.includes(lit)) badNames.push(`${rel(f)} holds env-shaped constant ${lit}`);
    }
    expect(badNames).toEqual([]);
    expect(badComputed).toEqual([]);
  });

  it("only the named files may start a process, and only the named programs", () => {
    const spawners: string[] = [];
    const bad: string[] = [];
    for (const f of files) {
      if (!modulesReached(f).has("child_process")) continue; // either spelling, any reach form
      const sf = parse(f);
      const bindings: string[] = [];
      eachNode(sf, (n) => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && bare(n.moduleSpecifier.text) === "child_process") {
          const nb = n.importClause?.namedBindings;
          if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) bindings.push(el.name.text);
          if (nb && ts.isNamespaceImport(nb)) bindings.push(nb.name.text);
          if (n.importClause?.name) bindings.push(n.importClause.name.text);
        }
      });
      spawners.push(rel(f));
      if (unreadableReaches(f).includes("child_process"))
        bad.push(`${rel(f)} reaches "child_process" by a dynamic import or require — even on the allowlist, those call sites carry no binding this gate can check`);
      if (!bindings.length) {
        bad.push(`${rel(f)} reaches the "child_process" builtin without a readable named binding — the commands it starts cannot be checked`);
        continue;
      }
      const allowed = MAY_SPAWN[rel(f)];
      if (!allowed) continue; // caught by the membership assertion below
      eachNode(sf, (n) => {
        if (!ts.isCallExpression(n)) return;
        const callee = n.expression.getText(sf).split(".")[0]!;
        if (!bindings.includes(callee)) return;
        const arg = n.arguments[0];
        if (!arg || !ts.isStringLiteral(arg)) bad.push(`${rel(f)} starts a process with a computed command: ${arg?.getText(sf).slice(0, 40) ?? "(none)"}`);
        else if (!allowed.includes(arg.text)) bad.push(`${rel(f)} starts "${arg.text}" (allowed: ${allowed.join(", ")})`);
      });
    }
    expect(spawners.sort()).toEqual(Object.keys(MAY_SPAWN).sort());
    expect(bad).toEqual([]);
  });
});

/**
 * D. What gets published is what was attested.
 *
 * CI attests the COMMITTED `dist/mcp-server.mjs` — that path is the SLSA provenance subject, and
 * `verify_the_bundle.md` tells a stranger to check their download against it. But `prepack` fires on
 * `npm pack` AND `npm publish`, so a publish REBUILDS the bundle and ships whatever the publishing
 * machine produced, not the attested file. They agree only while the build is byte-deterministic,
 * which is a property of the toolchain rather than of this repository, and the disagreement is
 * silent because both artifacts are "the bundle".
 *
 * The hook cannot simply be removed: only `dist/*.mjs` is committed, so without a build the tarball
 * carries no `dist/index.js` or `dist/index.d.ts` and the manifest's own `main`/`types` point at
 * nothing. Measured on a clean checkout — the tarball contained exactly one file under dist/.
 *
 * So the hook stays and is made unable to change the attested bytes: it builds, then REFUSES if the
 * rebuild differs from what is committed.
 */
describe("D. what gets published is what was attested", () => {
  const PUBLISH_TIME_HOOKS = ["prepare", "prepack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish"];
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};

  it("prepack is the only publish-time hook", () => {
    expect(Object.keys(scripts).filter((s) => PUBLISH_TIME_HOOKS.includes(s))).toEqual(["prepack"]);
  });

  it("prepack cannot ship a bundle that differs from the attested committed one", () => {
    expect(scripts["prepack"]).toContain("git diff --exit-code -- dist/mcp-server.mjs");
  });
});

# 01: The CLI, commands and the response envelope

## One run, one JSON document

`src/cli.ts` is headless on purpose: an agent runs it, reads stdout, and nothing stays running.
`run(argv)` returns `{ stdout, stderr, code }` and never exits by itself, so tests drive it directly
(`tests/cli.unit.test.ts`). The entry guard `isEntryPoint` runs it only when this file is the one Node
was asked to run, compared by resolved path, so the published `bin` symlink works and a script that
merely imports the module does not run it (`tests/entrypoint.unit.test.ts`).

The words on the command line:

- **skill**: the first word. `SKILLS` in `src/cli.ts` maps each word to the function that builds its
  commands: `buildCommands` (`src/earn/commands.ts`) for `earn`, `buildConnectCommands`
  (`src/connect/commands.ts`) for `connect`.
- **command**: the second word. Commands are keyed by tool name, skill-prefixed (`earn_quote`), and
  `treasury earn quote` and `treasury earn prepare-deposit` both resolve, since hyphens become
  underscores. Lookup uses own keys only, so `earn constructor` reaches nothing inherited.
- **flags**: the command's argument names, in either spelling (`--amount_usdc`, `--amount-usdc`).

**Exit status.** 0 with the result on stdout; 1 with `{ "error": … }` on stderr when the command could
not run as asked. A verdict is a result: `earn status` reporting `WHITELIST_GATED` exits 0. Keep that
split when you add a command: a refusal the caller can act on is a field, not an exit code.

## How flags are parsed

`parseFlags` builds a `node:util` `parseArgs` option table from the command's zod schema. `kindOf`
looks through `optional`, `default` and pipes to find whether a flag is a string, a number or a
boolean switch. Three rules are worth knowing before you add a flag:

- **A repeated flag is refused.** Repeats are read from the parse tokens, because `parseArgs` keeps
  only the last value, and `--receiver A --receiver B` would otherwise silently mean B.
- **Numbers are whole numbers only**, checked before the schema runs.
- **The schema runs in strict mode**, so an unknown key is refused, and each issue is reported as
  `--flag: message`.

`--help` (alone after the command, or after the skill) prints each command's title, description and
flags, with the constraints read from the schema's JSON Schema (`describe`, `SCHEMA_KEYS`). So a
`describe()` on a zod field is user-facing documentation, and `llms.txt` is generated from it (see
[`../release/01-build-and-bundles.md`](../release/01-build-and-bundles.md)).

## Declaring a command

Inside `buildCommands` and `buildConnectCommands`, every command is one `register(name, meta,
handler)` call. `meta` is `{ title, description, inputSchema }` (the `Command` interface in
`src/earn/commands.ts`); the handler returns a JSON string.

Adding, removing or renaming a command is a contract change, checked three ways: the CI step that
runs the bundle and compares the exact command and flag set, the CI step that compares the skill's
command table in `plugin/skills/earn/SKILL.md` with `earn --help`, and `llms.txt`, which is rebuilt
from both. Update the skill in the same pull request.

## The helpers every earn response passes through

All in `src/earn/commands.ts`:

| helper | what it guarantees |
|---|---|
| `guarded` | wraps every handler: anything thrown is re-thrown with RPC endpoints masked (`redactEndpoints`, `src/redact.ts`), plus a setup hint when the failure looks like a transport failure on an unconfigured public endpoint |
| `text` | serialises a result; when the body shows a transport failure and no RPC is configured, adds a `setup_required` field naming the variable to set |
| `onItsChain` | runs the reads while checking the endpoint answers for the vault's chain, and reports a wrong-chain endpoint instead of the confusing "not a contract" errors it causes |
| `commitsMoney` | the one place the vault's `warning` is attached; deposits use it, withdrawals deliberately do not. `tests/commands.unit.test.ts` fails if any other line writes a `warning` field |
| `unsigned` | the PREPARE envelope: `requires_signature: true`, `status: "unsigned"`, the chain first, the warning, `next_step`, `signer_rules` and the calls |
| `SIGNER_RULES` | what a signer must do for the calls to land exactly once; stated with every build because nothing here signs |

Secrets: before any handler runs, `registerSecretSource(resolvedRpcSecrets)` tells the redactor which
URL values are secret, so a keyed URL is masked even inside a provider's own error body. `run` in
`src/cli.ts` registers it again before anything can print, since a usage error echoes what was typed.
What the redaction promises is in [`../../security-model.md`](../../security-model.md).

## One argument vocabulary

The header of `src/earn/commands.ts` states the contracts that are easy to erode:

- the address argument is `account` everywhere; `receiver` is distinct because it is where money
  lands;
- every command that takes `vault` also takes `chain`, and the two are settled together by
  `resolveVault` / `resolveAnyVault` (see [`../registry/01-the-vault-registry.md`](../registry/01-the-vault-registry.md));
- every response that names a vault says which chain it is on (`onChain`, `onSolana`).

Addresses parse as either family (`addressArg`), because which family a command needs is known only
after the vault resolves; each branch then checks its own (`evm` in `src/earn/commands.ts`,
`solanaAccount` in `src/earn/solana.ts`).

## The pointer to the guide

`treasury --help` and each skill's `--help` carry a `guide` field (`guidePointer`, `src/guide.ts`)
naming `llms.txt` beside the CLI and its URL at this version's tag. The plugin's copy omits it,
recognised by the plugin manifest at its root, because the plugin already loads the same text as the
Earn skill.

## Errors that tell the caller what to do

Every refusal names the reason and the next step: `resolveVault` says which chain a vault is on and
which vaults the named chain has; `parseFlags` lists the command's flags and which ones are
switches. Follow the same pattern in a new error, and never let a failure render as an empty
result.

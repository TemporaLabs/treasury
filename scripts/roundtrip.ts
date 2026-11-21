/**
 * The allocate → deallocate round trip used to be driven here through the `treasury earn` commands, stopping where
 * the skill stops: at unsigned calls, which it decoded and checked independently of the CLI.
 *
 * On the EVM chains that path is gone. The earn commands now reach the Tempora API, which prepares each deposit and
 * withdrawal as a request for the CONNECTED wallet: reading a position, quoting and preparing all need a wallet
 * connected with `treasury connect wallet` and signed in to the API (a page in the operator's browser), and a prepared
 * deposit's second step exists only once the first has been sent from that wallet and its hash handed back. A harness
 * that runs unattended, and never sends, cannot drive that; and every step the API returns is already held by
 * `checkSteps` inside the commands, which the unit tier proves (`tests/earn-api.unit.test.ts`,
 * `tests/connect-api.unit.test.ts`). So this script refuses, and says how to run the round trip by hand.
 *
 * It never signs, sends, reads a key, or defaults a destination, and it does not start a request at the API.
 */

const steps = [
  "treasury connect wallet                                   # once: the operator connects and signs in",
  "treasury earn vaults                                      # the vault ids the Tempora API lists",
  "treasury earn terms --vault <id>                          # show the terms; note terms.sha256",
  "treasury earn quote --vault <id> --direction deposit --amount_usdc <amount>",
  "treasury earn prepare_deposit --vault <id> --amount_usdc <amount> --terms_sha256 <sha256>",
  "  send step 1 from the connected wallet, then:",
  "treasury earn submit --request_id <id> --step_id <step> --tx_hash <hash>",
  "treasury earn request --request_id <id>                   # until step 2 is ready; send it, submit it",
  "treasury earn balance --vault <id>",
  "treasury earn prepare_withdraw --vault <id> --all          # then send, submit and read it the same way",
  "  or, on one page in the browser: treasury connect deposit … / treasury connect withdraw …",
];

console.error(
  [
    "roundtrip: on the EVM chains the earn commands go through the Tempora API, for the connected wallet, so this",
    "unattended harness no longer applies. Run the round trip by hand:",
    "",
    ...steps.map((s) => `  ${s}`),
    "",
    "Nothing was prepared, sent or started.",
  ].join("\n"),
);
process.exit(2);

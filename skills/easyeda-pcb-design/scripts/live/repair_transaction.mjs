#!/usr/bin/env node

import { runTransactionCli } from "./lib/transaction_runner.mjs";

// Kept beside the executable entrypoint so repository contract lint can verify
// documented options while parsing remains shared with the route runner.
export const CLI_OPTIONS = [
  "--plan", "--output", "--execute", "--bridge-port", "--window-id", "--self-test",
];

await runTransactionCli("repair");

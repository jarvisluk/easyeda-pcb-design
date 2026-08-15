#!/usr/bin/env node

import { runTransactionCli } from "./lib/transaction_runner.mjs";
import { cliFailure, isMain } from "./lib/tool_runtime.mjs";

export const CLI_OPTIONS = [
  "--plan", "--output", "--execute", "--bridge-port", "--window-id", "--self-test", "--help", "-h",
];

if (isMain(import.meta.url)) {
  try {
    await runTransactionCli();
  } catch (error) {
    cliFailure(error, "easyeda-transaction-result");
  }
}

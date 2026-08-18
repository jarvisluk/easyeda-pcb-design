#!/usr/bin/env node

import { appendPlanToolFailure, runTransactionCli } from "./lib/transaction_runner.mjs";
import { cliFailure, isMain } from "./lib/tool_runtime.mjs";

export const CLI_OPTIONS = [
  "--plan", "--output", "--execute", "--bridge-port", "--window-id", "--self-test", "--help", "-h",
];

if (isMain(import.meta.url)) {
  const startedAt = new Date();
  try {
    await runTransactionCli();
  } catch (error) {
    await appendPlanToolFailure(process.argv.slice(2), error, startedAt, "easyeda_transaction.mjs");
    cliFailure(error, "easyeda-transaction-result");
  }
}

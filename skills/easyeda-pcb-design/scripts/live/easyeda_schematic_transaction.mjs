#!/usr/bin/env node

import { isMain, cliFailure } from "./lib/tool_runtime.mjs";
import {
  appendSchematicPlanFailure,
  runSchematicTransactionCli,
} from "./lib/schematic_transaction_runner.mjs";

const CLI_STARTED_AT = new Date();

if (isMain(import.meta.url)) {
  runSchematicTransactionCli().catch(async (error) => {
    await appendSchematicPlanFailure(
      process.argv.slice(2), error, CLI_STARTED_AT, "easyeda_schematic_transaction.mjs",
    ).catch(() => {});
    cliFailure(error, "easyeda-schematic-transaction");
  });
}

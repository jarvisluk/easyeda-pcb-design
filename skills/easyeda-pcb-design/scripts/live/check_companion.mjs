#!/usr/bin/env node

/**
 * Preflight for live EasyEDA work. Exit 0 only when easyeda-api skill appears
 * installed and easyeda-bridge reports an connected EDA window.
 *
 * Agents must run this before create/modify/audit. On failure: stop and do not
 * guess API signatures.
 */

import { pathToFileURL } from "node:url";

import { EXIT, checkCompanion, nonemptyString } from "../lib/audit_common.mjs";
import { appendToolFailureFromArgv, appendToolLogEntry } from "./lib/operation_log.mjs";
import { resolveOperationLogPath, writeNewJson } from "./lib/tool_runtime.mjs";

const DEFAULT_OUTPUT = "evidence/readbacks/companion-check.json";

function parseArgs(argv) {
  const options = { bridgePort: undefined, output: DEFAULT_OUTPUT, operationLog: undefined, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--bridge-port") {
      index += 1;
      if (index >= argv.length) throw new Error("--bridge-port requires a value");
      const port = Number(argv[index]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--bridge-port must be an integer from 1 to 65535");
      }
      options.bridgePort = port;
    } else if (option === "--output" || option === "--operation-log") {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      if (option === "--output") options.output = argv[index];
      else options.operationLog = argv[index];
    } else if (option === "--self-test") {
      options.selfTest = true;
    } else if (option === "--help" || option === "-h") {
      process.stdout.write(`Usage: node scripts/live/check_companion.mjs [--output FILE] [--operation-log FILE] [--bridge-port PORT] [--self-test]\n\nRun from the board project root. The default output is ${DEFAULT_OUTPUT}.\n`);
      process.exit(0);
    } else if (nonemptyString(option)) {
      throw new Error(`unknown option: ${option}`);
    }
  }
  return options;
}

async function main() {
  const startedAt = new Date();
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) {
      process.stdout.write(`${JSON.stringify({ status: "COMPANION_SELF_TEST_CLEAR" })}\n`);
      return;
    }
    const report = await checkCompanion({ bridgePort: options.bridgePort });
    const output = await writeNewJson(options.output, report);
    const endedAt = new Date();
    await appendToolLogEntry(resolveOperationLogPath(options.operationLog, options.output), {
      tool: "check_companion.mjs",
      gate: "COMPANION_READY",
      operation: "EasyEDA companion readiness preflight",
      outcome: "READ_ONLY",
      semanticReadback: report.ready ? "companion reported ready" : "companion did not report ready",
      startedAt,
      endedAt,
      attemptDisposition: report.ready ? "ACCEPTED" : "REJECTED",
      gateProgress: report.ready ? "CLOSED" : "BLOCKED",
      evidence: [output],
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ready ? EXIT.OK : EXIT.ERROR;
  } catch (error) {
    await appendToolFailureFromArgv(process.argv.slice(2), {
      tool: "check_companion.mjs", gate: "COMPANION_READY", startedAt, error,
      defaultOutput: DEFAULT_OUTPUT,
    }).catch(() => {});
    process.stderr.write(
      `${JSON.stringify(
        {
          ready: false,
          fabricationRelease: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = EXIT.ERROR;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

export { DEFAULT_OUTPUT, main, parseArgs };

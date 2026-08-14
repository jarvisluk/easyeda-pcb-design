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

function parseArgs(argv) {
  const options = { bridgePort: undefined, json: true };
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
    } else if (option === "--help" || option === "-h") {
      process.stdout.write(`Usage: node scripts/live/check_companion.mjs [--bridge-port PORT]\n`);
      process.exit(0);
    } else if (nonemptyString(option)) {
      throw new Error(`unknown option: ${option}`);
    }
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await checkCompanion({ bridgePort: options.bridgePort });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ready ? EXIT.OK : EXIT.ERROR;
  } catch (error) {
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

export { main, parseArgs };

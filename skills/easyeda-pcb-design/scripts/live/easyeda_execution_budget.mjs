#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  nonemptyString,
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
} from "../lib/audit_common.mjs";

const STOP = Object.freeze({
  RETRY: "STOPPED_RETRY_CEILING",
  GATE: "STOPPED_GATE_BUDGET_EXHAUSTED",
  NO_PROGRESS: "STOPPED_NO_GATE_PROGRESS",
  TOTAL: "STOPPED_BUDGET_EXHAUSTED",
  CONTINUE: "CONTINUE",
});

function usage() {
  return `Usage:
  node scripts/live/easyeda_execution_budget.mjs --budget FILE \\
    --operation-log FILE --output FILE [--evaluated-at ISO_TIMESTAMP]
  node scripts/live/easyeda_execution_budget.mjs --self-test

The checker is read-only. A STOPPED_* result is refusal evidence and exits 2.
CONTINUE exits 0. Tool/input errors exit 1. No result authorizes fabrication.
`;
}

function parseArgs(argv) {
  const options = { budget: null, operationLog: null, output: null, evaluatedAt: null, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--budget") options.budget = next();
    else if (option === "--operation-log") options.operationLog = next();
    else if (option === "--output") options.output = next();
    else if (option === "--evaluated-at") options.evaluatedAt = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!options.selfTest) {
    for (const field of ["budget", "operationLog", "output"]) {
      if (!options[field]) throw new Error(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
    }
  }
  return options;
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

function positiveDuration(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive duration in ms`);
  return Number(value);
}

function validateBudget(budget) {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    throw new Error("budget must be one JSON object");
  }
  if (budget.schemaVersion !== 1 || budget.kind !== "easyeda-execution-budget") {
    throw new Error("budget must be easyeda-execution-budget schemaVersion 1");
  }
  timestamp(budget.startedAt, "budget.startedAt");
  positiveDuration(budget.totalBudgetMs, "budget.totalBudgetMs");
  positiveDuration(budget.noGateProgressBudgetMs, "budget.noGateProgressBudgetMs");
  if (!Number.isInteger(budget.defaultAttemptLimit) || budget.defaultAttemptLimit < 1) {
    throw new Error("budget.defaultAttemptLimit must be a positive integer");
  }
  for (const [gate, duration] of Object.entries(budget.gateBudgetsMs || {})) {
    if (!nonemptyString(gate)) throw new Error("budget.gateBudgetsMs keys must be non-empty gate names");
    positiveDuration(duration, `budget.gateBudgetsMs.${gate}`);
  }
  for (const [family, limit] of Object.entries(budget.attemptLimits || {})) {
    if (!nonemptyString(family) || !Number.isInteger(limit) || limit < 1) {
      throw new Error("budget.attemptLimits must map non-empty families to positive integers");
    }
  }
}

function validateLog(log) {
  if (!log || typeof log !== "object" || Array.isArray(log) || log.schemaVersion !== 2) {
    throw new Error("operation log must use schemaVersion 2 timing telemetry");
  }
  if (!Array.isArray(log.entries)) throw new Error("operation log entries must be an array");
  for (const [index, entry] of log.entries.entries()) {
    timestamp(entry.startedAt, `entries[${index}].startedAt`);
    timestamp(entry.endedAt, `entries[${index}].endedAt`);
    if (!nonemptyString(entry.attemptFamily) || !Number.isInteger(entry.attemptIndex)) {
      throw new Error(`entries[${index}] lacks attemptFamily/attemptIndex`);
    }
    if (!nonemptyString(entry.transactionId) || !nonemptyString(entry.gate)) {
      throw new Error(`entries[${index}] lacks transactionId/gate`);
    }
    if (!["ACCEPTED", "REJECTED", "UNKNOWN", "READ_ONLY"].includes(entry.attemptDisposition)) {
      throw new Error(`entries[${index}] has invalid attemptDisposition`);
    }
    if (!["NO_CHANGE", "CLOSED", "BLOCKED"].includes(entry.gateProgress)) {
      throw new Error(`entries[${index}] has invalid gateProgress`);
    }
  }
}

function analyzeExecutionBudget(budget, log, evaluatedAt = new Date().toISOString()) {
  validateBudget(budget);
  validateLog(log);
  const now = timestamp(evaluatedAt, "evaluatedAt");
  const start = timestamp(budget.startedAt, "budget.startedAt");
  const entries = [...log.entries].sort(
    (first, second) => timestamp(first.endedAt, "endedAt") - timestamp(second.endedAt, "endedAt"),
  );
  const latestEnd = entries.length
    ? Math.max(now, timestamp(entries.at(-1).endedAt, "latest endedAt"))
    : now;
  const elapsedMs = Math.max(0, latestEnd - start);
  const attempts = new Map();
  const gateWindows = new Map();
  let lastProgressAt = start;
  for (const entry of entries) {
    const endedAt = timestamp(entry.endedAt, "entry.endedAt");
    const startedAt = timestamp(entry.startedAt, "entry.startedAt");
    const attemptKey = `${entry.attemptFamily}::${entry.attemptIndex}`;
    if (!attempts.has(attemptKey)) {
      attempts.set(attemptKey, {
        family: entry.attemptFamily,
        index: entry.attemptIndex,
        disposition: entry.attemptDisposition,
        transactionId: entry.transactionId,
      });
    } else if (entry.attemptDisposition !== "READ_ONLY") {
      attempts.get(attemptKey).disposition = entry.attemptDisposition;
    }
    const window = gateWindows.get(entry.gate) || { startedAt, endedAt };
    window.startedAt = Math.min(window.startedAt, startedAt);
    window.endedAt = Math.max(window.endedAt, endedAt);
    gateWindows.set(entry.gate, window);
    if (entry.gateProgress === "CLOSED") lastProgressAt = Math.max(lastProgressAt, endedAt);
  }
  const attemptsByFamily = new Map();
  for (const attempt of attempts.values()) {
    if (["READ_ONLY", "ACCEPTED"].includes(attempt.disposition)) continue;
    const indices = attemptsByFamily.get(attempt.family) || [];
    indices.push(attempt.index);
    attemptsByFamily.set(attempt.family, indices);
  }
  const reasons = [];
  for (const [family, indices] of attemptsByFamily) {
    const limit = budget.attemptLimits?.[family] ?? budget.defaultAttemptLimit;
    if (new Set(indices).size >= limit) {
      reasons.push({
        status: STOP.RETRY,
        reason: `${family} exhausted ${limit} rejected/unknown attempt(s)`,
        attemptFamily: family,
        limit,
      });
    }
  }
  for (const [gate, window] of gateWindows) {
    const limit = budget.gateBudgetsMs?.[gate];
    if (Number.isFinite(limit) && window.endedAt - window.startedAt >= limit) {
      reasons.push({
        status: STOP.GATE,
        reason: `${gate} exhausted its ${limit} ms gate budget`,
        gate,
        limit,
      });
    }
  }
  const noProgressMs = Math.max(0, latestEnd - lastProgressAt);
  if (noProgressMs >= budget.noGateProgressBudgetMs) {
    reasons.push({
      status: STOP.NO_PROGRESS,
      reason: `no gate closed for ${noProgressMs} ms`,
      limit: budget.noGateProgressBudgetMs,
    });
  }
  if (elapsedMs >= budget.totalBudgetMs) {
    reasons.push({
      status: STOP.TOTAL,
      reason: `total elapsed time ${elapsedMs} ms exhausted the task budget`,
      limit: budget.totalBudgetMs,
    });
  }
  const precedence = [STOP.RETRY, STOP.GATE, STOP.NO_PROGRESS, STOP.TOTAL];
  const status = precedence.find((candidate) => reasons.some((item) => item.status === candidate))
    || STOP.CONTINUE;
  return {
    schemaVersion: 1,
    kind: "easyeda-execution-budget-check",
    status,
    executeAllowed: status === STOP.CONTINUE,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    evaluatedAt: new Date(now).toISOString(),
    metrics: {
      elapsedMs,
      noGateProgressMs: noProgressMs,
      operationCount: entries.length,
      attemptCount: attempts.size,
      gateDurationsMs: Object.fromEntries(
        [...gateWindows].map(([gate, window]) => [gate, window.endedAt - window.startedAt]),
      ),
    },
    reasons,
  };
}

function selfTest() {
  const budget = {
    schemaVersion: 1,
    kind: "easyeda-execution-budget",
    startedAt: "2026-08-14T00:00:00.000Z",
    totalBudgetMs: 60_000,
    noGateProgressBudgetMs: 20_000,
    defaultAttemptLimit: 2,
    gateBudgetsMs: { ROUTING_CANARY_CLEAR: 30_000 },
    attemptLimits: {},
  };
  const entry = (overrides = {}) => ({
    id: "op-1",
    transactionId: "tx-1",
    gate: "ROUTING_CANARY_CLEAR",
    attemptFamily: "route-usb",
    attemptIndex: 1,
    startedAt: "2026-08-14T00:00:01.000Z",
    endedAt: "2026-08-14T00:00:02.000Z",
    durationMs: 1000,
    operation: "route plan",
    outcome: "COMMITTED",
    attemptDisposition: "ACCEPTED",
    gateProgress: "CLOSED",
    evidence: ["route.json"],
    semanticReadback: "saved/reopened route accepted",
    ...overrides,
  });
  const clear = analyzeExecutionBudget(
    budget,
    { schemaVersion: 2, appendOnly: true, entries: [entry()] },
    "2026-08-14T00:00:03.000Z",
  );
  if (clear.status !== STOP.CONTINUE || clear.executeAllowed !== true) {
    throw new Error("clear budget fixture did not allow continuation");
  }
  const retry = analyzeExecutionBudget(
    budget,
    {
      schemaVersion: 2,
      appendOnly: true,
      entries: [
        entry({ attemptDisposition: "REJECTED", gateProgress: "NO_CHANGE" }),
        entry({
          id: "op-2",
          transactionId: "tx-2",
          attemptIndex: 2,
          startedAt: "2026-08-14T00:00:03.000Z",
          endedAt: "2026-08-14T00:00:04.000Z",
          attemptDisposition: "REJECTED",
          gateProgress: "NO_CHANGE",
        }),
      ],
    },
    "2026-08-14T00:00:05.000Z",
  );
  if (retry.status !== STOP.RETRY || retry.executeAllowed !== false) {
    throw new Error("retry ceiling did not produce refusal evidence");
  }
  const noProgress = analyzeExecutionBudget(
    budget,
    { schemaVersion: 2, appendOnly: true, entries: [entry({ gateProgress: "NO_CHANGE" })] },
    "2026-08-14T00:00:25.000Z",
  );
  if (noProgress.status !== STOP.NO_PROGRESS) {
    throw new Error("no-progress budget did not stop execution");
  }
  process.stdout.write(`${JSON.stringify({ clear: clear.status, retry: retry.status, noProgress: noProgress.status })}\n`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) return selfTest();
    const budget = JSON.parse(await readFile(path.resolve(options.budget), "utf8"));
    const log = JSON.parse(await readFile(path.resolve(options.operationLog), "utf8"));
    const result = analyzeExecutionBudget(budget, log, options.evaluatedAt || new Date().toISOString());
    const output = resolveSafeOutputPath(options.output);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.executeAllowed ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, kind: "easyeda-execution-budget-check", fabricationRelease: false }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { STOP, analyzeExecutionBudget, parseArgs, validateBudget, validateLog };

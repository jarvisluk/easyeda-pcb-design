#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
} from "../lib/audit_common.mjs";
import { analyzeOperationLog } from "./easyeda_gate_ledger.mjs";
import { appendToolFailureFromArgv, appendToolLogEntry } from "./lib/operation_log.mjs";
import { resolveOperationLogPath } from "./lib/tool_runtime.mjs";

const DEFAULT_OUTPUT = "evidence/readbacks/execution-timing.json";

function usage() {
  return `Usage:
  node scripts/live/easyeda_execution_timing.mjs [--output FILE] [--operation-log FILE] \\
    [--task-started-at ISO_TIMESTAMP] [--evaluated-at ISO_TIMESTAMP]
  node scripts/live/easyeda_execution_timing.mjs --self-test

The reporter is read-only. It records and summarizes elapsed time but never
authorizes, blocks, stops, or limits PCB work. The default report is
evidence/readbacks/execution-timing.json. Input errors exit 1.
`;
}

function parseArgs(argv) {
  const options = {
    operationLog: null,
    output: DEFAULT_OUTPUT,
    taskStartedAt: null,
    evaluatedAt: null,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--operation-log") options.operationLog = next();
    else if (option === "--output") options.output = next();
    else if (option === "--task-started-at") options.taskStartedAt = next();
    else if (option === "--evaluated-at") options.evaluatedAt = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  return options;
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

function summarizeGroup(entries, field) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry[field];
    const group = groups.get(key) || {
      stepCount: 0,
      measuredDurationMs: 0,
      firstStartedAt: entry.startedAt,
      lastEndedAt: entry.endedAt,
      attempts: new Set(),
      dispositions: { ACCEPTED: 0, REJECTED: 0, UNKNOWN: 0, READ_ONLY: 0 },
      progress: { CLOSED: 0, BLOCKED: 0, NO_CHANGE: 0 },
    };
    group.stepCount += 1;
    group.measuredDurationMs += entry.durationMs;
    if (timestamp(entry.startedAt, "entry.startedAt") < timestamp(group.firstStartedAt, "group.firstStartedAt")) {
      group.firstStartedAt = entry.startedAt;
    }
    if (timestamp(entry.endedAt, "entry.endedAt") > timestamp(group.lastEndedAt, "group.lastEndedAt")) {
      group.lastEndedAt = entry.endedAt;
    }
    group.attempts.add(`${entry.attemptFamily}::${entry.attemptIndex}`);
    group.dispositions[entry.attemptDisposition] += 1;
    group.progress[entry.gateProgress] += 1;
    groups.set(key, group);
  }
  return Object.fromEntries(
    [...groups.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([key, group]) => [key, {
      ...group,
      attemptCount: group.attempts.size,
      attempts: undefined,
    }]),
  );
}

function analyzeExecutionTiming(log, options = {}) {
  const logCheck = analyzeOperationLog(log);
  if (logCheck.status !== "VERIFIED") {
    throw new Error(`operation log is not valid schemaVersion 2 timing telemetry: ${logCheck.reason}`);
  }
  const evaluatedAt = options.evaluatedAt || new Date().toISOString();
  const evaluatedMs = timestamp(evaluatedAt, "evaluatedAt");
  const entries = [...log.entries].sort((first, second) =>
    timestamp(first.startedAt, "entry.startedAt") - timestamp(second.startedAt, "entry.startedAt") ||
    timestamp(first.endedAt, "entry.endedAt") - timestamp(second.endedAt, "entry.endedAt")
  );
  const taskStartedAt = options.taskStartedAt || entries[0]?.startedAt || evaluatedAt;
  const taskStartedMs = timestamp(taskStartedAt, "taskStartedAt");
  if (taskStartedMs > evaluatedMs) throw new Error("taskStartedAt must not be after evaluatedAt");
  for (const [index, entry] of entries.entries()) {
    if (timestamp(entry.startedAt, `entries[${index}].startedAt`) < taskStartedMs) {
      throw new Error(`entries[${index}].startedAt precedes taskStartedAt`);
    }
    if (timestamp(entry.endedAt, `entries[${index}].endedAt`) > evaluatedMs) {
      throw new Error(`entries[${index}].endedAt is after evaluatedAt`);
    }
  }
  const closed = entries.filter((entry) => entry.gateProgress === "CLOSED");
  const lastClosedAt = closed.length ? closed.at(-1).endedAt : null;
  const measuredStepDurationMs = entries.reduce((sum, entry) => sum + entry.durationMs, 0);
  const attempts = new Set(entries.map((entry) => `${entry.attemptFamily}::${entry.attemptIndex}`));
  return {
    schemaVersion: 1,
    kind: "easyeda-execution-timing-report",
    status: "TIMING_RECORDED",
    controlsExecution: false,
    timeLimitsEnforced: false,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    taskStartedAt: new Date(taskStartedMs).toISOString(),
    evaluatedAt: new Date(evaluatedMs).toISOString(),
    summary: {
      totalElapsedMs: evaluatedMs - taskStartedMs,
      measuredStepDurationMs,
      stepCount: entries.length,
      attemptCount: attempts.size,
      gateCount: new Set(entries.map((entry) => entry.gate)).size,
      closedGateEventCount: closed.length,
      lastGateClosedAt: lastClosedAt,
      elapsedSinceLastGateClosureMs: evaluatedMs - timestamp(lastClosedAt || taskStartedAt, "last progress timestamp"),
    },
    byGate: summarizeGroup(entries, "gate"),
    byAttemptFamily: summarizeGroup(entries, "attemptFamily"),
    steps: entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      gate: entry.gate,
      attemptFamily: entry.attemptFamily,
      attemptIndex: entry.attemptIndex,
      operation: entry.operation,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      durationMs: entry.durationMs,
      outcome: entry.outcome,
      attemptDisposition: entry.attemptDisposition,
      gateProgress: entry.gateProgress,
    })),
    longestSteps: [...entries]
      .sort((first, second) => second.durationMs - first.durationMs)
      .slice(0, 10)
      .map((entry) => ({ id: entry.id, operation: entry.operation, gate: entry.gate, durationMs: entry.durationMs })),
    interpretation: "Elapsed time is observational telemetry only. Continue or stop based on design decisions, authorization, identity, rollback, readback, DRC, and gate evidence—not duration.",
  };
}

function entry(overrides = {}) {
  return {
    id: "step-1",
    operation: "route canary apply",
    transactionId: "tx-1",
    gate: "ROUTING_CANARY_CLEAR",
    attemptFamily: "route-usb",
    attemptIndex: 1,
    startedAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T12:00:00.000Z",
    durationMs: 43_200_000,
    attemptDisposition: "REJECTED",
    gateProgress: "NO_CHANGE",
    outcome: "COMMITTED",
    semanticReadback: "candidate rejected",
    recordedBy: "TOOL",
    tool: "self-test-tool.mjs",
    evidence: ["evidence/readbacks/step-1.json"],
    ...overrides,
  };
}

function selfTest() {
  const log = {
    schemaVersion: 2,
    appendOnly: true,
    entries: [
      entry(),
      entry({
        id: "step-2",
        transactionId: "tx-2",
        attemptIndex: 2,
        startedAt: "2026-08-14T12:00:00.000Z",
        endedAt: "2026-08-15T12:00:00.000Z",
        durationMs: 86_400_000,
        attemptDisposition: "ACCEPTED",
        gateProgress: "CLOSED",
      }),
    ],
  };
  const result = analyzeExecutionTiming(log, {
    taskStartedAt: "2026-08-14T00:00:00.000Z",
    evaluatedAt: "2026-08-16T00:00:00.000Z",
  });
  if (
    result.status !== "TIMING_RECORDED" || result.controlsExecution !== false ||
    result.timeLimitsEnforced !== false || result.summary.totalElapsedMs !== 172_800_000 ||
    result.summary.measuredStepDurationMs !== 129_600_000 || result.summary.attemptCount !== 2
  ) throw new Error("timing reporter did not preserve long-running step telemetry");
  if ("executeAllowed" in result || JSON.stringify(result).includes("STOPPED_")) {
    throw new Error("timing reporter emitted an execution decision or time-limit stop status");
  }
  process.stdout.write(`${JSON.stringify({ status: result.status, elapsedMs: result.summary.totalElapsedMs, controlsExecution: result.controlsExecution })}\n`);
}

async function main() {
  const startedAt = new Date();
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) return selfTest();
    const operationLogPath = resolveOperationLogPath(options.operationLog, options.output);
    const log = JSON.parse(await readFile(operationLogPath, "utf8"));
    const result = analyzeExecutionTiming(log, options);
    const output = resolveSafeOutputPath(options.output);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    const endedAt = new Date();
    await appendToolLogEntry(operationLogPath, {
      tool: "easyeda_execution_timing.mjs",
      gate: "EXECUTION_TIMING_RECORDED",
      operation: "operation-log timing summary",
      outcome: "READ_ONLY",
      semanticReadback: `${result.status}; summarized ${result.summary.stepCount} prior step(s); controlsExecution=false`,
      startedAt,
      endedAt,
      attemptDisposition: "READ_ONLY",
      gateProgress: "NO_CHANGE",
      evidence: [output],
    });
    process.stdout.write(`${JSON.stringify({ status: result.status, output, summary: result.summary })}\n`);
  } catch (error) {
    await appendToolFailureFromArgv(process.argv.slice(2), {
      tool: "easyeda_execution_timing.mjs", gate: "EXECUTION_TIMING_RECORDED", startedAt, error,
      defaultOutput: DEFAULT_OUTPUT,
    }).catch(() => {});
    process.stderr.write(`${JSON.stringify({ error: error.message, kind: "easyeda-execution-timing-report", fabricationRelease: false }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();

export { analyzeExecutionTiming, parseArgs };

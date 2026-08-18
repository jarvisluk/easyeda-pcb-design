import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveOperationLogPath } from "./tool_runtime.mjs";

const OUTCOMES = new Set([
  "COMMITTED",
  "NOT_COMMITTED",
  "COMMITTED_THEN_THREW",
  "UNKNOWN_TIMEOUT",
  "READ_ONLY",
]);
const DISPOSITIONS = new Set(["ACCEPTED", "REJECTED", "UNKNOWN", "READ_ONLY"]);
const GATE_PROGRESS = new Set(["NO_CHANGE", "CLOSED", "BLOCKED"]);

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function emptyOperationLog() {
  return { schemaVersion: 2, appendOnly: true, entries: [] };
}

function validateLogShape(log) {
  if (!log || typeof log !== "object" || Array.isArray(log)) {
    throw new Error("operation log must be a JSON object");
  }
  if (log.schemaVersion !== 2 || log.appendOnly !== true || !Array.isArray(log.entries)) {
    throw new Error("operation log must be schemaVersion 2 with appendOnly: true and entries[]");
  }
  const ids = new Set();
  for (const [index, entry] of log.entries.entries()) {
    if (!nonempty(entry?.id)) throw new Error(`operation log entries[${index}] lacks an id`);
    if (ids.has(entry.id)) throw new Error(`operation log contains duplicate entry id ${entry.id}`);
    ids.add(entry.id);
  }
  return log;
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`unable to lock operation log: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function loadOperationLog(file) {
  try {
    return validateLogShape(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyOperationLog();
    throw new Error(`unable to load operation log ${file}: ${error.message}`);
  }
}

function nextAttemptIndex(entries, attemptFamily) {
  return entries
    .filter((entry) => entry?.attemptFamily === attemptFamily)
    .reduce((maximum, entry) => Math.max(maximum, Number(entry.attemptIndex) || 0), 0) + 1;
}

function normalizeEntry(entry, log) {
  const startedAt = new Date(entry.startedAt);
  const endedAt = new Date(entry.endedAt);
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime())) {
    throw new Error("operation-log timestamps must be valid ISO-8601 values");
  }
  if (endedAt.getTime() < startedAt.getTime()) {
    throw new Error("operation-log endedAt must not precede startedAt");
  }
  const attemptFamily = nonempty(entry.attemptFamily) ? entry.attemptFamily : entry.tool;
  const normalized = {
    ...entry,
    id: nonempty(entry.id)
      ? entry.id
      : `${String(entry.tool || "tool").replace(/[^a-zA-Z0-9_-]+/g, "-")}-${endedAt.getTime()}-${randomUUID().slice(0, 8)}`,
    transactionId: nonempty(entry.transactionId)
      ? entry.transactionId
      : `${String(entry.tool || "tool").replace(/[^a-zA-Z0-9_-]+/g, "-")}-managed`,
    gate: nonempty(entry.gate) ? entry.gate : "TOOL_EXECUTION",
    attemptFamily,
    attemptIndex: Number.isInteger(entry.attemptIndex) && entry.attemptIndex > 0
      ? entry.attemptIndex
      : nextAttemptIndex(log.entries, attemptFamily),
    operation: entry.operation,
    outcome: entry.outcome || "READ_ONLY",
    semanticReadback: entry.semanticReadback,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    attemptDisposition: entry.attemptDisposition || "READ_ONLY",
    gateProgress: entry.gateProgress || "NO_CHANGE",
    evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
    recordedBy: "TOOL",
    tool: entry.tool,
  };
  for (const field of ["id", "transactionId", "gate", "attemptFamily", "operation", "semanticReadback", "tool"]) {
    if (!nonempty(normalized[field])) throw new Error(`operation-log entry requires ${field}`);
  }
  if (!OUTCOMES.has(normalized.outcome)) throw new Error(`invalid operation-log outcome ${normalized.outcome}`);
  if (!DISPOSITIONS.has(normalized.attemptDisposition)) {
    throw new Error(`invalid operation-log attemptDisposition ${normalized.attemptDisposition}`);
  }
  if (!GATE_PROGRESS.has(normalized.gateProgress)) {
    throw new Error(`invalid operation-log gateProgress ${normalized.gateProgress}`);
  }
  if (log.entries.some((item) => item.id === normalized.id)) {
    throw new Error(`operation log already contains entry id ${normalized.id}`);
  }
  return normalized;
}

async function appendToolLogEntry(file, entry) {
  const resolved = path.resolve(file);
  await mkdir(path.dirname(resolved), { recursive: true });
  const lockPath = `${resolved}.lock`;
  const lock = await acquireLock(lockPath);
  let temporary = null;
  try {
    const log = await loadOperationLog(resolved);
    const normalized = normalizeEntry(entry, log);
    const updated = { ...log, entries: [...log.entries, normalized] };
    temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, resolved);
    return { logPath: resolved, entry: normalized, entryCount: updated.entries.length };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

function operationLogPathFromArgv(argv, cwd = process.cwd(), defaultOutput = null) {
  const optionValue = (option) => {
    const index = argv.indexOf(option);
    return index >= 0 && nonempty(argv[index + 1]) ? argv[index + 1] : null;
  };
  try {
    return resolveOperationLogPath(
      optionValue("--operation-log"),
      optionValue("--output") || defaultOutput,
      cwd,
    );
  } catch {
    return null;
  }
}

async function appendToolFailureFromArgv(argv, {
  tool,
  gate = "TOOL_EXECUTION",
  startedAt,
  error,
  transactionId,
  attemptFamily,
  attemptIndex,
  defaultOutput,
} = {}) {
  const logPath = operationLogPathFromArgv(argv, process.cwd(), defaultOutput);
  if (!logPath) return null;
  const endedAt = new Date();
  return appendToolLogEntry(logPath, {
    tool,
    transactionId,
    gate,
    attemptFamily,
    attemptIndex,
    operation: `${tool} failed before producing an accepted report`,
    outcome: "READ_ONLY",
    semanticReadback: `tool error: ${error instanceof Error ? error.message : String(error)}`,
    startedAt,
    endedAt,
    attemptDisposition: "REJECTED",
    gateProgress: "BLOCKED",
    evidence: [],
  });
}

export {
  appendToolLogEntry,
  appendToolFailureFromArgv,
  emptyOperationLog,
  loadOperationLog,
  validateLogShape,
};

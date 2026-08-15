#!/usr/bin/env node

/**
 * Gate-ledger lint for live EasyEDA transactions.
 *
 * The gate sequences in references/workflows/live-build-gates.md are normative
 * prose. This script turns them into a checkable object so a skipped gate is
 * detectable instead of merely discouraged. It validates that:
 *
 *   1. the declared branch is known and its gates appear in canonical order;
 *   2. no gate is closed while an earlier required gate is still open;
 *   3. every closed gate binds at least one existing non-empty evidence file;
 *   4. a narrower scope does not claim gates beyond its terminal gate;
 *   5. the append-only operation log exists and is well formed.
 *
 * It reads files only. It never contacts EasyEDA and never closes a gate itself.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  existingArtifactPath,
  nonemptyString,
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
} from "../lib/audit_common.mjs";

const EXIT = Object.freeze({ OK: 0, ERROR: 1, BLOCKED: 2, UNVERIFIED: 3 });

// Canonical sequences copied from live-build-gates.md. That reference remains
// the authority for their meaning; keep this table in sync with it.
const BRANCH_GATES = Object.freeze({
  "new-construction": Object.freeze([
    "COMPANION_READY",
    "PROJECT_BOUND",
    "PRIMARY_FUNCTIONS_CONFIRMED",
    "SCHEMATIC_IDENTITY_STABLE",
    "SCHEMATIC_VERIFIED",
    "PCB_SYNC_MATCH",
    "ROUTING_CANARY_CLEAR",
    "FULL_ROUTING_CLEAR",
    "COPPER_CANARY_CLEAR",
    "DESIGN_CLOSURE",
  ]),
  "existing-schematic-modification": Object.freeze([
    "COMPANION_READY",
    "ACTIVE_SCHEMATIC_REVISION_BOUND",
    "ROLLBACK_EVIDENCE_VERIFIED",
    "PRE_EDIT_SCHEMATIC_CAPTURED",
    "BOUNDED_SCHEMATIC_TRANSACTION",
    "POST_EDIT_DELTA_VERIFIED",
    "SCHEMATIC_DRC_CLEAR",
    "HANDOFF_INVALIDATION_RECORDED",
    "SCHEMATIC_CLOSURE",
  ]),
  "existing-board-continuation": Object.freeze([
    "COMPANION_READY",
    "ACTIVE_PCB_AND_HANDOFF_BOUND",
    "PCB_SYNC_MATCH",
    "EXISTING_STATE_BASELINED",
    "FIRST_INCOMPLETE_GATE_IDENTIFIED",
    "CONTINUATION_CANARY_CLEAR",
    "INCOMPLETE_WORK_CLOSED",
    "DESIGN_CLOSURE",
  ]),
  "existing-board-repair": Object.freeze([
    "COMPANION_READY",
    "ACTIVE_REVISION_BOUND",
    "ROLLBACK_EVIDENCE_VERIFIED",
    "PRE_EDIT_SEMANTICS_CAPTURED",
    "BOUNDED_GEOMETRY_TRANSACTION",
    "POST_EDIT_SEMANTICS_MATCH",
    "REPAIR_DRC_CLEAR",
    "DESIGN_CLOSURE",
  ]),
  // Review writes nothing, so it has no mutation gates. It still needs a
  // truthful ledger: without this branch a read-only review would have to
  // mislabel itself as a repair that never happened.
  "read-only-review": Object.freeze([
    "COMPANION_READY",
    "ACTIVE_REVISION_BOUND",
    "REVIEW_SCOPE_BOUND",
    "EVIDENCE_INVENTORY_COMPLETE",
  ]),
});

// PCB_SYNC_MATCH has exactly one recognized substitute: the strict verified
// native-comparator false-negative result defined in live-build-gates.md.
const GATE_STATE_ALIASES = Object.freeze({
  PCB_SYNC_MATCH: Object.freeze(["PCB_SYNC_VERIFIED_CACHE_EXCEPTION"]),
});

// Gates that presuppose a bound project. Closing any of these means a project
// UUID exists and must be recorded; COMPANION_READY alone does not.
const PROJECT_BINDING_GATES = new Set([
  "PROJECT_BOUND",
  "ACTIVE_SCHEMATIC_REVISION_BOUND",
  "ACTIVE_PCB_AND_HANDOFF_BOUND",
  "ACTIVE_REVISION_BOUND",
]);

// The terminal gate is the last gate a transaction owns at this branch and
// scope. It has two independent uses: a narrower scope must not claim gates past
// its terminal, and completion is measured against it.
//
// Enumerate every valid pair. An absent pair is not a permissive default; it is
// a branch/scope contradiction, because a schematic-only scope cannot own board
// geometry gates and a pcb-only scope cannot own schematic-intent gates.
const SCOPE_TERMINAL_GATE = Object.freeze({
  "schematic-only": Object.freeze({
    "new-construction": "SCHEMATIC_VERIFIED",
    "existing-schematic-modification": "SCHEMATIC_CLOSURE",
    "read-only-review": "EVIDENCE_INVENTORY_COMPLETE",
  }),
  "pcb-only": Object.freeze({
    "new-construction": "DESIGN_CLOSURE",
    "existing-board-continuation": "DESIGN_CLOSURE",
    "existing-board-repair": "DESIGN_CLOSURE",
    "read-only-review": "EVIDENCE_INVENTORY_COMPLETE",
  }),
  "end-to-end": Object.freeze({
    "new-construction": "DESIGN_CLOSURE",
    "existing-schematic-modification": "SCHEMATIC_CLOSURE",
    "existing-board-continuation": "DESIGN_CLOSURE",
    "existing-board-repair": "DESIGN_CLOSURE",
    "read-only-review": "EVIDENCE_INVENTORY_COMPLETE",
  }),
});

// A pcb-only entry starts from an existing schematic, but its upstream gates are
// not exempt: it closes them by citing the bound handoff artifact as their
// evidence. That keeps one rule for every branch and makes inherited evidence
// visible in the ledger instead of turning an unclosed gate into a silent
// exemption.
//
// Completion is a second axis, independent of the integrity decision. A ledger
// can be honest bookkeeping for work that is only partly done, and that state
// must stay representable: if an honest early stop were indistinguishable from a
// failure, claiming false completion would become the rewarded strategy.
// Consumers that must not read partial work as closure check this field rather
// than the decision.
const COMPLETION = Object.freeze({
  COMPLETE: "COMPLETE",
  // Every owned gate except the terminal is closed. The closing audit runs in
  // this state legitimately, because that audit report is the terminal gate's
  // own evidence and cannot exist before it runs.
  TERMINAL_PENDING: "TERMINAL_PENDING",
  INCOMPLETE: "INCOMPLETE",
  // Integrity is too broken to say anything about completion.
  INDETERMINATE: "INDETERMINATE",
});

const SCOPES = Object.freeze(["schematic-only", "pcb-only", "end-to-end"]);
const CLOSED = "CLOSED";
const GATE_STATES = Object.freeze([CLOSED, "OPEN", "BLOCKED", "NOT_APPLICABLE"]);
const OPERATION_OUTCOMES = Object.freeze([
  "COMMITTED",
  "NOT_COMMITTED",
  "COMMITTED_THEN_THREW",
  "UNKNOWN_TIMEOUT",
  "READ_ONLY",
]);
const ATTEMPT_DISPOSITIONS = Object.freeze(["ACCEPTED", "REJECTED", "UNKNOWN", "READ_ONLY"]);
const GATE_PROGRESS = Object.freeze(["NO_CHANGE", "CLOSED", "BLOCKED"]);

function validTimestamp(value) {
  return nonemptyString(value) && Number.isFinite(Date.parse(value));
}

// Resolve the gates this transaction must settle to be complete: the canonical
// sequence truncated at the terminal gate for this branch and scope.
function ownedGateSequence(sequence, branch, scope) {
  if (!sequence || !branch || !scope) return null;
  const terminal = SCOPE_TERMINAL_GATE[scope]?.[branch];
  if (!terminal) return null;
  const terminalIndex = sequence.indexOf(terminal);
  if (terminalIndex < 0) return null;
  return { terminal, owned: sequence.slice(0, terminalIndex + 1) };
}

// Completion answers a different question from the integrity decision: not
// whether the bookkeeping is trustworthy, but whether the declared slice reached
// its end. Keeping the two separate is what lets an honest partial ledger stay
// honest instead of being pressured into overclaiming.
function analyzeCompletion(options) {
  const { sequence, branch, scope, byGate, integrityFailed } = options;
  const indeterminate = (reason) => ({
    state: COMPLETION.INDETERMINATE,
    terminalGate: null,
    ownedGates: [],
    remainingGates: [],
    reason,
  });
  if (integrityFailed) {
    return indeterminate(
      "gate bookkeeping integrity must clear before completion is meaningful",
    );
  }
  if (!sequence || !branch || !scope) {
    return indeterminate(
      "branch and scope must be valid before completion is meaningful",
    );
  }
  const resolved = ownedGateSequence(sequence, branch, scope);
  if (!resolved) {
    return indeterminate(
      "scope " + scope + " declares no terminal gate for branch " + branch,
    );
  }
  // NOT_APPLICABLE is a real disposition for an intermediate gate the design
  // genuinely does not have, so it counts as settled there. The terminal gate is
  // deliberately excluded: allowing NOT_APPLICABLE to settle it would let a
  // ledger declare completion by declaring its own endpoint irrelevant.
  const remaining = resolved.owned.filter((gate) => {
    const entry = byGate.get(gate);
    if (!entry) return true;
    if (entry.closed) return false;
    return !(entry.state === "NOT_APPLICABLE" && gate !== resolved.terminal);
  });
  let state;
  let reason;
  if (remaining.length === 0) {
    state = COMPLETION.COMPLETE;
    reason =
      "every gate owned by branch " +
      branch +
      " at scope " +
      scope +
      " is settled through " +
      resolved.terminal;
  } else if (remaining.length === 1 && remaining[0] === resolved.terminal) {
    state = COMPLETION.TERMINAL_PENDING;
    reason =
      "only the terminal gate " +
      resolved.terminal +
      " remains; a final audit report is that gate's own closing evidence";
  } else {
    state = COMPLETION.INCOMPLETE;
    reason =
      remaining.length +
      " gate(s) owned by this slice are unsettled, starting at " +
      remaining[0];
  }
  return {
    state,
    terminalGate: resolved.terminal,
    ownedGates: resolved.owned,
    remainingGates: remaining,
    reason,
  };
}

/**
 * Render the validated analysis as a human-readable status table.
 *
 * This exists because a hand-written closure summary is unverifiable prose: it
 * can cite an evidence file that does not exist, transcribe a gate state wrongly,
 * or omit the completion axis, and no check would notice. Deriving the table
 * from the same analysis object the JSON report carries makes the readable view
 * and the machine verdict impossible to disagree.
 *
 * It renders only what the analysis proved. Evidence paths come from the
 * resolved-artifact list, so a declared-but-missing artifact is reported as
 * missing rather than printed as if it were real. It adds no recommendation and
 * no readiness claim of its own.
 */
function renderMarkdown(report) {
  const analysis = report?.analysis;
  if (!analysis || typeof analysis !== "object") {
    throw new Error("cannot render markdown without a ledger analysis");
  }
  const lines = [];
  // Show paths relative to the ledger, and keep a relative form even when the
  // artifact sits above it. Printing an absolute path would leak the operator's
  // home directory into a document meant to be shared or committed.
  const relative = (target) => {
    if (!nonemptyString(target)) return null;
    const from = path.dirname(path.resolve(report.ledgerPath || "."));
    const rel = path.relative(from, target);
    return nonemptyString(rel) ? rel : target;
  };

  lines.push("# Gate ledger status");
  lines.push("");
  lines.push(
    "Generated by `easyeda_gate_ledger.mjs` from the validated ledger. " +
      notAFabricationReleaseMessage(),
  );
  lines.push("");

  lines.push("## Bound transaction");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push("| Branch | " + (analysis.branch || "_unresolved_") + " |");
  lines.push("| Scope | " + (analysis.scope || "_unresolved_") + " |");
  lines.push(
    "| Project UUID | " +
      (nonemptyString(analysis.projectUuid)
        ? "`" + analysis.projectUuid + "`"
        : "_not recorded_") +
      " |",
  );
  lines.push("| Ledger | `" + (relative(report.ledgerPath) || "?") + "` |");
  lines.push("| Generated | " + (report.generatedAt || "?") + " |");
  lines.push("");

  // Both axes are stated together and labelled, because integrity alone reads
  // like closure to a human skimming for a verdict.
  lines.push("## Decision");
  lines.push("");
  lines.push(
    "- Bookkeeping integrity: **" + (analysis.decision || "?") + "**",
  );
  lines.push("- Slice completion: **" + (analysis.completion || "?") + "**");
  const completionAnalysis = analysis.completionAnalysis || {};
  if (nonemptyString(completionAnalysis.reason)) {
    lines.push("- " + completionAnalysis.reason);
  }
  if (analysis.decision === "CLEARED" && analysis.completion !== "COMPLETE") {
    lines.push(
      "- A CLEARED ledger that is not COMPLETE is work in progress, not a closure.",
    );
  }
  lines.push("");

  const gates = Array.isArray(analysis.gates) ? analysis.gates : [];
  const owned = Array.isArray(completionAnalysis.ownedGates)
    ? completionAnalysis.ownedGates
    : [];
  const remaining = new Set(
    Array.isArray(completionAnalysis.remainingGates)
      ? completionAnalysis.remainingGates
      : [],
  );
  const byGate = new Map(gates.map((gate) => [gate.gate, gate]));
  // Walk the canonical sequence rather than the declared order so a gate the
  // ledger never mentioned still appears, instead of vanishing from the view.
  const order = owned.length
    ? owned
    : Array.isArray(analysis.canonicalSequence) && analysis.canonicalSequence.length
      ? analysis.canonicalSequence
      : gates.map((gate) => gate.gate);

  lines.push("## Gates");
  lines.push("");
  lines.push("| Gate | State | Evidence | Note |");
  lines.push("| --- | --- | --- | --- |");
  for (const name of order) {
    const entry = byGate.get(name);
    if (!entry) {
      lines.push(
        "| `" +
          name +
          "` | NOT RECORDED | _none_ | absent from the ledger" +
          (remaining.has(name) ? "; still owned by this slice" : "") +
          " |",
      );
      continue;
    }
    let state = entry.state || "?";
    if (entry.usedAliasState) state += " (recognized substitute)";
    const evidence = Array.isArray(entry.evidence?.resolved)
      ? entry.evidence.resolved.map((item) => "`" + (relative(item.resolved) || item.declared) + "`")
      : [];
    const missing = Array.isArray(entry.evidence?.missing)
      ? entry.evidence.missing
      : [];
    const notes = [];
    if (missing.length) {
      notes.push("declared but missing: " + missing.map((m) => "`" + m + "`").join(", "));
    }
    if (remaining.has(name)) notes.push("remaining in this slice");
    if (nonemptyString(entry.note)) notes.push(entry.note);
    lines.push(
      "| `" +
        name +
        "` | " +
        state +
        " | " +
        (evidence.length ? evidence.join("<br>") : "_none_") +
        " | " +
        (notes.length ? notes.join("; ") : "—") +
        " |",
    );
  }
  lines.push("");

  const extra = gates.filter((gate) => !order.includes(gate.gate));
  if (extra.length) {
    lines.push("## Gates outside this slice");
    lines.push("");
    for (const gate of extra) {
      lines.push("- `" + gate.gate + "` — " + (gate.state || "?"));
    }
    lines.push("");
  }

  if (Array.isArray(analysis.blocked) && analysis.blocked.length) {
    lines.push("## Blocking findings");
    lines.push("");
    for (const item of analysis.blocked) lines.push("- " + item);
    lines.push("");
  }
  if (Array.isArray(analysis.unverified) && analysis.unverified.length) {
    lines.push("## Unverified findings");
    lines.push("");
    for (const item of analysis.unverified) lines.push("- " + item);
    lines.push("");
  }

  if (remaining.size) {
    lines.push("## Remaining gates");
    lines.push("");
    for (const name of remaining) lines.push("- `" + name + "`");
    lines.push("");
  }

  const log = analysis.operationLog;
  if (log && typeof log === "object") {
    lines.push("## Operation log");
    lines.push("");
    lines.push("- Status: " + (log.status || "?"));
    if (Number.isFinite(log.entryCount)) {
      lines.push("- Entries: " + log.entryCount);
    }
    if (nonemptyString(log.reason)) lines.push("- " + log.reason);
    lines.push("");
  }

  if (Array.isArray(analysis.limitations) && analysis.limitations.length) {
    lines.push("## Limitations");
    lines.push("");
    // The stored limitations are hard-wrapped sentence fragments. Rendering one
    // bullet per fragment produces broken half-sentences, so join them back into
    // prose rather than reproducing the array shape.
    lines.push(analysis.limitations.join(" "));
    lines.push("");
  }

  return lines.join("\n");
}

function usage() {
  return [
    "Usage:",
    "  node scripts/live/easyeda_gate_ledger.mjs --ledger FILE [options]",
    "",
    "Options:",
    "  --ledger FILE          Gate ledger JSON for the current transaction",
    "  --require-gate GATE    Require this gate to be CLOSED (repeatable)",
    "  --output FILE          Relative JSON output path under cwd",
    "  --markdown FILE        Relative Markdown status path under cwd",
    "  --force                Overwrite an existing output file",
    "  --self-test            Run deterministic offline tests",
    "  --help                 Show this help",
    "",
    "Exit codes: 0=CLEARED, 1=error, 2=BLOCKED, 3=UNVERIFIED.",
    "",
    "Ledger fields: schemaVersion (1), branch, scope, projectUuid,",
    "operationLog (relative path), and gates[] entries of",
    "{ gate, state, evidence[] }.",
    "",
    "Branches: " + Object.keys(BRANCH_GATES).join(", ") + ".",
    "Scopes: " + SCOPES.join(", ") + ".",
    "A CLOSED gate requires at least one existing non-empty evidence artifact.",
    "",
    "Two independent axes are reported. decision (CLEARED/UNVERIFIED/BLOCKED) is",
    "bookkeeping integrity. completion (COMPLETE/TERMINAL_PENDING/INCOMPLETE/",
    "INDETERMINATE) is whether the declared branch and scope reached their",
    "terminal gate. CLEARED + INCOMPLETE is the honest state of work in progress,",
    "not a design closure; the exit code reflects integrity only.",
    "",
    "--markdown renders the same validated analysis as a readable status table.",
    "Use it instead of hand-writing a closure summary: a hand-written table can",
    "cite a missing artifact or transcribe a gate state wrongly, and nothing would",
    "catch it.",
    "",
    "This lint proves bookkeeping order and evidence existence only. It never",
    "proves that an artifact's content closes its gate, and it is not a",
    "fabrication release.",
    "",
  ].join("\n");
}

function requiredValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new Error(option + " requires a value");
  return argv[index + 1];
}

function parseArgs(argv) {
  const options = {
    ledger: undefined,
    requireGates: [],
    output: undefined,
    markdown: undefined,
    force: false,
    selfTest: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--ledger") {
      options.ledger = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--require-gate") {
      options.requireGates.push(requiredValue(argv, index, option));
      index += 1;
    } else if (option === "--output") {
      options.output = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--markdown") {
      options.markdown = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--force") {
      options.force = true;
    } else if (option === "--self-test") {
      options.selfTest = true;
    } else if (option === "--help" || option === "-h") {
      options.help = true;
    } else {
      throw new Error("unknown option: " + option);
    }
  }
  if (!options.help && !options.selfTest && !nonemptyString(options.ledger)) {
    throw new Error("--ledger is required");
  }
  options.requireGates = [
    ...new Set(options.requireGates.filter(nonemptyString)),
  ];
  return options;
}

/**
 * Validate the append-only operation log required by live-build-gates.md. A
 * duplicated entry id is the signature of an ad hoc narrative log rather than an
 * append-only record, and a timed-out write with no semantic readback is exactly
 * the state that silently produces duplicate primitives.
 */
function analyzeOperationLog(log, options = {}) {
  const base = { entryCount: 0, logPath: options.logPath || null };
  const reject = (reason, extra = {}) => ({
    ...base,
    status: "UNVERIFIED",
    reason,
    ...extra,
  });
  if (log === undefined) {
    return reject("no append-only operation log was supplied");
  }
  if (!log || typeof log !== "object" || Array.isArray(log)) {
    return reject("operation log must be a JSON object");
  }
  if (log.schemaVersion !== 2) {
    return reject(
      log.schemaVersion === 1
        ? "operation log schemaVersion 1 predates mandatory timing and attempt telemetry"
        : "operation log schemaVersion must be 2",
    );
  }
  if (log.appendOnly !== true) {
    return reject("operation log must declare appendOnly: true");
  }
  if (!Array.isArray(log.entries)) {
    return reject("operation log entries must be an array");
  }
  const entries = log.entries;
  const issues = [];
  const seenIds = new Set();
  const seenAttempts = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const prefix = "entries[" + index + "]";
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(prefix + " must be an object");
      continue;
    }
    if (!nonemptyString(entry.id)) {
      issues.push(prefix + ".id is required");
    } else if (seenIds.has(entry.id)) {
      issues.push(prefix + ".id duplicates an earlier entry id: " + entry.id);
    } else {
      seenIds.add(entry.id);
    }
    if (!nonemptyString(entry.operation)) {
      issues.push(prefix + ".operation is required");
    }
    for (const field of ["transactionId", "gate", "attemptFamily"]) {
      if (!nonemptyString(entry[field])) issues.push(prefix + "." + field + " is required");
    }
    if (!Number.isInteger(entry.attemptIndex) || entry.attemptIndex < 1) {
      issues.push(prefix + ".attemptIndex must be a positive integer");
    } else if (nonemptyString(entry.attemptFamily)) {
      const attemptKey = entry.attemptFamily + "::" + entry.attemptIndex;
      if (
        seenAttempts.has(attemptKey) &&
        seenAttempts.get(attemptKey) !== entry.transactionId
      ) {
        issues.push(prefix + " reuses attemptFamily/attemptIndex across transactions " + attemptKey);
      }
      seenAttempts.set(attemptKey, entry.transactionId);
    }
    if (!validTimestamp(entry.startedAt) || !validTimestamp(entry.endedAt)) {
      issues.push(prefix + ".startedAt and .endedAt must be valid timestamps");
    } else {
      const measuredDuration = Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
      if (measuredDuration < 0) issues.push(prefix + ".endedAt precedes .startedAt");
      if (!Number.isFinite(entry.durationMs) || entry.durationMs < 0) {
        issues.push(prefix + ".durationMs must be a non-negative number");
      } else if (Math.abs(entry.durationMs - measuredDuration) > 1) {
        issues.push(prefix + ".durationMs does not match timestamp duration");
      }
    }
    if (!ATTEMPT_DISPOSITIONS.includes(entry.attemptDisposition)) {
      issues.push(prefix + ".attemptDisposition must be one of " + ATTEMPT_DISPOSITIONS.join(", "));
    }
    if (!GATE_PROGRESS.includes(entry.gateProgress)) {
      issues.push(prefix + ".gateProgress must be one of " + GATE_PROGRESS.join(", "));
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.some((item) => !nonemptyString(item))) {
      issues.push(prefix + ".evidence must be an array of non-empty artifact paths");
    }
    if (!OPERATION_OUTCOMES.includes(entry.outcome)) {
      issues.push(
        prefix + ".outcome must be one of " + OPERATION_OUTCOMES.join(", "),
      );
    }
    if (
      entry.outcome === "UNKNOWN_TIMEOUT" &&
      !nonemptyString(entry.semanticReadback)
    ) {
      issues.push(
        prefix +
          " records a bridge timeout with no semanticReadback; a timed-out write leaves an unknown state and must be resolved by net/layer/geometry/designator readback before any retry",
      );
    } else if (
      entry.outcome !== "READ_ONLY" &&
      !nonemptyString(entry.semanticReadback)
    ) {
      issues.push(prefix + ".semanticReadback is required for a write attempt");
    }
  }
  if (issues.length) {
    return reject("operation log is malformed: " + issues.join("; "), {
      entryCount: entries.length,
      issues,
    });
  }
  return {
    ...base,
    status: "VERIFIED",
    reason: "operation log has " + entries.length + " well-formed entries",
    entryCount: entries.length,
  };
}

function resolveGateEvidence(entry, baseDir) {
  const candidates = Array.isArray(entry.evidence)
    ? entry.evidence
    : nonemptyString(entry.evidence)
      ? [entry.evidence]
      : [];
  const resolved = [];
  const missing = [];
  for (const candidate of candidates) {
    if (!nonemptyString(candidate)) {
      missing.push(String(candidate));
      continue;
    }
    const found = existingArtifactPath(candidate, { cwd: baseDir });
    if (found) resolved.push({ declared: candidate, resolved: found });
    else missing.push(candidate);
  }
  return { candidates, resolved, missing };
}

function analyzeLedger(ledger, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const requireGates = options.requireGates || [];
  const blocked = [];
  const unverified = [];

  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return {
      decision: "UNVERIFIED",
      completion: COMPLETION.INDETERMINATE,
      branch: null,
      scope: null,
      gates: [],
      closedGates: [],
      firstOpenGate: null,
      operationLog: analyzeOperationLog(undefined),
      blocked,
      unverified: ["gate ledger must be a JSON object"],
      completionAnalysis: analyzeCompletion({ integrityFailed: true }),
    };
  }
  if (ledger.schemaVersion !== 1) {
    unverified.push("ledger schemaVersion must be 1");
  }
  const branch = nonemptyString(ledger.branch) ? ledger.branch : null;
  const sequence = branch ? BRANCH_GATES[branch] : undefined;
  if (!sequence) {
    unverified.push(
      "ledger branch must be one of " + Object.keys(BRANCH_GATES).join(", "),
    );
  }
  const scope = nonemptyString(ledger.scope) ? ledger.scope : null;
  if (!scope || !SCOPES.includes(scope)) {
    unverified.push("ledger scope must be one of " + SCOPES.join(", "));
  }
  // The project UUID only exists once PROJECT_BOUND closes, so requiring it
  // unconditionally would deadlock the first gate of a from-zero build. Require
  // it exactly when the ledger claims a gate that depends on a bound project.
  const projectBindingClosed = (Array.isArray(ledger.gates) ? ledger.gates : []).some(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      PROJECT_BINDING_GATES.has(entry.gate) &&
      (entry.state === CLOSED ||
        (GATE_STATE_ALIASES[entry.gate] || []).includes(entry.state)),
  );
  // Any branch other than a from-zero build starts from an existing project, so
  // only new-construction may omit the UUID, and only before binding closes.
  const mayOmitProjectUuid =
    branch === "new-construction" && !projectBindingClosed;
  if (!mayOmitProjectUuid && !nonemptyString(ledger.projectUuid)) {
    unverified.push(
      "ledger projectUuid is required except before PROJECT_BOUND in a new-construction build",
    );
  }
  if (!Array.isArray(ledger.gates)) {
    unverified.push("ledger gates must be an array");
  }

  const rawGates = Array.isArray(ledger.gates) ? ledger.gates : [];
  const gates = [];
  const seenGates = new Set();
  for (let index = 0; index < rawGates.length; index += 1) {
    const entry = rawGates[index];
    const prefix = "gates[" + index + "]";
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      unverified.push(prefix + " must be an object");
      continue;
    }
    const name = nonemptyString(entry.gate) ? entry.gate : null;
    if (!name) {
      unverified.push(prefix + ".gate is required");
      continue;
    }
    if (seenGates.has(name)) {
      unverified.push(prefix + " repeats gate " + name);
      continue;
    }
    seenGates.add(name);
    const declaredState = nonemptyString(entry.state) ? entry.state : null;
    const aliases = GATE_STATE_ALIASES[name] || [];
    const isAliasState = declaredState ? aliases.includes(declaredState) : false;
    if (
      !declaredState ||
      (!GATE_STATES.includes(declaredState) && !isAliasState)
    ) {
      unverified.push(
        prefix +
          ".state must be one of " +
          GATE_STATES.join(", ") +
          (aliases.length ? " or " + aliases.join(", ") : ""),
      );
      continue;
    }
    if (sequence && !sequence.includes(name)) {
      unverified.push(
        prefix + " gate " + name + " does not belong to branch " + branch,
      );
      continue;
    }
    gates.push({
      gate: name,
      state: declaredState,
      closed: declaredState === CLOSED || isAliasState,
      usedAliasState: isAliasState,
      sequenceIndex: sequence ? sequence.indexOf(name) : -1,
      evidence: resolveGateEvidence(entry, baseDir),
      note: nonemptyString(entry.note) ? entry.note : null,
    });
  }

  // Declared order must match canonical order; a ledger written out of order
  // hides which gate was actually reached first.
  const ordered = gates.filter((gate) => gate.sequenceIndex >= 0);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].sequenceIndex < ordered[index - 1].sequenceIndex) {
      unverified.push(
        "gate " +
          ordered[index].gate +
          " is listed after " +
          ordered[index - 1].gate +
          " but precedes it in the " +
          branch +
          " sequence",
      );
      break;
    }
  }

  const byGate = new Map(gates.map((gate) => [gate.gate, gate]));
  const closedGates = gates
    .filter((gate) => gate.closed)
    .map((gate) => gate.gate);

  // A CLOSED gate with no existing artifact is the failure mode this lint exists
  // to catch: prose claiming a gate that no evidence supports.
  for (const gate of gates) {
    if (!gate.closed) continue;
    if (gate.evidence.resolved.length === 0) {
      blocked.push(
        "gate " +
          gate.gate +
          " is CLOSED but binds no existing non-empty evidence artifact" +
          (gate.evidence.missing.length
            ? " (missing: " + gate.evidence.missing.join(", ") + ")"
            : ""),
      );
    } else if (gate.evidence.missing.length) {
      unverified.push(
        "gate " +
          gate.gate +
          " declares evidence that does not exist: " +
          gate.evidence.missing.join(", "),
      );
    }
  }

  // No gate may be closed while an earlier gate in the sequence is open.
  let firstOpenGate = null;
  if (sequence) {
    for (const name of sequence) {
      const entry = byGate.get(name);
      if (!entry || !entry.closed) {
        firstOpenGate = name;
        break;
      }
    }
    if (firstOpenGate) {
      const firstOpenIndex = sequence.indexOf(firstOpenGate);
      for (const gate of gates) {
        if (gate.closed && gate.sequenceIndex > firstOpenIndex) {
          blocked.push(
            "gate " +
              gate.gate +
              " is CLOSED while the earlier gate " +
              firstOpenGate +
              " is not closed",
          );
        }
      }
    }
  }

  // Scope boundary: a narrower scope must not claim gates past its terminal.
  const terminalGate =
    scope && branch && SCOPE_TERMINAL_GATE[scope]
      ? SCOPE_TERMINAL_GATE[scope][branch]
      : undefined;
  if (terminalGate && sequence) {
    const terminalIndex = sequence.indexOf(terminalGate);
    for (const gate of gates) {
      if (gate.closed && gate.sequenceIndex > terminalIndex) {
        blocked.push(
          "scope " +
            scope +
            " stops at " +
            terminalGate +
            " but gate " +
            gate.gate +
            " is CLOSED",
        );
      }
    }
  }

  for (const required of requireGates) {
    const entry = byGate.get(required);
    if (!entry) {
      blocked.push("required gate " + required + " is absent from the ledger");
    } else if (!entry.closed) {
      blocked.push(
        "required gate " + required + " is " + entry.state + ", not CLOSED",
      );
    }
  }

  // A read-only review performs no writes, so demanding a write log would make
  // an honest review unrepresentable. Every mutating branch still requires it.
  const readOnlyBranch = branch === "read-only-review";
  const operationLog = readOnlyBranch
    ? {
        status: "NOT_APPLICABLE",
        reason: "read-only review performs no write operations",
        entryCount: 0,
        logPath: null,
      }
    : analyzeOperationLog(options.operationLog, {
        logPath: nonemptyString(ledger.operationLog) ? ledger.operationLog : null,
      });
  if (!readOnlyBranch && operationLog.status !== "VERIFIED") {
    unverified.push("operation log: " + operationLog.reason);
  }

  const decision = blocked.length
    ? "BLOCKED"
    : unverified.length
      ? "UNVERIFIED"
      : "CLEARED";
  // Completion is reported alongside the decision, never folded into it. A
  // CLEARED + INCOMPLETE ledger is the normal, honest state of work in progress;
  // downstream consumers decide what that permits.
  const completionAnalysis = analyzeCompletion({
    sequence,
    branch,
    scope,
    byGate,
    integrityFailed: decision !== "CLEARED",
  });
  return {
    decision,
    completion: completionAnalysis.state,
    branch,
    scope,
    projectUuid: ledger.projectUuid || null,
    canonicalSequence: sequence ? [...sequence] : [],
    gates,
    closedGates,
    firstOpenGate,
    terminalGate: terminalGate || null,
    requiredGates: [...requireGates],
    operationLog,
    blocked,
    unverified,
    completionAnalysis,
    limitations: [
      "This lint proves gate bookkeeping order and evidence existence only.",
      "It does not read an artifact's content or prove that the artifact closes its gate.",
      "decision reports bookkeeping integrity; completion reports whether the",
      "declared branch and scope reached their terminal gate. They are independent:",
      "a CLEARED ledger may be INCOMPLETE, which is the honest state of work in",
      "progress and is not a design closure.",
      "A CLEARED, COMPLETE ledger is still not a fabrication release.",
    ],
  };
}

function selfTestLedger(overrides = {}) {
  return {
    schemaVersion: 1,
    branch: "new-construction",
    scope: "schematic-only",
    projectUuid: "project-1",
    operationLog: "operation-log.json",
    gates: [
      { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
      { gate: "PROJECT_BOUND", state: "CLOSED", evidence: ["binding.json"] },
    ],
    ...overrides,
  };
}

function selfTestOperationLog(overrides = {}) {
  return {
    schemaVersion: 2,
    appendOnly: true,
    entries: [
      {
        id: "op-1",
        transactionId: "tx-1",
        gate: "PROJECT_BOUND",
        attemptFamily: "project-binding",
        attemptIndex: 1,
        startedAt: "2026-08-14T00:00:00.000Z",
        endedAt: "2026-08-14T00:00:01.000Z",
        durationMs: 1000,
        operation: "sch_PrimitiveComponent.create U1",
        outcome: "COMMITTED",
        attemptDisposition: "ACCEPTED",
        gateProgress: "CLOSED",
        evidence: ["binding.json"],
        semanticReadback: "reopened page; U1 present with stable unique id",
      },
    ],
    ...overrides,
  };
}

async function runSelfTest() {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "easyeda-gate-ledger-"));
  try {
    writeFileSync(path.join(dir, "companion.json"), '{"ready":true}\n');
    writeFileSync(path.join(dir, "binding.json"), '{"decision":"BOUND"}\n');
    writeFileSync(path.join(dir, "primary.json"), '{"cleared":true}\n');
    writeFileSync(path.join(dir, "empty.json"), "");
    const log = selfTestOperationLog();

    const cleared = analyzeLedger(selfTestLedger(), {
      baseDir: dir,
      operationLog: log,
    });
    if (cleared.decision !== "CLEARED") {
      throw new Error(
        "valid ledger was not cleared: " +
          JSON.stringify([...cleared.blocked, ...cleared.unverified]),
      );
    }

    const missingEvidence = analyzeLedger(
      selfTestLedger({
        gates: [
          { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
          { gate: "PROJECT_BOUND", state: "CLOSED", evidence: ["absent.json"] },
        ],
      }),
      { baseDir: dir, operationLog: log },
    );
    if (missingEvidence.decision !== "BLOCKED") {
      throw new Error("closed gate with missing evidence was accepted");
    }

    const emptyEvidence = analyzeLedger(
      selfTestLedger({
        gates: [
          { gate: "COMPANION_READY", state: "CLOSED", evidence: ["empty.json"] },
        ],
      }),
      { baseDir: dir, operationLog: log },
    );
    if (emptyEvidence.decision !== "BLOCKED") {
      throw new Error("zero-byte evidence file was accepted");
    }

    // Skipping a gate must be BLOCKED. This is the observed failure mode where
    // copper and routing proceeded while synchronization was never closed.
    const skipped = analyzeLedger(
      selfTestLedger({
        scope: "end-to-end",
        gates: [
          { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
          { gate: "PROJECT_BOUND", state: "CLOSED", evidence: ["binding.json"] },
          { gate: "PRIMARY_FUNCTIONS_CONFIRMED", state: "OPEN" },
          { gate: "COPPER_CANARY_CLEAR", state: "CLOSED", evidence: ["primary.json"] },
        ],
      }),
      { baseDir: dir, operationLog: log },
    );
    if (skipped.decision !== "BLOCKED") {
      throw new Error("out-of-order gate closure was accepted");
    }
    if (
      !skipped.blocked.some((item) =>
        /COPPER_CANARY_CLEAR is CLOSED while the earlier gate PRIMARY_FUNCTIONS_CONFIRMED/.test(
          item,
        ),
      )
    ) {
      throw new Error("skipped-gate explanation is missing");
    }
    if (skipped.firstOpenGate !== "PRIMARY_FUNCTIONS_CONFIRMED") {
      throw new Error("firstOpenGate was not reported correctly");
    }

    // A schematic-only scope must not claim PCB gates.
    const scopeOverreach = analyzeLedger(
      selfTestLedger({
        gates: [
          { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
          { gate: "PROJECT_BOUND", state: "CLOSED", evidence: ["binding.json"] },
          { gate: "PRIMARY_FUNCTIONS_CONFIRMED", state: "CLOSED", evidence: ["primary.json"] },
          { gate: "SCHEMATIC_IDENTITY_STABLE", state: "CLOSED", evidence: ["primary.json"] },
          { gate: "SCHEMATIC_VERIFIED", state: "CLOSED", evidence: ["primary.json"] },
          { gate: "PCB_SYNC_MATCH", state: "CLOSED", evidence: ["primary.json"] },
        ],
      }),
      { baseDir: dir, operationLog: log },
    );
    if (scopeOverreach.decision !== "BLOCKED") {
      throw new Error("schematic-only scope was allowed to close a PCB gate");
    }

    // The verified cache exception is a recognized PCB_SYNC_MATCH substitute.
    const aliasLedger = analyzeLedger(
      selfTestLedger({
        branch: "existing-board-continuation",
        scope: "pcb-only",
        gates: [
          { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
          { gate: "ACTIVE_PCB_AND_HANDOFF_BOUND", state: "CLOSED", evidence: ["binding.json"] },
          {
            gate: "PCB_SYNC_MATCH",
            state: "PCB_SYNC_VERIFIED_CACHE_EXCEPTION",
            evidence: ["primary.json"],
          },
        ],
      }),
      { baseDir: dir, operationLog: log },
    );
    if (aliasLedger.decision !== "CLEARED") {
      throw new Error("verified native-cache exception was rejected");
    }

    // An invented state string must not pass as a gate closure.
    const bogusState = analyzeLedger(
      selfTestLedger({
        gates: [
          { gate: "COMPANION_READY", state: "PROBABLY_FINE", evidence: ["companion.json"] },
        ],
      }),
      { baseDir: dir, operationLog: log },
    );
    if (bogusState.decision !== "UNVERIFIED") {
      throw new Error("an invented gate state was accepted");
    }

    // A gate outside the declared branch is UNVERIFIED.
    const foreignGate = analyzeLedger(
      selfTestLedger({
        branch: "existing-board-repair",
        scope: "pcb-only",
        gates: [
          { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
          { gate: "PRIMARY_FUNCTIONS_CONFIRMED", state: "OPEN" },
        ],
      }),
      { baseDir: dir, operationLog: log },
    );
    if (foreignGate.decision !== "UNVERIFIED") {
      throw new Error("foreign gate name was accepted for the declared branch");
    }

    const requiredMissing = analyzeLedger(selfTestLedger(), {
      baseDir: dir,
      operationLog: log,
      requireGates: ["SCHEMATIC_VERIFIED"],
    });
    if (requiredMissing.decision !== "BLOCKED") {
      throw new Error("absent required gate was accepted");
    }

    // Operation-log contracts.
    const missingLog = analyzeLedger(selfTestLedger(), { baseDir: dir });
    if (missingLog.decision !== "UNVERIFIED") {
      throw new Error("absent operation log was accepted");
    }
    const duplicateIds = analyzeOperationLog(
      selfTestOperationLog({
        entries: [
          { id: "op-1", operation: "a", outcome: "COMMITTED", semanticReadback: "rb a" },
          { id: "op-1", operation: "b", outcome: "COMMITTED", semanticReadback: "rb b" },
        ],
      }),
    );
    if (duplicateIds.status !== "UNVERIFIED") {
      throw new Error("duplicate operation-log entry ids were accepted");
    }
    const timeoutWithoutReadback = analyzeOperationLog(
      selfTestOperationLog({
        entries: [{ id: "op-1", operation: "create", outcome: "UNKNOWN_TIMEOUT" }],
      }),
    );
    if (timeoutWithoutReadback.status !== "UNVERIFIED") {
      throw new Error("timed-out write without semantic readback was accepted");
    }
    if (
      !timeoutWithoutReadback.issues.some((item) =>
        /leaves an unknown state/.test(item),
      )
    ) {
      throw new Error("timeout guidance is missing from the operation-log lint");
    }
    const appendOnlyMissing = analyzeOperationLog(
      selfTestOperationLog({ appendOnly: false }),
    );
    if (appendOnlyMissing.status !== "UNVERIFIED") {
      throw new Error("a log without appendOnly was accepted");
    }
    const legacyTiming = analyzeOperationLog({
      schemaVersion: 1,
      appendOnly: true,
      entries: [],
    });
    if (legacyTiming.status !== "UNVERIFIED" || !/predates mandatory timing/.test(legacyTiming.reason)) {
      throw new Error("legacy operation log did not remain historical-only evidence");
    }
    const badDuration = selfTestOperationLog();
    badDuration.entries[0].durationMs = 998;
    if (analyzeOperationLog(badDuration).status !== "UNVERIFIED") {
      throw new Error("operation log accepted inconsistent timestamp duration");
    }

    if (!parseArgs(["--ledger", "l.json"]).ledger) {
      throw new Error("--ledger was not parsed");
    }
    if (
      parseArgs(["--ledger", "l.json", "--markdown", "status.md"]).markdown !==
      "status.md"
    ) {
      throw new Error("--markdown was not parsed");
    }
    let rejected = false;
    try {
      parseArgs([]);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("missing --ledger was accepted");

    // The renderer exists to stop a readable summary from disagreeing with the
    // verdict, so assert the specific ways a hand-written table goes wrong.
    const partial = analyzeLedger(selfTestLedger(), {
      baseDir: dir,
      operationLog: log,
    });
    const partialMarkdown = renderMarkdown({
      ledgerPath: path.join(dir, "gate-ledger.json"),
      generatedAt: "1970-01-01T00:00:00.000Z",
      analysis: partial,
    });
    if (partial.completion === "COMPLETE") {
      throw new Error("self-test ledger was expected to be an incomplete slice");
    }
    // Both axes must be present: integrity alone reads as closure.
    if (
      !partialMarkdown.includes("Bookkeeping integrity: **" + partial.decision) ||
      !partialMarkdown.includes("Slice completion: **" + partial.completion)
    ) {
      throw new Error("markdown omits one of the two decision axes");
    }
    if (!/not a fabrication release/i.test(partialMarkdown)) {
      throw new Error("markdown omits the fabrication-release boundary");
    }
    // An owned gate the ledger never mentioned must still be visible.
    for (const gate of partial.completionAnalysis.remainingGates) {
      if (!partialMarkdown.includes("`" + gate + "`")) {
        throw new Error("markdown hides remaining gate " + gate);
      }
    }
    if (!partialMarkdown.includes("NOT RECORDED")) {
      throw new Error("markdown does not mark unrecorded owned gates");
    }

    // A declared-but-absent artifact must never be printed as if it resolved.
    const withMissing = analyzeLedger(
      selfTestLedger({
        gates: [
          {
            gate: "COMPANION_READY",
            state: "CLOSED",
            evidence: ["companion.json", "absent.json"],
          },
        ],
      }),
      { baseDir: dir, operationLog: log },
    );
    const missingMarkdown = renderMarkdown({
      ledgerPath: path.join(dir, "gate-ledger.json"),
      generatedAt: "1970-01-01T00:00:00.000Z",
      analysis: withMissing,
    });
    if (!/declared but missing: `absent\.json`/.test(missingMarkdown)) {
      throw new Error("markdown does not report a declared-but-missing artifact");
    }
    if (!missingMarkdown.includes("`companion.json`")) {
      throw new Error("markdown drops a resolved evidence artifact");
    }

    let renderRejected = false;
    try {
      renderMarkdown({ ledgerPath: "x.json" });
    } catch {
      renderRejected = true;
    }
    if (!renderRejected) {
      throw new Error("markdown was rendered without an analysis");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.selfTest) {
    await runSelfTest();
    process.stdout.write("easyeda gate ledger self-test passed\n");
    return;
  }
  const ledgerPath = path.resolve(options.ledger);
  const ledger = await readJson(ledgerPath);
  const baseDir = path.dirname(ledgerPath);
  let operationLog;
  if (nonemptyString(ledger?.operationLog)) {
    const logPath = path.isAbsolute(ledger.operationLog)
      ? ledger.operationLog
      : path.resolve(baseDir, ledger.operationLog);
    try {
      operationLog = await readJson(logPath);
    } catch {
      // An unreadable log stays UNVERIFIED rather than throwing, so the report
      // explains the reason instead of losing the rest of the analysis.
      operationLog = null;
    }
  }
  const analysis = analyzeLedger(ledger, {
    baseDir,
    operationLog,
    requireGates: options.requireGates,
  });
  const report = {
    schemaVersion: 1,
    kind: "easyeda-gate-ledger",
    decision: analysis.decision,
    completion: analysis.completion,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    ledgerPath,
    generatedAt: new Date().toISOString(),
    analysis,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (options.output) {
    const outputPath = resolveSafeOutputPath(options.output, {
      force: options.force,
    });
    await writeFile(outputPath, text, "utf8");
  }
  if (options.markdown) {
    const markdownPath = resolveSafeOutputPath(options.markdown, {
      force: options.force,
    });
    await writeFile(markdownPath, renderMarkdown(report) + "\n", "utf8");
  }
  process.stdout.write(text);
  process.exitCode =
    analysis.decision === "CLEARED"
      ? EXIT.OK
      : analysis.decision === "UNVERIFIED"
        ? EXIT.UNVERIFIED
        : EXIT.BLOCKED;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      (error instanceof Error ? error.message : String(error)) + "\n",
    );
    process.exitCode = EXIT.ERROR;
  });
}

export {
  BRANCH_GATES,
  COMPLETION,
  EXIT,
  GATE_STATES,
  GATE_STATE_ALIASES,
  OPERATION_OUTCOMES,
  ATTEMPT_DISPOSITIONS,
  GATE_PROGRESS,
  SCOPES,
  SCOPE_TERMINAL_GATE,
  analyzeCompletion,
  analyzeLedger,
  analyzeOperationLog,
  parseArgs,
  renderMarkdown,
  selfTestLedger,
  selfTestOperationLog,
};

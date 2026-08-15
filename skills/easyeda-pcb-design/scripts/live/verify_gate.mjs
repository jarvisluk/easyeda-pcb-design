#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { summarizePcbDrcEvidence } from "../audits/easyeda_design_audit.mjs";
import {
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
} from "../lib/audit_common.mjs";
import { validateTransactionPlan } from "./lib/transaction_plan.mjs";
import { appendOperationEntry } from "./lib/transaction_runner.mjs";

const PLACEMENT_REQUIRED_AXES = [
  "boardMechanicalContainment",
  "viaPadGeometry",
  "componentOccupancy",
  "criticalPlacementZones",
  "humanInterfaces",
  "externalInterfacesAndBom",
];

function usage() {
  return `Usage:
  node scripts/live/verify_gate.mjs --plan FILE --before FILE --after FILE \\
    --transaction-result FILE --output FILE
  node scripts/live/verify_gate.mjs --self-test

The plan names its budget, checkpoint, ledger, and placement artifacts. The
after-state must come from inspect_current_state.mjs --with-drc after a
save/switch/reopen. VERIFIED closes only the bounded transaction evidence; it
is not a fabrication release.
`;
}

function parseArgs(argv) {
  const options = {
    plan: null, before: null, after: null, transactionResult: null, output: null, selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--plan") options.plan = next();
    else if (option === "--before") options.before = next();
    else if (option === "--after") options.after = next();
    else if (option === "--transaction-result") options.transactionResult = next();
    else if (option === "--output") options.output = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!options.selfTest) {
    for (const field of ["plan", "before", "after", "transactionResult", "output"]) {
      if (!options[field]) throw new Error(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
    }
  }
  return options;
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`unable to read ${label} ${file}: ${error.message}`);
  }
}

function numericEqual(first, second) {
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= 1e-7;
}

function layerIdFromEnum(value) {
  if (value === "TOP") return 1;
  if (value === "BOTTOM") return 2;
  const match = /^INNER_(\d+)$/.exec(value || "");
  return match ? 14 + Number(match[1]) : null;
}

function lineMatches(actual, expected, net) {
  const sameDirection =
    numericEqual(actual.startX, expected.startX) &&
    numericEqual(actual.startY, expected.startY) &&
    numericEqual(actual.endX, expected.endX) &&
    numericEqual(actual.endY, expected.endY);
  const reversed =
    numericEqual(actual.startX, expected.endX) &&
    numericEqual(actual.startY, expected.endY) &&
    numericEqual(actual.endX, expected.startX) &&
    numericEqual(actual.endY, expected.startY);
  return (
    actual.net === net &&
    Number(actual.layer) === layerIdFromEnum(expected.layerEnum) &&
    (sameDirection || reversed) &&
    numericEqual(actual.lineWidth, expected.lineWidth)
  );
}

function viaMatches(actual, expected, net) {
  return (
    actual.net === net &&
    numericEqual(actual.x, expected.x) &&
    numericEqual(actual.y, expected.y) &&
    numericEqual(actual.holeDiameter, expected.holeDiameter) &&
    numericEqual(actual.diameter, expected.diameter)
  );
}

function analyzeGateVerification(input) {
  const { plan, before, after, transactionResult, budget, checkpoint, ledger, placement } = input;
  const mode = plan?.kind === "easyeda-repair-transaction-plan" ? "repair" : "route";
  const planValidation = validateTransactionPlan(plan, mode);
  const failures = [];
  const unverified = [];
  if (!planValidation.valid) failures.push(...planValidation.errors.map((item) => `plan: ${item}`));
  if (before?.kind !== "easyeda-current-state" || after?.kind !== "easyeda-current-state") {
    failures.push("before and after must be easyeda-current-state artifacts");
  }
  if (before?.fingerprint !== plan?.baselineFingerprint) {
    failures.push("before-state fingerprint does not match plan baseline");
  }
  if (
    before?.project?.uuid !== plan?.projectUuid ||
    before?.document?.uuid !== plan?.pcbUuid ||
    after?.project?.uuid !== plan?.projectUuid ||
    after?.document?.uuid !== plan?.pcbUuid
  ) failures.push("project/PCB UUID binding changed across the transaction");
  if (
    transactionResult?.kind !== `easyeda-${mode}-transaction-result` ||
    transactionResult?.status !== "TRANSACTION_APPLIED_PENDING_REOPEN" ||
    transactionResult?.plan?.transactionId !== plan?.transactionId
  ) failures.push("transaction application result is absent or bound to another plan");
  if (
    budget?.kind !== "easyeda-execution-budget-check" ||
    budget?.status !== "CONTINUE" ||
    budget?.executeAllowed !== true
  ) {
    failures.push("pre-transaction budget check did not permit execution");
  }
  const checkpointMatches = Boolean(
    checkpoint?.executeAllowed === true &&
      checkpoint?.liveFingerprint === plan?.baselineFingerprint &&
      (
        (checkpoint?.kind === "easyeda-native-checkpoint-check" &&
          checkpoint?.status === "NATIVE_CHECKPOINT_MATCH") ||
        (checkpoint?.kind === "easyeda-native-restore-check" &&
          checkpoint?.status === "NATIVE_RESTORE_MATCH" &&
          checkpoint?.restoreReady === true)
      ),
  );
  if (!checkpointMatches) {
    failures.push("pre-transaction native checkpoint did not match the baseline");
  } else if (
    plan?.targetClass === "PRODUCTION" &&
    checkpoint?.kind !== "easyeda-native-restore-check"
  ) {
    failures.push("production transaction lacked a non-production probe restore check");
  }
  if (ledger?.kind !== "easyeda-gate-ledger" || ledger?.decision !== "CLEARED") {
    unverified.push("gate ledger integrity is not CLEARED");
  }
  const placementRequired = new Set(placement?.coverage?.requiredAxes || []);
  const placementChecked = new Set(placement?.coverage?.checkedAxes || []);
  if (
    placement?.kind !== "easyeda-placement-audit" ||
    placement?.schemaVersion !== 3 ||
    placement?.status !== "PLACEMENT_CLEAR_FOR_ROUTING" ||
    placement?.design?.fingerprint !== after?.fingerprint ||
    placement?.coverage?.unverifiedAxes?.length ||
    PLACEMENT_REQUIRED_AXES.some(
      (axis) => !placementRequired.has(axis) || !placementChecked.has(axis),
    )
  ) unverified.push("current schema 3 placement/containment coverage is not clear for the after revision");

  const beforeLines = before?.raw?.lines || [];
  const afterLines = after?.raw?.lines || [];
  const beforeVias = before?.raw?.vias || [];
  const afterVias = after?.raw?.vias || [];
  if (afterLines.length - beforeLines.length !== plan?.acceptance?.expectedLineDelta) {
    failures.push("saved/reopened line-count delta differs from the immutable plan");
  }
  if (afterVias.length - beforeVias.length !== plan?.acceptance?.expectedViaDelta) {
    failures.push("saved/reopened via-count delta differs from the immutable plan");
  }
  const afterLineIds = new Set(afterLines.map((item) => item.primitiveId));
  const afterViaIds = new Set(afterVias.map((item) => item.primitiveId));
  for (const primitiveId of plan?.deletes?.lineIds || []) {
    if (afterLineIds.has(primitiveId)) failures.push(`deleted line remains after reopen: ${primitiveId}`);
  }
  for (const primitiveId of plan?.deletes?.viaIds || []) {
    if (afterViaIds.has(primitiveId)) failures.push(`deleted via remains after reopen: ${primitiveId}`);
  }
  for (const [index, expected] of (plan?.creates?.lines || []).entries()) {
    if (!afterLines.some((actual) => lineMatches(actual, expected, plan.net))) {
      failures.push(`planned line ${index} is absent after saved/reopened readback`);
    }
  }
  for (const [index, expected] of (plan?.creates?.vias || []).entries()) {
    if (!afterVias.some((actual) => viaMatches(actual, expected, plan.net))) {
      failures.push(`planned via ${index} is absent after saved/reopened readback`);
    }
  }
  let drc = null;
  if (after?.axes?.drc?.status !== "CAPTURED") {
    unverified.push("after-state lacks repeated detailed DRC evidence");
  } else {
    drc = summarizePcbDrcEvidence(after.raw, {});
    if (!drc.evidenceVerified) unverified.push("repeated detailed DRC evidence is unstable or incomplete");
    else if (!drc.passed) failures.push("saved/reopened detailed DRC contains non-exempt errors");
  }
  const status = failures.length
    ? "TRANSACTION_REJECTED"
    : unverified.length
      ? "TRANSACTION_UNVERIFIED"
      : "TRANSACTION_VERIFIED";
  return {
    schemaVersion: 1,
    kind: "easyeda-transaction-gate-verification",
    status,
    gateMayAdvance: status === "TRANSACTION_VERIFIED",
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    transactionId: plan?.transactionId || null,
    mode,
    beforeFingerprint: before?.fingerprint || null,
    afterFingerprint: after?.fingerprint || null,
    delta: {
      lineCount: afterLines.length - beforeLines.length,
      viaCount: afterVias.length - beforeVias.length,
    },
    drc,
    failures,
    unverified,
    nextAction: status === "TRANSACTION_VERIFIED"
      ? "Record this artifact at the owning live gate; do not infer fabrication readiness."
      : "Stop expansion. Use exact created IDs for cleanup or restore the verified native checkpoint, then prove fingerprint recovery.",
  };
}

function selfTest() {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const line = { primitiveId: "line-new", net: "USB_DP", layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 8 };
  const plan = {
    schemaVersion: 1,
    kind: "easyeda-route-transaction-plan",
    transactionId: "tx-1", gate: "ROUTING_CANARY_CLEAR",
    attemptFamily: "route-usb", attemptIndex: 1,
    targetClass: "NON_PRODUCTION_PROBE", projectUuid: "project-1", pcbUuid: "pcb-1",
    baselineFingerprint: fingerprint, net: "USB_DP",
    creates: { lines: [{ layerEnum: "TOP", startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 8, primitiveLock: false }], vias: [] },
    deletes: { lineIds: [], viaIds: [] },
    acceptance: { expectedLineDelta: 1, expectedViaDelta: 0, requireDetailedDrc: true },
    controls: {
      budgetCheck: "budget.json", checkpointCheck: "checkpoint.json",
      authorizationRecord: "authorization.json", gateLedgerCheck: "ledger.json",
      placementReport: "placement.json", operationLog: "operation-log.json",
    },
  };
  const state = (after = false) => ({
    kind: "easyeda-current-state", fingerprint: after ? `sha256:${"b".repeat(64)}` : fingerprint,
    project: { uuid: "project-1" }, document: { uuid: "pcb-1" },
    axes: { drc: { status: "NOT_RUN" } },
    raw: { lines: after ? [line] : [], vias: [] },
  });
  const base = {
    plan, before: state(false), after: state(true),
    transactionResult: { kind: "easyeda-route-transaction-result", status: "TRANSACTION_APPLIED_PENDING_REOPEN", plan: { transactionId: "tx-1" } },
    budget: { kind: "easyeda-execution-budget-check", status: "CONTINUE", executeAllowed: true },
    checkpoint: { kind: "easyeda-native-checkpoint-check", status: "NATIVE_CHECKPOINT_MATCH", executeAllowed: true, liveFingerprint: fingerprint },
    ledger: { kind: "easyeda-gate-ledger", decision: "CLEARED" },
    placement: {
      kind: "easyeda-placement-audit",
      schemaVersion: 3,
      status: "PLACEMENT_CLEAR_FOR_ROUTING",
      design: { fingerprint: `sha256:${"b".repeat(64)}` },
      coverage: {
        requiredAxes: [...PLACEMENT_REQUIRED_AXES],
        checkedAxes: [...PLACEMENT_REQUIRED_AXES],
        unverifiedAxes: [],
      },
    },
  };
  const unverified = analyzeGateVerification(base);
  if (unverified.status !== "TRANSACTION_UNVERIFIED") throw new Error("missing repeated DRC did not stay unverified");
  const rejectedInput = structuredClone(base);
  rejectedInput.after.raw.lines = [];
  const rejected = analyzeGateVerification(rejectedInput);
  if (rejected.status !== "TRANSACTION_REJECTED") throw new Error("missing planned geometry did not reject transaction");
  const verifiedInput = structuredClone(base);
  const rule = { name: "self-test rules", configuration: { clearance: 6 } };
  verifiedInput.after.axes.drc.status = "CAPTURED";
  verifiedInput.after.raw.drc = [];
  verifiedInput.after.raw.drcEvidence = {
    schemaVersion: 1,
    ruleBefore: rule,
    ruleAfter: rule,
    samples: [
      { id: "silent-1", strict: true, userInterface: false, includeVerboseError: true, result: [] },
      { id: "silent-2", strict: true, userInterface: false, includeVerboseError: true, result: [] },
      { id: "visible-final", strict: true, userInterface: true, includeVerboseError: true, result: [] },
    ],
  };
  const verified = analyzeGateVerification(verifiedInput);
  if (verified.status !== "TRANSACTION_VERIFIED") {
    throw new Error(`valid transaction did not verify: ${JSON.stringify(verified)}`);
  }
  process.stdout.write(`${JSON.stringify({ verified: verified.status, unverified: unverified.status, rejected: rejected.status })}\n`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) return selfTest();
    const planPath = path.resolve(options.plan);
    const plan = await readJson(planPath, "plan");
    const baseDir = path.dirname(planPath);
    const [before, after, transactionResult, budget, checkpoint, ledger, placement, operationLog] = await Promise.all([
      readJson(path.resolve(options.before), "before state"),
      readJson(path.resolve(options.after), "after state"),
      readJson(path.resolve(options.transactionResult), "transaction result"),
      readJson(path.resolve(baseDir, plan.controls.budgetCheck), "budget check"),
      readJson(path.resolve(baseDir, plan.controls.checkpointCheck), "checkpoint check"),
      readJson(path.resolve(baseDir, plan.controls.gateLedgerCheck), "gate ledger check"),
      readJson(path.resolve(baseDir, plan.controls.placementReport), "placement report"),
      readJson(path.resolve(baseDir, plan.controls.operationLog), "operation log"),
    ]);
    const result = analyzeGateVerification({ plan, before, after, transactionResult, budget, checkpoint, ledger, placement });
    const output = resolveSafeOutputPath(options.output);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    const verifiedAt = new Date();
    await appendOperationEntry(
      path.resolve(baseDir, plan.controls.operationLog),
      operationLog,
      {
        id: `${plan.transactionId}-verify-${verifiedAt.getTime()}`,
        transactionId: plan.transactionId,
        gate: plan.gate,
        attemptFamily: plan.attemptFamily,
        attemptIndex: plan.attemptIndex,
        operation: `${result.mode} transaction saved/reopened gate verification`,
        outcome: "READ_ONLY",
        semanticReadback: `${result.status}: ${result.failures.length} failure(s), ${result.unverified.length} unverified finding(s)`,
        startedAt: verifiedAt.toISOString(),
        endedAt: verifiedAt.toISOString(),
        durationMs: 0,
        attemptDisposition: result.status === "TRANSACTION_VERIFIED"
          ? "ACCEPTED"
          : result.status === "TRANSACTION_REJECTED"
            ? "REJECTED"
            : "UNKNOWN",
        gateProgress: result.status === "TRANSACTION_VERIFIED"
          ? "CLOSED"
          : result.status === "TRANSACTION_REJECTED"
            ? "BLOCKED"
            : "NO_CHANGE",
        evidence: [options.output],
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "TRANSACTION_VERIFIED" ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, kind: "easyeda-transaction-gate-verification", fabricationRelease: false }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { analyzeGateVerification, parseArgs };

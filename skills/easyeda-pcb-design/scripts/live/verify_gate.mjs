#!/usr/bin/env node

import path from "node:path";

import { summarizePcbDrcEvidence } from "../audits/easyeda_design_audit.mjs";
import { notAFabricationReleaseMessage } from "../lib/audit_common.mjs";
import { appendOperationEntry, PLACEMENT_REQUIRED_AXES, planFixture } from "./lib/transaction_runner.mjs";
import { COLLECTIONS, operationDefinition } from "./lib/operation_registry.mjs";
import { validateTransactionPlan } from "./lib/transaction_plan.mjs";
import {
  cliFailure,
  isMain,
  readJsonFile,
  resolveArtifactRoot,
  resolveContainedPath,
  writeContainedJson,
} from "./lib/tool_runtime.mjs";

function usage() {
  return `Usage:
  node scripts/live/verify_gate.mjs --plan FILE --before FILE --after FILE \\
    --transaction-result FILE --output FILE
  node scripts/live/verify_gate.mjs --self-test

The after-state must be schema-2 inspect_current_state.mjs --with-drc evidence
from a saved/reopened PCB. The verifier proves exact IDs, normalized deltas,
post-placement containment, and repeated DRC for every registered operation.
`;
}

function parseArgs(argv) {
  const options = { plan: null, before: null, after: null, transactionResult: null, output: null, selfTest: false };
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
      if (!options[field]) throw new Error(`--${field.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`);
    }
  }
  return options;
}

function numericEqual(first, second) {
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= 1e-7;
}

function layerIdFromEnum(value) {
  if (value === "TOP") return 1;
  if (value === "BOTTOM") return 2;
  if (value === "BOARD_OUTLINE") return 11;
  const match = /^INNER_(\d+)$/.exec(value || "");
  return match ? 14 + Number(match[1]) : null;
}

function pointsEqual(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  return actual.every((point, index) => numericEqual(point?.[0], expected[index]?.[0]) && numericEqual(point?.[1], expected[index]?.[1]));
}

function matchesCreated(actual, operation) {
  if (!actual) return false;
  if (operation.type === "line.create") {
    const direct = numericEqual(actual.startX, operation.startX) && numericEqual(actual.startY, operation.startY) &&
      numericEqual(actual.endX, operation.endX) && numericEqual(actual.endY, operation.endY);
    const reverse = numericEqual(actual.startX, operation.endX) && numericEqual(actual.startY, operation.endY) &&
      numericEqual(actual.endX, operation.startX) && numericEqual(actual.endY, operation.startY);
    return actual.net === operation.net && Number(actual.layer) === layerIdFromEnum(operation.layerEnum) &&
      (direct || reverse) && numericEqual(actual.lineWidth, operation.lineWidth) && actual.locked === operation.primitiveLock;
  }
  if (operation.type === "via.create") {
    return actual.net === operation.net && numericEqual(actual.x, operation.x) && numericEqual(actual.y, operation.y) &&
      numericEqual(actual.holeDiameter, operation.holeDiameter) && numericEqual(actual.diameter, operation.diameter) &&
      actual.locked === operation.primitiveLock;
  }
  if (operation.type === "polyline.create") {
    return actual.net === operation.net && Number(actual.layer) === layerIdFromEnum(operation.layerEnum) &&
      numericEqual(actual.lineWidth, operation.lineWidth) && actual.locked === operation.primitiveLock &&
      pointsEqual(actual.points, operation.expectedPoints);
  }
  return false;
}

function componentMatches(actual, operation) {
  if (!actual || actual.designator !== operation.designator) return false;
  const changes = operation.changes || {};
  if (changes.x !== undefined && !numericEqual(actual.x, changes.x)) return false;
  if (changes.y !== undefined && !numericEqual(actual.y, changes.y)) return false;
  if (changes.rotation !== undefined && !numericEqual(actual.rotation, changes.rotation)) return false;
  if (changes.layerEnum !== undefined && Number(actual.layer) !== layerIdFromEnum(changes.layerEnum)) return false;
  if (changes.primitiveLock !== undefined && actual.locked !== changes.primitiveLock) return false;
  return true;
}

function collectionItems(state, collection) {
  return Array.isArray(state?.raw?.[collection]) ? state.raw[collection] : [];
}

function ids(items) {
  return new Set(items.map((item) => item?.primitiveId).filter(Boolean));
}

function postPlacementClear(placement, fingerprint) {
  const required = new Set(placement?.coverage?.requiredAxes || []);
  const checked = new Set(placement?.coverage?.checkedAxes || []);
  return Boolean(
    placement?.kind === "easyeda-placement-audit" && placement?.schemaVersion === 3 &&
    placement?.status === "PLACEMENT_CLEAR_FOR_ROUTING" && placement?.design?.fingerprint === fingerprint &&
    !placement?.coverage?.unverifiedAxes?.length &&
    PLACEMENT_REQUIRED_AXES.every((axis) => required.has(axis) && checked.has(axis))
  );
}

function analyzeGateVerification(input) {
  const { plan: inputPlan, before, after, transactionResult, budget, checkpoint, ledger, postPlacement } = input;
  const validation = validateTransactionPlan(inputPlan);
  const plan = validation.plan;
  const failures = [];
  const unverified = [];
  if (!validation.executable) failures.push(...[...validation.errors, ...validation.warnings].map((item) => `plan: ${item}`));
  if (before?.kind !== "easyeda-current-state" || after?.kind !== "easyeda-current-state" || before?.schemaVersion !== 2 || after?.schemaVersion !== 2) {
    failures.push("before and after must be schema-2 easyeda-current-state artifacts");
  }
  if (before?.fingerprint !== plan?.baselineFingerprint) failures.push("before-state fingerprint does not match plan baseline");
  if (
    before?.project?.uuid !== plan?.projectUuid || before?.document?.uuid !== plan?.pcbUuid ||
    after?.project?.uuid !== plan?.projectUuid || after?.document?.uuid !== plan?.pcbUuid
  ) failures.push("project/PCB UUID binding changed across the transaction");
  if (
    transactionResult?.kind !== "easyeda-transaction-result" || transactionResult?.schemaVersion !== 2 ||
    transactionResult?.status !== "TRANSACTION_APPLIED_PENDING_REOPEN" ||
    transactionResult?.plan?.transactionId !== plan?.transactionId || transactionResult?.plan?.mode !== plan?.mode
  ) failures.push("transaction application result is absent or bound to another plan/mode");
  if (budget?.kind !== "easyeda-execution-budget-check" || budget?.status !== "CONTINUE" || budget?.executeAllowed !== true) {
    failures.push("pre-transaction budget check did not permit execution");
  }
  const checkpointMatches = Boolean(
    checkpoint?.executeAllowed === true && checkpoint?.liveFingerprint === plan?.baselineFingerprint &&
      ((checkpoint?.kind === "easyeda-native-checkpoint-check" && checkpoint?.status === "NATIVE_CHECKPOINT_MATCH") ||
       (checkpoint?.kind === "easyeda-native-restore-check" && checkpoint?.status === "NATIVE_RESTORE_MATCH" && checkpoint?.restoreReady === true)),
  );
  if (!checkpointMatches) failures.push("pre-transaction native checkpoint did not match the baseline");
  else if (plan?.targetClass === "PRODUCTION" && checkpoint?.kind !== "easyeda-native-restore-check") {
    failures.push("production transaction lacked a non-production probe restore check");
  }
  if (ledger?.kind !== "easyeda-gate-ledger" || ledger?.decision !== "CLEARED") unverified.push("gate ledger integrity is not CLEARED");
  if (plan?.acceptance?.requirePlacementClearAfter && !postPlacementClear(postPlacement, after?.fingerprint)) {
    unverified.push("post-transaction schema-3 placement/containment coverage is not clear for the after revision");
  }

  const delta = {};
  const operationResults = new Map(
    (transactionResult?.immediateResult?.operationResults || []).map((item) => [item.operationId, item]),
  );
  for (const collection of COLLECTIONS) {
    const beforeItems = collectionItems(before, collection);
    const afterItems = collectionItems(after, collection);
    const beforeIds = ids(beforeItems);
    const afterIds = ids(afterItems);
    delta[collection] = afterItems.length - beforeItems.length;
    if (delta[collection] !== plan?.acceptance?.expectedDeltas?.[collection]) {
      failures.push(`${collection} count delta differs from the immutable plan`);
    }
    const plannedDeletes = new Set(
      (plan?.operations || []).filter((operation) => operationDefinition(operation.type)?.collection === collection && operationDefinition(operation.type)?.delta === -1)
        .map((operation) => operation.primitiveId),
    );
    for (const primitiveId of beforeIds) {
      if (!plannedDeletes.has(primitiveId) && !afterIds.has(primitiveId)) failures.push(`unplanned ${collection} removal: ${primitiveId}`);
    }
    for (const primitiveId of plannedDeletes) {
      if (afterIds.has(primitiveId)) failures.push(`planned ${collection} deletion remains after reopen: ${primitiveId}`);
    }
    const expectedCreatedIds = new Set();
    for (const operation of (plan?.operations || []).filter(
      (item) => operationDefinition(item.type)?.collection === collection && operationDefinition(item.type)?.delta === 1,
    )) {
      const returnedId = operationResults.get(operation.operationId)?.returnedId;
      if (!returnedId) failures.push(`create operation lacks a returned primitive ID: ${operation.operationId}`);
      else expectedCreatedIds.add(returnedId);
      const actual = afterItems.find((item) => item.primitiveId === returnedId);
      if (!matchesCreated(actual, operation)) failures.push(`created primitive does not match plan after reopen: ${operation.operationId}`);
    }
    for (const primitiveId of afterIds) {
      if (!beforeIds.has(primitiveId) && !expectedCreatedIds.has(primitiveId)) failures.push(`unplanned ${collection} residue: ${primitiveId}`);
    }
  }
  for (const operation of (plan?.operations || []).filter((item) => item.type === "component.modify")) {
    const actual = collectionItems(after, "components").find((item) => item.primitiveId === operation.primitiveId);
    if (!componentMatches(actual, operation)) failures.push(`component modification does not match plan after reopen: ${operation.operationId}`);
  }

  let drc = null;
  if (after?.axes?.drc?.status !== "CAPTURED") unverified.push("after-state lacks repeated detailed DRC evidence");
  else {
    drc = summarizePcbDrcEvidence(after.raw, {});
    if (!drc.evidenceVerified) unverified.push("repeated detailed DRC evidence is unstable or incomplete");
    else if (!drc.passed) failures.push("saved/reopened detailed DRC contains non-exempt errors");
  }
  const status = failures.length ? "TRANSACTION_REJECTED" : unverified.length ? "TRANSACTION_UNVERIFIED" : "TRANSACTION_VERIFIED";
  return {
    schemaVersion: 2,
    kind: "easyeda-transaction-gate-verification",
    status,
    gateMayAdvance: status === "TRANSACTION_VERIFIED",
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    transactionId: plan?.transactionId || null,
    mode: plan?.mode || null,
    beforeFingerprint: before?.fingerprint || null,
    afterFingerprint: after?.fingerprint || null,
    delta,
    drc,
    failures,
    unverified,
    nextAction: status === "TRANSACTION_VERIFIED"
      ? "Record this artifact at the owning live gate; do not infer fabrication readiness."
      : "Stop expansion. Execute the declared cleanup/restore strategy and prove exact baseline fingerprint recovery before another attempt.",
  };
}

function drcEvidence() {
  const rule = { name: "self-test rules", configuration: { clearance: 6 } };
  return {
    schemaVersion: 1, ruleBefore: rule, ruleAfter: rule,
    samples: [
      { id: "silent-1", strict: true, userInterface: false, includeVerboseError: true, result: [] },
      { id: "silent-2", strict: true, userInterface: false, includeVerboseError: true, result: [] },
      { id: "visible-final", strict: true, userInterface: true, includeVerboseError: true, result: [] },
    ],
  };
}

function stateFixture(plan, after = false) {
  const raw = { kind: "pcb", lines: [], vias: [], components: [], polylines: [], pours: [], poured: [], drc: [], drcEvidence: drcEvidence() };
  const returnedIds = {};
  for (const operation of plan.operations) {
    if (operation.type === "line.create" && after) {
      const returnedId = `${operation.operationId}-new`;
      returnedIds[operation.operationId] = returnedId;
      raw.lines.push({ primitiveId: returnedId, net: operation.net, layer: layerIdFromEnum(operation.layerEnum), startX: operation.startX, startY: operation.startY, endX: operation.endX, endY: operation.endY, lineWidth: operation.lineWidth, locked: operation.primitiveLock });
    } else if (operation.type === "via.create" && after) {
      const returnedId = `${operation.operationId}-new`;
      returnedIds[operation.operationId] = returnedId;
      raw.vias.push({ primitiveId: returnedId, net: operation.net, x: operation.x, y: operation.y, holeDiameter: operation.holeDiameter, diameter: operation.diameter, locked: operation.primitiveLock });
    } else if (operation.type === "line.delete" && !after) raw.lines.push({ primitiveId: operation.primitiveId });
    else if (operation.type === "via.delete" && !after) raw.vias.push({ primitiveId: operation.primitiveId });
    else if (operation.type === "polyline.delete" && !after) raw.polylines.push({ primitiveId: operation.primitiveId });
    else if (operation.type === "component.modify") {
      raw.components.push({
        primitiveId: operation.primitiveId, designator: operation.designator,
        layer: layerIdFromEnum(after ? operation.changes.layerEnum : operation.expectedBefore.layerEnum),
        x: after ? operation.changes.x : operation.expectedBefore.x,
        y: after ? operation.changes.y : operation.expectedBefore.y,
        rotation: after ? operation.changes.rotation : operation.expectedBefore.rotation,
        locked: after ? operation.changes.primitiveLock : operation.expectedBefore.primitiveLock,
      });
    } else if (operation.type === "polyline.create" && after) {
      const returnedId = `${operation.operationId}-new`;
      returnedIds[operation.operationId] = returnedId;
      raw.polylines.push({ primitiveId: returnedId, net: operation.net, layer: layerIdFromEnum(operation.layerEnum), lineWidth: operation.lineWidth, locked: operation.primitiveLock, points: operation.expectedPoints });
    } else if (operation.type === "pour.delete" && !after) raw.pours.push({ primitiveId: operation.primitiveId });
    else if (operation.type === "poured.delete" && !after) raw.poured.push({ primitiveId: operation.primitiveId });
  }
  const fingerprint = after ? `sha256:${"b".repeat(64)}` : plan.baselineFingerprint;
  return {
    state: {
      schemaVersion: 2, kind: "easyeda-current-state", fingerprint,
      project: { uuid: plan.projectUuid }, document: { uuid: plan.pcbUuid },
      axes: { drc: { status: "CAPTURED" } }, raw,
    },
    returnedIds,
  };
}

function selfTest() {
  for (const mode of ["route", "repair", "placement", "outline", "copper"]) {
    const plan = planFixture(mode);
    const before = stateFixture(plan, false);
    const after = stateFixture(plan, true);
    const transactionResult = {
      schemaVersion: 2, kind: "easyeda-transaction-result", status: "TRANSACTION_APPLIED_PENDING_REOPEN",
      plan: { transactionId: plan.transactionId, mode },
      immediateResult: {
        operationResults: plan.operations.map((operation) => ({
          operationId: operation.operationId,
          returnedId: after.returnedIds[operation.operationId] || null,
        })),
      },
    };
    const input = {
      plan, before: before.state, after: after.state, transactionResult,
      budget: { kind: "easyeda-execution-budget-check", status: "CONTINUE", executeAllowed: true },
      checkpoint: { kind: "easyeda-native-checkpoint-check", status: "NATIVE_CHECKPOINT_MATCH", executeAllowed: true, liveFingerprint: plan.baselineFingerprint },
      ledger: { kind: "easyeda-gate-ledger", decision: "CLEARED" },
      postPlacement: {
        kind: "easyeda-placement-audit", schemaVersion: 3, status: "PLACEMENT_CLEAR_FOR_ROUTING",
        design: { fingerprint: after.state.fingerprint },
        coverage: { requiredAxes: [...PLACEMENT_REQUIRED_AXES], checkedAxes: [...PLACEMENT_REQUIRED_AXES], unverifiedAxes: [] },
      },
    };
    const verified = analyzeGateVerification(input);
    if (verified.status !== "TRANSACTION_VERIFIED") throw new Error(`${mode} transaction did not verify: ${JSON.stringify(verified)}`);
    const residue = structuredClone(input);
    residue.after.raw.lines.push({ primitiveId: "unexpected-residue" });
    const rejected = analyzeGateVerification(residue);
    if (rejected.status !== "TRANSACTION_REJECTED") throw new Error(`${mode} residue was not rejected`);
  }
  process.stdout.write(`${JSON.stringify({ status: "TRANSACTION_VERIFIER_SELF_TEST_CLEAR", modes: 5, residueRejected: true })}\n`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) return selfTest();
    const planPath = path.resolve(options.plan);
    const inputPlan = await readJsonFile(planPath, "plan");
    const validation = validateTransactionPlan(inputPlan);
    if (!validation.executable) throw new Error([...validation.errors, ...validation.warnings].join("; "));
    const plan = validation.plan;
    const artifactRoot = resolveArtifactRoot(planPath, plan.artifactRoot);
    const loadControl = (field, label) => readJsonFile(resolveContainedPath(artifactRoot, plan.controls[field], label), label);
    const [before, after, transactionResult, budget, checkpoint, ledger, postPlacement, operationLog] = await Promise.all([
      readJsonFile(resolveContainedPath(artifactRoot, options.before, "before state"), "before state"),
      readJsonFile(resolveContainedPath(artifactRoot, options.after, "after state"), "after state"),
      readJsonFile(resolveContainedPath(artifactRoot, options.transactionResult, "transaction result"), "transaction result"),
      loadControl("budgetCheck", "budget check"),
      loadControl("checkpointCheck", "checkpoint check"),
      loadControl("gateLedgerCheck", "gate ledger check"),
      loadControl("postPlacementReport", "post-transaction placement report"),
      loadControl("operationLog", "operation log"),
    ]);
    const result = analyzeGateVerification({ plan, before, after, transactionResult, budget, checkpoint, ledger, postPlacement });
    const output = await writeContainedJson(artifactRoot, options.output, result);
    const verifiedAt = new Date();
    await appendOperationEntry(
      resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log"),
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
        startedAt: verifiedAt.toISOString(), endedAt: verifiedAt.toISOString(), durationMs: 0,
        attemptDisposition: result.status === "TRANSACTION_VERIFIED" ? "ACCEPTED" : result.status === "TRANSACTION_REJECTED" ? "REJECTED" : "UNKNOWN",
        gateProgress: result.status === "TRANSACTION_VERIFIED" ? "CLOSED" : result.status === "TRANSACTION_REJECTED" ? "BLOCKED" : "NO_CHANGE",
        evidence: [output],
      },
    );
    process.stdout.write(`${JSON.stringify({ status: result.status, mode: result.mode, output })}\n`);
    process.exitCode = result.status === "TRANSACTION_VERIFIED" ? 0 : 2;
  } catch (error) {
    cliFailure(error, "easyeda-transaction-gate-verification");
  }
}

if (isMain(import.meta.url)) await main();

export { analyzeGateVerification, parseArgs };

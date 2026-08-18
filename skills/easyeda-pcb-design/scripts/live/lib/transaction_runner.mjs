import { existsSync } from "node:fs";
import path from "node:path";

import { collectorCode } from "../../audits/easyeda_design_audit.mjs";
import {
  designFingerprint,
  notAFabricationReleaseMessage,
} from "../../lib/audit_common.mjs";
import { analyzeOperationLog } from "../easyeda_gate_ledger.mjs";
import { expectedDeltas } from "./operation_registry.mjs";
import {
  browserTransactionCode,
  stableHash,
  validateTransactionPlan,
} from "./transaction_plan.mjs";
import {
  executeEasyedaCode,
  readJsonFile,
  resolveArtifactRoot,
  resolveContainedPath,
  withTransactionControlDefaults,
  writeContainedJson,
} from "./tool_runtime.mjs";
import { appendToolLogEntry, loadOperationLog } from "./operation_log.mjs";

const PLACEMENT_REQUIRED_AXES = Object.freeze([
  "boardMechanicalContainment",
  "viaPadGeometry",
  "componentOccupancy",
  "criticalPlacementZones",
  "humanInterfaces",
  "externalInterfacesAndBom",
]);
const PRE_PLACEMENT_MODES = new Set(["route", "repair", "copper"]);

function usage() {
  return `Usage:
  node scripts/live/easyeda_transaction.mjs --plan FILE [--output FILE] [options]

Options:
  --execute             Apply the validated transaction. Default is dry-run.
  --bridge-port PORT    Use one verified EasyEDA bridge port.
  --window-id ID        Required when multiple windows are connected.
  --self-test           Run deterministic plan/control tests for every mode.

The schema-2 plan selects route, repair, placement, outline, or copper mode.
Execution requires current evidence and stops at
TRANSACTION_APPLIED_PENDING_REOPEN. It never closes a gate by itself.
`;
}

function parseArgs(argv) {
  const options = { plan: null, output: null, execute: false, bridgePort: null, windowId: null, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--plan") options.plan = next();
    else if (option === "--output") options.output = next();
    else if (option === "--execute") options.execute = true;
    else if (option === "--bridge-port") options.bridgePort = Number(next());
    else if (option === "--window-id") options.windowId = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!options.selfTest) {
    if (!options.plan) throw new Error("--plan is required");
  }
  if (options.bridgePort !== null && (!Number.isInteger(options.bridgePort) || options.bridgePort < 1 || options.bridgePort > 65535)) {
    throw new Error("--bridge-port must be an integer from 1 to 65535");
  }
  return options;
}

async function loadControlRecords(plan, artifactRoot) {
  const load = (field, label) => readJsonFile(
    resolveContainedPath(artifactRoot, plan.controls[field], label),
    label,
  );
  const operationLogPath = resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log");
  const [checkpoint, authorization, ledger, operationLog, prePlacement] = await Promise.all([
    load("checkpointCheck", "checkpoint check"),
    load("authorizationRecord", "authorization record"),
    load("gateLedgerCheck", "gate ledger check"),
    loadOperationLog(operationLogPath),
    PRE_PLACEMENT_MODES.has(plan.mode)
      ? load("prePlacementReport", "pre-transaction placement report")
      : Promise.resolve(null),
  ]);
  return analyzeControlRecords(plan, { checkpoint, authorization, ledger, operationLog, prePlacement });
}

function placementIsCurrentAndClear(placement, fingerprint) {
  const required = new Set(placement?.coverage?.requiredAxes || []);
  const checked = new Set(placement?.coverage?.checkedAxes || []);
  return Boolean(
    placement?.kind === "easyeda-placement-audit" &&
      placement?.schemaVersion === 3 &&
      placement?.status === "PLACEMENT_CLEAR_FOR_ROUTING" &&
      placement?.design?.fingerprint === fingerprint &&
      !placement?.coverage?.unverifiedAxes?.length &&
      PLACEMENT_REQUIRED_AXES.every((axis) => required.has(axis) && checked.has(axis))
  );
}

function analyzeControlRecords(plan, records) {
  const { checkpoint, authorization, ledger, operationLog, prePlacement } = records;
  const reasons = [];
  const checkpointMatches = Boolean(
    checkpoint?.executeAllowed === true &&
      checkpoint?.liveFingerprint === plan.baselineFingerprint &&
      (
        (checkpoint?.kind === "easyeda-native-checkpoint-check" && checkpoint?.status === "NATIVE_CHECKPOINT_MATCH") ||
        (checkpoint?.kind === "easyeda-native-restore-check" && checkpoint?.status === "NATIVE_RESTORE_MATCH" && checkpoint?.restoreReady === true)
      ),
  );
  if (!checkpointMatches) reasons.push("native checkpoint does not match the plan baseline fingerprint");
  else if (plan.targetClass === "PRODUCTION" && checkpoint.kind !== "easyeda-native-restore-check") {
    reasons.push("production transaction requires a non-production probe restore check");
  }
  if (
    authorization?.kind !== "easyeda-operation-authorization" ||
    authorization?.schemaVersion !== 1 ||
    authorization?.authorized !== true ||
    authorization?.transactionId !== plan.transactionId ||
    authorization?.mode !== plan.mode ||
    !["USER_OWNED", "AI_DEDICATED"].includes(authorization?.authorizationProfile) ||
    typeof authorization?.userWords !== "string" ||
    !authorization.userWords.trim() ||
    !Number.isFinite(Date.parse(authorization.authorizedAt))
  ) reasons.push("operation authorization is absent, stale, or not bound to this transaction and mode");
  if (plan.targetClass === "PRODUCTION" && authorization?.targetClass !== "PRODUCTION") {
    reasons.push("production transaction lacks production-specific authorization");
  }
  if (ledger?.kind !== "easyeda-gate-ledger" || ledger?.decision !== "CLEARED") {
    reasons.push("gate ledger integrity is not CLEARED before the transaction");
  }
  if (PRE_PLACEMENT_MODES.has(plan.mode) && !placementIsCurrentAndClear(prePlacement, plan.baselineFingerprint)) {
    reasons.push("pre-transaction placement and native board-containment coverage is not current and clear");
  }
  const operationLogAnalysis = analyzeOperationLog(operationLog || {});
  if (operationLogAnalysis.status !== "VERIFIED") {
    reasons.push(`operation log is not valid schemaVersion 2 telemetry: ${operationLogAnalysis.reason}`);
  }
  return { cleared: reasons.length === 0, reasons, ...records };
}

function dryRunResult(validation, controls = null) {
  let code = null;
  if (validation.executable) code = browserTransactionCode(validation.plan);
  const clear = validation.executable && controls?.cleared === true;
  return {
    schemaVersion: 2,
    kind: "easyeda-transaction-result",
    status: clear ? "PLAN_VALID" : "PLAN_BLOCKED",
    executeAllowed: clear,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    planFingerprint: stableHash(validation.plan),
    plan: validation.summary,
    errors: validation.errors,
    warnings: validation.warnings,
    controlReasons: controls?.reasons || [],
    browserCodeFingerprint: code ? stableHash(code) : null,
    nextAction: validation.executable
      ? "Execute only after all named control artifacts clear; then save/reopen and verify the exact normalized delta."
      : "Author or correct a native schemaVersion 2 immutable transaction plan before any live call.",
  };
}

function operationFixtures(mode) {
  if (mode === "route") return [
    {
      operationId: "op-line-create", type: "line.create", net: "USB_DP", layerEnum: "TOP",
      startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 8, primitiveLock: false,
    },
    {
      operationId: "op-via-create", type: "via.create", net: "USB_DP", x: 100, y: 0,
      holeDiameter: 12, diameter: 24, viaType: "VIA", primitiveLock: false,
    },
  ];
  if (mode === "repair") return [
    { operationId: "op-line-delete", type: "line.delete", primitiveId: "line-1" },
    { operationId: "op-via-delete", type: "via.delete", primitiveId: "via-1" },
    { operationId: "op-polyline-delete", type: "polyline.delete", primitiveId: "polyline-1" },
  ];
  if (mode === "placement") return [{
    operationId: "op-component-modify", type: "component.modify", primitiveId: "component-1", designator: "U1",
    expectedBefore: { x: 10, y: 20, rotation: 0, layerEnum: "TOP", primitiveLock: false },
    changes: { x: 30, y: 40, rotation: 90, layerEnum: "TOP", primitiveLock: false },
  }];
  if (mode === "outline") return [{
    operationId: "op-outline-create", type: "polyline.create", net: "", layerEnum: "BOARD_OUTLINE",
    polygon: [0, 0, "L", 100, 0, 100, 100, 0, 100, 0, 0],
    expectedPoints: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
    lineWidth: 10, primitiveLock: true,
  }];
  return [
    { operationId: "op-pour-delete", type: "pour.delete", primitiveId: "pour-1" },
    { operationId: "op-poured-delete", type: "poured.delete", primitiveId: "poured-1" },
  ];
}

function planFixture(mode = "route") {
  const operations = operationFixtures(mode);
  const destructive = !["route", "outline"].includes(mode);
  return withTransactionControlDefaults({
    schemaVersion: 2,
    kind: "easyeda-transaction-plan",
    mode,
    transactionId: `tx-${mode}-1`,
    gate: mode === "route" ? "ROUTING_CANARY_CLEAR" : "BOUNDED_GEOMETRY_TRANSACTION",
    attemptFamily: `${mode}-fixture`,
    attemptIndex: 1,
    targetClass: "NON_PRODUCTION_PROBE",
    projectUuid: "project-1",
    pcbUuid: "pcb-1",
    baselineFingerprint: `sha256:${"a".repeat(64)}`,
    artifactRoot: ".",
    operations,
    rollback: { strategy: destructive ? "RESTORE_CHECKPOINT" : "DELETE_CREATED_IDS" },
    acceptance: {
      expectedDeltas: expectedDeltas(operations),
      requireDetailedDrc: true,
      requirePlacementClearAfter: true,
      requireBaselineRecoveryOnReject: true,
    },
    controls: {
      checkpointCheck: "evidence/readbacks/checkpoint.json",
      authorizationRecord: "evidence/readbacks/authorization.json",
      gateLedgerCheck: "evidence/readbacks/gate-ledger-check.json",
      prePlacementReport: "evidence/audits/placement-before.json",
      postPlacementReport: "evidence/audits/placement-after.json",
      operationLog: "evidence/readbacks/operation-log.json",
    },
  }, "pcb");
}

function controlFixture(plan) {
  const fingerprint = plan.baselineFingerprint;
  return {
    checkpoint: { kind: "easyeda-native-checkpoint-check", status: "NATIVE_CHECKPOINT_MATCH", executeAllowed: true, liveFingerprint: fingerprint },
    authorization: {
      kind: "easyeda-operation-authorization", schemaVersion: 1, authorized: true,
      transactionId: plan.transactionId, mode: plan.mode, authorizationProfile: "USER_OWNED",
      userWords: "authorize this bounded non-production probe", authorizedAt: "2026-08-15T00:00:00.000Z",
      targetClass: "NON_PRODUCTION_PROBE",
    },
    ledger: { kind: "easyeda-gate-ledger", decision: "CLEARED" },
    prePlacement: {
      kind: "easyeda-placement-audit", schemaVersion: 3, status: "PLACEMENT_CLEAR_FOR_ROUTING",
      design: { fingerprint },
      coverage: { requiredAxes: [...PLACEMENT_REQUIRED_AXES], checkedAxes: [...PLACEMENT_REQUIRED_AXES], unverifiedAxes: [] },
    },
    operationLog: { schemaVersion: 2, appendOnly: true, entries: [] },
  };
}

function selfTest() {
  if (parseArgs(["--plan", "plan.json"]).output !== null) {
    throw new Error("transaction CLI did not keep --output optional");
  }
  for (const mode of ["route", "repair", "placement", "outline", "copper"]) {
    const plan = planFixture(mode);
    const validation = validateTransactionPlan(plan);
    if (!validation.executable) throw new Error(`valid ${mode} plan failed: ${validation.errors.join("; ")}`);
    if (!validation.plan.controls.transactionResult || !validation.plan.controls.verificationReport) {
      throw new Error(`${mode} plan did not derive result and verification paths`);
    }
    const controls = analyzeControlRecords(plan, controlFixture(plan));
    if (!controls.cleared) throw new Error(`valid ${mode} controls blocked: ${controls.reasons.join("; ")}`);
    if (!browserTransactionCode(plan).includes("operationResults")) throw new Error(`${mode} browser program was not generated`);
  }
  const unsafe = planFixture("route");
  unsafe.operations.push({ operationId: "bad-delete", type: "line.delete", primitiveId: "line-1" });
  unsafe.acceptance.expectedDeltas = expectedDeltas(unsafe.operations);
  unsafe.rollback.strategy = "RESTORE_CHECKPOINT";
  if (validateTransactionPlan(unsafe).valid) throw new Error("route mode accepted a destructive operation");
  const escaping = planFixture("route");
  escaping.controls.operationLog = "../operation-log.json";
  if (validateTransactionPlan(escaping).valid) throw new Error("plan accepted an escaping control path");
  const legacy = {
    schemaVersion: 1, kind: "easyeda-route-transaction-plan", transactionId: "legacy", gate: "ROUTING_CANARY_CLEAR",
    attemptFamily: "legacy", attemptIndex: 1, targetClass: "NON_PRODUCTION_PROBE", projectUuid: "p", pcbUuid: "b",
    baselineFingerprint: `sha256:${"a".repeat(64)}`, net: "N", creates: { lines: [], vias: [] }, deletes: { lineIds: [], viaIds: [] },
    acceptance: { expectedLineDelta: 0, expectedViaDelta: 0, requireDetailedDrc: true }, controls: {},
  };
  if (validateTransactionPlan(legacy).executable) throw new Error("legacy plan unexpectedly remained executable");
  const production = planFixture("route");
  production.targetClass = "PRODUCTION";
  const records = controlFixture(production);
  records.authorization.targetClass = "PRODUCTION";
  if (!analyzeControlRecords(production, records).reasons.some((reason) => /probe restore/.test(reason))) {
    throw new Error("production controls accepted an untested native checkpoint");
  }
  process.stdout.write(`${JSON.stringify({ status: "TOOLS_LIBRARY_SELF_TEST_CLEAR", modes: 5, schemaVersion: 2 })}\n`);
}

async function runTransactionCli(argv = process.argv.slice(2)) {
  const toolStartedAt = new Date();
  const options = parseArgs(argv);
  if (options.selfTest) return selfTest();
  const planPath = path.resolve(options.plan);
  const input = await readJsonFile(planPath, "transaction plan");
  const validation = validateTransactionPlan(input);
  const artifactRoot = validation.plan?.artifactRoot
    ? resolveArtifactRoot(planPath, validation.plan.artifactRoot)
    : path.dirname(planPath);
  const outputRelative = options.output || validation.plan?.controls?.[
    options.execute ? "transactionResult" : "planCheck"
  ] || `evidence/readbacks/transaction-${options.execute ? "result" : "plan-check"}.json`;
  const outputPath = resolveContainedPath(artifactRoot, outputRelative, "transaction output");
  if (existsSync(outputPath)) throw new Error(`transaction output already exists: ${outputPath}`);
  let controls = null;
  if (validation.executable) controls = await loadControlRecords(validation.plan, artifactRoot);
  let result = dryRunResult(validation, controls);
  if (options.execute) {
    if (!validation.executable || !controls?.cleared) {
      throw new Error([...validation.errors, ...validation.warnings, ...(controls?.reasons || [])].join("; "));
    }
    const plan = validation.plan;
    const preflightCall = await executeEasyedaCode({
      code: collectorCode({ includeDrc: false }),
      bridgePort: options.bridgePort,
      windowId: options.windowId,
    });
    if (!preflightCall.response.success) throw new Error(preflightCall.response.error || "EasyEDA preflight readback failed");
    const preflight = preflightCall.response.result;
    const preflightFingerprint = designFingerprint(preflight);
    if (preflight?.project?.uuid !== plan.projectUuid || preflight?.document?.uuid !== plan.pcbUuid || preflightFingerprint !== plan.baselineFingerprint) {
      throw new Error("saved/reopened live revision no longer matches the transaction baseline");
    }
    const startedAt = new Date();
    let call;
    try {
      call = await executeEasyedaCode({
        code: browserTransactionCode(plan),
        bridgePort: preflightCall.bridge.port,
        windowId: preflightCall.windowId,
      });
    } catch (error) {
      call = { bridge: preflightCall.bridge, windowId: preflightCall.windowId, response: { success: false, error: error.message } };
    }
    const endedAt = new Date();
    const committed = call.response.success && call.response.result?.saveReturned === true;
    const operationLogPath = resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log");
    const operationEntry = {
      id: `${plan.transactionId}-apply-${plan.attemptIndex}`,
      transactionId: plan.transactionId,
      gate: plan.gate,
      attemptFamily: plan.attemptFamily,
      attemptIndex: plan.attemptIndex,
      operation: `${plan.mode} transaction: ${JSON.stringify(validation.summary.operationCounts)}`,
      outcome: committed ? "COMMITTED" : "UNKNOWN_TIMEOUT",
      semanticReadback: committed
        ? "API transaction returned after save; saved/reopened verification remains pending"
        : "transaction or save outcome requires immediate semantic readback before any retry",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      attemptDisposition: "UNKNOWN",
      gateProgress: "NO_CHANGE",
      evidence: [outputPath],
    };
    const commonResult = {
      ...result,
      executeAllowed: false,
      appliedAt: new Date().toISOString(),
      bridge: { port: call.bridge.port, windowId: call.response.windowId || call.windowId },
      preflight: { projectUuid: preflight.project.uuid, pcbUuid: preflight.document.uuid, fingerprint: preflightFingerprint },
      immediateResult: call.response.result || null,
      executionError: call.response.success ? null : call.response.error || "EasyEDA transaction failed",
    };
    result = committed
      ? {
          ...commonResult,
          status: "TRANSACTION_APPLIED_PENDING_REOPEN",
          nextAction: "Preserve this result, save/switch/reopen the PCB, collect full current state, rerun the post-placement audit, and run verify_gate.mjs.",
        }
      : {
          ...commonResult,
          status: "TRANSACTION_OUTCOME_UNKNOWN",
          nextAction: "Stop. Capture current state immediately; do not retry. Restore the verified checkpoint or prove the exact semantic outcome before another attempt.",
        };
    await writeContainedJson(artifactRoot, outputRelative, result);
    await appendToolLogEntry(operationLogPath, {
      ...operationEntry,
      tool: "easyeda_transaction.mjs",
      authorizationUserWords: controls.authorization.userWords,
      evidence: [
        outputPath,
        resolveContainedPath(artifactRoot, plan.controls.authorizationRecord, "authorization record"),
      ],
    });
  }
  const output = outputPath;
  if (!options.execute) {
    await writeContainedJson(artifactRoot, outputRelative, result);
    const endedAt = new Date();
    const plan = validation.plan;
    await appendToolLogEntry(
      resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log"),
      {
        tool: "easyeda_transaction.mjs",
        transactionId: plan.transactionId,
        gate: plan.gate,
        attemptFamily: plan.attemptFamily,
        attemptIndex: plan.attemptIndex,
        operation: `${plan.mode} transaction plan validation`,
        outcome: "READ_ONLY",
        semanticReadback: `${result.status}; authorization recorded exactly as supplied by the bound authorization artifact`,
        startedAt: toolStartedAt,
        endedAt,
        attemptDisposition: result.status === "PLAN_VALID" ? "ACCEPTED" : "REJECTED",
        gateProgress: result.status === "PLAN_VALID" ? "NO_CHANGE" : "BLOCKED",
        authorizationUserWords: controls?.authorization?.userWords || null,
        evidence: [
          outputPath,
          resolveContainedPath(artifactRoot, plan.controls.authorizationRecord, "authorization record"),
        ],
      },
    );
  }
  process.stdout.write(`${JSON.stringify({ status: result.status, mode: validation.plan?.mode || null, output })}\n`);
  process.exitCode = ["PLAN_BLOCKED", "TRANSACTION_OUTCOME_UNKNOWN"].includes(result.status) ? 2 : 0;
}

async function appendPlanToolFailure(argv, error, startedAt, tool) {
  try {
    const planIndex = argv.indexOf("--plan");
    if (planIndex < 0 || !argv[planIndex + 1]) return null;
    const planPath = path.resolve(argv[planIndex + 1]);
    const input = await readJsonFile(planPath, "transaction plan");
    const plan = validateTransactionPlan(input).plan;
    if (!plan?.artifactRoot || !plan?.controls?.operationLog) return null;
    const artifactRoot = resolveArtifactRoot(planPath, plan.artifactRoot);
    return appendToolLogEntry(
      resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log"),
      {
        tool,
        transactionId: plan.transactionId,
        gate: plan.gate,
        attemptFamily: plan.attemptFamily,
        attemptIndex: plan.attemptIndex,
        operation: `${tool} failed before producing an accepted report`,
        outcome: "READ_ONLY",
        semanticReadback: `tool error: ${error instanceof Error ? error.message : String(error)}`,
        startedAt,
        endedAt: new Date(),
        attemptDisposition: "REJECTED",
        gateProgress: "BLOCKED",
        evidence: [],
      },
    );
  } catch {
    return null;
  }
}

export {
  PLACEMENT_REQUIRED_AXES,
  analyzeControlRecords,
  appendPlanToolFailure,
  dryRunResult,
  parseArgs,
  planFixture,
  runTransactionCli,
  selfTest,
};

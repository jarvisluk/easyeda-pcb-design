import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  designFingerprint,
  fetchJson,
  findBridge,
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
  resolveWindow,
} from "../../lib/audit_common.mjs";
import { collectorCode } from "../../audits/easyeda_design_audit.mjs";
import { analyzeOperationLog } from "../easyeda_gate_ledger.mjs";
import { browserTransactionCode, stableHash, validateTransactionPlan } from "./transaction_plan.mjs";

const PLACEMENT_REQUIRED_AXES = [
  "boardMechanicalContainment",
  "viaPadGeometry",
  "componentOccupancy",
  "criticalPlacementZones",
  "humanInterfaces",
  "externalInterfacesAndBom",
];

function usage(mode) {
  return `Usage:
  node scripts/live/${mode}_transaction.mjs --plan FILE --output FILE [options]

Options:
  --execute             Apply the validated transaction. Default is dry-run.
  --bridge-port PORT    Use one verified EasyEDA bridge port.
  --window-id ID        Required when multiple windows are connected.
  --self-test           Run deterministic plan/control tests.

Execution requires CONTINUE budget evidence, matching checkpoint evidence
(NATIVE_RESTORE_MATCH for production), current ledger/placement evidence, and
an exact-transaction authorization record. An applied transaction remains
PENDING_SAVED_REOPENED_READBACK and closes no gate.
`;
}

function parseArgs(argv, mode) {
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
      process.stdout.write(usage(mode));
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!options.selfTest) {
    if (!options.plan) throw new Error("--plan is required");
    if (!options.output) throw new Error("--output is required");
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

async function validateControls(plan, baseDir) {
  const resolve = (file) => path.resolve(baseDir, file);
  const [budget, checkpoint, authorization, ledger, placement, operationLog] = await Promise.all([
    readJson(resolve(plan.controls.budgetCheck), "budget check"),
    readJson(resolve(plan.controls.checkpointCheck), "checkpoint check"),
    readJson(resolve(plan.controls.authorizationRecord), "authorization record"),
    readJson(resolve(plan.controls.gateLedgerCheck), "gate ledger check"),
    readJson(resolve(plan.controls.placementReport), "placement report"),
    readJson(resolve(plan.controls.operationLog), "operation log"),
  ]);
  return analyzeControlRecords(
    plan,
    budget,
    checkpoint,
    authorization,
    ledger,
    placement,
    operationLog,
  );
}

function analyzeControlRecords(
  plan,
  budget,
  checkpoint,
  authorization,
  ledger,
  placement,
  operationLog,
) {
  const reasons = [];
  if (budget.kind !== "easyeda-execution-budget-check" || budget.status !== "CONTINUE" || budget.executeAllowed !== true) {
    reasons.push("execution budget does not permit another transaction");
  }
  const checkpointMatches = Boolean(
    checkpoint.executeAllowed === true &&
      checkpoint.liveFingerprint === plan.baselineFingerprint &&
      (
        (checkpoint.kind === "easyeda-native-checkpoint-check" &&
          checkpoint.status === "NATIVE_CHECKPOINT_MATCH") ||
        (checkpoint.kind === "easyeda-native-restore-check" &&
          checkpoint.status === "NATIVE_RESTORE_MATCH" &&
          checkpoint.restoreReady === true)
      ),
  );
  if (!checkpointMatches) {
    reasons.push("native checkpoint does not match the plan baseline fingerprint");
  } else if (
    plan.targetClass === "PRODUCTION" &&
    checkpoint.kind !== "easyeda-native-restore-check"
  ) {
    reasons.push("production transaction requires a non-production probe restore check");
  }
  if (
    authorization.kind !== "easyeda-operation-authorization" ||
    authorization.schemaVersion !== 1 ||
    authorization.authorized !== true ||
    authorization.transactionId !== plan.transactionId ||
    !["USER_OWNED", "AI_DEDICATED"].includes(authorization.authorizationProfile) ||
    typeof authorization.userWords !== "string" ||
    !authorization.userWords.trim() ||
    !Number.isFinite(Date.parse(authorization.authorizedAt))
  ) reasons.push("operation authorization is absent, stale, or not bound to this transaction");
  if (
    plan.targetClass === "PRODUCTION" &&
    authorization.targetClass !== "PRODUCTION"
  ) reasons.push("production transaction lacks production-specific authorization");
  if (ledger.kind !== "easyeda-gate-ledger" || ledger.decision !== "CLEARED") {
    reasons.push("gate ledger integrity is not CLEARED before the transaction");
  }
  const placementRequired = new Set(placement?.coverage?.requiredAxes || []);
  const placementChecked = new Set(placement?.coverage?.checkedAxes || []);
  if (
    placement?.kind !== "easyeda-placement-audit" ||
    placement?.schemaVersion !== 3 ||
    placement?.status !== "PLACEMENT_CLEAR_FOR_ROUTING" ||
    placement?.design?.fingerprint !== plan.baselineFingerprint ||
    placement?.coverage?.unverifiedAxes?.length ||
    PLACEMENT_REQUIRED_AXES.some(
      (axis) => !placementRequired.has(axis) || !placementChecked.has(axis),
    )
  ) reasons.push("placement and native board-containment coverage is not current and clear");
  const operationLogAnalysis = analyzeOperationLog(operationLog);
  if (operationLogAnalysis.status !== "VERIFIED") {
    reasons.push(`operation log is not valid schemaVersion 2 telemetry: ${operationLogAnalysis.reason}`);
  }
  return {
    cleared: reasons.length === 0,
    reasons,
    budget,
    checkpoint,
    authorization,
    ledger,
    placement,
    operationLog,
  };
}

async function appendOperationEntry(file, log, entry) {
  if (log.entries.some((item) => item.id === entry.id)) {
    throw new Error(`operation log already contains entry id ${entry.id}`);
  }
  const updated = { ...log, entries: [...log.entries, entry] };
  await writeFile(file, `${JSON.stringify(updated, null, 2)}\n`);
}

function dryRunResult(plan, mode, validation, controls = null) {
  const code = validation.valid ? browserTransactionCode(plan, mode) : null;
  return {
    schemaVersion: 1,
    kind: `easyeda-${mode}-transaction-result`,
    status: validation.valid && (!controls || controls.cleared)
      ? "PLAN_VALID"
      : "PLAN_BLOCKED",
    executeAllowed: validation.valid && controls?.cleared === true,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    planFingerprint: stableHash(plan),
    plan: validation.summary,
    errors: validation.errors,
    controlReasons: controls?.reasons || [],
    browserCodeFingerprint: code ? stableHash(code) : null,
    nextAction: validation.valid
      ? "Run only with --execute after all control artifacts clear; then save/reopen and verify the exact delta."
      : "Correct the immutable JSON plan before any live call.",
  };
}

function planFixture(mode) {
  return {
    schemaVersion: 1,
    kind: `easyeda-${mode}-transaction-plan`,
    transactionId: "tx-route-1",
    gate: "ROUTING_CANARY_CLEAR",
    attemptFamily: "route-usb",
    attemptIndex: 1,
    targetClass: "NON_PRODUCTION_PROBE",
    projectUuid: "project-1",
    pcbUuid: "pcb-1",
    baselineFingerprint: `sha256:${"a".repeat(64)}`,
    net: "USB_DP",
    creates: {
      lines: [{
        layerEnum: "TOP", startX: 0, startY: 0, endX: 100,
        endY: 0, lineWidth: 8, primitiveLock: false,
      }],
      vias: [],
    },
    deletes: { lineIds: [], viaIds: [] },
    acceptance: { expectedLineDelta: 1, expectedViaDelta: 0, requireDetailedDrc: true },
    controls: {
      budgetCheck: "budget.json",
      checkpointCheck: "checkpoint.json",
      authorizationRecord: "authorization.json",
      gateLedgerCheck: "gate-ledger-check.json",
      placementReport: "placement-report.json",
      operationLog: "operation-log.json",
    },
  };
}

function selfTest(mode) {
  const fixturePlan = planFixture(mode);
  const valid = validateTransactionPlan(fixturePlan, mode);
  if (!valid.valid) throw new Error(`valid ${mode} plan failed: ${valid.errors.join("; ")}`);
  const invalid = planFixture(mode);
  invalid.creates.lines[0].lineWidth = 0;
  if (validateTransactionPlan(invalid, mode).valid) throw new Error("zero-width route plan cleared");
  const escaping = planFixture(mode);
  escaping.controls.operationLog = "../operation-log.json";
  if (validateTransactionPlan(escaping, mode).valid) {
    throw new Error("transaction plan accepted an escaping control path");
  }
  if (mode === "route") {
    const deleting = planFixture(mode);
    deleting.deletes.lineIds = ["line-1"];
    deleting.acceptance.expectedLineDelta = 0;
    if (validateTransactionPlan(deleting, mode).valid) throw new Error("route plan accepted deletion");
  } else {
    const repair = planFixture(mode);
    repair.deletes.lineIds = ["line-1"];
    repair.acceptance.expectedLineDelta = 0;
    if (!validateTransactionPlan(repair, mode).valid) throw new Error("bounded repair plan rejected exact-id deletion");
  }
  const fingerprint = fixturePlan.baselineFingerprint;
  const budget = { kind: "easyeda-execution-budget-check", status: "CONTINUE", executeAllowed: true };
  const checkpoint = {
    kind: "easyeda-native-checkpoint-check",
    status: "NATIVE_CHECKPOINT_MATCH",
    executeAllowed: true,
    liveFingerprint: fingerprint,
  };
  const authorization = {
    kind: "easyeda-operation-authorization",
    schemaVersion: 1,
    authorized: true,
    transactionId: fixturePlan.transactionId,
    authorizationProfile: "USER_OWNED",
    userWords: "authorize this bounded non-production probe",
    authorizedAt: "2026-08-15T00:00:00.000Z",
    targetClass: "NON_PRODUCTION_PROBE",
  };
  const ledger = { kind: "easyeda-gate-ledger", decision: "CLEARED" };
  const placement = {
    kind: "easyeda-placement-audit",
    schemaVersion: 3,
    status: "PLACEMENT_CLEAR_FOR_ROUTING",
    design: { fingerprint },
    coverage: {
      requiredAxes: [...PLACEMENT_REQUIRED_AXES],
      checkedAxes: [...PLACEMENT_REQUIRED_AXES],
      unverifiedAxes: [],
    },
  };
  const operationLog = { schemaVersion: 2, appendOnly: true, entries: [] };
  const controls = analyzeControlRecords(
    fixturePlan,
    budget,
    checkpoint,
    authorization,
    ledger,
    placement,
    operationLog,
  );
  if (!controls.cleared) throw new Error(`valid controls blocked: ${controls.reasons.join("; ")}`);
  const production = structuredClone(fixturePlan);
  production.targetClass = "PRODUCTION";
  const productionAuthorization = { ...authorization, targetClass: "PRODUCTION" };
  const productionBlocked = analyzeControlRecords(
    production,
    budget,
    checkpoint,
    productionAuthorization,
    ledger,
    placement,
    operationLog,
  );
  if (!productionBlocked.reasons.some((item) => /probe restore/.test(item))) {
    throw new Error("production controls accepted an untested native checkpoint");
  }
  const restore = {
    kind: "easyeda-native-restore-check",
    status: "NATIVE_RESTORE_MATCH",
    executeAllowed: true,
    restoreReady: true,
    liveFingerprint: fingerprint,
  };
  const productionClear = analyzeControlRecords(
    production,
    budget,
    restore,
    productionAuthorization,
    ledger,
    placement,
    operationLog,
  );
  if (!productionClear.cleared) {
    throw new Error(`verified production controls blocked: ${productionClear.reasons.join("; ")}`);
  }
  process.stdout.write(`${JSON.stringify({ mode, valid: true, unsafePlanRejected: true, productionRestoreRequired: true })}\n`);
}

async function runTransactionCli(mode, argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv, mode);
    if (options.selfTest) return selfTest(mode);
    const planPath = path.resolve(options.plan);
    const plan = await readJson(planPath, "transaction plan");
    const validation = validateTransactionPlan(plan, mode);
    let controls = null;
    if (validation.valid) controls = await validateControls(plan, path.dirname(planPath));
    let result = dryRunResult(plan, mode, validation, controls);
    if (options.execute) {
      if (!validation.valid || !controls?.cleared) {
        throw new Error([...validation.errors, ...(controls?.reasons || [])].join("; "));
      }
      const bridge = await findBridge(options.bridgePort || undefined);
      const windowId = await resolveWindow(bridge, options.windowId || undefined);
      const preflight = await fetchJson(
        `http://127.0.0.1:${bridge.port}/execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: collectorCode({ includeDrc: false }), windowId }),
        },
        120_000,
      );
      if (!preflight.success) throw new Error(preflight.error || "EasyEDA preflight readback failed");
      const preflightFingerprint = designFingerprint(preflight.result);
      if (
        preflight.result?.project?.uuid !== plan.projectUuid ||
        preflight.result?.document?.uuid !== plan.pcbUuid ||
        preflightFingerprint !== plan.baselineFingerprint
      ) {
        throw new Error("saved/reopened live revision no longer matches the transaction baseline");
      }
      const transactionStartedAt = new Date();
      let response;
      try {
        response = await fetchJson(
          `http://127.0.0.1:${bridge.port}/execute`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: browserTransactionCode(plan, mode), windowId }),
          },
          120_000,
        );
      } catch (error) {
        response = { success: false, error: error.message };
      }
      const endedAt = new Date();
      const committed = response.success && response.result?.saveReturned === true;
      const operationEntry = {
        id: `${plan.transactionId}-apply-${plan.attemptIndex}`,
        transactionId: plan.transactionId,
        gate: plan.gate,
        attemptFamily: plan.attemptFamily,
        attemptIndex: plan.attemptIndex,
        operation: `${mode} transaction: ${validation.summary.createLineCount} line create(s), ${validation.summary.createViaCount} via create(s), ${validation.summary.deleteLineCount} line delete(s), ${validation.summary.deleteViaCount} via delete(s)`,
        outcome: committed ? "COMMITTED" : "UNKNOWN_TIMEOUT",
        semanticReadback: committed
          ? "API transaction returned after save; saved/reopened verification remains pending"
          : "transaction or save outcome requires immediate semantic readback before any retry",
        startedAt: transactionStartedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - transactionStartedAt.getTime(),
        attemptDisposition: "UNKNOWN",
        gateProgress: "NO_CHANGE",
        evidence: [options.output],
      };
      await appendOperationEntry(
        path.resolve(path.dirname(planPath), plan.controls.operationLog),
        controls.operationLog,
        operationEntry,
      );
      if (!response.success) throw new Error(response.error || "EasyEDA transaction failed");
      if (!committed) throw new Error("EasyEDA transaction did not return a successful PCB save");
      result = {
        ...result,
        status: "TRANSACTION_APPLIED_PENDING_REOPEN",
        executeAllowed: false,
        appliedAt: new Date().toISOString(),
        bridge: { port: bridge.port, windowId: response.windowId },
        preflight: {
          projectUuid: preflight.result.project.uuid,
          pcbUuid: preflight.result.document.uuid,
          fingerprint: preflightFingerprint,
        },
        immediateResult: response.result,
        nextAction:
          "Preserve this result, save/switch/reopen the PCB, collect current state with detailed DRC, and run verify_gate.mjs. Do not expand the route or repair yet.",
      };
    }
    const output = resolveSafeOutputPath(options.output);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "PLAN_BLOCKED" ? 2 : 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, kind: `easyeda-${mode}-transaction-result`, fabricationRelease: false }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

export {
  analyzeControlRecords,
  appendOperationEntry,
  dryRunResult,
  parseArgs,
  planFixture,
  runTransactionCli,
  selfTest,
  validateControls,
};

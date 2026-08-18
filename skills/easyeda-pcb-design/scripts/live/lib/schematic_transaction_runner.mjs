import { existsSync } from "node:fs";
import path from "node:path";

import { notAFabricationReleaseMessage } from "../../lib/audit_common.mjs";
import { analyzeOperationLog } from "../easyeda_gate_ledger.mjs";
import { appendToolLogEntry, loadOperationLog } from "./operation_log.mjs";
import { finalizeSchematicRaw, schematicCollectorCode, schematicFingerprint, stableHash } from "./schematic_state.mjs";
import {
  schematicBrowserTransactionCode,
  schematicCapabilityFingerprint,
  schematicPlanFixture,
  validateSchematicTransactionPlan,
} from "./schematic_transaction_plan.mjs";
import {
  executeEasyedaCode,
  readJsonFile,
  resolveArtifactRoot,
  resolveContainedPath,
  writeContainedJson,
} from "./tool_runtime.mjs";

function usage() {
  return `Usage:
  node scripts/live/easyeda_schematic_transaction.mjs --plan FILE [--output FILE] [options]

Options:
  --execute             Apply the validated transaction. Default is dry-run.
  --bridge-port PORT    Use one verified EasyEDA bridge port.
  --window-id ID        Required when multiple windows are connected.
  --self-test           Run deterministic schematic transaction tests.

The tool accepts schema-2 easyeda-schematic-transaction-plan JSON. It writes its
own operation-log entry on validation, application, rejection, and supported failure.
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
    throw new Error("--bridge-port must be an integer from 1 through 65535");
  }
  return options;
}

function stateMatchesPlan(state, plan) {
  return Boolean(
    state?.kind === "easyeda-schematic-state" && state?.schemaVersion === 2 &&
    state?.project?.uuid === plan.projectUuid && state?.schematic?.uuid === plan.schematicUuid &&
    state?.document?.uuid === plan.schematicPageUuid && state?.fingerprint === plan.baselineFingerprint &&
    state?.reopen?.performed === true && state?.axes?.erc?.status === "CAPTURED" && state?.axes?.erc?.stable === true,
  );
}

function analyzeControls(plan, records) {
  const reasons = [];
  const { authorization, ledger, preEditState, rollbackCheck, capabilityCheck, operationLog } = records;
  if (
    authorization?.kind !== "easyeda-operation-authorization" || authorization?.schemaVersion !== 1 ||
    authorization?.authorized !== true || authorization?.transactionId !== plan.transactionId ||
    authorization?.mode !== plan.mode || authorization?.targetClass !== plan.targetClass ||
    !["USER_OWNED", "AI_DEDICATED"].includes(authorization?.authorizationProfile) ||
    typeof authorization?.userWords !== "string" || !authorization.userWords.trim() ||
    !Number.isFinite(Date.parse(authorization.authorizedAt))
  ) reasons.push("operation authorization is absent, stale, or not bound to the schematic transaction");
  if (ledger?.kind !== "easyeda-gate-ledger" || ledger?.decision !== "CLEARED" || ledger?.projectUuid !== plan.projectUuid) {
    reasons.push("gate ledger integrity/project binding is not CLEARED");
  }
  if (!stateMatchesPlan(preEditState, plan)) reasons.push("saved/reopened pre-edit schematic state does not match the plan baseline");
  const destructive = plan.operations.some((operation) => ["schematic.component.modify", "schematic.component.delete", "schematic.wire.modify", "schematic.wire.delete"].includes(operation.type));
  if (destructive && !(
    rollbackCheck?.kind === "easyeda-schematic-restore-check" &&
    rollbackCheck?.status === "SCHEMATIC_RESTORE_MATCH" && rollbackCheck?.executeAllowed === true &&
    rollbackCheck?.restoreReady === true && rollbackCheck?.liveFingerprint === plan.baselineFingerprint
  )) reasons.push("destructive schematic transaction lacks a matching separately verified native restore check");
  if (plan.targetClass === "PRODUCTION" && !(
    capabilityCheck?.kind === "easyeda-schematic-transaction-gate-verification" &&
    capabilityCheck?.status === "SCHEMATIC_TRANSACTION_VERIFIED" && capabilityCheck?.targetClass === "NON_PRODUCTION_PROBE" &&
    capabilityCheck?.capabilityFingerprint === schematicCapabilityFingerprint(plan)
  )) reasons.push("production schematic transaction lacks a matching non-production capability qualification");
  const logAnalysis = analyzeOperationLog(operationLog || {});
  if (logAnalysis.status !== "VERIFIED") reasons.push(`operation log is not valid schema-2 tool telemetry: ${logAnalysis.reason}`);
  return { cleared: reasons.length === 0, reasons, ...records };
}

async function loadControls(plan, artifactRoot) {
  const read = (field, label) => readJsonFile(resolveContainedPath(artifactRoot, plan.controls[field], label), label);
  const destructive = plan.operations.some((operation) => ["schematic.component.modify", "schematic.component.delete", "schematic.wire.modify", "schematic.wire.delete"].includes(operation.type));
  const operationLog = await loadOperationLog(resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log"));
  const [authorization, ledger, preEditState, rollbackCheck, capabilityCheck] = await Promise.all([
    read("authorizationRecord", "authorization record"),
    read("gateLedgerCheck", "gate ledger check"),
    read("preEditState", "pre-edit schematic state"),
    destructive ? read("rollbackCheck", "schematic rollback check") : Promise.resolve(null),
    plan.targetClass === "PRODUCTION" ? read("capabilityCheck", "schematic capability check") : Promise.resolve(null),
  ]);
  return analyzeControls(plan, { authorization, ledger, preEditState, rollbackCheck, capabilityCheck, operationLog });
}

function dryRunResult(validation, controls) {
  const clear = validation.executable && controls?.cleared === true;
  const code = validation.executable ? schematicBrowserTransactionCode(validation.plan) : null;
  return {
    schemaVersion: 2, kind: "easyeda-schematic-transaction-result",
    status: clear ? "SCHEMATIC_PLAN_VALID" : "SCHEMATIC_PLAN_BLOCKED",
    executeAllowed: clear, fabricationRelease: false, notAFabricationRelease: notAFabricationReleaseMessage(),
    planFingerprint: validation.executable ? stableHash(validation.plan) : null,
    plan: validation.summary, errors: validation.errors, controlReasons: controls?.reasons || [],
    browserCodeFingerprint: code ? stableHash(code) : null,
    nextAction: clear
      ? "Execute the same immutable plan, then use inspect_schematic_state.mjs with ERC and verify_schematic_gate.mjs."
      : "Correct the immutable plan or named control evidence before any live write.",
  };
}

function schematicControlFixture(plan) {
  return {
    authorization: {
      kind: "easyeda-operation-authorization", schemaVersion: 1, authorized: true,
      transactionId: plan.transactionId, mode: plan.mode, targetClass: plan.targetClass,
      authorizationProfile: "USER_OWNED", userWords: "authorize schematic fixture", authorizedAt: "2026-08-17T00:00:00.000Z",
    },
    ledger: { kind: "easyeda-gate-ledger", decision: "CLEARED", projectUuid: plan.projectUuid },
    preEditState: {
      schemaVersion: 2, kind: "easyeda-schematic-state", project: { uuid: plan.projectUuid },
      schematic: { uuid: plan.schematicUuid }, document: { uuid: plan.schematicPageUuid },
      fingerprint: plan.baselineFingerprint, reopen: { performed: true }, axes: { erc: { status: "CAPTURED", stable: true } },
    },
    rollbackCheck: {
      kind: "easyeda-schematic-restore-check", status: "SCHEMATIC_RESTORE_MATCH",
      executeAllowed: true, restoreReady: true, liveFingerprint: plan.baselineFingerprint,
    },
    capabilityCheck: {
      kind: "easyeda-schematic-transaction-gate-verification", status: "SCHEMATIC_TRANSACTION_VERIFIED",
      targetClass: "NON_PRODUCTION_PROBE", capabilityFingerprint: schematicCapabilityFingerprint(plan),
    },
    operationLog: { schemaVersion: 2, appendOnly: true, entries: [] },
  };
}

function selfTest() {
  if (parseArgs(["--plan", "plan.json"]).output !== null) {
    throw new Error("schematic transaction CLI did not keep --output optional");
  }
  for (const mode of ["new-construction", "existing-schematic-modification"]) {
    const plan = schematicPlanFixture(mode);
    const validation = validateSchematicTransactionPlan(plan);
    if (!validation.executable) throw new Error(`valid ${mode} plan failed: ${validation.errors.join("; ")}`);
    const controls = analyzeControls(plan, schematicControlFixture(plan));
    if (!controls.cleared) throw new Error(`valid ${mode} controls failed: ${controls.reasons.join("; ")}`);
    if (!schematicBrowserTransactionCode(plan).includes("sch_Document.save")) throw new Error(`${mode} code omitted schematic save`);
  }
  const unsafe = schematicPlanFixture("new-construction");
  unsafe.operations.push({
    operationId: "delete-wire", type: "schematic.wire.delete", primitiveId: "wire-1",
    expectedBefore: { line: [0, 0, 10, 0], net: "N" },
  });
  unsafe.acceptance.expectedDeltas.wires = -1;
  if (validateSchematicTransactionPlan(unsafe).valid) throw new Error("new-construction plan accepted a destructive operation");
  const production = schematicPlanFixture("new-construction");
  production.targetClass = "PRODUCTION";
  const controls = schematicControlFixture(production);
  controls.capabilityCheck = null;
  if (!analyzeControls(production, controls).reasons.some((reason) => /capability/.test(reason))) throw new Error("production plan accepted missing capability evidence");
  const lineType = schematicPlanFixture("existing-schematic-modification");
  lineType.operations = [{
    operationId: "style-wire", type: "schematic.wire.modify", primitiveId: "wire-1",
    expectedBefore: { line: [0, 0, 10, 0], net: "N", lineType: 0 }, changes: { lineTypeEnum: "DASHED" },
  }];
  lineType.acceptance.expectedDeltas = { components: 0, wires: 0, annotations: 0 };
  lineType.acceptance.pinNetAssertions = [{ uniqueId: "U1-STABLE", pinNumber: "1", net: "N" }];
  if (!validateSchematicTransactionPlan(lineType).valid) throw new Error("valid wire line-type modification was rejected");
  const partialCreateCode = schematicBrowserTransactionCode(schematicPlanFixture("new-construction"));
  if (!partialCreateCode.includes("CREATED_PENDING_IDENTITY") || !partialCreateCode.includes("transactionError")) {
    throw new Error("schematic create code does not preserve partial-operation evidence");
  }
  process.stdout.write("easyeda schematic transaction self-test passed\n");
}

async function runSchematicTransactionCli(argv = process.argv.slice(2)) {
  const toolStartedAt = new Date();
  const options = parseArgs(argv);
  if (options.selfTest) return selfTest();
  const planPath = path.resolve(options.plan);
  const input = await readJsonFile(planPath, "schematic transaction plan");
  const validation = validateSchematicTransactionPlan(input);
  const artifactRoot = validation.plan?.artifactRoot ? resolveArtifactRoot(planPath, validation.plan.artifactRoot) : path.dirname(planPath);
  const outputRelative = options.output || validation.plan?.controls?.[
    options.execute ? "transactionResult" : "planCheck"
  ] || `evidence/readbacks/schematic-transaction-${options.execute ? "result" : "plan-check"}.json`;
  const outputPath = resolveContainedPath(artifactRoot, outputRelative, "schematic transaction output");
  if (existsSync(outputPath)) throw new Error(`schematic transaction output already exists: ${outputPath}`);
  let controls = null;
  if (validation.executable) controls = await loadControls(validation.plan, artifactRoot);
  let result = dryRunResult(validation, controls);
  const operationLogPath = validation.plan?.controls?.operationLog
    ? resolveContainedPath(artifactRoot, validation.plan.controls.operationLog, "operation log")
    : null;
  if (options.execute) {
    if (!validation.executable || !controls?.cleared) throw new Error([...validation.errors, ...(controls?.reasons || [])].join("; "));
    const plan = validation.plan;
    const preflightCall = await executeEasyedaCode({
      code: schematicCollectorCode({ schematicPageUuid: plan.schematicPageUuid, schematicUuid: plan.schematicUuid, includeErc: false }),
      bridgePort: options.bridgePort, windowId: options.windowId, timeoutMs: 35_000,
    });
    if (!preflightCall.response.success || !preflightCall.response.result) throw new Error(preflightCall.response.error || "schematic preflight failed");
    const preflightRaw = finalizeSchematicRaw(preflightCall.response.result);
    const liveFingerprint = schematicFingerprint(preflightRaw);
    if (preflightRaw.project?.uuid !== plan.projectUuid || preflightRaw.schematic?.uuid !== plan.schematicUuid || preflightRaw.document?.uuid !== plan.schematicPageUuid || liveFingerprint !== plan.baselineFingerprint) {
      throw new Error("live schematic revision no longer matches the immutable plan baseline");
    }
    const startedAt = new Date();
    let call;
    try {
      call = await executeEasyedaCode({
        code: schematicBrowserTransactionCode(plan), bridgePort: preflightCall.bridge.port,
        windowId: preflightCall.windowId, timeoutMs: 120_000,
      });
    } catch (error) {
      call = { bridge: preflightCall.bridge, windowId: preflightCall.windowId, response: { success: false, error: error.message } };
    }
    const endedAt = new Date();
    const committed = call.response.success && call.response.result?.saveReturned === true;
    result = {
      ...result, executeAllowed: false,
      status: committed ? "SCHEMATIC_TRANSACTION_APPLIED_PENDING_REOPEN" : "SCHEMATIC_TRANSACTION_OUTCOME_UNKNOWN",
      appliedAt: endedAt.toISOString(), bridge: { port: call.bridge.port, windowId: call.response.windowId || call.windowId },
      preflight: { projectUuid: preflightRaw.project.uuid, schematicUuid: preflightRaw.schematic.uuid, schematicPageUuid: preflightRaw.document.uuid, fingerprint: liveFingerprint },
      immediateResult: call.response.result || null,
      executionError: call.response.success ? null : call.response.error || "schematic transaction failed",
      nextAction: committed
        ? "Switch away, reopen the page, capture full state with repeated ERC, and run verify_schematic_gate.mjs."
        : "Stop. Capture saved/reopened state immediately; do not retry until outcome and rollback are resolved.",
    };
    await writeContainedJson(artifactRoot, outputRelative, result);
    await appendToolLogEntry(operationLogPath, {
      id: `${plan.transactionId}-apply-${plan.attemptIndex}`, tool: "easyeda_schematic_transaction.mjs",
      transactionId: plan.transactionId, gate: plan.gate, attemptFamily: plan.attemptFamily, attemptIndex: plan.attemptIndex,
      operation: `${plan.mode} schematic transaction: ${JSON.stringify(validation.summary.operationCounts)}`,
      outcome: committed ? "COMMITTED" : "UNKNOWN_TIMEOUT",
      semanticReadback: committed ? "schematic save returned true; saved/reopened verification remains pending" : "write or save outcome requires immediate readback before any retry",
      startedAt, endedAt, attemptDisposition: "UNKNOWN", gateProgress: "NO_CHANGE",
      authorizationUserWords: controls.authorization.userWords,
      evidence: [outputPath, resolveContainedPath(artifactRoot, plan.controls.authorizationRecord, "authorization record")],
    });
  } else {
    await writeContainedJson(artifactRoot, outputRelative, result);
    const endedAt = new Date();
    if (operationLogPath) await appendToolLogEntry(operationLogPath, {
      tool: "easyeda_schematic_transaction.mjs", transactionId: validation.plan.transactionId,
      gate: validation.plan.gate, attemptFamily: validation.plan.attemptFamily, attemptIndex: validation.plan.attemptIndex,
      operation: `${validation.plan.mode} schematic transaction plan validation`, outcome: "READ_ONLY",
      semanticReadback: `${result.status}; immutable plan and controls evaluated`, startedAt: toolStartedAt, endedAt,
      attemptDisposition: result.status === "SCHEMATIC_PLAN_VALID" ? "ACCEPTED" : "REJECTED",
      gateProgress: result.status === "SCHEMATIC_PLAN_VALID" ? "NO_CHANGE" : "BLOCKED",
      authorizationUserWords: controls?.authorization?.userWords || null, evidence: [outputPath],
    });
  }
  process.stdout.write(`${JSON.stringify({ status: result.status, mode: validation.plan?.mode || null, output: outputPath })}\n`);
  process.exitCode = ["SCHEMATIC_PLAN_BLOCKED", "SCHEMATIC_TRANSACTION_OUTCOME_UNKNOWN"].includes(result.status) ? 2 : 0;
}

async function appendSchematicPlanFailure(argv, error, startedAt, tool) {
  try {
    const planIndex = argv.indexOf("--plan");
    if (planIndex < 0 || !argv[planIndex + 1]) return null;
    const planPath = path.resolve(argv[planIndex + 1]);
    const plan = (await readJsonFile(planPath, "schematic transaction plan"));
    if (!plan?.artifactRoot || !plan?.controls?.operationLog) return null;
    const artifactRoot = resolveArtifactRoot(planPath, plan.artifactRoot);
    return appendToolLogEntry(resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log"), {
      tool, transactionId: plan.transactionId, gate: plan.gate, attemptFamily: plan.attemptFamily, attemptIndex: plan.attemptIndex,
      operation: `${tool} failed before producing an accepted report`, outcome: "READ_ONLY",
      semanticReadback: `tool error: ${error instanceof Error ? error.message : String(error)}`,
      startedAt, endedAt: new Date(), attemptDisposition: "REJECTED", gateProgress: "BLOCKED", evidence: [],
    });
  } catch {
    return null;
  }
}

export {
  analyzeControls,
  appendSchematicPlanFailure,
  dryRunResult,
  loadControls,
  parseArgs,
  runSchematicTransactionCli,
  schematicControlFixture,
  selfTest,
  stateMatchesPlan,
};

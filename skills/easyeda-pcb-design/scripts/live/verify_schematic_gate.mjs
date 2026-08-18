#!/usr/bin/env node

import path from "node:path";

import { notAFabricationReleaseMessage } from "../lib/audit_common.mjs";
import { analyzeOperationLog } from "./easyeda_gate_ledger.mjs";
import { appendToolLogEntry, loadOperationLog } from "./lib/operation_log.mjs";
import {
  normalizeComponent,
  normalizeWire,
  stableHash,
  stableValue,
} from "./lib/schematic_state.mjs";
import {
  SCHEMATIC_COLLECTIONS,
  SCHEMATIC_OPERATION_DEFINITIONS,
  schematicCapabilityFingerprint,
  schematicPlanFixture,
  validateSchematicTransactionPlan,
} from "./lib/schematic_transaction_plan.mjs";
import { appendSchematicPlanFailure } from "./lib/schematic_transaction_runner.mjs";
import {
  cliFailure,
  isMain,
  readJsonFile,
  resolveArtifactRoot,
  resolveContainedPath,
  writeContainedJson,
} from "./lib/tool_runtime.mjs";

const CLI_STARTED_AT = new Date();

function usage() {
  return `Usage:
  node scripts/live/verify_schematic_gate.mjs --plan FILE [options]
  node scripts/live/verify_schematic_gate.mjs --self-test

The plan supplies default before/after/result/report paths. Explicit path
options remain available as overrides.

The verifier requires saved/switch/reopened schematic states with repeated ERC.
It checks exact primitive deltas, untouched identity, JLCEDA pin-net assertions,
and tool-owned transaction evidence, then appends its own operation-log entry.
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
  if (!options.selfTest && !options.plan) throw new Error("--plan is required");
  return options;
}

function equal(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function ids(items) {
  return new Set((items || []).map((item) => item?.primitiveId).filter(Boolean));
}

function itemMap(items) {
  return new Map((items || []).map((item) => [item?.primitiveId, item]).filter(([id]) => id));
}

function componentMatches(actual, operation) {
  if (!actual) return false;
  if (operation.type === "schematic.component.create") {
    const expected = {
      designator: operation.identity.designator, uniqueId: operation.identity.uniqueId,
      x: operation.x, y: operation.y,
      rotation: operation.rotation ?? 0, mirror: operation.mirror ?? false,
      addIntoBom: operation.addIntoBom ?? true, addIntoPcb: operation.addIntoPcb ?? true,
    };
    for (const field of ["name", "manufacturer", "manufacturerId", "supplier", "supplierId"]) {
      if (operation.identity[field] !== undefined) expected[field] = operation.identity[field];
    }
    return Object.entries(expected).every(([field, value]) => equal(actual[field], value));
  }
  if (operation.type === "schematic.component.modify") {
    return Object.entries(operation.changes || {}).filter(([field]) => field !== "otherProperty").every(([field, value]) => equal(actual[field], value));
  }
  return false;
}

function wireMatches(actual, operation) {
  if (!actual) return false;
  const lineTypes = { SOLID: 0, DASHED: 1, DOTTED: 2, DOT_DASHED: 3 };
  const values = operation.type === "schematic.wire.create" ? operation : operation.changes || {};
  if (values.line !== undefined && !equal(actual.line, values.line)) return false;
  if (values.net !== undefined && actual.net !== values.net) return false;
  if (values.color !== undefined && actual.color !== values.color) return false;
  if (values.lineWidth !== undefined && actual.lineWidth !== values.lineWidth) return false;
  if (values.lineTypeEnum !== undefined && actual.lineType !== (values.lineTypeEnum == null ? null : lineTypes[values.lineTypeEnum])) return false;
  return true;
}

function netlistComponentMap(state) {
  return state?.raw?.netlist?.components && typeof state.raw.netlist.components === "object"
    ? state.raw.netlist.components
    : {};
}

function assertionNet(component, pinNumber) {
  const pin = component?.pinInfoMap?.[String(pinNumber)] ?? component?.pinInfoMap?.[pinNumber];
  return typeof pin?.net === "string" ? pin.net : null;
}

function analyzeVerification({ plan: inputPlan, before, after, transactionResult, ledger, rollbackCheck, operationLog }) {
  const validation = validateSchematicTransactionPlan(inputPlan);
  const plan = validation.plan;
  const failures = [];
  const unverified = [];
  if (!validation.executable) failures.push(...validation.errors.map((error) => `plan: ${error}`));
  for (const [name, state] of [["before", before], ["after", after]]) {
    if (state?.kind !== "easyeda-schematic-state" || state?.schemaVersion !== 2 || state?.raw?.kind !== "schematic") failures.push(`${name} must be schema-2 easyeda-schematic-state evidence`);
    if (state?.reopen?.performed !== true) unverified.push(`${name} state lacks a tool-observed switch/reopen cycle`);
    if (state?.axes?.erc?.status !== "CAPTURED" || state?.axes?.erc?.stable !== true) unverified.push(`${name} state lacks stable three-sample detailed ERC`);
  }
  if (before?.fingerprint !== plan?.baselineFingerprint) failures.push("before-state fingerprint does not match the plan baseline");
  for (const state of [before, after]) if (
    state?.project?.uuid !== plan?.projectUuid || state?.schematic?.uuid !== plan?.schematicUuid || state?.document?.uuid !== plan?.schematicPageUuid
  ) failures.push("project, parent schematic, or page UUID changed across the transaction");
  if (
    transactionResult?.kind !== "easyeda-schematic-transaction-result" || transactionResult?.schemaVersion !== 2 ||
    transactionResult?.status !== "SCHEMATIC_TRANSACTION_APPLIED_PENDING_REOPEN" ||
    transactionResult?.plan?.transactionId !== plan?.transactionId || transactionResult?.plan?.mode !== plan?.mode ||
    transactionResult?.planFingerprint !== stableHash(plan)
  ) failures.push("schematic transaction application result is absent or bound to another plan/mode");
  const logAnalysis = analyzeOperationLog(operationLog);
  if (logAnalysis.status !== "VERIFIED") failures.push(`operation log is not valid tool telemetry: ${logAnalysis.reason}`);
  const applyEntry = (operationLog?.entries || []).find((entry) => entry.id === `${plan?.transactionId}-apply-${plan?.attemptIndex}`);
  if (!(
    applyEntry?.recordedBy === "TOOL" && applyEntry?.tool === "easyeda_schematic_transaction.mjs" &&
    applyEntry?.transactionId === plan?.transactionId && applyEntry?.outcome === "COMMITTED"
  )) failures.push("tool-owned committed application log entry is absent or mismatched");
  if (ledger?.kind !== "easyeda-gate-ledger" || ledger?.decision !== "CLEARED" || ledger?.projectUuid !== plan?.projectUuid) {
    unverified.push("gate ledger integrity/project binding is not CLEARED");
  }
  const destructive = (plan?.operations || []).some((operation) => SCHEMATIC_OPERATION_DEFINITIONS[operation.type]?.destructive);
  if (destructive && !(
    rollbackCheck?.kind === "easyeda-schematic-restore-check" && rollbackCheck?.status === "SCHEMATIC_RESTORE_MATCH" &&
    rollbackCheck?.executeAllowed === true && rollbackCheck?.restoreReady === true && rollbackCheck?.liveFingerprint === plan?.baselineFingerprint
  )) failures.push("destructive schematic transaction lacked matching native restore evidence");

  const operationResults = new Map((transactionResult?.immediateResult?.operationResults || []).map((item) => [item.operationId, item]));
  const delta = {};
  for (const collection of SCHEMATIC_COLLECTIONS) {
    const beforeItems = before?.raw?.[collection] || [];
    const afterItems = after?.raw?.[collection] || [];
    const beforeIds = ids(beforeItems);
    const afterIds = ids(afterItems);
    delta[collection] = afterItems.length - beforeItems.length;
    if (delta[collection] !== plan?.acceptance?.expectedDeltas?.[collection]) failures.push(`${collection} count delta differs from the immutable plan`);
    const relevant = (plan?.operations || []).filter((operation) => SCHEMATIC_OPERATION_DEFINITIONS[operation.type]?.collection === collection);
    const deleted = new Set(relevant.filter((operation) => SCHEMATIC_OPERATION_DEFINITIONS[operation.type].delta === -1).map((operation) => operation.primitiveId));
    const modified = new Set(relevant.filter((operation) => SCHEMATIC_OPERATION_DEFINITIONS[operation.type].delta === 0).map((operation) => operation.primitiveId));
    const created = new Set();
    for (const operation of relevant.filter((item) => SCHEMATIC_OPERATION_DEFINITIONS[item.type].delta === 1)) {
      const returnedId = operationResults.get(operation.operationId)?.returnedId;
      if (!returnedId) failures.push(`create operation lacks a returned primitive ID: ${operation.operationId}`);
      else created.add(returnedId);
      const actual = afterItems.find((item) => item.primitiveId === returnedId);
      const matches = collection === "components" ? componentMatches(actual, operation) : wireMatches(actual, operation);
      if (!matches) failures.push(`created ${collection} primitive does not match after reopen: ${operation.operationId}`);
    }
    for (const primitiveId of beforeIds) {
      if (deleted.has(primitiveId)) {
        if (afterIds.has(primitiveId)) failures.push(`planned ${collection} deletion remains: ${primitiveId}`);
      } else if (!afterIds.has(primitiveId)) failures.push(`unplanned ${collection} removal: ${primitiveId}`);
    }
    for (const primitiveId of afterIds) if (!beforeIds.has(primitiveId) && !created.has(primitiveId)) failures.push(`unplanned ${collection} residue: ${primitiveId}`);
    const beforeById = itemMap(beforeItems);
    const afterById = itemMap(afterItems);
    for (const primitiveId of beforeIds) {
      if (deleted.has(primitiveId) || modified.has(primitiveId)) continue;
      const normalize = collection === "components" ? normalizeComponent : collection === "wires" ? normalizeWire : (value) => value;
      if (!equal(normalize(beforeById.get(primitiveId)), normalize(afterById.get(primitiveId)))) failures.push(`untouched ${collection} primitive changed: ${primitiveId}`);
    }
    for (const operation of relevant.filter((item) => SCHEMATIC_OPERATION_DEFINITIONS[item.type].delta === 0)) {
      const actual = afterById.get(operation.primitiveId);
      const matches = collection === "components" ? componentMatches(actual, operation) : wireMatches(actual, operation);
      if (!matches) failures.push(`modified ${collection} primitive does not match after reopen: ${operation.operationId}`);
    }
  }

  const afterNetlist = netlistComponentMap(after);
  const liveDesignators = new Set();
  const liveUniqueIds = new Set();
  for (const component of after?.raw?.components || []) {
    if (!component.designator || liveDesignators.has(component.designator)) failures.push(`missing or duplicate live designator: ${component.designator || "<empty>"}`);
    if (!component.uniqueId || liveUniqueIds.has(component.uniqueId)) failures.push(`missing or duplicate live uniqueId: ${component.uniqueId || "<empty>"}`);
    liveDesignators.add(component.designator);
    liveUniqueIds.add(component.uniqueId);
    const netlistRecord = afterNetlist[component.uniqueId];
    if (!netlistRecord || netlistRecord.props?.Designator !== component.designator || netlistRecord.props?.["Unique ID"] !== component.uniqueId) {
      failures.push(`live/netlist identity mismatch: ${component.designator || component.primitiveId}`);
    }
  }
  if (Object.keys(afterNetlist).length !== (after?.raw?.components || []).length) failures.push("live component count differs from JLCEDA netlist component count");
  for (const assertion of plan?.acceptance?.pinNetAssertions || []) {
    if (assertionNet(afterNetlist[assertion.uniqueId], assertion.pinNumber) !== assertion.net) {
      failures.push(`pin-net assertion failed: ${assertion.uniqueId} pin ${assertion.pinNumber} expected ${assertion.net || "<empty>"}`);
    }
  }
  const affectedUniqueIds = new Set([
    ...(plan?.operations || []).map((operation) => operation.identity?.uniqueId || operation.expectedBefore?.uniqueId).filter(Boolean),
    ...(plan?.acceptance?.pinNetAssertions || []).map((assertion) => assertion.uniqueId),
  ]);
  const beforeNetlist = netlistComponentMap(before);
  for (const [uniqueId, record] of Object.entries(beforeNetlist)) {
    if (!affectedUniqueIds.has(uniqueId) && !equal(record, afterNetlist[uniqueId])) failures.push(`untouched netlist component changed: ${uniqueId}`);
  }
  const beforeErc = new Set((before?.axes?.erc?.leaves || []).map((leaf) => stableHash(leaf)));
  const newErc = (after?.axes?.erc?.leaves || []).filter((leaf) => !beforeErc.has(stableHash(leaf)));
  if (newErc.length) failures.push(`saved/reopened ERC contains ${newErc.length} new unexplained finding(s)`);

  const status = failures.length ? "SCHEMATIC_TRANSACTION_REJECTED" : unverified.length ? "SCHEMATIC_TRANSACTION_UNVERIFIED" : "SCHEMATIC_TRANSACTION_VERIFIED";
  return {
    schemaVersion: 2, kind: "easyeda-schematic-transaction-gate-verification", status,
    gateMayAdvance: status === "SCHEMATIC_TRANSACTION_VERIFIED", fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(), transactionId: plan?.transactionId || null,
    mode: plan?.mode || null, targetClass: plan?.targetClass || null,
    capabilityFingerprint: schematicCapabilityFingerprint(plan),
    planFingerprint: plan ? stableHash(plan) : null,
    capabilityQualified: status === "SCHEMATIC_TRANSACTION_VERIFIED" && plan?.targetClass === "NON_PRODUCTION_PROBE",
    beforeFingerprint: before?.fingerprint || null, afterFingerprint: after?.fingerprint || null,
    delta, failures, unverified, newErc,
    nextAction: status === "SCHEMATIC_TRANSACTION_VERIFIED"
      ? "Record this report at the owning schematic gate; identity and presentation gates remain independently required."
      : "Stop expansion and apply the declared created-ID cleanup or verified native restore before another attempt.",
  };
}

function stateFixture(plan, after = false) {
  const components = [];
  const wires = [];
  const netlist = { components: {} };
  const returnedIds = {};
  for (const operation of plan.operations) {
    if (operation.type === "schematic.component.create" && after) {
      const returnedId = `${operation.operationId}-new`;
      returnedIds[operation.operationId] = returnedId;
      components.push({
        primitiveId: returnedId, designator: operation.identity.designator, uniqueId: operation.identity.uniqueId,
        name: operation.identity.name || "", x: operation.x, y: operation.y, rotation: operation.rotation ?? 0,
        mirror: operation.mirror ?? false, addIntoBom: operation.addIntoBom ?? true, addIntoPcb: operation.addIntoPcb ?? true,
        manufacturer: operation.identity.manufacturer || "", manufacturerId: operation.identity.manufacturerId || "",
        supplier: operation.identity.supplier || "", supplierId: operation.identity.supplierId || "",
      });
      netlist.components[operation.identity.uniqueId] = { props: { Designator: operation.identity.designator, "Unique ID": operation.identity.uniqueId }, pinInfoMap: {} };
    }
  }
  return {
    schemaVersion: 2, kind: "easyeda-schematic-state", fingerprint: after ? `sha256:${"b".repeat(64)}` : plan.baselineFingerprint,
    project: { uuid: plan.projectUuid }, schematic: { uuid: plan.schematicUuid }, document: { uuid: plan.schematicPageUuid },
    reopen: { performed: true }, axes: { erc: { status: "CAPTURED", stable: true, leaves: [] } },
    raw: { kind: "schematic", components, annotations: [], wires, netlist }, returnedIds,
  };
}

function selfTest() {
  if (parseArgs(["--plan", "plan.json"]).plan !== "plan.json") {
    throw new Error("schematic verifier did not accept plan-only invocation");
  }
  const plan = schematicPlanFixture("new-construction");
  const before = stateFixture(plan, false);
  const after = stateFixture(plan, true);
  const result = {
    schemaVersion: 2, kind: "easyeda-schematic-transaction-result", status: "SCHEMATIC_TRANSACTION_APPLIED_PENDING_REOPEN",
    planFingerprint: stableHash(plan), plan: { transactionId: plan.transactionId, mode: plan.mode },
    immediateResult: { operationResults: plan.operations.map((operation) => ({ operationId: operation.operationId, returnedId: after.returnedIds[operation.operationId] })) },
  };
  const operationLog = { schemaVersion: 2, appendOnly: true, entries: [{
    id: `${plan.transactionId}-apply-${plan.attemptIndex}`, transactionId: plan.transactionId, gate: plan.gate,
    attemptFamily: plan.attemptFamily, attemptIndex: plan.attemptIndex, operation: "schematic fixture apply",
    outcome: "COMMITTED", semanticReadback: "fixture committed", startedAt: "2026-08-17T00:00:00.000Z",
    endedAt: "2026-08-17T00:00:00.000Z", durationMs: 0, attemptDisposition: "UNKNOWN",
    gateProgress: "NO_CHANGE", evidence: ["result.json"], recordedBy: "TOOL", tool: "easyeda_schematic_transaction.mjs",
  }] };
  const verified = analyzeVerification({ plan, before, after, transactionResult: result, operationLog, ledger: { kind: "easyeda-gate-ledger", decision: "CLEARED", projectUuid: plan.projectUuid } });
  if (verified.status !== "SCHEMATIC_TRANSACTION_VERIFIED" || !verified.capabilityQualified) throw new Error(`valid schematic fixture failed: ${verified.failures.join("; ")}`);
  const residue = structuredClone(after);
  residue.raw.wires.push({ primitiveId: "unexpected-wire", net: "N", line: [0, 0, 10, 0] });
  const rejected = analyzeVerification({ plan, before, after: residue, transactionResult: result, operationLog, ledger: { kind: "easyeda-gate-ledger", decision: "CLEARED", projectUuid: plan.projectUuid } });
  if (rejected.status !== "SCHEMATIC_TRANSACTION_REJECTED") throw new Error("unplanned schematic residue was accepted");
  process.stdout.write("verify schematic gate self-test passed\n");
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.selfTest) return selfTest();
  const planPath = path.resolve(options.plan);
  const inputPlan = await readJsonFile(planPath, "schematic transaction plan");
  const validation = validateSchematicTransactionPlan(inputPlan);
  if (!validation.executable) throw new Error(validation.errors.join("; "));
  const plan = validation.plan;
  const artifactRoot = plan.artifactRoot ? resolveArtifactRoot(planPath, plan.artifactRoot) : path.dirname(planPath);
  const beforeRelative = options.before || plan.controls.preEditState;
  const afterRelative = options.after || plan.controls.postEditState;
  const transactionResultRelative = options.transactionResult || plan.controls.transactionResult;
  const outputRelative = options.output || plan.controls.verificationReport;
  const [before, after, transactionResult, ledger, rollbackCheck, operationLog] = await Promise.all([
    readJsonFile(resolveContainedPath(artifactRoot, beforeRelative, "before state"), "before state"),
    readJsonFile(resolveContainedPath(artifactRoot, afterRelative, "after state"), "after state"),
    readJsonFile(resolveContainedPath(artifactRoot, transactionResultRelative, "transaction result"), "transaction result"),
    readJsonFile(resolveContainedPath(artifactRoot, plan.controls.gateLedgerCheck, "gate ledger check"), "gate ledger check"),
    plan.rollback?.strategy === "RESTORE_CHECKPOINT"
      ? readJsonFile(resolveContainedPath(artifactRoot, plan.controls.rollbackCheck, "rollback check"), "rollback check")
      : Promise.resolve(null),
    loadOperationLog(resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log")),
  ]);
  const report = analyzeVerification({ plan, before, after, transactionResult, ledger, rollbackCheck, operationLog });
  const output = await writeContainedJson(artifactRoot, outputRelative, report);
  const endedAt = new Date();
  await appendToolLogEntry(resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log"), {
    tool: "verify_schematic_gate.mjs", transactionId: plan.transactionId, gate: plan.gate,
    attemptFamily: plan.attemptFamily, attemptIndex: plan.attemptIndex,
    operation: "saved/reopened schematic exact-delta, netlist, and ERC verification", outcome: "READ_ONLY",
    semanticReadback: `${report.status}; ${report.failures.length} failure(s); ${report.unverified.length} unverified item(s)`,
    startedAt: CLI_STARTED_AT, endedAt,
    attemptDisposition: report.status === "SCHEMATIC_TRANSACTION_VERIFIED" ? "ACCEPTED" : report.status === "SCHEMATIC_TRANSACTION_REJECTED" ? "REJECTED" : "UNKNOWN",
    gateProgress: report.status === "SCHEMATIC_TRANSACTION_VERIFIED" ? "CLOSED" : report.status === "SCHEMATIC_TRANSACTION_REJECTED" ? "BLOCKED" : "NO_CHANGE",
    evidence: [output],
  });
  process.stdout.write(`${JSON.stringify({ status: report.status, output })}\n`);
  process.exitCode = report.status === "SCHEMATIC_TRANSACTION_VERIFIED" ? 0 : report.status === "SCHEMATIC_TRANSACTION_REJECTED" ? 2 : 3;
}

if (isMain(import.meta.url)) {
  main().catch(async (error) => {
    await appendSchematicPlanFailure(process.argv.slice(2), error, CLI_STARTED_AT, "verify_schematic_gate.mjs").catch(() => {});
    cliFailure(error, "easyeda-schematic-transaction-gate-verification");
  });
}

export { analyzeVerification, componentMatches, parseArgs, selfTest, wireMatches };

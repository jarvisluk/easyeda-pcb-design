import path from "node:path";
import { withTransactionControlDefaults } from "./tool_runtime.mjs";

import { stableHash } from "./schematic_state.mjs";

const SCHEMATIC_MODES = Object.freeze(["new-construction", "existing-schematic-modification"]);
const SCHEMATIC_COLLECTIONS = Object.freeze(["components", "wires", "annotations"]);
const TARGET_CLASSES = new Set(["NON_PRODUCTION_PROBE", "PRODUCTION"]);
const ROLLBACK_STRATEGIES = new Set(["DELETE_CREATED_IDS", "RESTORE_CHECKPOINT"]);
const LINE_TYPES = new Set(["SOLID", "DASHED", "DOTTED", "DOT_DASHED"]);
const COMPONENT_CHANGE_FIELDS = new Set([
  "x", "y", "rotation", "mirror", "addIntoBom", "addIntoPcb", "designator", "name",
  "uniqueId", "manufacturer", "manufacturerId", "supplier", "supplierId",
]);

const SCHEMATIC_OPERATION_DEFINITIONS = Object.freeze({
  "schematic.component.create": Object.freeze({ collection: "components", delta: 1, destructive: false, api: "eda.sch_PrimitiveComponent.create" }),
  "schematic.component.modify": Object.freeze({ collection: "components", delta: 0, destructive: true, api: "eda.sch_PrimitiveComponent.modify" }),
  "schematic.component.delete": Object.freeze({ collection: "components", delta: -1, destructive: true, api: "eda.sch_PrimitiveComponent.delete" }),
  "schematic.wire.create": Object.freeze({ collection: "wires", delta: 1, destructive: false, api: "eda.sch_PrimitiveWire.create" }),
  "schematic.wire.modify": Object.freeze({ collection: "wires", delta: 0, destructive: true, api: "eda.sch_PrimitiveWire.modify" }),
  "schematic.wire.delete": Object.freeze({ collection: "wires", delta: -1, destructive: true, api: "eda.sch_PrimitiveWire.delete" }),
});

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function safeRelativePath(value) {
  if (!nonempty(value) || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function safeArtifactRoot(value) {
  return typeof value === "string" && /^(?:\.|\.\.(?:\/\.\.){0,3})$/.test(value);
}

function validateLine(line, prefix, errors) {
  if (!Array.isArray(line) || line.length < 4 || line.length % 2 !== 0 || !line.every(finite)) {
    errors.push(`${prefix} must be one flat even-length finite coordinate array with at least two points`);
    return;
  }
  for (let index = 0; index + 3 < line.length; index += 2) {
    const [x1, y1, x2, y2] = line.slice(index, index + 4);
    if (x1 === x2 && y1 === y2) errors.push(`${prefix} contains a zero-length segment`);
    else if (x1 !== x2 && y1 !== y2) errors.push(`${prefix} contains a diagonal segment`);
  }
}

function validateComponentIdentity(identity, prefix, errors) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    errors.push(`${prefix} is required`);
    return;
  }
  if (!nonempty(identity.designator)) errors.push(`${prefix}.designator is required`);
  if (!nonempty(identity.uniqueId)) errors.push(`${prefix}.uniqueId is required`);
  for (const field of ["name", "manufacturer", "manufacturerId", "supplier", "supplierId"]) {
    if (identity[field] !== undefined && typeof identity[field] !== "string") errors.push(`${prefix}.${field} must be a string`);
  }
  if (identity.otherProperty !== undefined) errors.push(`${prefix}.otherProperty is not supported because saved/reopened verification cannot prove it`);
}

function validateExpectedComponent(expected, prefix, errors) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    errors.push(`${prefix} is required`);
    return;
  }
  if (!nonempty(expected.designator) || !nonempty(expected.uniqueId)) {
    errors.push(`${prefix} requires designator and uniqueId`);
  }
}

function validateWireShape(operation, prefix, errors, field = "line") {
  validateLine(operation[field], `${prefix}.${field}`, errors);
  if (operation.net !== undefined && typeof operation.net !== "string") errors.push(`${prefix}.net must be a string`);
  if (operation.color !== undefined && operation.color !== null && typeof operation.color !== "string") errors.push(`${prefix}.color must be a string or null`);
  if (operation.lineWidth !== undefined && operation.lineWidth !== null && (!finite(operation.lineWidth) || operation.lineWidth < 1 || operation.lineWidth > 10)) {
    errors.push(`${prefix}.lineWidth must be null or a number from 1 through 10`);
  }
  if (operation.lineTypeEnum !== undefined && operation.lineTypeEnum !== null && !LINE_TYPES.has(operation.lineTypeEnum)) {
    errors.push(`${prefix}.lineTypeEnum must be SOLID, DASHED, DOTTED, DOT_DASHED, or null`);
  }
}

function validateOperation(operation, index, mode, errors) {
  const prefix = `operations[${index}]`;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    errors.push(`${prefix} must be one object`);
    return;
  }
  if (!nonempty(operation.operationId)) errors.push(`${prefix}.operationId is required`);
  const definition = SCHEMATIC_OPERATION_DEFINITIONS[operation.type];
  if (!definition) {
    errors.push(`${prefix}.type is not registered for schematic transactions`);
    return;
  }
  if (mode === "new-construction" && definition.delta !== 1) {
    errors.push(`${prefix}.type is not create-only and cannot run in new-construction mode`);
  }
  if (operation.type === "schematic.component.create") {
    for (const field of ["libraryUuid", "uuid"]) if (!nonempty(operation[field])) errors.push(`${prefix}.${field} is required`);
    for (const field of ["x", "y", "rotation"]) if (operation[field] !== undefined && !finite(operation[field])) errors.push(`${prefix}.${field} must be finite`);
    if (!finite(operation.x) || !finite(operation.y)) errors.push(`${prefix}.x and ${prefix}.y are required`);
    for (const field of ["mirror", "addIntoBom", "addIntoPcb"]) {
      if (operation[field] !== undefined && typeof operation[field] !== "boolean") errors.push(`${prefix}.${field} must be boolean`);
    }
    validateComponentIdentity(operation.identity, `${prefix}.identity`, errors);
  } else if (operation.type === "schematic.component.modify") {
    if (!nonempty(operation.primitiveId)) errors.push(`${prefix}.primitiveId is required`);
    validateExpectedComponent(operation.expectedBefore, `${prefix}.expectedBefore`, errors);
    if (!operation.changes || typeof operation.changes !== "object" || Array.isArray(operation.changes) || !Object.keys(operation.changes).length) {
      errors.push(`${prefix}.changes must be a non-empty object`);
    } else {
      for (const field of Object.keys(operation.changes)) {
        if (!COMPONENT_CHANGE_FIELDS.has(field)) errors.push(`${prefix}.changes.${field} is not supported`);
        if (!(field in (operation.expectedBefore || {}))) errors.push(`${prefix}.expectedBefore.${field} is required for a changed field`);
      }
      for (const field of ["x", "y", "rotation"]) if (field in operation.changes && !finite(operation.changes[field])) errors.push(`${prefix}.changes.${field} must be finite`);
      for (const field of ["mirror", "addIntoBom", "addIntoPcb"]) if (field in operation.changes && typeof operation.changes[field] !== "boolean") errors.push(`${prefix}.changes.${field} must be boolean`);
      for (const field of ["designator", "name", "uniqueId", "manufacturer", "manufacturerId", "supplier", "supplierId"]) {
        if (field in operation.changes && typeof operation.changes[field] !== "string") errors.push(`${prefix}.changes.${field} must be a string`);
      }
      for (const field of ["designator", "uniqueId"]) {
        if (field in operation.changes && !nonempty(operation.changes[field])) errors.push(`${prefix}.changes.${field} must be non-empty`);
      }
    }
  } else if (operation.type === "schematic.component.delete") {
    if (!nonempty(operation.primitiveId)) errors.push(`${prefix}.primitiveId is required`);
    validateExpectedComponent(operation.expectedBefore, `${prefix}.expectedBefore`, errors);
  } else if (operation.type === "schematic.wire.create") {
    validateWireShape(operation, prefix, errors);
    if (typeof operation.net !== "string") errors.push(`${prefix}.net is required for deterministic connectivity`);
  } else if (operation.type === "schematic.wire.modify") {
    if (!nonempty(operation.primitiveId)) errors.push(`${prefix}.primitiveId is required`);
    if (!operation.expectedBefore || typeof operation.expectedBefore !== "object") errors.push(`${prefix}.expectedBefore is required`);
    if (!operation.changes || typeof operation.changes !== "object" || !Object.keys(operation.changes).length) {
      errors.push(`${prefix}.changes must be a non-empty object`);
    } else {
      const allowed = new Set(["line", "net", "color", "lineWidth", "lineTypeEnum"]);
      for (const field of Object.keys(operation.changes)) {
        if (!allowed.has(field)) errors.push(`${prefix}.changes.${field} is not supported`);
        const expectedField = field === "lineTypeEnum" ? "lineType" : field;
        if (!(expectedField in (operation.expectedBefore || {}))) errors.push(`${prefix}.expectedBefore.${expectedField} is required for a changed field`);
      }
      if ("line" in operation.changes) validateLine(operation.changes.line, `${prefix}.changes.line`, errors);
      if ("net" in operation.changes && typeof operation.changes.net !== "string") errors.push(`${prefix}.changes.net must be a string`);
      if ("color" in operation.changes && operation.changes.color !== null && typeof operation.changes.color !== "string") errors.push(`${prefix}.changes.color must be a string or null`);
      if ("lineWidth" in operation.changes && operation.changes.lineWidth !== null && (!finite(operation.changes.lineWidth) || operation.changes.lineWidth < 1 || operation.changes.lineWidth > 10)) errors.push(`${prefix}.changes.lineWidth must be null or a number from 1 through 10`);
      if ("lineTypeEnum" in operation.changes && operation.changes.lineTypeEnum !== null && !LINE_TYPES.has(operation.changes.lineTypeEnum)) errors.push(`${prefix}.changes.lineTypeEnum is invalid`);
    }
  } else {
    if (!nonempty(operation.primitiveId)) errors.push(`${prefix}.primitiveId is required`);
    if (!operation.expectedBefore || typeof operation.expectedBefore !== "object") errors.push(`${prefix}.expectedBefore is required`);
    else {
      validateLine(operation.expectedBefore.line, `${prefix}.expectedBefore.line`, errors);
      if (typeof operation.expectedBefore.net !== "string") errors.push(`${prefix}.expectedBefore.net is required`);
    }
  }
}

function expectedSchematicDeltas(operations = []) {
  const deltas = Object.fromEntries(SCHEMATIC_COLLECTIONS.map((name) => [name, 0]));
  for (const operation of operations) {
    const definition = SCHEMATIC_OPERATION_DEFINITIONS[operation?.type];
    if (definition) deltas[definition.collection] += definition.delta;
  }
  return deltas;
}

function schematicOperationCounts(operations = []) {
  const counts = {};
  for (const operation of operations) counts[operation?.type || "unknown"] = (counts[operation?.type || "unknown"] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function schematicCapabilityFingerprint(plan) {
  return stableHash((plan?.operations || []).map((operation) => ({
    type: operation.type,
    fields: Object.keys(operation).filter((field) => !["operationId", "primitiveId", "expectedBefore"].includes(field)).sort(),
    changeFields: Object.keys(operation.changes || {}).sort(),
    identityFields: Object.keys(operation.identity || {}).sort(),
  })));
}

function validateSchematicTransactionPlan(input) {
  const plan = withTransactionControlDefaults(input, "schematic");
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { valid: false, executable: false, errors: ["plan must be one JSON object"], plan };
  }
  if (plan.schemaVersion !== 2 || plan.kind !== "easyeda-schematic-transaction-plan") errors.push("plan must be easyeda-schematic-transaction-plan schemaVersion 2");
  if (!SCHEMATIC_MODES.includes(plan.mode)) errors.push(`mode must be one of ${SCHEMATIC_MODES.join(", ")}`);
  for (const field of ["transactionId", "gate", "attemptFamily", "projectUuid", "schematicUuid", "schematicPageUuid", "baselineFingerprint"]) {
    if (!nonempty(plan[field])) errors.push(`${field} is required`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(plan.baselineFingerprint || "")) errors.push("baselineFingerprint must be sha256:<64 hex>");
  if (!safeArtifactRoot(plan.artifactRoot)) errors.push("artifactRoot must be ., .., ../.., ../../.., or ../../../..");
  if (!Number.isInteger(plan.attemptIndex) || plan.attemptIndex < 1) errors.push("attemptIndex must be a positive integer");
  if (!TARGET_CLASSES.has(plan.targetClass)) errors.push("targetClass must be NON_PRODUCTION_PROBE or PRODUCTION");
  if (!Array.isArray(plan.operations) || !plan.operations.length) errors.push("operations must be a non-empty array");
  (plan.operations || []).forEach((operation, index) => validateOperation(operation, index, plan.mode, errors));
  const operationIds = (plan.operations || []).map((operation) => operation?.operationId).filter(nonempty);
  if (new Set(operationIds).size !== operationIds.length) errors.push("operationId values must be unique within a transaction");
  const identities = (plan.operations || []).filter((operation) => operation?.type === "schematic.component.create").map((operation) => operation.identity || {});
  for (const field of ["designator", "uniqueId"]) {
    const values = identities.map((identity) => identity[field]).filter(nonempty);
    if (new Set(values).size !== values.length) errors.push(`component-create identity ${field} values must be unique`);
  }
  const deltas = expectedSchematicDeltas(plan.operations || []);
  if (!plan.acceptance || typeof plan.acceptance !== "object") errors.push("acceptance is required");
  else {
    for (const collection of SCHEMATIC_COLLECTIONS) {
      if (plan.acceptance.expectedDeltas?.[collection] !== deltas[collection]) errors.push(`acceptance.expectedDeltas.${collection} must equal ${deltas[collection]}`);
    }
    for (const field of ["requireSavedReopen", "requireStableErc", "requireNoNewErc", "requireUntouchedIdentity"]) {
      if (plan.acceptance[field] !== true) errors.push(`acceptance.${field} must be true`);
    }
    const wireWrites = (plan.operations || []).some((operation) => operation?.type?.startsWith("schematic.wire."));
    if (wireWrites && (!Array.isArray(plan.acceptance.pinNetAssertions) || !plan.acceptance.pinNetAssertions.length)) {
      errors.push("wire transactions require acceptance.pinNetAssertions");
    }
    for (const [index, assertion] of (plan.acceptance.pinNetAssertions || []).entries()) {
      if (!nonempty(assertion?.uniqueId) || !nonempty(String(assertion?.pinNumber || "")) || typeof assertion?.net !== "string") {
        errors.push(`acceptance.pinNetAssertions[${index}] requires uniqueId, pinNumber, and net`);
      }
    }
  }
  const destructive = (plan.operations || []).some((operation) => SCHEMATIC_OPERATION_DEFINITIONS[operation?.type]?.destructive);
  const onlyCreates = (plan.operations || []).every((operation) => SCHEMATIC_OPERATION_DEFINITIONS[operation?.type]?.delta === 1);
  if (!ROLLBACK_STRATEGIES.has(plan.rollback?.strategy)) errors.push("rollback.strategy must be DELETE_CREATED_IDS or RESTORE_CHECKPOINT");
  if (destructive && plan.rollback?.strategy !== "RESTORE_CHECKPOINT") errors.push("modification or deletion requires rollback.strategy RESTORE_CHECKPOINT");
  if (plan.rollback?.strategy === "DELETE_CREATED_IDS" && !onlyCreates) errors.push("DELETE_CREATED_IDS is valid only for create-only transactions");
  const requiredControls = [
    "authorizationRecord", "gateLedgerCheck", "preEditState", "postEditState",
    "planCheck", "transactionResult", "verificationReport", "operationLog",
  ];
  if (destructive) requiredControls.push("rollbackCheck");
  if (plan.targetClass === "PRODUCTION") requiredControls.push("capabilityCheck");
  if (!plan.controls || typeof plan.controls !== "object") errors.push("controls is required");
  else for (const field of requiredControls) if (!safeRelativePath(plan.controls[field])) errors.push(`controls.${field} must stay inside the artifact root`);
  return {
    valid: errors.length === 0,
    executable: errors.length === 0,
    errors,
    plan: structuredClone(plan),
    summary: {
      transactionId: plan.transactionId || null,
      mode: plan.mode || null,
      operationCount: (plan.operations || []).length,
      operationCounts: schematicOperationCounts(plan.operations || []),
      expectedDeltas: deltas,
      destructive,
      targetClass: plan.targetClass || null,
      capabilityFingerprint: schematicCapabilityFingerprint(plan),
    },
  };
}

function schematicBrowserTransactionCode(plan) {
  const validation = validateSchematicTransactionPlan(plan);
  if (!validation.executable) throw new Error(`schematic transaction plan is not executable: ${validation.errors.join("; ")}`);
  return `
const plan = ${JSON.stringify(validation.plan)};
const project = await eda.dmt_Project.getCurrentProjectInfo();
const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
const schematic = await eda.dmt_Schematic.getCurrentSchematicInfo();
if (!project || project.uuid !== plan.projectUuid) throw new Error("project UUID mismatch");
if (!document || document.uuid !== plan.schematicPageUuid || document.documentType !== 1) throw new Error("schematic page UUID/type mismatch");
if (!schematic || schematic.uuid !== plan.schematicUuid) throw new Error("parent schematic UUID mismatch");
const value = (object, method, property) => typeof object?.[method] === "function" ? object[method]() : object?.[property];
const primitiveId = (object) => value(object, "getState_PrimitiveId", "primitiveId");
const lineTypes = { SOLID: 0, DASHED: 1, DOTTED: 2, DOT_DASHED: 3 };
const componentState = (item) => ({
  primitiveId: primitiveId(item), designator: value(item, "getState_Designator", "designator") || "",
  uniqueId: value(item, "getState_UniqueId", "uniqueId") || "", name: value(item, "getState_Name", "name") || "",
  x: value(item, "getState_X", "x"), y: value(item, "getState_Y", "y"), rotation: value(item, "getState_Rotation", "rotation"),
  mirror: value(item, "getState_Mirror", "mirror"), addIntoBom: value(item, "getState_AddIntoBom", "addIntoBom"),
  addIntoPcb: value(item, "getState_AddIntoPcb", "addIntoPcb"), manufacturer: value(item, "getState_Manufacturer", "manufacturer") || "",
  manufacturerId: value(item, "getState_ManufacturerId", "manufacturerId") || "", supplier: value(item, "getState_Supplier", "supplier") || "",
  supplierId: value(item, "getState_SupplierId", "supplierId") || "",
});
const wireState = (item) => ({
  primitiveId: primitiveId(item), net: value(item, "getState_Net", "net") || "", line: value(item, "getState_Line", "line") || null,
  color: value(item, "getState_Color", "color") ?? null, lineWidth: value(item, "getState_LineWidth", "lineWidth") ?? null,
  lineType: value(item, "getState_LineType", "lineType") ?? null,
});
const matchesExpected = (actual, expected) => Object.entries(expected || {}).every(([key, expectedValue]) => JSON.stringify(actual?.[key]) === JSON.stringify(expectedValue));
const rawComponents = await eda.sch_PrimitiveComponent.getAll();
const components = rawComponents.filter((item) => {
  const type = value(item, "getState_ComponentType", "componentType");
  return type === undefined || type === "part";
});
const wires = await eda.sch_PrimitiveWire.getAll();
const componentsById = new Map(components.map((item) => [primitiveId(item), item]));
const wiresById = new Map(wires.map((item) => [primitiveId(item), item]));
const operationResults = [];
let transactionError = null;
for (const operation of plan.operations) {
  let returned = null;
  const operationResult = { operationId: operation.operationId, type: operation.type, returnedId: null, stage: "STARTED" };
  operationResults.push(operationResult);
  try {
  if (operation.type === "schematic.component.create") {
    const created = await eda.sch_PrimitiveComponent.create(
      { libraryType: "3", libraryUuid: operation.libraryUuid, uuid: operation.uuid },
      operation.x, operation.y, operation.subPartName, operation.rotation ?? 0, operation.mirror ?? false,
      operation.addIntoBom ?? true, operation.addIntoPcb ?? true,
    );
    if (!created) throw new Error("component create returned undefined: " + operation.operationId);
    operationResult.returnedId = primitiveId(created);
    operationResult.stage = "CREATED_PENDING_IDENTITY";
    returned = await eda.sch_PrimitiveComponent.modify(created, operation.identity);
    if (!returned) throw new Error("component identity modify returned undefined: " + operation.operationId);
  } else if (operation.type === "schematic.component.modify") {
    const target = componentsById.get(operation.primitiveId);
    if (!target || !matchesExpected(componentState(target), operation.expectedBefore)) throw new Error("component expected-before mismatch: " + operation.operationId);
    returned = await eda.sch_PrimitiveComponent.modify(target, operation.changes);
    if (!returned) throw new Error("component modify returned undefined: " + operation.operationId);
  } else if (operation.type === "schematic.component.delete") {
    const target = componentsById.get(operation.primitiveId);
    if (!target || !matchesExpected(componentState(target), operation.expectedBefore)) throw new Error("component delete expected-before mismatch: " + operation.operationId);
    if (!await eda.sch_PrimitiveComponent.delete(target)) throw new Error("component delete returned false: " + operation.operationId);
  } else if (operation.type === "schematic.wire.create") {
    returned = await eda.sch_PrimitiveWire.create(operation.line, operation.net, operation.color ?? null, operation.lineWidth ?? null, operation.lineTypeEnum == null ? null : lineTypes[operation.lineTypeEnum]);
    if (!returned) throw new Error("wire create returned undefined: " + operation.operationId);
  } else if (operation.type === "schematic.wire.modify") {
    const target = wiresById.get(operation.primitiveId);
    if (!target || !matchesExpected(wireState(target), operation.expectedBefore)) throw new Error("wire modify expected-before mismatch: " + operation.operationId);
    const changes = { ...operation.changes };
    if ("lineTypeEnum" in changes) { changes.lineType = changes.lineTypeEnum == null ? null : lineTypes[changes.lineTypeEnum]; delete changes.lineTypeEnum; }
    returned = await eda.sch_PrimitiveWire.modify(target, changes);
    if (!returned) throw new Error("wire modify returned undefined: " + operation.operationId);
  } else if (operation.type === "schematic.wire.delete") {
    const target = wiresById.get(operation.primitiveId);
    if (!target || !matchesExpected(wireState(target), operation.expectedBefore)) throw new Error("wire delete expected-before mismatch: " + operation.operationId);
    if (!await eda.sch_PrimitiveWire.delete(target)) throw new Error("wire delete returned false: " + operation.operationId);
  }
  operationResult.returnedId = returned ? primitiveId(returned) : operationResult.returnedId;
  operationResult.stage = "APPLIED";
  } catch (error) {
    operationResult.stage = "FAILED";
    operationResult.error = error instanceof Error ? error.message : String(error);
    transactionError = operationResult.error;
    break;
  }
}
if (transactionError) return { saveReturned: false, operationResults, immediateErc: null, transactionError };
let saveReturned = false;
let immediateErc = null;
try {
  saveReturned = await eda.sch_Document.save();
  if (saveReturned === true) immediateErc = await eda.sch_Drc.check(true, false, true);
} catch (error) {
  transactionError = error instanceof Error ? error.message : String(error);
}
return { saveReturned, operationResults, immediateErc, transactionError };`;
}

function schematicPlanFixture(mode = "new-construction") {
  const operations = mode === "new-construction"
    ? [{
        operationId: "create-u1", type: "schematic.component.create", libraryUuid: "library-1", uuid: "device-1",
        x: 100, y: 100, rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: true,
        identity: { designator: "U1", uniqueId: "U1-STABLE", name: "MCU", manufacturer: "Vendor", manufacturerId: "PART-1" },
      }]
    : [{
        operationId: "move-u1", type: "schematic.component.modify", primitiveId: "component-1",
        expectedBefore: { designator: "U1", uniqueId: "U1-STABLE", x: 100 }, changes: { x: 120 },
      }];
  const destructive = mode !== "new-construction";
  return withTransactionControlDefaults({
    schemaVersion: 2, kind: "easyeda-schematic-transaction-plan", mode,
    transactionId: `schematic-${mode}-1`, gate: mode === "new-construction" ? "SCHEMATIC_IDENTITY_STABLE" : "BOUNDED_SCHEMATIC_TRANSACTION",
    attemptFamily: `${mode}-fixture`, attemptIndex: 1, targetClass: "NON_PRODUCTION_PROBE",
    projectUuid: "project-1", schematicUuid: "schematic-1", schematicPageUuid: "page-1",
    baselineFingerprint: `sha256:${"a".repeat(64)}`, artifactRoot: ".", operations,
    rollback: { strategy: destructive ? "RESTORE_CHECKPOINT" : "DELETE_CREATED_IDS" },
    acceptance: {
      expectedDeltas: expectedSchematicDeltas(operations), requireSavedReopen: true, requireStableErc: true,
      requireNoNewErc: true, requireUntouchedIdentity: true, pinNetAssertions: [],
    },
    controls: {
      authorizationRecord: "evidence/readbacks/authorization.json", gateLedgerCheck: "evidence/readbacks/gate-ledger-check.json",
      preEditState: "evidence/readbacks/before.json", rollbackCheck: "evidence/readbacks/restore-check.json",
      capabilityCheck: "evidence/readbacks/capability-check.json", operationLog: "evidence/readbacks/operation-log.json",
    },
  }, "schematic");
}

export {
  SCHEMATIC_COLLECTIONS,
  SCHEMATIC_MODES,
  SCHEMATIC_OPERATION_DEFINITIONS,
  expectedSchematicDeltas,
  schematicBrowserTransactionCode,
  schematicCapabilityFingerprint,
  schematicOperationCounts,
  schematicPlanFixture,
  validateSchematicTransactionPlan,
};

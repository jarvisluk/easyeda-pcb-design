import { createHash } from "node:crypto";
import path from "node:path";

import {
  COLLECTIONS,
  MODES,
  expectedDeltas,
  operationCounts,
  operationDefinition,
} from "./operation_registry.mjs";

const COPPER_LAYER_RE = /^(?:TOP|BOTTOM|INNER_(?:[1-9]|[12][0-9]|30))$/;
const LAYER_ENUM_EXAMPLES = Object.freeze(["INNER_1", "INNER_30"]);
const COMPONENT_LAYERS = new Set(["TOP", "BOTTOM"]);
const VIA_TYPES = new Set(["VIA", "BLIND", "SUTURE"]);
const TARGET_CLASSES = new Set(["NON_PRODUCTION_PROBE", "PRODUCTION"]);
const ROLLBACK_STRATEGIES = new Set(["DELETE_CREATED_IDS", "RESTORE_CHECKPOINT"]);
const REQUIRED_CONTROLS = Object.freeze([
  "budgetCheck",
  "checkpointCheck",
  "authorizationRecord",
  "gateLedgerCheck",
  "postPlacementReport",
  "operationLog",
]);
const PRE_PLACEMENT_MODES = new Set(["route", "repair", "copper"]);

function nonempty(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function stableHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function safeRelativePath(value) {
  if (!nonempty(value) || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function safeArtifactRoot(value) {
  return typeof value === "string" && /^(?:\.|\.\.(?:\/\.\.){0,3})$/.test(value);
}

function legacyOperations(plan) {
  const operations = [];
  let serial = 0;
  const add = (type, body) => {
    serial += 1;
    operations.push({ operationId: `legacy-${serial}`, type, ...body });
  };
  for (const line of plan.creates?.lines || []) add("line.create", { net: plan.net, ...line });
  for (const via of plan.creates?.vias || []) add("via.create", { net: plan.net, ...via });
  for (const primitiveId of plan.deletes?.lineIds || []) add("line.delete", { primitiveId });
  for (const primitiveId of plan.deletes?.viaIds || []) add("via.delete", { primitiveId });
  return operations;
}

function normalizeTransactionPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  if (plan.schemaVersion === 2 && plan.kind === "easyeda-transaction-plan") {
    return structuredClone(plan);
  }
  const legacyMode = plan.kind === "easyeda-route-transaction-plan"
    ? "route"
    : plan.kind === "easyeda-repair-transaction-plan"
      ? "repair"
      : null;
  if (plan.schemaVersion !== 1 || !legacyMode) return structuredClone(plan);
  const operations = legacyOperations(plan);
  return {
    schemaVersion: 2,
    kind: "easyeda-transaction-plan",
    compatibility: { sourceSchemaVersion: 1, execution: "DRY_RUN_ONLY" },
    mode: legacyMode,
    transactionId: plan.transactionId,
    gate: plan.gate,
    attemptFamily: plan.attemptFamily,
    attemptIndex: plan.attemptIndex,
    targetClass: plan.targetClass,
    projectUuid: plan.projectUuid,
    pcbUuid: plan.pcbUuid,
    baselineFingerprint: plan.baselineFingerprint,
    artifactRoot: ".",
    operations,
    rollback: {
      strategy: operations.some((operation) => operation.type.endsWith(".delete"))
        ? "RESTORE_CHECKPOINT"
        : "DELETE_CREATED_IDS",
    },
    acceptance: {
      expectedDeltas: expectedDeltas(operations),
      requireDetailedDrc: plan.acceptance?.requireDetailedDrc === true,
      requirePlacementClearAfter: true,
      requireBaselineRecoveryOnReject: true,
    },
    controls: {
      ...plan.controls,
      prePlacementReport: plan.controls?.placementReport,
      postPlacementReport: plan.controls?.placementReport,
    },
  };
}

function validateLayer(value, allowed, field, errors) {
  if (!allowed(value || "")) errors.push(`${field} is not an allowed EPCB_LayerId enum member`);
}

function validateLineCreate(operation, prefix, errors, mode) {
  if (mode === "outline") {
    if (typeof operation.net !== "string") errors.push(`${prefix}.net must be a string`);
  } else if (!nonempty(operation.net)) errors.push(`${prefix}.net is required`);
  validateLayer(
    operation.layerEnum,
    (value) => COPPER_LAYER_RE.test(value) || (mode === "outline" && value === "BOARD_OUTLINE"),
    `${prefix}.layerEnum`,
    errors,
  );
  for (const field of ["startX", "startY", "endX", "endY", "lineWidth"]) {
    if (!finite(operation[field])) errors.push(`${prefix}.${field} must be finite`);
  }
  if (finite(operation.lineWidth) && operation.lineWidth <= 0) errors.push(`${prefix}.lineWidth must be positive`);
  if (
    [operation.startX, operation.startY, operation.endX, operation.endY].every(finite) &&
    operation.startX === operation.endX && operation.startY === operation.endY
  ) errors.push(`${prefix} must not be zero length`);
  if (typeof operation.primitiveLock !== "boolean") errors.push(`${prefix}.primitiveLock must be boolean`);
}

function validateViaCreate(operation, prefix, errors) {
  if (!nonempty(operation.net)) errors.push(`${prefix}.net is required`);
  for (const field of ["x", "y", "holeDiameter", "diameter"]) {
    if (!finite(operation[field])) errors.push(`${prefix}.${field} must be finite`);
  }
  if (finite(operation.holeDiameter) && operation.holeDiameter <= 0) errors.push(`${prefix}.holeDiameter must be positive`);
  if (finite(operation.diameter) && finite(operation.holeDiameter) && operation.diameter <= operation.holeDiameter) {
    errors.push(`${prefix}.diameter must exceed holeDiameter`);
  }
  if (!VIA_TYPES.has(operation.viaType)) errors.push(`${prefix}.viaType must be VIA, BLIND, or SUTURE`);
  if (typeof operation.primitiveLock !== "boolean") errors.push(`${prefix}.primitiveLock must be boolean`);
}

function validateDelete(operation, prefix, errors) {
  if (!nonempty(operation.primitiveId)) errors.push(`${prefix}.primitiveId is required`);
}

function validateComponentModify(operation, prefix, errors) {
  validateDelete(operation, prefix, errors);
  if (!nonempty(operation.designator)) errors.push(`${prefix}.designator is required for identity binding`);
  if (!operation.expectedBefore || typeof operation.expectedBefore !== "object") {
    errors.push(`${prefix}.expectedBefore is required`);
  }
  if (!operation.changes || typeof operation.changes !== "object") {
    errors.push(`${prefix}.changes is required`);
    return;
  }
  const allowed = new Set(["x", "y", "rotation", "layerEnum", "primitiveLock"]);
  for (const field of Object.keys(operation.changes)) {
    if (!allowed.has(field)) errors.push(`${prefix}.changes.${field} is not allowed`);
  }
  if (!["x", "y", "rotation", "primitiveLock", "layerEnum"].some((field) => field in operation.changes)) {
    errors.push(`${prefix}.changes must change placement or lock state`);
  }
  for (const field of ["x", "y", "rotation"]) {
    if (field in operation.changes && !finite(operation.changes[field])) errors.push(`${prefix}.changes.${field} must be finite`);
    if (field in (operation.expectedBefore || {}) && !finite(operation.expectedBefore[field])) {
      errors.push(`${prefix}.expectedBefore.${field} must be finite`);
    }
  }
  for (const field of ["x", "y", "rotation", "layerEnum", "primitiveLock"]) {
    if (!(field in (operation.expectedBefore || {}))) errors.push(`${prefix}.expectedBefore.${field} is required`);
  }
  for (const recordName of ["expectedBefore", "changes"]) {
    const value = operation[recordName]?.layerEnum;
    if (value !== undefined && !COMPONENT_LAYERS.has(value)) {
      errors.push(`${prefix}.${recordName}.layerEnum must be TOP or BOTTOM`);
    }
  }
  if (operation.changes.primitiveLock !== undefined && typeof operation.changes.primitiveLock !== "boolean") {
    errors.push(`${prefix}.changes.primitiveLock must be boolean`);
  }
  if (typeof operation.expectedBefore?.primitiveLock !== "boolean") {
    errors.push(`${prefix}.expectedBefore.primitiveLock must be boolean`);
  }
}

function validatePolylineCreate(operation, prefix, errors) {
  if (typeof operation.net !== "string") errors.push(`${prefix}.net must be a string`);
  validateLayer(
    operation.layerEnum,
    (value) => value === "BOARD_OUTLINE" || COPPER_LAYER_RE.test(value),
    `${prefix}.layerEnum`,
    errors,
  );
  if (!Array.isArray(operation.polygon) || operation.polygon.length < 5) {
    errors.push(`${prefix}.polygon must be a non-trivial TPCB_PolygonSourceArray`);
  } else if (operation.polygon.some((item) => typeof item !== "number" && !["L", "ARC", "CARC", "C", "R", "CIRCLE"].includes(item))) {
    errors.push(`${prefix}.polygon contains an unsupported polygon token`);
  }
  if (!Array.isArray(operation.expectedPoints) || operation.expectedPoints.length < 4 || operation.expectedPoints.some(
    (point) => !Array.isArray(point) || point.length !== 2 || !point.every(finite),
  )) errors.push(`${prefix}.expectedPoints must contain at least four finite [x,y] points`);
  if (!finite(operation.lineWidth) || operation.lineWidth <= 0) errors.push(`${prefix}.lineWidth must be positive`);
  if (typeof operation.primitiveLock !== "boolean") errors.push(`${prefix}.primitiveLock must be boolean`);
}

function validateOperation(operation, index, mode, errors) {
  const prefix = `operations[${index}]`;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!nonempty(operation.operationId)) errors.push(`${prefix}.operationId is required`);
  const definition = operationDefinition(operation.type);
  if (!definition) {
    errors.push(`${prefix}.type is not registered`);
    return;
  }
  if (!definition.modes.includes(mode)) errors.push(`${prefix}.type ${operation.type} is not allowed in ${mode} mode`);
  if (operation.type === "line.create") validateLineCreate(operation, prefix, errors, mode);
  else if (operation.type === "via.create") validateViaCreate(operation, prefix, errors);
  else if (operation.type === "component.modify") validateComponentModify(operation, prefix, errors);
  else if (operation.type === "polyline.create") validatePolylineCreate(operation, prefix, errors);
  else validateDelete(operation, prefix, errors);
}

function validateTransactionPlan(input) {
  const plan = normalizeTransactionPlan(input);
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { valid: false, executable: false, errors: ["plan must be one JSON object"], warnings, plan };
  }
  if (plan.schemaVersion !== 2 || plan.kind !== "easyeda-transaction-plan") {
    errors.push("plan must be easyeda-transaction-plan schemaVersion 2");
  }
  if (plan.compatibility?.sourceSchemaVersion === 1) {
    warnings.push("schemaVersion 1 plan normalized for dry-run inspection; author a native schemaVersion 2 plan before execution");
  }
  if (!MODES.includes(plan.mode)) errors.push(`mode must be one of ${MODES.join(", ")}`);
  for (const field of ["transactionId", "gate", "attemptFamily", "projectUuid", "pcbUuid", "baselineFingerprint"]) {
    if (!nonempty(plan[field])) errors.push(`${field} is required`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(plan.baselineFingerprint || "")) {
    errors.push("baselineFingerprint must be sha256:<64 hex>");
  }
  if (!safeArtifactRoot(plan.artifactRoot)) {
    errors.push("artifactRoot must be ., .., ../.., ../../.., or ../../../..");
  }
  if (!Number.isInteger(plan.attemptIndex) || plan.attemptIndex < 1) errors.push("attemptIndex must be a positive integer");
  if (!TARGET_CLASSES.has(plan.targetClass)) errors.push("targetClass must be NON_PRODUCTION_PROBE or PRODUCTION");
  if (!Array.isArray(plan.operations) || !plan.operations.length) errors.push("operations must be a non-empty array");
  (plan.operations || []).forEach((operation, index) => validateOperation(operation, index, plan.mode, errors));
  const ids = (plan.operations || []).map((operation) => operation?.operationId).filter(nonempty);
  if (new Set(ids).size !== ids.length) errors.push("operationId values must be unique within a transaction");

  const deltas = expectedDeltas(plan.operations || []);
  if (!plan.acceptance || typeof plan.acceptance !== "object") {
    errors.push("acceptance is required");
  } else {
    for (const collection of COLLECTIONS) {
      if (plan.acceptance.expectedDeltas?.[collection] !== deltas[collection]) {
        errors.push(`acceptance.expectedDeltas.${collection} must equal ${deltas[collection]}`);
      }
    }
    if (plan.acceptance.requireDetailedDrc !== true) errors.push("acceptance.requireDetailedDrc must be true");
    if (plan.acceptance.requirePlacementClearAfter !== true) errors.push("acceptance.requirePlacementClearAfter must be true");
    if (plan.acceptance.requireBaselineRecoveryOnReject !== true) {
      errors.push("acceptance.requireBaselineRecoveryOnReject must be true");
    }
  }

  const destructive = (plan.operations || []).some((operation) => operationDefinition(operation?.type)?.destructive);
  const onlyCreates = (plan.operations || []).every((operation) => operationDefinition(operation?.type)?.delta === 1);
  if (!ROLLBACK_STRATEGIES.has(plan.rollback?.strategy)) errors.push("rollback.strategy must be DELETE_CREATED_IDS or RESTORE_CHECKPOINT");
  if (destructive && plan.rollback?.strategy !== "RESTORE_CHECKPOINT") {
    errors.push("destructive or modifying operations require rollback.strategy RESTORE_CHECKPOINT");
  }
  if (plan.rollback?.strategy === "DELETE_CREATED_IDS" && !onlyCreates) {
    errors.push("DELETE_CREATED_IDS is valid only for create-only transactions");
  }

  if (!plan.controls || typeof plan.controls !== "object") {
    errors.push("controls is required");
  } else {
    const required = [...REQUIRED_CONTROLS];
    if (PRE_PLACEMENT_MODES.has(plan.mode)) required.push("prePlacementReport");
    for (const field of required) {
      if (!safeRelativePath(plan.controls[field])) errors.push(`controls.${field} must stay within the plan directory`);
    }
  }

  return {
    valid: errors.length === 0,
    executable: errors.length === 0 && plan.compatibility?.execution !== "DRY_RUN_ONLY",
    errors,
    warnings,
    plan,
    summary: {
      transactionId: plan.transactionId || null,
      mode: plan.mode || null,
      operationCount: (plan.operations || []).length,
      operationCounts: operationCounts(plan.operations || []),
      expectedDeltas: deltas,
      destructive,
      targetClass: plan.targetClass || null,
    },
  };
}

function browserTransactionCode(input) {
  const validation = validateTransactionPlan(input);
  if (!validation.executable) throw new Error(`transaction plan is not executable: ${[...validation.errors, ...validation.warnings].join("; ")}`);
  const plan = validation.plan;
  return `const plan = ${JSON.stringify(plan)};
const project = await eda.dmt_Project.getCurrentProjectInfo();
const documentInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!project || project.uuid !== plan.projectUuid) throw new Error("project UUID mismatch");
if (!documentInfo || documentInfo.uuid !== plan.pcbUuid || documentInfo.documentType !== 3) throw new Error("active PCB UUID/type mismatch");
const value = (object, methodName, propertyName) => typeof object?.[methodName] === "function" ? object[methodName]() : object?.[propertyName];
const id = (object) => value(object, "getState_PrimitiveId", "primitiveId");
const getAll = async () => ({
  lines: await eda.pcb_PrimitiveLine.getAll(),
  vias: await eda.pcb_PrimitiveVia.getAll(),
  components: await eda.pcb_PrimitiveComponent.getAll(),
  polylines: await eda.pcb_PrimitivePolyline.getAll(),
  pours: await eda.pcb_PrimitivePour.getAll(),
  poured: await eda.pcb_PrimitivePoured.getAll(),
});
const ids = (items) => items.map(id).filter(Boolean);
const before = await getAll();
const beforeById = Object.fromEntries(Object.entries(before).map(([kind, items]) => [kind, new Map(items.map((item) => [id(item), item]))]));
const operationResults = [];
for (const operation of plan.operations) {
  let created;
  if (operation.type === "line.create") {
    created = await eda.pcb_PrimitiveLine.create(operation.net, EPCB_LayerId[operation.layerEnum], operation.startX, operation.startY, operation.endX, operation.endY, operation.lineWidth, operation.primitiveLock);
  } else if (operation.type === "line.delete") {
    if (!beforeById.lines.has(operation.primitiveId)) throw new Error("planned line delete target absent: " + operation.primitiveId);
    if (!await eda.pcb_PrimitiveLine.delete(operation.primitiveId)) throw new Error("line delete returned false: " + operation.primitiveId);
  } else if (operation.type === "via.create") {
    created = await eda.pcb_PrimitiveVia.create(operation.net, operation.x, operation.y, operation.holeDiameter, operation.diameter, EPCB_PrimitiveViaType[operation.viaType], operation.designRuleBlindViaName || null, null, operation.primitiveLock);
  } else if (operation.type === "via.delete") {
    if (!beforeById.vias.has(operation.primitiveId)) throw new Error("planned via delete target absent: " + operation.primitiveId);
    if (!await eda.pcb_PrimitiveVia.delete(operation.primitiveId)) throw new Error("via delete returned false: " + operation.primitiveId);
  } else if (operation.type === "component.modify") {
    const component = beforeById.components.get(operation.primitiveId);
    if (!component) throw new Error("planned component target absent: " + operation.primitiveId);
    const actualDesignator = value(component, "getState_Designator", "designator") || "";
    if (actualDesignator !== operation.designator) throw new Error("component designator binding mismatch: " + operation.operationId);
    for (const field of ["x", "y", "rotation"]) {
      if (operation.expectedBefore[field] !== undefined) {
        const getter = "getState_" + field[0].toUpperCase() + field.slice(1);
        if (value(component, getter, field) !== operation.expectedBefore[field]) throw new Error("component expectedBefore mismatch: " + operation.operationId + ":" + field);
      }
    }
    if (operation.expectedBefore.layerEnum !== undefined && value(component, "getState_Layer", "layer") !== EPCB_LayerId[operation.expectedBefore.layerEnum]) throw new Error("component expectedBefore layer mismatch: " + operation.operationId);
    if (value(component, "getState_PrimitiveLock", "primitiveLock") !== operation.expectedBefore.primitiveLock) throw new Error("component expectedBefore lock mismatch: " + operation.operationId);
    const changes = { ...operation.changes };
    if (changes.layerEnum !== undefined) { changes.layer = EPCB_LayerId[changes.layerEnum]; delete changes.layerEnum; }
    created = await eda.pcb_PrimitiveComponent.modify(component, changes);
  } else if (operation.type === "polyline.create") {
    const polygon = eda.pcb_MathPolygon.createPolygon(operation.polygon);
    if (!polygon) throw new Error("polyline polygon source is invalid: " + operation.operationId);
    created = await eda.pcb_PrimitivePolyline.create(operation.net, EPCB_LayerId[operation.layerEnum], polygon, operation.lineWidth, operation.primitiveLock);
  } else if (operation.type === "polyline.delete") {
    if (!beforeById.polylines.has(operation.primitiveId)) throw new Error("planned polyline delete target absent: " + operation.primitiveId);
    if (!await eda.pcb_PrimitivePolyline.delete(operation.primitiveId)) throw new Error("polyline delete returned false: " + operation.primitiveId);
  } else if (operation.type === "pour.delete") {
    if (!beforeById.pours.has(operation.primitiveId)) throw new Error("planned pour delete target absent: " + operation.primitiveId);
    if (!await eda.pcb_PrimitivePour.delete(operation.primitiveId)) throw new Error("pour delete returned false: " + operation.primitiveId);
  } else if (operation.type === "poured.delete") {
    if (!beforeById.poured.has(operation.primitiveId)) throw new Error("planned poured delete target absent: " + operation.primitiveId);
    if (!await eda.pcb_PrimitivePoured.delete(operation.primitiveId)) throw new Error("poured delete returned false: " + operation.primitiveId);
  } else {
    throw new Error("unimplemented registered operation: " + operation.type);
  }
  operationResults.push({ operationId: operation.operationId, type: operation.type, returnedId: created ? id(created) || null : null });
}
const saveReturned = await eda.pcb_Document.save();
const immediateDrc = await eda.pcb_Drc.check(true, false, true);
const after = await getAll();
return {
  transactionId: plan.transactionId,
  projectUuid: project.uuid,
  pcbUuid: documentInfo.uuid,
  beforeIds: Object.fromEntries(Object.entries(before).map(([kind, items]) => [kind, ids(items)])),
  afterIds: Object.fromEntries(Object.entries(after).map(([kind, items]) => [kind, ids(items)])),
  operationResults,
  saveReturned,
  immediateDrc,
};`;
}

export {
  COPPER_LAYER_RE,
  browserTransactionCode,
  normalizeTransactionPlan,
  stableHash,
  validateTransactionPlan,
};

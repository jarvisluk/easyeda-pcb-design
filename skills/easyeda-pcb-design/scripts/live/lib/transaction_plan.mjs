import { createHash } from "node:crypto";

const LAYER_ENUM_RE = /^(?:TOP|BOTTOM|INNER_(?:[1-9]|[12][0-9]|30))$/;
const LAYER_ENUM_EXAMPLES = ["INNER_1", "INNER_30"];
const VIA_TYPES = new Set(["VIA", "BLIND", "SUTURE"]);
const TARGET_CLASSES = new Set(["NON_PRODUCTION_PROBE", "PRODUCTION"]);

function nonempty(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function stableHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function validateLine(line, prefix, errors) {
  if (!line || typeof line !== "object" || Array.isArray(line)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!LAYER_ENUM_RE.test(line.layerEnum || "")) {
    errors.push(`${prefix}.layerEnum must name a copper EPCB_LayerId enum member`);
  }
  for (const field of ["startX", "startY", "endX", "endY", "lineWidth"]) {
    if (!finite(line[field])) errors.push(`${prefix}.${field} must be finite`);
  }
  if (finite(line.lineWidth) && line.lineWidth <= 0) errors.push(`${prefix}.lineWidth must be positive`);
  if (
    [line.startX, line.startY, line.endX, line.endY].every(finite) &&
    line.startX === line.endX && line.startY === line.endY
  ) errors.push(`${prefix} must not be zero length`);
  if (line.primitiveLock !== false && line.primitiveLock !== true) {
    errors.push(`${prefix}.primitiveLock must be true or false`);
  }
}

function validateVia(via, prefix, errors) {
  if (!via || typeof via !== "object" || Array.isArray(via)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const field of ["x", "y", "holeDiameter", "diameter"]) {
    if (!finite(via[field])) errors.push(`${prefix}.${field} must be finite`);
  }
  if (finite(via.holeDiameter) && via.holeDiameter <= 0) errors.push(`${prefix}.holeDiameter must be positive`);
  if (finite(via.diameter) && via.diameter <= via.holeDiameter) {
    errors.push(`${prefix}.diameter must exceed holeDiameter`);
  }
  if (!VIA_TYPES.has(via.viaType)) errors.push(`${prefix}.viaType must be VIA, BLIND, or SUTURE`);
  if (via.primitiveLock !== false && via.primitiveLock !== true) {
    errors.push(`${prefix}.primitiveLock must be true or false`);
  }
}

function validateTransactionPlan(plan, expectedMode) {
  const errors = [];
  const expectedKind = `easyeda-${expectedMode}-transaction-plan`;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { valid: false, errors: ["plan must be one JSON object"] };
  }
  if (plan.schemaVersion !== 1 || plan.kind !== expectedKind) {
    errors.push(`plan must be ${expectedKind} schemaVersion 1`);
  }
  for (const field of ["transactionId", "gate", "attemptFamily", "projectUuid", "pcbUuid", "baselineFingerprint", "net"]) {
    if (!nonempty(plan[field])) errors.push(`${field} is required`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(plan.baselineFingerprint || "")) {
    errors.push("baselineFingerprint must be sha256:<64 hex>");
  }
  if (!Number.isInteger(plan.attemptIndex) || plan.attemptIndex < 1) {
    errors.push("attemptIndex must be a positive integer");
  }
  if (!TARGET_CLASSES.has(plan.targetClass)) {
    errors.push("targetClass must be NON_PRODUCTION_PROBE or PRODUCTION");
  }
  const creates = plan.creates;
  if (!creates || typeof creates !== "object" || Array.isArray(creates)) {
    errors.push("creates must be an object");
  }
  const lines = Array.isArray(creates?.lines) ? creates.lines : [];
  const vias = Array.isArray(creates?.vias) ? creates.vias : [];
  if (!Array.isArray(creates?.lines) || !Array.isArray(creates?.vias)) {
    errors.push("creates.lines and creates.vias must be arrays");
  }
  lines.forEach((line, index) => validateLine(line, `creates.lines[${index}]`, errors));
  vias.forEach((via, index) => validateVia(via, `creates.vias[${index}]`, errors));
  const deletes = plan.deletes || { lineIds: [], viaIds: [] };
  for (const field of ["lineIds", "viaIds"]) {
    if (!Array.isArray(deletes[field]) || deletes[field].some((item) => !nonempty(item))) {
      errors.push(`deletes.${field} must be an array of non-empty primitive ids`);
    } else if (new Set(deletes[field]).size !== deletes[field].length) {
      errors.push(`deletes.${field} must not contain duplicates`);
    }
  }
  if (expectedMode === "route" && ((deletes.lineIds || []).length || (deletes.viaIds || []).length)) {
    errors.push("route transactions cannot delete existing primitives; use repair mode");
  }
  if (!lines.length && !vias.length && !(deletes.lineIds || []).length && !(deletes.viaIds || []).length) {
    errors.push("transaction plan contains no operations");
  }
  const acceptance = plan.acceptance;
  if (!acceptance || typeof acceptance !== "object" || acceptance.requireDetailedDrc !== true) {
    errors.push("acceptance.requireDetailedDrc must be true");
  }
  const expectedLineDelta = lines.length - (deletes.lineIds || []).length;
  const expectedViaDelta = vias.length - (deletes.viaIds || []).length;
  if (acceptance?.expectedLineDelta !== expectedLineDelta) {
    errors.push(`acceptance.expectedLineDelta must equal ${expectedLineDelta}`);
  }
  if (acceptance?.expectedViaDelta !== expectedViaDelta) {
    errors.push(`acceptance.expectedViaDelta must equal ${expectedViaDelta}`);
  }
  for (const field of [
    "budgetCheck",
    "checkpointCheck",
    "authorizationRecord",
    "gateLedgerCheck",
    "placementReport",
    "operationLog",
  ]) {
    const value = plan.controls?.[field];
    if (!nonempty(value)) errors.push(`controls.${field} is required`);
    else if (
      value.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.split(/[\\/]/).includes("..")
    ) errors.push(`controls.${field} must stay under the transaction-plan directory`);
  }
  return {
    valid: errors.length === 0,
    errors,
    summary: {
      transactionId: plan.transactionId || null,
      gate: plan.gate || null,
      mode: expectedMode,
      targetClass: plan.targetClass || null,
      attemptFamily: plan.attemptFamily || null,
      attemptIndex: plan.attemptIndex || null,
      net: plan.net || null,
      createLineCount: lines.length,
      createViaCount: vias.length,
      deleteLineCount: (deletes.lineIds || []).length,
      deleteViaCount: (deletes.viaIds || []).length,
      expectedLineDelta,
      expectedViaDelta,
    },
  };
}

function browserTransactionCode(plan, expectedMode) {
  const validation = validateTransactionPlan(plan, expectedMode);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  return `
const plan = ${JSON.stringify(plan)};
const project = await eda.dmt_Project.getCurrentProjectInfo();
const documentInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!project || project.uuid !== plan.projectUuid) throw new Error("project UUID mismatch");
if (!documentInfo || documentInfo.uuid !== plan.pcbUuid || documentInfo.documentType !== 3) throw new Error("active PCB UUID/type mismatch");
const value = (object, methodName, propertyName) => typeof object?.[methodName] === "function" ? object[methodName]() : object?.[propertyName];
const beforeLines = await eda.pcb_PrimitiveLine.getAll();
const beforeVias = await eda.pcb_PrimitiveVia.getAll();
const beforeLineIds = beforeLines.map((item) => value(item, "getState_PrimitiveId", "primitiveId"));
const beforeViaIds = beforeVias.map((item) => value(item, "getState_PrimitiveId", "primitiveId"));
for (const primitiveId of plan.deletes?.lineIds || []) await eda.pcb_PrimitiveLine.delete(primitiveId);
for (const primitiveId of plan.deletes?.viaIds || []) await eda.pcb_PrimitiveVia.delete(primitiveId);
const createReturns = { lines: [], vias: [] };
for (const line of plan.creates.lines) {
  const created = await eda.pcb_PrimitiveLine.create(plan.net, EPCB_LayerId[line.layerEnum], line.startX, line.startY, line.endX, line.endY, line.lineWidth, line.primitiveLock);
  createReturns.lines.push(value(created, "getState_PrimitiveId", "primitiveId") || null);
}
for (const via of plan.creates.vias) {
  const created = await eda.pcb_PrimitiveVia.create(plan.net, via.x, via.y, via.holeDiameter, via.diameter, EPCB_PrimitiveViaType[via.viaType], via.designRuleBlindViaName || null, null, via.primitiveLock);
  createReturns.vias.push(value(created, "getState_PrimitiveId", "primitiveId") || null);
}
const saveReturned = await eda.pcb_Document.save();
const immediateDrc = await eda.pcb_Drc.check(true, false, true);
const afterLines = await eda.pcb_PrimitiveLine.getAll();
const afterVias = await eda.pcb_PrimitiveVia.getAll();
return {
  transactionId: plan.transactionId,
  projectUuid: project.uuid,
  pcbUuid: documentInfo.uuid,
  beforeLineIds,
  beforeViaIds,
  afterLineIds: afterLines.map((item) => value(item, "getState_PrimitiveId", "primitiveId")),
  afterViaIds: afterVias.map((item) => value(item, "getState_PrimitiveId", "primitiveId")),
  createReturns,
  saveReturned,
  immediateDrc,
};`;
}

export {
  browserTransactionCode,
  LAYER_ENUM_EXAMPLES,
  stableHash,
  validateTransactionPlan,
};

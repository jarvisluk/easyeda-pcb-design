import { createHash } from "node:crypto";

const SCHEMATIC_DOCUMENT_TYPE = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function sortRecords(records) {
  return [...records].sort((left, right) =>
    JSON.stringify(stableValue(left)).localeCompare(JSON.stringify(stableValue(right))));
}

function normalizeComponent(component, { includePrimitiveId = true } = {}) {
  const normalized = {
    designator: component?.designator || "",
    uniqueId: component?.uniqueId || "",
    name: component?.name || "",
    x: component?.x ?? null,
    y: component?.y ?? null,
    rotation: component?.rotation ?? null,
    mirror: component?.mirror ?? null,
    addIntoBom: component?.addIntoBom ?? null,
    addIntoPcb: component?.addIntoPcb ?? null,
    manufacturer: component?.manufacturer || "",
    manufacturerId: component?.manufacturerId || "",
    supplier: component?.supplier || "",
    supplierId: component?.supplierId || "",
    footprint: component?.footprint || null,
  };
  if (includePrimitiveId) normalized.primitiveId = component?.primitiveId || null;
  return normalized;
}

function normalizeWire(wire, { includePrimitiveId = true } = {}) {
  const normalized = {
    net: wire?.net || "",
    line: stableValue(wire?.line ?? null),
    color: wire?.color ?? null,
    lineWidth: wire?.lineWidth ?? null,
    lineType: wire?.lineType ?? null,
  };
  if (includePrimitiveId) normalized.primitiveId = wire?.primitiveId || null;
  return normalized;
}

function normalizeAnnotation(annotation, { includePrimitiveId = true } = {}) {
  const normalized = {
    componentType: annotation?.componentType || "",
    net: annotation?.net || "",
    x: annotation?.x ?? null,
    y: annotation?.y ?? null,
    rotation: annotation?.rotation ?? null,
  };
  if (includePrimitiveId) normalized.primitiveId = annotation?.primitiveId || null;
  return normalized;
}

function parseNetlist(netlistText) {
  if (typeof netlistText !== "string" || !netlistText.trim()) {
    throw new Error("schematic state lacks a non-empty JLCEDA netlist");
  }
  let parsed;
  try {
    parsed = JSON.parse(netlistText);
  } catch (error) {
    throw new Error(`unable to parse JLCEDA schematic netlist: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JLCEDA schematic netlist must be one JSON object");
  }
  return parsed;
}

function schematicFingerprintPayload(raw, { semanticOnly = false } = {}) {
  if (raw?.kind !== "schematic") throw new Error("schematic state raw payload must have kind schematic");
  const payload = {
    components: sortRecords((raw.components || []).map((item) => normalizeComponent(item, { includePrimitiveId: !semanticOnly }))),
    annotations: sortRecords((raw.annotations || []).map((item) => normalizeAnnotation(item, { includePrimitiveId: !semanticOnly }))),
    wires: sortRecords((raw.wires || []).map((item) => normalizeWire(item, { includePrimitiveId: !semanticOnly }))),
    netlist: stableValue(raw.netlist || {}),
  };
  if (!semanticOnly) {
    payload.projectUuid = raw.project?.uuid || null;
    payload.schematicUuid = raw.schematic?.uuid || null;
    payload.schematicPageUuid = raw.document?.uuid || null;
  }
  return payload;
}

function schematicFingerprint(raw) {
  return stableHash(schematicFingerprintPayload(raw));
}

function schematicSemanticFingerprint(raw) {
  return stableHash(schematicFingerprintPayload(raw, { semanticOnly: true }));
}

function canonicalErcLeaves(raw) {
  const samples = raw?.ercEvidence?.samples || [];
  if (!samples.length) return [];
  const result = samples.at(-1)?.result;
  return Array.isArray(result)
    ? sortRecords(result.map((item) => stableValue(stripVolatileErcFields(item))))
    : [];
}

function stripVolatileErcFields(value) {
  if (Array.isArray(value)) return value.map(stripVolatileErcFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "globalIndex")
      .map(([key, item]) => [key, stripVolatileErcFields(item)]),
  );
}

function ercLeafFindings(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => ercLeafFindings(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const children = Array.isArray(value.list) ? value.list : [];
  if (children.length) children.forEach((item) => ercLeafFindings(item, output));
  else if (value.errorType || value.errorObjType) output.push(value);
  return output;
}

function summarizeErcResult(result) {
  if (!Array.isArray(result)) {
    return {
      passed: false, errorCount: null, warningCount: null,
      errors: [], warnings: [], reason: "schematic DRC did not return detailed array evidence",
    };
  }
  const warnings = result.filter((item) => String(item?.type || "").toLowerCase() === "warn");
  const errors = result.filter((item) => String(item?.type || "").toLowerCase() !== "warn");
  const errorLeaves = ercLeafFindings(errors);
  const warningLeaves = ercLeafFindings(warnings);
  const groupCount = (groups) => groups.reduce(
    (total, item) => total + (Number.isFinite(item?.count) ? item.count : 1),
    0,
  );
  return {
    passed: errors.length === 0,
    errorCount: errorLeaves.length || errors.length,
    warningCount: warningLeaves.length || groupCount(warnings),
    errors: sortRecords(errors.map((item) => stableValue(stripVolatileErcFields(item)))),
    warnings: sortRecords(warnings.map((item) => stableValue(stripVolatileErcFields(item)))),
    errorLeaves: sortRecords(errorLeaves.map((item) => stableValue(stripVolatileErcFields(item)))),
    warningLeaves: sortRecords(warningLeaves.map((item) => stableValue(stripVolatileErcFields(item)))),
    reason: errors.length === 0
      ? "schematic DRC returned zero non-warning error groups"
      : `schematic DRC returned ${errors.length} non-warning error group(s)`,
  };
}

function analyzeErcEvidence(raw) {
  const evidence = raw?.ercEvidence;
  const expected = [
    { id: "silent-1", userInterface: false },
    { id: "silent-2", userInterface: false },
    { id: "visible-final", userInterface: true },
  ];
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : [];
  const contractComplete = Boolean(
    evidence?.schemaVersion === 1 &&
    samples.length === expected.length &&
    samples.every((sample, index) =>
      sample?.id === expected[index].id &&
      sample?.strict === true &&
      sample?.userInterface === expected[index].userInterface &&
      sample?.includeVerboseError === true &&
      Array.isArray(sample?.result)),
  );
  if (!contractComplete) {
    return {
      status: "UNVERIFIED", decision: "UNVERIFIED", passed: false,
      stable: false, contractComplete: false, leaves: [], errors: [], warnings: [],
      errorCount: null, warningCount: null,
      reason: "required two silent and one visible detailed strict schematic DRC samples are absent",
    };
  }
  const fingerprints = samples.map((sample) =>
    stableHash(stripVolatileErcFields(sample.result)));
  const stable = new Set(fingerprints).size === 1;
  const summary = summarizeErcResult(samples.at(-1).result);
  return {
    status: stable ? "CAPTURED" : "UNSTABLE",
    decision: stable ? (summary.passed ? "CLEAR" : "BLOCKED") : "UNVERIFIED",
    contractComplete,
    stable,
    ...summary,
    leaves: canonicalErcLeaves(raw),
    sampleFingerprints: fingerprints,
    reason: stable
      ? `three detailed strict schematic DRC samples agree; ${summary.reason}`
      : "detailed strict schematic DRC samples disagree",
  };
}

function schematicCollectorCode({
  schematicPageUuid,
  schematicUuid,
  switchDocumentUuid,
  includeErc = false,
} = {}) {
  return `
const targetPageUuid = ${JSON.stringify(schematicPageUuid)};
const targetSchematicUuid = ${JSON.stringify(schematicUuid)};
const switchDocumentUuid = ${JSON.stringify(switchDocumentUuid || null)};
const includeErc = ${includeErc === true};
if (switchDocumentUuid) {
  if (switchDocumentUuid === targetPageUuid) throw new Error("switch document must differ from target schematic page");
  await eda.dmt_EditorControl.openDocument(switchDocumentUuid);
  const switched = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!switched || switched.uuid !== switchDocumentUuid) throw new Error("switch document did not become active");
}
await eda.dmt_EditorControl.openDocument(targetPageUuid);
const project = await eda.dmt_Project.getCurrentProjectInfo();
const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
const schematic = await eda.dmt_Schematic.getCurrentSchematicInfo();
const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!project || !document || document.uuid !== targetPageUuid || document.documentType !== ${SCHEMATIC_DOCUMENT_TYPE}) {
  throw new Error("target schematic page UUID/type did not become active");
}
if (!schematic || schematic.uuid !== targetSchematicUuid) throw new Error("parent schematic UUID mismatch");
if (!page || page.uuid !== targetPageUuid) throw new Error("current schematic-page identity mismatch");
const value = (object, method, property) =>
  typeof object?.[method] === "function" ? object[method]() : object?.[property];
const primitives = await eda.sch_PrimitiveComponent.getAll();
const parts = [];
const annotations = [];
for (const item of primitives || []) {
  const componentType = value(item, "getState_ComponentType", "componentType");
  const primitiveId = value(item, "getState_PrimitiveId", "primitiveId");
  if (componentType !== undefined && componentType !== "part") {
    annotations.push({
      primitiveId,
      componentType: componentType || "",
      net: value(item, "getState_Net", "net") || "",
      x: value(item, "getState_X", "x"),
      y: value(item, "getState_Y", "y"),
      rotation: value(item, "getState_Rotation", "rotation"),
    });
    continue;
  }
  parts.push({
    primitiveId,
    designator: value(item, "getState_Designator", "designator") || "",
    uniqueId: value(item, "getState_UniqueId", "uniqueId") || "",
    name: value(item, "getState_Name", "name") || "",
    x: value(item, "getState_X", "x"),
    y: value(item, "getState_Y", "y"),
    rotation: value(item, "getState_Rotation", "rotation"),
    mirror: value(item, "getState_Mirror", "mirror"),
    addIntoBom: value(item, "getState_AddIntoBom", "addIntoBom"),
    addIntoPcb: value(item, "getState_AddIntoPcb", "addIntoPcb"),
    manufacturer: value(item, "getState_Manufacturer", "manufacturer") || "",
    manufacturerId: value(item, "getState_ManufacturerId", "manufacturerId") || "",
    supplier: value(item, "getState_Supplier", "supplier") || "",
    supplierId: value(item, "getState_SupplierId", "supplierId") || "",
    footprint: value(item, "getState_Footprint", "footprint") || null,
  });
}
const wires = (await eda.sch_PrimitiveWire.getAll()).map((wire) => ({
  primitiveId: value(wire, "getState_PrimitiveId", "primitiveId"),
  net: value(wire, "getState_Net", "net") || "",
  line: value(wire, "getState_Line", "line") || null,
  color: value(wire, "getState_Color", "color") ?? null,
  lineWidth: value(wire, "getState_LineWidth", "lineWidth") ?? null,
  lineType: value(wire, "getState_LineType", "lineType") ?? null,
}));
const netlistFile = await eda.sch_ManufactureData.getNetlistFile("SCHEMATIC_STATE", "JLCEDA");
if (!netlistFile) throw new Error("schematic netlist export returned no file");
const netlistText = await netlistFile.text();
let ercEvidence = null;
if (includeErc) {
  const samples = [];
  samples.push({ id: "silent-1", strict: true, userInterface: false, includeVerboseError: true, result: await eda.sch_Drc.check(true, false, true) });
  samples.push({ id: "silent-2", strict: true, userInterface: false, includeVerboseError: true, result: await eda.sch_Drc.check(true, false, true) });
  samples.push({ id: "visible-final", strict: true, userInterface: true, includeVerboseError: true, result: await eda.sch_Drc.check(true, true, true) });
  ercEvidence = { schemaVersion: 1, samples };
}
return {
  kind: "schematic",
  project: { uuid: project.uuid, name: project.friendlyName || project.name || "" },
  schematic: { uuid: schematic.uuid, name: schematic.name || schematic.friendlyName || "" },
  document: { uuid: document.uuid, name: document.name || document.friendlyName || "", documentType: document.documentType },
  reopen: { switchDocumentUuid, targetPageUuid, performed: Boolean(switchDocumentUuid) },
  components: parts,
  annotations,
  wires,
  netlistText,
  ercEvidence,
};`;
}

function finalizeSchematicRaw(raw) {
  const netlist = parseNetlist(raw?.netlistText);
  const finalized = { ...raw, netlist };
  delete finalized.netlistText;
  return finalized;
}

export {
  SCHEMATIC_DOCUMENT_TYPE,
  analyzeErcEvidence,
  canonicalErcLeaves,
  ercLeafFindings,
  finalizeSchematicRaw,
  normalizeAnnotation,
  normalizeComponent,
  normalizeWire,
  parseNetlist,
  schematicCollectorCode,
  schematicFingerprint,
  schematicFingerprintPayload,
  schematicSemanticFingerprint,
  summarizeErcResult,
  stableHash,
  stableValue,
};

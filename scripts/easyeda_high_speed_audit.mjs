#!/usr/bin/env node

/**
 * Audit the active EasyEDA Pro PCB through the easyeda-api bridge.
 *
 * Geometry is reported in EasyEDA PCB canvas units (mil). This tool performs
 * deterministic screening checks. It never returns a bare fabrication PASS.
 * Free-text evidence requires human attestation (env + attest file), or an
 * on-disk artifact path must exist.
 */

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  DECISION_VALUES,
  EXIT,
  applyDecisionExitCode,
  constraintFingerprint,
  designFingerprint,
  evidenceMeetsGate,
  existingArtifactPath,
  fetchJson,
  findBridge,
  highRiskInterfaceReasons,
  nonemptyString,
  notAFabricationReleaseMessage,
  resolveHumanAttestation,
  resolveManufacturingReview,
  resolveSafeOutputPath,
  resolveWindow,
} from "./audit_common.mjs";

const DECISIONS = DECISION_VALUES;
// The bridge execution sandbox does not expose enum globals. This value is
// copied from the exact EDMT_EditorDocumentType reference in easyeda-api.
const PCB_DOCUMENT_TYPE = 3;
const REVIEW_EVIDENCE = new Set([
  "MANUAL_REVIEWED",
  "SOLVER_VERIFIED",
  "MEASUREMENT_VERIFIED",
]);
const IMPEDANCE_EVIDENCE = new Set([
  "FAB_CONFIRMED",
  "SOLVER_VERIFIED",
  "MEASUREMENT_VERIFIED",
]);
const HIGH_RISK_EVIDENCE = new Set(["SOLVER_VERIFIED", "MEASUREMENT_VERIFIED"]);

function usage() {
  return `Usage:
  node easyeda_high_speed_audit.mjs [options]

Options:
  --constraints FILE               JSON constraint/evidence record (recommended)
  --high-speed-net NET             Add a high-speed net (repeatable)
  --pair POS:NEG                   Add a differential pair (repeatable)
  --ground-net NET                 Return/reference net (default: GND)
  --max-pair-skew-mil N            Explicit fallback pair mismatch limit
  --max-return-via-distance-mil N  Explicit fallback return-via distance limit
  --require-ground-pour            Require a valid filled reference-net pour (default)
  --allow-no-ground-pour           Opt out of the ground-pour requirement
  --exception-note TEXT            Required with --allow-no-ground-pour
  --user-attested-evidence         Request free-text evidence (needs human env+file)
  --attest-file FILE               Human attest file (required with attestation)
  --manufacturing-reviewed         Mark Gerber/BOM/PnP reviewed (needs human attest)
  --bridge-port PORT               Use one bridge port instead of scanning
  --window-id ID                   Required when multiple EasyEDA windows exist
  --output FILE                    Relative path under cwd for the JSON report
  --force                          Overwrite an existing --output file
  --self-test                      Run deterministic offline checks
  --help                           Show this help

Human attestation also requires EASYEDA_AUDIT_USER_ATTEST=YES in the human shell.
Agents must never set that env var or write the attest file.

Exit codes: 1=error, 2=FAIL, 3=UNVERIFIED FOR FABRICATION,
4=PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS (not a fab release).
`;
}

function finitePositive(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${option} requires a positive finite number`);
  }
  return number;
}

function parsePair(value) {
  const separator = value.includes(":") ? ":" : ",";
  const parts = value.split(separator).map((item) => item.trim());
  if (parts.length !== 2 || parts.some((item) => !item)) {
    throw new Error(`--pair must be POS:NEG or POS,NEG; received ${value}`);
  }
  return { positive: parts[0], negative: parts[1] };
}

function parseArgs(argv) {
  const options = {
    constraintsPath: undefined,
    constraintRecord: undefined,
    highSpeedNets: [],
    pairs: [],
    groups: [],
    interfaces: [],
    groundNet: "GND",
    maxPairSkewMil: undefined,
    maxReturnViaDistanceMil: undefined,
    requireGroundPour: true,
    allowNoGroundPour: false,
    exceptionNote: undefined,
    userAttestedEvidence: false,
    attestFile: undefined,
    manufacturingReviewed: false,
    humanAttestation: undefined,
    bridgePort: undefined,
    windowId: undefined,
    output: undefined,
    force: false,
    selfTest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };

    if (option === "--constraints") options.constraintsPath = next();
    else if (option === "--high-speed-net") options.highSpeedNets.push(next());
    else if (option === "--pair") options.pairs.push(parsePair(next()));
    else if (option === "--ground-net") options.groundNet = next();
    else if (option === "--max-pair-skew-mil") {
      options.maxPairSkewMil = finitePositive(next(), option);
    } else if (option === "--max-return-via-distance-mil") {
      options.maxReturnViaDistanceMil = finitePositive(next(), option);
    } else if (option === "--require-ground-pour") options.requireGroundPour = true;
    else if (option === "--allow-no-ground-pour") {
      options.allowNoGroundPour = true;
      options.requireGroundPour = false;
    } else if (option === "--exception-note") options.exceptionNote = next();
    else if (option === "--user-attested-evidence") {
      options.userAttestedEvidence = true;
    } else if (option === "--attest-file") options.attestFile = next();
    else if (option === "--manufacturing-reviewed") {
      options.manufacturingReviewed = true;
    } else if (option === "--bridge-port") {
      options.bridgePort = finitePositive(next(), option);
      if (!Number.isInteger(options.bridgePort) || options.bridgePort > 65535) {
        throw new Error("--bridge-port must be an integer from 1 to 65535");
      }
    } else if (option === "--window-id") options.windowId = next();
    else if (option === "--output") options.output = next();
    else if (option === "--force") options.force = true;
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }

  if (!nonemptyString(options.groundNet)) {
    throw new Error("--ground-net requires a non-empty net name");
  }
  if (options.allowNoGroundPour && !nonemptyString(options.exceptionNote)) {
    throw new Error("--allow-no-ground-pour requires --exception-note TEXT");
  }
  if (options.manufacturingReviewed && !nonemptyString(options.attestFile)) {
    throw new Error("--manufacturing-reviewed requires --attest-file");
  }
  if (options.userAttestedEvidence && !nonemptyString(options.attestFile)) {
    throw new Error("--user-attested-evidence requires --attest-file");
  }
  options.humanAttestation = resolveHumanAttestation(options);
  return options;
}

function normalizedClassification(value) {
  if (!nonemptyString(value)) return undefined;
  const normalized = value.trim().toUpperCase().replaceAll(/[\s/-]+/g, "_");
  if (normalized === "CONTROLLED_HIGH_SPEED" || normalized === "HIGH_RISK_SI") {
    return normalized;
  }
  return value;
}

function pairFromRecord(value, inherited, interfaceName) {
  const pair = typeof value === "string" ? parsePair(value) : value;
  if (!pair || !nonemptyString(pair.positive) || !nonemptyString(pair.negative)) {
    throw new Error(`invalid differential pair in interface ${interfaceName || "<unnamed>"}`);
  }
  const limit = pair.maxSkewMil ?? inherited.maxPairSkewMil;
  return {
    positive: pair.positive.trim(),
    negative: pair.negative.trim(),
    maxSkewMil:
      limit === undefined ? undefined : finitePositive(limit, "pair maxSkewMil"),
    interfaceName,
    topology: pair.topology || inherited.topology,
  };
}

function groupFromRecord(value, inherited, interfaceName) {
  if (!value || !nonemptyString(value.name) || !Array.isArray(value.nets)) {
    throw new Error(`invalid length group in interface ${interfaceName || "<unnamed>"}`);
  }
  const nets = [...new Set(value.nets.filter(nonemptyString).map((net) => net.trim()))];
  if (nets.length < 2) {
    throw new Error(`length group ${value.name} must contain at least two nets`);
  }
  const limit = value.maxSkewMil ?? inherited.maxGroupSkewMil;
  return {
    name: value.name.trim(),
    nets,
    maxSkewMil:
      limit === undefined ? undefined : finitePositive(limit, "group maxSkewMil"),
    interfaceName,
  };
}

function mergeConstraintRecord(options, record) {
  if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error("constraint record must be a JSON object");
  }

  const merged = {
    ...options,
    constraintRecord: record,
    classification: normalizedClassification(record?.classification),
    fabricator: record?.fabricator,
    stackup: record?.stackup,
    evidenceRecord: record?.evidence,
    interfaces: [],
    groups: [],
  };
  const highSpeedNets = new Set(options.highSpeedNets.filter(nonemptyString));
  const pairs = options.pairs.map((pair) => ({
    ...pair,
    maxSkewMil: options.maxPairSkewMil,
    interfaceName: "CLI",
    topology: undefined,
  }));
  const groups = [];

  if (record?.groundNet !== undefined) {
    if (!nonemptyString(record.groundNet)) {
      throw new Error("constraint groundNet must be a non-empty string");
    }
    merged.groundNet = record.groundNet.trim();
  }
  if (record?.requireGroundPour !== undefined) {
    merged.requireGroundPour = Boolean(record.requireGroundPour);
  } else if (record && !options.allowNoGroundPour) {
    merged.requireGroundPour = true;
  }
  if (record?.exceptionNote !== undefined && nonemptyString(record.exceptionNote)) {
    merged.exceptionNote = record.exceptionNote.trim();
  }
  if (merged.requireGroundPour === false && !nonemptyString(merged.exceptionNote)) {
    throw new Error(
      "requireGroundPour=false requires exceptionNote in the constraint record or --exception-note",
    );
  }
  if (record?.maxReturnViaDistanceMil !== undefined) {
    merged.maxReturnViaDistanceMil = finitePositive(
      record.maxReturnViaDistanceMil,
      "constraint maxReturnViaDistanceMil",
    );
  }

  const interfaces = Array.isArray(record?.interfaces) ? record.interfaces : [];
  for (const item of interfaces) {
    if (!item || typeof item !== "object" || !nonemptyString(item.name)) {
      throw new Error("every constraint interface requires a non-empty name");
    }
    const interfaceName = item.name.trim();
    const nets = Array.isArray(item.nets)
      ? [...new Set(item.nets.filter(nonemptyString).map((net) => net.trim()))]
      : [];
    for (const net of nets) highSpeedNets.add(net);
    const inherited = {
      maxPairSkewMil: item.maxPairSkewMil ?? record?.maxPairSkewMil,
      maxGroupSkewMil: item.maxGroupSkewMil ?? record?.maxGroupSkewMil,
      topology: item.topology,
    };
    const interfacePairs = Array.isArray(item.pairs)
      ? item.pairs.map((pair) => pairFromRecord(pair, inherited, interfaceName))
      : [];
    const interfaceGroups = Array.isArray(item.groups)
      ? item.groups.map((group) => groupFromRecord(group, inherited, interfaceName))
      : [];
    for (const pair of interfacePairs) {
      highSpeedNets.add(pair.positive);
      highSpeedNets.add(pair.negative);
      pairs.push(pair);
    }
    for (const group of interfaceGroups) {
      group.nets.forEach((net) => highSpeedNets.add(net));
      groups.push(group);
    }
    if (item.maxReturnViaDistanceMil !== undefined) {
      const limit = finitePositive(
        item.maxReturnViaDistanceMil,
        `${interfaceName} maxReturnViaDistanceMil`,
      );
      merged.maxReturnViaDistanceMil =
        merged.maxReturnViaDistanceMil === undefined
          ? limit
          : Math.min(merged.maxReturnViaDistanceMil, limit);
    }
    merged.interfaces.push({ ...item, name: interfaceName, nets });
  }

  for (const pair of pairs) {
    highSpeedNets.add(pair.positive);
    highSpeedNets.add(pair.negative);
  }
  merged.highSpeedNets = [...highSpeedNets];
  merged.pairs = pairs;
  merged.groups = groups;
  return merged;
}

async function loadAndMergeConstraints(options) {
  if (!options.constraintsPath) return mergeConstraintRecord(options, undefined);
  let record;
  try {
    record = JSON.parse(await readFile(options.constraintsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read constraint record ${options.constraintsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return mergeConstraintRecord(options, record);
}

function collectorCode() {
  return `
const project = await eda.dmt_Project.getCurrentProjectInfo();
if (!project) throw new Error("No EasyEDA project is open");
const documentInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!documentInfo || documentInfo.documentType !== ${PCB_DOCUMENT_TYPE}) {
  throw new Error("The active EasyEDA document is not a PCB");
}

const value = (object, methodName, propertyName) => {
  if (typeof object[methodName] === "function") return object[methodName]();
  return object[propertyName];
};
const layers = await eda.pcb_Layer.getAllLayers();
const netNames = await eda.pcb_Net.getAllNetsName();
const components = await eda.pcb_PrimitiveComponent.getAll();
const lines = await eda.pcb_PrimitiveLine.getAll();
const arcs = await eda.pcb_PrimitiveArc.getAll();
const polylines = await eda.pcb_PrimitivePolyline.getAll();
const vias = await eda.pcb_PrimitiveVia.getAll();
const pours = await eda.pcb_PrimitivePour.getAll();

const segments = lines
  .map((line) => ({
    primitiveId: value(line, "getState_PrimitiveId", "primitiveId"),
    segmentKind: "line",
    net: value(line, "getState_Net", "net") || "",
    layer: value(line, "getState_Layer", "layer"),
    lineWidth: value(line, "getState_LineWidth", "lineWidth"),
    startX: value(line, "getState_StartX", "startX"),
    startY: value(line, "getState_StartY", "startY"),
    endX: value(line, "getState_EndX", "endX"),
    endY: value(line, "getState_EndY", "endY"),
  }))
  .filter((line) =>
    [line.startX, line.startY, line.endX, line.endY].every(Number.isFinite)
  );

for (const arc of arcs) {
  const item = {
    primitiveId: value(arc, "getState_PrimitiveId", "primitiveId"),
    segmentKind: "arc",
    net: value(arc, "getState_Net", "net") || "",
    layer: value(arc, "getState_Layer", "layer"),
    lineWidth: value(arc, "getState_LineWidth", "lineWidth"),
    startX: value(arc, "getState_StartX", "startX"),
    startY: value(arc, "getState_StartY", "startY"),
    endX: value(arc, "getState_EndX", "endX"),
    endY: value(arc, "getState_EndY", "endY"),
    arcAngle: value(arc, "getState_ArcAngle", "arcAngle"),
  };
  if ([item.startX, item.startY, item.endX, item.endY, item.arcAngle].every(Number.isFinite)) {
    segments.push(item);
  }
}

for (const polyline of polylines) {
  const net = value(polyline, "getState_Net", "net") || "";
  const polygon = value(polyline, "getState_Polygon", "polygon");
  const points = polygon && typeof polygon.discretize === "function"
    ? polygon.discretize()
    : [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) continue;
    segments.push({
      primitiveId:
        value(polyline, "getState_PrimitiveId", "primitiveId") + ":" + (index - 1),
      segmentKind: "polyline",
      net,
      layer: value(polyline, "getState_Layer", "layer"),
      lineWidth: value(polyline, "getState_LineWidth", "lineWidth"),
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
    });
  }
}

const viaData = vias
  .map((via) => ({
    primitiveId: value(via, "getState_PrimitiveId", "primitiveId"),
    net: value(via, "getState_Net", "net") || "",
    x: value(via, "getState_X", "x"),
    y: value(via, "getState_Y", "y"),
    diameter: value(via, "getState_Diameter", "diameter"),
    holeDiameter: value(via, "getState_HoleDiameter", "holeDiameter"),
    viaType: value(via, "getState_ViaType", "viaType"),
    blindViaRule:
      value(via, "getState_DesignRuleBlindViaName", "designRuleBlindViaName") || null,
  }))
  .filter((via) => Number.isFinite(via.x) && Number.isFinite(via.y));

const pourData = [];
for (const pour of pours) {
  const copper = await pour.getCopperRegion();
  const fills = copper ? copper.getState_PourFills() : [];
  pourData.push({
    primitiveId: value(pour, "getState_PrimitiveId", "primitiveId"),
    name: value(pour, "getState_PourName", "pourName") || "",
    net: value(pour, "getState_Net", "net") || "",
    layer: value(pour, "getState_Layer", "layer"),
    preserveSilos: Boolean(
      value(pour, "getState_PreserveSilos", "preserveSilos")
    ),
    hasCopper: Boolean(copper),
    fillCount: fills.length,
    solidFillCount: fills.filter((fill) => fill && fill.fill === true).length,
  });
}

const drc = await eda.pcb_Drc.check(true, false, true);
return {
  project: {
    uuid: project.uuid,
    name: project.friendlyName || project.name || "",
  },
  document: {
    uuid: documentInfo.uuid,
    name: documentInfo.name || documentInfo.friendlyName || "",
    documentType: documentInfo.documentType,
  },
  layers: layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    type: layer.type,
  })),
  netNames,
  components: components.map((component) => ({
    primitiveId: value(component, "getState_PrimitiveId", "primitiveId"),
    designator: value(component, "getState_Designator", "designator") || "",
    layer: value(component, "getState_Layer", "layer"),
    x: value(component, "getState_X", "x"),
    y: value(component, "getState_Y", "y"),
  })),
  segments,
  vias: viaData,
  pours: pourData,
  drc,
};`;
}

async function collectFromEasyEda(bridge, windowId) {
  const response = await fetchJson(
    `http://127.0.0.1:${bridge.port}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: collectorCode(), windowId }),
    },
    120_000,
  );
  if (!response.success) throw new Error(response.error || "EasyEDA execution failed");
  return { raw: response.result, windowId: response.windowId };
}

function drcSummary(drc) {
  if (typeof drc === "boolean") {
    return { passed: drc, errorCount: drc ? 0 : null, errors: [] };
  }
  if (Array.isArray(drc)) {
    return { passed: drc.length === 0, errorCount: drc.length, errors: drc };
  }
  return {
    passed: false,
    errorCount: null,
    errors: [],
    note: "Unexpected DRC response; review in EasyEDA",
  };
}

function segmentLength(segment) {
  const chord = Math.hypot(
    segment.endX - segment.startX,
    segment.endY - segment.startY,
  );
  if (segment.segmentKind !== "arc") return chord;
  const radians = (Math.abs(segment.arcAngle) * Math.PI) / 180;
  const sine = Math.sin(radians / 2);
  if (radians <= 0 || Math.abs(sine) < 1e-12) return chord;
  return (chord / (2 * Math.abs(sine))) * radians;
}

function coordinateKey(x, y, layer) {
  const quantize = (value) => Math.round(value / 0.05);
  return `${quantize(x)},${quantize(y)},${layer}`;
}

function coordinateOnlyKey(x, y) {
  const quantize = (value) => Math.round(value / 0.05);
  return `${quantize(x)},${quantize(y)}`;
}

function routeSummary(net, segments, vias) {
  const routeSegments = segments.filter((segment) => segment.net === net);
  const routeVias = vias.filter((via) => via.net === net);
  const adjacency = new Map();
  const coordinates = new Map();
  const addNode = (key, coordinate) => {
    if (!adjacency.has(key)) adjacency.set(key, new Set());
    coordinates.set(key, coordinate);
  };
  const connect = (left, right) => {
    adjacency.get(left).add(right);
    adjacency.get(right).add(left);
  };

  for (const segment of routeSegments) {
    const start = coordinateKey(segment.startX, segment.startY, segment.layer);
    const end = coordinateKey(segment.endX, segment.endY, segment.layer);
    addNode(start, {
      x: segment.startX,
      y: segment.startY,
      layer: segment.layer,
    });
    addNode(end, { x: segment.endX, y: segment.endY, layer: segment.layer });
    connect(start, end);
  }

  for (const via of routeVias) {
    const coordinate = coordinateOnlyKey(via.x, via.y);
    const matching = [...coordinates.entries()]
      .filter(([, item]) => coordinateOnlyKey(item.x, item.y) === coordinate)
      .map(([key]) => key);
    for (let index = 1; index < matching.length; index += 1) {
      connect(matching[0], matching[index]);
    }
  }

  let connectedComponents = 0;
  const visited = new Set();
  for (const node of adjacency.keys()) {
    if (visited.has(node)) continue;
    connectedComponents += 1;
    const pending = [node];
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...adjacency.get(current));
    }
  }
  const branchVertices = [...adjacency.entries()]
    .filter(([, neighbors]) => neighbors.size > 2)
    .map(([key, neighbors]) => ({ key, degree: neighbors.size }));
  const endpointCount = [...adjacency.values()].filter(
    (neighbors) => neighbors.size === 1,
  ).length;
  const layers = [...new Set(routeSegments.map((segment) => segment.layer))].sort();
  const widthsMil = [
    ...new Set(
      routeSegments
        .map((segment) => segment.lineWidth)
        .filter(Number.isFinite)
        .map((width) => Number(width.toFixed(3))),
    ),
  ].sort((left, right) => left - right);
  const lengthMil = routeSegments.reduce(
    (total, segment) => total + segmentLength(segment),
    0,
  );

  return {
    net,
    present: routeSegments.length > 0 || routeVias.length > 0,
    segmentCount: routeSegments.length,
    viaCount: routeVias.length,
    lengthMil: Number(lengthMil.toFixed(3)),
    layers,
    widthsMil,
    connectedComponents,
    endpointCount,
    branchVertices,
    containsArc: routeSegments.some((segment) => segment.segmentKind === "arc"),
    containsPolyline: routeSegments.some(
      (segment) => segment.segmentKind === "polyline",
    ),
  };
}

function evidenceStatus(evidenceRecord, key) {
  const value = evidenceRecord?.[key];
  if (nonemptyString(value)) return value.trim();
  if (value && typeof value === "object" && nonemptyString(value.status)) {
    return value.status.trim();
  }
  return undefined;
}

function validEvidence(evidenceRecord, key, acceptedStatuses, options) {
  return evidenceMeetsGate(evidenceRecord?.[key], acceptedStatuses, options);
}

function evidenceGateHint() {
  return "existing artifact/artifactPath, or human attestation (EASYEDA_AUDIT_USER_ATTEST=YES + --attest-file)";
}

function constraintCompleteness(options, signalViaCount) {
  const missing = [];
  const record = options.constraintRecord;
  if (!record) {
    missing.push("no --constraints record was supplied");
    return missing;
  }
  const autoHighRiskReasons = highRiskInterfaceReasons(options.interfaces);
  const effectivelyHighRisk =
    options.classification === "HIGH_RISK_SI" || autoHighRiskReasons.length > 0;
  if (
    !["CONTROLLED_HIGH_SPEED", "HIGH_RISK_SI"].includes(options.classification) &&
    !effectivelyHighRisk
  ) {
    missing.push("classification must be CONTROLLED_HIGH_SPEED or HIGH_RISK_SI");
  } else if (
    !["CONTROLLED_HIGH_SPEED", "HIGH_RISK_SI"].includes(options.classification) &&
    effectivelyHighRisk
  ) {
    missing.push("classification must be CONTROLLED_HIGH_SPEED or HIGH_RISK_SI");
  }
  if (autoHighRiskReasons.length && options.classification !== "HIGH_RISK_SI") {
    missing.push(
      `classification must be HIGH_RISK_SI (${autoHighRiskReasons.join("; ")})`,
    );
  }
  if (!nonemptyString(options.fabricator)) missing.push("fabricator is missing");
  if (!options.highSpeedNets.length) missing.push("no high-speed nets are listed");
  if (!options.interfaces.length) missing.push("no interfaces are defined");

  const stackup = options.stackup;
  if (!stackup || typeof stackup !== "object") {
    missing.push("stackup is missing");
  } else {
    if (!nonemptyString(stackup.source)) missing.push("stackup.source is missing");
    if (!nonemptyString(stackup.sourceDocument)) {
      missing.push("stackup.sourceDocument is missing");
    }
    for (const key of [
      "boardThicknessMm",
      "copperThicknessUm",
      "dielectricHeightMm",
      "dk",
      "lossTangent",
      "frequencyGhz",
    ]) {
      if (!Number.isFinite(stackup[key]) || stackup[key] <= 0) {
        missing.push(`stackup.${key} must be a positive number`);
      }
    }
    if (
      !Array.isArray(stackup.layers) ||
      stackup.layers.length < 2 ||
      stackup.layers.some(
        (layer) =>
          !layer ||
          !nonemptyString(layer.name) ||
          !nonemptyString(layer.role),
      )
    ) {
      missing.push("stackup.layers must list at least two named layer roles");
    }
    if (stackup.source !== "FAB_CONFIRMED") {
      missing.push("stackup is not FAB_CONFIRMED");
    } else if (
      !existingArtifactPath(stackup.artifactPath || stackup.artifact) &&
      !options.humanAttestation?.accepted
    ) {
      missing.push(`stackup FAB_CONFIRMED requires ${evidenceGateHint()}`);
      if (options.humanAttestation?.requested && options.humanAttestation?.reason) {
        missing.push(options.humanAttestation.reason);
      }
    } else if (
      options.humanAttestation?.accepted &&
      !existingArtifactPath(stackup.artifactPath || stackup.artifact) &&
      !nonemptyString(stackup.sourceDocument)
    ) {
      missing.push("attested stackup requires sourceDocument text");
    }
  }

  for (const item of options.interfaces) {
    if (!item.nets.length && !Array.isArray(item.pairs)) {
      missing.push(`interface ${item.name} has no nets or pairs`);
    }
    if (!Number.isFinite(item.dataRateGbps) && !Number.isFinite(item.riseTimePs)) {
      missing.push(`interface ${item.name} needs dataRateGbps or riseTimePs`);
    }
    if (!nonemptyString(item.topology)) {
      missing.push(`interface ${item.name} topology is missing`);
    }
    if (!nonemptyString(item.requirementsSource)) {
      missing.push(`interface ${item.name} requirementsSource is missing`);
    }
    if (
      !Array.isArray(item.endpoints) ||
      item.endpoints.filter(nonemptyString).length < 2
    ) {
      missing.push(`interface ${item.name} needs at least two named endpoints`);
    }
    if (
      !item.protection ||
      typeof item.protection !== "object" ||
      !["IMPLEMENTED", "NOT_REQUIRED", "NOT_APPLICABLE"].includes(
        item.protection.disposition,
      )
    ) {
      missing.push(`interface ${item.name} protection disposition is missing`);
    } else if (
      item.protection.disposition === "IMPLEMENTED" &&
      (!Array.isArray(item.protection.parts) ||
        item.protection.parts.filter(nonemptyString).length === 0)
    ) {
      missing.push(`interface ${item.name} implemented protection has no parts`);
    }
    if (!Array.isArray(item.testPoints)) {
      missing.push(`interface ${item.name} testPoints must be explicitly listed`);
    }
    if (!Number.isFinite(item.maxStubMil) || item.maxStubMil <= 0) {
      missing.push(`interface ${item.name} maxStubMil is missing`);
    }
    if (
      item.terminationNotApplicable !== true &&
      (!item.termination ||
        typeof item.termination !== "object" ||
        !nonemptyString(item.termination.type) ||
        !nonemptyString(item.termination.owner) ||
        !nonemptyString(item.termination.source))
    ) {
      missing.push(`interface ${item.name} termination record is incomplete`);
    }
    if (
      item.acCouplingNotApplicable !== true &&
      (!item.acCoupling ||
        typeof item.acCoupling !== "object" ||
        !nonemptyString(item.acCoupling.owner) ||
        !nonemptyString(item.acCoupling.source))
    ) {
      missing.push(`interface ${item.name} AC-coupling record is incomplete`);
    }
    if (
      item.connectorNotApplicable !== true &&
      !nonemptyString(item.connectorOrCableModel)
    ) {
      missing.push(`interface ${item.name} connector/cable model is missing`);
    }
    if (
      !item.referenceBySignalLayer ||
      typeof item.referenceBySignalLayer !== "object" ||
      Array.isArray(item.referenceBySignalLayer) ||
      !Object.keys(item.referenceBySignalLayer).length
    ) {
      missing.push(`interface ${item.name} referenceBySignalLayer is missing`);
    }
    const hasImpedance =
      Number.isFinite(item.targetDiffOhm) || Number.isFinite(item.targetSingleOhm);
    if (!hasImpedance) {
      missing.push(`interface ${item.name} target impedance is missing`);
    }
    if (!Number.isFinite(item.tolerancePercent) || item.tolerancePercent <= 0) {
      missing.push(`interface ${item.name} tolerancePercent is missing`);
    }
  }
  for (const pair of options.pairs) {
    if (!Number.isFinite(pair.maxSkewMil)) {
      missing.push(
        `pair ${pair.positive}/${pair.negative} has no explicit maxSkewMil`,
      );
    }
  }
  for (const group of options.groups) {
    if (!Number.isFinite(group.maxSkewMil)) {
      missing.push(`group ${group.name} has no explicit maxSkewMil`);
    }
  }
  if (
    signalViaCount > 0 &&
    !Number.isFinite(options.maxReturnViaDistanceMil)
  ) {
    missing.push("signal vias exist but maxReturnViaDistanceMil is missing");
  }

  if (
    !validEvidence(
      options.evidenceRecord,
      "impedance",
      IMPEDANCE_EVIDENCE,
      options,
    )
  ) {
    missing.push(`impedance evidence missing (${evidenceGateHint()})`);
  }
  if (
    !validEvidence(
      options.evidenceRecord,
      "continuousReference",
      REVIEW_EVIDENCE,
      options,
    )
  ) {
    missing.push(
      `continuous-reference review evidence missing (${evidenceGateHint()})`,
    );
  }
  if (
    options.pairs.length &&
    !validEvidence(options.evidenceRecord, "coupling", REVIEW_EVIDENCE, options)
  ) {
    missing.push(
      `differential coupling review evidence missing (${evidenceGateHint()})`,
    );
  }
  const launchDeclared = options.interfaces.some(
    (item) =>
      item.protection?.disposition === "IMPLEMENTED" ||
      (item.connectorNotApplicable !== true &&
        nonemptyString(item.connectorOrCableModel)),
  );
  if (record.launchesNotApplicable === true && launchDeclared) {
    missing.push(
      "launchesNotApplicable conflicts with a connector/model or implemented protection",
    );
  } else if (
    record.launchesNotApplicable !== true &&
    !validEvidence(options.evidenceRecord, "launches", REVIEW_EVIDENCE, options)
  ) {
    missing.push(
      `connector/BGA/protection launch review evidence missing (${evidenceGateHint()})`,
    );
  }
  if (
    signalViaCount > 0 &&
    !validEvidence(
      options.evidenceRecord,
      "returnViaLayerSpan",
      REVIEW_EVIDENCE,
      options,
    )
  ) {
    missing.push(
      `return-via layer-span review evidence missing (${evidenceGateHint()})`,
    );
  }
  if (
    effectivelyHighRisk &&
    !validEvidence(
      options.evidenceRecord,
      "solverOrMeasurement",
      HIGH_RISK_EVIDENCE,
      options,
    )
  ) {
    missing.push("high-risk SI requires solver or measurement evidence");
    for (const reason of autoHighRiskReasons) missing.push(reason);
  }
  return [...new Set(missing)];
}

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function analyze(raw, options, source) {
  const tolerance = 0.05;
  const segments = Array.isArray(raw.segments)
    ? raw.segments
    : (raw.lines || []).map((line) => ({ ...line, segmentKind: "line" }));
  const vias = raw.vias || [];
  const summaries = new Map(
    options.highSpeedNets.map((net) => [
      net,
      routeSummary(net, segments, vias),
    ]),
  );
  const missingHighSpeedNets = [...summaries.values()]
    .filter((summary) => !summary.present)
    .map((summary) => summary.net);

  const nonStandardAngles = segments
    .filter(
      (segment) =>
        segment.segmentKind === "line" && summaries.has(segment.net),
    )
    .filter((segment) => {
      const dx = Math.abs(segment.endX - segment.startX);
      const dy = Math.abs(segment.endY - segment.startY);
      return dx > tolerance && dy > tolerance && Math.abs(dx - dy) > tolerance;
    })
    .map((segment) => ({
      primitiveId: segment.primitiveId,
      net: segment.net,
      layer: segment.layer,
      angleDeg: Number(
        (
          (Math.atan2(
            segment.endY - segment.startY,
            segment.endX - segment.startX,
          ) *
            180) /
          Math.PI
        ).toFixed(3),
      ),
    }));

  const pairChecks = options.pairs.map((pair) => {
    const positive = summaries.get(pair.positive) ||
      routeSummary(pair.positive, segments, vias);
    const negative = summaries.get(pair.negative) ||
      routeSummary(pair.negative, segments, vias);
    const skewMil = Math.abs(positive.lengthMil - negative.lengthMil);
    const layerSetsMatch = arraysEqual(positive.layers, negative.layers);
    const widthsMatch =
      positive.widthsMil.length > 0 &&
      negative.widthsMil.length > 0 &&
      arraysEqual(positive.widthsMil, negative.widthsMil);
    const topologyPassed =
      positive.connectedComponents === 1 &&
      negative.connectedComponents === 1 &&
      positive.branchVertices.length === 0 &&
      negative.branchVertices.length === 0;
    const limitPresent = Number.isFinite(pair.maxSkewMil);
    const hardFailure =
      !positive.present ||
      !negative.present ||
      !layerSetsMatch ||
      !widthsMatch ||
      !topologyPassed ||
      (limitPresent && skewMil > pair.maxSkewMil);
    return {
      ...pair,
      positive,
      negative,
      skewMil: Number(skewMil.toFixed(3)),
      limitMil: pair.maxSkewMil ?? null,
      limitPresent,
      layerSetsMatch,
      widthsMatch,
      topologyPassed,
      hardFailure,
      passed:
        !hardFailure &&
        limitPresent &&
        skewMil <= pair.maxSkewMil,
    };
  });

  const groupChecks = options.groups.map((group) => {
    const members = group.nets.map(
      (net) => summaries.get(net) || routeSummary(net, segments, vias),
    );
    const lengths = members.map((member) => member.lengthMil);
    const skewMil = lengths.length ? Math.max(...lengths) - Math.min(...lengths) : 0;
    const limitPresent = Number.isFinite(group.maxSkewMil);
    const hardFailure =
      members.some((member) => !member.present) ||
      (limitPresent && skewMil > group.maxSkewMil);
    return {
      ...group,
      members,
      skewMil: Number(skewMil.toFixed(3)),
      limitMil: group.maxSkewMil ?? null,
      limitPresent,
      hardFailure,
      passed:
        !hardFailure &&
        limitPresent &&
        skewMil <= group.maxSkewMil,
    };
  });

  const pointToPointIssues = [];
  for (const item of options.interfaces) {
    if (String(item.topology).toLowerCase() !== "point-to-point") continue;
    for (const net of item.nets) {
      const summary = summaries.get(net);
      if (
        summary?.present &&
        (summary.connectedComponents !== 1 || summary.branchVertices.length > 0)
      ) {
        pointToPointIssues.push({
          interfaceName: item.name,
          net,
          connectedComponents: summary.connectedComponents,
          branchVertices: summary.branchVertices,
        });
      }
    }
  }

  const groundVias = vias.filter((via) => via.net === options.groundNet);
  const signalVias = vias.filter((via) => summaries.has(via.net));
  const returnViaChecks = signalVias.map((via) => {
    let nearest;
    for (const groundVia of groundVias) {
      const distance = Math.hypot(via.x - groundVia.x, via.y - groundVia.y);
      if (!nearest || distance < nearest.distanceMil) {
        nearest = { primitiveId: groundVia.primitiveId, distanceMil: distance };
      }
    }
    const limitPresent = Number.isFinite(options.maxReturnViaDistanceMil);
    const hardFailure = Boolean(
      !nearest ||
        (limitPresent &&
          nearest.distanceMil > options.maxReturnViaDistanceMil),
    );
    return {
      signalViaId: via.primitiveId,
      net: via.net,
      viaType: via.viaType ?? null,
      blindViaRule: via.blindViaRule ?? null,
      nearestReturnViaId: nearest?.primitiveId || null,
      distanceMil: nearest ? Number(nearest.distanceMil.toFixed(3)) : null,
      limitMil: options.maxReturnViaDistanceMil ?? null,
      limitPresent,
      hardFailure,
      proximityPassed: Boolean(
        nearest &&
          limitPresent &&
          nearest.distanceMil <= options.maxReturnViaDistanceMil,
      ),
      layerSpanEvidence: evidenceStatus(
        options.evidenceRecord,
        "returnViaLayerSpan",
      ) || null,
    };
  });

  const pours = (raw.pours || []).map((pour) => ({
    ...pour,
    passed:
      pour.hasCopper &&
      pour.fillCount > 0 &&
      pour.solidFillCount > 0 &&
      !pour.preserveSilos,
  }));
  const groundPours = pours.filter((pour) => pour.net === options.groundNet);
  const groundPourPresent = groundPours.some((pour) => pour.passed);
  const drc = drcSummary(raw.drc);
  const incompleteConstraints = constraintCompleteness(options, signalVias.length);

  const failures = [];
  if (!drc.passed) failures.push("DRC did not pass");
  if (missingHighSpeedNets.length) {
    failures.push(
      `declared high-speed nets are absent: ${missingHighSpeedNets.join(", ")}`,
    );
  }
  if (nonStandardAngles.length) {
    failures.push(
      `${nonStandardAngles.length} high-speed segment(s) are not 0/45/90 degrees`,
    );
  }
  for (const pair of pairChecks.filter((check) => check.hardFailure)) {
    failures.push(
      `differential pair ${pair.positive}/${pair.negative} fails presence, skew, layer, width, or topology checks`,
    );
  }
  for (const group of groupChecks.filter((check) => check.hardFailure)) {
    failures.push(`length group ${group.name} is missing or exceeds its skew limit`);
  }
  for (const issue of pointToPointIssues) {
    failures.push(
      `point-to-point net ${issue.net} has a branch or disconnected route`,
    );
  }
  for (const check of returnViaChecks.filter((item) => item.hardFailure)) {
    failures.push(
      `high-speed via ${check.signalViaId} lacks a verified close ${options.groundNet} return via`,
    );
  }
  if (options.requireGroundPour && !groundPourPresent) {
    failures.push(`no valid filled ${options.groundNet} pour was found`);
  }

  const warnings = [];
  const invalidNonReferencePours = pours.filter(
    (pour) => pour.net !== options.groundNet && !pour.passed,
  );
  if (invalidNonReferencePours.length) {
    warnings.push(
      `${invalidNonReferencePours.length} non-reference pour(s) are unfilled or preserve islands`,
    );
  }
  if (!groundPourPresent && !options.requireGroundPour) {
    warnings.push(
      `no valid filled ${options.groundNet} pour was found; a dedicated plane requires separate evidence`,
    );
  }

  const autoHighRiskReasons = highRiskInterfaceReasons(options.interfaces);
  const effectivelyHighRisk =
    options.classification === "HIGH_RISK_SI" || autoHighRiskReasons.length > 0;

  let decision;
  if (failures.length) decision = DECISIONS.FAIL;
  else if (incompleteConstraints.length) decision = DECISIONS.UNVERIFIED;
  else decision = DECISIONS.PASS_WITH_EXCEPTIONS;

  if (
    !options.requireGroundPour &&
    nonemptyString(options.exceptionNote) &&
    !warnings.some((item) => item.includes("exceptionNote"))
  ) {
    warnings.push(`ground-pour requirement waived: ${options.exceptionNote}`);
  }
  if (options.humanAttestation?.accepted) {
    warnings.push(
      `free-text evidence accepted under human attestation (revision ${options.humanAttestation.revision}); artifacts were not verified on disk`,
    );
  } else if (options.humanAttestation?.requested) {
    warnings.push(options.humanAttestation.reason);
  }
  for (const reason of autoHighRiskReasons) {
    if (!warnings.includes(reason)) warnings.push(reason);
  }
  const manufacturing = resolveManufacturingReview(options);
  if (!manufacturing.reviewed) warnings.push(manufacturing.reason);
  const fingerprint = designFingerprint(raw);
  const constraintsFingerprint = constraintFingerprint(options.constraintRecord);

  return {
    schemaVersion: 5,
    kind: "high-speed",
    evidence: "RULE_CHECK",
    decision,
    fabricationRelease: false,
    manufacturingOutputsReviewed: Boolean(manufacturing.reviewed),
    notAFabricationRelease: notAFabricationReleaseMessage(),
    source,
    generatedAt: new Date().toISOString(),
    design: {
      project: raw.project || null,
      document: raw.document || null,
      fingerprint,
      netCount: new Set(raw.netNames || []).size,
      layerCount: (raw.layers || []).length,
      routedSegmentCount: segments.filter((segment) => segment.net).length,
      viaCount: vias.length,
      pourCount: pours.length,
    },
    constraints: {
      sourceFile: options.constraintsPath || null,
      fingerprint: constraintsFingerprint,
      classification: options.classification || null,
      effectiveClassification: effectivelyHighRisk
        ? "HIGH_RISK_SI"
        : options.classification || null,
      fabricator: options.fabricator || null,
      highSpeedNets: options.highSpeedNets,
      differentialPairs: options.pairs,
      lengthGroups: options.groups,
      groundNet: options.groundNet,
      maxReturnViaDistanceMil: options.maxReturnViaDistanceMil ?? null,
      requireGroundPour: options.requireGroundPour,
      exceptionNote: options.exceptionNote || null,
      userAttestedEvidenceRequested: Boolean(options.userAttestedEvidence),
      humanAttestation: options.humanAttestation || null,
      autoHighRiskReasons,
    },
    checks: {
      drc,
      routeSummaries: Object.fromEntries(summaries),
      missingHighSpeedNets,
      pairChecks,
      groupChecks,
      pointToPointIssues,
      returnViaChecks,
      nonStandardAngles,
      pours,
      groundPourPresent,
      incompleteConstraints,
    },
    failures,
    warnings,
    limitations: [
      "Package and connector internal delay are not included in routed length.",
      "Proximity to a GND via does not prove the via spans the relevant reference layers; explicit review evidence is required.",
      "Copper fill status does not prove uninterrupted reference coverage or absence of plane-slot crossings.",
      "Insertion loss, return loss, crosstalk, via stubs, launches, and material dispersion require solver or measurement evidence when applicable.",
      "A non-failing report remains tied to the exact reviewed routing, layer, via, stackup, connector, and copper revision.",
      "Free-text evidence closes gates only with human attestation (EASYEDA_AUDIT_USER_ATTEST=YES + --attest-file); prefer on-disk artifact/artifactPath files.",
    ],
  };
}

function completeConstraintFixture() {
  return {
    classification: "CONTROLLED_HIGH_SPEED",
    fabricator: "JLCPCB",
    groundNet: "GND",
    requireGroundPour: true,
    maxReturnViaDistanceMil: 50,
    stackup: {
      source: "FAB_CONFIRMED",
      sourceDocument: "self-test-stackup",
      boardThicknessMm: 1.6,
      copperThicknessUm: 35,
      dielectricHeightMm: 0.18,
      dk: 4.1,
      lossTangent: 0.02,
      frequencyGhz: 1,
      layers: [
        { name: "Top", role: "signal" },
        { name: "L2", role: "ground" },
        { name: "Bottom", role: "signal" },
      ],
    },
    interfaces: [
      {
        name: "USB2",
        requirementsSource: "USB 2.0 and self-test transceiver datasheet",
        dataRateGbps: 0.48,
        riseTimePs: 500,
        topology: "point-to-point",
        endpoints: ["U1.USB_DP/DM", "J1.D+/D-"],
        protection: {
          disposition: "IMPLEMENTED",
          parts: ["D1"],
        },
        testPoints: [],
        maxStubMil: 20,
        termination: {
          type: "internal",
          owner: "U1 transceiver",
          source: "self-test transceiver datasheet",
        },
        acCouplingNotApplicable: true,
        connectorOrCableModel: "USB 2.0 receptacle and compliant cable",
        referenceBySignalLayer: { Top: "L2:GND" },
        nets: ["USB_DP", "USB_DM"],
        targetDiffOhm: 90,
        tolerancePercent: 10,
        pairs: [
          {
            positive: "USB_DP",
            negative: "USB_DM",
            maxSkewMil: 20,
          },
        ],
      },
    ],
    evidence: {
      impedance: { status: "FAB_CONFIRMED", source: "self-test coupon" },
      continuousReference: {
        status: "MANUAL_REVIEWED",
        source: "self-test reference review",
      },
      coupling: {
        status: "MANUAL_REVIEWED",
        source: "self-test coupling review",
      },
      launches: {
        status: "MANUAL_REVIEWED",
        source: "self-test connector/protection launch review",
      },
    },
  };
}

function selfTestFixture() {
  return {
    project: { uuid: "self-test", name: "self-test" },
    document: { uuid: "pcb-self-test", name: "PCB", documentType: 3 },
    layers: [
      { id: 1, name: "Top Layer" },
      { id: 2, name: "Bottom Layer" },
    ],
    netNames: ["USB_DP", "USB_DM", "GND"],
    components: [],
    segments: [
      {
        primitiveId: "p1",
        segmentKind: "line",
        net: "USB_DP",
        layer: 1,
        lineWidth: 8,
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 0,
      },
      {
        primitiveId: "p2",
        segmentKind: "line",
        net: "USB_DM",
        layer: 1,
        lineWidth: 8,
        startX: 0,
        startY: 10,
        endX: 100,
        endY: 10,
      },
    ],
    vias: [],
    pours: [
      {
        primitiveId: "pour1",
        name: "GND_BOTTOM",
        net: "GND",
        layer: 2,
        preserveSilos: false,
        hasCopper: true,
        fillCount: 1,
        solidFillCount: 1,
      },
    ],
    drc: [],
  };
}

async function main() {
  try {
    let options = parseArgs(process.argv.slice(2));
    if (options.selfTest) {
      options = mergeConstraintRecord(options, completeConstraintFixture());
      options.humanAttestation = {
        accepted: true,
        requested: true,
        reason: "self-test attestation",
        revision: "self-test",
        attestFile: "<self-test>",
      };
      const report = analyze(selfTestFixture(), options, { kind: "self-test" });
      if (report.decision !== DECISIONS.PASS_WITH_EXCEPTIONS) {
        throw new Error(
          `self-test failed: ${JSON.stringify({
            failures: report.failures,
            incomplete: report.checks.incompleteConstraints,
          })}`,
        );
      }
      if (report.fabricationRelease !== false) {
        throw new Error("self-test must set fabricationRelease=false");
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    options = await loadAndMergeConstraints(options);
    const bridge = await findBridge(options.bridgePort);
    const windowId = await resolveWindow(bridge, options.windowId);
    const collected = await collectFromEasyEda(bridge, windowId);
    const report = analyze(collected.raw, options, {
      kind: "easyeda-bridge",
      port: bridge.port,
      windowId: collected.windowId,
      bridgeHealth: bridge.health,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      const outputPath = resolveSafeOutputPath(options.output, {
        force: options.force,
      });
      await writeFile(outputPath, serialized, "utf8");
    }
    process.stdout.write(serialized);
    process.exitCode = applyDecisionExitCode(report.decision);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          evidence: "RULE_CHECK",
          fabricationRelease: false,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = EXIT.ERROR;
  }
}

export {
  DECISIONS,
  EXIT,
  analyze,
  applyDecisionExitCode,
  completeConstraintFixture,
  collectorCode,
  constraintCompleteness,
  loadAndMergeConstraints,
  mergeConstraintRecord,
  parseArgs,
  resolveWindow,
  routeSummary,
  selfTestFixture,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

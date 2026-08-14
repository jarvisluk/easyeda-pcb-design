#!/usr/bin/env node

/**
 * Datasheet-constrained crystal/clock-sensitive-loop PCB audit.
 *
 * This audit checks geometry that the EasyEDA bridge can read deterministically.
 * It does not prove oscillator startup margin, load capacitance, pin mapping,
 * EMC performance, or the silicon vendor's ground/keepout guidance.
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
  nonemptyString,
  notAFabricationReleaseMessage,
  resolveHumanAttestation,
  resolveSafeOutputPath,
  resolveWindow,
} from "../lib/audit_common.mjs";

const DECISIONS = DECISION_VALUES;
// The bridge execution sandbox does not expose enum globals. This value is
// copied from the exact EDMT_EditorDocumentType reference in easyeda-api.
const PCB_DOCUMENT_TYPE = 3;
const MANUAL_REVIEW_EVIDENCE = new Set([
  "MANUAL_REVIEWED",
  "SOLVER_VERIFIED",
  "MEASUREMENT_VERIFIED",
]);

function usage() {
  return `Usage:
  node scripts/audits/easyeda_crystal_clock_audit.mjs --constraints FILE [options]

Options:
  --constraints FILE               Revision-controlled crystal/clock constraints
  --user-attested-evidence         Accept human-attested manual evidence
  --attest-file FILE               Human-written revision attest file
  --bridge-port PORT               Use one port instead of scanning 49620-49629
  --window-id ID                   Target a registered EasyEDA window
  --output FILE                    Relative path under cwd for the JSON report
  --force                          Overwrite an existing --output file
  --self-test                      Run offline positive and negative fixtures
  --help                           Show this help

Human attestation also requires EASYEDA_AUDIT_USER_ATTEST=YES in the human shell.
Agents must never set that variable or write the attest file.

Exit codes: 1=error, 2=FAIL, 3=UNVERIFIED FOR FABRICATION,
4=PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS (not a fab release).
`;
}

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`${option} requires an integer from 1 to 65535`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    constraintsPath: undefined,
    userAttestedEvidence: false,
    attestFile: undefined,
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
    else if (option === "--user-attested-evidence") {
      options.userAttestedEvidence = true;
    } else if (option === "--attest-file") options.attestFile = next();
    else if (option === "--bridge-port") {
      options.bridgePort = positiveInteger(next(), option);
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

  if (options.userAttestedEvidence && !nonemptyString(options.attestFile)) {
    throw new Error("--user-attested-evidence requires --attest-file");
  }
  options.humanAttestation = resolveHumanAttestation(options);
  return options;
}

function mergeConstraintRecord(options, record) {
  if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error("constraint record must be a JSON object");
  }
  return {
    ...options,
    constraintRecord: record,
    loops: Array.isArray(record?.loops) ? record.loops : [],
    evidenceRecord: record?.evidence,
  };
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
return {
  kind: "pcb",
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
  vias: vias
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
    .filter((via) => Number.isFinite(via.x) && Number.isFinite(via.y)),
  pours: pourData,
  drc: await eda.pcb_Drc.check(true, false, true),
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

function summarizeDrc(drc) {
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
    note: "Unexpected DRC response; inspect EasyEDA manually",
  };
}

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function finiteNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
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

function componentIndex(components) {
  const byRef = new Map();
  for (const component of components) {
    const key = `${component.designator || ""}`.trim().toUpperCase();
    if (!key) continue;
    if (!byRef.has(key)) byRef.set(key, []);
    byRef.get(key).push(component);
  }
  return byRef;
}

function oneComponent(byRef, reference) {
  if (!nonemptyString(reference)) return undefined;
  const matches = byRef.get(reference.trim().toUpperCase()) || [];
  return matches.length === 1 ? matches[0] : undefined;
}

function referenceIssue(byRef, reference) {
  if (!nonemptyString(reference)) return "reference is missing";
  const matches = byRef.get(reference.trim().toUpperCase()) || [];
  if (!matches.length) return `${reference} is absent`;
  if (matches.length > 1) return `${reference} is duplicated`;
  if (![matches[0].x, matches[0].y].every(Number.isFinite)) {
    return `${reference} has no readable placement origin`;
  }
  return undefined;
}

function distanceMil(left, right) {
  if (!left || !right) return null;
  return Number(Math.hypot(left.x - right.x, left.y - right.y).toFixed(3));
}

function constraintCompleteness(options) {
  const missing = [];
  const record = options.constraintRecord;
  if (!record) return ["no --constraints record was supplied"];
  if (!Array.isArray(record.loops) || !record.loops.length) {
    missing.push("no crystal/clock loops are defined");
  }
  for (const [index, loop] of options.loops.entries()) {
    const name = nonemptyString(loop?.name) ? loop.name : `loop[${index}]`;
    if (!loop || typeof loop !== "object") {
      missing.push(`${name} must be an object`);
      continue;
    }
    if (!nonemptyString(loop.name)) missing.push(`${name} name is missing`);
    if (!nonemptyString(loop.mcuRef)) missing.push(`${name} mcuRef is missing`);
    if (!nonemptyString(loop.crystalRef)) {
      missing.push(`${name} crystalRef is missing`);
    }
    if (!Array.isArray(loop.nets) || loop.nets.filter(nonemptyString).length < 2) {
      missing.push(`${name} needs at least two explicitly listed crystal nets`);
    }
    if (
      !Array.isArray(loop.loadCapRefs) ||
      (!loop.loadCapRefs.length && loop.loadCapacitorsNotApplicable !== true)
    ) {
      missing.push(
        `${name} loadCapRefs must be explicit, or set loadCapacitorsNotApplicable=true`,
      );
    }
    if (!nonemptyString(loop.requirementsSource)) {
      missing.push(`${name} requirementsSource is missing`);
    } else if (
      !existingArtifactPath(loop.requirementsArtifact) &&
      !options.humanAttestation?.accepted
    ) {
      missing.push(
        `${name} requirements source needs an existing requirementsArtifact or human attestation`,
      );
    }
    if (!finitePositive(loop.maxMcuCrystalDistanceMil)) {
      missing.push(`${name} maxMcuCrystalDistanceMil must be a positive number`);
    }
    if (
      !finitePositive(loop.maxLoadCapCrystalDistanceMil) &&
      loop.loadCapacitorsNotApplicable !== true
    ) {
      missing.push(
        `${name} maxLoadCapCrystalDistanceMil must be a positive number`,
      );
    }
    if (!finitePositive(loop.maxNetLengthMil)) {
      missing.push(`${name} maxNetLengthMil must be a positive number`);
    }
    if (!finiteNonnegativeInteger(loop.maxViasPerNet)) {
      missing.push(`${name} maxViasPerNet must be a non-negative integer`);
    }
    if (typeof loop.requireSameSide !== "boolean") {
      missing.push(`${name} requireSameSide must be explicit`);
    }
  }
  if (
    !evidenceMeetsGate(
      options.evidenceRecord?.manualReview,
      MANUAL_REVIEW_EVIDENCE,
      options,
    )
  ) {
    missing.push(
      "datasheet/pin-map/load-capacitance/ground-keepout/noise-isolation manual review evidence is missing",
    );
  }
  return [...new Set(missing)];
}

function analyze(raw, options, source) {
  if (raw.kind && raw.kind !== "pcb") {
    throw new Error(`unsupported audit kind: ${raw.kind}`);
  }
  const components = raw.components || [];
  const segments = raw.segments || [];
  const vias = raw.vias || [];
  const byRef = componentIndex(components);
  const drc = summarizeDrc(raw.drc);
  const incompleteConstraints = constraintCompleteness(options);
  const fingerprint = designFingerprint(raw);
  const constraintsFingerprint = constraintFingerprint(options.constraintRecord);
  const crystalNets = [
    ...new Set(
      options.loops.flatMap((loop) =>
        Array.isArray(loop?.nets) ? loop.nets.filter(nonemptyString) : [],
      ),
    ),
  ];
  const failures = [];
  if (!drc.passed) failures.push("PCB DRC did not pass");

  const loopChecks = options.loops.map((loop, index) => {
    const name = nonemptyString(loop?.name) ? loop.name : `loop[${index}]`;
    const componentRefs = [
      loop?.mcuRef,
      loop?.crystalRef,
      ...(Array.isArray(loop?.loadCapRefs) ? loop.loadCapRefs : []),
    ].filter(nonemptyString);
    const componentIssues = componentRefs
      .map((reference) => referenceIssue(byRef, reference))
      .filter(Boolean);
    const mcu = oneComponent(byRef, loop?.mcuRef);
    const crystal = oneComponent(byRef, loop?.crystalRef);
    const loadCaps = (loop?.loadCapRefs || [])
      .map((reference) => ({
        reference,
        component: oneComponent(byRef, reference),
      }));
    const mcuCrystalDistanceMil = distanceMil(mcu, crystal);
    const loadCapDistancesMil = loadCaps.map(({ reference, component }) => ({
      reference,
      distanceMil: distanceMil(component, crystal),
    }));
    const sameSideComponents = [mcu, crystal, ...loadCaps.map((item) => item.component)]
      .filter(Boolean);
    const componentLayers = [
      ...new Set(sameSideComponents.map((item) => item.layer)),
    ];
    const netChecks = [...new Set((loop?.nets || []).filter(nonemptyString))].map(
      (net) => {
        const netSegments = segments.filter((segment) => segment.net === net);
        const netVias = vias.filter((via) => via.net === net);
        const lengthMil = Number(
          netSegments.reduce((sum, segment) => sum + segmentLength(segment), 0).toFixed(3),
        );
        const layers = [...new Set(netSegments.map((segment) => segment.layer))];
        return {
          net,
          segmentCount: netSegments.length,
          lengthMil,
          viaCount: netVias.length,
          layers,
          passed:
            netSegments.length > 0 &&
            (!finitePositive(loop?.maxNetLengthMil) ||
              lengthMil <= loop.maxNetLengthMil) &&
            (!finiteNonnegativeInteger(loop?.maxViasPerNet) ||
              netVias.length <= loop.maxViasPerNet) &&
            (loop?.requireSameSide !== true ||
              (layers.length === 1 &&
                (!crystal || layers[0] === crystal.layer))),
        };
      },
    );

    const observedFailures = [];
    for (const issue of componentIssues) observedFailures.push(issue);
    if (
      mcuCrystalDistanceMil !== null &&
      finitePositive(loop?.maxMcuCrystalDistanceMil) &&
      mcuCrystalDistanceMil > loop.maxMcuCrystalDistanceMil
    ) {
      observedFailures.push(
        `${name} MCU-to-crystal origin distance ${mcuCrystalDistanceMil} mil exceeds ${loop.maxMcuCrystalDistanceMil} mil`,
      );
    }
    for (const item of loadCapDistancesMil) {
      if (
        item.distanceMil !== null &&
        finitePositive(loop?.maxLoadCapCrystalDistanceMil) &&
        item.distanceMil > loop.maxLoadCapCrystalDistanceMil
      ) {
        observedFailures.push(
          `${name} ${item.reference}-to-crystal origin distance ${item.distanceMil} mil exceeds ${loop.maxLoadCapCrystalDistanceMil} mil`,
        );
      }
    }
    if (
      loop?.requireSameSide === true &&
      sameSideComponents.length === componentRefs.length &&
      componentLayers.length > 1
    ) {
      observedFailures.push(`${name} MCU, crystal, and load capacitors are not on one side`);
    }
    for (const check of netChecks.filter((item) => !item.passed)) {
      if (!check.segmentCount) {
        observedFailures.push(`${name} declared crystal net ${check.net} has no routed segments`);
      } else {
        if (
          finitePositive(loop?.maxNetLengthMil) &&
          check.lengthMil > loop.maxNetLengthMil
        ) {
          observedFailures.push(
            `${name} net ${check.net} length ${check.lengthMil} mil exceeds ${loop.maxNetLengthMil} mil`,
          );
        }
        if (
          finiteNonnegativeInteger(loop?.maxViasPerNet) &&
          check.viaCount > loop.maxViasPerNet
        ) {
          observedFailures.push(
            `${name} net ${check.net} has ${check.viaCount} vias; limit is ${loop.maxViasPerNet}`,
          );
        }
        if (
          loop?.requireSameSide === true &&
          (check.layers.length !== 1 ||
            (crystal && check.layers[0] !== crystal.layer))
        ) {
          observedFailures.push(
            `${name} net ${check.net} is not routed only on the crystal component side`,
          );
        }
      }
    }
    failures.push(...observedFailures);
    return {
      name,
      requirementsSource: loop?.requirementsSource || null,
      componentRefs,
      componentIssues,
      mcuCrystalDistanceMil,
      maxMcuCrystalDistanceMil: loop?.maxMcuCrystalDistanceMil ?? null,
      loadCapDistancesMil,
      maxLoadCapCrystalDistanceMil:
        loop?.maxLoadCapCrystalDistanceMil ?? null,
      requireSameSide: loop?.requireSameSide ?? null,
      maxNetLengthMil: loop?.maxNetLengthMil ?? null,
      maxViasPerNet: loop?.maxViasPerNet ?? null,
      componentLayers,
      netChecks,
      observedFailures,
    };
  });

  let decision;
  if (failures.length) decision = DECISIONS.FAIL;
  else if (incompleteConstraints.length) decision = DECISIONS.UNVERIFIED;
  else decision = DECISIONS.PASS_WITH_EXCEPTIONS;

  const warnings = [
    "Component-origin distances are conservative placement proxies; pad-to-pad geometry still requires visual review.",
    "Oscillator startup margin, effective load capacitance, pin mapping, ground/keepout policy, and noise coupling are not proven by geometry checks.",
    "Manufacturing outputs are not reviewed by this audit.",
  ];
  if (options.humanAttestation?.accepted) {
    warnings.push(
      `manual evidence accepted under human attestation (revision ${options.humanAttestation.revision})`,
    );
  } else if (options.humanAttestation?.requested) {
    warnings.push(options.humanAttestation.reason);
  }

  return {
    schemaVersion: 1,
    kind: "crystal-clock",
    evidence: "RULE_CHECK",
    decision,
    fabricationRelease: false,
    manufacturingOutputsReviewed: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    source,
    generatedAt: new Date().toISOString(),
    design: {
      project: raw.project || null,
      document: raw.document || null,
      fingerprint,
      componentCount: components.length,
      routedSegmentCount: segments.length,
      viaCount: vias.length,
    },
    constraints: {
      constraintsPath: options.constraintsPath || null,
      fingerprint: constraintsFingerprint,
      loopCount: options.loops.length,
      crystalNets,
    },
    checks: {
      drc,
      loops: loopChecks,
      incompleteConstraints,
      manualReviewEvidence:
        options.evidenceRecord?.manualReview?.status || null,
    },
    failures: [...new Set(failures)],
    warnings,
    limitations: [
      "The EasyEDA API data used here does not expose a verified MCU/crystal pad-to-pad path, so component origins are used for placement distance checks.",
      "Declared trace length is the sum of routed primitives on each named net; package and pad geometry are excluded.",
      "A passing report does not prove oscillator electrical operation, EMC compliance, or fabrication readiness.",
    ],
  };
}

function selfTestFixture() {
  return {
    kind: "pcb",
    project: { uuid: "self-test", name: "Self Test" },
    document: { uuid: "pcb", name: "PCB", documentType: 3 },
    components: [
      { primitiveId: "u1", designator: "U1", layer: 1, x: 0, y: 0 },
      { primitiveId: "y1", designator: "Y1", layer: 1, x: 100, y: 0 },
      { primitiveId: "c1", designator: "C1", layer: 1, x: 120, y: 30 },
      { primitiveId: "c2", designator: "C2", layer: 1, x: 120, y: -30 },
    ],
    segments: [
      {
        primitiveId: "xin",
        segmentKind: "line",
        net: "OSC_IN",
        layer: 1,
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 0,
      },
      {
        primitiveId: "xout",
        segmentKind: "line",
        net: "OSC_OUT",
        layer: 1,
        startX: 0,
        startY: 20,
        endX: 100,
        endY: 20,
      },
    ],
    vias: [],
    drc: [],
  };
}

function completeConstraintFixture() {
  return {
    loops: [
      {
        name: "HSE",
        mcuRef: "U1",
        crystalRef: "Y1",
        loadCapRefs: ["C1", "C2"],
        nets: ["OSC_IN", "OSC_OUT"],
        requirementsSource: "MCU datasheet oscillator layout section",
        maxMcuCrystalDistanceMil: 300,
        maxLoadCapCrystalDistanceMil: 150,
        maxNetLengthMil: 200,
        maxViasPerNet: 0,
        requireSameSide: true,
      },
    ],
    evidence: {
      manualReview: {
        status: "MANUAL_REVIEWED",
        source: "self-test review",
      },
    },
  };
}

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.selfTest) {
      const options = mergeConstraintRecord(
        {
          ...parsed,
          humanAttestation: {
            accepted: true,
            requested: true,
            revision: "self-test",
          },
        },
        completeConstraintFixture(),
      );
      const passing = analyze(selfTestFixture(), options, { kind: "self-test" });
      const failingFixture = selfTestFixture();
      failingFixture.vias.push({
        primitiveId: "via1",
        net: "OSC_IN",
        x: 50,
        y: 0,
      });
      const failing = analyze(failingFixture, options, {
        kind: "self-test-negative",
      });
      if (
        passing.decision !== DECISIONS.PASS_WITH_EXCEPTIONS ||
        failing.decision !== DECISIONS.FAIL ||
        passing.fabricationRelease !== false
      ) {
        throw new Error("self-test fixtures produced unexpected decisions");
      }
      process.stdout.write(`${JSON.stringify({ passing, failing }, null, 2)}\n`);
      return;
    }

    const options = await loadAndMergeConstraints(parsed);
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
  collectorCode,
  completeConstraintFixture,
  mergeConstraintRecord,
  parseArgs,
  selfTestFixture,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

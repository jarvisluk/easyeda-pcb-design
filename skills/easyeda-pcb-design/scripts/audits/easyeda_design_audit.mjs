#!/usr/bin/env node

/**
 * Baseline schematic/PCB audit through the easyeda-api bridge.
 *
 * The checks are deterministic rule checks. They do not replace electrical,
 * mechanical, current-capacity, or manufacturing review. Bare PASS is never
 * emitted; a non-failing result is not a fabrication release.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DECISION_VALUES,
  EXIT,
  analyzePourConnectivity,
  applyDecisionExitCode,
  constraintFingerprint,
  crystalNetHints,
  designFingerprint,
  fetchJson,
  findBridge,
  freeCopperPrimitiveIds,
  highSpeedDiscovery,
  nonemptyString,
  notAFabricationReleaseMessage,
  readCrystalClearanceReport,
  readHighSpeedClearanceReport,
  resolveManufacturingReview,
  resolveSafeOutputPath,
  resolveWindow,
  validateNetlistCompareExceptionArtifact,
} from "../lib/audit_common.mjs";
import { validateComponentEvidenceRecord } from "../lints/component_selection_evidence.mjs";

const DECISIONS = DECISION_VALUES;
// The bridge execution sandbox does not expose enum globals. These values are
// copied from the exact EDMT_EditorDocumentType reference bundled with
// easyeda-api, rather than guessed at call sites.
const DOCUMENT_TYPE = Object.freeze({
  SCHEMATIC_PAGE: 1,
  PCB: 3,
});

function usage() {
  return `Usage:
  node scripts/audits/easyeda_design_audit.mjs [options]

Options:
  --ground-net NET                  Ground/reference net (default: GND)
  --allow-no-ground-pour            Do not fail a PCB with no valid ground pour
  --allow-nonstandard-angle         Report but do not fail arbitrary-angle tracks
  --allow-sharp-right-angle         Report but do not fail unchamfered 90-degree corners
  --allow-routing-cycle NET         Allow intentional explicit-routing cycles on NET
                                      (repeatable; requires --exception-note)
  --exception-note TEXT             Required with any --allow-* flag
  --crystal-audit-report FILE       Clear crystal/clock net hints using its audit JSON
  --component-evidence FILE         Revision-bound component-selection evidence JSON
  --gate-ledger FILE                Cleared easyeda_gate_ledger.mjs report for this
                                      transaction; a missing or non-cleared ledger
                                      keeps the result UNVERIFIED FOR FABRICATION
  --schematic-page-envelope FILE    Declared drawable page area for this exact
                                      schematic page; without it, symbols drawn
                                      outside the page cannot be detected and the
                                      result stays UNVERIFIED FOR FABRICATION
  --placement-audit-report FILE    Exact-revision PLACEMENT_CLEAR_FOR_ROUTING report
  --netlist-compare-report FILE     Strict schematic/PCB comparison report; may clear
                                      only a verified native Import Changes cache error
  --high-speed-constraints FILE     Revision-controlled HS interface constraints
  --high-speed-audit-report FILE    Clear HS-net hints using a prior HS audit JSON
  --manufacturing-reviewed          Mark Gerber/BOM/PnP reviewed (needs human attest)
  --attest-file FILE                Human attest file (see skill docs)
  --bridge-port PORT                Use one port instead of scanning 49620-49629
  --window-id ID                    Target a registered EasyEDA window
  --output FILE                     Relative path under cwd for the JSON report
  --force                           Overwrite an existing --output file
  --self-test                       Run PCB and schematic offline tests
  --help                            Show this help

Exit codes: 1=error, 2=FAIL, 3=UNVERIFIED FOR FABRICATION,
4=PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS (not a fab release).
Bare PASS is never emitted. Crystal/clock and HS-like net names force UNVERIFIED
unless their corresponding cleared audit reports are supplied.
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
    groundNet: "GND",
    requireGroundPour: true,
    allowNoGroundPour: false,
    allowNonstandardAngle: false,
    allowSharpRightAngle: false,
    allowRoutingCycleNets: [],
    exceptionNote: undefined,
    crystalAuditReport: undefined,
    componentEvidence: undefined,
    componentEvidenceRecord: undefined,
    componentEvidenceBaseDir: undefined,
    gateLedger: undefined,
    gateLedgerRecord: undefined,
    schematicPageEnvelope: undefined,
    schematicPageEnvelopeRecord: undefined,
    placementAuditReport: undefined,
    placementAuditRecord: undefined,
    netlistCompareReport: undefined,
    highSpeedConstraints: undefined,
    highSpeedConstraintRecord: undefined,
    highSpeedAuditReport: undefined,
    manufacturingReviewed: false,
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

    if (option === "--ground-net") options.groundNet = next();
    else if (option === "--allow-no-ground-pour") {
      options.allowNoGroundPour = true;
      options.requireGroundPour = false;
    } else if (option === "--allow-nonstandard-angle") {
      options.allowNonstandardAngle = true;
    } else if (option === "--allow-sharp-right-angle") {
      options.allowSharpRightAngle = true;
    } else if (option === "--allow-routing-cycle") {
      const net = next();
      if (!nonemptyString(net)) {
        throw new Error("--allow-routing-cycle requires a non-empty net name");
      }
      options.allowRoutingCycleNets.push(net);
    } else if (option === "--exception-note") options.exceptionNote = next();
    else if (option === "--crystal-audit-report") {
      options.crystalAuditReport = next();
    }
    else if (option === "--component-evidence") {
      options.componentEvidence = next();
    }
    else if (option === "--gate-ledger") {
      options.gateLedger = next();
    }
    else if (option === "--schematic-page-envelope") {
      options.schematicPageEnvelope = next();
    }
    else if (option === "--placement-audit-report") {
      options.placementAuditReport = next();
    }
    else if (option === "--netlist-compare-report") {
      options.netlistCompareReport = next();
    }
    else if (option === "--high-speed-constraints") {
      options.highSpeedConstraints = next();
    } else if (option === "--high-speed-audit-report") {
      options.highSpeedAuditReport = next();
    } else if (option === "--manufacturing-reviewed") {
      options.manufacturingReviewed = true;
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
  if (
    (
      options.allowNoGroundPour ||
      options.allowNonstandardAngle ||
      options.allowSharpRightAngle ||
      options.allowRoutingCycleNets.length
    ) &&
    !nonemptyString(options.exceptionNote)
  ) {
    throw new Error(
      "--allow-* options require --exception-note TEXT",
    );
  }
  options.allowRoutingCycleNets = [
    ...new Set(options.allowRoutingCycleNets.filter(nonemptyString)),
  ];
  if (options.manufacturingReviewed && !nonemptyString(options.attestFile)) {
    throw new Error("--manufacturing-reviewed requires --attest-file");
  }
  return options;
}

async function loadHighSpeedConstraintRecord(options) {
  if (!options.highSpeedConstraints) return options;
  let record;
  try {
    record = JSON.parse(await readFile(options.highSpeedConstraints, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read high-speed constraints ${options.highSpeedConstraints}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("high-speed constraints must be a JSON object");
  }
  let nativeNetlistCacheException;
  if (record.nativeNetlistCacheException !== undefined) {
    const value = record.nativeNetlistCacheException;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("nativeNetlistCacheException must be an object");
    }
    if (!nonemptyString(value.reason)) {
      throw new Error("nativeNetlistCacheException requires a non-empty reason");
    }
    const artifactPath = value.artifactPath || value.artifact;
    if (!nonemptyString(artifactPath)) {
      throw new Error(
        "nativeNetlistCacheException requires a manufacturing-netlist artifactPath",
      );
    }
    let artifact;
    try {
      artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    } catch (error) {
      throw new Error(
        `unable to read nativeNetlistCacheException artifact: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const validated = validateNetlistCompareExceptionArtifact(
      artifact,
      path.resolve(artifactPath),
    );
    nativeNetlistCacheException = {
      ...validated,
      reason: `${value.reason.trim()} — ${validated.reason}`,
    };
  }
  return {
    ...options,
    highSpeedConstraintRecord: record,
    nativeNetlistCacheException,
  };
}

async function loadNetlistCompareReport(options) {
  if (!options.netlistCompareReport) return options;
  if (options.nativeNetlistCacheException) {
    throw new Error(
      "do not combine --netlist-compare-report with legacy nativeNetlistCacheException metadata",
    );
  }
  const artifactPath = path.resolve(options.netlistCompareReport);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read netlist comparison report ${options.netlistCompareReport}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    ...options,
    nativeNetlistCacheException: validateNetlistCompareExceptionArtifact(
      artifact,
      artifactPath,
    ),
  };
}

async function loadComponentEvidenceRecord(options) {
  if (!options.componentEvidence) return options;
  const recordPath = path.resolve(options.componentEvidence);
  let record;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read component-selection evidence ${options.componentEvidence}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("component-selection evidence must be a JSON object");
  }
  return {
    ...options,
    componentEvidenceRecord: record,
    componentEvidenceBaseDir: path.dirname(recordPath),
  };
}

async function loadGateLedgerReport(options) {
  if (!options.gateLedger) return options;
  const reportPath = path.resolve(options.gateLedger);
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read gate ledger report ${options.gateLedger}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("gate ledger report must be a JSON object");
  }
  return { ...options, gateLedgerRecord: report, gateLedger: reportPath };
}

/**
 * Bind the gate ledger to this exact project. The ledger proves that the
 * transaction's gates were closed in order against existing evidence; it does
 * not replace any individual gate's own artifact.
 */
function gateLedgerClearance(report, expected = {}) {
  if (!report) {
    return {
      cleared: false,
      blocking: false,
      reason: "no gate ledger report supplied",
    };
  }
  if (report.kind !== "easyeda-gate-ledger" || report.fabricationRelease !== false) {
    return {
      cleared: false,
      blocking: false,
      reason: "gate ledger report kind or fabrication-release boundary is invalid",
    };
  }
  const analysis = report.analysis;
  if (
    report.schemaVersion !== 1 ||
    !analysis ||
    typeof analysis !== "object" ||
    !Array.isArray(analysis.blocked) ||
    !Array.isArray(analysis.unverified) ||
    !Array.isArray(analysis.gates)
  ) {
    return {
      cleared: false,
      blocking: false,
      reason: "gate ledger report omits complete schema 1 analysis evidence",
    };
  }
  if (
    nonemptyString(expected.projectUuid) &&
    analysis.projectUuid !== expected.projectUuid
  ) {
    return {
      cleared: false,
      blocking: false,
      reason: `gate ledger project UUID mismatch (${analysis.projectUuid || "missing"})`,
    };
  }
  if (report.decision === "BLOCKED" || analysis.blocked.length) {
    return {
      cleared: false,
      blocking: true,
      reason: "gate ledger reports a skipped, out-of-order, or unevidenced gate",
      failures: analysis.blocked,
    };
  }
  if (report.decision !== "CLEARED") {
    return {
      cleared: false,
      blocking: false,
      reason: `gate ledger decision is ${report.decision || "missing"}`,
    };
  }
  // Integrity is only half the question. A ledger can be perfectly honest
  // bookkeeping for a slice that stopped early, and that must not read as
  // closure here. The completion axis is what separates the two, so a partial
  // ledger keeps the audit UNVERIFIED instead of letting clean upstream checks
  // imply a finished design.
  const completion = analysis.completion || report.completion;
  const completionAnalysis = analysis.completionAnalysis;
  // A report predating the completion axis cannot show that its slice finished.
  // Treat the absent field as unproven rather than as permission, so a stale
  // artifact cannot silently bypass this check.
  if (!nonemptyString(completion)) {
    return {
      cleared: false,
      blocking: false,
      completion: null,
      reason:
        "gate ledger report omits the completion axis; regenerate it with the " +
        "current easyeda_gate_ledger.mjs so slice completion is provable",
    };
  }
  if (completion === "INCOMPLETE" || completion === "INDETERMINATE") {
    const remaining = Array.isArray(completionAnalysis?.remainingGates)
      ? completionAnalysis.remainingGates
      : [];
    const detail = remaining.length
      ? `; unsettled gates: ${remaining.join(", ")}`
      : "";
    return {
      cleared: false,
      blocking: false,
      completion,
      reason:
        `gate ledger bookkeeping is honest but the declared ${analysis.branch} slice ` +
        `at scope ${analysis.scope} has not reached its terminal gate ` +
        `${completionAnalysis?.terminalGate || "(undeclared)"}${detail}`,
      remainingGates: remaining,
    };
  }
  // TERMINAL_PENDING is the expected state while producing this very report: the
  // terminal gate's evidence is the audit output that does not exist yet.
  return {
    cleared: true,
    blocking: false,
    completion: completion || null,
    reason:
      `gate ledger cleared for branch ${analysis.branch} at scope ${analysis.scope}` +
      (completion === "TERMINAL_PENDING"
        ? `, pending only its terminal gate ${completionAnalysis?.terminalGate || ""}`
        : ""),
    branch: analysis.branch || null,
    scope: analysis.scope || null,
  };
}

async function loadSchematicPageEnvelope(options) {
  if (!options.schematicPageEnvelope) return options;
  const recordPath = path.resolve(options.schematicPageEnvelope);
  let record;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read schematic page envelope ${options.schematicPageEnvelope}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    ...options,
    schematicPageEnvelope: recordPath,
    schematicPageEnvelopeRecord: validateSchematicPageEnvelope(
      record,
      recordPath,
    ),
  };
}

async function loadPlacementAuditReport(options) {
  if (!options.placementAuditReport) return options;
  const reportPath = path.resolve(options.placementAuditReport);
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read placement audit ${options.placementAuditReport}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("placement audit report must be a JSON object");
  }
  return { ...options, placementAuditRecord: report, placementAuditReport: reportPath };
}

function placementAuditClearance(report, expected = {}) {
  if (!report) {
    return {
      cleared: false,
      blocking: false,
      reason: "no exact-revision placement audit report supplied",
    };
  }
  if (report.kind !== "easyeda-placement-audit" || report.fabricationRelease !== false) {
    return {
      cleared: false,
      blocking: false,
      reason: "placement report kind or fabrication-release boundary is invalid",
    };
  }
  const placement = report.checks?.componentPlacement;
  const boardContainment = report.checks?.boardContainment;
  const arrayContracts = [
    [boardContainment, "violations", "blocking"],
    [boardContainment, "unverified", "unresolved"],
    [report.checks?.viaPad, "violations", "blocking"],
    [report.checks?.viaPad, "unsupportedPads", "unresolved"],
    [report.checks?.viaPad, "unsupportedVias", "unresolved"],
    [placement, "exactConflicts", "blocking"],
    [placement, "ownPadOutsideCourtyard", "blocking"],
    [placement, "crossComponentPadConflicts", "blocking"],
    [placement, "crossComponentPadClearanceViolations", "blocking"],
    [placement, "padToForeignCourtyardConflicts", "blocking"],
    [placement, "criticalZoneViolations", "blocking"],
    [placement, "unsupportedPadOccupancy", "unresolved"],
    [placement, "unownedPads", "unresolved"],
    [placement, "componentIdentityConflicts", "unresolved"],
    [placement, "invalidEnvelopes", "unresolved"],
    [placement, "missingEnvelopeDesignators", "unresolved"],
    [placement, "missingOppositeSideCourtyardDesignators", "unresolved"],
    [placement, "missingPadstackProjectionEvidence", "unresolved"],
    [placement, "unresolvedBboxCandidates", "unresolved"],
    [placement, "criticalZoneUnverified", "unresolved"],
    [report.checks?.humanInterfaces, "violations", "blocking"],
    [report.checks?.humanInterfaces, "unverified", "unresolved"],
    [report.checks?.interfacesAndBom, "failures", "blocking"],
    [report.checks?.interfacesAndBom, "unverified", "unresolved"],
  ];
  const requiredCoverageAxes = [
    "boardMechanicalContainment",
    "viaPadGeometry",
    "componentOccupancy",
    "criticalPlacementZones",
    "humanInterfaces",
    "externalInterfacesAndBom",
  ];
  const checkedCoverageAxes = new Set(report.coverage?.checkedAxes || []);
  const coverageComplete =
    Array.isArray(report.coverage?.requiredAxes) &&
    Array.isArray(report.coverage?.checkedAxes) &&
    Array.isArray(report.coverage?.unverifiedAxes) &&
    Array.isArray(report.coverage?.notApplicable) &&
    requiredCoverageAxes.every((axis) =>
      report.coverage.requiredAxes.includes(axis) && checkedCoverageAxes.has(axis)) &&
    report.coverage.unverifiedAxes.length === 0;
  if (
    report.schemaVersion !== 3 ||
    !placement ||
    !boardContainment ||
    !coverageComplete ||
    arrayContracts.some(([owner, field]) => !owner || !Array.isArray(owner[field])) ||
    !Array.isArray(report.failures) ||
    !Array.isArray(report.unverified) ||
    !Array.isArray(report.stale)
  ) {
    return {
      cleared: false,
      blocking: false,
      reason: "placement report predates or omits complete schema 3 coverage and board-containment evidence",
    };
  }
  if (
    report.design?.project?.uuid !== expected.projectUuid ||
    report.design?.document?.uuid !== expected.documentUuid ||
    report.design?.fingerprint !== expected.designFingerprint
  ) {
    return {
      cleared: false,
      blocking: false,
      reason: "placement report project/document/fingerprint is missing or stale",
      status: report.status || null,
    };
  }
  const blockingFindings = arrayContracts
    .filter(([, , classification]) => classification === "blocking")
    .flatMap(([owner, field]) => owner[field]);
  if (blockingFindings.length || report.failures.length) {
    return {
      cleared: false,
      blocking: true,
      reason: "placement report contains blocking placement findings",
      failures: blockingFindings.length ? blockingFindings : report.failures,
    };
  }
  const constraintFingerprint = report.constraints?.recordFingerprint;
  if (
    report.constraints?.revision !== expected.designFingerprint ||
    report.constraints?.consistencyGateStatus !== "CLEARED_FOR_PLACEMENT" ||
    typeof constraintFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/i.test(constraintFingerprint)
  ) {
    return {
      cleared: false,
      blocking: false,
      reason: "placement report constraint revision, fingerprint, or consistency gate is stale or invalid",
    };
  }
  const unresolvedFindings = arrayContracts
    .filter(([, , classification]) => classification === "unresolved")
    .flatMap(([owner, field]) => owner[field]);
  if (
    unresolvedFindings.length ||
    report.unverified.length ||
    report.stale.length
  ) {
    return {
      cleared: false,
      blocking: false,
      reason: "placement report contains unresolved or stale placement evidence",
    };
  }
  if (report.status === "PLACEMENT_CLEAR_FOR_ROUTING") {
    return { cleared: true, blocking: false, reason: "exact-revision placement gate cleared" };
  }
  if (report.status === "BLOCKED") {
    return {
      cleared: false,
      blocking: true,
      reason: "exact-revision placement audit contains blocking findings",
      failures: report.failures || [],
    };
  }
  return {
    cleared: false,
    blocking: false,
    reason: `placement audit status is ${report.status || "missing"}`,
    status: report.status || null,
  };
}

function collectorCode(options = {}) {
  const includeDrc = options.includeDrc !== false;
  return `
const includeDrc = ${includeDrc};
const project = await eda.dmt_Project.getCurrentProjectInfo();
if (!project) throw new Error("No EasyEDA project is open");
const documentInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!documentInfo) throw new Error("No EasyEDA document is active");

const value = (object, methodName, propertyName) => {
  if (typeof object[methodName] === "function") return object[methodName]();
  return object[propertyName];
};
const base = {
  project: {
    uuid: project.uuid,
    name: project.friendlyName || project.name || "",
  },
  document: {
    uuid: documentInfo.uuid,
    name: documentInfo.name || documentInfo.friendlyName || "",
    documentType: documentInfo.documentType,
  },
};
const pointFrom = (x, y) => ({ x, y });
const polygonPoints = (polygon) => {
  if (!polygon) return [];
  if (typeof polygon.discretize === "function") {
    try {
      const discretized = polygon.discretize() || [];
      const points = discretized
        .map((point) => pointFrom(point?.x, point?.y))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length > 2) {
        const first = points[0];
        const last = points[points.length - 1];
        if (first.x !== last.x || first.y !== last.y) {
          points.push(pointFrom(first.x, first.y));
        }
      }
      return points;
    } catch {}
  }
  let source = null;
  if (typeof polygon.getSource === "function") {
    try { source = polygon.getSource(); } catch {}
  }
  if (!Array.isArray(source) && Array.isArray(polygon.polygon)) {
    source = polygon.polygon;
  }
  if (!Array.isArray(source) || !source.length) return [];
  if (source[0] === "R") {
    const [, x, y, width, height, rotation = 0] = source;
    if (![x, y, width, height, rotation].every(Number.isFinite) || rotation !== 0) return [];
    return [
      pointFrom(x, y),
      pointFrom(x + width, y),
      pointFrom(x + width, y + height),
      pointFrom(x, y + height),
      pointFrom(x, y),
    ];
  }
  const points = [];
  let index = 0;
  if (Number.isFinite(source[0]) && Number.isFinite(source[1])) {
    points.push(pointFrom(source[0], source[1]));
    index = 2;
  }
  while (index < source.length) {
    const token = source[index];
    if (token === "L") {
      index += 1;
      while (
        index + 1 < source.length
        && Number.isFinite(source[index])
        && Number.isFinite(source[index + 1])
      ) {
        points.push(pointFrom(source[index], source[index + 1]));
        index += 2;
      }
      continue;
    }
    if (Number.isFinite(token) && Number.isFinite(source[index + 1])) {
      points.push(pointFrom(token, source[index + 1]));
      index += 2;
      continue;
    }
    return [];
  }
  if (points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first.x !== last.x || first.y !== last.y) points.push(pointFrom(first.x, first.y));
  }
  return points;
};

if (documentInfo.documentType === ${DOCUMENT_TYPE.SCHEMATIC_PAGE}) {
  const schematicPrimitives = await eda.sch_PrimitiveComponent.getAll();
  // Net ports and net flags share the component primitive API, but they are
  // connectivity annotations rather than BOM/PCB components.
  const isPart = (component) => {
    const componentType = value(
      component,
      "getState_ComponentType",
      "componentType",
    );
    return componentType === undefined || componentType === "part";
  };
  const components = schematicPrimitives.filter(isPart);
  const schematicAnnotations = schematicPrimitives
    .filter((component) => !isPart(component))
    .map((component) => ({
      primitiveId: value(component, "getState_PrimitiveId", "primitiveId"),
      componentType:
        value(component, "getState_ComponentType", "componentType") || "",
      net: value(component, "getState_Net", "net") || "",
      x: value(component, "getState_X", "x"),
      y: value(component, "getState_Y", "y"),
      rotation: value(component, "getState_Rotation", "rotation"),
    }));
  const wires = await eda.sch_PrimitiveWire.getAll();
  const schematicWires = wires.map((wire) => ({
    primitiveId: value(wire, "getState_PrimitiveId", "primitiveId"),
    net: value(wire, "getState_Net", "net") || "",
    line: value(wire, "getState_Line", "line") || null,
  }));
  const drc = includeDrc ? await eda.sch_Drc.check(true, false, true) : null;
  // Symbol placement geometry. The BBox API is beta and can include the
  // designator, value, and other attribute text, so it screens crowding and
  // page overrun; it never proves a symbol-body collision on its own.
  const componentData = [];
  for (const component of components) {
    let bbox = null;
    try {
      bbox = (await eda.sch_Primitive.getPrimitivesBBox([component])) || null;
    } catch (error) {
      bbox = null;
    }
    componentData.push({
      primitiveId: value(component, "getState_PrimitiveId", "primitiveId"),
      designator: value(component, "getState_Designator", "designator") || "",
      uniqueId: value(component, "getState_UniqueId", "uniqueId") || "",
      name: value(component, "getState_Name", "name") || "",
      manufacturer:
        value(component, "getState_Manufacturer", "manufacturer") || "",
      manufacturerPartNumber:
        value(component, "getState_ManufacturerId", "manufacturerId") || "",
      supplier: value(component, "getState_Supplier", "supplier") || "",
      supplierPartNumber:
        value(component, "getState_SupplierId", "supplierId") || "",
      addIntoPcb: value(component, "getState_AddIntoPcb", "addIntoPcb"),
      footprint: value(component, "getState_Footprint", "footprint") || null,
      x: value(component, "getState_X", "x"),
      y: value(component, "getState_Y", "y"),
      rotation: value(component, "getState_Rotation", "rotation"),
      bbox,
    });
  }
  return {
    ...base,
    kind: "schematic",
    components: componentData,
    wireCount: wires.length,
    schematicAnnotations,
    schematicWires,
    drc,
  };
}

if (documentInfo.documentType === ${DOCUMENT_TYPE.PCB}) {
  const drcRuleBefore = includeDrc ? {
    name: await eda.pcb_Drc.getCurrentRuleConfigurationName(),
    configuration: await eda.pcb_Drc.getCurrentRuleConfiguration(),
  } : null;
  const layers = await eda.pcb_Layer.getAllLayers();
  const netNames = await eda.pcb_Net.getAllNetsName();
  const components = await eda.pcb_PrimitiveComponent.getAll();
  const lines = await eda.pcb_PrimitiveLine.getAll();
  const arcs = await eda.pcb_PrimitiveArc.getAll();
  const polylines = await eda.pcb_PrimitivePolyline.getAll();
  const vias = await eda.pcb_PrimitiveVia.getAll();
  const pours = await eda.pcb_PrimitivePour.getAll();

  const lineData = lines
    .map((line) => ({
      primitiveId: value(line, "getState_PrimitiveId", "primitiveId"),
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
  const arcData = arcs
    .map((arc) => ({
      primitiveId: value(arc, "getState_PrimitiveId", "primitiveId"),
      net: value(arc, "getState_Net", "net") || "",
      layer: value(arc, "getState_Layer", "layer"),
      lineWidth: value(arc, "getState_LineWidth", "lineWidth"),
      startX: value(arc, "getState_StartX", "startX"),
      startY: value(arc, "getState_StartY", "startY"),
      endX: value(arc, "getState_EndX", "endX"),
      endY: value(arc, "getState_EndY", "endY"),
      arcAngle: value(arc, "getState_ArcAngle", "arcAngle"),
    }))
    .filter((arc) =>
      [arc.startX, arc.startY, arc.endX, arc.endY, arc.arcAngle].every(Number.isFinite)
    );
  const segments = [
    ...lineData.map((line) => ({ ...line, segmentKind: "line" })),
    ...arcData.map((arc) => ({ ...arc, segmentKind: "arc" })),
  ];
  const polylineData = [];
  for (const polyline of polylines) {
    const net = value(polyline, "getState_Net", "net") || "";
    const polygon = value(polyline, "getState_Polygon", "polygon");
    const points = polygonPoints(polygon);
    const first = points[0];
    const last = points[points.length - 1];
    const closed = Boolean(
      points.length >= 4 &&
      Number.isFinite(first?.x) &&
      Number.isFinite(first?.y) &&
      first.x === last?.x &&
      first.y === last?.y
    );
    polylineData.push({
      primitiveId: value(polyline, "getState_PrimitiveId", "primitiveId"),
      net,
      layer: value(polyline, "getState_Layer", "layer"),
      lineWidth: value(polyline, "getState_LineWidth", "lineWidth"),
      locked: Boolean(value(polyline, "getState_PrimitiveLock", "primitiveLock")),
      closed,
      points: points.map((point) => [point.x, point.y]),
    });
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
      solderMaskExpansion:
        value(via, "getState_SolderMaskExpansion", "solderMaskExpansion") || null,
    }))
    .filter((via) => Number.isFinite(via.x) && Number.isFinite(via.y));
  const pourData = [];
  for (const pour of pours) {
    const copper = await pour.getCopperRegion();
    const complexPolygon = value(
      pour,
      "getState_ComplexPolygon",
      "complexPolygon",
    );
    const fills = copper ? copper.getState_PourFills() : [];
    const solidFills = fills.filter((fill) => fill && fill.fill === true);
    pourData.push({
      primitiveId: value(pour, "getState_PrimitiveId", "primitiveId"),
      name: value(pour, "getState_PourName", "pourName") || "",
      net: value(pour, "getState_Net", "net") || "",
      layer: value(pour, "getState_Layer", "layer"),
      lineWidth: value(pour, "getState_LineWidth", "lineWidth"),
      fillMethod: value(pour, "getState_PourFillMethod", "pourFillMethod"),
      priority: value(pour, "getState_PourPriority", "pourPriority"),
      complexPolygon:
        complexPolygon &&
        typeof complexPolygon.getSourceStrictComplex === "function"
          ? complexPolygon.getSourceStrictComplex()
          : complexPolygon || null,
      preserveSilos: Boolean(
        value(pour, "getState_PreserveSilos", "preserveSilos")
      ),
    hasCopper: Boolean(copper),
    fillCount: fills.length,
    solidFillCount: solidFills.length,
    solidFillRecords: solidFills.map((fill) => ({
      id: fill.id || fill.primitiveId || "",
      lineWidth: fill.lineWidth,
      path:
        fill.path && typeof fill.path.getSourceStrictComplex === "function"
          ? fill.path.getSourceStrictComplex()
          : fill.path || null,
    })),
    solidFillIds: solidFills
      .map((fill) => fill.id || fill.primitiveId)
      .filter(Boolean),
    });
  }
  const componentData = [];
  const padData = [];
  for (const component of components) {
    const primitiveId = value(component, "getState_PrimitiveId", "primitiveId");
    const designator = value(component, "getState_Designator", "designator") || "";
    const bbox = await eda.pcb_Primitive.getPrimitivesBBox([component]);
    componentData.push({
      primitiveId,
      designator,
      uniqueId: value(component, "getState_UniqueId", "uniqueId") || "",
      name: value(component, "getState_Name", "name") || "",
      manufacturer:
        value(component, "getState_Manufacturer", "manufacturer") || "",
      manufacturerPartNumber:
        value(component, "getState_ManufacturerId", "manufacturerId") || "",
      footprint: value(component, "getState_Footprint", "footprint") || null,
      model3D: value(component, "getState_Model3D", "model3D") || null,
      layer: value(component, "getState_Layer", "layer"),
      x: value(component, "getState_X", "x"),
      y: value(component, "getState_Y", "y"),
      rotation: value(component, "getState_Rotation", "rotation") || 0,
      bbox: bbox || null,
    });
    const pins = typeof component.getAllPins === "function"
      ? await component.getAllPins()
      : [];
    for (const pad of pins || []) {
      padData.push({
        primitiveId: value(pad, "getState_PrimitiveId", "primitiveId"),
        parentComponentPrimitiveId: primitiveId,
        designator,
        padNumber: value(pad, "getState_PadNumber", "padNumber") || "",
        net: value(pad, "getState_Net", "net") || "",
        layer: value(pad, "getState_Layer", "layer"),
        x: value(pad, "getState_X", "x"),
        y: value(pad, "getState_Y", "y"),
        rotation: value(pad, "getState_Rotation", "rotation") || 0,
        pad: value(pad, "getState_Pad", "pad") || null,
        specialPad: value(pad, "getState_SpecialPad", "specialPad") || null,
        hole: value(pad, "getState_Hole", "hole") || null,
        padType: value(pad, "getState_PadType", "padType"),
        solderMaskAndPasteMaskExpansion:
          value(
            pad,
            "getState_SolderMaskAndPasteMaskExpansion",
            "solderMaskAndPasteMaskExpansion"
          ) || null,
      });
    }
  }
  const drcSamples = includeDrc ? [
    {
      id: "silent-1",
      strict: true,
      userInterface: false,
      includeVerboseError: true,
      result: await eda.pcb_Drc.check(true, false, true),
    },
    {
      id: "silent-2",
      strict: true,
      userInterface: false,
      includeVerboseError: true,
      result: await eda.pcb_Drc.check(true, false, true),
    },
    {
      id: "visible-final",
      strict: true,
      userInterface: true,
      includeVerboseError: true,
      result: await eda.pcb_Drc.check(true, true, true),
    },
  ] : [];
  const drcRuleAfter = includeDrc ? {
    name: await eda.pcb_Drc.getCurrentRuleConfigurationName(),
    configuration: await eda.pcb_Drc.getCurrentRuleConfiguration(),
  } : null;
  const drc = includeDrc ? drcSamples[drcSamples.length - 1].result : null;
  return {
    ...base,
    kind: "pcb",
    boardOutlineLayerId:
      layers.find((layer) =>
        /board.*outline|outline.*board|板框/i.test(layer.name || "")
      )?.id ?? null,
    layers: layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      type: layer.type,
    })),
    components: componentData,
    pads: padData,
    netNames,
    lines: lineData,
    arcs: arcData,
    polylines: polylineData,
    segments,
    vias: viaData,
    viaCount: viaData.length,
    pours: [
      ...new Map(
        pourData.map((pour) => [pour.primitiveId || JSON.stringify(pour), pour]),
      ).values(),
    ],
    drc,
    drcEvidence: {
      schemaVersion: 1,
      ruleBefore: drcRuleBefore,
      ruleAfter: drcRuleAfter,
      samples: drcSamples,
    },
  };
}

throw new Error(
  "Active document must be a schematic page or PCB; received type " +
    documentInfo.documentType
);`;
}

async function collectFromEasyEda(bridge, windowId) {
  const payload = { code: collectorCode(), windowId };
  const response = await fetchJson(
    `http://127.0.0.1:${bridge.port}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    120_000,
  );
  if (!response.success) throw new Error(response.error || "EasyEDA execution failed");
  return { raw: response.result, windowId: response.windowId };
}

function drcLeafErrors(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => drcLeafErrors(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const children = Array.isArray(value.list) ? value.list : [];
  if (children.length) {
    children.forEach((item) => drcLeafErrors(item, output));
  } else if (nonemptyString(value.errorType) || nonemptyString(value.errorObjType)) {
    output.push(value);
  }
  return output;
}

function summarizeDrc(drc) {
  if (typeof drc === "boolean") {
    return { passed: drc, errorCount: drc ? 0 : null, errors: [] };
  }
  if (Array.isArray(drc)) {
    const warningGroups = drc.filter(
      (item) => String(item?.type || "").toLowerCase() === "warn",
    );
    const errors = drc.filter(
      (item) => String(item?.type || "").toLowerCase() !== "warn",
    );
    const errorLeaves = drcLeafErrors(errors);
    const warningLeaves = drcLeafErrors(warningGroups);
    const warningCount = warningGroups.reduce(
      (total, item) => total + (Number.isFinite(item?.count) ? item.count : 1),
      0,
    );
    return {
      passed: errors.length === 0,
      errorCount: errorLeaves.length || errors.length,
      errors,
      errorLeaves,
      warningCount: warningLeaves.length || warningCount,
      warnings: warningGroups,
      warningLeaves,
    };
  }
  return {
    passed: false,
    errorCount: null,
    errors: [],
    note: "Unexpected DRC response; inspect EasyEDA manually",
  };
}

function stripVolatileDrcFields(value) {
  if (Array.isArray(value)) return value.map(stripVolatileDrcFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "globalIndex")
      .map(([key, item]) => [key, stripVolatileDrcFields(item)]),
  );
}

function canonicalDrcLeaves(drc) {
  return drcLeafErrors(drc)
    .map((item) => ({
      errorType: item.errorType || "",
      errorObjType: item.errorObjType || "",
      ruleName: item.ruleName || "",
      objs: Array.isArray(item.objs)
        ? [...item.objs].filter(nonemptyString).sort()
        : nonemptyString(item.objs)
          ? [item.objs]
          : [],
      isFree: item.isFree === true,
      explanation: stripVolatileDrcFields(item.explanation || null),
    }))
    .sort((left, right) =>
      constraintFingerprint(left).localeCompare(constraintFingerprint(right)),
    );
}

function drcRuleBinding(evidence = {}) {
  const before = evidence.ruleBefore || {};
  const after = evidence.ruleAfter || {};
  const beforeConfigurationValid = Boolean(
    before.configuration &&
      typeof before.configuration === "object" &&
      !Array.isArray(before.configuration),
  );
  const afterConfigurationValid = Boolean(
    after.configuration &&
      typeof after.configuration === "object" &&
      !Array.isArray(after.configuration),
  );
  const beforeFingerprint = beforeConfigurationValid
    ? constraintFingerprint(before.configuration)
    : null;
  const afterFingerprint = afterConfigurationValid
    ? constraintFingerprint(after.configuration)
    : null;
  const captured = Boolean(
    nonemptyString(before.name) &&
      nonemptyString(after.name) &&
      beforeFingerprint &&
      afterFingerprint,
  );
  const stable = Boolean(
    captured &&
      before.name === after.name &&
      beforeFingerprint === afterFingerprint,
  );
  return {
    captured,
    stable,
    name: stable ? before.name : null,
    fingerprint: stable ? beforeFingerprint : null,
    before: {
      name: before.name || null,
      fingerprint: beforeFingerprint,
      configuration: beforeConfigurationValid ? before.configuration : null,
    },
    after: {
      name: after.name || null,
      fingerprint: afterFingerprint,
      configuration: afterConfigurationValid ? after.configuration : null,
    },
    reason: !captured
      ? "current DRC rule configuration was not captured before and after the checks"
      : stable
        ? "DRC rule name and full configuration were stable across the audit"
        : "DRC rule name or full configuration changed during the audit",
  };
}

function summarizePcbDrcEvidence(raw, options) {
  const evidence = raw.drcEvidence || {};
  const samples = Array.isArray(evidence.samples) ? evidence.samples : [];
  const expectedSamples = [
    { id: "silent-1", userInterface: false },
    { id: "silent-2", userInterface: false },
    { id: "visible-final", userInterface: true },
  ];
  const sampleContractComplete = Boolean(
    samples.length === expectedSamples.length &&
      samples.every((sample, index) =>
        sample?.id === expectedSamples[index].id &&
        sample.strict === true &&
        sample.userInterface === expectedSamples[index].userInterface &&
        sample.includeVerboseError === true &&
        Array.isArray(sample.result),
      ),
  );
  const sampleReports = samples.map((sample) => {
    const canonicalLeaves = canonicalDrcLeaves(sample.result);
    return {
      id: sample.id || null,
      strict: sample.strict === true,
      userInterface: sample.userInterface === true,
      includeVerboseError: sample.includeVerboseError === true,
      detailedResult: Array.isArray(sample.result),
      leafCount: canonicalLeaves.length,
      leafFingerprint: constraintFingerprint({ leaves: canonicalLeaves }),
      summary: summarizePcbDrc(
        sample.result,
        options,
        raw.document,
        raw.project,
      ),
      canonicalLeaves,
    };
  });
  const leafFingerprints = sampleReports.map((sample) => sample.leafFingerprint);
  const repeatable = Boolean(
    sampleContractComplete &&
      leafFingerprints.length > 0 &&
      leafFingerprints.every((fingerprint) => fingerprint === leafFingerprints[0]),
  );
  const ruleBinding = drcRuleBinding(evidence);
  const evidenceVerified = Boolean(
    sampleContractComplete && repeatable && ruleBinding.stable,
  );
  const fallback = summarizePcbDrc(
    raw.drc,
    options,
    raw.document,
    raw.project,
  );
  const finalSummary = sampleReports.at(-1)?.summary || fallback;
  const nonPassingSamples = sampleReports.filter((sample) => !sample.summary.passed);
  const observedLeaves = [
    ...new Map(
      sampleReports
        .flatMap((sample) => sample.canonicalLeaves)
        .map((leaf) => [constraintFingerprint(leaf), leaf]),
    ).values(),
  ];
  const passed = sampleReports.length > 0
    ? nonPassingSamples.length === 0
    : fallback.passed;
  return {
    ...finalSummary,
    passed,
    errorCount: passed ? 0 : observedLeaves.length || finalSummary.errorCount,
    evidenceVerified,
    ruleBinding,
    repeatability: {
      sampleContractComplete,
      stableLeafSet: repeatable,
      expectedSequence: expectedSamples,
      observedSampleIds: sampleReports.map((sample) => sample.id),
      leafFingerprints,
      reason: !sampleContractComplete
        ? "required two silent and one visible detailed strict DRC samples are missing"
        : repeatable
          ? "all strict DRC samples returned the same canonical leaf set"
          : "strict DRC samples returned different canonical leaf sets",
    },
    samples: sampleReports.map(({ canonicalLeaves, summary, ...sample }) => ({
      ...sample,
      passed: summary.passed,
      passedWithExceptions: summary.passedWithExceptions === true,
      errorCount: summary.errorCount,
      warningCount: summary.warningCount || 0,
    })),
    observedNonPassingSampleIds: nonPassingSamples.map((sample) => sample.id),
    observedLeaves,
  };
}

function summarizePcbDrc(drc, options, documentInfo, projectInfo) {
  const summary = summarizeDrc(drc);
  const exception = options.nativeNetlistCacheException;
  if (!exception || summary.passed) return summary;
  const leaves = drcLeafErrors(drc);
  const pcbMatches = exception.artifact.pcbUuid === documentInfo?.uuid;
  const projectMatches =
    !exception.artifact.projectUuid ||
    exception.artifact.projectUuid === projectInfo?.uuid;
  const solelyNativeCache =
    leaves.length > 0 &&
    leaves.every(
      (item) =>
        item.errorType === "Netlist Error" && item.ruleName === "Import Changes",
    );
  if (!pcbMatches || !projectMatches || !solelyNativeCache) {
    return {
      ...summary,
      exceptionRejected: !pcbMatches
        ? `manufacturing-netlist artifact PCB ${exception.artifact.pcbUuid} does not match active PCB ${documentInfo?.uuid || "<unknown>"}`
        : !projectMatches
          ? `manufacturing-netlist artifact project ${exception.artifact.projectUuid} does not match active project ${projectInfo?.uuid || "<unknown>"}`
        : "DRC contains errors other than the documented native Import Changes cache mismatch",
    };
  }
  return {
    passed: true,
    passedWithExceptions: true,
    errorCount: 0,
    rawErrorCount: leaves.length,
    rawErrors: summary.errors,
    errors: [],
    warningCount: summary.warningCount || 0,
    warnings: summary.warnings || [],
    exceptions: leaves.map((item) => ({
      errorType: item.errorType,
      errorObjType: item.errorObjType || null,
      ruleName: item.ruleName,
      globalIndex: item.globalIndex || null,
      reason: exception.reason,
      artifactPath: exception.artifactPath,
      manufacturingNetlist: exception.artifact,
    })),
  };
}

function designatorIssues(components) {
  const missing = components
    .filter((component) => !component.designator)
    .map((component) => component.primitiveId);
  const byDesignator = new Map();
  for (const component of components.filter((item) => item.designator)) {
    if (!byDesignator.has(component.designator)) byDesignator.set(component.designator, []);
    byDesignator.get(component.designator).push(component.primitiveId);
  }
  const duplicates = [...byDesignator.entries()]
    .filter(([, primitiveIds]) => primitiveIds.length > 1)
    .map(([designator, primitiveIds]) => ({ designator, primitiveIds }));
  return { missing, duplicates };
}

function nearestFortyFiveDeviationDeg(segment) {
  const angle =
    (Math.atan2(segment.endY - segment.startY, segment.endX - segment.startX) *
      180) /
    Math.PI;
  const normalized = ((angle % 180) + 180) % 180;
  const nearest = Math.round(normalized / 45) * 45;
  return Math.abs(normalized - nearest);
}

function padContainsPoint(pad, point, layer, tolerance) {
  if (!pad || pad.net !== point.net) return false;
  const padLayers = Array.isArray(pad.layer) ? pad.layer : [pad.layer];
  if (
    padLayers.filter(Number.isFinite).length &&
    !padLayers.includes(layer) &&
    !padLayers.includes(0)
  ) {
    return false;
  }
  if (![pad.x, pad.y].every(Number.isFinite)) return false;
  const dx = point.x - pad.x;
  const dy = point.y - pad.y;
  const radians = (-Number(pad.rotation || 0) * Math.PI) / 180;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  const shape = Array.isArray(pad.pad) ? pad.pad : [];
  const kind = String(shape[0] || "").toUpperCase();
  const width = Number(shape[1]);
  const height = Number(shape[2]);
  if (!Number.isFinite(width) || width <= 0) {
    return Math.hypot(dx, dy) <= tolerance;
  }
  if (kind.includes("ELLIPSE")) {
    const halfWidth = width / 2 + tolerance;
    const halfHeight = (Number.isFinite(height) ? height : width) / 2 + tolerance;
    return (localX / halfWidth) ** 2 + (localY / halfHeight) ** 2 <= 1;
  }
  if (kind.includes("POLYGON")) {
    return Math.hypot(localX, localY) <= width / 2 + tolerance;
  }
  if (Number.isFinite(height) && height > 0) {
    return (
      Math.abs(localX) <= width / 2 + tolerance &&
      Math.abs(localY) <= height / 2 + tolerance
    );
  }
  return Math.hypot(localX, localY) <= width / 2 + tolerance;
}

function analyzeSharpRightAngleCorners(raw, segments, tolerance = 0.05) {
  const endpointMap = new Map();
  const keyFor = (segment, x, y) =>
    `${segment.net}\u0000${segment.layer}\u0000${Math.round(x / tolerance)}\u0000${Math.round(
      y / tolerance,
    )}`;
  const addEndpoint = (segment, x, y, otherX, otherY) => {
    const key = keyFor(segment, x, y);
    if (!endpointMap.has(key)) endpointMap.set(key, []);
    endpointMap.get(key).push({ segment, x, y, otherX, otherY });
  };
  for (const segment of segments) {
    if (!segment.net || segment.segmentKind === "arc") continue;
    addEndpoint(
      segment,
      segment.startX,
      segment.startY,
      segment.endX,
      segment.endY,
    );
    addEndpoint(
      segment,
      segment.endX,
      segment.endY,
      segment.startX,
      segment.startY,
    );
  }

  const pads = raw.pads || [];
  const vias = raw.vias || [];
  const corners = [];
  for (const incident of endpointMap.values()) {
    if (incident.length !== 2) continue;
    const [first, second] = incident;
    if (first.segment.primitiveId === second.segment.primitiveId) continue;
    const firstVector = [first.otherX - first.x, first.otherY - first.y];
    const secondVector = [second.otherX - second.x, second.otherY - second.y];
    const firstLength = Math.hypot(...firstVector);
    const secondLength = Math.hypot(...secondVector);
    if (firstLength <= tolerance || secondLength <= tolerance) continue;
    const cosine = Math.max(
      -1,
      Math.min(
        1,
        (firstVector[0] * secondVector[0] + firstVector[1] * secondVector[1]) /
          (firstLength * secondLength),
      ),
    );
    const turnAngleDeg = (Math.acos(cosine) * 180) / Math.PI;
    if (Math.abs(turnAngleDeg - 90) > 0.1) continue;
    const point = { x: first.x, y: first.y, net: first.segment.net };
    const atPad = pads.some((pad) =>
      padContainsPoint(pad, point, first.segment.layer, tolerance),
    );
    const atVia = vias.some(
      (via) =>
        via.net === point.net &&
        Math.hypot(via.x - point.x, via.y - point.y) <= tolerance,
    );
    if (atPad || atVia) continue;
    corners.push({
      net: first.segment.net,
      layer: first.segment.layer,
      x: Number(first.x.toFixed(4)),
      y: Number(first.y.toFixed(4)),
      turnAngleDeg: Number(turnAngleDeg.toFixed(3)),
      primitiveIds: [
        first.segment.primitiveId,
        second.segment.primitiveId,
      ],
    });
  }
  return {
    method:
      "same-net/same-layer two-segment endpoint junctions; pad and via junctions excluded",
    toleranceMil: tolerance,
    corners,
    count: corners.length,
    limitations: [
      "Arc tangency and intersections away from explicit segment endpoints are not evaluated.",
      "Pad exclusion uses documented pad geometry; unusual complex pads may receive only conservative center-point exclusion.",
    ],
  };
}

function summarizeRoutingLayers(lines, layerById) {
  const byLayer = new Map();
  for (const line of lines) {
    const lengthMil = Math.hypot(
      line.endX - line.startX,
      line.endY - line.startY,
    );
    if (!byLayer.has(line.layer)) {
      byLayer.set(line.layer, {
        layer: line.layer,
        layerName: layerById.get(line.layer)?.name || "",
        segmentCount: 0,
        lengthMil: 0,
      });
    }
    const item = byLayer.get(line.layer);
    item.segmentCount += 1;
    item.lengthMil += lengthMil;
  }
  const totalLengthMil = [...byLayer.values()].reduce(
    (sum, item) => sum + item.lengthMil,
    0,
  );
  return [...byLayer.values()]
    .map((item) => ({
      ...item,
      lengthMil: Number(item.lengthMil.toFixed(3)),
      lengthPercent: totalLengthMil
        ? Number(((item.lengthMil / totalLengthMil) * 100).toFixed(2))
        : 0,
    }))
    .sort((first, second) => first.layer - second.layer);
}

const ROUTING_TOPOLOGY_TOLERANCE_MIL = 0.05;

function routingPointKey(layer, point, tolerance = ROUTING_TOPOLOGY_TOLERANCE_MIL) {
  return `${String(layer)}@${Math.round(point.x / tolerance)},${Math.round(
    point.y / tolerance,
  )}`;
}

function pointOnStraightSegment(point, segment, tolerance) {
  const dx = segment.endX - segment.startX;
  const dy = segment.endY - segment.startY;
  const length = Math.hypot(dx, dy);
  if (length <= tolerance) return false;
  const cross =
    (point.x - segment.startX) * dy - (point.y - segment.startY) * dx;
  if (Math.abs(cross) > tolerance * length) return false;
  const dot =
    (point.x - segment.startX) * dx + (point.y - segment.startY) * dy;
  return dot >= -tolerance * length && dot <= length * length + tolerance * length;
}

function uniqueRoutingPoints(points, tolerance) {
  const seen = new Set();
  return points.filter((point) => {
    const key = `${Math.round(point.x / tolerance)},${Math.round(
      point.y / tolerance,
    )}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function straightSegmentIntersections(first, second, tolerance) {
  const p = { x: first.startX, y: first.startY };
  const q = { x: second.startX, y: second.startY };
  const r = {
    x: first.endX - first.startX,
    y: first.endY - first.startY,
  };
  const s = {
    x: second.endX - second.startX,
    y: second.endY - second.startY,
  };
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const qMinusP = { x: q.x - p.x, y: q.y - p.y };
  const denominator = cross(r, s);
  const scale = Math.max(1, Math.hypot(r.x, r.y), Math.hypot(s.x, s.y));

  if (Math.abs(denominator) <= tolerance * scale) {
    if (Math.abs(cross(qMinusP, r)) > tolerance * Math.max(1, Math.hypot(r.x, r.y))) {
      return [];
    }
    return uniqueRoutingPoints(
      [
        p,
        { x: first.endX, y: first.endY },
        q,
        { x: second.endX, y: second.endY },
      ].filter(
        (point) =>
          pointOnStraightSegment(point, first, tolerance) &&
          pointOnStraightSegment(point, second, tolerance),
      ),
      tolerance,
    );
  }

  const t = cross(qMinusP, s) / denominator;
  const u = cross(qMinusP, r) / denominator;
  const margin = tolerance / scale;
  if (t < -margin || t > 1 + margin || u < -margin || u > 1 + margin) {
    return [];
  }
  return [{ x: p.x + t * r.x, y: p.y + t * r.y }];
}

function routingEdgeSummary(edge, nodes) {
  const start = nodes.get(edge.from);
  const end = nodes.get(edge.to);
  return {
    kind: edge.kind,
    primitiveId: edge.primitiveId,
    layer: edge.layer ?? null,
    start,
    end,
    lengthMil: Number(Math.hypot(end.x - start.x, end.y - start.y).toFixed(4)),
  };
}

function findTreePath(tree, start, end) {
  const queue = [start];
  const previous = new Map([[start, null]]);
  while (queue.length) {
    const current = queue.shift();
    if (current === end) break;
    for (const entry of tree.get(current) || []) {
      if (previous.has(entry.node)) continue;
      previous.set(entry.node, { node: current, edge: entry.edge });
      queue.push(entry.node);
    }
  }
  if (!previous.has(end)) return [];
  const path = [];
  for (let cursor = end; cursor !== start; ) {
    const entry = previous.get(cursor);
    path.push(entry.edge);
    cursor = entry.node;
  }
  return path.reverse();
}

function analyzeRoutingTopology(raw, options = {}) {
  const tolerance = ROUTING_TOPOLOGY_TOLERANCE_MIL;
  const allowedNets = new Set(options.allowRoutingCycleNets || []);
  const sourceSegments =
    Array.isArray(raw.segments) && raw.segments.length
      ? raw.segments
      : [
          ...(raw.lines || []).map((segment) => ({
            ...segment,
            segmentKind: "line",
          })),
          ...(raw.arcs || []).map((segment) => ({
            ...segment,
            segmentKind: "arc",
          })),
        ];
  const segmentsByNet = new Map();
  for (const segment of sourceSegments) {
    if (
      !nonemptyString(segment.net) ||
      ![segment.startX, segment.startY, segment.endX, segment.endY].every(
        Number.isFinite,
      )
    ) {
      continue;
    }
    if (!segmentsByNet.has(segment.net)) segmentsByNet.set(segment.net, []);
    segmentsByNet.get(segment.net).push(segment);
  }
  const viasByNet = new Map();
  for (const via of raw.vias || []) {
    if (!nonemptyString(via.net) || !Number.isFinite(via.x) || !Number.isFinite(via.y)) {
      continue;
    }
    if (!viasByNet.has(via.net)) viasByNet.set(via.net, []);
    viasByNet.get(via.net).push(via);
  }

  const netNames = new Set([...segmentsByNet.keys(), ...viasByNet.keys()]);
  const nets = [];
  for (const net of [...netNames].sort()) {
    const segments = segmentsByNet.get(net) || [];
    const vias = viasByNet.get(net) || [];
    const splitPoints = segments.map((segment) => [
      { x: segment.startX, y: segment.startY },
      { x: segment.endX, y: segment.endY },
    ]);

    for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
      const first = segments[firstIndex];
      if (first.segmentKind === "arc") continue;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < segments.length;
        secondIndex += 1
      ) {
        const second = segments[secondIndex];
        if (
          second.segmentKind === "arc" ||
          String(first.layer) !== String(second.layer)
        ) {
          continue;
        }
        const intersections = straightSegmentIntersections(
          first,
          second,
          tolerance,
        );
        splitPoints[firstIndex].push(...intersections);
        splitPoints[secondIndex].push(...intersections);
      }
    }

    for (const via of vias) {
      for (let index = 0; index < segments.length; index += 1) {
        if (
          segments[index].segmentKind !== "arc" &&
          pointOnStraightSegment(via, segments[index], tolerance)
        ) {
          splitPoints[index].push({ x: via.x, y: via.y });
        }
      }
    }

    const nodes = new Map();
    const edgeByKey = new Map();
    const duplicateEdges = [];
    const addEdge = (edge) => {
      if (edge.from === edge.to) return;
      const key =
        edge.from < edge.to
          ? `${edge.from}|${edge.to}`
          : `${edge.to}|${edge.from}`;
      if (edgeByKey.has(key)) {
        const existing = edgeByKey.get(key);
        if (existing.primitiveId !== edge.primitiveId) {
          duplicateEdges.push({
            firstPrimitiveId: existing.primitiveId,
            secondPrimitiveId: edge.primitiveId,
            start: nodes.get(edge.from),
            end: nodes.get(edge.to),
          });
        }
        return;
      }
      edgeByKey.set(key, edge);
    };

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const dx = segment.endX - segment.startX;
      const dy = segment.endY - segment.startY;
      const denominator = dx * dx + dy * dy;
      const points = uniqueRoutingPoints(splitPoints[index], tolerance).sort(
        (first, second) => {
          const firstT =
            denominator > 0
              ? ((first.x - segment.startX) * dx +
                  (first.y - segment.startY) * dy) /
                denominator
              : 0;
          const secondT =
            denominator > 0
              ? ((second.x - segment.startX) * dx +
                  (second.y - segment.startY) * dy) /
                denominator
              : 0;
          return firstT - secondT;
        },
      );
      for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
        const start = points[pointIndex - 1];
        const end = points[pointIndex];
        if (Math.hypot(end.x - start.x, end.y - start.y) <= tolerance) continue;
        const from = routingPointKey(segment.layer, start, tolerance);
        const to = routingPointKey(segment.layer, end, tolerance);
        nodes.set(from, { layer: segment.layer, x: start.x, y: start.y });
        nodes.set(to, { layer: segment.layer, x: end.x, y: end.y });
        addEdge({
          from,
          to,
          kind: segment.segmentKind || "line",
          primitiveId: segment.primitiveId,
          layer: segment.layer,
        });
      }
    }

    for (const via of vias) {
      const touched = [];
      for (const [key, node] of nodes) {
        if (
          Math.hypot(node.x - via.x, node.y - via.y) <= tolerance &&
          !touched.includes(key)
        ) {
          touched.push(key);
        }
      }
      for (let index = 1; index < touched.length; index += 1) {
        addEdge({
          from: touched[0],
          to: touched[index],
          kind: "via",
          primitiveId: via.primitiveId,
          layer: null,
        });
      }
    }

    const parent = new Map([...nodes.keys()].map((key) => [key, key]));
    const find = (key) => {
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(key) !== key) {
        const next = parent.get(key);
        parent.set(key, root);
        key = next;
      }
      return root;
    };
    const union = (first, second) => {
      const firstRoot = find(first);
      const secondRoot = find(second);
      if (firstRoot === secondRoot) return false;
      parent.set(secondRoot, firstRoot);
      return true;
    };
    const tree = new Map();
    const addTreeEdge = (edge) => {
      if (!tree.has(edge.from)) tree.set(edge.from, []);
      if (!tree.has(edge.to)) tree.set(edge.to, []);
      tree.get(edge.from).push({ node: edge.to, edge });
      tree.get(edge.to).push({ node: edge.from, edge });
    };
    const cycleWitnesses = [];
    for (const edge of edgeByKey.values()) {
      if (union(edge.from, edge.to)) {
        addTreeEdge(edge);
        continue;
      }
      if (cycleWitnesses.length >= 20) continue;
      const witnessEdges = [...findTreePath(tree, edge.from, edge.to), edge];
      const publicEdges = witnessEdges.map((item) =>
        routingEdgeSummary(item, nodes),
      );
      const witnessPoints = publicEdges.flatMap((item) => [item.start, item.end]);
      cycleWitnesses.push({
        edgeCount: publicEdges.length,
        lengthMil: Number(
          publicEdges.reduce((sum, item) => sum + item.lengthMil, 0).toFixed(4),
        ),
        boundsMil: {
          minX: Math.min(...witnessPoints.map((point) => point.x)),
          minY: Math.min(...witnessPoints.map((point) => point.y)),
          maxX: Math.max(...witnessPoints.map((point) => point.x)),
          maxY: Math.max(...witnessPoints.map((point) => point.y)),
        },
        edges: publicEdges,
      });
    }
    const componentCount = new Set([...nodes.keys()].map(find)).size;
    const cyclomaticNumber =
      edgeByKey.size - nodes.size + componentCount;
    nets.push({
      net,
      allowed: allowedNets.has(net),
      nodeCount: nodes.size,
      edgeCount: edgeByKey.size,
      connectedComponentCount: componentCount,
      cyclomaticNumber,
      cycleWitnesses,
      duplicateEdges,
      coverage:
        segments.some((segment) => segment.segmentKind === "arc")
          ? "PARTIAL_ARC_INTERSECTION_COVERAGE"
          : "STRAIGHT_TRACK_AND_VIA_GRAPH",
    });
  }

  const cyclicNets = nets.filter((item) => item.cyclomaticNumber > 0);
  const unexpectedCycles = cyclicNets.filter((item) => !item.allowed);
  const allowedCycles = cyclicNets.filter((item) => item.allowed);
  const duplicateNets = nets.filter((item) => item.duplicateEdges.length);
  return {
    method: "per-net explicit track/via graph; same-layer straight intersections split into nodes",
    toleranceMil: tolerance,
    policy:
      "Explicit routing cycles are failures unless the net is named by --allow-routing-cycle with --exception-note.",
    nets,
    cyclicNets: cyclicNets.map((item) => item.net),
    unexpectedCycles: unexpectedCycles.map((item) => item.net),
    allowedCycles: allowedCycles.map((item) => item.net),
    duplicateNets: duplicateNets.map((item) => item.net),
    limitations: [
      "Copper pours and pad-internal copper are not expanded into graph edges, so a loop closed only through a pour or pad body can be missed.",
      "Arc endpoints are included, but intersections through an arc interior are not solved; affected nets are marked partial.",
    ],
  };
}

function schematicWirePaths(line) {
  if (!Array.isArray(line)) return [];
  if (line.every((value) => typeof value === "number")) return [line];
  return line.filter(
    (path) =>
      Array.isArray(path) && path.every((value) => typeof value === "number"),
  );
}

function schematicWireGeometry(wire) {
  const paths = schematicWirePaths(wire?.line);
  let length = 0;
  let segmentCount = 0;
  for (const path of paths) {
    for (let index = 2; index + 1 < path.length; index += 2) {
      length += Math.hypot(
        path[index] - path[index - 2],
        path[index + 1] - path[index - 1],
      );
      segmentCount += 1;
    }
  }
  return {
    primitiveId: wire?.primitiveId || null,
    net: wire?.net || "",
    length,
    segmentCount,
  };
}

function analyzeSchematicPresentation(raw = {}) {
  const hasWireGeometry = Array.isArray(raw.schematicWires);
  const hasAnnotations = Array.isArray(raw.schematicAnnotations);
  const componentCount = (raw.components || []).length;
  if (!hasWireGeometry || !hasAnnotations) {
    return {
      status: "UNVERIFIED",
      available: false,
      blocking: false,
      requiresVisualReview: true,
      observations: [
        "schematic wire geometry or connectivity-annotation readback is missing",
      ],
      metrics: {
        componentCount,
        wireCount: raw.wireCount || 0,
        annotationCount: null,
      },
    };
  }

  const wires = raw.schematicWires.map(schematicWireGeometry);
  const wireCount = wires.length;
  const annotationCount = raw.schematicAnnotations.length;
  const netportCount = raw.schematicAnnotations.filter(
    (item) => item.componentType === "netport",
  ).length;
  const shortStubCount = wires.filter(
    (item) => item.segmentCount === 1 && item.length <= 15,
  ).length;
  const multiSegmentWireCount = wires.filter(
    (item) => item.segmentCount > 1,
  ).length;
  const maximumWireLength = wires.reduce(
    (maximum, item) => Math.max(maximum, item.length),
    0,
  );
  const shortStubRatio = wireCount ? shortStubCount / wireCount : 0;
  const multiSegmentWireRatio = wireCount
    ? multiSegmentWireCount / wireCount
    : 0;
  const annotationPerComponent = componentCount
    ? annotationCount / componentCount
    : 0;

  const degradedLabelStubPattern =
    componentCount >= 8 &&
    wireCount >= Math.max(24, componentCount * 3) &&
    annotationCount >= Math.max(12, componentCount) &&
    shortStubRatio >= 0.95 &&
    multiSegmentWireCount === 0 &&
    maximumWireLength <= 20;
  const reviewPattern =
    !degradedLabelStubPattern &&
    componentCount >= 4 &&
    wireCount >= 12 &&
    annotationCount >= Math.max(6, Math.ceil(componentCount / 2)) &&
    shortStubRatio >= 0.8 &&
    multiSegmentWireRatio <= 0.1;

  const observations = [];
  if (degradedLabelStubPattern) {
    observations.push(
      "the page is dominated by one-segment short stubs and connectivity annotations, with no multi-segment functional wiring",
    );
  } else if (reviewPattern) {
    observations.push(
      "short stubs and connectivity annotations dominate the page; inspect functional-block continuity before schematic handoff",
    );
  }

  return {
    status: degradedLabelStubPattern
      ? "DEGRADED_LABEL_STUB_PATTERN"
      : reviewPattern
        ? "REVIEW_REQUIRED"
        : "CLEAR",
    available: true,
    blocking: degradedLabelStubPattern,
    requiresVisualReview: degradedLabelStubPattern || reviewPattern,
    observations,
    metrics: {
      componentCount,
      wireCount,
      annotationCount,
      netportCount,
      shortStubCount,
      shortStubRatio,
      multiSegmentWireCount,
      multiSegmentWireRatio,
      maximumWireLength,
      annotationPerComponent,
      schematicUnit: "10mil",
      shortStubThreshold: 15,
    },
    limitations: [
      "This geometry screen detects an extreme label/stub presentation pattern; it does not prove circuit correctness or judge every legitimate connector or cross-sheet labeling style.",
      "A visual review of the saved/reopened exact page is still required before schematic handoff.",
    ],
  };
}

/**
 * Validate a hand-authored schematic page envelope.
 *
 * EasyEDA exposes no API for the drawing frame or sheet size: the schematic
 * CANVAS record carries only an origin. The declared envelope is therefore the
 * only bound this audit can check symbol placement against, and it must name
 * its own source rather than inherit a guessed sheet constant.
 */
function validateSchematicPageEnvelope(record, recordPath) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("schematic page envelope must be a JSON object");
  }
  if (record.kind !== "easyeda-schematic-page-envelope") {
    throw new Error(
      'schematic page envelope requires kind "easyeda-schematic-page-envelope"',
    );
  }
  if (record.schemaVersion !== 1) {
    throw new Error("schematic page envelope requires schemaVersion 1");
  }
  if (record.unit !== "10mil") {
    throw new Error(
      'schematic page envelope requires unit "10mil" to match schematic coordinates',
    );
  }
  if (!nonemptyString(record.documentUuid)) {
    throw new Error(
      "schematic page envelope requires the exact schematic page documentUuid",
    );
  }
  if (!nonemptyString(record.source)) {
    throw new Error(
      "schematic page envelope requires a source naming how the drawable bound was established",
    );
  }
  const envelope = record.envelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("schematic page envelope requires an envelope object");
  }
  for (const field of ["minX", "minY", "maxX", "maxY"]) {
    if (!Number.isFinite(envelope[field])) {
      throw new Error(`schematic page envelope requires a finite ${field}`);
    }
  }
  if (envelope.maxX <= envelope.minX || envelope.maxY <= envelope.minY) {
    throw new Error(
      "schematic page envelope requires maxX > minX and maxY > minY",
    );
  }
  return {
    recordPath: recordPath || null,
    documentUuid: record.documentUuid,
    source: record.source,
    unit: record.unit,
    envelope: {
      minX: envelope.minX,
      minY: envelope.minY,
      maxX: envelope.maxX,
      maxY: envelope.maxY,
    },
  };
}

function schematicComponentLabel(component) {
  return (
    (nonemptyString(component?.designator) && component.designator) ||
    (nonemptyString(component?.primitiveId) && component.primitiveId) ||
    "(unidentified component)"
  );
}

function normalizedSchematicBbox(bbox) {
  if (!bbox || typeof bbox !== "object" || Array.isArray(bbox)) return null;
  const { minX, minY, maxX, maxY } = bbox;
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }
  return {
    minX: Math.min(minX, maxX),
    minY: Math.min(minY, maxY),
    maxX: Math.max(minX, maxX),
    maxY: Math.max(minY, maxY),
  };
}

/**
 * Screen symbol placement geometry on a schematic page.
 *
 * Two defects motivate this check: symbols stacked on each other because no
 * deliberate pose was ever assigned, and symbols drawn outside the drawable
 * page area. Coincident poses are decidable from the API alone. Page overrun is
 * only decidable against a declared envelope, because EasyEDA exposes no sheet
 * or drawing-frame dimension, so an absent envelope stays unverified rather than
 * silently passing.
 *
 * BBox intersections are a crowding screen only. The schematic BBox API is beta
 * and includes designator/value text, so intersecting boxes are review evidence,
 * never a proven symbol-body collision.
 */
function analyzeSchematicPlacement(raw = {}, pageEnvelopeRecord = null) {
  const COINCIDENT_TOLERANCE = 0.5;
  const CLUSTER_SPREAD_RATIO = 0.25;
  const CLUSTER_MINIMUM_COMPONENTS = 8;
  const components = raw.components || [];
  const componentCount = components.length;
  const positioned = components.filter(
    (component) =>
      Number.isFinite(component?.x) && Number.isFinite(component?.y),
  );
  const missingPositionDesignators = components
    .filter(
      (component) =>
        !Number.isFinite(component?.x) || !Number.isFinite(component?.y),
    )
    .map(schematicComponentLabel);
  const unresolvedBboxDesignators = components
    .filter((component) => !normalizedSchematicBbox(component?.bbox))
    .map(schematicComponentLabel);

  if (!componentCount) {
    return {
      status: "UNVERIFIED",
      available: false,
      blocking: false,
      requiresVisualReview: true,
      observations: [],
      unresolved: ["schematic page has no part symbols to screen for placement"],
      coincidentPoseGroups: [],
      bboxOverlaps: [],
      envelopeViolations: [],
      missingPositionDesignators,
      unresolvedBboxDesignators,
      pageEnvelope: null,
      metrics: { componentCount: 0, positionedComponentCount: 0 },
      limitations: [],
    };
  }

  const unresolved = [];
  if (missingPositionDesignators.length) {
    unresolved.push(
      `schematic symbol coordinates are missing or non-finite for ${missingPositionDesignators.length} component(s)`,
    );
  }
  if (unresolvedBboxDesignators.length) {
    unresolved.push(
      `schematic symbol BBox readback is unavailable for ${unresolvedBboxDesignators.length} component(s), so their crowding and page containment stay unscreened`,
    );
  }

  // Coincident poses are the literal signature of symbols created without a
  // deliberate position. No sourced dimension is needed to call this a defect.
  const poseGroups = new Map();
  for (const component of positioned) {
    const key = `${Math.round(component.x / COINCIDENT_TOLERANCE)}:${Math.round(
      component.y / COINCIDENT_TOLERANCE,
    )}`;
    if (!poseGroups.has(key)) poseGroups.set(key, []);
    poseGroups.get(key).push(component);
  }
  const coincidentPoseGroups = [...poseGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      x: group[0].x,
      y: group[0].y,
      designators: group.map(schematicComponentLabel),
      primitiveIds: group.map((component) => component.primitiveId || null),
    }));

  const boxed = positioned
    .map((component) => ({
      component,
      bbox: normalizedSchematicBbox(component.bbox),
    }))
    .filter((item) => item.bbox);
  const bboxOverlaps = [];
  for (let first = 0; first < boxed.length; first += 1) {
    for (let second = first + 1; second < boxed.length; second += 1) {
      const a = boxed[first].bbox;
      const b = boxed[second].bbox;
      if (a.minX >= b.maxX || b.minX >= a.maxX) continue;
      if (a.minY >= b.maxY || b.minY >= a.maxY) continue;
      bboxOverlaps.push({
        designators: [
          schematicComponentLabel(boxed[first].component),
          schematicComponentLabel(boxed[second].component),
        ],
        overlapWidth: Number(
          (Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)).toFixed(4),
        ),
        overlapHeight: Number(
          (Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY)).toFixed(4),
        ),
      });
    }
  }

  const occupiedBounds = positioned.length
    ? {
        minX: Math.min(...positioned.map((component) => component.x)),
        minY: Math.min(...positioned.map((component) => component.y)),
        maxX: Math.max(...positioned.map((component) => component.x)),
        maxY: Math.max(...positioned.map((component) => component.y)),
      }
    : null;

  const envelopeViolations = [];
  let pageEnvelope = null;
  if (pageEnvelopeRecord) {
    const stale =
      nonemptyString(raw.document?.uuid) &&
      pageEnvelopeRecord.documentUuid !== raw.document.uuid;
    pageEnvelope = {
      documentUuid: pageEnvelopeRecord.documentUuid,
      source: pageEnvelopeRecord.source,
      envelope: pageEnvelopeRecord.envelope,
      boundToActiveDocument: !stale,
    };
    if (stale) {
      unresolved.push(
        `schematic page envelope names document ${pageEnvelopeRecord.documentUuid}, not the active page ${raw.document.uuid}`,
      );
    } else {
      const bound = pageEnvelopeRecord.envelope;
      for (const component of positioned) {
        const originOutside =
          component.x < bound.minX ||
          component.x > bound.maxX ||
          component.y < bound.minY ||
          component.y > bound.maxY;
        const bbox = normalizedSchematicBbox(component.bbox);
        const extentOutside = bbox
          ? bbox.minX < bound.minX ||
            bbox.maxX > bound.maxX ||
            bbox.minY < bound.minY ||
            bbox.maxY > bound.maxY
          : false;
        if (!originOutside && !extentOutside) continue;
        envelopeViolations.push({
          designator: schematicComponentLabel(component),
          primitiveId: component.primitiveId || null,
          originOutside,
          extentOutside,
          x: component.x,
          y: component.y,
          bbox: bbox || null,
        });
      }
    }
  } else {
    unresolved.push(
      "no schematic page envelope was declared, so symbols drawn outside the drawable page area cannot be detected",
    );
  }

  const observations = [];
  if (coincidentPoseGroups.length) {
    observations.push(
      `${coincidentPoseGroups.length} group(s) of part symbols share one coordinate, so those symbols are stacked rather than placed`,
    );
  }
  if (envelopeViolations.length) {
    observations.push(
      `${envelopeViolations.length} part symbol(s) lie outside the declared drawable page area`,
    );
  }
  if (bboxOverlaps.length) {
    observations.push(
      `${bboxOverlaps.length} symbol BBox pair(s) intersect; confirm the symbols and their designator/value text stay separable by eye`,
    );
  }

  // Envelope-relative spread. A page whose symbols occupy a small corner of the
  // declared drawable area is the crowded-cluster case even when no two boxes
  // intersect. This is a screen ratio, not a sourced spacing requirement.
  let clusteredIntoCorner = false;
  let spreadRatioX = null;
  let spreadRatioY = null;
  if (
    pageEnvelope?.boundToActiveDocument &&
    occupiedBounds &&
    positioned.length >= CLUSTER_MINIMUM_COMPONENTS
  ) {
    const bound = pageEnvelope.envelope;
    spreadRatioX =
      (occupiedBounds.maxX - occupiedBounds.minX) / (bound.maxX - bound.minX);
    spreadRatioY =
      (occupiedBounds.maxY - occupiedBounds.minY) / (bound.maxY - bound.minY);
    clusteredIntoCorner =
      spreadRatioX <= CLUSTER_SPREAD_RATIO &&
      spreadRatioY <= CLUSTER_SPREAD_RATIO;
    if (clusteredIntoCorner) {
      observations.push(
        `${positioned.length} part symbols occupy ${(spreadRatioX * 100).toFixed(1)}% by ${(spreadRatioY * 100).toFixed(1)}% of the declared drawable page area; the page is crowded into one region instead of partitioned into functional blocks`,
      );
    }
  }

  const blocking =
    coincidentPoseGroups.length > 0 || envelopeViolations.length > 0;
  const requiresVisualReview =
    blocking || bboxOverlaps.length > 0 || clusteredIntoCorner;
  const status = blocking
    ? "DEGRADED_SYMBOL_PLACEMENT"
    : unresolved.length
      ? "UNVERIFIED"
      : requiresVisualReview
        ? "REVIEW_REQUIRED"
        : "CLEAR";

  return {
    status,
    available: true,
    blocking,
    requiresVisualReview,
    observations,
    unresolved,
    coincidentPoseGroups,
    bboxOverlaps,
    envelopeViolations,
    missingPositionDesignators,
    unresolvedBboxDesignators,
    pageEnvelope,
    metrics: {
      componentCount,
      positionedComponentCount: positioned.length,
      bboxComponentCount: boxed.length,
      coincidentPoseGroupCount: coincidentPoseGroups.length,
      bboxOverlapPairCount: bboxOverlaps.length,
      envelopeViolationCount: envelopeViolations.length,
      occupiedBounds,
      spreadRatioX,
      spreadRatioY,
      clusteredIntoCorner,
      schematicUnit: "10mil",
      coincidentToleranceUnits: COINCIDENT_TOLERANCE,
      clusterSpreadRatioThreshold: CLUSTER_SPREAD_RATIO,
      clusterMinimumComponents: CLUSTER_MINIMUM_COMPONENTS,
    },
    limitations: [
      "EasyEDA exposes no drawing-frame or sheet-size API, so page containment is judged only against the declared envelope and its stated source.",
      "The schematic BBox API is beta and can include designator, value, and other attribute text, so a BBox intersection is a crowding screen rather than a proven symbol-body collision.",
      "Coordinate spread does not prove a readable functional partition; exact-page visual review still owns that conclusion.",
    ],
  };
}

function analyzeSchematic(raw, source, options = {}) {
  const drc = summarizeDrc(raw.drc);
  const designators = designatorIssues(raw.components || []);
  const missingFootprints = (raw.components || [])
    .filter((component) => component.addIntoPcb === true && !component.footprint)
    .map((component) => ({
      primitiveId: component.primitiveId,
      designator: component.designator,
      name: component.name,
    }));
  const failures = [];
  if (!drc.passed) failures.push("schematic DRC did not pass");
  if (designators.missing.length) failures.push("one or more components lack designators");
  if (designators.duplicates.length) failures.push("duplicate component designators exist");
  if (missingFootprints.length) {
    failures.push("one or more PCB-included components lack footprints");
  }
  const componentSelectionEvidence = validateComponentEvidenceRecord(
    options.componentEvidenceRecord,
    raw,
    { baseDir: options.componentEvidenceBaseDir || process.cwd() },
  );
  failures.push(...componentSelectionEvidence.violations);
  const presentation = analyzeSchematicPresentation(raw);
  if (presentation.blocking) {
    failures.push(
      "schematic presentation is dominated by label/stub fragments and lacks readable functional wiring",
    );
  }
  // Symbol placement is a separate presentation axis from wiring. Stacked
  // symbols and page overrun survive a clean wiring screen, and a readable
  // wiring pattern does not prove either one is absent.
  const symbolPlacement = analyzeSchematicPlacement(
    raw,
    options.schematicPageEnvelopeRecord || null,
  );
  if (symbolPlacement.coincidentPoseGroups.length) {
    failures.push(
      "schematic part symbols share coordinates instead of holding deliberate poses",
    );
  }
  if (symbolPlacement.envelopeViolations.length) {
    failures.push(
      "schematic part symbols lie outside the declared drawable page area",
    );
  }
  const unverified = [...componentSelectionEvidence.unverified];
  if (!presentation.available) {
    unverified.push(
      "schematic presentation geometry is unavailable for readability screening",
    );
  } else if (presentation.requiresVisualReview && !presentation.blocking) {
    unverified.push(
      "schematic presentation requires visual review before handoff",
    );
  }
  unverified.push(...symbolPlacement.unresolved);
  if (symbolPlacement.requiresVisualReview && !symbolPlacement.blocking) {
    unverified.push(
      "schematic symbol placement requires exact-page visual review before handoff",
    );
  }
  const testSource = /^(?:test|self-test)/.test(source?.kind || "");
  const gateLedgerClearanceResult =
    testSource && !options.gateLedgerRecord
      ? { cleared: true, blocking: false, reason: "unit-test fixture bypass" }
      : gateLedgerClearance(options.gateLedgerRecord, {
          projectUuid: raw.project?.uuid,
        });
  if (gateLedgerClearanceResult.blocking) {
    failures.push(`gate ledger is blocked: ${gateLedgerClearanceResult.reason}`);
  } else if (!gateLedgerClearanceResult.cleared) {
    unverified.push(
      `live gate-sequence evidence is missing: ${gateLedgerClearanceResult.reason}`,
    );
  }

  const warnings = [];
  if (drc.warningCount) {
    warnings.push(
      `schematic ERC returned ${drc.warningCount} warning(s) and zero error groups`,
    );
  }
  warnings.push(...presentation.observations);
  warnings.push(...symbolPlacement.observations);

  const coverage = {
    requiredAxes: [
      "schematicDrc",
      "identityAndFootprints",
      "componentSelection",
      "presentationGeometry",
      "symbolPlacement",
      "gateSequence",
    ],
    checkedAxes: [
      "schematicDrc",
      "identityAndFootprints",
      "componentSelection",
      "presentationGeometry",
      "symbolPlacement",
      "gateSequence",
    ],
    unverifiedAxes: [
      ...(!componentSelectionEvidence.cleared ? ["componentSelection"] : []),
      ...(!presentation.available || presentation.requiresVisualReview
        ? ["presentationGeometry"]
        : []),
      ...(symbolPlacement.unresolved.length || symbolPlacement.requiresVisualReview
        ? ["symbolPlacement"]
        : []),
      ...(!gateLedgerClearanceResult.cleared ? ["gateSequence"] : []),
    ],
    notApplicable: [],
  };

  return {
    schemaVersion: 5,
    evidence: "RULE_CHECK",
    decision: failures.length
      ? DECISIONS.FAIL
      : unverified.length
        ? DECISIONS.UNVERIFIED
        : DECISIONS.PASS_WITH_EXCEPTIONS,
    fabricationRelease: false,
    manufacturingOutputsReviewed: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    kind: "schematic",
    source,
    generatedAt: new Date().toISOString(),
    design: {
      project: raw.project,
      document: raw.document,
      fingerprint: designFingerprint(raw),
      componentCount: (raw.components || []).length,
      wireCount: raw.wireCount || 0,
    },
    checks: {
      drc,
      designators,
      missingFootprints,
      componentSelectionEvidence,
      presentation,
      symbolPlacement,
      gateLedgerClearance: gateLedgerClearanceResult,
    },
    coverage,
    failures,
    unverified,
    warnings,
    limitations: [
      "A cleared component-selection evidence record proves traceability and exact metadata binding, not circuit correctness.",
      "DRC and metadata do not prove the circuit topology, derived values, ratings margin, pin mapping, or connector mating view.",
      "Presentation geometry screening does not replace exact-page visual review or justify drawing a literal power/ground loop.",
      "Symbol placement screening detects stacked poses, declared-page overrun, and crowding; it does not prove a readable functional partition, and EasyEDA exposes no sheet-size API to check a real drawing frame.",
      "Power integrity, protection, reset/boot states, clocks, and no-connect intent require schematic review.",
      "Unrouted nets, pin-map correctness, and manufacturing outputs are outside this baseline audit.",
    ],
  };
}

function analyzePcb(raw, options, source) {
  const tolerance = 0.05;
  const drc = summarizePcbDrcEvidence(raw, options);
  const designators = designatorIssues(raw.components || []);
  const layerById = new Map((raw.layers || []).map((layer) => [layer.id, layer]));
  const outlineLayerIds = new Set(
    (raw.layers || [])
      .filter(
        (layer) =>
          layer.id === raw.boardOutlineLayerId ||
          /board.*outline|outline.*board|板框/i.test(layer.name || ""),
      )
      .map((layer) => layer.id),
  );
  const outlineLines = (raw.lines || []).filter((line) => outlineLayerIds.has(line.layer));
  const outlineArcs = (raw.arcs || []).filter((arc) => outlineLayerIds.has(arc.layer));
  const routedLines = (raw.lines || []).filter((line) => line.net);
  const routedArcs = (raw.arcs || []).filter((arc) => arc.net);
  const routedStraightSegments = (raw.segments?.length
    ? raw.segments
    : routedLines.map((line) => ({ ...line, segmentKind: "line" })))
    .filter((segment) => segment.net && segment.segmentKind !== "arc");
  const nonStandardAngles = routedStraightSegments
    .filter((segment) => nearestFortyFiveDeviationDeg(segment) > 0.1)
    .map((line) => ({
      primitiveId: line.primitiveId,
      segmentKind: line.segmentKind || "line",
      net: line.net,
      layer: line.layer,
      layerName: layerById.get(line.layer)?.name || "",
      angleDeg: Number(
        ((Math.atan2(line.endY - line.startY, line.endX - line.startX) * 180) / Math.PI)
          .toFixed(3),
      ),
    }));
  const sharpRightAngleCorners = analyzeSharpRightAngleCorners(
    raw,
    routedStraightSegments,
    tolerance,
  );
  const routingLayerUsage = summarizeRoutingLayers(routedLines, layerById);
  const freeCopperIds = freeCopperPrimitiveIds(drcLeafErrors(raw.drc));
  const pours = (raw.pours || []).map((pour) =>
    analyzePourConnectivity(pour, freeCopperIds),
  );
  const validGroundPour = pours.some(
    (pour) => pour.net === options.groundNet && pour.passed,
  );
  const routingTopology = analyzeRoutingTopology(raw, options);

  const failures = [];
  if (!drc.passed) failures.push("PCB DRC did not pass");
  if (!outlineLines.length && !outlineArcs.length) {
    failures.push("no board-outline line or arc primitives were found");
  }
  if (designators.missing.length) failures.push("one or more PCB components lack designators");
  if (designators.duplicates.length) failures.push("duplicate PCB component designators exist");
  if (nonStandardAngles.length && !options.allowNonstandardAngle) {
    failures.push(
      `${nonStandardAngles.length} routed segment(s) are not 0/45/90 degrees`,
    );
  }
  if (
    sharpRightAngleCorners.count &&
    !options.allowSharpRightAngle
  ) {
    failures.push(
      `${sharpRightAngleCorners.count} unchamfered 90-degree routed corner(s) were found`,
    );
  }
  if (pours.some((pour) => !pour.passed)) {
    failures.push(
      "one or more copper pours are unfilled, have incomplete solid-fill ID evidence, or contain free copper",
    );
  }
  if (options.requireGroundPour && !validGroundPour) {
    failures.push(`no valid filled ${options.groundNet} pour was found`);
  }
  if (routingTopology.unexpectedCycles.length) {
    failures.push(
      `explicit routing cycle(s) found on net(s): ${routingTopology.unexpectedCycles.join(
        ", ",
      )}`,
    );
  }
  if (routingTopology.duplicateNets.length) {
    failures.push(
      `duplicate overlapping route edge(s) found on net(s): ${routingTopology.duplicateNets.join(
        ", ",
      )}`,
    );
  }

  const warnings = [];
  if (drc.passedWithExceptions) {
    warnings.push(
      `DRC native-netlist cache mismatch accepted only under manufacturing-netlist evidence: ${options.nativeNetlistCacheException.reason}`,
    );
  }
  const preserveSilosReadbackOverrides = pours.filter(
    (pour) => pour.preserveSilosStateIgnored,
  );
  if (preserveSilosReadbackOverrides.length) {
    warnings.push(
      `${preserveSilosReadbackOverrides.length} pour(s) report preserveSilos=true but were accepted from solid-fill IDs plus zero free-copper DRC evidence`,
    );
  }
  if (routedArcs.length) {
    warnings.push(
      `${routedArcs.length} routed arc(s) require visual geometry and manufacturability review`,
    );
  }
  if (!options.requireGroundPour && !validGroundPour) {
    warnings.push(`no valid filled ${options.groundNet} pour was found by design`);
  }
  if (!options.requireGroundPour && nonemptyString(options.exceptionNote)) {
    warnings.push(`ground-pour requirement waived: ${options.exceptionNote}`);
  }
  if (options.allowNonstandardAngle && nonemptyString(options.exceptionNote)) {
    warnings.push(`nonstandard-angle failure waived: ${options.exceptionNote}`);
  }
  if (
    options.allowSharpRightAngle &&
    sharpRightAngleCorners.count &&
    nonemptyString(options.exceptionNote)
  ) {
    warnings.push(`sharp-right-angle failure waived: ${options.exceptionNote}`);
  }
  if (routingTopology.allowedCycles.length) {
    warnings.push(
      `routing cycle exception for ${routingTopology.allowedCycles.join(
        ", ",
      )}: ${options.exceptionNote}`,
    );
  }
  const partialTopologyNets = routingTopology.nets
    .filter((item) => item.coverage !== "STRAIGHT_TRACK_AND_VIA_GRAPH")
    .map((item) => item.net);
  if (partialTopologyNets.length) {
    warnings.push(
      `routing-cycle coverage is partial for net(s) containing arcs: ${partialTopologyNets.join(
        ", ",
      )}`,
    );
  }
  const allNetNames = [
    ...(raw.netNames || []),
    ...(raw.lines || []).map((item) => item.net),
    ...(raw.arcs || []).map((item) => item.net),
    ...(raw.vias || []).map((item) => item.net),
    ...(raw.pours || []).map((item) => item.net),
  ].filter(Boolean);
  const fingerprint = designFingerprint(raw);
  const evidenceBindingFingerprint = constraintFingerprint({
    designFingerprint: fingerprint,
    drcRuleConfigurationName: drc.ruleBinding.name,
    drcRuleConfigurationFingerprint: drc.ruleBinding.fingerprint,
  });
  const highSpeedConstraintFingerprint = constraintFingerprint(
    options.highSpeedConstraintRecord,
  );
  const highSpeedDiscoveryResult = highSpeedDiscovery(allNetNames, {
    constraintRecord: options.highSpeedConstraintRecord,
  });
  const hintedHighSpeedNets = highSpeedDiscoveryResult.candidateNets;
  const hintedCrystalNets = crystalNetHints(allNetNames);
  const crystalClearance = hintedCrystalNets.length
    ? readCrystalClearanceReport(options.crystalAuditReport, {
        expectedProjectUuid: raw.project?.uuid,
        expectedDocumentUuid: raw.document?.uuid,
        expectedDesignFingerprint: fingerprint,
        requiredNets: hintedCrystalNets,
      })
    : { cleared: true, reason: "no crystal/clock net hints" };
  const highSpeedClearance = hintedHighSpeedNets.length
    ? readHighSpeedClearanceReport(options.highSpeedAuditReport, {
        expectedProjectUuid: raw.project?.uuid,
        expectedDocumentUuid: raw.document?.uuid,
        expectedDesignFingerprint: fingerprint,
        expectedConstraintFingerprint: highSpeedConstraintFingerprint,
        requiredNets: hintedHighSpeedNets,
      })
    : { cleared: true, reason: "no high-speed net hints" };
  const unverified = [];
  if (!drc.evidenceVerified) {
    unverified.push(
      `PCB DRC evidence is not closure-grade: ${drc.ruleBinding.reason}; ${drc.repeatability.reason}`,
    );
  }
  const testSource = /^(?:test|self-test)/.test(source?.kind || "");
  const placementClearance = testSource && !options.placementAuditRecord
    ? { cleared: true, blocking: false, reason: "unit-test fixture bypass" }
    : placementAuditClearance(options.placementAuditRecord, {
        projectUuid: raw.project?.uuid,
        documentUuid: raw.document?.uuid,
        designFingerprint: fingerprint,
      });
  if (placementClearance.blocking) {
    failures.push(`placement audit is blocked: ${placementClearance.reason}`);
  } else if (!placementClearance.cleared) {
    unverified.push(`placement/assembly closure is missing: ${placementClearance.reason}`);
  } else if (!testSource) {
    warnings.push(
      `placement/assembly closure is bound to the current PCB: ${options.placementAuditReport}`,
    );
  }
  const gateLedgerClearanceResult =
    testSource && !options.gateLedgerRecord
      ? { cleared: true, blocking: false, reason: "unit-test fixture bypass" }
      : gateLedgerClearance(options.gateLedgerRecord, {
          projectUuid: raw.project?.uuid,
        });
  if (gateLedgerClearanceResult.blocking) {
    failures.push(`gate ledger is blocked: ${gateLedgerClearanceResult.reason}`);
  } else if (!gateLedgerClearanceResult.cleared) {
    unverified.push(
      `live gate-sequence evidence is missing: ${gateLedgerClearanceResult.reason}`,
    );
  } else if (!testSource) {
    warnings.push(
      `gate ledger is bound to the current project: ${options.gateLedger}`,
    );
  }
  if (hintedCrystalNets.length && !crystalClearance.cleared) {
    unverified.push(
      `possible crystal/clock nets detected (${hintedCrystalNets.join(
        ", ",
      )}); supply --crystal-audit-report from a cleared crystal/clock audit (${
        crystalClearance.reason
      })`,
    );
    warnings.push(unverified[unverified.length - 1]);
  } else if (hintedCrystalNets.length) {
    warnings.push(
      `crystal/clock nets ${hintedCrystalNets.join(
        ", ",
      )} cleared by report: ${crystalClearance.reportPath}`,
    );
  }
  if (hintedHighSpeedNets.length && !highSpeedClearance.cleared) {
    unverified.push(
      `possible high-speed nets detected (${hintedHighSpeedNets.join(
        ", ",
      )}); supply --high-speed-audit-report from a non-failing cleared HS audit (${
        highSpeedClearance.reason
      })`,
    );
    warnings.push(unverified[unverified.length - 1]);
  } else if (hintedHighSpeedNets.length) {
    warnings.push(
      `high-speed nets ${hintedHighSpeedNets.join(
        ", ",
      )} cleared by report: ${highSpeedClearance.reportPath}`,
    );
  }

  const manufacturing = resolveManufacturingReview(options);
  if (!manufacturing.reviewed) {
    warnings.push(manufacturing.reason);
  }

  let decision;
  if (failures.length) decision = DECISIONS.FAIL;
  else if (unverified.length) decision = DECISIONS.UNVERIFIED;
  else decision = DECISIONS.PASS_WITH_EXCEPTIONS;

  const coverage = {
    requiredAxes: [
      "detailedDrc",
      "routingGeometry",
      "routingTopology",
      "copperConnectivity",
      "boardMechanicalContainment",
      "placementClosure",
      "gateSequence",
      "specializedTechnology",
    ],
    checkedAxes: [
      "detailedDrc",
      "routingGeometry",
      "routingTopology",
      "copperConnectivity",
      "boardMechanicalContainment",
      "placementClosure",
      "gateSequence",
      "specializedTechnology",
    ],
    unverifiedAxes: [
      ...(!drc.evidenceVerified ? ["detailedDrc"] : []),
      ...(partialTopologyNets.length ? ["routingTopology"] : []),
      ...(!placementClearance.cleared
        ? ["boardMechanicalContainment", "placementClosure"]
        : []),
      ...(!gateLedgerClearanceResult.cleared ? ["gateSequence"] : []),
      ...(hintedCrystalNets.length && !crystalClearance.cleared
        ? ["specializedTechnology"]
        : []),
      ...(hintedHighSpeedNets.length && !highSpeedClearance.cleared
        ? ["specializedTechnology"]
        : []),
    ],
    notApplicable: [
      ...(!hintedCrystalNets.length && !hintedHighSpeedNets.length
        ? ["specializedTechnology"]
        : []),
      ...(!manufacturing.reviewed ? ["manufacturingOutputs"] : []),
    ],
  };

  return {
    schemaVersion: 9,
    evidence: "RULE_CHECK",
    decision,
    fabricationRelease: false,
    manufacturingOutputsReviewed: Boolean(manufacturing.reviewed),
    notAFabricationRelease: notAFabricationReleaseMessage(),
    kind: "pcb",
    source,
    generatedAt: new Date().toISOString(),
    design: {
      project: raw.project,
      document: raw.document,
      fingerprint,
      evidenceBindingFingerprint,
      netCount: new Set(allNetNames).size,
      layerCount: (raw.layers || []).length,
      componentCount: (raw.components || []).length,
      routedLineCount: routedLines.length,
      routedArcCount: routedArcs.length,
      viaCount: raw.viaCount || 0,
      pourCount: pours.length,
      outlinePrimitiveCount: outlineLines.length + outlineArcs.length,
    },
    constraints: {
      groundNet: options.groundNet,
      requireGroundPour: options.requireGroundPour,
      allowNonstandardAngle: options.allowNonstandardAngle,
      allowSharpRightAngle: options.allowSharpRightAngle,
      allowRoutingCycleNets: options.allowRoutingCycleNets,
      exceptionNote: options.exceptionNote || null,
      crystalAuditReport: options.crystalAuditReport || null,
      highSpeedConstraints: options.highSpeedConstraints || null,
      highSpeedConstraintFingerprint,
      highSpeedAuditReport: options.highSpeedAuditReport || null,
      netlistCompareReport: options.netlistCompareReport || null,
      placementAuditReport: options.placementAuditReport || null,
      gateLedgerReport: options.gateLedger || null,
      nativeNetlistCacheException: options.nativeNetlistCacheException || null,
      drcRuleBinding: {
        captured: drc.ruleBinding.captured,
        stable: drc.ruleBinding.stable,
        name: drc.ruleBinding.name,
        fingerprint: drc.ruleBinding.fingerprint,
      },
    },
    checks: {
      drc,
      designators,
      nonStandardAngles,
      sharpRightAngleCorners,
      routingLayerUsage,
      routingTopology,
      pours,
      validGroundPour,
      hintedCrystalNets,
      crystalClearance,
      hintedHighSpeedNets,
      highSpeedDiscovery: highSpeedDiscoveryResult,
      highSpeedClearance,
      placementClearance,
      gateLedgerClearance: gateLedgerClearanceResult,
      manufacturing,
      unverified,
      outline: {
        lineCount: outlineLines.length,
        arcCount: outlineArcs.length,
        candidateLayerIds: [...outlineLayerIds],
      },
    },
    coverage,
    failures,
    warnings,
    limitations: [
      "Native outline topology and material containment are accepted only through the bound schema-3 placement audit; the baseline collector alone does not prove them.",
      ...routingTopology.limitations,
      ...sharpRightAngleCorners.limitations,
      "Unrouted connections and netlist equivalence must be confirmed in EasyEDA.",
      "The bound placement audit checks declared geometry and interface policy but does not replace enclosure, assembler, or process evidence.",
      "Manufacturing outputs, BOM, and pick-and-place files require separate human-attested review.",
      "Crystal electrical values, oscillator margin, ground/keepout policy, and noise coupling require datasheet-backed manual review.",
      "High-speed/impedance claims require easyeda_high_speed_audit.mjs and cannot be closed by this baseline audit alone.",
    ],
  };
}

function analyze(raw, options, source) {
  if (raw.kind === "schematic") return analyzeSchematic(raw, source, options);
  if (raw.kind === "pcb") return analyzePcb(raw, options, source);
  throw new Error(`unsupported audit kind: ${raw.kind}`);
}

function bindPcbDrcEvidence(
  raw,
  {
    results = [raw.drc, raw.drc, raw.drc],
    ruleBefore = {
      name: "Self Test Two Layer Rules",
      configuration: { clearance: { trackToTrack: 0.1016 } },
    },
    ruleAfter = ruleBefore,
  } = {},
) {
  const samples = [
    { id: "silent-1", userInterface: false },
    { id: "silent-2", userInterface: false },
    { id: "visible-final", userInterface: true },
  ].map((sample, index) => ({
    ...sample,
    strict: true,
    includeVerboseError: true,
    result: results[index],
  }));
  raw.drc = results.at(-1);
  raw.drcEvidence = {
    schemaVersion: 1,
    ruleBefore,
    ruleAfter,
    samples,
  };
  return raw;
}

function pcbFixture() {
  return bindPcbDrcEvidence({
    kind: "pcb",
    project: { uuid: "self-test", name: "Self Test" },
    document: { uuid: "pcb", name: "PCB", documentType: 3 },
    boardOutlineLayerId: 11,
    layers: [
      { id: 1, name: "Top Layer" },
      { id: 2, name: "Bottom Layer" },
      { id: 11, name: "Renamed Mechanical Contour" },
    ],
    components: [
      { primitiveId: "u1", designator: "U1", layer: 1, x: 100, y: 100 },
    ],
    lines: [
      {
        primitiveId: "outline1",
        net: "",
        layer: 11,
        startX: 0,
        startY: 0,
        endX: 1000,
        endY: 0,
      },
      {
        primitiveId: "track1",
        net: "3V3",
        layer: 1,
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 0,
      },
    ],
    arcs: [],
    viaCount: 0,
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
        solidFillIds: ["fill1"],
      },
    ],
    drc: [],
  });
}

function schematicPageEnvelopeFixture() {
  return validateSchematicPageEnvelope(
    {
      kind: "easyeda-schematic-page-envelope",
      schemaVersion: 1,
      unit: "10mil",
      documentUuid: "sch",
      source: "self-test fixture drawable page area",
      envelope: { minX: 0, minY: 0, maxX: 1000, maxY: 800 },
    },
    null,
  );
}

function schematicFixture() {
  const schematicWires = Array.from({ length: 12 }, (_, index) => ({
    primitiveId: `wire-${index + 1}`,
    net: index % 2 ? "GND" : "+3V3",
    line: [0, index * 20, 40, index * 20, 40, index * 20 + 20],
  }));
  // One deliberately posed symbol with a bounded extent, so the placement screen
  // has a CLEAR baseline without adding a second part that would need its own
  // component-selection evidence.
  return {
    kind: "schematic",
    project: { uuid: "self-test", name: "Self Test" },
    document: { uuid: "sch", name: "Schematic", documentType: 1 },
    components: [
      {
        primitiveId: "u1",
        designator: "U1",
        name: "MCU",
        addIntoPcb: true,
        footprint: { libraryUuid: "lib", uuid: "fp", name: "LQFP48" },
        x: 200,
        y: 200,
        rotation: 0,
        bbox: { minX: 160, minY: 160, maxX: 240, maxY: 240 },
      },
    ],
    wireCount: schematicWires.length,
    schematicAnnotations: [],
    schematicWires,
    drc: [],
  };
}

async function main() {
  try {
    const options = await loadSchematicPageEnvelope(
      await loadGateLedgerReport(
        await loadPlacementAuditReport(
          await loadComponentEvidenceRecord(
            await loadNetlistCompareReport(
              await loadHighSpeedConstraintRecord(
                parseArgs(process.argv.slice(2)),
              ),
            ),
          ),
        ),
      ),
    );
    if (options.selfTest) {
      const pcb = analyze(pcbFixture(), options, { kind: "self-test" });
      const schematicOptions = {
        ...options,
        schematicPageEnvelopeRecord:
          options.schematicPageEnvelopeRecord || schematicPageEnvelopeFixture(),
      };
      const schematic = analyze(schematicFixture(), schematicOptions, {
        kind: "self-test",
      });
      const failingPcbFixture = pcbFixture();
      failingPcbFixture.lines.push({
        primitiveId: "bad-angle",
        net: "SIGNAL",
        layer: 1,
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 37,
      });
      const failingSchematicFixture = schematicFixture();
      failingSchematicFixture.components[0].footprint = null;
      // Stacked symbols plus one symbol drawn past the declared page bound: the
      // two blocking placement signatures this screen exists for.
      const failingPlacementFixture = schematicFixture();
      failingPlacementFixture.components.push(
        {
          // Same pose as U1: the stacked-symbol signature.
          primitiveId: "c1",
          designator: "C1",
          name: "100nF",
          addIntoPcb: true,
          footprint: { libraryUuid: "lib", uuid: "fp-c", name: "C0402" },
          x: failingPlacementFixture.components[0].x,
          y: failingPlacementFixture.components[0].y,
          rotation: 0,
          bbox: { ...failingPlacementFixture.components[0].bbox },
        },
        {
          // Past the declared drawable page bound.
          primitiveId: "r1",
          designator: "R1",
          name: "10k",
          addIntoPcb: true,
          footprint: { libraryUuid: "lib", uuid: "fp-r", name: "R0402" },
          x: 1400,
          y: 600,
          rotation: 0,
          bbox: { minX: 1380, minY: 580, maxX: 1420, maxY: 620 },
        },
      );
      const cycleFixture = pcbFixture();
      cycleFixture.lines.push(
        {
          primitiveId: "cycle-1",
          net: "SIGNAL",
          layer: 1,
          startX: 200,
          startY: 200,
          endX: 300,
          endY: 200,
        },
        {
          primitiveId: "cycle-2",
          net: "SIGNAL",
          layer: 1,
          startX: 300,
          startY: 200,
          endX: 300,
          endY: 300,
        },
        {
          primitiveId: "cycle-3",
          net: "SIGNAL",
          layer: 1,
          startX: 300,
          startY: 300,
          endX: 200,
          endY: 300,
        },
        {
          primitiveId: "cycle-4",
          net: "SIGNAL",
          layer: 1,
          startX: 200,
          startY: 300,
          endX: 200,
          endY: 200,
        },
      );
      const failingPcb = analyze(failingPcbFixture, options, {
        kind: "self-test-negative",
      });
      const cyclePcb = analyze(cycleFixture, options, {
        kind: "self-test-cycle-negative",
      });
      const failingSchematic = analyze(failingSchematicFixture, schematicOptions, {
        kind: "self-test-negative",
      });
      const failingPlacement = analyze(
        failingPlacementFixture,
        schematicOptions,
        { kind: "self-test-placement-negative" },
      );
      const hsHintFixture = pcbFixture();
      hsHintFixture.lines.push({
        primitiveId: "usb3",
        net: "USB3_SSRX_P",
        layer: 1,
        startX: 0,
        startY: 20,
        endX: 100,
        endY: 20,
      });
      const hsHint = analyze(hsHintFixture, options, { kind: "self-test-hs-hint" });
      if (
        pcb.decision !== DECISIONS.PASS_WITH_EXCEPTIONS ||
        schematic.decision !== DECISIONS.UNVERIFIED ||
        failingPcb.decision !== DECISIONS.FAIL ||
        cyclePcb.decision !== DECISIONS.FAIL ||
        cyclePcb.checks.routingTopology.unexpectedCycles[0] !== "SIGNAL" ||
        failingSchematic.decision !== DECISIONS.FAIL ||
        schematic.checks.symbolPlacement.status !== "CLEAR" ||
        failingPlacement.decision !== DECISIONS.FAIL ||
        failingPlacement.checks.symbolPlacement.status !==
          "DEGRADED_SYMBOL_PLACEMENT" ||
        failingPlacement.checks.symbolPlacement.coincidentPoseGroups.length !==
          1 ||
        failingPlacement.checks.symbolPlacement.envelopeViolations.length !==
          1 ||
        pcb.fabricationRelease !== false ||
        hsHint.decision !== DECISIONS.UNVERIFIED ||
        !hsHint.checks.hintedHighSpeedNets.includes("USB3_SSRX_P")
      ) {
        throw new Error("self-test pass/fail fixtures produced unexpected decisions");
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            pcb,
            schematic,
            negativeTests: {
              pcbDecision: failingPcb.decision,
              cyclePcbDecision: cyclePcb.decision,
              cycleNets: cyclePcb.checks.routingTopology.unexpectedCycles,
              schematicDecision: failingSchematic.decision,
              schematicPlacementDecision: failingPlacement.decision,
              schematicPlacementStatus:
                failingPlacement.checks.symbolPlacement.status,
            },
            highSpeedHint: {
              nets: hsHint.checks.hintedHighSpeedNets,
              decision: hsHint.decision,
            },
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

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
  analyzePcb,
  analyzeRoutingTopology,
  analyzeSchematic,
  analyzeSchematicPlacement,
  analyzeSchematicPresentation,
  applyDecisionExitCode,
  bindPcbDrcEvidence,
  canonicalDrcLeaves,
  collectorCode,
  drcRuleBinding,
  gateLedgerClearance,
  loadGateLedgerReport,
  loadHighSpeedConstraintRecord,
  loadNetlistCompareReport,
  loadComponentEvidenceRecord,
  loadPlacementAuditReport,
  loadSchematicPageEnvelope,
  placementAuditClearance,
  parseArgs,
  pcbFixture,
  resolveWindow,
  schematicFixture,
  schematicPageEnvelopeFixture,
  summarizePcbDrcEvidence,
  validateNetlistCompareExceptionArtifact,
  validateSchematicPageEnvelope,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

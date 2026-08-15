#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  designFingerprint,
  fetchJson,
  findBridge,
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
  resolveWindow,
} from "../lib/audit_common.mjs";
import { collectorCode } from "./easyeda_design_audit.mjs";
import { analyzePlacementGeometry } from "../lib/placement_geometry.mjs";

const STATUS = Object.freeze({
  CLEAR: "PLACEMENT_CLEAR_FOR_ROUTING",
  BLOCKED: "BLOCKED",
  UNRESOLVED: "UNRESOLVED",
  STALE: "STALE",
});

const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  BLOCKED: 2,
  UNRESOLVED: 3,
  STALE: 4,
});

const REQUIRED_COVERAGE_AXES = Object.freeze([
  "boardMechanicalContainment",
  "viaPadGeometry",
  "componentOccupancy",
  "criticalPlacementZones",
  "humanInterfaces",
  "externalInterfacesAndBom",
]);

function usage() {
  return `Usage:
  node scripts/audits/easyeda_placement_audit.mjs --layout-constraints FILE \\
    --constraint-report FILE --output FILE [options]

  node scripts/audits/easyeda_placement_audit.mjs --print-fingerprint

Options:
  --layout-constraints FILE   Exact-revision layout-constraints.json
  --constraint-report FILE    CLEARED_FOR_PLACEMENT constraint-lint report
  --print-fingerprint         Read the bound PCB and print its design
                              fingerprint, then exit; authors no evidence and
                              needs no constraint inputs. Use it to set the
                              layout-constraints revision on an existing board.
  --bridge-port PORT          Use one port instead of scanning 49620-49629
  --window-id ID              Target a registered EasyEDA window
  --output FILE               New relative JSON evidence path under cwd
  --force                     Overwrite output; prohibited for release evidence
  --self-test                 Run deterministic placement geometry tests
  --help                      Show this help

Exit codes: 0=PLACEMENT_CLEAR_FOR_ROUTING, 1=tool error, 2=BLOCKED,
3=UNRESOLVED, 4=STALE. --print-fingerprint exits 0 on success. No status
authorizes fabrication or ordering.
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
    layoutConstraints: undefined,
    constraintReport: undefined,
    bridgePort: undefined,
    windowId: undefined,
    output: undefined,
    force: false,
    selfTest: false,
    printFingerprint: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--layout-constraints") options.layoutConstraints = next();
    else if (option === "--constraint-report") options.constraintReport = next();
    else if (option === "--bridge-port") options.bridgePort = positiveInteger(next(), option);
    else if (option === "--window-id") options.windowId = next();
    else if (option === "--output") options.output = next();
    else if (option === "--force") options.force = true;
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--print-fingerprint") options.printFingerprint = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  // --print-fingerprint is a read-only lookup, not an audit, so it must not
  // demand the very constraint record whose revision it exists to supply.
  if (options.printFingerprint) {
    // Reject flags this mode ignores. Silently accepting --output or --force
    // would let a caller believe they had written evidence that never exists.
    for (const [field, option] of [
      [options.selfTest, "--self-test"],
      [options.output, "--output"],
      [options.force, "--force"],
      [options.layoutConstraints, "--layout-constraints"],
      [options.constraintReport, "--constraint-report"],
    ]) {
      if (field) {
        throw new Error(
          `--print-fingerprint reads no evidence and writes none; remove ${option}`,
        );
      }
    }
  }
  if (!options.selfTest && !options.printFingerprint) {
    for (const [field, option] of [
      [options.layoutConstraints, "--layout-constraints"],
      [options.constraintReport, "--constraint-report"],
      [options.output, "--output"],
    ]) {
      if (!field) throw new Error(`${option} is required`);
    }
    if (options.force) {
      throw new Error("--force is prohibited for placement-closure evidence; use a new path");
    }
  }
  return options;
}

async function loadJsonWithBytes(file, label) {
  const bytes = await readFile(file);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`unable to parse ${label} ${file}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  return { value, bytes };
}

async function loadConstraintEvidence(options) {
  const recordLoaded = await loadJsonWithBytes(options.layoutConstraints, "layout constraints");
  const reportLoaded = await loadJsonWithBytes(options.constraintReport, "constraint report");
  const record = recordLoaded.value;
  const report = reportLoaded.value;
  const fingerprint = `sha256:${createHash("sha256").update(recordLoaded.bytes).digest("hex")}`;
  const issues = [];
  if (report.kind !== "easyeda-constraint-consistency") {
    issues.push("constraint report kind is not easyeda-constraint-consistency");
  }
  if (report.consistent !== true || report.gateStatus !== "CLEARED_FOR_PLACEMENT") {
    issues.push("constraint report does not prove CLEARED_FOR_PLACEMENT");
  }
  if (report.constraintRecordFingerprint !== fingerprint) {
    issues.push("constraint report fingerprint does not match layout-constraints bytes");
  }
  if (report.revision !== record.revision) {
    issues.push("constraint report revision differs from layout-constraints revision");
  }
  if (issues.length) throw new Error(issues.join("; "));
  return {
    record,
    report,
    recordFingerprint: fingerprint,
    recordPath: path.resolve(options.layoutConstraints),
    reportPath: path.resolve(options.constraintReport),
  };
}

function summarizeFindings(checks) {
  const failures = [];
  const unverified = [];
  if (checks.boardContainment.violations.length) {
    failures.push(
      `${checks.boardContainment.violations.length} board-boundary containment or native-outline violation(s)`,
    );
  }
  if (checks.viaPad.violations.length) {
    failures.push(
      `${checks.viaPad.violations.length} ordinary via/pad clearance or overlap violation(s)`,
    );
  }
  if (checks.componentPlacement.exactConflicts.length) {
    failures.push(
      `${checks.componentPlacement.exactConflicts.length} sourced courtyard conflict(s)`,
    );
  }
  if (checks.componentPlacement.ownPadOutsideCourtyard.length) {
    failures.push(
      `${checks.componentPlacement.ownPadOutsideCourtyard.length} live pad(s) extend outside their owning sourced courtyard`,
    );
  }
  if (checks.componentPlacement.crossComponentPadConflicts.length) {
    failures.push(
      `${checks.componentPlacement.crossComponentPadConflicts.length} foreign-component pad/pad overlap(s)`,
    );
  }
  if (checks.componentPlacement.crossComponentPadClearanceViolations.length) {
    failures.push(
      `${checks.componentPlacement.crossComponentPadClearanceViolations.length} foreign-component pad clearance violation(s)`,
    );
  }
  if (checks.componentPlacement.padToForeignCourtyardConflicts.length) {
    failures.push(
      `${checks.componentPlacement.padToForeignCourtyardConflicts.length} live pad/foreign-courtyard conflict(s)`,
    );
  }
  if (checks.componentPlacement.criticalZoneViolations.length) {
    failures.push(
      `${checks.componentPlacement.criticalZoneViolations.length} sourced critical-placement-zone intrusion(s)`,
    );
  }
  if (checks.humanInterfaces.violations.length) {
    failures.push(`${checks.humanInterfaces.violations.length} human-interface placement violation(s)`);
  }
  if (checks.interfacesAndBom.failures.length) {
    failures.push(`${checks.interfacesAndBom.failures.length} interface/BOM policy violation(s)`);
  }
  if (checks.viaPad.unsupportedPads.length) {
    unverified.push(
      `${checks.viaPad.unsupportedPads.length} pad shape(s) are unsupported for exact via clearance and component occupancy`,
    );
  }
  if (checks.viaPad.unsupportedVias.length) {
    unverified.push(
      `${checks.viaPad.unsupportedVias.length} via(s) lack exact finite geometry for pad-clearance checks`,
    );
  }
  if (checks.componentPlacement.unsupportedPadOccupancy.length) {
    unverified.push(
      `${checks.componentPlacement.unsupportedPadOccupancy.length} live pad shape(s) are unsupported for exact component occupancy`,
    );
  }
  if (checks.componentPlacement.missingEnvelopeDesignators?.length) {
    unverified.push(
      `${checks.componentPlacement.missingEnvelopeDesignators.length} component(s) lack sourced body/courtyard envelopes`,
    );
  }
  if (checks.componentPlacement.invalidEnvelopes.length) {
    unverified.push(
      `${checks.componentPlacement.invalidEnvelopes.length} assembly envelope(s) lack a valid sourced courtyard`,
    );
  }
  if (checks.componentPlacement.missingOppositeSideCourtyardDesignators.length) {
    unverified.push(
      `${checks.componentPlacement.missingOppositeSideCourtyardDesignators.length} through-hole component(s) lack sourced opposite-side courtyard geometry`,
    );
  }
  if (checks.componentPlacement.missingPadstackProjectionEvidence.length) {
    unverified.push(
      `${checks.componentPlacement.missingPadstackProjectionEvidence.length} through-hole/multilayer pad(s) lack sourced maximum copper projection evidence`,
    );
  }
  if (checks.componentPlacement.unownedPads.length) {
    unverified.push(
      `${checks.componentPlacement.unownedPads.length} live pad(s) cannot be bound to an owning component`,
    );
  }
  if (checks.componentPlacement.componentIdentityConflicts.length) {
    unverified.push(
      `${checks.componentPlacement.componentIdentityConflicts.length} live component identity conflict(s) prevent exact pad/envelope binding`,
    );
  }
  if (checks.componentPlacement.unresolvedBboxCandidates.length) {
    unverified.push(
      `${checks.componentPlacement.unresolvedBboxCandidates.length} EasyEDA BBox intersection candidate(s) lack exact pair coverage`,
    );
  }
  if (checks.componentPlacement.criticalZoneUnverified.length) {
    unverified.push(
      `${checks.componentPlacement.criticalZoneUnverified.length} critical-zone result(s) rely on missing or screen-only geometry`,
    );
  }
  if (checks.humanInterfaces.unverified.length) {
    unverified.push(
      `${checks.humanInterfaces.unverified.length} human-interface group(s) lack access evidence`,
    );
  }
  if (checks.interfacesAndBom.unverified.length) {
    unverified.push(
      `${checks.interfacesAndBom.unverified.length} external interface(s) remain undeclared or unverified`,
    );
  }
  if (checks.boardContainment.unverified.length) {
    unverified.push(
      `${checks.boardContainment.unverified.length} board-boundary identity or geometry result(s) remain unverified`,
    );
  }
  return { failures, unverified };
}

function coverageForChecks(checks) {
  const unverifiedAxes = [];
  if (checks.boardContainment.unverified.length) {
    unverifiedAxes.push("boardMechanicalContainment");
  }
  if (checks.viaPad.unsupportedPads.length || checks.viaPad.unsupportedVias.length) {
    unverifiedAxes.push("viaPadGeometry");
  }
  if (
    checks.componentPlacement.unsupportedPadOccupancy.length ||
    checks.componentPlacement.unownedPads.length ||
    checks.componentPlacement.componentIdentityConflicts.length ||
    checks.componentPlacement.invalidEnvelopes.length ||
    checks.componentPlacement.missingEnvelopeDesignators.length ||
    checks.componentPlacement.missingOppositeSideCourtyardDesignators.length ||
    checks.componentPlacement.missingPadstackProjectionEvidence.length ||
    checks.componentPlacement.unresolvedBboxCandidates.length
  ) unverifiedAxes.push("componentOccupancy");
  if (checks.componentPlacement.criticalZoneUnverified.length) {
    unverifiedAxes.push("criticalPlacementZones");
  }
  if (checks.humanInterfaces.unverified.length) unverifiedAxes.push("humanInterfaces");
  if (checks.interfacesAndBom.unverified.length) unverifiedAxes.push("externalInterfacesAndBom");
  return {
    requiredAxes: [...REQUIRED_COVERAGE_AXES],
    checkedAxes: [...REQUIRED_COVERAGE_AXES],
    unverifiedAxes: [...new Set(unverifiedAxes)],
    notApplicable: [],
  };
}

/**
 * Read-only fingerprint lookup. The constraint record's `revision` must equal
 * the live PCB fingerprint, but every audit that computes the fingerprint also
 * requires that record, so authoring one for an already-routed board was
 * circular. This resolves the circle and nothing else: it reads no constraint
 * input, writes no evidence, and closes no gate.
 */
function designFingerprintLookup(raw) {
  if (raw?.kind !== "pcb") {
    throw new Error("fingerprint lookup requires an active PCB document");
  }
  return {
    schemaVersion: 1,
    kind: "easyeda-design-fingerprint",
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    project: raw.project,
    document: raw.document,
    fingerprint: designFingerprint(raw),
    componentCount: (raw.components || []).length,
    padCount: (raw.pads || []).length,
    viaCount: (raw.vias || []).length,
    usage:
      "Copy fingerprint into layout-constraints.revision. This value identifies " +
      "the current geometry only; it is not placement, constraint, or review evidence.",
  };
}

// A record authored before placement constrains the layout. One reconstructed
// afterwards may instead describe it, in which case the gate can only confirm
// itself. That difference is not decidable from geometry, so the record must
// declare it and the report must carry it forward for the human reviewer.
const CONSTRAINT_BASIS = Object.freeze(["AUTHORED_BEFORE_PLACEMENT", "RECONSTRUCTED"]);

function analyzePlacement(raw, constraintEvidence, source = { kind: "offline" }) {
  if (raw.kind !== "pcb") throw new Error("placement audit requires an active PCB document");
  const fingerprint = designFingerprint(raw);
  const checks = analyzePlacementGeometry(raw, constraintEvidence.record);
  const findings = summarizeFindings(checks);
  const coverage = coverageForChecks(checks);
  const stale = [];
  if (constraintEvidence.record.revision !== fingerprint) {
    stale.push(
      `layout-constraints revision ${constraintEvidence.record.revision || "<missing>"} does not match PCB fingerprint ${fingerprint}`,
    );
  }
  const declaredBasis = constraintEvidence.record.constraintBasis;
  if (!CONSTRAINT_BASIS.includes(declaredBasis)) {
    findings.unverified.push(
      `layout-constraints constraintBasis must be one of ${CONSTRAINT_BASIS.join(", ")}`,
    );
  } else if (declaredBasis === "RECONSTRUCTED") {
    findings.unverified.push(
      "constraint basis was reconstructed after placement; a human must confirm " +
        "each courtyard and clearance came from its real source rather than from " +
        "the reviewed geometry",
    );
  }
  let status = STATUS.CLEAR;
  if (stale.length) status = STATUS.STALE;
  else if (findings.failures.length) status = STATUS.BLOCKED;
  else if (findings.unverified.length) status = STATUS.UNRESOLVED;
  return {
    schemaVersion: 3,
    kind: "easyeda-placement-audit",
    status,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    generatedAt: new Date().toISOString(),
    source,
    design: {
      project: raw.project,
      document: raw.document,
      fingerprint,
      componentCount: (raw.components || []).length,
      padCount: (raw.pads || []).length,
      viaCount: (raw.vias || []).length,
    },
    constraints: {
      revision: constraintEvidence.record.revision,
      basis: CONSTRAINT_BASIS.includes(declaredBasis) ? declaredBasis : null,
      recordFingerprint: constraintEvidence.recordFingerprint,
      recordPath: constraintEvidence.recordPath,
      consistencyReportPath: constraintEvidence.reportPath,
      consistencyGateStatus: constraintEvidence.report.gateStatus,
    },
    checks,
    coverage,
    failures: findings.failures,
    unverified: findings.unverified,
    stale,
    limitations: [
      "EasyEDA component BBox includes non-authoritative footprint graphics and is only a collision screen.",
      "A clear result requires a sourced assembly courtyard for every component and proves every supported live pad is contained by its owner's courtyard; silkscreen is not accepted.",
      "Cross-component occupancy checks compare sourced courtyards plus live pad copper, including through-hole pads across both sides.",
      "Board containment compares saved/reopened native outline primitives with every supported live pad, sourced courtyard, and critical placement zone; declared edge overhangs require separate evidence.",
      "Ellipse and oblong pad clearance uses a conservative polygon approximation; unsupported shapes remain unverified.",
      "The audit does not prove enclosure, cable, finger/tool, solder fillet, paste, thermal, or fabricator capability without the referenced evidence.",
      "Run against the saved/reopened PCB; a live unsaved editor state cannot close exact-revision evidence.",
    ],
  };
}

function exitCode(status) {
  if (status === STATUS.CLEAR) return EXIT.OK;
  if (status === STATUS.BLOCKED) return EXIT.BLOCKED;
  if (status === STATUS.UNRESOLVED) return EXIT.UNRESOLVED;
  if (status === STATUS.STALE) return EXIT.STALE;
  return EXIT.ERROR;
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

function fixture() {
  return {
    kind: "pcb",
    project: { uuid: "placement-project", name: "Placement Test" },
    document: { uuid: "placement-pcb", name: "PCB", documentType: 3 },
    boardOutlineLayerId: 11,
    layers: [{ id: 1, name: "Top Layer" }, { id: 11, name: "Board Outline" }],
    netNames: ["EN", "GND"],
    components: [
      {
        primitiveId: "sw1",
        designator: "SW1",
        name: "BUTTON",
        manufacturerPartNumber: "BUTTON-1",
        footprint: { uuid: "fp-sw", name: "SW-SMD" },
        layer: 1,
        x: 0,
        y: 0,
        rotation: 0,
        bbox: { minX: -50, minY: -40, maxX: 50, maxY: 40 },
      },
      {
        primitiveId: "j1",
        designator: "J1",
        name: "HEADER",
        manufacturerPartNumber: "HDR-102",
        footprint: { uuid: "fp-j", name: "HDR-TH_2P" },
        model3D: { uuid: "model-j", name: "HDR-M" },
        layer: 1,
        x: 300,
        y: 0,
        rotation: 0,
        bbox: { minX: 270, minY: -30, maxX: 330, maxY: 30 },
      },
    ],
    pads: [
      {
        primitiveId: "sw1-pad1",
        parentComponentPrimitiveId: "sw1",
        designator: "SW1",
        padNumber: "1",
        net: "EN",
        layer: 1,
        x: 20,
        y: 0,
        rotation: 0,
        pad: ["RECT", 40, 60, 0],
      },
    ],
    lines: [],
    arcs: [],
    polylines: [
      {
        primitiveId: "outline-main",
        layer: 11,
        net: "",
        locked: true,
        closed: true,
        points: [[-200, -200], [700, -200], [700, 200], [-200, 200], [-200, -200]],
      },
    ],
    segments: [],
    vias: [{ primitiveId: "via-en", net: "EN", x: 80, y: 0, diameter: 24, holeDiameter: 12 }],
    pours: [],
  };
}

function constraintFixture(raw) {
  return {
    revision: designFingerprint(raw),
    constraintBasis: "AUTHORED_BEFORE_PLACEMENT",
    boardBoundary: {
      binding: "LIVE_NATIVE",
      source: "saved/reopened native board-outline readback",
      outlineLayerId: 11,
      outerContourPrimitiveId: "outline-main",
      cutoutPrimitiveIds: [],
      requireLocked: true,
      edgeRelations: [],
    },
    assembly: {
      foreignPadCopperClearanceMm: 0.1524,
      foreignPadCopperClearanceSource: "fabricator copper clearance rule revision 1",
    },
    routingGeometry: {
      standardVia: {
        outerDiameterMm: 0.6096,
        holeDiameterMm: 0.3048,
        viaToPadCopperClearanceMm: 0.1524,
      },
    },
    assemblyEnvelopes: [
      {
        designator: "SW1",
        source: "button land pattern plus assembler spacing rule",
        courtyard: { type: "RECT", widthMil: 80, heightMil: 60, coordinates: "COMPONENT_LOCAL" },
      },
      {
        designator: "J1",
        source: "header land pattern plus assembler spacing rule",
        courtyard: { type: "RECT", widthMil: 50, heightMil: 50, coordinates: "COMPONENT_LOCAL" },
      },
    ],
    criticalPlacementZones: [],
    specialViaConstructions: [],
    humanInterfaceGroups: [
      {
        id: "reset-control",
        designators: ["SW1"],
        decision: "SEPARATE_WITH_RATIONALE",
        rationale: "single control",
        accessEvidenceArtifact: "access.json",
      },
    ],
    externalInterfaces: [
      {
        designator: "J1",
        function: "power",
        boardGender: "MALE",
        matingPart: "female cable",
        orientation: "vertical",
        populated: true,
        rationale: "test fixture",
        orderableMpn: "HDR-102",
        expectedFootprintName: "HDR-TH_2P",
        expectedModel3dUuid: "model-j",
      },
    ],
    bomNormalizationPolicy: {
      passives: { preferredFootprintsByPrefix: {}, exceptions: [] },
      connectors: {
        requireAllJDesignators: true,
        preferredManufacturerSeries: ["HDR-"],
        exceptions: [],
      },
    },
  };
}

function evidenceFixture(record) {
  return {
    record,
    report: { gateStatus: "CLEARED_FOR_PLACEMENT" },
    recordFingerprint: "sha256:self-test",
    recordPath: "layout-constraints.json",
    reportPath: "constraint-report.json",
  };
}

function selfTest() {
  const clearRaw = fixture();
  const clearRecord = constraintFixture(clearRaw);
  const clear = analyzePlacement(clearRaw, evidenceFixture(clearRecord), { kind: "self-test" });
  if (clear.status !== STATUS.CLEAR) {
    throw new Error(`clear fixture returned ${clear.status}: ${JSON.stringify(clear.unverified)}`);
  }

  const outsideRaw = structuredClone(clearRaw);
  outsideRaw.components[0].y = 190;
  const outsideRecord = constraintFixture(outsideRaw);
  const outside = analyzePlacement(outsideRaw, evidenceFixture(outsideRecord), { kind: "self-test" });
  if (
    outside.status !== STATUS.BLOCKED ||
    outside.checks.boardContainment.courtyardOutsideBoard.length !== 1
  ) {
    throw new Error("courtyard outside the native board outline did not block placement");
  }

  const esp32c3Raw = structuredClone(clearRaw);
  esp32c3Raw.polylines[0].points = [[0, 0], [2200, 0], [2200, 1500], [0, 1500], [0, 0]];
  esp32c3Raw.components[0].x = 100;
  esp32c3Raw.components[0].y = 100;
  esp32c3Raw.components[1].x = 300;
  esp32c3Raw.components[1].y = 100;
  esp32c3Raw.pads[0].x = 120;
  esp32c3Raw.pads[0].y = 100;
  esp32c3Raw.vias[0].x = 180;
  esp32c3Raw.vias[0].y = 100;
  esp32c3Raw.components.push({
    primitiveId: "u1-esp32c3",
    designator: "U1",
    name: "ESP32-C3-MINI-1",
    manufacturerPartNumber: "ESP32-C3-MINI-1-N4",
    footprint: { uuid: "fp-esp32c3", name: "ESP32-C3-MINI-1" },
    layer: 1,
    x: 1100,
    y: 1305.2,
    rotation: 0,
    bbox: { minX: 820, minY: 975.2, maxX: 1380, maxY: 1635.2 },
  });
  const esp32c3Record = constraintFixture(esp32c3Raw);
  esp32c3Record.assemblyEnvelopes.push({
    designator: "U1",
    source: "ESP32-C3 module integration drawing regression fixture",
    courtyard: { type: "RECT", widthMil: 560, heightMil: 660, coordinates: "COMPONENT_LOCAL" },
  });
  esp32c3Record.criticalPlacementZones.push({
    id: "U1_ANTENNA_ZONE",
    ownerDesignator: "U1",
    purpose: "module antenna clearance",
    source: "ESP32-C3 module integration drawing regression fixture",
    allowedDesignators: [],
    geometry: {
      type: "RECT",
      widthMil: 560,
      heightMil: 300,
      centerXMil: 0,
      centerYMil: 250,
      coordinates: "COMPONENT_LOCAL",
    },
  });
  const esp32c3Boundary = analyzePlacement(
    esp32c3Raw,
    evidenceFixture(esp32c3Record),
    { kind: "self-test" },
  );
  if (
    esp32c3Boundary.status !== STATUS.BLOCKED ||
    esp32c3Boundary.checks.boardContainment.courtyardOutsideBoard.length !== 1 ||
    esp32c3Boundary.checks.boardContainment.criticalZoneOutsideBoard.length !== 1
  ) {
    throw new Error("ESP32-C3 U1 y=1305.2 board-edge regression did not block placement");
  }

  const antennaRaw = structuredClone(clearRaw);
  const antennaRecord = constraintFixture(antennaRaw);
  antennaRecord.criticalPlacementZones.push({
    id: "SW1_ANTENNA_ZONE",
    ownerDesignator: "SW1",
    purpose: "module antenna overhang",
    source: "module integration drawing revision 1",
    allowedDesignators: [],
    geometry: {
      type: "RECT",
      widthMil: 80,
      heightMil: 180,
      centerXMil: 0,
      centerYMil: 180,
      coordinates: "COMPONENT_LOCAL",
    },
  });
  antennaRecord.boardBoundary.edgeRelations.push({
    subjectType: "CRITICAL_ZONE",
    subjectId: "SW1_ANTENNA_ZONE",
    relation: "ALLOWED_OVERHANG",
    source: "module integration drawing revision 1",
    evidenceArtifact: "antenna-edge-study.json",
  });
  const antennaOverhang = analyzePlacement(
    antennaRaw,
    evidenceFixture(antennaRecord),
    { kind: "self-test" },
  );
  if (antennaOverhang.status !== STATUS.CLEAR) {
    throw new Error(`documented antenna overhang returned ${antennaOverhang.status}`);
  }

  const missingBoundaryRecord = constraintFixture(clearRaw);
  delete missingBoundaryRecord.boardBoundary;
  const missingBoundary = analyzePlacement(
    clearRaw,
    evidenceFixture(missingBoundaryRecord),
    { kind: "self-test" },
  );
  if (missingBoundary.status !== STATUS.UNRESOLVED) {
    throw new Error("missing board boundary did not keep placement unresolved");
  }

  const unlockedRaw = structuredClone(clearRaw);
  unlockedRaw.polylines[0].locked = false;
  const unlockedRecord = constraintFixture(unlockedRaw);
  const unlocked = analyzePlacement(
    unlockedRaw,
    evidenceFixture(unlockedRecord),
    { kind: "self-test" },
  );
  if (unlocked.status !== STATUS.BLOCKED) {
    throw new Error("unlocked required native outline did not block placement");
  }

  const viaRaw = structuredClone(clearRaw);
  viaRaw.vias[0].x = 42;
  const viaRecord = constraintFixture(viaRaw);
  const viaBlocked = analyzePlacement(viaRaw, evidenceFixture(viaRecord), { kind: "self-test" });
  if (
    viaBlocked.status !== STATUS.BLOCKED ||
    viaBlocked.checks.viaPad.violations[0]?.sameNet !== true
  ) {
    throw new Error("same-net via/pad intrusion fixture did not block placement");
  }

  const specialRecord = constraintFixture(viaRaw);
  specialRecord.specialViaConstructions.push({
    viaPrimitiveId: "via-en",
    padDesignator: "SW1",
    padNumber: "1",
    construction: "FILLED_CAPPED_PLANARIZED",
    processEvidenceArtifact: "vippo.json",
  });
  specialRecord.revision = designFingerprint(viaRaw);
  const special = analyzePlacement(viaRaw, evidenceFixture(specialRecord), { kind: "self-test" });
  if (special.status !== STATUS.CLEAR) {
    throw new Error("declared exact special via construction did not clear placement");
  }

  const duplicateViaRaw = structuredClone(viaRaw);
  duplicateViaRaw.vias.push({
    ...structuredClone(duplicateViaRaw.vias[0]),
    x: 38,
  });
  const duplicateViaRecord = constraintFixture(duplicateViaRaw);
  duplicateViaRecord.specialViaConstructions.push({
    viaPrimitiveId: "via-en",
    padDesignator: "SW1",
    padNumber: "1",
    construction: "FILLED_CAPPED_PLANARIZED",
    processEvidenceArtifact: "vippo.json",
  });
  duplicateViaRecord.revision = designFingerprint(duplicateViaRaw);
  const duplicateVia = analyzePlacement(
    duplicateViaRaw,
    evidenceFixture(duplicateViaRecord),
    { kind: "self-test" },
  );
  if (
    duplicateVia.status !== STATUS.UNRESOLVED ||
    duplicateVia.checks.viaPad.unsupportedVias.length !== 2 ||
    duplicateVia.checks.viaPad.acceptedSpecialConstructions.length !== 0
  ) {
    throw new Error("one exact via exception covered duplicate live via primitive IDs");
  }

  const missingViaCoordinateRaw = structuredClone(clearRaw);
  missingViaCoordinateRaw.vias[0].x = null;
  const missingViaCoordinateRecord = constraintFixture(missingViaCoordinateRaw);
  missingViaCoordinateRecord.revision = designFingerprint(missingViaCoordinateRaw);
  const missingViaCoordinate = analyzePlacement(
    missingViaCoordinateRaw,
    evidenceFixture(missingViaCoordinateRecord),
    { kind: "self-test" },
  );
  if (
    missingViaCoordinate.status !== STATUS.UNRESOLVED ||
    missingViaCoordinate.checks.viaPad.unsupportedVias.length !== 1
  ) {
    throw new Error("null via coordinate cleared exact pad-clearance geometry");
  }

  const unresolvedRecord = constraintFixture(clearRaw);
  unresolvedRecord.assemblyEnvelopes = unresolvedRecord.assemblyEnvelopes.filter(
    (item) => item.designator !== "J1",
  );
  const unresolved = analyzePlacement(clearRaw, evidenceFixture(unresolvedRecord), {
    kind: "self-test",
  });
  if (unresolved.status !== STATUS.UNRESOLVED) {
    throw new Error("missing assembly envelope did not keep placement unresolved");
  }

  const ownerMismatchRaw = structuredClone(clearRaw);
  ownerMismatchRaw.pads[0].parentComponentPrimitiveId = "j1";
  const ownerMismatchRecord = constraintFixture(ownerMismatchRaw);
  ownerMismatchRecord.revision = designFingerprint(ownerMismatchRaw);
  const ownerMismatch = analyzePlacement(
    ownerMismatchRaw,
    evidenceFixture(ownerMismatchRecord),
    { kind: "self-test" },
  );
  if (
    ownerMismatch.status !== STATUS.UNRESOLVED ||
    ownerMismatch.checks.componentPlacement.unownedPads.length !== 1
  ) {
    throw new Error("mismatched pad designator/parent primitive binding did not remain unresolved");
  }

  const duplicateComponentRaw = structuredClone(clearRaw);
  duplicateComponentRaw.components.push({
    ...structuredClone(duplicateComponentRaw.components[1]),
    primitiveId: "j1-duplicate",
    x: 500,
    bbox: { minX: 475, minY: -25, maxX: 525, maxY: 25 },
  });
  const duplicateComponentRecord = constraintFixture(duplicateComponentRaw);
  duplicateComponentRecord.revision = designFingerprint(duplicateComponentRaw);
  const duplicateComponent = analyzePlacement(
    duplicateComponentRaw,
    evidenceFixture(duplicateComponentRecord),
    { kind: "self-test" },
  );
  if (
    duplicateComponent.status !== STATUS.UNRESOLVED ||
    !duplicateComponent.checks.componentPlacement.componentIdentityConflicts.length
  ) {
    throw new Error("duplicate component designator cleared exact owner binding");
  }

  const duplicatePadPrimitiveRaw = structuredClone(clearRaw);
  duplicatePadPrimitiveRaw.pads.push({
    ...structuredClone(duplicatePadPrimitiveRaw.pads[0]),
    padNumber: "2",
    x: -20,
  });
  const duplicatePadPrimitiveRecord = constraintFixture(duplicatePadPrimitiveRaw);
  duplicatePadPrimitiveRecord.revision = designFingerprint(duplicatePadPrimitiveRaw);
  const duplicatePadPrimitive = analyzePlacement(
    duplicatePadPrimitiveRaw,
    evidenceFixture(duplicatePadPrimitiveRecord),
    { kind: "self-test" },
  );
  if (
    duplicatePadPrimitive.status !== STATUS.UNRESOLVED ||
    duplicatePadPrimitive.checks.componentPlacement.unownedPads.length !== 2
  ) {
    throw new Error("duplicate pad primitiveId cleared exact owner binding");
  }

  const protrudingRecord = constraintFixture(clearRaw);
  protrudingRecord.assemblyEnvelopes[0].courtyard.widthMil = 50;
  protrudingRecord.revision = designFingerprint(clearRaw);
  const protruding = analyzePlacement(clearRaw, evidenceFixture(protrudingRecord), {
    kind: "self-test",
  });
  if (
    protruding.status !== STATUS.BLOCKED ||
    protruding.checks.componentPlacement.ownPadOutsideCourtyard.length !== 1
  ) {
    throw new Error("pad protruding beyond its owning courtyard did not block placement");
  }

  const concaveRaw = structuredClone(clearRaw);
  concaveRaw.pads[0].x = 0;
  const concaveRecord = constraintFixture(concaveRaw);
  concaveRecord.assemblyEnvelopes[0].courtyard = {
    type: "POLYGON",
    pointsMil: [
      [-50, -50], [50, -50], [50, 50], [10, 50],
      [10, -10], [-10, -10], [-10, 50], [-50, 50],
    ],
    coordinates: "COMPONENT_LOCAL",
  };
  concaveRecord.revision = designFingerprint(concaveRaw);
  const concave = analyzePlacement(concaveRaw, evidenceFixture(concaveRecord), {
    kind: "self-test",
  });
  if (
    concave.status !== STATUS.BLOCKED ||
    concave.checks.componentPlacement.ownPadOutsideCourtyard.length !== 1
  ) {
    throw new Error("pad edge crossing a concave courtyard notch did not block placement");
  }

  const selfIntersectingRecord = constraintFixture(clearRaw);
  selfIntersectingRecord.assemblyEnvelopes[0].courtyard = {
    type: "POLYGON",
    pointsMil: [[-50, -50], [50, 50], [-50, 50], [50, -50]],
    coordinates: "COMPONENT_LOCAL",
  };
  selfIntersectingRecord.revision = designFingerprint(clearRaw);
  const selfIntersecting = analyzePlacement(
    clearRaw,
    evidenceFixture(selfIntersectingRecord),
    { kind: "self-test" },
  );
  if (
    selfIntersecting.status !== STATUS.UNRESOLVED ||
    !selfIntersecting.checks.componentPlacement.invalidEnvelopes.includes("SW1")
  ) {
    throw new Error("self-intersecting courtyard polygon did not remain unresolved");
  }

  const explicitPolygonPadRaw = structuredClone(clearRaw);
  explicitPolygonPadRaw.pads[0].pad = [
    "POLYLINE_COMPLEX_POLYGON",
    [-20, -30, "L", 20, -30, "L", 20, 30, "L", -20, 30],
  ];
  const explicitPolygonPadRecord = constraintFixture(explicitPolygonPadRaw);
  explicitPolygonPadRecord.revision = designFingerprint(explicitPolygonPadRaw);
  const explicitPolygonPad = analyzePlacement(
    explicitPolygonPadRaw,
    evidenceFixture(explicitPolygonPadRecord),
    { kind: "self-test" },
  );
  if (
    explicitPolygonPad.status !== STATUS.UNRESOLVED ||
    explicitPolygonPad.checks.componentPlacement.unsupportedPadOccupancy.length !== 1
  ) {
    throw new Error("explicit polygon pad without a proven coordinate contract cleared placement");
  }

  const contractedPolygonPadRaw = structuredClone(clearRaw);
  contractedPolygonPadRaw.pads[0].pad = [
    "POLYGON",
    [0, -20, "L", 40, -20, 40, 20, 0, 20, 0, -20],
  ];
  const contractedPolygonPadRecord = constraintFixture(contractedPolygonPadRaw);
  contractedPolygonPadRecord.padGeometryContracts = [{
    primitiveId: "sw1-pad1",
    designator: "SW1",
    padNumber: "1",
    shape: "POLYGON",
    coordinates: "BOARD",
    evidenceArtifact: "self-test-polygon-board-coordinate-contract.json",
  }];
  contractedPolygonPadRecord.revision = designFingerprint(contractedPolygonPadRaw);
  const contractedPolygonPad = analyzePlacement(
    contractedPolygonPadRaw,
    evidenceFixture(contractedPolygonPadRecord),
    { kind: "self-test" },
  );
  if (contractedPolygonPad.status !== STATUS.CLEAR) {
    throw new Error("contracted board-coordinate polygon pad did not clear placement");
  }

  const ovalPadRaw = structuredClone(clearRaw);
  ovalPadRaw.pads[0].pad = ["OVAL", 40, 60];
  const ovalPadRecord = constraintFixture(ovalPadRaw);
  ovalPadRecord.assemblyEnvelopes[0].courtyard.widthMil = 100;
  ovalPadRecord.assemblyEnvelopes[0].courtyard.heightMil = 80;
  ovalPadRecord.revision = designFingerprint(ovalPadRaw);
  const ovalPad = analyzePlacement(
    ovalPadRaw,
    evidenceFixture(ovalPadRecord),
    { kind: "self-test" },
  );
  if (ovalPad.status !== STATUS.CLEAR) {
    throw new Error("EasyEDA OVAL pad did not use the deterministic oblong converter");
  }

  const specialPadstackRaw = structuredClone(clearRaw);
  specialPadstackRaw.pads[0].specialPad = [[1, 2, ["RECTANGLE", 60, 80, 0]]];
  const specialPadstackRecord = constraintFixture(specialPadstackRaw);
  specialPadstackRecord.revision = designFingerprint(specialPadstackRaw);
  const specialPadstack = analyzePlacement(
    specialPadstackRaw,
    evidenceFixture(specialPadstackRecord),
    { kind: "self-test" },
  );
  if (
    specialPadstack.status !== STATUS.UNRESOLVED ||
    specialPadstack.checks.componentPlacement.unsupportedPadOccupancy.length !== 1
  ) {
    throw new Error("per-layer specialPad geometry cleared without a deterministic converter");
  }

  const missingPadCoordinateRaw = structuredClone(clearRaw);
  missingPadCoordinateRaw.pads[0].x = null;
  const missingPadCoordinateRecord = constraintFixture(missingPadCoordinateRaw);
  missingPadCoordinateRecord.revision = designFingerprint(missingPadCoordinateRaw);
  const missingPadCoordinate = analyzePlacement(
    missingPadCoordinateRaw,
    evidenceFixture(missingPadCoordinateRecord),
    { kind: "self-test" },
  );
  if (
    missingPadCoordinate.status !== STATUS.UNRESOLVED ||
    missingPadCoordinate.checks.componentPlacement.unsupportedPadOccupancy.length !== 1
  ) {
    throw new Error("null pad coordinate was coerced to a clear origin");
  }

  const missingPadLayerRaw = structuredClone(clearRaw);
  missingPadLayerRaw.pads[0].layer = null;
  const missingPadLayerRecord = constraintFixture(missingPadLayerRaw);
  missingPadLayerRecord.revision = designFingerprint(missingPadLayerRaw);
  const missingPadLayer = analyzePlacement(
    missingPadLayerRaw,
    evidenceFixture(missingPadLayerRecord),
    { kind: "self-test" },
  );
  if (
    missingPadLayer.status !== STATUS.UNRESOLVED ||
    missingPadLayer.checks.componentPlacement.unsupportedPadOccupancy.length !== 1
  ) {
    throw new Error("null pad layer cleared component occupancy");
  }

  const missingComponentCoordinateRaw = structuredClone(clearRaw);
  missingComponentCoordinateRaw.components[0].x = null;
  const missingComponentCoordinateRecord = constraintFixture(missingComponentCoordinateRaw);
  missingComponentCoordinateRecord.revision = designFingerprint(missingComponentCoordinateRaw);
  const missingComponentCoordinate = analyzePlacement(
    missingComponentCoordinateRaw,
    evidenceFixture(missingComponentCoordinateRecord),
    { kind: "self-test" },
  );
  if (
    missingComponentCoordinate.status !== STATUS.UNRESOLVED ||
    !missingComponentCoordinate.checks.componentPlacement.invalidEnvelopes.includes("SW1")
  ) {
    throw new Error("null component coordinate cleared sourced envelope geometry");
  }

  const selfIntersectingZoneRecord = constraintFixture(clearRaw);
  selfIntersectingZoneRecord.criticalPlacementZones = [{
    id: "bow-tie-zone",
    ownerDesignator: "SW1",
    purpose: "self-test",
    source: "self-test",
    allowedDesignators: [],
    geometry: {
      type: "POLYGON",
      pointsMil: [[-50, -50], [50, 50], [-50, 50], [50, -50]],
      coordinates: "COMPONENT_LOCAL",
    },
  }];
  selfIntersectingZoneRecord.revision = designFingerprint(clearRaw);
  const selfIntersectingZone = analyzePlacement(
    clearRaw,
    evidenceFixture(selfIntersectingZoneRecord),
    { kind: "self-test" },
  );
  if (
    selfIntersectingZone.status !== STATUS.UNRESOLVED ||
    selfIntersectingZone.checks.componentPlacement.criticalZoneUnverified.length !== 1
  ) {
    throw new Error("self-intersecting critical zone polygon did not remain unresolved");
  }

  for (const [name, configure] of [
    ["courtyard numeric string", (record) => {
      record.assemblyEnvelopes[0].courtyard.centerXMil = "100";
    }],
    ["opposite courtyard null center", (record) => {
      record.assemblyEnvelopes[1].oppositeSideCourtyard = {
        type: "RECT",
        widthMil: 20,
        heightMil: 20,
        centerYMil: null,
        coordinates: "COMPONENT_LOCAL",
      };
    }],
    ["critical zone boolean rotation", (record) => {
      record.criticalPlacementZones = [{
        id: "invalid-optional-zone",
        ownerDesignator: "SW1",
        purpose: "self-test",
        source: "self-test",
        allowedDesignators: [],
        geometry: {
          type: "RECT",
          widthMil: 20,
          heightMil: 20,
          rotationDeg: true,
          coordinates: "COMPONENT_LOCAL",
        },
      }];
    }],
  ]) {
    const record = constraintFixture(clearRaw);
    configure(record);
    record.revision = designFingerprint(clearRaw);
    const result = analyzePlacement(clearRaw, evidenceFixture(record), { kind: "self-test" });
    if (result.status !== STATUS.UNRESOLVED) {
      throw new Error(`${name} was silently defaulted to zero and cleared placement`);
    }
  }

  const missingZoneOwnerRecord = constraintFixture(clearRaw);
  missingZoneOwnerRecord.criticalPlacementZones = [{
    id: "ghost-owner-zone",
    ownerDesignator: "GHOST",
    purpose: "self-test",
    source: "self-test",
    allowedDesignators: [],
    geometry: {
      type: "RECT",
      widthMil: 20,
      heightMil: 20,
      centerXMil: 1000,
      centerYMil: 1000,
      coordinates: "BOARD",
    },
  }];
  missingZoneOwnerRecord.revision = designFingerprint(clearRaw);
  const missingZoneOwner = analyzePlacement(
    clearRaw,
    evidenceFixture(missingZoneOwnerRecord),
    { kind: "self-test" },
  );
  if (
    missingZoneOwner.status !== STATUS.UNRESOLVED ||
    missingZoneOwner.checks.componentPlacement.criticalZoneUnverified.length !== 1
  ) {
    throw new Error("BOARD-coordinate critical zone with an absent owner cleared placement");
  }

  const foreignPadRaw = structuredClone(clearRaw);
  foreignPadRaw.pads.push({
    primitiveId: "j1-pad1",
    parentComponentPrimitiveId: "j1",
    designator: "J1",
    padNumber: "1",
    net: "GND",
    layer: 1,
    x: 30,
    y: 0,
    rotation: 0,
    pad: ["RECT", 30, 30, 0],
  });
  const foreignPadRecord = constraintFixture(foreignPadRaw);
  foreignPadRecord.revision = designFingerprint(foreignPadRaw);
  const foreignPad = analyzePlacement(foreignPadRaw, evidenceFixture(foreignPadRecord), {
    kind: "self-test",
  });
  if (
    foreignPad.status !== STATUS.BLOCKED ||
    foreignPad.checks.componentPlacement.crossComponentPadConflicts.length !== 1 ||
    !foreignPad.checks.componentPlacement.padToForeignCourtyardConflicts.length
  ) {
    throw new Error("foreign-component pad overlap did not block placement");
  }

  const closePadRaw = structuredClone(clearRaw);
  closePadRaw.components[1].x = 49;
  closePadRaw.components[1].bbox = { minX: 24, minY: -25, maxX: 74, maxY: 25 };
  closePadRaw.pads.push({
    primitiveId: "j1-close-pad1",
    parentComponentPrimitiveId: "j1",
    designator: "J1",
    padNumber: "1",
    net: "GND",
    layer: 1,
    x: 49,
    y: 0,
    rotation: 0,
    pad: ["RECT", 8, 8, 0],
  });
  const closePadRecord = constraintFixture(closePadRaw);
  closePadRecord.revision = designFingerprint(closePadRaw);
  const closePad = analyzePlacement(closePadRaw, evidenceFixture(closePadRecord), {
    kind: "self-test",
  });
  if (
    closePad.status !== STATUS.BLOCKED ||
    closePad.checks.componentPlacement.crossComponentPadClearanceViolations.length !== 1
  ) {
    throw new Error("foreign-component pad copper-clearance fixture did not block placement");
  }

  const oppositeSideRaw = structuredClone(clearRaw);
  oppositeSideRaw.components[1].layer = 2;
  oppositeSideRaw.components[1].x = 30;
  oppositeSideRaw.components[1].bbox = { minX: 5, minY: -25, maxX: 55, maxY: 25 };
  oppositeSideRaw.pads.push({
    primitiveId: "j1-bottom-pad1",
    parentComponentPrimitiveId: "j1",
    designator: "J1",
    padNumber: "1",
    net: "GND",
    layer: 2,
    x: 30,
    y: 0,
    rotation: 0,
    pad: ["RECT", 30, 30, 0],
    hole: null,
  });
  const missingBottomTransformRecord = constraintFixture(oppositeSideRaw);
  missingBottomTransformRecord.revision = designFingerprint(oppositeSideRaw);
  const missingBottomTransform = analyzePlacement(
    oppositeSideRaw,
    evidenceFixture(missingBottomTransformRecord),
    { kind: "self-test" },
  );
  if (missingBottomTransform.status !== STATUS.UNRESOLVED) {
    throw new Error("bottom-side component-local courtyard without a mirror transform cleared");
  }
  const oppositeSideRecord = constraintFixture(oppositeSideRaw);
  oppositeSideRecord.assemblyEnvelopes[1].courtyard.bottomSideTransform =
    "MIRROR_LOCAL_X_THEN_ROTATE";
  oppositeSideRecord.revision = designFingerprint(oppositeSideRaw);
  const oppositeSide = analyzePlacement(
    oppositeSideRaw,
    evidenceFixture(oppositeSideRecord),
    { kind: "self-test" },
  );
  if (
    oppositeSide.status !== STATUS.CLEAR ||
    oppositeSide.checks.componentPlacement.crossComponentPadConflicts.length
  ) {
    throw new Error("opposite-side SMD pads were incorrectly treated as a collision");
  }
  const throughHoleRaw = structuredClone(oppositeSideRaw);
  throughHoleRaw.pads.at(-1).layer = 12;
  throughHoleRaw.pads.at(-1).hole = ["ROUND", 12];
  const throughHoleRecord = constraintFixture(throughHoleRaw);
  throughHoleRecord.assemblyEnvelopes[1].courtyard.bottomSideTransform =
    "MIRROR_LOCAL_X_THEN_ROTATE";
  throughHoleRecord.assemblyEnvelopes[1].padstackProjectionEvidence = [{
    padNumber: "1",
    policy: "MAXIMUM_COPPER_PROJECTION",
    source: "self-test padstack table",
  }];
  throughHoleRecord.revision = designFingerprint(throughHoleRaw);
  const throughHole = analyzePlacement(
    throughHoleRaw,
    evidenceFixture(throughHoleRecord),
    { kind: "self-test" },
  );
  if (
    throughHole.status !== STATUS.BLOCKED ||
    throughHole.checks.componentPlacement.crossComponentPadConflicts.length !== 1
  ) {
    throw new Error("through-hole pad did not occupy both assembly sides");
  }
  const throughHoleNoConflictRaw = structuredClone(clearRaw);
  throughHoleNoConflictRaw.pads.push({
    primitiveId: "j1-through-pad-clear",
    parentComponentPrimitiveId: "j1",
    designator: "J1",
    padNumber: "1",
    net: "GND",
    layer: 12,
    x: 300,
    y: 0,
    rotation: 0,
    pad: ["ELLIPSE", 24, 24, 0],
    hole: ["ROUND", 12],
  });
  const missingOppositeRecord = constraintFixture(throughHoleNoConflictRaw);
  missingOppositeRecord.assemblyEnvelopes[1].padstackProjectionEvidence = [{
    padNumber: "1",
    policy: "MAXIMUM_COPPER_PROJECTION",
    source: "self-test padstack table",
  }];
  missingOppositeRecord.revision = designFingerprint(throughHoleNoConflictRaw);
  const missingOpposite = analyzePlacement(
    throughHoleNoConflictRaw,
    evidenceFixture(missingOppositeRecord),
    { kind: "self-test" },
  );
  if (
    missingOpposite.status !== STATUS.UNRESOLVED ||
    missingOpposite.checks.componentPlacement.missingOppositeSideCourtyardDesignators[0] !== "J1"
  ) {
    throw new Error("through-hole component without opposite-side courtyard did not remain unresolved");
  }
  const oppositeCourtyardRecord = constraintFixture(throughHoleNoConflictRaw);
  oppositeCourtyardRecord.assemblyEnvelopes[1].oppositeSideCourtyard = {
    type: "RECT",
    widthMil: 50,
    heightMil: 50,
    coordinates: "COMPONENT_LOCAL",
  };
  oppositeCourtyardRecord.revision = designFingerprint(throughHoleNoConflictRaw);
  const missingProjection = analyzePlacement(
    throughHoleNoConflictRaw,
    evidenceFixture(oppositeCourtyardRecord),
    { kind: "self-test" },
  );
  if (
    missingProjection.status !== STATUS.UNRESOLVED ||
    missingProjection.checks.componentPlacement.missingPadstackProjectionEvidence.length !== 1
  ) {
    throw new Error("through-hole pad without maximum-projection evidence cleared placement");
  }
  oppositeCourtyardRecord.assemblyEnvelopes[1].padstackProjectionEvidence = [{
    padNumber: "1",
    policy: "MAXIMUM_COPPER_PROJECTION",
    source: "self-test padstack table",
  }];
  oppositeCourtyardRecord.revision = designFingerprint(throughHoleNoConflictRaw);
  const oppositeCourtyard = analyzePlacement(
    throughHoleNoConflictRaw,
    evidenceFixture(oppositeCourtyardRecord),
    { kind: "self-test" },
  );
  if (oppositeCourtyard.status !== STATUS.CLEAR) {
    throw new Error("sourced opposite-side courtyard did not clear through-hole placement");
  }

  const singleLayerHoleMetadataRaw = structuredClone(clearRaw);
  singleLayerHoleMetadataRaw.pads[0].hole = ["ROUND", 1.4, 1.4];
  const singleLayerHoleMetadataRecord = constraintFixture(singleLayerHoleMetadataRaw);
  singleLayerHoleMetadataRecord.revision = designFingerprint(singleLayerHoleMetadataRaw);
  const singleLayerHoleMetadata = analyzePlacement(
    singleLayerHoleMetadataRaw,
    evidenceFixture(singleLayerHoleMetadataRecord),
    { kind: "self-test" },
  );
  if (singleLayerHoleMetadata.status !== STATUS.CLEAR) {
    throw new Error("single-layer SMD pad hole-like metadata was treated as opposite-side occupancy");
  }

  process.stdout.write(
    `${JSON.stringify({
      clear: clear.status,
      courtyardOutsideBoard: outside.status,
      esp32c3U1BoundaryRegression: esp32c3Boundary.status,
      documentedAntennaOverhang: antennaOverhang.status,
      missingBoardBoundary: missingBoundary.status,
      unlockedBoardBoundary: unlocked.status,
      sameNetViaIntrusion: viaBlocked.status,
      declaredSpecialVia: special.status,
      duplicateViaIdentity: duplicateVia.status,
      missingViaCoordinate: missingViaCoordinate.status,
      missingEnvelope: unresolved.status,
      mismatchedPadOwner: ownerMismatch.status,
      duplicateComponentIdentity: duplicateComponent.status,
      duplicatePadIdentity: duplicatePadPrimitive.status,
      ownPadOutsideCourtyard: protruding.status,
      concaveCourtyardEscape: concave.status,
      selfIntersectingCourtyard: selfIntersecting.status,
      explicitPolygonPad: explicitPolygonPad.status,
      contractedPolygonPad: contractedPolygonPad.status,
      ovalPad: ovalPad.status,
      perLayerSpecialPad: specialPadstack.status,
      missingPadCoordinate: missingPadCoordinate.status,
      missingPadLayer: missingPadLayer.status,
      missingComponentCoordinate: missingComponentCoordinate.status,
      selfIntersectingCriticalZone: selfIntersectingZone.status,
      invalidOptionalRectGeometry: STATUS.UNRESOLVED,
      missingCriticalZoneOwner: missingZoneOwner.status,
      foreignPadOverlap: foreignPad.status,
      foreignPadClearance: closePad.status,
      oppositeSideSmd: oppositeSide.status,
      bottomSideMissingTransform: missingBottomTransform.status,
      throughHoleAcrossSides: throughHole.status,
      throughHoleMissingOppositeCourtyard: missingOpposite.status,
      throughHoleMissingProjectionEvidence: missingProjection.status,
      throughHoleWithOppositeCourtyard: oppositeCourtyard.status,
      singleLayerHoleMetadata: singleLayerHoleMetadata.status,
    })}\n`,
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) {
      selfTest();
      return;
    }
    if (options.printFingerprint) {
      const bridge = await findBridge(options.bridgePort);
      const windowId = await resolveWindow(bridge, options.windowId);
      const collected = await collectFromEasyEda(bridge, windowId);
      process.stdout.write(
        `${JSON.stringify(designFingerprintLookup(collected.raw), null, 2)}\n`,
      );
      return;
    }
    const constraintEvidence = await loadConstraintEvidence(options);
    const bridge = await findBridge(options.bridgePort);
    const windowId = await resolveWindow(bridge, options.windowId);
    const collected = await collectFromEasyEda(bridge, windowId);
    const report = analyzePlacement(collected.raw, constraintEvidence, {
      kind: "easyeda-bridge",
      port: bridge.port,
      windowId: collected.windowId,
      bridgeHealth: bridge.health,
    });
    const outputPath = resolveSafeOutputPath(options.output, { force: false });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode(report.status);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        kind: "easyeda-placement-audit",
        fabricationRelease: false,
      }, null, 2)}\n`,
    );
    process.exitCode = EXIT.ERROR;
  }
}

export {
  EXIT,
  STATUS,
  analyzePlacement,
  collectFromEasyEda,
  constraintFixture,
  designFingerprintLookup,
  evidenceFixture,
  exitCode,
  fixture,
  loadConstraintEvidence,
  parseArgs,
  selfTest,
  summarizeFindings,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

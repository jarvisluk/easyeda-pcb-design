#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COMPLETION_TEMPLATE,
  DESIGN_FINGERPRINT_SCHEMA_VERSION,
  EXIT as COMMON_EXIT,
  analyzePourConnectivity,
  constraintFingerprint,
  crystalNetHints,
  designFingerprint,
  evidenceMeetsGate,
  findEasyedaApiSkill,
  freeCopperPrimitiveIds,
  highRiskInterfaceReasons,
  highSpeedDiscovery,
  highSpeedNetHints,
  readCrystalClearanceReport,
  readHighSpeedClearanceReport,
  resolveHumanAttestation,
  resolveSafeOutputPath,
} from "../../skills/easyeda-pcb-design/scripts/lib/audit_common.mjs";
import {
  DECISIONS as BASELINE_DECISIONS,
  EXIT as BASELINE_EXIT,
  analyze as analyzeBaseline,
  analyzeSchematicPlacement,
  analyzeSchematicPresentation,
  bindPcbDrcEvidence,
  collectorCode as baselineCollectorCode,
  parseArgs as parseBaselineArgs,
  pcbFixture,
  resolveWindow as resolveBaselineWindow,
  schematicFixture,
  schematicPageEnvelopeFixture,
  validateNetlistCompareExceptionArtifact,
  validateSchematicPageEnvelope,
} from "../../skills/easyeda-pcb-design/scripts/audits/easyeda_design_audit.mjs";
import {
  REQUIRED_INVALIDATION_TRIGGERS,
  REQUIRED_PARAMETER_COVERAGE_ASPECTS,
  sha256Buffer,
  validateArtifact as validateSelectionArtifact,
  validateComponentEvidenceRecord,
} from "../../skills/easyeda-pcb-design/scripts/lints/component_selection_evidence.mjs";
import {
  DECISIONS as CRYSTAL_DECISIONS,
  analyze as analyzeCrystal,
  collectorCode as crystalCollectorCode,
  completeConstraintFixture as completeCrystalConstraintFixture,
  mergeConstraintRecord as mergeCrystalConstraintRecord,
  parseArgs as parseCrystalArgs,
  selfTestFixture as crystalSelfTestFixture,
} from "../../skills/easyeda-pcb-design/scripts/audits/easyeda_crystal_clock_audit.mjs";
import {
  BRANCH_GATES as LEDGER_BRANCH_GATES,
  EXIT as LEDGER_EXIT,
  analyzeLedger,
  analyzeOperationLog,
  selfTestLedger,
  selfTestOperationLog,
} from "../../skills/easyeda-pcb-design/scripts/live/easyeda_gate_ledger.mjs";
import {
  DECISIONS,
  EXIT,
  analyze,
  collectorCode as highSpeedCollectorCode,
  completeConstraintFixture,
  mergeConstraintRecord,
  parseArgs,
  routeSummary,
  selfTestFixture,
} from "../../skills/easyeda-pcb-design/scripts/audits/easyeda_high_speed_audit.mjs";
import {
  comparePcbDataPlane,
  compareNetlists,
  identityContractIssues,
  overallDecision,
  parseArgs as parseNetlistCompareArgs,
  summarizeNativeComparison,
  verifyNativeCacheException,
} from "../../skills/easyeda-pcb-design/scripts/audits/easyeda_netlist_compare.mjs";
import {
  analyzeIdentity,
  parseArgs as parseIdentityPreflightArgs,
  parseInternalNetlistViews,
  pcbCollectorCode as identityPcbCollectorCode,
  schematicCollectorCode as identitySchematicCollectorCode,
} from "../../skills/easyeda-pcb-design/scripts/live/easyeda_identity_preflight.mjs";
import {
  analyzeRevisionIntent,
  parseArgs as parseRevisionGuardArgs,
  resolveSafeInputPath,
  treeCollectorCode as revisionTreeCollectorCode,
} from "../../skills/easyeda-pcb-design/scripts/live/easyeda_revision_guard.mjs";
import {
  STATUS as PLACEMENT_STATUS,
  analyzePlacement,
  constraintFixture as placementConstraintFixture,
  designFingerprintLookup,
  evidenceFixture as placementEvidenceFixture,
  fixture as placementFixture,
  parseArgs as parsePlacementArgs,
} from "../../skills/easyeda-pcb-design/scripts/audits/easyeda_placement_audit.mjs";

function withHumanAttestation(options, revision = "test-rev-1") {
  return {
    ...options,
    userAttestedEvidence: true,
    humanAttestation: {
      accepted: true,
      requested: true,
      reason: "test attestation",
      revision,
      attestFile: "<test>",
    },
  };
}

function highSpeedOptions(record, argv = [], extras = {}) {
  const parsed = parseArgs(argv.filter((item) => item !== "--user-attested-evidence"));
  return {
    ...mergeConstraintRecord(parsed, record),
    ...extras,
  };
}

function attested(record, argv = []) {
  return withHumanAttestation(highSpeedOptions(record, argv));
}

function clone(value) {
  return structuredClone(value);
}

function parameterCoverageFixture(overrides = {}) {
  return REQUIRED_PARAMETER_COVERAGE_ASPECTS.map((aspect) => ({
    aspect,
    status: "NOT_APPLICABLE",
    parameterIds: [],
    checkIds: [],
    rationale: "not exercised by this synthetic regression fixture",
    ...(overrides[aspect] || {}),
  }));
}

function componentEvidenceRecord(raw, artifactPath, content) {
  return {
    schemaVersion: 2,
    schematic: {
      projectUuid: raw.project.uuid,
      documentUuid: raw.document.uuid,
      fingerprintSchemaVersion: DESIGN_FINGERPRINT_SCHEMA_VERSION,
      designFingerprint: designFingerprint(raw),
    },
    invalidationPolicy: [...REQUIRED_INVALIDATION_TRIGGERS],
    sources: {
      primary: {
        publisher: "Example Semiconductor",
        documentId: "DS-100",
        revision: "Rev 1.2",
        canonicalUrl: "https://manufacturer.example/DS-100.pdf",
        retrievedAt: "2026-08-09T00:00:00Z",
        accessStatus: "AVAILABLE_VERIFIED",
        authority: "MANUFACTURER_PRIMARY",
        artifactPath,
        sha256: sha256Buffer(content),
        mediaType: "application/pdf",
        contentVerification: {
          status: "VERIFIED",
          method: "VISUAL_REVIEW",
          exactPartMatch: true,
          revisionMatch: true,
          observedDocumentId: "DS-100",
          observedRevision: "Rev 1.2",
          coveredPartNumbers: ["EXAMPLE-MCU-1"],
          location: "cover and section 4",
          reviewedAt: "2026-08-09T00:05:00Z",
          reviewer: "regression-test",
        },
      },
    },
    designRequirements: [
      {
        id: "rail_min_v",
        name: "minimum rail voltage",
        value: 3.0,
        unit: "V",
        conditions: "normal operation",
        basis: {
          kind: "REQUIREMENTS_BASELINE",
          reference: "test baseline power budget",
          fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
      {
        id: "rail_max_v",
        name: "maximum rail voltage",
        value: 3.6,
        unit: "V",
        conditions: "normal operation",
        basis: {
          kind: "REQUIREMENTS_BASELINE",
          reference: "test baseline power budget",
          fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
    ],
    parts: [
      {
        reference: "U1",
        manufacturer: "Example Semiconductor",
        manufacturerPartNumber: "EXAMPLE-MCU-1",
        package: "LQFP48",
        footprint: "LQFP48",
        criticality: "CRITICAL",
        disposition: "POPULATE",
        functionClass: "MICROCONTROLLER",
        sourceIds: ["primary"],
        requirements: [
          {
            name: "supply voltage",
            value: "3.3 V",
            sourceId: "primary",
            location: "section 4.1",
            derivation: "direct datasheet requirement",
          },
        ],
        parameters: [
          {
            id: "supply_min_v",
            name: "minimum supply voltage",
            value: 2.7,
            unit: "V",
            conditions: "recommended operating conditions",
            sourceId: "primary",
            location: "section 4.1",
          },
          {
            id: "supply_max_v",
            name: "maximum supply voltage",
            value: 3.6,
            unit: "V",
            conditions: "recommended operating conditions",
            sourceId: "primary",
            location: "section 4.1",
          },
        ],
        libraryBinding: {
          resolution: "EXACT_LIBRARY_DEVICE",
          substitutionPolicy: "FORBID",
          requestedManufacturerPartNumber: "EXAMPLE-MCU-1",
          selectedManufacturerPartNumber: "EXAMPLE-MCU-1",
          deviceUuid: "device-u1",
          symbolUuid: "symbol-u1",
          footprintUuid: "fp",
          footprintLibraryUuid: "lib",
        },
        parameterCoverage: parameterCoverageFixture({
          ELECTRICAL_LIMITS: {
            status: "AUDITED",
            parameterIds: ["supply_min_v", "supply_max_v"],
            checkIds: ["u1_supply_range"],
            rationale: "the project rail range must be contained",
          },
        }),
        suitability: { checkIds: ["u1_supply_range"], unresolved: [] },
      },
    ],
    suitabilityChecks: [
      {
        id: "u1_supply_range",
        type: "PARAMETER_RANGE_CONTAINS",
        partReference: "U1",
        parameterMinimumId: "supply_min_v",
        parameterMaximumId: "supply_max_v",
        requirementMinimumId: "rail_min_v",
        requirementMaximumId: "rail_max_v",
      },
    ],
  };
}

function writeAttestFile(dir, revision = "rev-A") {
  const file = path.join(dir, "attest.txt");
  writeFileSync(
    file,
    `I ATTEST EVIDENCE FOR PCB REVISION: ${revision}\n`,
    "utf8",
  );
  return file;
}

function runTests() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction("eda", baselineCollectorCode()));
  assert.doesNotThrow(() => new AsyncFunction("eda", crystalCollectorCode()));
  assert.doesNotThrow(() => new AsyncFunction("eda", highSpeedCollectorCode()));
  assert.doesNotThrow(() =>
    new AsyncFunction("eda", identitySchematicCollectorCode("schematic-page-1")),
  );
  assert.doesNotThrow(() =>
    new AsyncFunction("eda", identityPcbCollectorCode("pcb-1")),
  );
  assert.doesNotThrow(() => new AsyncFunction("eda", revisionTreeCollectorCode()));
  assert.doesNotMatch(
    baselineCollectorCode(),
    /\b(?:EDMT_EditorDocumentType|EPCB_LayerId)\b/,
  );
  assert.doesNotMatch(
    highSpeedCollectorCode(),
    /\bEDMT_EditorDocumentType\b/,
  );
  assert.doesNotMatch(
    crystalCollectorCode(),
    /\bEDMT_EditorDocumentType\b/,
  );
  assert.match(baselineCollectorCode(), /getState_SpecialPad/);

  // Fingerprint lookup breaks the circular dependency that made a
  // layout-constraints record unauthorable for an already-routed board.
  {
    const lookupRaw = placementFixture();
    const lookup = designFingerprintLookup(lookupRaw);
    assert.equal(lookup.kind, "easyeda-design-fingerprint");
    assert.equal(lookup.fabricationRelease, false);
    // The printed value must be exactly what the audit compares against.
    const boundRecord = placementConstraintFixture(lookupRaw);
    assert.equal(boundRecord.revision, lookup.fingerprint);
    const bound = analyzePlacement(
      lookupRaw,
      placementEvidenceFixture(boundRecord),
      { kind: "test-fingerprint-lookup" },
    );
    assert.equal(bound.status, PLACEMENT_STATUS.CLEAR);
    // A schematic is not a valid subject for a PCB fingerprint.
    assert.throws(() => designFingerprintLookup(schematicFixture()));
    // A record reconstructed after placement may describe the geometry it
    // is meant to constrain, so it must never clear silently.
    const reconstructed = {
      ...boundRecord,
      constraintBasis: "RECONSTRUCTED",
    };
    const reconstructedReport = analyzePlacement(
      lookupRaw,
      placementEvidenceFixture(reconstructed),
      { kind: "test-reconstructed-basis" },
    );
    assert.notEqual(reconstructedReport.status, PLACEMENT_STATUS.CLEAR);
    assert.equal(reconstructedReport.constraints.basis, "RECONSTRUCTED");
    assert.match(
      reconstructedReport.unverified.join(String.fromCharCode(10)),
      /reconstructed after placement/,
    );
    // An undeclared basis is also not clear; the record must state one.
    const undeclared = { ...boundRecord };
    delete undeclared.constraintBasis;
    const undeclaredReport = analyzePlacement(
      lookupRaw,
      placementEvidenceFixture(undeclared),
      { kind: "test-undeclared-basis" },
    );
    assert.notEqual(undeclaredReport.status, PLACEMENT_STATUS.CLEAR);
    assert.equal(undeclaredReport.constraints.basis, null);
    // The lookup mode must reject flags it would silently ignore.
    for (const ignored of [["--output", "e.json"], ["--force"], ["--layout-constraints", "x.json"]]) {
      assert.throws(() => parsePlacementArgs(["--print-fingerprint", ...ignored]));
    }
    // The lookup must not demand the record it exists to help author.
    const lookupArgs = parsePlacementArgs(["--print-fingerprint"]);
    assert.equal(lookupArgs.printFingerprint, true);
    assert.equal(lookupArgs.layoutConstraints, undefined);
    // Auditing still requires its full evidence inputs.
    assert.throws(() => parsePlacementArgs([]));
  }
  // Gate ledger: canonical branches, closure semantics, append-only log.
  assert.deepEqual(Object.keys(LEDGER_BRANCH_GATES).sort(), [
    "existing-board-continuation",
    "existing-board-repair",
    "existing-schematic-modification",
    "new-construction",
    "read-only-review",
  ]);
  assert.equal(LEDGER_EXIT.BLOCKED, 2);
  assert.equal(LEDGER_EXIT.UNVERIFIED, 3);
  {
    const ledgerDir = mkdtempSync(path.join(tmpdir(), "easyeda-ledger-tests-"));
    try {
      const operationLog = selfTestOperationLog();
      writeFileSync(path.join(ledgerDir, "companion.json"), "{}\n", "utf8");
      writeFileSync(path.join(ledgerDir, "binding.json"), "{}\n", "utf8");
      writeFileSync(path.join(ledgerDir, "late.json"), "{}\n", "utf8");
      const ledgerOptions = { baseDir: ledgerDir, operationLog };

      const clearedLedger = analyzeLedger(selfTestLedger(), ledgerOptions);
      assert.equal(clearedLedger.decision, "CLEARED");

      // Bootstrap: the first gate of a from-zero build closes before any
      // project exists, so a missing projectUuid must not deadlock it.
      const bootstrapLedger = analyzeLedger(
        selfTestLedger({
          projectUuid: undefined,
          gates: [
            { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
          ],
        }),
        ledgerOptions,
      );
      assert.equal(bootstrapLedger.decision, "CLEARED");

      // Once a project-binding gate closes, the UUID becomes mandatory.
      const unboundProjectLedger = analyzeLedger(
        selfTestLedger({
          projectUuid: undefined,
          gates: [
            { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
            { gate: "PROJECT_BOUND", state: "CLOSED", evidence: ["binding.json"] },
          ],
        }),
        ledgerOptions,
      );
      assert.notEqual(unboundProjectLedger.decision, "CLEARED");

      // A read-only review writes nothing, so it must clear with no
      // operation log instead of forcing a false mutation-branch label.
      const reviewLedger = analyzeLedger(
        selfTestLedger({
          branch: "read-only-review",
          scope: "end-to-end",
          gates: [
            { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
            {
              gate: "ACTIVE_REVISION_BOUND",
              state: "CLOSED",
              evidence: ["binding.json"],
            },
          ],
        }),
        { baseDir: ledgerDir },
      );
      assert.equal(reviewLedger.decision, "CLEARED");

      // Review binds an existing project, so its UUID stays mandatory.
      const reviewWithoutProject = analyzeLedger(
        selfTestLedger({
          branch: "read-only-review",
          scope: "end-to-end",
          projectUuid: undefined,
          gates: [
            { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
          ],
        }),
        { baseDir: ledgerDir },
      );
      assert.notEqual(reviewWithoutProject.decision, "CLEARED");

      // Review must not borrow a mutation branch's gates.
      const reviewClaimingRepairGate = analyzeLedger(
        selfTestLedger({
          branch: "read-only-review",
          scope: "end-to-end",
          gates: [
            { gate: "COMPANION_READY", state: "CLOSED", evidence: ["companion.json"] },
            { gate: "REPAIR_DRC_CLEAR", state: "CLOSED", evidence: ["late.json"] },
          ],
        }),
        { baseDir: ledgerDir },
      );
      assert.notEqual(reviewClaimingRepairGate.decision, "CLEARED");
      // A closed gate must bind an existing artifact.
      const unboundLedger = analyzeLedger(
        selfTestLedger({
          gates: [
            { gate: "COMPANION_READY", state: "CLOSED", evidence: [] },
          ],
        }),
        ledgerOptions,
      );
      assert.notEqual(unboundLedger.decision, "CLEARED");

      // Closing a later gate while an earlier one is open is the observed
      // failure mode and must never clear.
      const branchGates = LEDGER_BRANCH_GATES["new-construction"];
      const outOfOrderLedger = analyzeLedger(
        selfTestLedger({
          gates: [
            { gate: branchGates[0], state: "OPEN", evidence: [] },
            {
              gate: branchGates[branchGates.length - 1],
              state: "CLOSED",
              evidence: ["late.json"],
            },
          ],
        }),
        ledgerOptions,
      );
      assert.notEqual(outOfOrderLedger.decision, "CLEARED");

      // Two axes: bookkeeping integrity and slice completion. An honest ledger
      // for work in progress must stay CLEARED, because making an early stop
      // indistinguishable from a failure would reward claiming false completion.
      // It must simultaneously report INCOMPLETE so no consumer reads partial
      // work as closure.
      const partialEndToEnd = analyzeLedger(
        selfTestLedger({ scope: "end-to-end" }),
        ledgerOptions,
      );
      assert.equal(partialEndToEnd.decision, "CLEARED");
      assert.equal(partialEndToEnd.completion, "INCOMPLETE");
      assert.equal(
        partialEndToEnd.completionAnalysis.terminalGate,
        "DESIGN_CLOSURE",
      );
      assert.ok(
        partialEndToEnd.completionAnalysis.remainingGates.includes(
          "DESIGN_CLOSURE",
        ),
      );

      // A narrower scope reaching its own terminal is genuinely complete, not a
      // truncated end-to-end run.
      const schematicOnlyGates = LEDGER_BRANCH_GATES["new-construction"]
        .slice(0, 5)
        .map((gate) => ({ gate, state: "CLOSED", evidence: ["late.json"] }));
      const schematicOnlyComplete = analyzeLedger(
        selfTestLedger({ scope: "schematic-only", gates: schematicOnlyGates }),
        ledgerOptions,
      );
      assert.equal(schematicOnlyComplete.decision, "CLEARED");
      assert.equal(schematicOnlyComplete.completion, "COMPLETE");

      // A read-only review writes nothing yet still completes at its inventory
      // gate; it must never need a mutation branch to look finished.
      const reviewComplete = analyzeLedger(
        {
          schemaVersion: 1,
          branch: "read-only-review",
          scope: "end-to-end",
          projectUuid: "project-1",
          gates: LEDGER_BRANCH_GATES["read-only-review"].map((gate) => ({
            gate,
            state: "CLOSED",
            evidence: ["late.json"],
          })),
        },
        { baseDir: ledgerDir },
      );
      assert.equal(reviewComplete.decision, "CLEARED");
      assert.equal(reviewComplete.completion, "COMPLETE");

      // The terminal gate may not be settled by declaring it inapplicable; that
      // would let a ledger complete by disowning its own endpoint. Intermediate
      // gates may legitimately be NOT_APPLICABLE.
      const terminalDodge = analyzeLedger(
        selfTestLedger({
          scope: "schematic-only",
          gates: [
            ...schematicOnlyGates.slice(0, 4),
            { gate: "SCHEMATIC_VERIFIED", state: "NOT_APPLICABLE" },
          ],
        }),
        ledgerOptions,
      );
      assert.notEqual(terminalDodge.completion, "COMPLETE");

      // Broken bookkeeping makes completion unknowable rather than passable.
      const brokenCompletion = analyzeLedger(
        selfTestLedger({
          scope: "end-to-end",
          gates: [{ gate: "COMPANION_READY", state: "CLOSED", evidence: [] }],
        }),
        ledgerOptions,
      );
      assert.notEqual(brokenCompletion.decision, "CLEARED");
      assert.equal(brokenCompletion.completion, "INDETERMINATE");

      assert.equal(analyzeOperationLog(operationLog).status, "VERIFIED");

      // Append-only contract: reused ids void the log as evidence.
      const duplicatedLog = JSON.parse(JSON.stringify(operationLog));
      duplicatedLog.entries.push({ ...duplicatedLog.entries[0] });
      assert.notEqual(analyzeOperationLog(duplicatedLog).status, "VERIFIED");

      // A committed write with no semantic readback cannot clear.
      const unreadbackLog = JSON.parse(JSON.stringify(operationLog));
      unreadbackLog.entries[0] = {
        ...unreadbackLog.entries[0],
        outcome: "COMMITTED",
        semanticReadback: "",
      };
      assert.notEqual(analyzeOperationLog(unreadbackLog).status, "VERIFIED");
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  }

  assert.equal(BASELINE_EXIT.PASS_WITH_EXCEPTIONS, 4);
  assert.equal(EXIT.PASS_WITH_EXCEPTIONS, 4);
  assert.equal(COMMON_EXIT.UNVERIFIED, 3);
  assert.match(COMPLETION_TEMPLATE, /fabricationRelease: false/);

  const matchingNetlist = {
    components: {
      gge1: {
        props: {
          "Unique ID": "gge1",
          Designator: "U1",
          Device: "device-1",
          Footprint: "footprint-1",
          "Manufacturer Part": "ESP32-C3-MINI-1-H4X",
        },
        pinInfoMap: {
          1: { net: "GND" },
          2: { net: "+3V3" },
        },
      },
    },
  };
  const sameNetlist = clone(matchingNetlist);
  sameNetlist.components.gge1.props["PCB Layer"] = "TopLayer";
  const matchingComparison = compareNetlists(matchingNetlist, sameNetlist);
  assert.equal(matchingComparison.match, true);
  assert.equal(matchingComparison.pinNetDiffs.length, 0);
  assert.equal(matchingComparison.corePropertyDiffs.length, 0);
  assert.equal(matchingComparison.informationalPropertyDiffCount, 1);

  const pinMismatchNetlist = clone(sameNetlist);
  pinMismatchNetlist.components.gge1.pinInfoMap[2].net = "GND";
  const pinMismatch = compareNetlists(matchingNetlist, pinMismatchNetlist);
  assert.equal(pinMismatch.match, false);
  assert.equal(pinMismatch.pinNetDiffs[0].pin, "2");

  const footprintMismatchNetlist = clone(sameNetlist);
  footprintMismatchNetlist.components.gge1.props.Footprint = "wrong-footprint";
  const footprintMismatch = compareNetlists(
    matchingNetlist,
    footprintMismatchNetlist,
  );
  assert.equal(footprintMismatch.match, false);
  assert.equal(footprintMismatch.corePropertyDiffs[0].property, "Footprint");

  const staleIdentityNetlist = clone(matchingNetlist);
  staleIdentityNetlist.components.UNIQUEU1 =
    staleIdentityNetlist.components.gge1;
  delete staleIdentityNetlist.components.gge1;
  const staleIdentityComparison = compareNetlists(
    staleIdentityNetlist,
    staleIdentityNetlist,
  );
  assert.equal(staleIdentityComparison.match, false);
  assert.equal(
    staleIdentityComparison.identityContract.schematicIssues[0].code,
    "COMPONENT_KEY_UNIQUE_ID_MISMATCH",
  );
  assert.equal(identityContractIssues(matchingNetlist, "test").length, 0);
  assert.throws(() => parseNetlistCompareArgs([]), /schematic-page-uuid/);
  assert.throws(
    () =>
      parseNetlistCompareArgs([
        "--schematic-page-uuid",
        "page-1",
        "--pcb-uuid",
        "pcb-1",
        "--require-native-match",
      ]),
    /requires --schematic-uuid/,
  );
  assert.equal(
    parseNetlistCompareArgs([
      "--schematic-page-uuid",
      "page-1",
      "--schematic-uuid",
      "schematic-1",
      "--pcb-uuid",
      "pcb-1",
      "--require-native-match",
    ]).schematicUuid,
    "schematic-1",
  );
  assert.throws(
    () =>
      parseNetlistCompareArgs([
        "--schematic-page-uuid",
        "page-1",
        "--pcb-uuid",
        "pcb-1",
        "--allow-native-cache-exception",
      ]),
    /requires --schematic-uuid/,
  );
  assert.deepEqual(summarizeNativeComparison(undefined, false), {
    status: "NOT_REQUESTED",
    differenceCount: null,
    differences: [],
  });
  assert.equal(summarizeNativeComparison(null, true).status, "UNAVAILABLE");
  assert.equal(summarizeNativeComparison([], true).status, "MATCH");
  assert.deepEqual(
    summarizeNativeComparison([{ type: "NET", object: "GND" }], true),
    {
      status: "MISMATCH",
      differenceCount: 1,
      differences: [{ type: "NET", object: "GND" }],
    },
  );
  assert.equal(overallDecision(true, "NOT_REQUESTED"), "MATCH");
  assert.equal(overallDecision(true, "MATCH"), "MATCH");
  assert.equal(overallDecision(false, "MATCH"), "MISMATCH");
  assert.equal(overallDecision(true, "MISMATCH"), "MISMATCH");
  assert.equal(overallDecision(true, "UNAVAILABLE"), "UNVERIFIED");
  assert.equal(overallDecision(true, "NOT_REQUESTED", true), "UNVERIFIED");
  assert.equal(overallDecision(true, "MATCH", true), "MATCH");
  assert.equal(
    overallDecision(true, "MISMATCH", true, "VERIFIED"),
    "MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION",
  );
  const directPcb = comparePcbDataPlane(
    matchingNetlist,
    JSON.stringify(sameNetlist),
    ["GND", "+3V3"],
    [
      {
        primitiveId: "pcb-u1",
        designator: "U1",
        pads: [
          { primitiveId: "pad-1", number: "1", net: "GND" },
          { primitiveId: "pad-2", number: "2", net: "+3V3" },
        ],
      },
    ],
  );
  assert.equal(directPcb.match, true);
  const cacheDifferences = [
    { type: "NET", object: "'+3V3'", net1: ["U1.2"], net2: [] },
    { type: "NET", object: "GND", net1: ["U1.1"], net2: [] },
  ];
  assert.equal(
    verifyNativeCacheException({
      requested: true,
      manufacturingMatch: true,
      nativeDifferences: cacheDifferences,
      fileComparison: [],
      pcbDataPlane: directPcb,
      expectedNetNames: ["+3V3", "GND"],
    }).status,
    "VERIFIED",
  );
  assert.equal(
    verifyNativeCacheException({
      requested: true,
      manufacturingMatch: true,
      nativeDifferences: [
        { type: "COMPONENT", object: "U1", net1: ["U1"], net2: [] },
      ],
      fileComparison: [],
      pcbDataPlane: directPcb,
      expectedNetNames: ["+3V3", "GND"],
    }).status,
    "REJECTED",
  );
  const badDirectPcb = comparePcbDataPlane(
    matchingNetlist,
    JSON.stringify(sameNetlist),
    ["GND", "+3V3"],
    [
      {
        primitiveId: "pcb-u1",
        designator: "U1",
        pads: [
          { primitiveId: "pad-1", number: "1", net: "GND" },
          { primitiveId: "pad-2", number: "2", net: "GND" },
        ],
      },
    ],
  );
  assert.equal(badDirectPcb.match, false);
  assert.ok(
    badDirectPcb.issues.some(
      (issue) => issue.code === "PCB_DIRECT_PAD_NET_MISMATCH",
    ),
  );
  assert.equal(EXIT.UNVERIFIED, 3);

  assert.throws(() => parseIdentityPreflightArgs([]), /schematic-page-uuid/);
  assert.throws(
    () =>
      parseIdentityPreflightArgs([
        "--schematic-page-uuid",
        "page-1",
        "--require-native-match",
      ]),
    /requires --schematic-uuid and --pcb-uuid/,
  );
  assert.equal(
    parseInternalNetlistViews([
      JSON.stringify(matchingNetlist),
      JSON.stringify({ components: {} }),
    ]).views.length,
    2,
  );
  const identityPass = analyzeIdentity({
    liveParts: [
      { primitiveId: "u1", designator: "U1", uniqueId: "gge1" },
    ],
    schematicNetlist: matchingNetlist,
    pcbInternalRaw: [
      JSON.stringify(matchingNetlist),
      JSON.stringify({ components: {} }),
    ],
    pcbRequested: true,
    nativeDifferences: [],
    nativeRequested: true,
    requireNativeMatch: true,
    expectedPartCount: 1,
  });
  assert.equal(identityPass.decision, "MATCH");
  assert.deepEqual(identityPass.pcbEmptyInternalViewIndexes, [1]);
  const identityStale = analyzeIdentity({
    liveParts: [
      { primitiveId: "u1", designator: "U1", uniqueId: "gge1" },
    ],
    schematicNetlist: matchingNetlist,
    pcbInternalRaw: [JSON.stringify(staleIdentityNetlist)],
    pcbRequested: true,
  });
  assert.equal(identityStale.decision, "MISMATCH");
  assert.ok(
    identityStale.issues.some(
      (issue) => issue.code === "PCB_INTERNAL_VIEW_DIVERGES",
    ),
  );

  assert.throws(() => parseRevisionGuardArgs([]), /manifest is required/);
  assert.throws(
    () =>
      parseRevisionGuardArgs([
        "--manifest",
        "revision-manifest.json",
        "--intent-role",
        "diagnostic",
      ]),
    /revision intent requires/,
  );
  assert.throws(() => resolveSafeInputPath("/tmp/tree.json"), /relative/);
  const revisionManifest = {
    schemaVersion: 1,
    projectUuid: "project-1",
    revisions: [
      {
        uuid: "pcb-1",
        parentUuid: null,
        role: "rollback",
        status: "preserved",
        reason: "known-good baseline",
        successGate: "PCB_SYNC_MATCH",
        cleanupDisposition: "keep",
      },
    ],
  };
  const revisionTree = {
    project: { uuid: "project-1" },
    pcbs: [{ uuid: "pcb-1", name: "PCB1" }],
  };
  const revisionAllowed = analyzeRevisionIntent(
    revisionManifest,
    revisionTree,
    {
      role: "diagnostic",
      parentUuid: "pcb-1",
      reason: "test one synchronization hypothesis",
      successGate: "PCB_SYNC_MATCH",
      cleanupDisposition: "delete-after-proof",
    },
  );
  assert.equal(revisionAllowed.decision, "ALLOWED");
  const manifestWithDiagnostic = clone(revisionManifest);
  manifestWithDiagnostic.revisions.push({
    uuid: "pcb-diag",
    parentUuid: "pcb-1",
    role: "diagnostic",
    status: "active",
    reason: "existing diagnostic",
    successGate: "PCB_SYNC_MATCH",
    cleanupDisposition: "needs-user-decision",
  });
  const revisionBlocked = analyzeRevisionIntent(
    manifestWithDiagnostic,
    {
      ...revisionTree,
      pcbs: [...revisionTree.pcbs, { uuid: "pcb-diag" }],
    },
    {
      role: "diagnostic",
      parentUuid: "pcb-1",
      reason: "second synchronization hypothesis",
      successGate: "PCB_SYNC_MATCH",
      cleanupDisposition: "delete-after-proof",
    },
  );
  assert.equal(revisionBlocked.decision, "BLOCKED");
  assert.match(revisionBlocked.blockedReasons.join("\n"), /active diagnostic/);
  const revisionUnverified = analyzeRevisionIntent(revisionManifest, {
    ...revisionTree,
    pcbs: [...revisionTree.pcbs, { uuid: "pcb-extra" }],
  });
  assert.equal(revisionUnverified.decision, "UNVERIFIED");
  assert.deepEqual(revisionUnverified.unregisteredLiveUuids, ["pcb-extra"]);

  assert.equal(DESIGN_FINGERPRINT_SCHEMA_VERSION, 6);
  const rotationFingerprintFixture = pcbFixture();
  rotationFingerprintFixture.components[0].rotation = 0;
  const rotationFingerprintA = designFingerprint(rotationFingerprintFixture);
  rotationFingerprintFixture.components[0].rotation = 90;
  assert.notEqual(
    designFingerprint(rotationFingerprintFixture),
    rotationFingerprintA,
    "component rotation must invalidate exact-revision evidence",
  );
  const specialPadFingerprintFixture = placementFixture();
  const specialPadFingerprint = designFingerprint(specialPadFingerprintFixture);
  specialPadFingerprintFixture.pads[0].specialPad = [[1, 2, ["RECTANGLE", 60, 80, 0]]];
  assert.notEqual(
    designFingerprint(specialPadFingerprintFixture),
    specialPadFingerprint,
    "per-layer specialPad geometry must invalidate exact-revision evidence",
  );
  const outlineFingerprintFixture = placementFixture();
  const outlineFingerprint = designFingerprint(outlineFingerprintFixture);
  outlineFingerprintFixture.polylines[0].points[1][0] += 10;
  assert.notEqual(
    designFingerprint(outlineFingerprintFixture),
    outlineFingerprint,
    "native board-outline geometry must invalidate exact-revision evidence",
  );

  const placementRaw = placementFixture();
  const placementRecord = placementConstraintFixture(placementRaw);
  const placementClear = analyzePlacement(
    placementRaw,
    placementEvidenceFixture(placementRecord),
    { kind: "test-placement-clear" },
  );
  assert.equal(placementClear.status, PLACEMENT_STATUS.CLEAR);
  const placementViaIntrusionRaw = clone(placementRaw);
  placementViaIntrusionRaw.vias[0].x = 42;
  const placementViaIntrusion = analyzePlacement(
    placementViaIntrusionRaw,
    placementEvidenceFixture(placementConstraintFixture(placementViaIntrusionRaw)),
    { kind: "test-placement-via" },
  );
  assert.equal(placementViaIntrusion.status, PLACEMENT_STATUS.BLOCKED);
  assert.equal(placementViaIntrusion.checks.viaPad.violations[0].sameNet, true);
  assert.equal(placementViaIntrusion.checks.viaPad.violations[0].copperOverlap, true);
  assert.equal(
    placementViaIntrusion.checks.viaPad.violations[0].drillOverlap,
    true,
    "same-net drill intrusion into an ordinary switch pad must block placement",
  );

  const placementEnvelopeConflictRaw = clone(placementRaw);
  placementEnvelopeConflictRaw.components[1].x = 25;
  placementEnvelopeConflictRaw.components[1].bbox = {
    minX: -5,
    minY: -30,
    maxX: 55,
    maxY: 30,
  };
  const placementEnvelopeConflict = analyzePlacement(
    placementEnvelopeConflictRaw,
    placementEvidenceFixture(placementConstraintFixture(placementEnvelopeConflictRaw)),
    { kind: "test-placement-envelope-conflict" },
  );
  assert.equal(placementEnvelopeConflict.status, PLACEMENT_STATUS.BLOCKED);
  assert.equal(
    placementEnvelopeConflict.checks.componentPlacement.exactConflicts.length,
    1,
    "sourced assembly-envelope overlap must block placement",
  );

  const formalRaw = pcbFixture();
  const formalMissingPlacement = analyzeBaseline(
    formalRaw,
    parseBaselineArgs([]),
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalMissingPlacement.decision, BASELINE_DECISIONS.UNVERIFIED);
  assert.match(
    formalMissingPlacement.checks.unverified.join("\n"),
    /placement\/assembly closure/,
  );
  // Formal-review fixtures exercise real gating, so they must supply a
  // cleared gate ledger just as they supply a cleared placement audit. The
  // ledger must also be complete: a final audit runs when only the terminal
  // gate remains, since this audit's own report is that gate's evidence.
  const clearGateLedgerReport = {
    schemaVersion: 1,
    kind: "easyeda-gate-ledger",
    decision: "CLEARED",
    completion: "TERMINAL_PENDING",
    fabricationRelease: false,
    analysis: {
      branch: "new-construction",
      scope: "end-to-end",
      projectUuid: "self-test",
      completion: "TERMINAL_PENDING",
      completionAnalysis: {
        state: "TERMINAL_PENDING",
        terminalGate: "DESIGN_CLOSURE",
        remainingGates: ["DESIGN_CLOSURE"],
      },
      gates: [
        { gate: "COMPANION_READY", state: "CLOSED" },
      ],
      blocked: [],
      unverified: [],
    },
  };
  const formalLedgerOptions = {
    gateLedgerRecord: clearGateLedgerReport,
    gateLedger: "<gate-ledger-self-test>",
  };
  const clearPlacementArtifact = {
    schemaVersion: 3,
    kind: "easyeda-placement-audit",
    status: "PLACEMENT_CLEAR_FOR_ROUTING",
    fabricationRelease: false,
    design: {
      project: formalRaw.project,
      document: formalRaw.document,
      fingerprint: designFingerprint(formalRaw),
    },
    constraints: {
      revision: designFingerprint(formalRaw),
      recordFingerprint: `sha256:${"a".repeat(64)}`,
      consistencyGateStatus: "CLEARED_FOR_PLACEMENT",
    },
    checks: {
      boardContainment: {
        outerContour: { primitiveId: "outline-main", locked: true, pointCount: 4 },
        cutouts: [],
        padOutsideBoard: [],
        courtyardOutsideBoard: [],
        criticalZoneOutsideBoard: [],
        cutoutIntersections: [],
        violations: [],
        unverified: [],
      },
      viaPad: {
        violations: [],
        unsupportedPads: [],
        unsupportedVias: [],
      },
      componentPlacement: {
        exactConflicts: [],
        ownPadOutsideCourtyard: [],
        crossComponentPadConflicts: [],
        crossComponentPadClearanceViolations: [],
        padToForeignCourtyardConflicts: [],
        criticalZoneViolations: [],
        unsupportedPadOccupancy: [],
        unownedPads: [],
        componentIdentityConflicts: [],
        invalidEnvelopes: [],
        missingEnvelopeDesignators: [],
        missingOppositeSideCourtyardDesignators: [],
        missingPadstackProjectionEvidence: [],
        unresolvedBboxCandidates: [],
        criticalZoneUnverified: [],
      },
      humanInterfaces: { violations: [], unverified: [] },
      interfacesAndBom: { failures: [], unverified: [] },
    },
    coverage: {
      requiredAxes: [
        "boardMechanicalContainment",
        "viaPadGeometry",
        "componentOccupancy",
        "criticalPlacementZones",
        "humanInterfaces",
        "externalInterfacesAndBom",
      ],
      checkedAxes: [
        "boardMechanicalContainment",
        "viaPadGeometry",
        "componentOccupancy",
        "criticalPlacementZones",
        "humanInterfaces",
        "externalInterfacesAndBom",
      ],
      unverifiedAxes: [],
      notApplicable: [],
    },
    failures: [],
    unverified: [],
    stale: [],
  };
  const formalPlacementClear = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      ...formalLedgerOptions,
      placementAuditRecord: clearPlacementArtifact,
      placementAuditReport: "<placement-self-test>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalPlacementClear.decision, BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS);
  // An honest but unfinished ledger must not let clean upstream checks imply a
  // finished design. This is the failure this axis exists to catch: before it,
  // a slice that had closed two of ten gates could still reach a passing audit.
  const formalIncompleteLedger = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      gateLedger: "<gate-ledger-incomplete-self-test>",
      gateLedgerRecord: {
        ...clearGateLedgerReport,
        completion: "INCOMPLETE",
        analysis: {
          ...clearGateLedgerReport.analysis,
          completion: "INCOMPLETE",
          completionAnalysis: {
            state: "INCOMPLETE",
            terminalGate: "DESIGN_CLOSURE",
            remainingGates: ["FULL_ROUTING_CLEAR", "DESIGN_CLOSURE"],
          },
        },
      },
      placementAuditRecord: clearPlacementArtifact,
      placementAuditReport: "<placement-self-test>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalIncompleteLedger.decision, BASELINE_DECISIONS.UNVERIFIED);
  assert.match(
    formalIncompleteLedger.checks.unverified.join("\n"),
    /has not reached its terminal gate DESIGN_CLOSURE/,
  );
  // A ledger predating the completion axis cannot prove its slice finished, so
  // the absent field is unproven rather than permission.
  const formalLegacyLedger = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      gateLedger: "<gate-ledger-legacy-self-test>",
      gateLedgerRecord: {
        ...clearGateLedgerReport,
        completion: undefined,
        analysis: {
          ...clearGateLedgerReport.analysis,
          completion: undefined,
          completionAnalysis: undefined,
        },
      },
      placementAuditRecord: clearPlacementArtifact,
      placementAuditReport: "<placement-self-test>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalLegacyLedger.decision, BASELINE_DECISIONS.UNVERIFIED);
  const formalLegacyPlacement = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      ...formalLedgerOptions,
      placementAuditRecord: { ...clearPlacementArtifact, schemaVersion: 1 },
      placementAuditReport: "<placement-self-test-legacy>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalLegacyPlacement.decision, BASELINE_DECISIONS.UNVERIFIED);
  const formalMissingCoverage = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      ...formalLedgerOptions,
      placementAuditRecord: { ...clearPlacementArtifact, coverage: undefined },
      placementAuditReport: "<placement-self-test-missing-coverage>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalMissingCoverage.decision, BASELINE_DECISIONS.UNVERIFIED);
  const formalConflictingClearPlacement = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      ...formalLedgerOptions,
      placementAuditRecord: {
        ...clearPlacementArtifact,
        checks: {
          ...clearPlacementArtifact.checks,
          componentPlacement: {
            ...clearPlacementArtifact.checks.componentPlacement,
            ownPadOutsideCourtyard: [{ designator: "SW1", padNumber: "1" }],
          },
        },
      },
      placementAuditReport: "<placement-self-test-conflicting-clear>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalConflictingClearPlacement.decision, BASELINE_DECISIONS.FAIL);
  const formalExactConflictClearPlacement = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      ...formalLedgerOptions,
      placementAuditRecord: {
        ...clearPlacementArtifact,
        checks: {
          ...clearPlacementArtifact.checks,
          componentPlacement: {
            ...clearPlacementArtifact.checks.componentPlacement,
            exactConflicts: [{ firstDesignator: "SW1", secondDesignator: "U1" }],
          },
        },
      },
      placementAuditReport: "<placement-self-test-exact-conflict>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalExactConflictClearPlacement.decision, BASELINE_DECISIONS.FAIL);
  for (const [name, mutate, expectedDecision] of [
    [
      "via-violation",
      (artifact) => artifact.checks.viaPad.violations.push({ viaPrimitiveId: "via-1" }),
      BASELINE_DECISIONS.FAIL,
    ],
    [
      "missing-envelope",
      (artifact) => artifact.checks.componentPlacement.missingEnvelopeDesignators.push("U1"),
      BASELINE_DECISIONS.UNVERIFIED,
    ],
    [
      "unsupported-via",
      (artifact) => artifact.checks.viaPad.unsupportedVias.push({ primitiveId: "via-1" }),
      BASELINE_DECISIONS.UNVERIFIED,
    ],
    [
      "human-interface-violation",
      (artifact) => artifact.checks.humanInterfaces.violations.push({ groupId: "controls" }),
      BASELINE_DECISIONS.FAIL,
    ],
    [
      "interface-bom-failure",
      (artifact) => artifact.checks.interfacesAndBom.failures.push({ designator: "J1" }),
      BASELINE_DECISIONS.FAIL,
    ],
  ]) {
    const artifact = clone(clearPlacementArtifact);
    mutate(artifact);
    const result = analyzeBaseline(
      formalRaw,
      {
        ...parseBaselineArgs([]),
        ...formalLedgerOptions,
      ...formalLedgerOptions,
        placementAuditRecord: artifact,
        placementAuditReport: `<placement-self-test-${name}>`,
      },
      { kind: "formal-review-fixture" },
    );
    assert.equal(result.decision, expectedDecision, name);
  }
  const formalStaleConstraintPlacement = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      ...formalLedgerOptions,
      placementAuditRecord: {
        ...clearPlacementArtifact,
        constraints: {
          ...clearPlacementArtifact.constraints,
          revision: `sha256:${"b".repeat(64)}`,
        },
      },
      placementAuditReport: "<placement-self-test-stale-constraint>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalStaleConstraintPlacement.decision, BASELINE_DECISIONS.UNVERIFIED);
  const formalPlacementBlocked = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      ...formalLedgerOptions,
      placementAuditRecord: {
        ...clearPlacementArtifact,
        status: "BLOCKED",
        failures: ["component overlap"],
      },
      placementAuditReport: "<placement-self-test-blocked>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalPlacementBlocked.decision, BASELINE_DECISIONS.FAIL);

  // A formal review with clear placement but no gate ledger stays unverified.
  const formalMissingLedger = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      placementAuditRecord: clearPlacementArtifact,
      placementAuditReport: "<placement-self-test-no-ledger>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalMissingLedger.decision, BASELINE_DECISIONS.UNVERIFIED);
  assert.match(
    formalMissingLedger.checks.unverified.join(String.fromCharCode(10)),
    /live gate-sequence evidence is missing/,
  );
  // A blocked ledger is a hard failure, not a missing-evidence case.
  const formalBlockedLedger = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      placementAuditRecord: clearPlacementArtifact,
      placementAuditReport: "<placement-self-test-blocked-ledger>",
      gateLedgerRecord: {
        ...clearGateLedgerReport,
        decision: "BLOCKED",
        analysis: {
          ...clearGateLedgerReport.analysis,
          blocked: ["PCB_SYNC_MATCH was never closed"],
        },
      },
      gateLedger: "<gate-ledger-self-test-blocked>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalBlockedLedger.decision, BASELINE_DECISIONS.FAIL);
  // A ledger bound to another project cannot clear this one.
  const formalForeignLedger = analyzeBaseline(
    formalRaw,
    {
      ...parseBaselineArgs([]),
      placementAuditRecord: clearPlacementArtifact,
      placementAuditReport: "<placement-self-test-foreign-ledger>",
      gateLedgerRecord: {
        ...clearGateLedgerReport,
        analysis: {
          ...clearGateLedgerReport.analysis,
          projectUuid: "other-project",
        },
      },
      gateLedger: "<gate-ledger-self-test-foreign>",
    },
    { kind: "formal-review-fixture" },
  );
  assert.equal(formalForeignLedger.decision, BASELINE_DECISIONS.UNVERIFIED);
  const baseline = analyzeBaseline(
    pcbFixture(),
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(baseline.decision, BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS);
  assert.equal(baseline.fabricationRelease, false);
  assert.equal(baseline.manufacturingOutputsReviewed, false);
  assert.equal(baseline.checks.drc.evidenceVerified, true);
  assert.ok(baseline.coverage.requiredAxes.includes("boardMechanicalContainment"));
  assert.deepEqual(baseline.coverage.unverifiedAxes, []);
  assert.equal(baseline.checks.drc.ruleBinding.stable, true);
  assert.equal(
    baseline.constraints.drcRuleBinding.fingerprint,
    baseline.checks.drc.ruleBinding.fingerprint,
  );
  assert.match(baseline.design.evidenceBindingFingerprint, /^sha256:/);
  assert.deepEqual(
    baseline.checks.drc.repeatability.observedSampleIds,
    ["silent-1", "silent-2", "visible-final"],
  );
  assert.ok(!Object.hasOwn(BASELINE_DECISIONS, "PASS"));
  assert.ok(!Object.hasOwn(DECISIONS, "PASS"));

  const missingDrcEvidenceFixture = pcbFixture();
  delete missingDrcEvidenceFixture.drcEvidence;
  const missingDrcEvidence = analyzeBaseline(
    missingDrcEvidenceFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(
    missingDrcEvidence.decision,
    BASELINE_DECISIONS.UNVERIFIED,
  );
  assert.equal(missingDrcEvidence.checks.drc.passed, true);
  assert.equal(missingDrcEvidence.checks.drc.evidenceVerified, false);
  assert.match(
    missingDrcEvidence.checks.unverified.join("\n"),
    /DRC evidence is not closure-grade/,
  );

  const changedRuleFixture = pcbFixture();
  bindPcbDrcEvidence(changedRuleFixture, {
    ruleAfter: {
      name: "Self Test Two Layer Rules",
      configuration: { clearance: { trackToTrack: 0.1524 } },
    },
  });
  const changedRule = analyzeBaseline(
    changedRuleFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(changedRule.decision, BASELINE_DECISIONS.UNVERIFIED);
  assert.equal(changedRule.checks.drc.ruleBinding.stable, false);
  assert.match(changedRule.checks.drc.ruleBinding.reason, /changed/);

  const clearanceLeaf = {
    errorType: "Clearance Error",
    errorObjType: "Track-to-Via",
    ruleName: "Clearance",
    globalIndex: "volatile-1",
    objs: ["via-gnd", "track-en"],
    explanation: {
      errData: {
        actual: 0.137,
        required: 0.1524,
        obj1: "track-en",
        obj2: "via-gnd",
      },
    },
  };
  const clearanceResult = [
    { name: "Clearance Error", list: [clearanceLeaf] },
  ];
  const repeatedClearanceFixture = pcbFixture();
  bindPcbDrcEvidence(repeatedClearanceFixture, {
    results: [
      clearanceResult,
      [
        {
          name: "Clearance Error",
          list: [{ ...clearanceLeaf, globalIndex: "volatile-2", objs: ["track-en", "via-gnd"] }],
        },
      ],
      clearanceResult,
    ],
  });
  const repeatedClearance = analyzeBaseline(
    repeatedClearanceFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(repeatedClearance.decision, BASELINE_DECISIONS.FAIL);
  assert.equal(repeatedClearance.checks.drc.evidenceVerified, true);
  assert.equal(repeatedClearance.checks.drc.errorCount, 1);
  assert.deepEqual(
    repeatedClearance.checks.drc.observedNonPassingSampleIds,
    ["silent-1", "silent-2", "visible-final"],
  );

  const inconsistentDrcFixture = pcbFixture();
  bindPcbDrcEvidence(inconsistentDrcFixture, {
    results: [clearanceResult, [], []],
  });
  const inconsistentDrc = analyzeBaseline(
    inconsistentDrcFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(inconsistentDrc.decision, BASELINE_DECISIONS.FAIL);
  assert.equal(inconsistentDrc.checks.drc.evidenceVerified, false);
  assert.equal(inconsistentDrc.checks.drc.repeatability.stableLeafSet, false);
  assert.deepEqual(
    inconsistentDrc.checks.drc.observedNonPassingSampleIds,
    ["silent-1"],
  );

  const schematicWarningsOnly = analyzeBaseline(
    {
      kind: "schematic",
      project: { uuid: "self-test", name: "Self Test" },
      document: { uuid: "sch", name: "Schematic", documentType: 1 },
      components: [
        {
          primitiveId: "u1",
          designator: "U1",
          name: "MCU",
          addIntoPcb: true,
          footprint: { libraryUuid: "lib", uuid: "fp" },
        },
      ],
      wireCount: 1,
      drc: [{ type: "warn", count: 3 }],
    },
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(
    schematicWarningsOnly.decision,
    BASELINE_DECISIONS.UNVERIFIED,
  );
  assert.equal(schematicWarningsOnly.checks.drc.warningCount, 3);
  assert.equal(schematicWarningsOnly.checks.drc.errorCount, 0);
  assert.ok(schematicWarningsOnly.coverage.requiredAxes.includes("symbolPlacement"));
  assert.ok(schematicWarningsOnly.coverage.unverifiedAxes.includes("presentationGeometry"));

  const degradedPresentationRaw = schematicFixture();
  degradedPresentationRaw.components = Array.from({ length: 22 }, (_, index) => ({
    primitiveId: `part-${index + 1}`,
    designator: `U${index + 1}`,
    name: "Part",
    addIntoPcb: true,
    footprint: { libraryUuid: "lib", uuid: `fp-${index + 1}` },
  }));
  degradedPresentationRaw.schematicAnnotations = Array.from(
    { length: 37 },
    (_, index) => ({
      primitiveId: `netport-${index + 1}`,
      componentType: "netport",
      net: `NET_${index + 1}`,
    }),
  );
  degradedPresentationRaw.schematicWires = Array.from(
    { length: 113 },
    (_, index) => ({
      primitiveId: `stub-${index + 1}`,
      net: `NET_${(index % 37) + 1}`,
      line: [index * 20, 0, index * 20 + 10, 0],
    }),
  );
  degradedPresentationRaw.wireCount =
    degradedPresentationRaw.schematicWires.length;
  const degradedPresentation = analyzeBaseline(
    degradedPresentationRaw,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(degradedPresentation.decision, BASELINE_DECISIONS.FAIL);
  assert.equal(
    degradedPresentation.checks.presentation.status,
    "DEGRADED_LABEL_STUB_PATTERN",
  );
  assert.equal(degradedPresentation.checks.presentation.metrics.shortStubCount, 113);
  assert.equal(
    analyzeSchematicPresentation(degradedPresentationRaw).blocking,
    true,
  );

  // Symbol placement is the second presentation axis: a page can have clean
  // wiring and still stack symbols or run them off the sheet.
  const placementEnvelope = schematicPageEnvelopeFixture();
  const secondSymbol = (overrides = {}) => ({
    primitiveId: "c1",
    designator: "C1",
    name: "100nF",
    addIntoPcb: true,
    footprint: { libraryUuid: "lib", uuid: "fp-c", name: "C0402" },
    x: 800,
    y: 600,
    rotation: 90,
    bbox: { minX: 780, minY: 580, maxX: 820, maxY: 620 },
    ...overrides,
  });
  const withSecondSymbol = (overrides) => {
    const raw = schematicFixture();
    raw.components.push(secondSymbol(overrides));
    return raw;
  };

  const clearPlacement = analyzeSchematicPlacement(
    withSecondSymbol(),
    placementEnvelope,
  );
  assert.equal(clearPlacement.status, "CLEAR");
  assert.equal(clearPlacement.blocking, false);
  assert.deepEqual(clearPlacement.unresolved, []);

  // No envelope: stacking is still decidable, page overrun is not, and the
  // missing bound must read as unscreened rather than cleared.
  const noEnvelope = analyzeSchematicPlacement(withSecondSymbol(), null);
  assert.equal(noEnvelope.status, "UNVERIFIED");
  assert.equal(noEnvelope.blocking, false);
  assert.equal(noEnvelope.envelopeViolations.length, 0);
  assert.ok(
    noEnvelope.unresolved.some((entry) =>
      entry.includes("no schematic page envelope was declared"),
    ),
  );

  const stackedRaw = withSecondSymbol({
    x: 200,
    y: 200,
    bbox: { minX: 160, minY: 160, maxX: 240, maxY: 240 },
  });
  const stacked = analyzeSchematicPlacement(stackedRaw, placementEnvelope);
  assert.equal(stacked.status, "DEGRADED_SYMBOL_PLACEMENT");
  assert.equal(stacked.blocking, true);
  assert.equal(stacked.coincidentPoseGroups.length, 1);
  assert.deepEqual(stacked.coincidentPoseGroups[0].designators, ["U1", "C1"]);
  assert.equal(stacked.bboxOverlaps.length, 1);
  // Stacking is blocking without an envelope too, since it needs no page bound.
  assert.equal(analyzeSchematicPlacement(stackedRaw, null).blocking, true);
  const offPageRaw = withSecondSymbol({
    primitiveId: "r1",
    designator: "R1",
    name: "10k",
    footprint: { libraryUuid: "lib", uuid: "fp-r", name: "R0402" },
    x: 1400,
    y: 600,
    rotation: 0,
    bbox: { minX: 1380, minY: 580, maxX: 1420, maxY: 620 },
  });
  const offPage = analyzeSchematicPlacement(offPageRaw, placementEnvelope);
  assert.equal(offPage.status, "DEGRADED_SYMBOL_PLACEMENT");
  assert.equal(offPage.envelopeViolations.length, 1);
  assert.equal(offPage.envelopeViolations[0].designator, "R1");
  assert.equal(offPage.envelopeViolations[0].originOutside, true);
  assert.equal(offPage.envelopeViolations[0].extentOutside, true);

  // A symbol whose origin is inside the bound but whose extent is not is still a
  // page overrun: the reader sees the clipped body and text, not the origin.
  const extentOnlyRaw = withSecondSymbol({
    x: 990,
    bbox: { minX: 970, minY: 580, maxX: 1010, maxY: 620 },
  });
  const extentOnly = analyzeSchematicPlacement(extentOnlyRaw, placementEnvelope);
  assert.equal(extentOnly.status, "DEGRADED_SYMBOL_PLACEMENT");
  assert.equal(extentOnly.envelopeViolations.length, 1);
  assert.equal(extentOnly.envelopeViolations[0].originOutside, false);
  assert.equal(extentOnly.envelopeViolations[0].extentOutside, true);

  // A stale envelope naming another page proves nothing about this one.
  const staleEnvelope = analyzeSchematicPlacement(offPageRaw, {
    ...placementEnvelope,
    documentUuid: "other-page",
  });
  assert.equal(staleEnvelope.status, "UNVERIFIED");
  assert.equal(staleEnvelope.blocking, false);
  assert.equal(staleEnvelope.envelopeViolations.length, 0);
  assert.equal(staleEnvelope.pageEnvelope.boundToActiveDocument, false);
  // Crowding into one corner: no two boxes intersect, no pose repeats, and the
  // page is still unusable. Review evidence, not a blocking finding.
  const crowdedRaw = schematicFixture();
  crowdedRaw.components = Array.from({ length: 9 }, (_, index) => ({
    primitiveId: `part-${index + 1}`,
    designator: `U${index + 1}`,
    name: "Part",
    addIntoPcb: true,
    footprint: { libraryUuid: "lib", uuid: `fp-${index + 1}` },
    x: 20 + index * 5,
    y: 20 + index * 5,
    rotation: 0,
    bbox: {
      minX: 19 + index * 5,
      minY: 19 + index * 5,
      maxX: 20 + index * 5,
      maxY: 20 + index * 5,
    },
  }));
  const crowded = analyzeSchematicPlacement(crowdedRaw, placementEnvelope);
  assert.equal(crowded.status, "REVIEW_REQUIRED");
  assert.equal(crowded.blocking, false);
  assert.equal(crowded.requiresVisualReview, true);
  assert.equal(crowded.metrics.clusteredIntoCorner, true);

  // Unavailable BBox readback leaves crowding and containment unscreened rather
  // than clear, since the beta BBox call can fail per primitive.
  const missingBbox = analyzeSchematicPlacement(
    withSecondSymbol({ bbox: null }),
    placementEnvelope,
  );
  assert.equal(missingBbox.status, "UNVERIFIED");
  assert.deepEqual(missingBbox.unresolvedBboxDesignators, ["C1"]);

  // Non-finite coordinates must not be coerced to the page origin.
  const missingPosition = analyzeSchematicPlacement(
    withSecondSymbol({ x: null }),
    placementEnvelope,
  );
  assert.equal(missingPosition.status, "UNVERIFIED");
  assert.deepEqual(missingPosition.missingPositionDesignators, ["C1"]);
  assert.equal(missingPosition.coincidentPoseGroups.length, 0);
  // Baseline wiring: both blocking placement signatures must reach the audit
  // decision, and a clean wiring screen must not absorb them.
  const placementOptions = {
    ...parseBaselineArgs([]),
    schematicPageEnvelopeRecord: placementEnvelope,
  };
  const stackedBaseline = analyzeBaseline(stackedRaw, placementOptions, {
    kind: "test",
  });
  assert.equal(stackedBaseline.decision, BASELINE_DECISIONS.FAIL);
  assert.equal(
    stackedBaseline.checks.symbolPlacement.status,
    "DEGRADED_SYMBOL_PLACEMENT",
  );
  assert.ok(
    stackedBaseline.failures.some((entry) =>
      entry.includes("share coordinates instead of holding deliberate poses"),
    ),
  );
  assert.equal(stackedBaseline.checks.presentation.status, "CLEAR");

  const offPageBaseline = analyzeBaseline(offPageRaw, placementOptions, {
    kind: "test",
  });
  assert.equal(offPageBaseline.decision, BASELINE_DECISIONS.FAIL);
  assert.ok(
    offPageBaseline.failures.some((entry) =>
      entry.includes("outside the declared drawable page area"),
    ),
  );

  // An absent envelope keeps an otherwise clean schematic unverified.
  const noEnvelopeBaseline = analyzeBaseline(
    schematicFixture(),
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(noEnvelopeBaseline.decision, BASELINE_DECISIONS.UNVERIFIED);
  assert.ok(
    noEnvelopeBaseline.unverified.some((entry) =>
      entry.includes("no schematic page envelope was declared"),
    ),
  );
  // Envelope record contract. Each rejection is a case where accepting the
  // record would let a guessed or mismatched bound produce a blocking finding.
  const validEnvelopeRecord = {
    kind: "easyeda-schematic-page-envelope",
    schemaVersion: 1,
    unit: "10mil",
    documentUuid: "sch",
    source: "A4 landscape frame minus title block",
    envelope: { minX: 0, minY: 0, maxX: 1000, maxY: 800 },
  };
  assert.equal(
    validateSchematicPageEnvelope(validEnvelopeRecord, "/tmp/envelope.json")
      .envelope.maxX,
    1000,
  );
  for (const [mutation, pattern] of [
    [{ kind: "wrong" }, /easyeda-schematic-page-envelope/],
    [{ schemaVersion: 2 }, /schemaVersion 1/],
    [{ unit: "mil" }, /10mil/],
    [{ documentUuid: "" }, /documentUuid/],
    [{ source: "" }, /requires a source/],
    [{ envelope: { minX: 100, minY: 0, maxX: 100, maxY: 800 } }, /maxX > minX/],
    [{ envelope: { minX: 0, minY: 0, maxX: 1000 } }, /finite maxY/],
  ]) {
    assert.throws(
      () =>
        validateSchematicPageEnvelope(
          { ...validEnvelopeRecord, ...mutation },
          null,
        ),
      pattern,
    );
  }

  const baselinePreserveSilosFixture = pcbFixture();
  baselinePreserveSilosFixture.pours[0].preserveSilos = true;
  baselinePreserveSilosFixture.pours[0].solidFillIds = ["fill-connected"];
  const baselinePreserveSilosPass = analyzeBaseline(
    baselinePreserveSilosFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(baselinePreserveSilosPass.checks.validGroundPour, true);
  assert.equal(
    baselinePreserveSilosPass.checks.pours[0].preserveSilosStateIgnored,
    true,
  );

  const partialFillEvidence = analyzePourConnectivity({
    hasCopper: true,
    fillCount: 2,
    solidFillCount: 2,
    solidFillIds: ["fill-connected"],
    preserveSilos: false,
  });
  assert.equal(partialFillEvidence.passed, false);
  assert.equal(
    partialFillEvidence.islandStatus,
    "UNVERIFIED_SOLID_FILL_ID_COVERAGE",
  );

  const freeCopperLeaves = [
    {
      errorType: "No Connection",
      isFree: true,
      objs: ["fill-free"],
      explanation: { errData: { obj1: "fill-free", obj2: "fill-peer" } },
    },
  ];
  const freeCopperIds = freeCopperPrimitiveIds(freeCopperLeaves);
  assert.deepEqual(
    [...freeCopperIds].sort(),
    ["fill-free"],
  );
  const freeCopperPour = analyzePourConnectivity(
    {
      hasCopper: true,
      fillCount: 2,
      solidFillCount: 2,
      solidFillIds: ["fill-connected", "fill-free"],
      preserveSilos: false,
    },
    freeCopperIds,
  );
  assert.equal(freeCopperPour.passed, false);
  assert.equal(freeCopperPour.islandStatus, "FREE_COPPER_DETECTED");
  assert.deepEqual(freeCopperPour.freeSolidFillIds, ["fill-free"]);

  const baselineFreeCopperFixture = pcbFixture();
  baselineFreeCopperFixture.pours[0].solidFillIds = ["fill-free"];
  baselineFreeCopperFixture.drc = [
    {
      name: "Connection Error",
      list: [
        {
          errorType: "No Connection",
          isFree: true,
          objs: ["fill-free"],
        },
      ],
    },
  ];
  bindPcbDrcEvidence(baselineFreeCopperFixture);
  const baselineFreeCopperFail = analyzeBaseline(
    baselineFreeCopperFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(baselineFreeCopperFail.decision, BASELINE_DECISIONS.FAIL);
  assert.equal(baselineFreeCopperFail.checks.pours[0].passed, false);
  assert.equal(
    baselineFreeCopperFail.checks.pours[0].islandStatus,
    "FREE_COPPER_DETECTED",
  );

  const baselineNativeCacheFixture = pcbFixture();
  baselineNativeCacheFixture.drc = [
    {
      name: "Netlist Error",
      list: [
        {
          errorType: "Netlist Error",
          errorObjType: "Netlist Error",
          ruleName: "Import Changes",
          globalIndex: "err-native-cache",
        },
      ],
    },
  ];
  bindPcbDrcEvidence(baselineNativeCacheFixture);
  const baselineNativeCachePass = analyzeBaseline(
    baselineNativeCacheFixture,
    {
      ...parseBaselineArgs([]),
      nativeNetlistCacheException: {
        reason: "self-test native cache mismatch",
        artifactPath: "<self-test>",
        artifact: {
          kind: "easyeda-manufacturing-netlist-comparison",
          pcbUuid: "pcb",
          comparisonMatch: true,
        },
      },
    },
    { kind: "test" },
  );
  assert.equal(baselineNativeCachePass.checks.drc.passedWithExceptions, true);
  assert.equal(
    baselineNativeCachePass.decision,
    BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS,
  );
  assert.ok(baselineNativeCachePass.checks.drc.rawErrors.length > 0);

  const strictCacheArtifact = {
    kind: "easyeda-manufacturing-netlist-comparison",
    decision: "MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION",
    manufacturingDecision: "MATCH",
    fabricationRelease: false,
    project: { uuid: "self-test" },
    schematic: { uuid: "sch" },
    pcb: { uuid: "pcb" },
    comparison: { match: true },
    pcbDataPlaneIntegrity: { match: true },
    nativeFileComparison: [],
    nativeCacheException: {
      status: "VERIFIED",
      issues: [],
      interpretation: "self-test verified native cache false negative",
    },
  };
  const strictCacheException = validateNetlistCompareExceptionArtifact(
    strictCacheArtifact,
    "<strict-self-test>",
  );
  const strictCachePass = analyzeBaseline(
    baselineNativeCacheFixture,
    {
      ...parseBaselineArgs([]),
      nativeNetlistCacheException: strictCacheException,
    },
    { kind: "test" },
  );
  assert.equal(strictCachePass.checks.drc.passedWithExceptions, true);
  assert.equal(strictCachePass.checks.drc.rawErrorCount, 1);

  assert.throws(
    () =>
      validateNetlistCompareExceptionArtifact(
        {
          ...strictCacheArtifact,
          pcbDataPlaneIntegrity: { match: false },
        },
        "<weak-self-test>",
      ),
    /complete verified native-cache-exception contract/,
  );
  const wrongProjectException = validateNetlistCompareExceptionArtifact(
    {
      ...strictCacheArtifact,
      project: { uuid: "different-project" },
    },
    "<wrong-project-self-test>",
  );
  const strictCacheWrongProject = analyzeBaseline(
    baselineNativeCacheFixture,
    {
      ...parseBaselineArgs([]),
      nativeNetlistCacheException: wrongProjectException,
    },
    { kind: "test" },
  );
  assert.equal(strictCacheWrongProject.decision, BASELINE_DECISIONS.FAIL);
  assert.match(
    strictCacheWrongProject.checks.drc.exceptionRejected,
    /does not match active project/,
  );
  const baselineNativeCachePlusRealError = clone(baselineNativeCacheFixture);
  baselineNativeCachePlusRealError.drc.push({
    errorType: "Clearance Error",
    errorObjType: "Track",
    ruleName: "Clearance",
  });
  bindPcbDrcEvidence(baselineNativeCachePlusRealError);
  const baselineNativeCacheRejected = analyzeBaseline(
    baselineNativeCachePlusRealError,
    {
      ...parseBaselineArgs([]),
      nativeNetlistCacheException: {
        reason: "self-test native cache mismatch",
        artifactPath: "<self-test>",
        artifact: { pcbUuid: "pcb" },
      },
    },
    { kind: "test" },
  );
  assert.equal(baselineNativeCacheRejected.decision, BASELINE_DECISIONS.FAIL);

  assert.throws(
    () => parseBaselineArgs(["--allow-no-ground-pour"]),
    /exception-note/,
  );
  assert.throws(
    () => parseBaselineArgs(["--allow-routing-cycle", "3V3"]),
    /exception-note/,
  );
  assert.throws(
    () => parseBaselineArgs(["--allow-sharp-right-angle"]),
    /exception-note/,
  );

  const sharpCornerFixture = pcbFixture();
  sharpCornerFixture.lines.push(
    {
      primitiveId: "sharp-horizontal",
      net: "SIGNAL",
      layer: 1,
      startX: 200,
      startY: 200,
      endX: 300,
      endY: 200,
    },
    {
      primitiveId: "sharp-vertical",
      net: "SIGNAL",
      layer: 1,
      startX: 300,
      startY: 200,
      endX: 300,
      endY: 300,
    },
  );
  const sharpCornerReport = analyzeBaseline(
    sharpCornerFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(sharpCornerReport.decision, BASELINE_DECISIONS.FAIL);
  assert.equal(sharpCornerReport.checks.sharpRightAngleCorners.count, 1);
  assert.equal(
    sharpCornerReport.checks.routingLayerUsage[0].segmentCount,
    3,
  );
  assert.deepEqual(
    sharpCornerReport.checks.sharpRightAngleCorners.corners[0].primitiveIds,
    ["sharp-horizontal", "sharp-vertical"],
  );

  const allowedSharpCornerReport = analyzeBaseline(
    sharpCornerFixture,
    parseBaselineArgs([
      "--allow-sharp-right-angle",
      "--exception-note",
      "reviewed connector fanout corner",
    ]),
    { kind: "test" },
  );
  assert.equal(
    allowedSharpCornerReport.decision,
    BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS,
  );

  const chamferedFixture = pcbFixture();
  chamferedFixture.lines.push(
    {
      primitiveId: "chamfer-horizontal",
      net: "SIGNAL",
      layer: 1,
      startX: 200,
      startY: 200,
      endX: 280,
      endY: 200,
    },
    {
      primitiveId: "chamfer-diagonal",
      net: "SIGNAL",
      layer: 1,
      startX: 280,
      startY: 200,
      endX: 300,
      endY: 220,
    },
    {
      primitiveId: "chamfer-vertical",
      net: "SIGNAL",
      layer: 1,
      startX: 300,
      startY: 220,
      endX: 300,
      endY: 300,
    },
  );
  const chamferedReport = analyzeBaseline(
    chamferedFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(
    chamferedReport.decision,
    BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS,
  );
  assert.equal(chamferedReport.checks.sharpRightAngleCorners.count, 0);

  const padJunctionFixture = clone(sharpCornerFixture);
  padJunctionFixture.pads = [
    {
      primitiveId: "u1-pad1",
      net: "SIGNAL",
      layer: 1,
      x: 300,
      y: 200,
      rotation: 0,
      pad: ["RECT", 40, 40, 0],
    },
  ];
  const padJunctionReport = analyzeBaseline(
    padJunctionFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(
    padJunctionReport.decision,
    BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS,
  );
  assert.equal(padJunctionReport.checks.sharpRightAngleCorners.count, 0);

  const nearFortyFiveFixture = pcbFixture();
  nearFortyFiveFixture.lines.push({
    primitiveId: "near-45",
    net: "SIGNAL",
    layer: 1,
    startX: 0,
    startY: 50,
    endX: 1000,
    endY: 1049,
  });
  const nearFortyFiveReport = analyzeBaseline(
    nearFortyFiveFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(nearFortyFiveReport.checks.nonStandardAngles.length, 0);

  const routingCycleFixture = pcbFixture();
  routingCycleFixture.lines.push(
    {
      primitiveId: "loop-top",
      net: "3V3",
      layer: 1,
      startX: 200,
      startY: 200,
      endX: 300,
      endY: 200,
    },
    {
      primitiveId: "loop-right",
      net: "3V3",
      layer: 1,
      startX: 300,
      startY: 200,
      endX: 300,
      endY: 300,
    },
    {
      primitiveId: "loop-bottom",
      net: "3V3",
      layer: 1,
      startX: 300,
      startY: 300,
      endX: 200,
      endY: 300,
    },
    {
      primitiveId: "loop-left",
      net: "3V3",
      layer: 1,
      startX: 200,
      startY: 300,
      endX: 200,
      endY: 200,
    },
  );
  const routingCycleReport = analyzeBaseline(
    routingCycleFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(routingCycleReport.decision, BASELINE_DECISIONS.FAIL);
  assert.deepEqual(
    routingCycleReport.checks.routingTopology.unexpectedCycles,
    ["3V3"],
  );
  const routingCycleNet =
    routingCycleReport.checks.routingTopology.nets.find(
      (item) => item.net === "3V3",
    );
  assert.equal(routingCycleNet.cyclomaticNumber, 1);
  assert.equal(routingCycleNet.cycleWitnesses[0].edgeCount, 4);

  const allowedRoutingCycleReport = analyzeBaseline(
    routingCycleFixture,
    parseBaselineArgs([
      "--allow-routing-cycle",
      "3V3",
      "--allow-sharp-right-angle",
      "--exception-note",
      "intentional ring feed reviewed for current sharing",
    ]),
    { kind: "test" },
  );
  assert.equal(
    allowedRoutingCycleReport.decision,
    BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS,
  );
  assert.deepEqual(
    allowedRoutingCycleReport.checks.routingTopology.allowedCycles,
    ["3V3"],
  );

  const hsHintFixture = pcbFixture();
  hsHintFixture.lines.push({
    primitiveId: "pcie",
    net: "PCIE_RX0_P",
    layer: 1,
    startX: 0,
    startY: 40,
    endX: 80,
    endY: 40,
  });
  const hsHintReport = analyzeBaseline(
    hsHintFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(hsHintReport.decision, BASELINE_DECISIONS.UNVERIFIED);
  assert.deepEqual(hsHintReport.checks.hintedHighSpeedNets, ["PCIE_RX0_P"]);

  const unroutedHighSpeedFixture = pcbFixture();
  unroutedHighSpeedFixture.netNames = ["3V3", "GND", "USB_DP", "USB_DM"];
  const unroutedHighSpeedReport = analyzeBaseline(
    unroutedHighSpeedFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(
    unroutedHighSpeedReport.decision,
    BASELINE_DECISIONS.UNVERIFIED,
  );
  assert.deepEqual(
    new Set(unroutedHighSpeedReport.checks.hintedHighSpeedNets),
    new Set(["USB_DP", "USB_DM"]),
  );

  const explicitConstraintFixture = pcbFixture();
  explicitConstraintFixture.netNames = ["3V3", "GND", "MYSTERY_A", "MYSTERY_B"];
  const explicitConstraintOptions = {
    ...parseBaselineArgs([]),
    highSpeedConstraintRecord: {
      classification: "CONTROLLED_HIGH_SPEED",
      interfaces: [
        {
          name: "custom-link",
          nets: ["MYSTERY_A", "MYSTERY_B"],
        },
      ],
    },
  };
  const explicitConstraintReport = analyzeBaseline(
    explicitConstraintFixture,
    explicitConstraintOptions,
    { kind: "test" },
  );
  assert.equal(
    explicitConstraintReport.decision,
    BASELINE_DECISIONS.UNVERIFIED,
  );
  assert.deepEqual(
    new Set(explicitConstraintReport.checks.hintedHighSpeedNets),
    new Set(["MYSTERY_A", "MYSTERY_B"]),
  );
  assert.ok(
    explicitConstraintReport.checks.highSpeedDiscovery.candidates.every(
      (item) => item.sources.includes("constraint-record"),
    ),
  );
  const missingDeclaredOptions = {
    ...parseBaselineArgs([]),
    highSpeedConstraintRecord: {
      classification: "CONTROLLED_HIGH_SPEED",
      interfaces: [{ name: "custom-link", nets: ["ABSENT_FAST_NET"] }],
    },
  };
  const missingDeclaredReport = analyzeBaseline(
    pcbFixture(),
    missingDeclaredOptions,
    { kind: "test" },
  );
  assert.equal(
    missingDeclaredReport.decision,
    BASELINE_DECISIONS.UNVERIFIED,
  );
  assert.deepEqual(
    missingDeclaredReport.checks.highSpeedDiscovery.missingDeclaredNets,
    ["ABSENT_FAST_NET"],
  );

  const sidebandOnlyFixture = pcbFixture();
  sidebandOnlyFixture.netNames = [
    "3V3",
    "GND",
    "HDMI_CEC",
    "PCIE_RST_N",
    "USB3_VBUS",
  ];
  const sidebandOnlyReport = analyzeBaseline(
    sidebandOnlyFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(
    sidebandOnlyReport.decision,
    BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS,
  );
  assert.deepEqual(sidebandOnlyReport.checks.hintedHighSpeedNets, []);

  const crystalHintFixture = pcbFixture();
  crystalHintFixture.lines.push({
    primitiveId: "xtal",
    net: "MCU_OSC_IN",
    layer: 1,
    startX: 0,
    startY: 60,
    endX: 80,
    endY: 60,
  });
  const crystalHintReport = analyzeBaseline(
    crystalHintFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(crystalHintReport.decision, BASELINE_DECISIONS.UNVERIFIED);
  assert.deepEqual(crystalHintReport.checks.hintedCrystalNets, ["MCU_OSC_IN"]);

  const tempDir = mkdtempSync(path.join(tmpdir(), "easyeda-audit-"));
  try {
    const selectionRaw = schematicFixture();
    selectionRaw.components[0] = {
      ...selectionRaw.components[0],
      manufacturer: "Example Semiconductor",
      manufacturerPartNumber: "EXAMPLE-MCU-1",
      footprint: { libraryUuid: "lib", uuid: "fp", name: "LQFP48" },
    };
    const selectionPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n",
    );
    const selectionPdfPath = path.join(tempDir, "selection.pdf");
    writeFileSync(selectionPdfPath, selectionPdf);
    const selectionRecord = componentEvidenceRecord(
      selectionRaw,
      selectionPdfPath,
      selectionPdf,
    );
    const selectionResult = validateComponentEvidenceRecord(
      selectionRecord,
      selectionRaw,
      { baseDir: tempDir },
    );
    assert.equal(selectionResult.cleared, true);

    const incompleteParameterCoverage = clone(selectionRecord);
    incompleteParameterCoverage.parts[0].parameterCoverage =
      incompleteParameterCoverage.parts[0].parameterCoverage.filter(
        (coverage) => coverage.aspect !== "TIMING_FREQUENCY",
      );
    const incompleteParameterCoverageResult = validateComponentEvidenceRecord(
      incompleteParameterCoverage,
      selectionRaw,
      { baseDir: tempDir },
    );
    assert.equal(
      incompleteParameterCoverageResult.decision,
      BASELINE_DECISIONS.UNVERIFIED,
    );
    assert.match(
      incompleteParameterCoverageResult.unverified.join("\n"),
      /parameterCoverage is missing TIMING_FREQUENCY/,
    );

    const inadequateSelection = clone(selectionRecord);
    inadequateSelection.designRequirements.find(
      (requirement) => requirement.id === "rail_max_v",
    ).value = 4.2;
    const inadequateResult = validateComponentEvidenceRecord(
      inadequateSelection,
      selectionRaw,
      { baseDir: tempDir },
    );
    assert.equal(inadequateResult.decision, BASELINE_DECISIONS.FAIL);
    assert.match(inadequateResult.violations.join("\n"), /does not contain required range/);

    const legacySelection = clone(selectionRecord);
    legacySelection.schemaVersion = 1;
    const legacyResult = validateComponentEvidenceRecord(
      legacySelection,
      selectionRaw,
      { baseDir: tempDir },
    );
    assert.equal(legacyResult.decision, BASELINE_DECISIONS.UNVERIFIED);
    assert.match(legacyResult.unverified.join("\n"), /traceability only/);

    const blockedLibrary = clone(selectionRecord);
    blockedLibrary.parts[0].libraryBinding = {
      resolution: "BLOCKED",
      substitutionPolicy: "FORBID",
      requestedManufacturerPartNumber: "EXAMPLE-MCU-1",
      selectedManufacturerPartNumber: "EXAMPLE-MCU-1",
      reason: "exact device is absent and custom qualification is incomplete",
    };
    const blockedLibraryResult = validateComponentEvidenceRecord(
      blockedLibrary,
      selectionRaw,
      { baseDir: tempDir },
    );
    assert.equal(blockedLibraryResult.decision, BASELINE_DECISIONS.UNVERIFIED);
    assert.match(blockedLibraryResult.unverified.join("\n"), /library binding is BLOCKED/);

    const forbiddenSubstitute = clone(selectionRecord);
    forbiddenSubstitute.parts[0].libraryBinding = {
      ...forbiddenSubstitute.parts[0].libraryBinding,
      resolution: "APPROVED_SUBSTITUTE",
      substitutionPolicy: "FORBID",
      requestedManufacturerPartNumber: "ORIGINAL-MCU-1",
      reason: "test unauthorized substitution",
      approvalReference: "MISSING-VALID-AUTHORIZATION",
      candidateComparisonArtifact: selectionPdfPath,
      comparison: {
        electrical: "MATCH",
        pinout: "MATCH",
        package: "MATCH",
        footprint: "MATCH",
        thermal: "MATCH",
        mechanical: "MATCH",
        firmware: "MATCH",
        regulatory: "MATCH",
      },
    };
    const forbiddenSubstituteResult = validateComponentEvidenceRecord(
      forbiddenSubstitute,
      selectionRaw,
      { baseDir: tempDir },
    );
    assert.equal(forbiddenSubstituteResult.decision, BASELINE_DECISIONS.FAIL);
    assert.match(forbiddenSubstituteResult.violations.join("\n"), /FORBID/);

    const wrongFootprintBinding = clone(selectionRecord);
    wrongFootprintBinding.parts[0].libraryBinding.footprintUuid = "different-fp";
    const wrongFootprintBindingResult = validateComponentEvidenceRecord(
      wrongFootprintBinding,
      selectionRaw,
      { baseDir: tempDir },
    );
    assert.equal(wrongFootprintBindingResult.decision, BASELINE_DECISIONS.FAIL);
    assert.match(
      wrongFootprintBindingResult.violations.join("\n"),
      /live footprint UUID differs/,
    );
    const selectionPass = analyzeBaseline(
      selectionRaw,
      {
        ...parseBaselineArgs([]),
        componentEvidenceRecord: selectionRecord,
        componentEvidenceBaseDir: tempDir,
        // The page envelope is required for any non-unverified schematic result,
        // so supply it here to keep this case about component evidence.
        schematicPageEnvelopeRecord: schematicPageEnvelopeFixture(),
      },
      { kind: "test" },
    );
    assert.equal(selectionPass.decision, BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS);

    for (const accessStatus of [
      "ACCESS_BLOCKED",
      "DOWNLOAD_FAILED",
      "CONTENT_UNREADABLE",
      "VARIANT_MISMATCH",
      "STALE_REVISION",
    ]) {
      const unavailable = clone(selectionRecord);
      unavailable.sources.primary.accessStatus = accessStatus;
      const result = validateComponentEvidenceRecord(unavailable, selectionRaw, {
        baseDir: tempDir,
      });
      assert.equal(result.cleared, false, accessStatus);
      assert.match(result.unverified.join("\n"), new RegExp(accessStatus));
    }

    const wrongMpn = clone(selectionRecord);
    wrongMpn.parts[0].manufacturerPartNumber = "WRONG-MPN";
    const wrongMpnReport = analyzeBaseline(
      selectionRaw,
      {
        ...parseBaselineArgs([]),
        componentEvidenceRecord: wrongMpn,
        componentEvidenceBaseDir: tempDir,
      },
      { kind: "test" },
    );
    assert.equal(wrongMpnReport.decision, BASELINE_DECISIONS.FAIL);

    const staleFingerprint = clone(selectionRecord);
    staleFingerprint.schematic.designFingerprint = "sha256:stale";
    const staleSelection = validateComponentEvidenceRecord(
      staleFingerprint,
      selectionRaw,
      { baseDir: tempDir },
    );
    assert.equal(staleSelection.cleared, false);
    assert.match(staleSelection.unverified.join("\n"), /fingerprint/);

    const distributorOnly = clone(selectionRecord);
    distributorOnly.sources.primary.authority = "DISTRIBUTOR_COPY";
    assert.equal(
      validateComponentEvidenceRecord(distributorOnly, selectionRaw, {
        baseDir: tempDir,
      }).cleared,
      false,
    );

    const noArtifact = clone(selectionRecord);
    delete noArtifact.sources.primary.artifactPath;
    assert.equal(
      validateComponentEvidenceRecord(noArtifact, selectionRaw, {
        baseDir: tempDir,
      }).cleared,
      false,
    );

    const zeroPath = path.join(tempDir, "zero.pdf");
    writeFileSync(zeroPath, Buffer.alloc(0));
    assert.equal(
      validateSelectionArtifact(
        { ...selectionRecord.sources.primary, artifactPath: zeroPath },
        tempDir,
      ).valid,
      false,
    );

    const corruptPath = path.join(tempDir, "corrupt.pdf");
    const corruptContent = Buffer.from("%PDF-1.4\ntruncated");
    writeFileSync(corruptPath, corruptContent);
    assert.match(
      validateSelectionArtifact(
        {
          ...selectionRecord.sources.primary,
          artifactPath: corruptPath,
          sha256: sha256Buffer(corruptContent),
        },
        tempDir,
      ).problems.join("\n"),
      /end marker/,
    );

    const loginPath = path.join(tempDir, "login.html");
    const loginContent = Buffer.from(
      "<!doctype html><html><title>Sign in</title>Sign in to continue</html>",
    );
    writeFileSync(loginPath, loginContent);
    assert.match(
      validateSelectionArtifact(
        {
          ...selectionRecord.sources.primary,
          artifactPath: loginPath,
          sha256: sha256Buffer(loginContent),
          mediaType: "text/html",
        },
        tempDir,
      ).problems.join("\n"),
      /login, denial, or block page/,
    );

    const encryptedPath = path.join(tempDir, "encrypted.pdf");
    const encryptedContent = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Encrypt 2 0 R>>endobj\n%%EOF\n",
    );
    writeFileSync(encryptedPath, encryptedContent);
    assert.match(
      validateSelectionArtifact(
        {
          ...selectionRecord.sources.primary,
          artifactPath: encryptedPath,
          sha256: sha256Buffer(encryptedContent),
        },
        tempDir,
      ).problems.join("\n"),
      /encrypted PDF/,
    );

    const hashMismatch = validateSelectionArtifact(
      { ...selectionRecord.sources.primary, sha256: "0".repeat(64) },
      tempDir,
    );
    assert.match(hashMismatch.problems.join("\n"), /sha256/);

    const clearedPath = path.join(tempDir, "hs-clear.json");
    writeFileSync(
      clearedPath,
      JSON.stringify({
        schemaVersion: 5,
        kind: "high-speed",
        decision: DECISIONS.PASS_WITH_EXCEPTIONS,
        fabricationRelease: false,
        design: {
          project: hsHintFixture.project,
          document: hsHintFixture.document,
          fingerprint: designFingerprint(hsHintFixture),
        },
        constraints: {
          fingerprint: null,
          highSpeedNets: ["PCIE_RX0_P"],
        },
      }),
      "utf8",
    );
    const cleared = analyzeBaseline(
      hsHintFixture,
      parseBaselineArgs(["--high-speed-audit-report", clearedPath]),
      { kind: "test" },
    );
    assert.equal(cleared.decision, BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS);

    const staleFixture = clone(hsHintFixture);
    staleFixture.lines.at(-1).endX += 1;
    const stale = analyzeBaseline(
      staleFixture,
      parseBaselineArgs(["--high-speed-audit-report", clearedPath]),
      { kind: "test" },
    );
    assert.equal(stale.decision, BASELINE_DECISIONS.UNVERIFIED);
    assert.match(stale.checks.highSpeedClearance.reason, /fingerprint/);

    const uncovered = readHighSpeedClearanceReport(clearedPath, {
      expectedProjectUuid: hsHintFixture.project.uuid,
      expectedDocumentUuid: hsHintFixture.document.uuid,
      expectedDesignFingerprint: designFingerprint(hsHintFixture),
      requiredNets: ["PCIE_RX0_P", "PCIE_TX0_P"],
    });
    assert.equal(uncovered.cleared, false);
    assert.match(uncovered.reason, /does not cover/);

    const constraintMismatch = readHighSpeedClearanceReport(clearedPath, {
      expectedConstraintFingerprint: constraintFingerprint({
        classification: "CONTROLLED_HIGH_SPEED",
      }),
    });
    assert.equal(constraintMismatch.cleared, false);
    assert.match(constraintMismatch.reason, /constraint fingerprint/);

    const failPath = path.join(tempDir, "hs-fail.json");
    writeFileSync(
      failPath,
      JSON.stringify({ decision: DECISIONS.FAIL }),
      "utf8",
    );
    const notCleared = analyzeBaseline(
      hsHintFixture,
      parseBaselineArgs(["--high-speed-audit-report", failPath]),
      { kind: "test" },
    );
    assert.equal(notCleared.decision, BASELINE_DECISIONS.UNVERIFIED);

    const crystalClearPath = path.join(tempDir, "crystal-clear.json");
    writeFileSync(
      crystalClearPath,
      JSON.stringify({
        kind: "crystal-clock",
        decision: CRYSTAL_DECISIONS.PASS_WITH_EXCEPTIONS,
        fabricationRelease: false,
        design: {
          project: crystalHintFixture.project,
          document: crystalHintFixture.document,
          fingerprint: designFingerprint(crystalHintFixture),
        },
        constraints: {
          crystalNets: ["MCU_OSC_IN"],
        },
      }),
      "utf8",
    );
    const crystalCleared = analyzeBaseline(
      crystalHintFixture,
      parseBaselineArgs(["--crystal-audit-report", crystalClearPath]),
      { kind: "test" },
    );
    assert.equal(
      crystalCleared.decision,
      BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS,
    );
    assert.equal(readCrystalClearanceReport(crystalClearPath).cleared, true);
    assert.equal(
      readCrystalClearanceReport(crystalClearPath, {
        expectedDesignFingerprint: "sha256:stale",
      }).cleared,
      false,
    );
    assert.equal(
      readCrystalClearanceReport(crystalClearPath, {
        requiredNets: ["MCU_OSC_OUT"],
      }).cleared,
      false,
    );

    const wrongKindPath = path.join(tempDir, "not-crystal.json");
    writeFileSync(
      wrongKindPath,
      JSON.stringify({
        kind: "high-speed",
        decision: CRYSTAL_DECISIONS.PASS_WITH_EXCEPTIONS,
      }),
      "utf8",
    );
    assert.equal(readCrystalClearanceReport(wrongKindPath).cleared, false);

    const noConstraints = analyze(
      selfTestFixture(),
      highSpeedOptions(undefined, ["--pair", "USB_DP:USB_DM"]),
      { kind: "test" },
    );
    assert.equal(noConstraints.decision, DECISIONS.UNVERIFIED);
    assert.equal(noConstraints.fabricationRelease, false);

    const freeTextNoAttest = analyze(
      selfTestFixture(),
      highSpeedOptions(completeConstraintFixture()),
      { kind: "test" },
    );
    assert.equal(freeTextNoAttest.decision, DECISIONS.UNVERIFIED);

    assert.throws(
      () => parseArgs(["--user-attested-evidence"]),
      /attest-file/,
    );

    const flagOnly = resolveHumanAttestation({
      userAttestedEvidence: true,
      attestFile: writeAttestFile(tempDir),
    }, {});
    assert.equal(flagOnly.accepted, false);
    assert.match(flagOnly.reason, /EASYEDA_AUDIT_USER_ATTEST/);

    const fullHuman = resolveHumanAttestation(
      {
        userAttestedEvidence: true,
        attestFile: writeAttestFile(tempDir, "board-1"),
      },
      { EASYEDA_AUDIT_USER_ATTEST: "YES" },
    );
    assert.equal(fullHuman.accepted, true);
    assert.equal(fullHuman.revision, "board-1");

    const artifact = path.join(tempDir, "coupon.txt");
    writeFileSync(artifact, "coupon\n", "utf8");
    const withArtifacts = completeConstraintFixture();
    for (const key of [
      "impedance",
      "continuousReference",
      "coupling",
      "launches",
    ]) {
      withArtifacts.evidence[key] = {
        status: withArtifacts.evidence[key].status,
        artifactPath: artifact,
        source: withArtifacts.evidence[key].source,
      };
    }
    withArtifacts.stackup.artifactPath = artifact;
    const artifactPass = analyze(
      selfTestFixture(),
      highSpeedOptions(withArtifacts),
      { kind: "test" },
    );
    assert.equal(artifactPass.decision, DECISIONS.PASS_WITH_EXCEPTIONS);

    const preserveSilosFixture = selfTestFixture();
    preserveSilosFixture.pours[0].preserveSilos = true;
    const preserveSilosPass = analyze(
      preserveSilosFixture,
      highSpeedOptions(withArtifacts),
      { kind: "test" },
    );
    assert.equal(preserveSilosPass.checks.groundPourPresent, true);
    assert.equal(
      preserveSilosPass.checks.pours[0].preserveSilosStateIgnored,
      true,
    );

    const highSpeedFreeCopperFixture = selfTestFixture();
    highSpeedFreeCopperFixture.pours[0].preserveSilos = false;
    highSpeedFreeCopperFixture.drc = [
      {
        name: "Connection Error",
        list: [
          {
            errorType: "No Connection",
            isFree: true,
            objs: ["fill1"],
          },
        ],
      },
    ];
    const highSpeedFreeCopperFail = analyze(
      highSpeedFreeCopperFixture,
      highSpeedOptions(withArtifacts),
      { kind: "test" },
    );
    assert.equal(highSpeedFreeCopperFail.decision, DECISIONS.FAIL);
    assert.equal(highSpeedFreeCopperFail.checks.pours[0].passed, false);
    assert.equal(
      highSpeedFreeCopperFail.checks.pours[0].islandStatus,
      "FREE_COPPER_DETECTED",
    );

    const boundedPairRecord = clone(withArtifacts);
    boundedPairRecord.interfaces[0].pairs[0].localFanInException = {
      allowLayerMismatch: true,
      maxAggregateSkewMil: 200,
      reason: "self-test duplicate-pad local fan-in",
      artifactPath: artifact,
    };
    boundedPairRecord.interfaces[0].channelPaths.find(
      (item) => item.name === "D-",
    ).maxLengthMil = 200;
    boundedPairRecord.interfaces[0].referenceBySignalLayer.Bottom = "L2:GND";
    const boundedPairFixture = selfTestFixture();
    boundedPairFixture.segments[1].layer = 2;
    boundedPairFixture.segments[1].endX = 180;
    const boundedPairPass = analyze(
      boundedPairFixture,
      highSpeedOptions(boundedPairRecord),
      { kind: "test" },
    );
    assert.equal(boundedPairPass.checks.pairChecks[0].exceptionApplied, true);
    assert.equal(boundedPairPass.decision, DECISIONS.PASS_WITH_EXCEPTIONS);

    const boundedViaRecord = clone(withArtifacts);
    boundedViaRecord.evidence.returnViaLayerSpan = {
      status: "MANUAL_REVIEWED",
      artifactPath: artifact,
      source: "self-test layer-span review",
    };
    boundedViaRecord.returnViaExceptions = [
      {
        signalViaId: "signal-via-bounded",
        maxDistanceMil: 150,
        reason: "self-test bounded return path",
        artifactPath: artifact,
      },
    ];
    const boundedViaFixture = selfTestFixture();
    boundedViaFixture.vias.push(
      {
        primitiveId: "signal-via-bounded",
        net: "USB_DP",
        x: 0,
        y: 0,
        viaType: 0,
      },
      {
        primitiveId: "return-via-bounded",
        net: "GND",
        x: 100,
        y: 0,
        viaType: 0,
      },
    );
    const boundedViaPass = analyze(
      boundedViaFixture,
      highSpeedOptions(boundedViaRecord),
      { kind: "test" },
    );
    assert.equal(
      boundedViaPass.checks.returnViaChecks[0].exceptionApplied,
      true,
    );
    assert.equal(boundedViaPass.decision, DECISIONS.PASS_WITH_EXCEPTIONS);

    const manufacturingNetlistArtifact = path.join(
      tempDir,
      "manufacturing-netlist-match.json",
    );
    writeFileSync(
      manufacturingNetlistArtifact,
      JSON.stringify({
        kind: "easyeda-manufacturing-netlist-comparison",
        decision: "MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION",
        manufacturingDecision: "MATCH",
        fabricationRelease: false,
        project: { uuid: "self-test" },
        pcb: { uuid: "pcb-self-test" },
        schematic: { uuid: "sch-self-test" },
        comparison: { match: true },
        pcbDataPlaneIntegrity: { match: true },
        nativeFileComparison: [],
        nativeCacheException: {
          status: "VERIFIED",
          issues: [],
          interpretation: "self-test verified native cache false negative",
        },
      }),
      "utf8",
    );
    const nativeCacheRecord = clone(withArtifacts);
    nativeCacheRecord.nativeNetlistCacheException = {
      reason: "self-test native cache mismatch",
      artifactPath: manufacturingNetlistArtifact,
    };
    const nativeCacheFixture = selfTestFixture();
    nativeCacheFixture.drc = [
      {
        errorType: "Netlist Error",
        errorObjType: "Netlist Error",
        ruleName: "Import Changes",
        globalIndex: "err-self-test",
      },
    ];
    const nativeCachePass = analyze(
      nativeCacheFixture,
      highSpeedOptions(nativeCacheRecord),
      { kind: "test" },
    );
    assert.equal(nativeCachePass.checks.drc.passedWithExceptions, true);
    assert.equal(nativeCachePass.decision, DECISIONS.PASS_WITH_EXCEPTIONS);

    const attestedPass = analyze(
      selfTestFixture(),
      attested(completeConstraintFixture()),
      { kind: "test" },
    );
    assert.equal(attestedPass.decision, DECISIONS.PASS_WITH_EXCEPTIONS);

    const crystalOptions = {
      ...mergeCrystalConstraintRecord(
        parseCrystalArgs([]),
        completeCrystalConstraintFixture(),
      ),
      humanAttestation: {
        accepted: true,
        requested: true,
        revision: "crystal-test",
      },
    };
    const crystalPass = analyzeCrystal(
      crystalSelfTestFixture(),
      crystalOptions,
      { kind: "test" },
    );
    assert.equal(
      crystalPass.decision,
      CRYSTAL_DECISIONS.PASS_WITH_EXCEPTIONS,
    );

    const crystalViaFixture = crystalSelfTestFixture();
    crystalViaFixture.vias.push({
      primitiveId: "osc-via",
      net: "OSC_IN",
      x: 50,
      y: 0,
    });
    const crystalViaFailure = analyzeCrystal(
      crystalViaFixture,
      crystalOptions,
      { kind: "test" },
    );
    assert.equal(crystalViaFailure.decision, CRYSTAL_DECISIONS.FAIL);

    const crystalDistanceFixture = crystalSelfTestFixture();
    crystalDistanceFixture.components.find(
      (component) => component.designator === "Y1",
    ).x = 1000;
    const crystalDistanceFailure = analyzeCrystal(
      crystalDistanceFixture,
      crystalOptions,
      { kind: "test" },
    );
    assert.equal(crystalDistanceFailure.decision, CRYSTAL_DECISIONS.FAIL);

    const crystalNoEvidence = analyzeCrystal(
      crystalSelfTestFixture(),
      mergeCrystalConstraintRecord(
        parseCrystalArgs([]),
        completeCrystalConstraintFixture(),
      ),
      { kind: "test" },
    );
    assert.equal(
      crystalNoEvidence.decision,
      CRYSTAL_DECISIONS.UNVERIFIED,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const missingNetRecord = completeConstraintFixture();
  missingNetRecord.interfaces[0].nets.push("USB_MISSING");
  const missingNet = analyze(
    selfTestFixture(),
    attested(missingNetRecord),
    { kind: "test" },
  );
  assert.equal(missingNet.decision, DECISIONS.FAIL);

  const noChannelLimitRecord = completeConstraintFixture();
  delete noChannelLimitRecord.interfaces[0].channelPaths;
  const noChannelLimit = analyze(
    selfTestFixture(),
    attested(noChannelLimitRecord),
    { kind: "test" },
  );
  assert.equal(noChannelLimit.decision, DECISIONS.UNVERIFIED);
  assert.ok(
    noChannelLimit.checks.incompleteConstraints.some((item) =>
      item.includes("requires channelPaths"),
    ),
  );

  const overLengthFixture = selfTestFixture();
  overLengthFixture.segments[0].endX = 200;
  const overLength = analyze(
    overLengthFixture,
    attested(completeConstraintFixture()),
    { kind: "test" },
  );
  assert.equal(overLength.decision, DECISIONS.FAIL);
  assert.equal(
    overLength.checks.channelPathChecks.find((item) => item.name === "D+")
      .hardFailure,
    true,
  );

  const unmappedLayerFixture = selfTestFixture();
  unmappedLayerFixture.segments.forEach((segment) => {
    segment.layer = 2;
  });
  const unmappedLayer = analyze(
    unmappedLayerFixture,
    attested(completeConstraintFixture()),
    { kind: "test" },
  );
  assert.equal(unmappedLayer.decision, DECISIONS.FAIL);
  assert.deepEqual(
    unmappedLayer.checks.referenceLayerChecks[0].unmappedLayers,
    ["Bottom Layer"],
  );

  const pairOnlyRecord = completeConstraintFixture();
  delete pairOnlyRecord.interfaces[0].nets;
  delete pairOnlyRecord.interfaces[0].channelPaths;
  pairOnlyRecord.interfaces[0].routeLengthNotConstrained = {
    reason: "self-test source imposes no maximum routed length",
    source: "self-test interface requirements",
  };
  const pairOnlyBottom = analyze(
    unmappedLayerFixture,
    attested(pairOnlyRecord),
    { kind: "test" },
  );
  assert.equal(pairOnlyBottom.decision, DECISIONS.FAIL);
  assert.deepEqual(pairOnlyBottom.constraints.highSpeedNets, ["USB_DP", "USB_DM"]);
  assert.deepEqual(
    pairOnlyBottom.checks.referenceLayerChecks[0].unmappedLayers,
    ["Bottom Layer"],
  );

  const nonFortyFiveFixture = selfTestFixture();
  nonFortyFiveFixture.segments[0].endY = 50;
  nonFortyFiveFixture.segments[1].endY = 60;
  const nonFortyFive = analyze(
    nonFortyFiveFixture,
    attested(completeConstraintFixture()),
    { kind: "test" },
  );
  assert.equal(nonFortyFive.decision, DECISIONS.FAIL);
  assert.equal(nonFortyFive.checks.nonStandardAngles.length, 2);

  const missingPlacementPartFixture = selfTestFixture();
  missingPlacementPartFixture.components =
    missingPlacementPartFixture.components.filter(
      (component) => component.designator !== "D1",
    );
  const missingPlacementPart = analyze(
    missingPlacementPartFixture,
    attested(completeConstraintFixture()),
    { kind: "test" },
  );
  assert.equal(missingPlacementPart.decision, DECISIONS.FAIL);
  assert.deepEqual(
    missingPlacementPart.checks.placementChecks[0].missingRefs,
    ["D1"],
  );

  const uncoupledFixture = selfTestFixture();
  uncoupledFixture.segments[1].layer = 2;
  uncoupledFixture.segments[1].startX = 10_000;
  uncoupledFixture.segments[1].endX = 10_100;
  const uncoupled = analyze(
    uncoupledFixture,
    attested(completeConstraintFixture()),
    { kind: "test" },
  );
  assert.equal(uncoupled.decision, DECISIONS.FAIL);
  assert.ok(
    uncoupled.failures.some((failure) =>
      failure.includes("differential pair USB_DP/USB_DM"),
    ),
  );
  assert.ok(uncoupled.failures.every((failure) => !failure.includes("[object Object]")));

  const highRiskRecord = completeConstraintFixture();
  highRiskRecord.classification = "HIGH_RISK_SI";
  const highRisk = analyze(
    selfTestFixture(),
    attested(highRiskRecord),
    { kind: "test" },
  );
  assert.equal(highRisk.decision, DECISIONS.UNVERIFIED);

  const highRiskVerifiedRecord = clone(highRiskRecord);
  highRiskVerifiedRecord.evidence.solverOrMeasurement = {
    status: "SOLVER_VERIFIED",
    artifact: "self-test.s2p",
  };
  const highRiskVerified = analyze(
    selfTestFixture(),
    attested(highRiskVerifiedRecord),
    { kind: "test" },
  );
  assert.equal(highRiskVerified.decision, DECISIONS.PASS_WITH_EXCEPTIONS);

  const usb3Record = completeConstraintFixture();
  usb3Record.interfaces[0].name = "USB3";
  usb3Record.interfaces[0].dataRateGbps = 5;
  const usb3Forced = analyze(
    selfTestFixture(),
    attested(usb3Record),
    { kind: "test" },
  );
  assert.equal(usb3Forced.decision, DECISIONS.UNVERIFIED);
  assert.equal(usb3Forced.constraints.effectiveClassification, "HIGH_RISK_SI");

  const viaFixture = selfTestFixture();
  viaFixture.vias.push(
    { primitiveId: "signal-via", net: "USB_DP", x: 50, y: 0, viaType: 0 },
    { primitiveId: "return-via", net: "GND", x: 60, y: 0, viaType: 0 },
  );
  const viaRecord = completeConstraintFixture();
  viaRecord.evidence.returnViaLayerSpan = {
    status: "MANUAL_REVIEWED",
    source: "self-test layer-span review",
  };
  const viaReport = analyze(viaFixture, attested(viaRecord), { kind: "test" });
  assert.equal(viaReport.decision, DECISIONS.PASS_WITH_EXCEPTIONS);

  assert.equal(parseArgs([]).requireGroundPour, true);
  assert.equal(parseArgs([]).userAttestedEvidence, false);

  assert.deepEqual(highSpeedNetHints(["3V3", "USB3_SSTX_N", "GND", "RXP"]), [
    "USB3_SSTX_N",
  ]);
  const discovery = highSpeedDiscovery([
    "USB_DP",
    "USB_DM",
    "REFCLK_P",
    "REFCLK_N",
    "QSPI_CLK",
    "SD_CLK",
    "RGMII_TXC",
    "D+",
    "D-",
    "RF_IN",
    "MIPI_CK_P",
    "HDMI_CEC",
    "PCIE_RST_N",
  ]);
  const discoveredByNet = new Map(
    discovery.candidates.map((item) => [item.net, item.classification]),
  );
  assert.equal(discoveredByNet.get("USB_DP"), "CONTROLLED_HIGH_SPEED");
  assert.equal(discoveredByNet.get("REFCLK_P"), "CONTROLLED_HIGH_SPEED");
  assert.equal(discoveredByNet.get("QSPI_CLK"), "UNRESOLVED");
  assert.equal(discoveredByNet.get("SD_CLK"), "UNRESOLVED");
  assert.equal(discoveredByNet.get("RGMII_TXC"), "UNRESOLVED");
  assert.equal(discoveredByNet.get("D+"), "UNRESOLVED");
  assert.equal(discoveredByNet.get("RF_IN"), "HIGH_RISK_SI");
  assert.equal(discoveredByNet.get("MIPI_CK_P"), "CONTROLLED_HIGH_SPEED");
  assert.equal(discoveredByNet.has("HDMI_CEC"), false);
  assert.equal(discoveredByNet.has("PCIE_RST_N"), false);
  assert.deepEqual(
    new Set(discovery.sidebandNets),
    new Set(["HDMI_CEC", "PCIE_RST_N"]),
  );
  assert.deepEqual(
    crystalNetHints(["3V3", "XTAL_IN", "MCU_OSC_OUT", "CLOCK_ENABLE"]),
    ["XTAL_IN", "MCU_OSC_OUT"],
  );
  assert.ok(
    highRiskInterfaceReasons([{ name: "PCIe Gen3", dataRateGbps: 8 }]).length >=
      1,
  );
  assert.equal(
    highRiskInterfaceReasons([{ name: "USB2", dataRateGbps: 0.48 }]).length,
    0,
  );
  assert.equal(
    highRiskInterfaceReasons([{ name: "sensor DP", dataRateGbps: 0.1 }]).length,
    0,
  );
  assert.ok(highRiskInterfaceReasons([{ name: "MIPI_CSI" }]).length >= 1);
  assert.ok(highRiskInterfaceReasons([{ name: "RF 5.8GHz" }]).length >= 1);
  assert.ok(
    highRiskInterfaceReasons([
      { name: "custom-link", validationRequirement: "eye mask compliance" },
    ]).length >= 1,
  );

  assert.equal(
    evidenceMeetsGate(
      { status: "FAB_CONFIRMED", source: "text only" },
      new Set(["FAB_CONFIRMED"]),
      { humanAttestation: { accepted: false } },
    ),
    false,
  );
  assert.equal(
    evidenceMeetsGate(
      { status: "FAB_CONFIRMED", source: "text only" },
      new Set(["FAB_CONFIRMED"]),
      { humanAttestation: { accepted: true } },
    ),
    true,
  );

  assert.equal(
    readHighSpeedClearanceReport(undefined).cleared,
    false,
  );

  assert.throws(() => resolveSafeOutputPath("/tmp/out.json"), /relative path/);
  assert.throws(() => resolveSafeOutputPath("../out.json"), /escapes/);

  const mislabel = findEasyedaApiSkill({
    EASYEDA_API_SKILL_PATH: process.cwd(),
    HOME: "/nonexistent-home-for-test",
  });
  assert.equal(
    mislabel.found,
    false,
    "easyeda-pcb-design must not be detected as easyeda-api",
  );
}

async function testBaselineCollectorFiltersNetports() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const part = {
    getState_ComponentType: () => "part",
    getState_PrimitiveId: () => "part-1",
    getState_Designator: () => "U1",
    getState_UniqueId: () => "unique-u1",
    getState_Name: () => "MCU",
    getState_Manufacturer: () => "Example Semiconductor",
    getState_ManufacturerId: () => "EXAMPLE-MCU-1",
    getState_Supplier: () => "Example Distributor",
    getState_SupplierId: () => "D123",
    getState_AddIntoPcb: () => true,
    getState_Footprint: () => ({ uuid: "fp-1" }),
  };
  const netport = {
    getState_ComponentType: () => "netport",
    getState_PrimitiveId: () => "netport-1",
    getState_Designator: () => "",
    getState_Name: () => "+3V3",
    getState_Net: () => "+3V3",
    getState_X: () => 100,
    getState_Y: () => 100,
    getState_Rotation: () => 0,
    getState_AddIntoPcb: () => undefined,
    getState_Footprint: () => undefined,
  };
  const wire = {
    getState_PrimitiveId: () => "wire-1",
    getState_Net: () => "+3V3",
    getState_Line: () => [0, 0, 40, 0],
  };
  const eda = {
    dmt_Project: {
      getCurrentProjectInfo: async () => ({ uuid: "project-1", name: "P" }),
    },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () => ({
        uuid: "schematic-page-1",
        name: "S",
        documentType: 1,
      }),
    },
    sch_PrimitiveComponent: { getAll: async () => [part, netport] },
    sch_PrimitiveWire: { getAll: async () => [wire, wire] },
    sch_Drc: { check: async () => [] },
  };
  const result = await new AsyncFunction("eda", baselineCollectorCode())(eda);
  assert.equal(result.kind, "schematic");
  assert.equal(result.components.length, 1);
  assert.equal(result.components[0].designator, "U1");
  assert.equal(result.components[0].manufacturerPartNumber, "EXAMPLE-MCU-1");
  assert.equal(result.schematicAnnotations.length, 1);
  assert.equal(result.schematicAnnotations[0].net, "+3V3");
  assert.equal(result.schematicWires.length, 2);
  assert.deepEqual(result.schematicWires[0].line, [0, 0, 40, 0]);
}

async function testMultipleWindowGuard() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        windows: [
          { windowId: "window-a", connected: true },
          { windowId: "window-b", connected: true },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    await assert.rejects(
      resolveBaselineWindow({ port: 49620 }, undefined),
      /multiple EasyEDA windows/,
    );
    assert.equal(
      await resolveBaselineWindow({ port: 49620 }, "window-b"),
      "window-b",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTests();
await testBaselineCollectorFiltersNetports();
await testMultipleWindowGuard();
process.stdout.write("easyeda audit tests passed\n");

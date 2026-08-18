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


export {
  assert,
  mkdtempSync,
  writeFileSync,
  rmSync,
  tmpdir,
  path,
  COMPLETION_TEMPLATE,
  DESIGN_FINGERPRINT_SCHEMA_VERSION,
  COMMON_EXIT,
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
  BASELINE_DECISIONS,
  BASELINE_EXIT,
  analyzeBaseline,
  analyzeSchematicPlacement,
  analyzeSchematicPresentation,
  bindPcbDrcEvidence,
  baselineCollectorCode,
  parseBaselineArgs,
  pcbFixture,
  resolveBaselineWindow,
  schematicFixture,
  schematicPageEnvelopeFixture,
  validateNetlistCompareExceptionArtifact,
  validateSchematicPageEnvelope,
  REQUIRED_INVALIDATION_TRIGGERS,
  REQUIRED_PARAMETER_COVERAGE_ASPECTS,
  sha256Buffer,
  validateSelectionArtifact,
  validateComponentEvidenceRecord,
  CRYSTAL_DECISIONS,
  analyzeCrystal,
  crystalCollectorCode,
  completeCrystalConstraintFixture,
  mergeCrystalConstraintRecord,
  parseCrystalArgs,
  crystalSelfTestFixture,
  LEDGER_BRANCH_GATES,
  LEDGER_EXIT,
  analyzeLedger,
  analyzeOperationLog,
  selfTestLedger,
  selfTestOperationLog,
  DECISIONS,
  EXIT,
  analyze,
  highSpeedCollectorCode,
  completeConstraintFixture,
  mergeConstraintRecord,
  parseArgs,
  routeSummary,
  selfTestFixture,
  comparePcbDataPlane,
  compareNetlists,
  identityContractIssues,
  overallDecision,
  parseNetlistCompareArgs,
  summarizeNativeComparison,
  verifyNativeCacheException,
  analyzeIdentity,
  parseIdentityPreflightArgs,
  parseInternalNetlistViews,
  identityPcbCollectorCode,
  identitySchematicCollectorCode,
  analyzeRevisionIntent,
  parseRevisionGuardArgs,
  resolveSafeInputPath,
  revisionTreeCollectorCode,
  PLACEMENT_STATUS,
  analyzePlacement,
  placementConstraintFixture,
  designFingerprintLookup,
  placementEvidenceFixture,
  placementFixture,
  parsePlacementArgs,
  withHumanAttestation,
  highSpeedOptions,
  attested,
  clone,
  parameterCoverageFixture,
  componentEvidenceRecord,
  writeAttestFile,
};

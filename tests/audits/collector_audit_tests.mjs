import * as context from "./audit_test_context.mjs";

const {
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
} = context;

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


export async function runCollectorAuditTests() {
  await testBaselineCollectorFiltersNetports();
  await testMultipleWindowGuard();
}

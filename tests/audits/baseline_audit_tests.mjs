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

export function runBaselineAuditTests() {
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

  const schematicWithoutDrcFixture = schematicFixture();
  delete schematicWithoutDrcFixture.drc;
  const schematicWithoutDrc = analyzeBaseline(
    schematicWithoutDrcFixture,
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(schematicWithoutDrc.decision, BASELINE_DECISIONS.UNVERIFIED);
  assert.ok(schematicWithoutDrc.coverage.unverifiedAxes.includes("schematicDrc"));
  assert.ok(
    schematicWithoutDrc.unverified.some((item) =>
      /cannot be called clear or verified/.test(item)),
  );
  assert.ok(!schematicWithoutDrc.failures.includes("schematic DRC did not pass"));

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

}

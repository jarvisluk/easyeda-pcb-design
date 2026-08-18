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

export function runSpecialistAuditTests() {
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

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

export function runCoreAuditTests() {
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
      const schematicDrcIndex = LEDGER_BRANCH_GATES["new-construction"]
        .indexOf("SCHEMATIC_DRC_CLEAR");
      const schematicTerminalIndex = LEDGER_BRANCH_GATES["new-construction"]
        .indexOf("SCHEMATIC_VERIFIED");
      assert.ok(schematicDrcIndex > 0);
      assert.ok(schematicTerminalIndex > 0);
      assert.ok(schematicDrcIndex < schematicTerminalIndex);
      assert.ok(schematicTerminalIndex < LEDGER_BRANCH_GATES["new-construction"].indexOf("PCB_SYNC_MATCH"));
      const schematicOnlyGates = LEDGER_BRANCH_GATES["new-construction"]
        .slice(0, schematicTerminalIndex + 1)
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
            ...schematicOnlyGates.slice(0, -1),
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

  assert.equal(parseRevisionGuardArgs([]).manifest, "revision-manifest.json");
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

}

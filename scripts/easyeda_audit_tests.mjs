#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COMPLETION_TEMPLATE,
  EXIT as COMMON_EXIT,
  constraintFingerprint,
  crystalNetHints,
  designFingerprint,
  evidenceMeetsGate,
  findEasyedaApiSkill,
  highRiskInterfaceReasons,
  highSpeedDiscovery,
  highSpeedNetHints,
  readCrystalClearanceReport,
  readHighSpeedClearanceReport,
  resolveHumanAttestation,
  resolveSafeOutputPath,
} from "./audit_common.mjs";
import {
  DECISIONS as BASELINE_DECISIONS,
  EXIT as BASELINE_EXIT,
  analyze as analyzeBaseline,
  collectorCode as baselineCollectorCode,
  parseArgs as parseBaselineArgs,
  pcbFixture,
  resolveWindow as resolveBaselineWindow,
} from "./easyeda_design_audit.mjs";
import {
  DECISIONS as CRYSTAL_DECISIONS,
  analyze as analyzeCrystal,
  collectorCode as crystalCollectorCode,
  completeConstraintFixture as completeCrystalConstraintFixture,
  mergeConstraintRecord as mergeCrystalConstraintRecord,
  parseArgs as parseCrystalArgs,
  selfTestFixture as crystalSelfTestFixture,
} from "./easyeda_crystal_clock_audit.mjs";
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
} from "./easyeda_high_speed_audit.mjs";

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

  assert.equal(BASELINE_EXIT.PASS_WITH_EXCEPTIONS, 4);
  assert.equal(EXIT.PASS_WITH_EXCEPTIONS, 4);
  assert.equal(COMMON_EXIT.UNVERIFIED, 3);
  assert.match(COMPLETION_TEMPLATE, /fabricationRelease: false/);

  const baseline = analyzeBaseline(
    pcbFixture(),
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(baseline.decision, BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS);
  assert.equal(baseline.fabricationRelease, false);
  assert.equal(baseline.manufacturingOutputsReviewed, false);
  assert.ok(!Object.hasOwn(BASELINE_DECISIONS, "PASS"));
  assert.ok(!Object.hasOwn(DECISIONS, "PASS"));

  assert.throws(
    () => parseBaselineArgs(["--allow-no-ground-pour"]),
    /exception-note/,
  );
  assert.throws(
    () => parseBaselineArgs(["--allow-routing-cycle", "3V3"]),
    /exception-note/,
  );

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
await testMultipleWindowGuard();
process.stdout.write("easyeda audit tests passed\n");

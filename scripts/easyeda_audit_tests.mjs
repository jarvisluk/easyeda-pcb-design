#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  DECISIONS as BASELINE_DECISIONS,
  analyze as analyzeBaseline,
  collectorCode as baselineCollectorCode,
  parseArgs as parseBaselineArgs,
  pcbFixture,
  resolveWindow as resolveBaselineWindow,
} from "./easyeda_design_audit.mjs";
import {
  DECISIONS,
  analyze,
  collectorCode as highSpeedCollectorCode,
  completeConstraintFixture,
  mergeConstraintRecord,
  parseArgs,
  routeSummary,
  selfTestFixture,
} from "./easyeda_high_speed_audit.mjs";

function highSpeedOptions(record, argv = []) {
  return mergeConstraintRecord(parseArgs(argv), record);
}

function clone(value) {
  return structuredClone(value);
}

function runTests() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction("eda", baselineCollectorCode()));
  assert.doesNotThrow(() => new AsyncFunction("eda", highSpeedCollectorCode()));

  const baseline = analyzeBaseline(
    pcbFixture(),
    parseBaselineArgs([]),
    { kind: "test" },
  );
  assert.equal(
    baseline.decision,
    BASELINE_DECISIONS.PASS_WITH_EXCEPTIONS,
    "renamed board-outline layer must be recognized by its enum ID",
  );

  const noConstraints = analyze(
    selfTestFixture(),
    highSpeedOptions(undefined, ["--pair", "USB_DP:USB_DM"]),
    { kind: "test" },
  );
  assert.equal(
    noConstraints.decision,
    DECISIONS.UNVERIFIED,
    "legacy screening without constraints must not pass",
  );
  assert.ok(
    noConstraints.checks.incompleteConstraints.includes(
      "no --constraints record was supplied",
    ),
  );

  const missingNetRecord = completeConstraintFixture();
  missingNetRecord.interfaces[0].nets.push("USB_MISSING");
  const missingNet = analyze(
    selfTestFixture(),
    highSpeedOptions(missingNetRecord),
    { kind: "test" },
  );
  assert.equal(missingNet.decision, DECISIONS.FAIL);
  assert.deepEqual(missingNet.checks.missingHighSpeedNets, ["USB_MISSING"]);

  const uncoupledFixture = selfTestFixture();
  uncoupledFixture.segments[1].layer = 2;
  uncoupledFixture.segments[1].startX = 10_000;
  uncoupledFixture.segments[1].endX = 10_100;
  const uncoupled = analyze(
    uncoupledFixture,
    highSpeedOptions(completeConstraintFixture()),
    { kind: "test" },
  );
  assert.equal(uncoupled.decision, DECISIONS.FAIL);
  assert.equal(uncoupled.checks.pairChecks[0].layerSetsMatch, false);

  const branchFixture = selfTestFixture();
  branchFixture.segments.push({
    primitiveId: "branch",
    segmentKind: "line",
    net: "USB_DP",
    layer: 1,
    lineWidth: 8,
    startX: 50,
    startY: 0,
    endX: 50,
    endY: 30,
  });
  branchFixture.segments[0].endX = 50;
  branchFixture.segments.push({
    primitiveId: "p1-tail",
    segmentKind: "line",
    net: "USB_DP",
    layer: 1,
    lineWidth: 8,
    startX: 50,
    startY: 0,
    endX: 100,
    endY: 0,
  });
  const branch = analyze(
    branchFixture,
    highSpeedOptions(completeConstraintFixture()),
    { kind: "test" },
  );
  assert.equal(branch.decision, DECISIONS.FAIL);
  assert.ok(branch.checks.pairChecks[0].positive.branchVertices.length > 0);

  const highRiskRecord = completeConstraintFixture();
  highRiskRecord.classification = "HIGH_RISK_SI";
  const highRisk = analyze(
    selfTestFixture(),
    highSpeedOptions(highRiskRecord),
    { kind: "test" },
  );
  assert.equal(highRisk.decision, DECISIONS.UNVERIFIED);
  assert.ok(
    highRisk.checks.incompleteConstraints.includes(
      "high-risk SI requires solver or measurement evidence",
    ),
  );

  const highRiskVerifiedRecord = clone(highRiskRecord);
  highRiskVerifiedRecord.evidence.solverOrMeasurement = {
    status: "SOLVER_VERIFIED",
    artifact: "self-test.s2p",
  };
  const highRiskVerified = analyze(
    selfTestFixture(),
    highSpeedOptions(highRiskVerifiedRecord),
    { kind: "test" },
  );
  assert.equal(highRiskVerified.decision, DECISIONS.PASS_WITH_EXCEPTIONS);

  const missingEndpointRecord = completeConstraintFixture();
  delete missingEndpointRecord.interfaces[0].endpoints;
  const missingEndpoints = analyze(
    selfTestFixture(),
    highSpeedOptions(missingEndpointRecord),
    { kind: "test" },
  );
  assert.equal(missingEndpoints.decision, DECISIONS.UNVERIFIED);
  assert.ok(
    missingEndpoints.checks.incompleteConstraints.includes(
      "interface USB2 needs at least two named endpoints",
    ),
  );

  const contradictoryLaunchRecord = completeConstraintFixture();
  contradictoryLaunchRecord.launchesNotApplicable = true;
  const contradictoryLaunch = analyze(
    selfTestFixture(),
    highSpeedOptions(contradictoryLaunchRecord),
    { kind: "test" },
  );
  assert.equal(contradictoryLaunch.decision, DECISIONS.UNVERIFIED);
  assert.ok(
    contradictoryLaunch.checks.incompleteConstraints.includes(
      "launchesNotApplicable conflicts with a connector/model or implemented protection",
    ),
  );

  const viaFixture = selfTestFixture();
  viaFixture.vias.push(
    {
      primitiveId: "signal-via",
      net: "USB_DP",
      x: 50,
      y: 0,
      viaType: 0,
    },
    {
      primitiveId: "return-via",
      net: "GND",
      x: 60,
      y: 0,
      viaType: 0,
    },
  );
  const viaRecord = completeConstraintFixture();
  viaRecord.evidence.returnViaLayerSpan = {
    status: "MANUAL_REVIEWED",
    source: "self-test layer-span review",
  };
  const viaReport = analyze(viaFixture, highSpeedOptions(viaRecord), {
    kind: "test",
  });
  assert.equal(viaReport.decision, DECISIONS.PASS_WITH_EXCEPTIONS);
  assert.equal(viaReport.checks.returnViaChecks[0].proximityPassed, true);

  const noViaLimitRecord = clone(viaRecord);
  delete noViaLimitRecord.maxReturnViaDistanceMil;
  delete noViaLimitRecord.interfaces[0].maxReturnViaDistanceMil;
  const noViaLimit = analyze(
    viaFixture,
    highSpeedOptions(noViaLimitRecord),
    { kind: "test" },
  );
  assert.equal(noViaLimit.decision, DECISIONS.UNVERIFIED);
  assert.ok(
    noViaLimit.checks.incompleteConstraints.includes(
      "signal vias exist but maxReturnViaDistanceMil is missing",
    ),
  );

  const arcSummary = routeSummary(
    "ARC",
    [
      {
        primitiveId: "arc",
        segmentKind: "arc",
        net: "ARC",
        layer: 1,
        lineWidth: 8,
        startX: 0,
        startY: 0,
        endX: 2,
        endY: 0,
        arcAngle: 180,
      },
    ],
    [],
  );
  assert.ok(Math.abs(arcSummary.lengthMil - Math.PI) < 0.001);

  const defaults = parseArgs([]);
  assert.equal(defaults.maxPairSkewMil, undefined);
  assert.equal(defaults.maxReturnViaDistanceMil, undefined);
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

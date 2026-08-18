#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLACEMENT_REQUIRED_AXES,
  planFixture,
} from "../../skills/easyeda-pcb-design/scripts/live/lib/transaction_runner.mjs";
import {
  DEFAULT_OUTPUT as COMPANION_DEFAULT_OUTPUT,
  parseArgs as parseCompanionArgs,
} from "../../skills/easyeda-pcb-design/scripts/live/check_companion.mjs";
import { schematicPlanFixture } from "../../skills/easyeda-pcb-design/scripts/live/lib/schematic_transaction_plan.mjs";
import { resolveOperationLogPath } from "../../skills/easyeda-pcb-design/scripts/live/lib/tool_runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const CHECK_COMPANION = path.join(REPO_ROOT, "skills/easyeda-pcb-design/scripts/live/check_companion.mjs");
const NATIVE_CHECKPOINT = path.join(REPO_ROOT, "skills/easyeda-pcb-design/scripts/live/easyeda_native_checkpoint.mjs");
const TRANSACTION = path.join(REPO_ROOT, "skills/easyeda-pcb-design/scripts/live/easyeda_transaction.mjs");
const SCHEMATIC_TRANSACTION = path.join(REPO_ROOT, "skills/easyeda-pcb-design/scripts/live/easyeda_schematic_transaction.mjs");
const VERIFY = path.join(REPO_ROOT, "skills/easyeda-pcb-design/scripts/live/verify_gate.mjs");

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(script, args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function drcEvidence() {
  const rule = { name: "integration fixture", configuration: { clearance: 6 } };
  return {
    schemaVersion: 1,
    ruleBefore: rule,
    ruleAfter: rule,
    samples: [
      { id: "silent-1", strict: true, userInterface: false, includeVerboseError: true, result: [] },
      { id: "silent-2", strict: true, userInterface: false, includeVerboseError: true, result: [] },
      { id: "visible-final", strict: true, userInterface: true, includeVerboseError: true, result: [] },
    ],
  };
}

function placement(fingerprint) {
  return {
    kind: "easyeda-placement-audit",
    schemaVersion: 3,
    status: "PLACEMENT_CLEAR_FOR_ROUTING",
    design: { fingerprint },
    coverage: {
      requiredAxes: [...PLACEMENT_REQUIRED_AXES],
      checkedAxes: [...PLACEMENT_REQUIRED_AXES],
      unverifiedAxes: [],
    },
  };
}

function main() {
  const root = mkdtempSync(path.join(tmpdir(), "easyeda-tools-integration-"));
  try {
    const derivedLog = resolveOperationLogPath(
      undefined,
      "standalone/evidence/snapshots/preflight.json",
      root,
    );
    if (derivedLog !== path.join(root, "standalone/evidence/readbacks/operation-log.json")) {
      throw new Error("operation log was not derived from the output evidence tree");
    }
    if (parseCompanionArgs([]).output !== COMPANION_DEFAULT_OUTPUT) {
      throw new Error("companion check did not select its default report path");
    }
    const standaloneRoot = path.join(root, "standalone");
    mkdirSync(standaloneRoot, { recursive: true });
    const standaloneFailure = run(CHECK_COMPANION, [
      "--unsupported-option",
    ], standaloneRoot);
    if (standaloneFailure.status === 0) throw new Error("invalid companion invocation unexpectedly passed");
    const standaloneLog = JSON.parse(readFileSync(path.join(root, "standalone/evidence/readbacks/operation-log.json"), "utf8"));
    if (standaloneLog.entries.length !== 1 || standaloneLog.entries[0].recordedBy !== "TOOL") {
      throw new Error("standalone live tool did not create its own failure log");
    }
    const nativePath = path.join(root, "standalone/evidence/snapshots/preflight.epro");
    const readbackPath = path.join(root, "standalone/evidence/readbacks/preflight-pcb.json");
    mkdirSync(path.dirname(nativePath), { recursive: true });
    writeFileSync(nativePath, "native-checkpoint-fixture");
    writeJson(readbackPath, {
      kind: "pcb",
      project: { uuid: "default-log-project" },
      document: { uuid: "default-log-pcb", documentType: 3 },
      boardOutlineLayerId: 11,
      components: [], pads: [], lines: [], arcs: [], polylines: [], vias: [], pours: [],
    });
    const standaloneSuccess = run(NATIVE_CHECKPOINT, [
      "create",
      "--native", "standalone/evidence/snapshots/preflight.epro",
      "--readback", "standalone/evidence/readbacks/preflight-pcb.json",
    ], root);
    if (standaloneSuccess.status !== 0) {
      throw new Error(`default-log checkpoint failed: ${standaloneSuccess.stderr || standaloneSuccess.stdout}`);
    }
    const appendedStandaloneLog = JSON.parse(
      readFileSync(path.join(root, "standalone/evidence/readbacks/operation-log.json"), "utf8"),
    );
    if (
      appendedStandaloneLog.entries.length !== 2 ||
      appendedStandaloneLog.entries.at(-1).tool !== "easyeda_native_checkpoint.mjs"
    ) {
      throw new Error("standalone live tool did not append its success entry to the derived log");
    }

    const schematicPlan = schematicPlanFixture("new-construction");
    schematicPlan.artifactRoot = "../..";
    const schematicRoot = path.join(root, "schematic");
    const schematicPlanPath = path.join(schematicRoot, "plans/transactions/new.json");
    const schematicControl = (field) => path.join(schematicRoot, schematicPlan.controls[field]);
    writeJson(schematicPlanPath, schematicPlan);
    writeJson(schematicControl("authorizationRecord"), {
      kind: "easyeda-operation-authorization", schemaVersion: 1, authorized: true,
      transactionId: schematicPlan.transactionId, mode: schematicPlan.mode,
      targetClass: schematicPlan.targetClass, authorizationProfile: "USER_OWNED",
      userWords: "authorize schematic integration fixture", authorizedAt: "2026-08-17T00:00:00.000Z",
    });
    writeJson(schematicControl("gateLedgerCheck"), {
      kind: "easyeda-gate-ledger", decision: "CLEARED", projectUuid: schematicPlan.projectUuid,
    });
    writeJson(schematicControl("preEditState"), {
      schemaVersion: 2, kind: "easyeda-schematic-state", fingerprint: schematicPlan.baselineFingerprint,
      project: { uuid: schematicPlan.projectUuid }, schematic: { uuid: schematicPlan.schematicUuid },
      document: { uuid: schematicPlan.schematicPageUuid }, reopen: { performed: true },
      axes: { erc: { status: "CAPTURED", stable: true, leaves: [] } },
      raw: { kind: "schematic", components: [], annotations: [], wires: [], netlist: { components: {} } },
    });
    const schematicDryRun = run(SCHEMATIC_TRANSACTION, [
      "--plan", schematicPlanPath,
    ]);
    if (schematicDryRun.status !== 0) throw new Error(`schematic transaction dry-run failed: ${schematicDryRun.stderr || schematicDryRun.stdout}`);
    const schematicLog = JSON.parse(readFileSync(schematicControl("operationLog"), "utf8"));
    if (
      schematicLog.entries.length !== 1 || schematicLog.entries[0].recordedBy !== "TOOL" ||
      schematicLog.entries[0].authorizationUserWords !== "authorize schematic integration fixture"
    ) throw new Error("schematic transaction did not initialize its own authorized operation log");

    const plan = planFixture("route");
    plan.artifactRoot = "../..";
    const planPath = path.join(root, "plans/routes/route.json");
    const resolveControl = (field) => path.join(root, plan.controls[field]);
    writeJson(planPath, plan);
    writeJson(resolveControl("checkpointCheck"), {
      kind: "easyeda-native-checkpoint-check", status: "NATIVE_CHECKPOINT_MATCH",
      executeAllowed: true, liveFingerprint: plan.baselineFingerprint,
    });
    writeJson(resolveControl("authorizationRecord"), {
      kind: "easyeda-operation-authorization", schemaVersion: 1, authorized: true,
      transactionId: plan.transactionId, mode: plan.mode, targetClass: plan.targetClass,
      authorizationProfile: "USER_OWNED", userWords: "authorize integration fixture",
      authorizedAt: "2026-08-15T00:00:00.000Z",
    });
    writeJson(resolveControl("gateLedgerCheck"), { kind: "easyeda-gate-ledger", decision: "CLEARED" });
    writeJson(resolveControl("prePlacementReport"), placement(plan.baselineFingerprint));
    const dryRun = run(TRANSACTION, [
      "--plan", planPath,
    ]);
    if (dryRun.status !== 0) throw new Error(`transaction dry-run failed: ${dryRun.stderr || dryRun.stdout}`);
    const planCheckPath = resolveControl("planCheck");
    const planCheck = JSON.parse(readFileSync(planCheckPath, "utf8"));
    if (planCheck.status !== "PLAN_VALID" || planCheck.plan?.mode !== "route") {
      throw new Error("transaction dry-run did not produce a valid route result");
    }
    const initializedLog = JSON.parse(readFileSync(resolveControl("operationLog"), "utf8"));
    if (
      initializedLog.entries.length !== 1 ||
      initializedLog.entries[0].recordedBy !== "TOOL" ||
      initializedLog.entries[0].authorizationUserWords !== "authorize integration fixture"
    ) {
      throw new Error("transaction tool did not initialize its own log with bound authorization evidence");
    }

    const escaped = run(TRANSACTION, [
      "--plan", planPath,
      "--output", "../escaped.json",
    ]);
    if (escaped.status === 0 || existsSync(path.join(root, "..", "escaped.json"))) {
      throw new Error("transaction output escaped the project artifact root");
    }
    const failureLogged = JSON.parse(readFileSync(resolveControl("operationLog"), "utf8"));
    if (
      failureLogged.entries.length !== 2 ||
      failureLogged.entries.at(-1).attemptDisposition !== "REJECTED" ||
      failureLogged.entries.at(-1).gateProgress !== "BLOCKED"
    ) {
      throw new Error("transaction tool did not log its own rejected invocation");
    }

    const afterFingerprint = `sha256:${"b".repeat(64)}`;
    const before = {
      schemaVersion: 2,
      kind: "easyeda-current-state",
      fingerprint: plan.baselineFingerprint,
      project: { uuid: plan.projectUuid },
      document: { uuid: plan.pcbUuid },
      axes: { drc: { status: "NOT_RUN" } },
      raw: { kind: "pcb", lines: [], vias: [], components: [], polylines: [], pours: [], poured: [] },
    };
    const lineOperation = plan.operations.find((operation) => operation.type === "line.create");
    const viaOperation = plan.operations.find((operation) => operation.type === "via.create");
    const after = {
      schemaVersion: 2,
      kind: "easyeda-current-state",
      fingerprint: afterFingerprint,
      project: { uuid: plan.projectUuid },
      document: { uuid: plan.pcbUuid },
      axes: { drc: { status: "CAPTURED" } },
      raw: {
        kind: "pcb",
        lines: [{
          primitiveId: "line-new", net: lineOperation.net, layer: 1,
          startX: lineOperation.startX, startY: lineOperation.startY,
          endX: lineOperation.endX, endY: lineOperation.endY,
          lineWidth: lineOperation.lineWidth, locked: lineOperation.primitiveLock,
        }],
        vias: [{
          primitiveId: "via-new", net: viaOperation.net, x: viaOperation.x, y: viaOperation.y,
          holeDiameter: viaOperation.holeDiameter, diameter: viaOperation.diameter,
          locked: viaOperation.primitiveLock,
        }],
        components: [], polylines: [], pours: [], poured: [], drc: [], drcEvidence: drcEvidence(),
      },
    };
    const result = {
      schemaVersion: 2,
      kind: "easyeda-transaction-result",
      status: "TRANSACTION_APPLIED_PENDING_REOPEN",
      plan: { transactionId: plan.transactionId, mode: plan.mode },
      immediateResult: {
        operationResults: [
          { operationId: lineOperation.operationId, returnedId: "line-new" },
          { operationId: viaOperation.operationId, returnedId: "via-new" },
        ],
      },
    };
    writeJson(resolveControl("preEditState"), before);
    writeJson(resolveControl("postEditState"), after);
    writeJson(resolveControl("transactionResult"), result);
    writeJson(resolveControl("postPlacementReport"), placement(afterFingerprint));

    const verified = run(VERIFY, [
      "--plan", planPath,
    ]);
    if (verified.status !== 0) throw new Error(`transaction verification failed: ${verified.stderr || verified.stdout}`);
    const gateCheck = JSON.parse(readFileSync(resolveControl("verificationReport"), "utf8"));
    if (gateCheck.status !== "TRANSACTION_VERIFIED") throw new Error("saved/reopened fixture did not verify");
    const operationLog = JSON.parse(readFileSync(resolveControl("operationLog"), "utf8"));
    if (
      operationLog.entries.length !== 3 ||
      operationLog.entries.at(-1).attemptDisposition !== "ACCEPTED" ||
      operationLog.entries.some((entry) => entry.recordedBy !== "TOOL")
    ) {
      throw new Error("gate verifier did not append accepted telemetry");
    }
    process.stdout.write("easyeda live tools integration tests passed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();

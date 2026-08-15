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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const TRANSACTION = path.join(REPO_ROOT, "skills/easyeda-pcb-design/scripts/live/easyeda_transaction.mjs");
const VERIFY = path.join(REPO_ROOT, "skills/easyeda-pcb-design/scripts/live/verify_gate.mjs");

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
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
    const plan = planFixture("route");
    plan.artifactRoot = "../..";
    const planPath = path.join(root, "plans/routes/route.json");
    const resolveControl = (field) => path.join(root, plan.controls[field]);
    writeJson(planPath, plan);
    writeJson(resolveControl("budgetCheck"), {
      kind: "easyeda-execution-budget-check", status: "CONTINUE", executeAllowed: true,
    });
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
    writeJson(resolveControl("operationLog"), { schemaVersion: 2, appendOnly: true, entries: [] });

    const dryRun = run(TRANSACTION, [
      "--plan", planPath,
      "--output", "evidence/readbacks/plan-check.json",
    ]);
    if (dryRun.status !== 0) throw new Error(`transaction dry-run failed: ${dryRun.stderr || dryRun.stdout}`);
    const planCheckPath = path.join(root, "evidence/readbacks/plan-check.json");
    const planCheck = JSON.parse(readFileSync(planCheckPath, "utf8"));
    if (planCheck.status !== "PLAN_VALID" || planCheck.plan?.mode !== "route") {
      throw new Error("transaction dry-run did not produce a valid route result");
    }

    const escaped = run(TRANSACTION, [
      "--plan", planPath,
      "--output", "../escaped.json",
    ]);
    if (escaped.status === 0 || existsSync(path.join(root, "..", "escaped.json"))) {
      throw new Error("transaction output escaped the project artifact root");
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
    writeJson(path.join(root, "evidence/readbacks/before.json"), before);
    writeJson(path.join(root, "evidence/readbacks/after.json"), after);
    writeJson(path.join(root, "evidence/readbacks/transaction-result.json"), result);
    writeJson(resolveControl("postPlacementReport"), placement(afterFingerprint));

    const verified = run(VERIFY, [
      "--plan", planPath,
      "--before", "evidence/readbacks/before.json",
      "--after", "evidence/readbacks/after.json",
      "--transaction-result", "evidence/readbacks/transaction-result.json",
      "--output", "evidence/readbacks/gate-check.json",
    ]);
    if (verified.status !== 0) throw new Error(`transaction verification failed: ${verified.stderr || verified.stdout}`);
    const gateCheck = JSON.parse(readFileSync(path.join(root, "evidence/readbacks/gate-check.json"), "utf8"));
    if (gateCheck.status !== "TRANSACTION_VERIFIED") throw new Error("saved/reopened fixture did not verify");
    const operationLog = JSON.parse(readFileSync(resolveControl("operationLog"), "utf8"));
    if (operationLog.entries.length !== 1 || operationLog.entries[0].attemptDisposition !== "ACCEPTED") {
      throw new Error("gate verifier did not append accepted telemetry");
    }
    process.stdout.write("easyeda live tools integration tests passed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();

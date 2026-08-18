#!/usr/bin/env node

/**
 * Read-only document-tree and revision-budget guard for EasyEDA PCB creation.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { appendToolFailureFromArgv, appendToolLogEntry } from "./lib/operation_log.mjs";
import { executeEasyedaCode, isMain, resolveOperationLogPath, timestampSlug, writeNewJson } from "./lib/tool_runtime.mjs";

const EXIT = Object.freeze({ OK: 0, ERROR: 1, BLOCKED: 2, UNVERIFIED: 3 });
const ROLES = new Set(["working", "rollback", "diagnostic", "final"]);
const STATUSES = new Set([
  "active",
  "preserved",
  "failed",
  "retired",
  "deleted",
]);
const CLEANUP = new Set([
  "keep",
  "delete-after-proof",
  "needs-user-decision",
]);
const CLI_STARTED_AT = new Date();
const DEFAULT_MANIFEST = "revision-manifest.json";
const DEFAULT_OUTPUT = `evidence/readbacks/revision-guard-${timestampSlug(CLI_STARTED_AT)}.json`;

function usage() {
  return `Usage:
  node scripts/live/easyeda_revision_guard.mjs [--manifest FILE] [options]

Options:
  --manifest FILE                 Override revision-manifest.json
  --tree-file FILE                Offline document-tree JSON instead of bridge
  --intent-role ROLE              working|rollback|diagnostic|final
  --parent-uuid UUID              Parent PCB UUID for the proposed revision
  --reason TEXT                   Concrete creation reason
  --success-gate TEXT             Gate the proposed revision must close
  --cleanup-disposition VALUE     keep|delete-after-proof|needs-user-decision
  --bridge-port PORT              Use one bridge port
  --window-id ID                  Target a registered EasyEDA window
  --output FILE                   Override the generated readback path
  --operation-log FILE            Override the log path derived from --output
  --force                         Overwrite an existing output file
  --self-test                     Run deterministic offline tests
  --help                          Show this help

The command never creates, renames, or deletes EasyEDA documents. Run it before
creating a PCB and again after registering the returned UUID in the manifest.
`;
}

function requiredValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
  return argv[index + 1];
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--bridge-port requires an integer from 1 to 65535");
  }
  return port;
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    treeFile: undefined,
    intentRole: undefined,
    parentUuid: undefined,
    reason: undefined,
    successGate: undefined,
    cleanupDisposition: undefined,
    bridgePort: undefined,
    windowId: undefined,
    output: DEFAULT_OUTPUT,
    operationLog: undefined,
    force: false,
    selfTest: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--manifest") {
      options.manifest = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--tree-file") {
      options.treeFile = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--intent-role") {
      options.intentRole = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--parent-uuid") {
      options.parentUuid = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--reason") {
      options.reason = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--success-gate") {
      options.successGate = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--cleanup-disposition") {
      options.cleanupDisposition = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--bridge-port") {
      options.bridgePort = positivePort(requiredValue(argv, index, option));
      index += 1;
    } else if (option === "--window-id") {
      options.windowId = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--output") {
      options.output = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--operation-log") {
      options.operationLog = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--force") {
      options.force = true;
    } else if (option === "--self-test") {
      options.selfTest = true;
    } else if (option === "--help" || option === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  const intentValues = [
    options.intentRole,
    options.reason,
    options.successGate,
    options.cleanupDisposition,
  ];
  const intentRequested = intentValues.some((value) => value !== undefined);
  if (intentRequested && intentValues.some((value) => value === undefined)) {
    throw new Error(
      "revision intent requires --intent-role, --reason, --success-gate, and --cleanup-disposition",
    );
  }
  return options;
}

function resolveSafeInputPath(input) {
  if (path.isAbsolute(input)) throw new Error("input path must be relative");
  const root = path.resolve(process.cwd());
  const resolved = path.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("input path escapes the working directory");
  }
  return resolved;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTree(tree) {
  const projectUuid = tree?.project?.uuid || tree?.projectUuid || "";
  const rawPcbs = tree?.pcbs || tree?.pcbDocuments || [];
  const pcbs = rawPcbs.map((pcb) => ({
    uuid: String(pcb.uuid || pcb.pcb?.uuid || ""),
    name: String(pcb.name || pcb.pcb?.name || ""),
    parentBoardName: String(
      pcb.parentBoardName || pcb.pcb?.parentBoardName || "",
    ),
  }));
  return { projectUuid: String(projectUuid), pcbs };
}

function validateRevision(revision, index, issues) {
  const prefix = `revisions[${index}]`;
  if (!nonempty(revision?.uuid)) issues.push(`${prefix}.uuid is required`);
  if (!ROLES.has(revision?.role)) issues.push(`${prefix}.role is invalid`);
  if (!STATUSES.has(revision?.status)) issues.push(`${prefix}.status is invalid`);
  if (!nonempty(revision?.reason)) issues.push(`${prefix}.reason is required`);
  if (!nonempty(revision?.successGate)) {
    issues.push(`${prefix}.successGate is required`);
  }
  if (!CLEANUP.has(revision?.cleanupDisposition)) {
    issues.push(`${prefix}.cleanupDisposition is invalid`);
  }
}

function analyzeRevisionIntent(manifest, rawTree, intent = undefined) {
  const blockedReasons = [];
  const unverifiedReasons = [];
  if (manifest?.schemaVersion !== 1) {
    unverifiedReasons.push("manifest schemaVersion must be 1");
  }
  if (!nonempty(manifest?.projectUuid)) {
    unverifiedReasons.push("manifest projectUuid is required");
  }
  if (!Array.isArray(manifest?.revisions)) {
    unverifiedReasons.push("manifest revisions must be an array");
  }
  const revisions = Array.isArray(manifest?.revisions) ? manifest.revisions : [];
  const manifestIssues = [];
  revisions.forEach((revision, index) =>
    validateRevision(revision, index, manifestIssues),
  );
  unverifiedReasons.push(...manifestIssues);

  const duplicateUuids = revisions
    .map((revision) => revision.uuid)
    .filter((uuid, index, values) => uuid && values.indexOf(uuid) !== index);
  if (duplicateUuids.length > 0) {
    unverifiedReasons.push(
      `manifest contains duplicate PCB UUIDs: ${[...new Set(duplicateUuids)].join(", ")}`,
    );
  }

  const tree = normalizeTree(rawTree);
  if (!tree.projectUuid) {
    unverifiedReasons.push("document tree project UUID is unavailable");
  } else if (
    nonempty(manifest?.projectUuid) &&
    tree.projectUuid !== manifest.projectUuid
  ) {
    unverifiedReasons.push("manifest and document tree project UUIDs differ");
  }
  const liveUuids = new Set(tree.pcbs.map((pcb) => pcb.uuid).filter(Boolean));
  const registeredUuids = new Set(revisions.map((revision) => revision.uuid));
  const unregisteredLiveUuids = [...liveUuids]
    .filter((uuid) => !registeredUuids.has(uuid))
    .sort();
  if (unregisteredLiveUuids.length > 0) {
    unverifiedReasons.push(
      `unregistered live PCB documents: ${unregisteredLiveUuids.join(", ")}`,
    );
  }
  const missingRegisteredUuids = revisions
    .filter(
      (revision) =>
        revision.status !== "deleted" && !liveUuids.has(revision.uuid),
    )
    .map((revision) => revision.uuid)
    .filter(Boolean)
    .sort();
  if (missingRegisteredUuids.length > 0) {
    unverifiedReasons.push(
      `registered non-deleted PCB documents missing from tree: ${missingRegisteredUuids.join(", ")}`,
    );
  }

  const activeCandidates = revisions.filter(
    (revision) =>
      revision.status === "active" &&
      (revision.role === "working" || revision.role === "final"),
  );
  const activeDiagnostics = revisions.filter(
    (revision) =>
      revision.status === "active" && revision.role === "diagnostic",
  );
  if (activeCandidates.length > 1) {
    blockedReasons.push("more than one active working/final PCB exists");
  }
  if (activeDiagnostics.length > 1) {
    blockedReasons.push("more than one active diagnostic PCB exists");
  }

  if (intent) {
    if (!ROLES.has(intent.role)) blockedReasons.push("intent role is invalid");
    if (!nonempty(intent.reason)) blockedReasons.push("intent reason is required");
    if (!nonempty(intent.successGate)) {
      blockedReasons.push("intent success gate is required");
    }
    if (!CLEANUP.has(intent.cleanupDisposition)) {
      blockedReasons.push("intent cleanup disposition is invalid");
    }
    if (
      (intent.role === "diagnostic" || intent.role === "final") &&
      !nonempty(intent.parentUuid)
    ) {
      blockedReasons.push(`${intent.role} intent requires a parent UUID`);
    }
    if (
      nonempty(intent.parentUuid) &&
      !revisions.some(
        (revision) =>
          revision.uuid === intent.parentUuid && revision.status !== "deleted",
      )
    ) {
      blockedReasons.push("intent parent UUID is not a registered live revision");
    }
    if (
      (intent.role === "working" || intent.role === "final") &&
      activeCandidates.length > 0
    ) {
      blockedReasons.push(
        "retire or preserve the current active working/final PCB before creating another",
      );
    }
    if (intent.role === "diagnostic" && activeDiagnostics.length > 0) {
      blockedReasons.push(
        "classify and dispose of the active diagnostic PCB before creating another",
      );
    }
  }

  const decision =
    unverifiedReasons.length > 0
      ? "UNVERIFIED"
      : blockedReasons.length > 0
        ? "BLOCKED"
        : "ALLOWED";
  return {
    decision,
    projectUuid: manifest?.projectUuid || null,
    livePcbCount: tree.pcbs.length,
    registeredRevisionCount: revisions.length,
    activeCandidateUuids: activeCandidates.map((revision) => revision.uuid),
    activeDiagnosticUuids: activeDiagnostics.map((revision) => revision.uuid),
    unregisteredLiveUuids,
    missingRegisteredUuids,
    blockedReasons,
    unverifiedReasons,
    intent: intent || null,
  };
}

function treeCollectorCode() {
  return `
const project = await eda.dmt_Project.getCurrentProjectInfo();
if (!project) throw new Error("current project unavailable");
return {
  project: { uuid: project.uuid, name: project.friendlyName || project.name || "" },
  boards: await eda.dmt_Board.getAllBoardsInfo(),
  schematics: await eda.dmt_Schematic.getAllSchematicsInfo(),
  pcbs: await eda.dmt_Pcb.getAllPcbsInfo(),
};
`;
}

async function collectTree(bridgePort, windowId) {
  const call = await executeEasyedaCode({ code: treeCollectorCode(), bridgePort, windowId, timeoutMs: 35_000 });
  const { response } = call;
  if (!response.success || !response.result) {
    throw new Error(response.error || "document tree collection failed");
  }
  return { ...call, result: response.result };
}

function selfTestFixtures() {
  const manifest = {
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
  const tree = { project: { uuid: "project-1" }, pcbs: [{ uuid: "pcb-1" }] };
  return { manifest, tree };
}

function runSelfTest() {
  const { manifest, tree } = selfTestFixtures();
  const allowed = analyzeRevisionIntent(manifest, tree, {
    role: "diagnostic",
    parentUuid: "pcb-1",
    reason: "test one hidden-cache hypothesis",
    successGate: "PCB_SYNC_MATCH",
    cleanupDisposition: "delete-after-proof",
  });
  if (allowed.decision !== "ALLOWED") {
    throw new Error("valid diagnostic intent was not allowed");
  }
  const withDiagnostic = structuredClone(manifest);
  withDiagnostic.revisions.push({
    uuid: "pcb-diag",
    parentUuid: "pcb-1",
    role: "diagnostic",
    status: "active",
    reason: "existing diagnostic",
    successGate: "PCB_SYNC_MATCH",
    cleanupDisposition: "needs-user-decision",
  });
  const treeWithDiagnostic = structuredClone(tree);
  treeWithDiagnostic.pcbs.push({ uuid: "pcb-diag" });
  const blocked = analyzeRevisionIntent(withDiagnostic, treeWithDiagnostic, {
    role: "diagnostic",
    parentUuid: "pcb-1",
    reason: "second diagnostic",
    successGate: "PCB_SYNC_MATCH",
    cleanupDisposition: "delete-after-proof",
  });
  if (blocked.decision !== "BLOCKED") {
    throw new Error("second diagnostic intent was not blocked");
  }
  const unregistered = analyzeRevisionIntent(manifest, {
    ...tree,
    pcbs: [...tree.pcbs, { uuid: "pcb-unregistered" }],
  });
  if (unregistered.decision !== "UNVERIFIED") {
    throw new Error("unregistered live PCB was not rejected");
  }
}

async function readJsonInput(file) {
  return JSON.parse(await readFile(resolveSafeInputPath(file), "utf8"));
}

async function main() {
  const startedAt = CLI_STARTED_AT;
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.selfTest) {
    runSelfTest();
    process.stdout.write("easyeda revision guard self-test passed\n");
    return;
  }
  const manifest = await readJsonInput(options.manifest);
  let tree;
  let bridgeInfo = null;
  if (options.treeFile) {
    tree = await readJsonInput(options.treeFile);
  } else {
    const call = await collectTree(options.bridgePort, options.windowId);
    tree = call.result;
    bridgeInfo = { port: call.bridge.port, windowId: call.windowId, health: call.bridge.health };
  }
  const intent = options.intentRole
    ? {
        role: options.intentRole,
        parentUuid: options.parentUuid,
        reason: options.reason,
        successGate: options.successGate,
        cleanupDisposition: options.cleanupDisposition,
      }
    : undefined;
  const analysis = analyzeRevisionIntent(manifest, tree, intent);
  const report = {
    schemaVersion: 1,
    kind: "easyeda-revision-guard",
    decision: analysis.decision,
    mutatesEasyeda: false,
    bridge: bridgeInfo,
    manifest: options.manifest,
    treeSource: options.treeFile || "live-bridge",
    analysis,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const output = await writeNewJson(options.output, report, { force: options.force });
  const endedAt = new Date();
  await appendToolLogEntry(resolveOperationLogPath(options.operationLog, options.output), {
    tool: "easyeda_revision_guard.mjs",
    gate: "REVISION_BUDGET_CLEAR",
    operation: "EasyEDA revision manifest and live document-tree guard",
    outcome: "READ_ONLY",
    semanticReadback: `${analysis.decision}; ${analysis.issues?.length || 0} issue(s)`,
    startedAt,
    endedAt,
    attemptDisposition: analysis.decision === "ALLOWED" ? "ACCEPTED" : analysis.decision === "BLOCKED" ? "REJECTED" : "UNKNOWN",
    gateProgress: analysis.decision === "ALLOWED" ? "CLOSED" : analysis.decision === "BLOCKED" ? "BLOCKED" : "NO_CHANGE",
    evidence: [output],
  });
  process.stdout.write(text);
  process.exitCode =
    analysis.decision === "ALLOWED"
      ? EXIT.OK
      : analysis.decision === "UNVERIFIED"
        ? EXIT.UNVERIFIED
        : EXIT.BLOCKED;
}

if (isMain(import.meta.url)) {
  main().catch(async (error) => {
    await appendToolFailureFromArgv(process.argv.slice(2), {
      tool: "easyeda_revision_guard.mjs", gate: "REVISION_BUDGET_CLEAR", startedAt: CLI_STARTED_AT, error,
      defaultOutput: DEFAULT_OUTPUT,
    }).catch(() => {});
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.ERROR;
  });
}

export {
  CLEANUP,
  EXIT,
  ROLES,
  STATUSES,
  analyzeRevisionIntent,
  normalizeTree,
  parseArgs,
  resolveSafeInputPath,
  treeCollectorCode,
};

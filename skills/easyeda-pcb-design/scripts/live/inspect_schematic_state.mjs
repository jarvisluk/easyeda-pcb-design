#!/usr/bin/env node

import path from "node:path";

import { appendToolFailureFromArgv, appendToolLogEntry } from "./lib/operation_log.mjs";
import {
  analyzeErcEvidence,
  finalizeSchematicRaw,
  schematicCollectorCode,
  schematicFingerprint,
  schematicSemanticFingerprint,
} from "./lib/schematic_state.mjs";
import {
  cliFailure,
  executeEasyedaCode,
  isMain,
  readJsonFile,
  resolveArtifactRoot,
  resolveContainedPath,
  resolveOperationLogPath,
  timestampSlug,
  writeContainedJson,
  writeNewJson,
} from "./lib/tool_runtime.mjs";
import { validateSchematicTransactionPlan } from "./lib/schematic_transaction_plan.mjs";

const CLI_STARTED_AT = new Date();
const DEFAULT_OUTPUT = `evidence/readbacks/schematic-state-${timestampSlug(CLI_STARTED_AT)}.json`;

function usage() {
  return `Usage:
  node scripts/live/inspect_schematic_state.mjs \
    [--plan FILE --stage before|after | --schematic-uuid UUID --schematic-page-uuid UUID] \
    --switch-document-uuid UUID [--output FILE] [--with-drc|--with-erc] [options]
  node scripts/live/inspect_schematic_state.mjs --self-test

The tool switches away, reopens the target page, captures parts, annotations,
wires, the JLCEDA netlist, and optional repeated detailed ERC. Every non-self-test
invocation appends its own schema-2 operation-log entry.

--with-drc is the preferred name; --with-erc is retained as a compatibility
alias. Both run EasyEDA SCH_Drc.check and produce the SCHEMATIC_DRC_CLEAR axis.
`;
}

function parseArgs(argv) {
  const options = {
    schematicUuid: null, schematicPageUuid: null, switchDocumentUuid: null,
    plan: null, stage: null, output: null, operationLog: null, withErc: false, bridgePort: null,
    windowId: null, selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--schematic-uuid") options.schematicUuid = next();
    else if (option === "--schematic-page-uuid") options.schematicPageUuid = next();
    else if (option === "--switch-document-uuid") options.switchDocumentUuid = next();
    else if (option === "--plan") options.plan = next();
    else if (option === "--stage") options.stage = next();
    else if (option === "--output") options.output = next();
    else if (option === "--operation-log") options.operationLog = next();
    else if (option === "--with-drc" || option === "--with-erc") options.withErc = true;
    else if (option === "--bridge-port") options.bridgePort = Number(next());
    else if (option === "--window-id") options.windowId = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (options.bridgePort !== null && (!Number.isInteger(options.bridgePort) || options.bridgePort < 1 || options.bridgePort > 65535)) {
    throw new Error("--bridge-port must be an integer from 1 through 65535");
  }
  if (!options.selfTest) {
    if (options.plan && !["before", "after"].includes(options.stage)) {
      throw new Error("--plan requires --stage before or --stage after");
    }
    if (options.stage && !options.plan) throw new Error("--stage requires --plan");
    const required = options.plan ? ["switchDocumentUuid"] : ["schematicUuid", "schematicPageUuid", "switchDocumentUuid"];
    for (const field of required) {
      if (!options[field]) throw new Error(`--${field.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`);
    }
    if (!options.plan && options.schematicPageUuid === options.switchDocumentUuid) throw new Error("switch document must differ from target schematic page");
  }
  return options;
}

function reportFromRaw(raw, { withErc = false } = {}) {
  const erc = analyzeErcEvidence(raw);
  return {
    schemaVersion: 2,
    kind: "easyeda-schematic-state",
    fabricationRelease: false,
    fingerprint: schematicFingerprint(raw),
    semanticFingerprint: schematicSemanticFingerprint(raw),
    project: raw.project,
    schematic: raw.schematic,
    document: raw.document,
    reopen: raw.reopen,
    axes: {
      identity: { status: "CAPTURED", componentCount: raw.components.length, wireCount: raw.wires.length },
      netlist: { status: "CAPTURED", componentCount: Object.keys(raw.netlist?.components || {}).length },
      erc: withErc ? erc : {
        status: "NOT_RUN", decision: "UNVERIFIED", passed: false, stable: false,
        leaves: [], reason: "--with-drc/--with-erc was omitted",
      },
    },
    raw,
  };
}

function selfTest() {
  const raw = finalizeSchematicRaw({
    kind: "schematic", project: { uuid: "project-1" }, schematic: { uuid: "schematic-1" },
    document: { uuid: "page-1", documentType: 1 }, reopen: { performed: true },
    components: [{ primitiveId: "c1", designator: "U1", uniqueId: "U1-STABLE", x: 10, y: 20 }],
    annotations: [], wires: [{ primitiveId: "w1", net: "GND", line: [0, 0, 10, 0] }],
    netlistText: JSON.stringify({ components: { "U1-STABLE": { props: { Designator: "U1", "Unique ID": "U1-STABLE" }, pinInfoMap: {} } } }),
    ercEvidence: { schemaVersion: 1, samples: [
      { id: "silent-1", strict: true, userInterface: false, includeVerboseError: true, result: [] },
      { id: "silent-2", strict: true, userInterface: false, includeVerboseError: true, result: [] },
      { id: "visible-final", strict: true, userInterface: true, includeVerboseError: true, result: [] },
    ] },
  });
  const report = reportFromRaw(raw, { withErc: true });
  if (!/^sha256:[0-9a-f]{64}$/.test(report.fingerprint)) throw new Error("schematic fingerprint was not generated");
  if (report.axes.erc.status !== "CAPTURED" || report.axes.erc.decision !== "CLEAR" || !report.axes.erc.stable) {
    throw new Error("stable schematic DRC fixture did not clear");
  }
  const blockedRaw = structuredClone(raw);
  for (const sample of blockedRaw.ercEvidence.samples) {
    sample.result = [{ type: "error", count: 1, list: [{ errorType: "Unconnected", errorObjType: "pin" }] }];
  }
  const blocked = reportFromRaw(blockedRaw, { withErc: true });
  if (blocked.axes.erc.decision !== "BLOCKED" || blocked.axes.erc.errorCount !== 1) {
    throw new Error("stable schematic DRC error fixture was not blocked");
  }
  if (!schematicCollectorCode({ schematicPageUuid: "p", schematicUuid: "s", switchDocumentUuid: "x", includeErc: true }).includes("sch_ManufactureData.getNetlistFile")) {
    throw new Error("schematic collector lacks netlist readback");
  }
  process.stdout.write("inspect schematic state self-test passed\n");
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.selfTest) return selfTest();
  let artifactRoot = null;
  let outputRelative = options.output || DEFAULT_OUTPUT;
  let operationLogPath = resolveOperationLogPath(options.operationLog, outputRelative);
  if (options.plan) {
    const planPath = path.resolve(options.plan);
    const validation = validateSchematicTransactionPlan(await readJsonFile(planPath, "schematic transaction plan"));
    if (!validation.executable) throw new Error(validation.errors.join("; "));
    const plan = validation.plan;
    artifactRoot = resolveArtifactRoot(planPath, plan.artifactRoot);
    options.schematicUuid = plan.schematicUuid;
    options.schematicPageUuid = plan.schematicPageUuid;
    if (options.switchDocumentUuid === options.schematicPageUuid) throw new Error("switch document must differ from target schematic page");
    outputRelative = options.output || plan.controls[
      options.stage === "before" ? "preEditState" : "postEditState"
    ];
    operationLogPath = resolveContainedPath(artifactRoot, plan.controls.operationLog, "operation log");
  }
  const call = await executeEasyedaCode({
    code: schematicCollectorCode({
      schematicPageUuid: options.schematicPageUuid,
      schematicUuid: options.schematicUuid,
      switchDocumentUuid: options.switchDocumentUuid,
      includeErc: options.withErc,
    }),
    bridgePort: options.bridgePort,
    windowId: options.windowId,
    timeoutMs: options.withErc ? 120_000 : 35_000,
  });
  if (!call.response.success || !call.response.result) throw new Error(call.response.error || "schematic state collection failed");
  const raw = finalizeSchematicRaw(call.response.result);
  const report = reportFromRaw(raw, { withErc: options.withErc });
  const output = artifactRoot
    ? await writeContainedJson(artifactRoot, outputRelative, report)
    : await writeNewJson(outputRelative, report);
  const endedAt = new Date();
  await appendToolLogEntry(operationLogPath, {
    tool: "inspect_schematic_state.mjs",
    gate: "SCHEMATIC_READBACK_CAPTURED",
    operation: `save/switch/reopen schematic state inspection${options.withErc ? " with repeated strict DRC/ERC" : ""}`,
    outcome: "READ_ONLY",
    semanticReadback: `${report.axes.identity.componentCount} component(s), ${report.axes.identity.wireCount} wire(s), fingerprint ${report.fingerprint}`,
    startedAt: CLI_STARTED_AT,
    endedAt,
    attemptDisposition: options.withErc && report.axes.erc.status !== "CAPTURED" ? "UNKNOWN" : "ACCEPTED",
    gateProgress: "NO_CHANGE",
    evidence: [output],
  });
  process.stdout.write(`${JSON.stringify({
    status: "SCHEMATIC_STATE_CAPTURED", output, fingerprint: report.fingerprint,
    schematicDrc: report.axes.erc.decision, errorCount: report.axes.erc.errorCount,
    warningCount: report.axes.erc.warningCount,
  })}\n`);
}

if (isMain(import.meta.url)) {
  main().catch(async (error) => {
    await appendToolFailureFromArgv(process.argv.slice(2), {
      tool: "inspect_schematic_state.mjs", gate: "SCHEMATIC_READBACK_CAPTURED", startedAt: CLI_STARTED_AT, error,
      defaultOutput: DEFAULT_OUTPUT,
    }).catch(() => {});
    cliFailure(error, "easyeda-schematic-state");
  });
}

export { DEFAULT_OUTPUT, parseArgs, reportFromRaw, selfTest };

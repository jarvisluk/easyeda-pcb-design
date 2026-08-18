#!/usr/bin/env node

import path from "node:path";

import { collectorCode } from "../audits/easyeda_design_audit.mjs";
import {
  designFingerprint,
  notAFabricationReleaseMessage,
} from "../lib/audit_common.mjs";
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
import { appendToolFailureFromArgv, appendToolLogEntry } from "./lib/operation_log.mjs";
import { validateTransactionPlan } from "./lib/transaction_plan.mjs";

const CLI_STARTED_AT = new Date();
const DEFAULT_OUTPUT = `evidence/readbacks/pcb-state-${timestampSlug(CLI_STARTED_AT)}.json`;

function usage() {
  return `Usage:
  node scripts/live/inspect_current_state.mjs [--plan FILE --stage before|after] [options]

Options:
  --with-drc           Include the formal repeated native DRC sequence.
  --plan FILE          Bind output to a transaction plan.
  --stage VALUE        Write the plan's before or after state path.
  --output FILE        Override the generated or plan-bound output path.
  --bridge-port PORT   Use one bridge port instead of discovery.
  --window-id ID       Required when multiple EasyEDA windows are connected.
  --operation-log FILE Override the tool-managed log path derived from --output.
  --self-test          Run deterministic summary checks.
`;
}

function parseArgs(argv) {
  const options = { output: null, plan: null, stage: null, operationLog: null, withDrc: false, bridgePort: null, windowId: null, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--output") options.output = next();
    else if (option === "--plan") options.plan = next();
    else if (option === "--stage") options.stage = next();
    else if (option === "--operation-log") options.operationLog = next();
    else if (option === "--with-drc") options.withDrc = true;
    else if (option === "--bridge-port") options.bridgePort = Number(next());
    else if (option === "--window-id") options.windowId = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (options.plan && !["before", "after"].includes(options.stage)) {
    throw new Error("--plan requires --stage before or --stage after");
  }
  if (options.stage && !options.plan) throw new Error("--stage requires --plan");
  return options;
}

function summarizeCurrentState(raw, withDrc = false) {
  if (raw?.kind !== "pcb") throw new Error("current-state inspection requires an active PCB");
  const outlineLayerId = raw.boardOutlineLayerId;
  const outline = {
    layerId: outlineLayerId ?? null,
    looseLineIds: (raw.lines || [])
      .filter((item) => Number(item.layer) === Number(outlineLayerId))
      .map((item) => item.primitiveId || null),
    looseArcIds: (raw.arcs || [])
      .filter((item) => Number(item.layer) === Number(outlineLayerId))
      .map((item) => item.primitiveId || null),
    nativePolylines: (raw.polylines || [])
      .filter((item) => Number(item.layer) === Number(outlineLayerId))
      .map((item) => ({
        primitiveId: item.primitiveId || null,
        locked: item.locked === true,
        closed: item.closed === true,
        pointCount: Array.isArray(item.points) ? item.points.length : 0,
      })),
  };
  const sourcePours = raw.pours || [];
  const generatedFillCount = sourcePours.reduce(
    (total, item) => total + (Number.isFinite(item?.solidFillCount) ? item.solidFillCount : 0),
    0,
  );
  const collections = {
    lines: raw.lines || [],
    vias: raw.vias || [],
    components: raw.components || [],
    polylines: raw.polylines || [],
    pours: raw.pours || [],
    poured: raw.poured || [],
  };
  const primitiveIndex = Object.fromEntries(
    Object.entries(collections).map(([kind, items]) => [
      kind,
      items.map((item) => item.primitiveId || null).filter(Boolean).sort(),
    ]),
  );
  return {
    schemaVersion: 2,
    kind: "easyeda-current-state",
    status: "CURRENT_STATE_CAPTURED",
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    capturedAt: new Date().toISOString(),
    project: raw.project,
    document: raw.document,
    fingerprint: designFingerprint(raw),
    counts: {
      components: (raw.components || []).length,
      pads: (raw.pads || []).length,
      lines: (raw.lines || []).length,
      arcs: (raw.arcs || []).length,
      polylines: (raw.polylines || []).length,
      vias: (raw.vias || []).length,
      sourcePours: sourcePours.length,
      poured: (raw.poured || []).length,
      generatedPoured: generatedFillCount,
    },
    axes: {
      geometry: "CAPTURED",
      boardOutline: outline,
      copper: {
        sourcePourIds: sourcePours.map((item) => item.primitiveId || null),
        generatedPouredIds: [
          ...(raw.poured || []).map((item) => item.primitiveId || null),
          ...sourcePours.flatMap((item) => item.solidFillIds || []),
        ].filter(Boolean),
      },
      drc: withDrc ? { status: "CAPTURED", raw: raw.drc, evidence: raw.drcEvidence } : { status: "NOT_RUN" },
    },
    primitiveIndex,
    raw,
  };
}

function selfTest() {
  const raw = {
    kind: "pcb",
    project: { uuid: "project-1" },
    document: { uuid: "pcb-1", documentType: 3 },
    boardOutlineLayerId: 11,
    components: [], pads: [], lines: [], arcs: [], segments: [], vias: [], pours: [], poured: [],
    polylines: [{ primitiveId: "outline-1", layer: 11, locked: true, closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 0]] }],
  };
  const result = summarizeCurrentState(raw, false);
  if (result.axes.boardOutline.nativePolylines[0]?.primitiveId !== "outline-1") {
    throw new Error("native outline was absent from current-state summary");
  }
  if (result.axes.drc.status !== "NOT_RUN") throw new Error("read-only fast state unexpectedly claimed DRC");
  if (!Array.isArray(result.primitiveIndex.poured)) throw new Error("poured primitive index is absent");
  process.stdout.write(`${JSON.stringify({ status: result.status, schemaVersion: result.schemaVersion, drc: result.axes.drc.status })}\n`);
}

async function main() {
  const startedAt = CLI_STARTED_AT;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) return selfTest();
    let artifactRoot = null;
    let outputRelative = options.output || DEFAULT_OUTPUT;
    let operationLogPath = resolveOperationLogPath(options.operationLog, outputRelative);
    if (options.plan) {
      const planPath = path.resolve(options.plan);
      const validation = validateTransactionPlan(await readJsonFile(planPath, "transaction plan"));
      if (!validation.executable) throw new Error([...validation.errors, ...validation.warnings].join("; "));
      artifactRoot = resolveArtifactRoot(planPath, validation.plan.artifactRoot);
      outputRelative = options.output || validation.plan.controls[
        options.stage === "before" ? "preEditState" : "postEditState"
      ];
      operationLogPath = resolveContainedPath(artifactRoot, validation.plan.controls.operationLog, "operation log");
    }
    const { response } = await executeEasyedaCode({
      code: collectorCode({ includeDrc: options.withDrc }),
      bridgePort: options.bridgePort,
      windowId: options.windowId,
    });
    if (!response.success) throw new Error(response.error || "EasyEDA current-state readback failed");
    const result = summarizeCurrentState(response.result, options.withDrc);
    const output = artifactRoot
      ? await writeContainedJson(artifactRoot, outputRelative, result)
      : await writeNewJson(outputRelative, result);
    const endedAt = new Date();
    await appendToolLogEntry(operationLogPath, {
      tool: "inspect_current_state.mjs",
      gate: options.withDrc ? "SAVED_REOPENED_STATE_CAPTURED" : "PREFLIGHT_STATE_CAPTURED",
      operation: options.withDrc ? "saved/reopened PCB state and repeated DRC capture" : "fast PCB current-state preflight",
      outcome: "READ_ONLY",
      semanticReadback: `${result.status}; fingerprint ${result.fingerprint}; DRC ${result.axes.drc.status}`,
      startedAt,
      endedAt,
      attemptDisposition: "ACCEPTED",
      gateProgress: options.withDrc ? "CLOSED" : "NO_CHANGE",
      evidence: [output],
    });
    process.stdout.write(`${JSON.stringify({ status: result.status, fingerprint: result.fingerprint, output })}\n`);
  } catch (error) {
    await appendToolFailureFromArgv(process.argv.slice(2), {
      tool: "inspect_current_state.mjs", gate: "CURRENT_STATE_CAPTURE", startedAt, error,
      defaultOutput: DEFAULT_OUTPUT,
    }).catch(() => {});
    cliFailure(error, "easyeda-current-state");
  }
}

if (isMain(import.meta.url)) await main();

export { DEFAULT_OUTPUT, parseArgs, summarizeCurrentState };

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { notAFabricationReleaseMessage } from "../lib/audit_common.mjs";
import { appendToolFailureFromArgv, appendToolLogEntry } from "./lib/operation_log.mjs";
import { evidencePathFromInput, isMain, resolveOperationLogPath, writeNewJson } from "./lib/tool_runtime.mjs";

const CLI_STARTED_AT = new Date();
const FAILURE_OUTPUT = "evidence/readbacks/schematic-checkpoint-error.json";

function defaultOutput(options) {
  const source = options.mode === "create" ? options.native : options.manifest;
  const stem = path.basename(source || "schematic", path.extname(source || ""))
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (options.mode === "create") return evidencePathFromInput(source, "snapshots", `${stem}-checkpoint.json`);
  if (options.mode === "verify-restore") return evidencePathFromInput(source, "readbacks", `${stem}-restore-check.json`);
  return evidencePathFromInput(source, "readbacks", `${stem}-check.json`);
}

function usage() {
  return `Usage:
  node scripts/live/easyeda_schematic_checkpoint.mjs create \
    --native FILE.epro --readback STATE.json [--output MANIFEST.json] [--operation-log FILE]
  node scripts/live/easyeda_schematic_checkpoint.mjs verify \
    --manifest MANIFEST.json --native FILE.epro --readback STATE.json [--output CHECK.json] [--operation-log FILE]
  node scripts/live/easyeda_schematic_checkpoint.mjs verify-restore \
    --manifest MANIFEST.json --native FILE.epro --readback RESTORED_STATE.json [--output CHECK.json] [--operation-log FILE]
  node scripts/live/easyeda_schematic_checkpoint.mjs --self-test

The readback must be inspect_schematic_state.mjs output. verify-restore requires
a separate non-production project and proves semantic equality, not fabrication readiness.
`;
}

function parseArgs(argv) {
  const input = [...argv];
  const options = { mode: null, native: null, readback: null, manifest: null, output: null, operationLog: null, selfTest: false };
  if (["create", "verify", "verify-restore"].includes(input[0])) options.mode = input.shift();
  for (let index = 0; index < input.length; index += 1) {
    const option = input[index];
    const next = () => {
      index += 1;
      if (index >= input.length) throw new Error(`${option} requires a value`);
      return input[index];
    };
    if (option === "--native") options.native = next();
    else if (option === "--readback") options.readback = next();
    else if (option === "--manifest") options.manifest = next();
    else if (option === "--output") options.output = next();
    else if (option === "--operation-log") options.operationLog = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!options.selfTest) {
    if (!options.mode) throw new Error("mode must be create, verify, or verify-restore");
    for (const field of ["native", "readback"]) if (!options[field]) throw new Error(`--${field.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`);
    if (options.mode !== "create" && !options.manifest) throw new Error("--manifest is required for verify and verify-restore");
    if (!options.output) options.output = defaultOutput(options);
  }
  return options;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function summary(state) {
  if (state?.kind !== "easyeda-schematic-state" || state?.schemaVersion !== 2 || state?.raw?.kind !== "schematic") {
    throw new Error("readback must be schema-2 inspect_schematic_state.mjs output");
  }
  if (state.reopen?.performed !== true) throw new Error("schematic checkpoint readback must prove a switch/reopen cycle");
  return {
    projectUuid: state.project?.uuid || null,
    schematicUuid: state.schematic?.uuid || null,
    schematicPageUuid: state.document?.uuid || null,
    fingerprint: state.fingerprint || null,
    semanticFingerprint: state.semanticFingerprint || null,
    componentCount: state.raw.components?.length || 0,
    annotationCount: state.raw.annotations?.length || 0,
    wireCount: state.raw.wires?.length || 0,
    netlistComponentCount: Object.keys(state.raw.netlist?.components || {}).length,
  };
}

async function createCheckpoint(nativePath, readbackPath) {
  if (path.extname(nativePath).toLowerCase() !== ".epro") throw new Error("native checkpoint must use the .epro extension");
  const [nativeBytes, nativeStat, readbackBytes] = await Promise.all([readFile(nativePath), stat(nativePath), readFile(readbackPath)]);
  if (!nativeBytes.length) throw new Error("native .epro checkpoint is empty");
  const state = JSON.parse(readbackBytes.toString("utf8"));
  const revision = summary(state);
  if (!revision.projectUuid || !revision.schematicUuid || !revision.schematicPageUuid || !revision.fingerprint || !revision.semanticFingerprint) {
    throw new Error("schematic checkpoint readback lacks bound identity or fingerprints");
  }
  return {
    schemaVersion: 1,
    kind: "easyeda-schematic-checkpoint",
    status: "SCHEMATIC_CHECKPOINT_VERIFIED",
    restoreReady: false,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    createdAt: new Date().toISOString(),
    nativeArtifact: { path: path.resolve(nativePath), sha256: sha256(nativeBytes), bytes: nativeBytes.length, modifiedAt: nativeStat.mtime.toISOString() },
    readbackArtifact: { path: path.resolve(readbackPath), sha256: sha256(readbackBytes) },
    revision,
    restoreDetector: {
      requiredProjectUuid: revision.projectUuid,
      requiredSchematicUuid: revision.schematicUuid,
      requiredSchematicPageUuid: revision.schematicPageUuid,
      requiredFingerprint: revision.fingerprint,
      requiredSemanticFingerprint: revision.semanticFingerprint,
      requiredCounts: {
        componentCount: revision.componentCount, annotationCount: revision.annotationCount,
        wireCount: revision.wireCount, netlistComponentCount: revision.netlistComponentCount,
      },
    },
    limitations: [
      "The manifest binds native bytes to one saved/reopened schematic readback.",
      "Only verify-restore in a separate non-production project proves restore compatibility.",
      "The checkpoint is rollback evidence, not fabrication or ordering authorization.",
    ],
  };
}

function compareCounts(actual, expected, prefix, reasons) {
  for (const [field, value] of Object.entries(expected || {})) if (actual[field] !== value) reasons.push(`${prefix}${field} mismatch`);
}

function verifyCheckpoint(manifest, nativeBytes, state, readbackBytes = null) {
  if (manifest?.kind !== "easyeda-schematic-checkpoint" || manifest?.schemaVersion !== 1) throw new Error("manifest must be easyeda-schematic-checkpoint schemaVersion 1");
  const actual = summary(state);
  const detector = manifest.restoreDetector || {};
  const reasons = [];
  if (sha256(nativeBytes) !== manifest.nativeArtifact?.sha256) reasons.push("native .epro SHA-256 mismatch");
  if (nativeBytes.length !== manifest.nativeArtifact?.bytes) reasons.push("native .epro byte-length mismatch");
  if (readbackBytes && sha256(readbackBytes) !== manifest.readbackArtifact?.sha256) reasons.push("schematic readback SHA-256 mismatch");
  if (actual.projectUuid !== detector.requiredProjectUuid) reasons.push("project UUID mismatch");
  if (actual.schematicUuid !== detector.requiredSchematicUuid) reasons.push("parent schematic UUID mismatch");
  if (actual.schematicPageUuid !== detector.requiredSchematicPageUuid) reasons.push("schematic page UUID mismatch");
  if (actual.fingerprint !== detector.requiredFingerprint) reasons.push("schematic revision fingerprint mismatch");
  compareCounts(actual, detector.requiredCounts, "", reasons);
  return {
    schemaVersion: 1, kind: "easyeda-schematic-checkpoint-check",
    status: reasons.length ? "SCHEMATIC_CHECKPOINT_MISMATCH" : "SCHEMATIC_CHECKPOINT_MATCH",
    executeAllowed: reasons.length === 0, restoreReady: false, fabricationRelease: false,
    liveFingerprint: actual.fingerprint, projectUuid: actual.projectUuid, schematicUuid: actual.schematicUuid,
    schematicPageUuid: actual.schematicPageUuid, checkedAt: new Date().toISOString(), reasons,
  };
}

function verifyRestore(manifest, nativeBytes, state) {
  if (manifest?.kind !== "easyeda-schematic-checkpoint" || manifest?.schemaVersion !== 1) throw new Error("manifest must be easyeda-schematic-checkpoint schemaVersion 1");
  const actual = summary(state);
  const detector = manifest.restoreDetector || {};
  const reasons = [];
  if (sha256(nativeBytes) !== manifest.nativeArtifact?.sha256) reasons.push("restored native .epro SHA-256 mismatch");
  if (actual.projectUuid === detector.requiredProjectUuid) reasons.push("restore verification must use a separate non-production project");
  if (actual.semanticFingerprint !== detector.requiredSemanticFingerprint) reasons.push("restored schematic semantic content differs from checkpoint");
  compareCounts(actual, detector.requiredCounts, "restored ", reasons);
  return {
    schemaVersion: 1, kind: "easyeda-schematic-restore-check",
    status: reasons.length ? "SCHEMATIC_RESTORE_MISMATCH" : "SCHEMATIC_RESTORE_MATCH",
    executeAllowed: reasons.length === 0, restoreReady: reasons.length === 0, fabricationRelease: false,
    liveFingerprint: detector.requiredFingerprint || null,
    restoredProjectUuid: actual.projectUuid, restoredSchematicUuid: actual.schematicUuid,
    restoredSchematicPageUuid: actual.schematicPageUuid, restoredSemanticFingerprint: actual.semanticFingerprint,
    checkedAt: new Date().toISOString(), reasons,
  };
}

async function selfTest() {
  const directory = await mkdtemp(path.join(tmpdir(), "easyeda-schematic-checkpoint-"));
  try {
    const nativePath = path.join(directory, "checkpoint.epro");
    const statePath = path.join(directory, "state.json");
    const state = {
      schemaVersion: 2, kind: "easyeda-schematic-state", fingerprint: `sha256:${"a".repeat(64)}`,
      semanticFingerprint: `sha256:${"b".repeat(64)}`, project: { uuid: "project-1" }, schematic: { uuid: "schematic-1" },
      document: { uuid: "page-1" }, reopen: { performed: true }, raw: { kind: "schematic", components: [], annotations: [], wires: [], netlist: { components: {} } },
    };
    await writeFile(nativePath, "native-schematic-fixture");
    await writeFile(statePath, `${JSON.stringify(state)}\n`);
    const manifest = await createCheckpoint(nativePath, statePath);
    const [nativeBytes, stateBytes] = await Promise.all([readFile(nativePath), readFile(statePath)]);
    if (verifyCheckpoint(manifest, nativeBytes, state, stateBytes).status !== "SCHEMATIC_CHECKPOINT_MATCH") throw new Error("matching schematic checkpoint did not clear");
    const restored = structuredClone(state);
    restored.project.uuid = "probe-project";
    restored.schematic.uuid = "probe-schematic";
    restored.document.uuid = "probe-page";
    if (verifyRestore(manifest, nativeBytes, restored).status !== "SCHEMATIC_RESTORE_MATCH") throw new Error("matching schematic restore did not clear");
    if (!verifyRestore(manifest, nativeBytes, state).reasons.some((reason) => /separate/.test(reason))) throw new Error("same-project restore was accepted");
    process.stdout.write("easyeda schematic checkpoint self-test passed\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.selfTest) return selfTest();
  let result;
  if (options.mode === "create") result = await createCheckpoint(path.resolve(options.native), path.resolve(options.readback));
  else {
    const [manifestBytes, nativeBytes, readbackBytes] = await Promise.all([
      readFile(path.resolve(options.manifest)), readFile(path.resolve(options.native)), readFile(path.resolve(options.readback)),
    ]);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const state = JSON.parse(readbackBytes.toString("utf8"));
    result = options.mode === "verify-restore" ? verifyRestore(manifest, nativeBytes, state) : verifyCheckpoint(manifest, nativeBytes, state, readbackBytes);
  }
  const output = await writeNewJson(options.output, result);
  const endedAt = new Date();
  const accepted = result.executeAllowed !== false;
  await appendToolLogEntry(resolveOperationLogPath(options.operationLog, options.output), {
    tool: "easyeda_schematic_checkpoint.mjs", gate: "SCHEMATIC_ROLLBACK_EVIDENCE_VERIFIED",
    operation: `schematic native checkpoint ${options.mode}`, outcome: "READ_ONLY",
    semanticReadback: `${result.status}; executeAllowed=${result.executeAllowed ?? false}; restoreReady=${result.restoreReady ?? false}`,
    startedAt: CLI_STARTED_AT, endedAt, attemptDisposition: accepted ? "ACCEPTED" : "REJECTED",
    gateProgress: accepted ? "CLOSED" : "BLOCKED", evidence: [output],
  });
  process.stdout.write(`${JSON.stringify({ status: result.status, output })}\n`);
  process.exitCode = accepted ? 0 : 2;
}

if (isMain(import.meta.url)) {
  main().catch(async (error) => {
    await appendToolFailureFromArgv(process.argv.slice(2), {
      tool: "easyeda_schematic_checkpoint.mjs", gate: "SCHEMATIC_ROLLBACK_EVIDENCE_VERIFIED", startedAt: CLI_STARTED_AT, error,
      defaultOutput: FAILURE_OUTPUT,
    }).catch(() => {});
    process.stderr.write(`${JSON.stringify({ error: error.message, kind: "easyeda-schematic-checkpoint", fabricationRelease: false }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { createCheckpoint, defaultOutput, parseArgs, summary, verifyCheckpoint, verifyRestore };

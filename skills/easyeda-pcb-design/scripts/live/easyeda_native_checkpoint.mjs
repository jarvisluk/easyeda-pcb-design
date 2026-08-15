#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  constraintFingerprint,
  designFingerprint,
  designFingerprintPayload,
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
} from "../lib/audit_common.mjs";

function usage() {
  return `Usage:
  node scripts/live/easyeda_native_checkpoint.mjs create \\
    --native FILE.epro --readback PCB.json --output checkpoint.json
  node scripts/live/easyeda_native_checkpoint.mjs verify \\
    --manifest checkpoint.json --native FILE.epro --readback PCB.json --output check.json
  node scripts/live/easyeda_native_checkpoint.mjs verify-restore \\
    --manifest checkpoint.json --native FILE.epro --readback RESTORED_PCB.json --output restore-check.json
  node scripts/live/easyeda_native_checkpoint.mjs --self-test

Create records a native export plus saved/reopened semantic readback. Verify
requires the exact artifact hash and revision fingerprint. This tool does not
export, import, restore, mutate EasyEDA, or authorize fabrication.
`;
}

function parseArgs(argv) {
  const options = {
    mode: null, native: null, readback: null, manifest: null, output: null, selfTest: false,
  };
  if (["create", "verify", "verify-restore"].includes(argv[0])) options.mode = argv.shift();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--native") options.native = next();
    else if (option === "--readback") options.readback = next();
    else if (option === "--manifest") options.manifest = next();
    else if (option === "--output") options.output = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!options.selfTest) {
    if (!options.mode) throw new Error("mode must be create, verify, or verify-restore");
    for (const field of ["native", "readback", "output"]) {
      if (!options[field]) throw new Error(`--${field} is required`);
    }
    if (["verify", "verify-restore"].includes(options.mode) && !options.manifest) {
      throw new Error("--manifest is required");
    }
    if (options.mode === "create" && options.manifest) throw new Error("--manifest is only valid in verify mode");
  }
  return options;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function semanticContentFingerprint(raw) {
  const payload = designFingerprintPayload(raw);
  delete payload.projectUuid;
  delete payload.documentUuid;
  return constraintFingerprint(payload);
}

function semanticSummary(raw) {
  if (raw?.kind !== "pcb") throw new Error("checkpoint readback must describe one PCB");
  const outlineLayerId = raw.boardOutlineLayerId;
  const outlinePolylines = (raw.polylines || [])
    .filter((item) => Number(item.layer) === Number(outlineLayerId))
    .map((item) => ({
      primitiveId: item.primitiveId || null,
      locked: item.locked === true,
      closed: item.closed === true,
      pointCount: Array.isArray(item.points) ? item.points.length : 0,
    }))
    .sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId)));
  return {
    projectUuid: raw.project?.uuid || null,
    pcbUuid: raw.document?.uuid || null,
    pcbFingerprint: designFingerprint(raw),
    semanticContentFingerprint: semanticContentFingerprint(raw),
    componentCount: (raw.components || []).length,
    padCount: (raw.pads || []).length,
    lineCount: (raw.lines || []).length,
    arcCount: (raw.arcs || []).length,
    polylineCount: (raw.polylines || []).length,
    viaCount: (raw.vias || []).length,
    sourcePourCount: (raw.pours || []).length,
    generatedFillCount: (raw.pours || []).reduce(
      (total, item) => total + (Number.isFinite(item?.solidFillCount) ? item.solidFillCount : 0),
      0,
    ),
    boardOutlineLayerId: outlineLayerId ?? null,
    outlinePolylines,
  };
}

async function createCheckpoint(nativePath, readbackPath) {
  if (path.extname(nativePath).toLowerCase() !== ".epro") {
    throw new Error("native checkpoint artifact must use the .epro extension");
  }
  const [nativeBytes, nativeStat, readbackBytes] = await Promise.all([
    readFile(nativePath),
    stat(nativePath),
    readFile(readbackPath),
  ]);
  if (!nativeBytes.length) throw new Error("native .epro checkpoint is empty");
  const raw = JSON.parse(readbackBytes.toString("utf8"));
  const summary = semanticSummary(raw);
  if (!summary.projectUuid || !summary.pcbUuid) {
    throw new Error("checkpoint readback lacks project or PCB UUID");
  }
  return {
    schemaVersion: 1,
    kind: "easyeda-native-checkpoint",
    status: "NATIVE_CHECKPOINT_VERIFIED",
    restoreReady: false,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    createdAt: new Date().toISOString(),
    nativeArtifact: {
      path: path.resolve(nativePath),
      sha256: sha256(nativeBytes),
      bytes: nativeBytes.length,
      modifiedAt: nativeStat.mtime.toISOString(),
    },
    readbackArtifact: {
      path: path.resolve(readbackPath),
      sha256: sha256(readbackBytes),
    },
    revision: summary,
    restoreDetector: {
      requiredProjectUuid: summary.projectUuid,
      requiredPcbUuid: summary.pcbUuid,
      requiredPcbFingerprint: summary.pcbFingerprint,
      requiredSemanticContentFingerprint: summary.semanticContentFingerprint,
      requiredCounts: {
        componentCount: summary.componentCount,
        padCount: summary.padCount,
        lineCount: summary.lineCount,
        arcCount: summary.arcCount,
        polylineCount: summary.polylineCount,
        viaCount: summary.viaCount,
        sourcePourCount: summary.sourcePourCount,
        generatedFillCount: summary.generatedFillCount,
      },
      requiredOutlinePolylines: summary.outlinePolylines,
    },
    limitations: [
      "The manifest binds the native file bytes to a same-transaction semantic readback; only an actual restore into a non-production probe can prove import compatibility.",
      "A checkpoint is rollback evidence, not authorization for a destructive operation or fabrication.",
    ],
  };
}

function verifyCheckpoint(manifest, nativeBytes, raw, readbackBytes = null) {
  const reasons = [];
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== "easyeda-native-checkpoint") {
    throw new Error("manifest must be easyeda-native-checkpoint schemaVersion 1");
  }
  const summary = semanticSummary(raw);
  if (sha256(nativeBytes) !== manifest.nativeArtifact?.sha256) {
    reasons.push("native .epro SHA-256 does not match the checkpoint manifest");
  }
  if (nativeBytes.length !== manifest.nativeArtifact?.bytes) {
    reasons.push("native .epro byte length does not match the checkpoint manifest");
  }
  if (readbackBytes && sha256(readbackBytes) !== manifest.readbackArtifact?.sha256) {
    reasons.push("semantic readback SHA-256 does not match the checkpoint manifest");
  }
  const detector = manifest.restoreDetector || {};
  if (summary.projectUuid !== detector.requiredProjectUuid) reasons.push("project UUID mismatch");
  if (summary.pcbUuid !== detector.requiredPcbUuid) reasons.push("PCB UUID mismatch");
  if (summary.pcbFingerprint !== detector.requiredPcbFingerprint) reasons.push("PCB fingerprint mismatch");
  for (const [field, expected] of Object.entries(detector.requiredCounts || {})) {
    if (summary[field] !== expected) reasons.push(`${field} mismatch`);
  }
  if (JSON.stringify(summary.outlinePolylines) !== JSON.stringify(detector.requiredOutlinePolylines || [])) {
    reasons.push("native board-outline identity/lock/closure summary mismatch");
  }
  return {
    schemaVersion: 1,
    kind: "easyeda-native-checkpoint-check",
    status: reasons.length ? "CHECKPOINT_MISMATCH" : "NATIVE_CHECKPOINT_MATCH",
    executeAllowed: reasons.length === 0,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    checkedAt: new Date().toISOString(),
    checkpointFingerprint: detector.requiredPcbFingerprint || null,
    liveFingerprint: summary.pcbFingerprint,
    reasons,
  };
}

function verifyRestore(manifest, nativeBytes, raw) {
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== "easyeda-native-checkpoint") {
    throw new Error("manifest must be easyeda-native-checkpoint schemaVersion 1");
  }
  const summary = semanticSummary(raw);
  const detector = manifest.restoreDetector || {};
  const reasons = [];
  if (sha256(nativeBytes) !== manifest.nativeArtifact?.sha256) {
    reasons.push("restored native .epro SHA-256 does not match the checkpoint manifest");
  }
  if (summary.projectUuid === detector.requiredProjectUuid) {
    reasons.push("restore verification must use a separate non-production probe project");
  }
  if (
    summary.semanticContentFingerprint !==
    detector.requiredSemanticContentFingerprint
  ) reasons.push("restored PCB semantic content differs from the checkpoint");
  for (const [field, expected] of Object.entries(detector.requiredCounts || {})) {
    if (summary[field] !== expected) reasons.push(`restored ${field} mismatch`);
  }
  if (JSON.stringify(summary.outlinePolylines) !== JSON.stringify(detector.requiredOutlinePolylines || [])) {
    reasons.push("restored native board-outline identity/lock/closure summary mismatch");
  }
  return {
    schemaVersion: 1,
    kind: "easyeda-native-restore-check",
    status: reasons.length ? "RESTORE_MISMATCH" : "NATIVE_RESTORE_MATCH",
    executeAllowed: reasons.length === 0,
    restoreReady: reasons.length === 0,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    checkedAt: new Date().toISOString(),
    checkpointFingerprint: detector.requiredPcbFingerprint || null,
    liveFingerprint: detector.requiredPcbFingerprint || null,
    restoredProjectUuid: summary.projectUuid,
    restoredPcbUuid: summary.pcbUuid,
    restoredSemanticContentFingerprint: summary.semanticContentFingerprint,
    reasons,
  };
}

async function selfTest() {
  const directory = await mkdtemp(path.join(tmpdir(), "easyeda-checkpoint-"));
  try {
    const nativePath = path.join(directory, "checkpoint.epro");
    const readbackPath = path.join(directory, "readback.json");
    const raw = {
      kind: "pcb",
      project: { uuid: "project-1" },
      document: { uuid: "pcb-1", documentType: 3 },
      boardOutlineLayerId: 11,
      components: [], pads: [], lines: [], arcs: [], vias: [], pours: [],
      polylines: [{
        primitiveId: "outline-1", layer: 11, locked: true, closed: true,
        points: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
      }],
    };
    await writeFile(nativePath, "native-epro-fixture");
    await writeFile(readbackPath, `${JSON.stringify(raw)}\n`);
    const manifest = await createCheckpoint(nativePath, readbackPath);
    const [nativeBytes, readbackBytes] = await Promise.all([
      readFile(nativePath),
      readFile(readbackPath),
    ]);
    const match = verifyCheckpoint(manifest, nativeBytes, raw, readbackBytes);
    if (match.status !== "NATIVE_CHECKPOINT_MATCH" || !match.executeAllowed) {
      throw new Error("matching native checkpoint did not clear");
    }
    const changed = structuredClone(raw);
    changed.vias.push({ primitiveId: "via-1", x: 5, y: 5, diameter: 20, holeDiameter: 10 });
    const mismatch = verifyCheckpoint(manifest, nativeBytes, changed);
    if (mismatch.status !== "CHECKPOINT_MISMATCH" || mismatch.executeAllowed) {
      throw new Error("changed readback did not invalidate checkpoint");
    }
    const changedBytes = Buffer.from("different-native-epro");
    const hashMismatch = verifyCheckpoint(manifest, changedBytes, raw);
    if (!hashMismatch.reasons.some((item) => /SHA-256/.test(item))) {
      throw new Error("native artifact hash mismatch was not detected");
    }
    const readbackHashMismatch = verifyCheckpoint(
      manifest,
      nativeBytes,
      raw,
      Buffer.from("different-readback"),
    );
    if (!readbackHashMismatch.reasons.some((item) => /readback SHA-256/.test(item))) {
      throw new Error("semantic readback artifact hash mismatch was not detected");
    }
    const restored = structuredClone(raw);
    restored.project.uuid = "probe-project";
    restored.document.uuid = "probe-pcb";
    const restoreMatch = verifyRestore(manifest, nativeBytes, restored);
    if (restoreMatch.status !== "NATIVE_RESTORE_MATCH" || !restoreMatch.restoreReady) {
      throw new Error(`matching probe restore did not clear: ${restoreMatch.reasons.join("; ")}`);
    }
    const unsafeRestore = verifyRestore(manifest, nativeBytes, raw);
    if (!unsafeRestore.reasons.some((item) => /separate non-production probe/.test(item))) {
      throw new Error("same-project restore verification was not rejected");
    }
    process.stdout.write(`${JSON.stringify({ match: match.status, restore: restoreMatch.status, unsafeRestore: unsafeRestore.status, revisionMismatch: mismatch.status, hashMismatch: hashMismatch.status, readbackHashMismatch: readbackHashMismatch.status })}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) return await selfTest();
    let result;
    if (options.mode === "create") {
      result = await createCheckpoint(path.resolve(options.native), path.resolve(options.readback));
    } else {
      const [manifestBytes, nativeBytes, readbackBytes] = await Promise.all([
        readFile(path.resolve(options.manifest)),
        readFile(path.resolve(options.native)),
        readFile(path.resolve(options.readback)),
      ]);
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      const raw = JSON.parse(readbackBytes.toString("utf8"));
      result = options.mode === "verify-restore"
        ? verifyRestore(manifest, nativeBytes, raw)
        : verifyCheckpoint(manifest, nativeBytes, raw, readbackBytes);
    }
    const output = resolveSafeOutputPath(options.output);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.executeAllowed === false ? 2 : 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, kind: "easyeda-native-checkpoint", fabricationRelease: false }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export {
  createCheckpoint,
  parseArgs,
  semanticContentFingerprint,
  semanticSummary,
  sha256,
  verifyCheckpoint,
  verifyRestore,
};

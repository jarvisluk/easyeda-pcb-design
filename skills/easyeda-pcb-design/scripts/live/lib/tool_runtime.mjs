import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  fetchJson,
  findBridge,
  resolveSafeOutputPath,
  resolveWindow,
} from "../../lib/audit_common.mjs";

async function readJsonFile(file, label = "JSON artifact") {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`unable to read ${label} ${file}: ${error.message}`);
  }
}

function resolveContainedPath(baseDir, relative, label = "artifact") {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`${label} must stay within the plan directory`);
  }
  return resolved;
}

function resolveMutableArtifactPath(file, label = "operation log", cwd = process.cwd()) {
  if (typeof file !== "string" || !file.trim()) throw new Error(`${label} requires a non-empty relative path`);
  if (path.isAbsolute(file)) throw new Error(`${label} must be relative to the current working directory`);
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the current working directory`);
  }
  return resolved;
}

function resolveOperationLogPath(operationLog, output, cwd = process.cwd()) {
  if (typeof operationLog === "string" && operationLog.trim()) {
    return resolveMutableArtifactPath(operationLog, "operation log", cwd);
  }
  if (typeof output !== "string" || !output.trim()) {
    throw new Error("tool-managed operation log requires --output when --operation-log is omitted");
  }
  const root = path.resolve(cwd);
  const outputPath = resolveMutableArtifactPath(output, "output", cwd);
  const parts = path.relative(root, outputPath).split(path.sep);
  const evidenceIndex = parts.lastIndexOf("evidence");
  if (evidenceIndex >= 0) {
    return path.resolve(root, ...parts.slice(0, evidenceIndex), "evidence", "readbacks", "operation-log.json");
  }
  return path.resolve(path.dirname(outputPath), "operation-log.json");
}

function artifactSlug(value, fallback = "artifact") {
  const slug = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function evidencePathFromInput(input, category, filename, cwd = process.cwd()) {
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, input || "."));
  const parts = relative.split(path.sep);
  const evidenceIndex = parts.lastIndexOf("evidence");
  const prefix = evidenceIndex >= 0 ? parts.slice(0, evidenceIndex) : [];
  return path.join(...prefix, "evidence", category, filename);
}

function transactionControlDefaults(transactionId, domain = "pcb") {
  const prefix = artifactSlug(transactionId, `${domain}-transaction`);
  return {
    preEditState: `evidence/readbacks/${prefix}-before.json`,
    postEditState: `evidence/readbacks/${prefix}-after.json`,
    planCheck: `evidence/readbacks/${prefix}-plan-check.json`,
    transactionResult: `evidence/readbacks/${prefix}-result.json`,
    verificationReport: `evidence/readbacks/${prefix}-gate-check.json`,
  };
}

function withTransactionControlDefaults(plan, domain = "pcb") {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  return {
    ...structuredClone(plan),
    controls: {
      ...transactionControlDefaults(plan.transactionId, domain),
      ...(plan.controls || {}),
    },
  };
}

function resolveArtifactRoot(planPath, relativeRoot) {
  const root = path.resolve(path.dirname(planPath), relativeRoot);
  if (root === path.parse(root).root) throw new Error("artifactRoot may not resolve to a filesystem root");
  const plan = path.resolve(planPath);
  if (plan !== root && !plan.startsWith(`${root}${path.sep}`)) {
    throw new Error("artifactRoot must resolve to the plan directory or one of its ancestors");
  }
  return root;
}

async function writeNewJson(file, value, { force = false } = {}) {
  const output = resolveSafeOutputPath(file, { force });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, force ? undefined : { flag: "wx" });
  return output;
}

async function writeContainedJson(baseDir, relative, value, { force = false } = {}) {
  const output = resolveContainedPath(baseDir, relative, "output");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, force ? undefined : { flag: "wx" });
  return output;
}

async function executeEasyedaCode({ code, bridgePort, windowId, timeoutMs = 120_000 }) {
  const bridge = await findBridge(bridgePort || undefined);
  const selectedWindowId = await resolveWindow(bridge, windowId || undefined);
  const response = await fetchJson(
    `http://127.0.0.1:${bridge.port}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, windowId: selectedWindowId }),
    },
    timeoutMs,
  );
  return { bridge, windowId: selectedWindowId, response };
}

function isMain(moduleUrl, argv = process.argv) {
  return Boolean(argv[1]) && moduleUrl === pathToFileURL(argv[1]).href;
}

function cliFailure(error, kind) {
  process.stderr.write(`${JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    kind,
    fabricationRelease: false,
  }, null, 2)}\n`);
  process.exitCode = 1;
}

export {
  cliFailure,
  executeEasyedaCode,
  isMain,
  readJsonFile,
  artifactSlug,
  evidencePathFromInput,
  resolveArtifactRoot,
  resolveContainedPath,
  resolveMutableArtifactPath,
  resolveOperationLogPath,
  timestampSlug,
  transactionControlDefaults,
  withTransactionControlDefaults,
  writeContainedJson,
  writeNewJson,
};

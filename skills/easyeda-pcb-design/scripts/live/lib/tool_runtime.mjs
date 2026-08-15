import { readFile, writeFile } from "node:fs/promises";
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
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, force ? undefined : { flag: "wx" });
  return output;
}

async function writeContainedJson(baseDir, relative, value, { force = false } = {}) {
  const output = resolveContainedPath(baseDir, relative, "output");
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
  resolveArtifactRoot,
  resolveContainedPath,
  writeContainedJson,
  writeNewJson,
};

#!/usr/bin/env node

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  API_CAPABILITY_REGISTRY,
  OPERATION_DEFINITIONS,
} from "../../skills/easyeda-pcb-design/scripts/live/lib/operation_registry.mjs";
import {
  SCHEMATIC_OPERATION_DEFINITIONS,
  validateSchematicTransactionPlan,
} from "../../skills/easyeda-pcb-design/scripts/live/lib/schematic_transaction_plan.mjs";
import { validateTransactionPlan } from "../../skills/easyeda-pcb-design/scripts/live/lib/transaction_plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const LIVE_ROOT = path.join(REPO_ROOT, "skills/easyeda-pcb-design/scripts/live");
const FIXTURE_ROOT = path.join(REPO_ROOT, "tests/fixtures/live-tools/plans");
const SCHEMATIC_FIXTURE_ROOT = path.join(REPO_ROOT, "tests/fixtures/live-tools/schematic-plans");
const EXPECTED_CLIS = Object.freeze([
  "check_companion.mjs",
  "easyeda_execution_timing.mjs",
  "easyeda_gate_ledger.mjs",
  "easyeda_identity_preflight.mjs",
  "easyeda_native_checkpoint.mjs",
  "easyeda_repair_snapshot.mjs",
  "easyeda_revision_guard.mjs",
  "easyeda_schematic_checkpoint.mjs",
  "easyeda_schematic_transaction.mjs",
  "easyeda_transaction.mjs",
  "inspect_current_state.mjs",
  "inspect_schematic_state.mjs",
  "verify_gate.mjs",
  "verify_schematic_gate.mjs",
]);
const REQUIRED_LIBRARIES = Object.freeze([
  "operation_log.mjs",
  "operation_registry.mjs",
  "schematic_state.mjs",
  "schematic_transaction_plan.mjs",
  "schematic_transaction_runner.mjs",
  "tool_runtime.mjs",
  "transaction_plan.mjs",
  "transaction_runner.mjs",
]);
const WRITE_METHOD_RE = /eda\.[A-Za-z0-9_.]+\.(?:create[A-Za-z0-9]*|delete[A-Za-z0-9]*|modify[A-Za-z0-9]*|setNetlist|importChanges|autoRouting|clearRouting|save)\s*\(/g;
const PLAN_LOG_CLIS = new Set([
  "easyeda_transaction.mjs",
  "easyeda_schematic_transaction.mjs",
  "verify_gate.mjs",
  "verify_schematic_gate.mjs",
]);

function listMjs(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".mjs") && statSync(path.join(dir, name)).isFile())
    .sort();
}

function repositoryFindings() {
  const findings = [];
  const clis = listMjs(LIVE_ROOT);
  if (JSON.stringify(clis) !== JSON.stringify([...EXPECTED_CLIS])) {
    findings.push({ type: "CLI_SURFACE_DRIFT", expected: EXPECTED_CLIS, actual: clis });
  }
  for (const name of clis) {
    if (/^(?:route|repair)_.+\.mjs$/.test(name)) findings.push({ type: "PER_ATTEMPT_SCRIPT", file: name });
  }
  for (const name of REQUIRED_LIBRARIES) {
    try {
      statSync(path.join(LIVE_ROOT, "lib", name));
    } catch {
      findings.push({ type: "MISSING_LIBRARY", file: name });
    }
  }
  for (const name of clis) {
    const source = readFileSync(path.join(LIVE_ROOT, name), "utf8");
    const contractSource = ["easyeda_transaction.mjs", "easyeda_schematic_transaction.mjs"].includes(name)
      ? `${source}\n${readFileSync(path.join(LIVE_ROOT, "lib", name === "easyeda_transaction.mjs" ? "transaction_runner.mjs" : "schematic_transaction_runner.mjs"), "utf8")}`
      : source;
    if (/\b(?:fetchJson|findBridge|resolveWindow)\b/.test(source)) {
      findings.push({ type: "BYPASSED_SHARED_RUNTIME", file: name });
    }
    const toolManagedLog = ["easyeda_transaction.mjs", "easyeda_schematic_transaction.mjs"].includes(name)
      ? readFileSync(path.join(LIVE_ROOT, "lib", name === "easyeda_transaction.mjs" ? "transaction_runner.mjs" : "schematic_transaction_runner.mjs"), "utf8").includes("appendToolLogEntry")
      : source.includes("appendToolLogEntry");
    if (!toolManagedLog) findings.push({ type: "MISSING_TOOL_MANAGED_LOG", file: name });
    const toolManagedFailure = ["easyeda_transaction.mjs", "verify_gate.mjs"].includes(name)
      ? source.includes("appendPlanToolFailure")
      : ["easyeda_schematic_transaction.mjs", "verify_schematic_gate.mjs"].includes(name)
        ? source.includes("appendSchematicPlanFailure")
      : source.includes("appendToolFailureFromArgv");
    if (!toolManagedFailure) findings.push({ type: "MISSING_TOOL_MANAGED_FAILURE_LOG", file: name });
    if (/--operation-log is required/.test(source)) {
      findings.push({ type: "MANDATORY_OPERATION_LOG_OPTION", file: name });
    }
    if (/--output is required/.test(contractSource)) {
      findings.push({ type: "MANDATORY_OUTPUT_OPTION", file: name });
    }
    if (!PLAN_LOG_CLIS.has(name) && !source.includes("resolveOperationLogPath")) {
      findings.push({ type: "MISSING_DEFAULT_OPERATION_LOG_PATH", file: name });
    }
  }
  for (const [api, capability] of Object.entries(API_CAPABILITY_REGISTRY)) {
    if (capability.disposition === "transaction") {
      const definition = capability.registry === "schematic"
        ? SCHEMATIC_OPERATION_DEFINITIONS[capability.operation]
        : OPERATION_DEFINITIONS[capability.operation];
      if (!definition || definition.api !== api) findings.push({ type: "REGISTRY_DRIFT", api, capability });
    }
  }
  const jsonFixtures = readdirSync(FIXTURE_ROOT).filter((name) => name.endsWith(".json")).sort();
  const modes = new Set();
  const operationTypes = new Set();
  for (const name of jsonFixtures) {
    const plan = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), "utf8"));
    const validation = validateTransactionPlan(plan);
    if (!validation.executable) findings.push({ type: "INVALID_PLAN_FIXTURE", file: name, errors: validation.errors, warnings: validation.warnings });
    else {
      modes.add(validation.plan.mode);
      for (const operation of validation.plan.operations) operationTypes.add(operation.type);
    }
  }
  for (const mode of ["route", "repair", "placement", "outline", "copper"]) {
    if (!modes.has(mode)) findings.push({ type: "MISSING_MODE_FIXTURE", mode });
  }
  for (const type of Object.keys(OPERATION_DEFINITIONS)) {
    if (!operationTypes.has(type)) findings.push({ type: "MISSING_OPERATION_FIXTURE", operation: type });
  }
  const schematicFixtures = readdirSync(SCHEMATIC_FIXTURE_ROOT).filter((name) => name.endsWith(".json")).sort();
  const schematicModes = new Set();
  const schematicOperationTypes = new Set();
  for (const name of schematicFixtures) {
    const plan = JSON.parse(readFileSync(path.join(SCHEMATIC_FIXTURE_ROOT, name), "utf8"));
    const validation = validateSchematicTransactionPlan(plan);
    if (!validation.executable) findings.push({ type: "INVALID_SCHEMATIC_PLAN_FIXTURE", file: name, errors: validation.errors });
    else {
      schematicModes.add(validation.plan.mode);
      for (const operation of validation.plan.operations) schematicOperationTypes.add(operation.type);
    }
  }
  for (const mode of ["new-construction", "existing-schematic-modification"]) {
    if (!schematicModes.has(mode)) findings.push({ type: "MISSING_SCHEMATIC_MODE_FIXTURE", mode });
  }
  for (const type of Object.keys(SCHEMATIC_OPERATION_DEFINITIONS)) {
    if (!schematicOperationTypes.has(type)) findings.push({ type: "MISSING_SCHEMATIC_OPERATION_FIXTURE", operation: type });
  }
  return {
    clis, jsonFixtures, modes: [...modes].sort(), operationTypes: [...operationTypes].sort(),
    schematicFixtures, schematicModes: [...schematicModes].sort(),
    schematicOperationTypes: [...schematicOperationTypes].sort(), findings,
  };
}

function walkMjs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkMjs(full, out);
    else if (entry.endsWith(".mjs")) out.push(full);
  }
  return out.sort();
}

function auditLegacyDirectory(dir) {
  const scripts = walkMjs(path.resolve(dir));
  const capabilities = {};
  const unknownWriteApis = new Set();
  let writeCallCount = 0;
  for (const file of scripts) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(WRITE_METHOD_RE)) {
      const api = match[0].replace(/\s*\($/, "");
      writeCallCount += 1;
      const capability = API_CAPABILITY_REGISTRY[api];
      if (!capability) unknownWriteApis.add(api);
      else {
        const key = `${capability.disposition}:${capability.operation || capability.owner}`;
        capabilities[key] = (capabilities[key] || 0) + 1;
      }
    }
  }
  const basenames = scripts.map((file) => path.basename(file));
  return {
    kind: "easyeda-legacy-tool-pattern-audit",
    decision: unknownWriteApis.size ? "UNMAPPED_WRITE_PATTERN" : "MIGRATION_READY",
    historicalEvidencePreserved: true,
    scriptCount: scripts.length,
    routeScriptCount: basenames.filter((name) => /^route_.*\.mjs$/.test(name)).length,
    repairScriptCount: basenames.filter((name) => /^repair_.*\.mjs$/.test(name)).length,
    writeCallCount,
    capabilities: Object.fromEntries(Object.entries(capabilities).sort(([a], [b]) => a.localeCompare(b))),
    unknownWriteApis: [...unknownWriteApis].sort(),
  };
}

function analyze(legacyDir = null) {
  const repository = repositoryFindings();
  const legacy = legacyDir ? auditLegacyDirectory(legacyDir) : null;
  const cleared = repository.findings.length === 0 && (!legacy || legacy.decision === "MIGRATION_READY");
  return {
    kind: "easyeda-live-tool-library-lint",
    decision: cleared ? "CLEARED" : "DRIFT",
    stableCliCount: repository.clis.length,
    stableClis: repository.clis,
    planFixtures: repository.jsonFixtures,
    coveredModes: repository.modes,
    coveredOperations: repository.operationTypes,
    schematicPlanFixtures: repository.schematicFixtures,
    coveredSchematicModes: repository.schematicModes,
    coveredSchematicOperations: repository.schematicOperationTypes,
    findings: repository.findings,
    legacy,
  };
}

function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "easyeda-tool-library-lint-"));
  try {
    writeFileSync(path.join(dir, "route_one.mjs"), "await eda.pcb_PrimitiveLine.create('N', EPCB_LayerId.TOP, 0, 0, 1, 1); await eda.pcb_Document.save();\n");
    writeFileSync(path.join(dir, "repair_one.mjs"), "await eda.pcb_PrimitiveLine.delete('id');\n");
    const mapped = auditLegacyDirectory(dir);
    if (mapped.decision !== "MIGRATION_READY" || mapped.routeScriptCount !== 1 || mapped.repairScriptCount !== 1) {
      throw new Error("mapped legacy fixture did not clear");
    }
    writeFileSync(path.join(dir, "unknown.mjs"), "await eda.pcb_PrimitiveMystery.delete('id');\n");
    const unknown = auditLegacyDirectory(dir);
    if (unknown.decision !== "UNMAPPED_WRITE_PATTERN") throw new Error("unknown write pattern was not rejected");
    process.stdout.write("live tool library lint self-test passed\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const index = argv.indexOf("--legacy-dir");
  const legacyDir = index >= 0 ? argv[index + 1] : null;
  if (index >= 0 && !legacyDir) throw new Error("--legacy-dir requires a directory");
  const report = analyze(legacyDir);
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`live tool library lint: ${report.decision}; ${report.stableCliCount} stable CLIs; modes ${report.coveredModes.join(", ")}\n`);
    if (report.legacy) {
      process.stdout.write(`legacy audit: ${report.legacy.decision}; ${report.legacy.scriptCount} scripts (${report.legacy.routeScriptCount} route, ${report.legacy.repairScriptCount} repair); ${report.legacy.writeCallCount} mapped write calls\n`);
    }
    for (const finding of report.findings) process.stderr.write(`${JSON.stringify(finding)}\n`);
    for (const api of report.legacy?.unknownWriteApis || []) process.stderr.write(`unmapped legacy write API: ${api}\n`);
  }
  process.exitCode = report.decision === "CLEARED" ? 0 : 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}

export { analyze, auditLegacyDirectory, repositoryFindings };

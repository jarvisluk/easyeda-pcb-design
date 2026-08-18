#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(ROOT, "skills/easyeda-pcb-design");

const CONTRACT_COMMANDS = [
  ["node", ["tests/lints/skill_reference_contract_lint.mjs"]],
  ["node", ["tests/lints/skill_reference_contract_lint.mjs", "--self-test"]],
  ["node", ["tests/lints/live_tool_library_lint.mjs"]],
  ["node", ["tests/lints/live_tool_library_lint.mjs", "--self-test"]],
];

const DETERMINISTIC_COMMANDS = [
  ["node", ["tests/audits/easyeda_audit_tests.mjs"]],
  ["node", ["tests/live/easyeda_tools_tests.mjs"]],
  ["python3", ["tests/calc/pcb_calc_tests.py"]],
  ["node", ["skills/easyeda-pcb-design/scripts/lints/requirements_baseline_lint.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/lints/component_selection_evidence.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_identity_preflight.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_revision_guard.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_repair_snapshot.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_gate_ledger.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_execution_timing.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_native_checkpoint.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/inspect_current_state.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_transaction.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/verify_gate.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/inspect_schematic_state.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_schematic_checkpoint.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/easyeda_schematic_transaction.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/verify_schematic_gate.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/audits/easyeda_placement_audit.mjs", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/audits/easyeda_crystal_clock_audit.mjs", "--self-test"]],
  ["python3", ["skills/easyeda-pcb-design/scripts/lints/easyeda_stackup_decision_lint.py", "--self-test"]],
  ["python3", ["skills/easyeda-pcb-design/scripts/lints/easyeda_constraint_lint.py", "--self-test"]],
  ["python3", ["skills/easyeda-pcb-design/scripts/audits/easyeda_manufacturing_audit.py", "--self-test"]],
  ["node", ["skills/easyeda-pcb-design/scripts/live/check_companion.mjs", "--self-test"]],
  ["node", ["tests/routing/run_routing_case.mjs", "--self-test"]],
];

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args) {
  const label = commandLabel(command, args);
  process.stdout.write("\n> " + label + "\n");
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(label + " failed with exit " + result.status);
  }
}

function walk(directory, predicate, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "designs") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, predicate, output);
    else if (predicate(full)) output.push(full);
  }
  return output;
}

function markdownFiles() {
  return walk(ROOT, (file) => file.endsWith(".md")).sort();
}

function checkRelativeLinks() {
  const findings = [];
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const file of markdownFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(markdownLink)) {
      let target = match[1].trim();
      if (
        target === "" ||
        target.startsWith("#") ||
        /^(?:https?:|mailto:|data:)/i.test(target)
      ) {
        continue;
      }
      if (target.startsWith("<") && target.endsWith(">")) {
        target = target.slice(1, -1);
      } else {
        target = target.split(/\s+["']/)[0];
      }
      target = target.split("#")[0].split("?")[0];
      if (target === "") continue;
      let decoded;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        findings.push(path.relative(ROOT, file) + ": invalid encoded link " + target);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), decoded);
      if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) {
        findings.push(path.relative(ROOT, file) + ": link escapes repository: " + target);
      } else if (!existsSync(resolved)) {
        findings.push(path.relative(ROOT, file) + ": missing link target: " + target);
      }
    }
  }
  if (findings.length) {
    throw new Error("relative-link check failed:\n  " + findings.join("\n  "));
  }
  process.stdout.write("relative-link check passed\n");
}

function checkReferenceContents() {
  const referencesRoot = path.join(SKILL_ROOT, "references");
  const findings = [];
  const references = walk(referencesRoot, (file) => file.endsWith(".md")).sort();
  for (const file of references) {
    const source = readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);
    if (lines.length > 100 && !lines.slice(0, 40).some((line) => line.trim() === "## Contents")) {
      findings.push(path.relative(ROOT, file) + " (" + lines.length + " lines)");
    }
  }
  if (findings.length) {
    throw new Error(
      "over-100-line references missing an early ## Contents section:\n  " +
        findings.join("\n  "),
    );
  }
  process.stdout.write("reference Contents check passed\n");
}

function checkTextWhitespace() {
  const extensions = new Set([".js", ".json", ".md", ".mjs", ".py", ".yaml", ".yml"]);
  const findings = [];
  const files = walk(ROOT, (file) => extensions.has(path.extname(file))).sort();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file);
    if (source.length > 0 && !source.endsWith("\n")) {
      findings.push(relative + ": missing final newline");
    }
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (/[ \t]+$/.test(lines[index])) {
        findings.push(relative + ":" + (index + 1) + ": trailing whitespace");
      }
    }
  }
  if (findings.length) {
    throw new Error("text whitespace check failed:\n  " + findings.join("\n  "));
  }
  process.stdout.write("text whitespace check passed\n");
}

function findQuickValidate() {
  const configured = process.env.SKILL_CREATOR_QUICK_VALIDATE;
  const codexRoot = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const candidates = [
    configured,
    path.join(codexRoot, "skills/.system/skill-creator/scripts/quick_validate.py"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function runSkillCreatorValidation({ ci }) {
  const quickValidate = findQuickValidate();
  if (!quickValidate) {
    if (ci) {
      process.stdout.write(
        "skill-creator quick_validate.py unavailable in CI; repository contract checks remain active\n",
      );
      return;
    }
    throw new Error(
      "skill-creator quick_validate.py not found; set SKILL_CREATOR_QUICK_VALIDATE or use --ci",
    );
  }
  run("python3", [quickValidate, SKILL_ROOT]);
}

function parseArgs(argv) {
  const allowed = new Set(["--quick", "--ci", "--list", "--help"]);
  for (const arg of argv) {
    if (!allowed.has(arg)) throw new Error("unknown option: " + arg);
  }
  return {
    quick: argv.includes("--quick"),
    ci: argv.includes("--ci"),
    list: argv.includes("--list"),
    help: argv.includes("--help"),
  };
}

function listCommands({ quick, ci }) {
  const commands = [...CONTRACT_COMMANDS, ...(quick ? [] : DETERMINISTIC_COMMANDS)];
  if (!ci) {
    const quickValidate = findQuickValidate();
    process.stdout.write(
      "python3 " +
        (quickValidate || "<skill-creator>/scripts/quick_validate.py") +
        " " +
        path.relative(ROOT, SKILL_ROOT) +
        "\n",
    );
  }
  for (const [command, args] of commands) {
    process.stdout.write(commandLabel(command, args) + "\n");
  }
  process.stdout.write("[internal] relative-link check\n");
  process.stdout.write("[internal] reference Contents check\n");
  process.stdout.write("[internal] text whitespace check\n");
  process.stdout.write("git diff --check\n");
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node tools/validate_repo.mjs [--quick] [--ci] [--list]\n" +
        "  --quick  run contract, link, Contents, and diff checks only\n" +
        "  --ci     allow skill-creator quick_validate.py to be unavailable\n" +
        "  --list   print the selected commands without running them\n",
    );
    return;
  }
  if (options.list) {
    listCommands(options);
    return;
  }

  runSkillCreatorValidation(options);
  for (const [command, args] of CONTRACT_COMMANDS) run(command, args);
  if (!options.quick) {
    for (const [command, args] of DETERMINISTIC_COMMANDS) run(command, args);
  }
  process.stdout.write("\n> internal repository structure checks\n");
  checkRelativeLinks();
  checkReferenceContents();
  checkTextWhitespace();
  run("git", ["diff", "--check"]);

  if (!options.quick) {
    process.stdout.write(
      "\nManual routing eval replies are intentionally not scored here. " +
        "Run affected cases with tests/routing/run_routing_case.mjs --case <id>.\n",
    );
  }
  process.stdout.write("\nrepository validation passed\n");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write("\nrepository validation failed: " + error.message + "\n");
  process.exitCode = 1;
}

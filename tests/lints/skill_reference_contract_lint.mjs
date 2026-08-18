#!/usr/bin/env node

// Repository maintenance lint: proves that skill prose and runtime scripts still
// agree on their shared vocabulary. This is the cheap tier of skill testing --
// it catches mechanical drift (renamed options, stale command blocks, status
// tokens no script recognizes) without starting an agent task.
//
// Checks:
//   1. Every node/python3 [<skill>/]scripts/... invocation in SKILL.md or references
//      names a script that exists.
//   2. Every long option on such a command line is accepted by that script.
//      Options are attributed per command, never per fenced block.
//   3. Every backticked ALL_CAPS token in prose appears in some script, unless
//      it is explicitly acknowledged in PROSE_ONLY_TOKENS.
//
// Usage:
//   node tests/lints/skill_reference_contract_lint.mjs
//   node tests/lints/skill_reference_contract_lint.mjs --self-test
//   node tests/lints/skill_reference_contract_lint.mjs --json

import {
  existsSync,
  mkdirSync,
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const SKILL_ROOT = path.join(REPO_ROOT, "skills/easyeda-pcb-design");

export const EXIT = { CLEARED: 0, DRIFT: 1, USAGE: 2 };

// Tokens that intentionally live only in prose. Every entry states why, so a
// later edit cannot quietly turn an enforced gate into an unenforced one.
//
// kind "prose-gate" is the significant case: the skill asks the agent to reach
// that state by judgment and no script can confirm it. Adding one is a
// deliberate decision to accept agent-enforced-only behavior.
export const PROSE_ONLY_TOKENS = Object.freeze({
  PROVISIONAL: {
    kind: "working-label",
    why: "working-artifact label during the constraint loop, never a closing status",
  },
  PROJECT_BRIEF: {
    kind: "rejected-legacy",
    why: "named only to reject it as a requirements basis, so no script should accept it",
  },
  XTAL_IN: {
    kind: "net-name-example",
    why: "example crystal net name matched by regex, not a status",
  },
  HSE_IN: {
    kind: "net-name-example",
    why: "example crystal net name matched by regex, not a status",
  },
  LSE_OUT: {
    kind: "net-name-example",
    why: "example crystal net name matched by regex, not a status",
  },
  ORIENTATION_VIOLATION: {
    kind: "prose-gate",
    why: "antenna orientation stop-work state is agent-judged; no script emits or validates it",
  },
  ORIENTATION_CLEARED: {
    kind: "prose-gate",
    why: "antenna orientation evidence record is hand-authored; no script validates its fields",
  },
  NOT_SUPPLIED: {
    kind: "prose-gate",
    why: "absent vendor RF reference layout is recorded in prose, not by a script status",
  },
});

const TOKEN_RE = /`([A-Z][A-Z0-9_]{4,})`/g;
const COMMAND_RE = /^\s*(?:node|python3)\s+(?:<skill>\/)?(scripts\/[A-Za-z0-9_/-]+\.(?:mjs|py))\b(.*)$/;
const LONG_OPTION_RE = /--[a-z][a-z0-9-]*/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function docFiles(skillRoot) {
  const docs = [];
  const entry = path.join(skillRoot, "SKILL.md");
  if (existsSync(entry)) docs.push(entry);
  const references = path.join(skillRoot, "references");
  if (existsSync(references)) {
    docs.push(...walk(references).filter((file) => file.endsWith(".md")));
  }
  return docs.sort();
}

export function scriptFiles(skillRoot) {
  const scripts = path.join(skillRoot, "scripts");
  if (!existsSync(scripts)) return [];
  return walk(scripts)
    .filter((file) => file.endsWith(".mjs") || file.endsWith(".py"))
    .sort();
}

// Join backslash continuations so one logical command becomes one line, then
// keep only lines that actually invoke a script. Per-command attribution is what
// keeps this lint free of the false positives a per-block scan produces when one
// block runs several scripts in sequence.
export function commandLines(markdown) {
  const found = [];
  const fence = /```bash\n[\s\S]*?```/g;
  for (const block of markdown.match(fence) || []) {
    const body = block.replace(/^```bash\n/, "").replace(/```$/, "");
    for (const line of body.replace(/\\\n/g, " ").split("\n")) {
      const match = line.match(COMMAND_RE);
      if (match) found.push({ script: match[1], rest: match[2] });
    }
  }
  return found;
}

// Covers option === "--flag", argparse add_argument("--flag"), and usage text. A
// script that only prints an option in help without parsing it is a different
// defect that this lint does not claim to detect.
function scriptAcceptsOption(source, option) {
  return (
    source.includes('"' + option + '"') ||
    source.includes("'" + option + "'") ||
    source.includes(option + " ") ||
    source.includes(option + "=")
  );
}

function tokenInScripts(token, allScriptText) {
  const boundary = String.fromCharCode(92) + "b";
  return new RegExp(boundary + token + boundary).test(allScriptText);
}

export function analyze({ docs, scripts, skillRoot, proseOnly = PROSE_ONLY_TOKENS }) {
  const findings = [];
  const sources = new Map();
  for (const file of scripts) {
    sources.set(path.relative(skillRoot, file), readFileSync(file, "utf8"));
  }
  const allScriptText = [...sources.values()].join("\n");

  let commandCount = 0;
  const tokenLocations = new Map();

  for (const file of docs) {
    const relative = path.relative(skillRoot, file);
    const markdown = readFileSync(file, "utf8");

    for (const command of commandLines(markdown)) {
      commandCount += 1;
      const source = sources.get(command.script);
      if (source === undefined) {
        findings.push({
          type: "MISSING_SCRIPT",
          doc: relative,
          script: command.script,
          detail: command.script + " is named in a command block but does not exist",
        });
        continue;
      }
      for (const option of command.rest.match(LONG_OPTION_RE) || []) {
        if (!scriptAcceptsOption(source, option)) {
          findings.push({
            type: "STALE_OPTION",
            doc: relative,
            script: command.script,
            option,
            detail: command.script + " does not accept " + option,
          });
        }
      }
    }

    for (const match of markdown.matchAll(TOKEN_RE)) {
      const token = match[1];
      if (!tokenLocations.has(token)) tokenLocations.set(token, new Set());
      tokenLocations.get(token).add(relative);
    }
  }

  const acknowledgedInUse = new Set();
  for (const [token, files] of tokenLocations) {
    if (tokenInScripts(token, allScriptText)) {
      if (proseOnly[token]) {
        findings.push({
          type: "STALE_PROSE_ONLY_ENTRY",
          token,
          detail: token + " is implemented in a script; remove it from PROSE_ONLY_TOKENS",
        });
      }
      continue;
    }
    if (proseOnly[token]) {
      acknowledgedInUse.add(token);
      continue;
    }
    findings.push({
      type: "ORPHAN_TOKEN",
      token,
      docs: [...files].sort(),
      detail:
        token +
        " appears in prose but in no script; implement it or acknowledge it in PROSE_ONLY_TOKENS",
    });
  }

  for (const token of Object.keys(proseOnly)) {
    if (!tokenLocations.has(token)) {
      findings.push({
        type: "UNUSED_PROSE_ONLY_ENTRY",
        token,
        detail: token + " is acknowledged as prose-only but appears in no document",
      });
    }
  }

  return {
    decision: findings.length === 0 ? "CLEARED" : "DRIFT",
    counts: {
      documents: docs.length,
      scripts: scripts.length,
      commands: commandCount,
      tokens: tokenLocations.size,
      findings: findings.length,
    },
    proseGates: [...acknowledgedInUse]
      .filter((token) => proseOnly[token].kind === "prose-gate")
      .sort(),
    findings,
  };
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      "self-test failed: " + message + " (expected " + expected + ", got " + actual + ")",
    );
  }
}

function selfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "skill-contract-lint-"));
  const write = (relative, content) => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  const fence = (lines) => "```bash\n" + lines.join("\n") + "\n```\n";
  const cont = String.fromCharCode(92);
  try {
    const audit = write(
      "scripts/audits/real_audit.mjs",
      'if (option === "--ground-net") {}\nconst status = "KNOWN_STATUS";\n',
    );
    const other = write("scripts/audits/other.mjs", 'if (option === "--only-here") {}\n');
    const scripts = [audit, other];

    const good = write(
      "SKILL.md",
      fence(["node scripts/audits/real_audit.mjs --ground-net GND"]) + "Use `KNOWN_STATUS`.\n",
    );
    const clear = analyze({ docs: [good], scripts, skillRoot: root, proseOnly: {} });
    assertEqual(clear.decision, "CLEARED", "valid command and implemented token should clear");

    const installed = write(
      "installed.md",
      fence(["node <skill>/scripts/audits/real_audit.mjs --ground-net GND"]),
    );
    const installedReport = analyze({ docs: [installed], scripts, skillRoot: root, proseOnly: {} });
    assertEqual(installedReport.decision, "CLEARED", "installed-skill placeholder command should clear");
    assertEqual(installedReport.counts.commands, 1, "installed-skill placeholder command must be counted");

    const stale = write("stale.md", fence(["node scripts/audits/real_audit.mjs --nope VALUE"]));
    const staleReport = analyze({ docs: [stale], scripts, skillRoot: root, proseOnly: {} });
    assertEqual(staleReport.decision, "DRIFT", "unknown option must be reported");
    assertEqual(staleReport.findings[0].type, "STALE_OPTION", "unknown option finding type");

    const gone = write("gone.md", fence(["node scripts/audits/gone.mjs --ground-net GND"]));
    const goneReport = analyze({ docs: [gone], scripts, skillRoot: root, proseOnly: {} });
    assertEqual(goneReport.findings[0].type, "MISSING_SCRIPT", "absent script finding type");

    // Regression guard for the false positive a per-block scan produces: two
    // scripts in one block must not inherit each other's options.
    const multi = write(
      "multi.md",
      fence([
        "node scripts/audits/real_audit.mjs " + cont,
        "  --ground-net GND",
        "",
        "node scripts/audits/other.mjs " + cont,
        "  --only-here 1",
      ]),
    );
    const multiReport = analyze({ docs: [multi], scripts, skillRoot: root, proseOnly: {} });
    assertEqual(
      multiReport.decision,
      "CLEARED",
      "per-command attribution must not cross-report options",
    );
    assertEqual(multiReport.counts.commands, 2, "both commands in one block must be counted");

    const orphan = write("orphan.md", "Mark `TOTALLY_ABSENT` and stop.\n");
    const orphanReport = analyze({ docs: [orphan], scripts, skillRoot: root, proseOnly: {} });
    assertEqual(orphanReport.findings[0].type, "ORPHAN_TOKEN", "unimplemented token finding type");

    const acknowledged = analyze({
      docs: [orphan],
      scripts,
      skillRoot: root,
      proseOnly: { TOTALLY_ABSENT: { kind: "prose-gate", why: "test" } },
    });
    assertEqual(acknowledged.decision, "CLEARED", "acknowledged prose-only token must clear");
    assertEqual(acknowledged.proseGates[0], "TOTALLY_ABSENT", "prose gates must be surfaced");

    const stalePermit = analyze({
      docs: [good],
      scripts,
      skillRoot: root,
      proseOnly: { KNOWN_STATUS: { kind: "prose-gate", why: "test" } },
    });
    assertEqual(
      stalePermit.findings.some((finding) => finding.type === "STALE_PROSE_ONLY_ENTRY"),
      true,
      "implemented token must be removed from the allowlist",
    );

    const unused = analyze({
      docs: [good],
      scripts,
      skillRoot: root,
      proseOnly: { NEVER_MENTIONED: { kind: "prose-gate", why: "test" } },
    });
    assertEqual(
      unused.findings.some((finding) => finding.type === "UNUSED_PROSE_ONLY_ENTRY"),
      true,
      "allowlist entry with no prose mention must be reported",
    );

    console.log("skill reference contract lint self-test passed");
    return EXIT.CLEARED;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const USAGE = [
  "Usage: node tests/lints/skill_reference_contract_lint.mjs [--self-test] [--json]",
  "",
  "Verifies that skill documents and runtime scripts agree on command options",
  "and status tokens. Exit 0 = CLEARED, 1 = DRIFT, 2 = usage error.",
];

function main(argv) {
  if (argv.includes("--help")) {
    for (const line of USAGE) console.log(line);
    return EXIT.CLEARED;
  }
  if (argv.includes("--self-test")) return selfTest();

  if (!existsSync(SKILL_ROOT)) {
    console.error("skill root not found: " + SKILL_ROOT);
    return EXIT.USAGE;
  }

  const docs = docFiles(SKILL_ROOT);
  const scripts = scriptFiles(SKILL_ROOT);
  if (docs.length === 0 || scripts.length === 0) {
    console.error("no documents or no scripts found; nothing to compare");
    return EXIT.USAGE;
  }

  const report = analyze({ docs, scripts, skillRoot: SKILL_ROOT });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.decision === "CLEARED" ? EXIT.CLEARED : EXIT.DRIFT;
  }

  const c = report.counts;
  console.log(
    "checked " +
      c.commands +
      " command invocations and " +
      c.tokens +
      " status tokens across " +
      c.documents +
      " documents against " +
      c.scripts +
      " scripts",
  );

  if (report.proseGates.length > 0) {
    console.log("");
    console.log("prose-only gates (agent-enforced, no script validates them):");
    for (const token of report.proseGates) console.log("  " + token);
  }

  console.log("");
  if (report.decision === "CLEARED") {
    console.log("skill reference contract lint: CLEARED");
    return EXIT.CLEARED;
  }

  console.error("skill reference contract lint: DRIFT (" + c.findings + " findings)");
  for (const finding of report.findings) {
    const where = finding.doc || (finding.docs || []).join(", ");
    const suffix = where ? " (" + where + ")" : "";
    console.error("  [" + finding.type + "] " + finding.detail + suffix);
  }
  return EXIT.DRIFT;
}

process.exitCode = main(process.argv.slice(2));

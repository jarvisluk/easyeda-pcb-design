#!/usr/bin/env node

// Repository maintenance harness for manual routing-only forward evaluations.
//
// These cases evaluate the behavioral surface of the skill -- entry state, scope,
// mode, technical-depth tier, and which references get loaded -- which no
// deterministic self-test can reach. They stop as soon as the agent has stated
// its routing decision, so they cost a fraction of a full board task.
//
// This script does not drive an agent or score a reply. It validates the case
// fixtures and emits the exact read-only prompt to hand to a fresh-context agent session, then
// records the expectations to compare the reply against. Keeping the agent step
// manual is deliberate: the point is to observe unprompted routing behavior, and
// a harness that fed the expectations to the agent would prove nothing.
//
// Usage:
//   node tests/routing/run_routing_case.mjs --list
//   node tests/routing/run_routing_case.mjs --case antenna-module-selection
//   node tests/routing/run_routing_case.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const SKILL_ROOT = path.join(REPO_ROOT, "skills/easyeda-pcb-design");
const CASES_DIR = path.join(HERE, "cases");

export const EXIT = { OK: 0, INVALID: 1, USAGE: 2 };

const REQUIRED_FIELDS = ["id", "why", "request", "readOnly", "expect"];
const REQUIRED_EXPECT_FIELDS = [
  "entryState",
  "enterAtPhase",
  "scopeLastPhase",
  "mode",
  "mustLoad",
  "mustNotLoad",
  "mustState",
];

const ENTRY_STATES = ["no design", "existing schematic", "unfinished PCB", "routed PCB"];
const MODES = ["guide", "build or modify", "review or release"];
const TIERS = ["baseline", "controlled/high-speed", "high-risk SI"];

// Validating fixtures matters more here than in a normal test: a case that
// points at a renamed reference would silently pass forever, because a human
// reads the verdict rather than a matcher.
export function validateCase(record, { skillRoot = SKILL_ROOT } = {}) {
  const problems = [];
  for (const field of REQUIRED_FIELDS) {
    if (record[field] === undefined) problems.push("missing field: " + field);
  }
  if (problems.length > 0) return problems;

  if (record.readOnly !== true) {
    problems.push("readOnly must be true; these cases must never write to a design");
  }
  const expect = record.expect;
  for (const field of REQUIRED_EXPECT_FIELDS) {
    if (expect[field] === undefined) problems.push("missing expect field: " + field);
  }
  if (!ENTRY_STATES.includes(expect.entryState)) {
    problems.push("entryState must be one of: " + ENTRY_STATES.join(", "));
  }
  if (!MODES.includes(expect.mode)) {
    problems.push("mode must be one of: " + MODES.join(", "));
  }
  if (expect.tierAnyOf !== undefined) {
    if (!Array.isArray(expect.tierAnyOf) || expect.tierAnyOf.length === 0) {
      problems.push("tierAnyOf must be a non-empty array when present");
    } else {
      for (const tier of expect.tierAnyOf) {
        if (!TIERS.includes(tier)) problems.push("unknown tier: " + tier);
      }
      if (expect.tierAnyOf.length > 1 && !expect.tierRule) {
        problems.push("tierAnyOf with several values requires tierRule to say what decides");
      }
    }
  }

  const referenced = [...(expect.mustLoad || []), ...(expect.mustNotLoad || [])];
  for (const relative of referenced) {
    if (!existsSync(path.join(skillRoot, relative))) {
      problems.push("expectation points at a path that does not exist: " + relative);
    }
  }
  const overlap = (expect.mustLoad || []).filter((item) =>
    (expect.mustNotLoad || []).includes(item),
  );
  for (const item of overlap) {
    problems.push("path appears in both mustLoad and mustNotLoad: " + item);
  }
  if ((expect.mustLoad || []).length === 0) {
    problems.push("mustLoad must name at least one reference");
  }
  return problems;
}

export function loadCases({ casesDir = CASES_DIR } = {}) {
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file: path.join(casesDir, file),
      record: JSON.parse(readFileSync(path.join(casesDir, file), "utf8")),
    }));
}

// The prompt deliberately withholds every expectation. It asks only for the
// routing decision the skill already requires an agent to make, then stops.
export function buildPrompt(record) {
  const lines = [
    "Read the easyeda-pcb-design skill and answer this request:",
    "",
    "  " + record.request,
    "",
    "This is a READ-ONLY routing probe. Do not create, modify, or write any",
    "design, project, file, or artifact, and do not call any live EasyEDA",
    "operation. Stop after the classification below.",
    "",
    "State, concisely and explicitly:",
    "",
    "1. entry state, and the first pipeline phase you own",
    "2. scope, and the last pipeline phase you own",
    "3. mode",
    "4. technical-depth tier, and why that tier",
    "5. every reference file you would load, as repo-relative paths",
    "6. references you deliberately would NOT load, and why",
    "7. the next concrete action you would take",
    "",
    "Do not perform step 7. Do not author any artifact. If the request is",
    "ambiguous, say which interpretation you chose and why.",
  ];
  return lines.join("\n");
}

function formatExpectations(record) {
  const e = record.expect;
  const out = [];
  out.push("expected entry state      : " + e.entryState);
  out.push("expected first phase      : " + e.enterAtPhase);
  out.push("expected last phase       : " + e.scopeLastPhase);
  out.push("expected mode             : " + e.mode);
  if (e.tierAnyOf) out.push("acceptable tier           : " + e.tierAnyOf.join(" | "));
  if (e.tierRule) out.push("tier rule                 : " + e.tierRule);
  out.push("");
  out.push("must load:");
  for (const item of e.mustLoad) out.push("  + " + item);
  if ((e.mustNotLoad || []).length > 0) {
    out.push("must NOT load:");
    for (const item of e.mustNotLoad) out.push("  - " + item);
  }
  out.push("");
  out.push("must state:");
  for (const item of e.mustState) out.push("  + " + item);
  if ((e.mustNotState || []).length > 0) {
    out.push("must NOT state:");
    for (const item of e.mustNotState) out.push("  - " + item);
  }
  return out;
}

function selfTest() {
  const cases = loadCases();
  if (cases.length === 0) throw new Error("self-test failed: no routing cases found");

  let invalid = 0;
  for (const entry of cases) {
    const problems = validateCase(entry.record);
    if (problems.length > 0) {
      invalid += 1;
      console.error("invalid case " + entry.record.id + ":");
      for (const problem of problems) console.error("  " + problem);
    }
  }
  if (invalid > 0) throw new Error("self-test failed: " + invalid + " invalid case fixtures");

  // Negative fixtures: the validator must actually reject bad cases.
  const base = cases[0].record;
  const mustReject = [
    ["writes allowed", Object.assign({}, base, { readOnly: false }), "readOnly must be true"],
    [
      "unknown entry state",
      Object.assign({}, base, {
        expect: Object.assign({}, base.expect, { entryState: "half a board" }),
      }),
      "entryState must be one of",
    ],
    [
      "nonexistent reference path",
      Object.assign({}, base, {
        expect: Object.assign({}, base.expect, {
          mustLoad: ["references/workflows/does-not-exist.md"],
        }),
      }),
      "does not exist",
    ],
    [
      "ambiguous tier without a rule",
      Object.assign({}, base, {
        expect: Object.assign({}, base.expect, {
          tierAnyOf: ["baseline", "high-risk SI"],
          tierRule: undefined,
        }),
      }),
      "requires tierRule",
    ],
  ];
  for (const [label, record, fragment] of mustReject) {
    const problems = validateCase(record);
    if (!problems.some((problem) => problem.includes(fragment))) {
      throw new Error("self-test failed: validator accepted a bad case (" + label + ")");
    }
  }

  // A prompt that leaked its own expectations would invalidate the method.
  const prompt = buildPrompt(base);
  const leaks = [...base.expect.mustLoad, base.expect.entryState, base.expect.mode];
  for (const leak of leaks) {
    if (prompt.includes(leak)) {
      throw new Error("self-test failed: prompt leaks the expectation " + leak);
    }
  }

  console.log("manual routing eval harness self-test passed (" + cases.length + " cases validated)");
  return EXIT.OK;
}

function main(argv) {
  if (argv.includes("--help")) {
    console.log("Usage: node tests/routing/run_routing_case.mjs [--list | --case ID | --self-test]");
    return EXIT.OK;
  }
  if (argv.includes("--self-test")) return selfTest();

  const cases = loadCases();
  if (argv.includes("--list") || argv.length === 0) {
    console.log("manual routing eval cases (" + cases.length + "):");
    for (const entry of cases) {
      console.log("");
      console.log("  " + entry.record.id);
      console.log("    request: " + entry.record.request);
      console.log("    guards : " + entry.record.why);
    }
    return EXIT.OK;
  }

  const index = argv.indexOf("--case");
  if (index === -1 || !argv[index + 1]) {
    console.error("pass --case ID, or --list to see available cases");
    return EXIT.USAGE;
  }
  const wanted = argv[index + 1];
  const entry = cases.find((item) => item.record.id === wanted);
  if (!entry) {
    console.error("unknown case: " + wanted);
    return EXIT.USAGE;
  }

  const problems = validateCase(entry.record);
  if (problems.length > 0) {
    console.error("case fixture is invalid:");
    for (const problem of problems) console.error("  " + problem);
    return EXIT.INVALID;
  }

  console.log("=== case: " + entry.record.id + " ===");
  console.log("");
  console.log("guards: " + entry.record.why);
  console.log("");
  console.log("--- prompt for a FRESH-CONTEXT read-only agent session ---");
  console.log("");
  console.log(buildPrompt(entry.record));
  console.log("");
  console.log("--- compare the reply against these expectations ---");
  console.log("");
  for (const line of formatExpectations(entry.record)) console.log(line);
  if (entry.record.notes) {
    console.log("");
    console.log("notes: " + entry.record.notes);
  }
  return EXIT.OK;
}

process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXIT,
  constraintFingerprint,
  nonemptyString,
  resolveSafeOutputPath,
} from "./audit_common.mjs";

const SCHEMA_VERSION = 1;
const RECORD_TYPE = "REQUIREMENTS_BASELINE";
const REPORT_KIND = "easyeda-requirements-baseline-check";

const REQUIRED_FUNCTION_CATEGORIES = Object.freeze([
  "POWER_INPUT",
  "PROGRAMMING_DEBUG",
  "EXTERNAL_INTERFACES",
  "RADIO_ANTENNA",
  "CONTROLS_INDICATORS",
  "EXPANSION_TEST",
]);

const REQUIREMENT_STATUSES = new Set([
  "CONFIRMED",
  "ASSUMPTION",
  "UNRESOLVED",
]);
const MATERIALITIES = new Set(["MATERIAL", "REVERSIBLE"]);
const FUNCTION_DISPOSITIONS = new Set([
  "INCLUDED",
  "OMITTED",
  "NOT_APPLICABLE",
  "UNRESOLVED",
]);
const DECISION_AUTHORITIES = new Set([
  "ORIGINAL_REQUEST_EXPLICIT",
  "USER_CONFIRMED",
  "USER_DELEGATED",
]);
const REQUIREMENT_AUTHORITIES = new Set([
  ...DECISION_AUTHORITIES,
  "GOVERNING_SPEC",
  "ENGINEERING_DERIVATION",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(nonemptyString).map((item) => item.trim()))]
    : [];
}

function add(problems, code, location, message) {
  problems.push({ code, location, message });
}

function validateSourceIds(sourceIds, sourceMap, problems, location) {
  const ids = uniqueStrings(sourceIds);
  if (!ids.length) {
    add(problems, "SOURCE_BASIS_MISSING", location, "at least one source ID is required");
    return ids;
  }
  for (const sourceId of ids) {
    if (!sourceMap.has(sourceId)) {
      add(
        problems,
        "SOURCE_BASIS_UNKNOWN",
        location,
        `source ID ${sourceId} is not present in requestSources`,
      );
    }
  }
  return ids;
}

function validateApproval(approval, sourceMap, problems, location) {
  if (!isObject(approval)) {
    add(problems, "APPROVAL_MISSING", location, "approval is required");
    return;
  }
  if (!DECISION_AUTHORITIES.has(approval.kind)) {
    add(
      problems,
      "APPROVAL_UNSUPPORTED",
      `${location}.kind`,
      "approval must be ORIGINAL_REQUEST_EXPLICIT, USER_CONFIRMED, or USER_DELEGATED; AI_DEDICATED is not product-feature approval",
    );
  }
  validateSourceIds(approval.sourceIds, sourceMap, problems, `${location}.sourceIds`);
}

function validateRequirements(requirements, sourceMap, problems) {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    add(problems, "REQUIREMENTS_MISSING", "requirements", "requirements must be a non-empty array");
    return;
  }
  const ids = new Set();
  requirements.forEach((requirement, index) => {
    const location = `requirements[${index}]`;
    if (!isObject(requirement)) {
      add(problems, "REQUIREMENT_INVALID", location, "requirement must be an object");
      return;
    }
    if (!nonemptyString(requirement.id)) {
      add(problems, "REQUIREMENT_ID_MISSING", `${location}.id`, "stable ID is required");
    } else if (ids.has(requirement.id)) {
      add(problems, "REQUIREMENT_ID_DUPLICATE", `${location}.id`, "requirement ID must be unique");
    } else {
      ids.add(requirement.id);
    }
    for (const field of ["category", "statement"]) {
      if (!nonemptyString(requirement[field])) {
        add(problems, "REQUIREMENT_FIELD_MISSING", `${location}.${field}`, `${field} is required`);
      }
    }
    if (!MATERIALITIES.has(requirement.materiality)) {
      add(problems, "MATERIALITY_INVALID", `${location}.materiality`, "materiality is missing or unsupported");
    }
    if (!REQUIREMENT_STATUSES.has(requirement.status)) {
      add(problems, "REQUIREMENT_STATUS_INVALID", `${location}.status`, "status is missing or unsupported");
    }
    const basis = requirement.basis;
    if (!isObject(basis) || !REQUIREMENT_AUTHORITIES.has(basis.kind)) {
      add(problems, "REQUIREMENT_BASIS_INVALID", `${location}.basis`, "requirement basis is missing or unsupported");
    } else {
      validateSourceIds(basis.sourceIds, sourceMap, problems, `${location}.basis.sourceIds`);
    }
    if (requirement.status === "UNRESOLVED") {
      add(problems, "REQUIREMENT_UNRESOLVED", location, "unresolved requirement blocks the baseline gate");
    }
    if (requirement.materiality === "MATERIAL" && requirement.status !== "CONFIRMED") {
      add(problems, "MATERIAL_REQUIREMENT_UNCONFIRMED", location, "material requirements must be confirmed");
    }
    if (
      requirement.status === "ASSUMPTION" &&
      (requirement.materiality !== "REVERSIBLE" || !nonemptyString(requirement.invalidationTrigger))
    ) {
      add(
        problems,
        "ASSUMPTION_NOT_BOUNDED",
        location,
        "an assumption must be reversible and name its invalidationTrigger",
      );
    }
  });
}

function validateFunctions(primaryFunctions, sourceMap, problems) {
  if (!Array.isArray(primaryFunctions) || primaryFunctions.length === 0) {
    add(problems, "PRIMARY_FUNCTIONS_MISSING", "primaryFunctions", "primaryFunctions must be a non-empty array");
    return { decisionIds: new Set(), categories: new Set() };
  }
  const decisionIds = new Set();
  const categories = new Set();
  primaryFunctions.forEach((decision, index) => {
    const location = `primaryFunctions[${index}]`;
    if (!isObject(decision)) {
      add(problems, "PRIMARY_FUNCTION_INVALID", location, "primary function decision must be an object");
      return;
    }
    if (!nonemptyString(decision.id)) {
      add(problems, "PRIMARY_FUNCTION_ID_MISSING", `${location}.id`, "stable ID is required");
    } else if (decisionIds.has(decision.id)) {
      add(problems, "PRIMARY_FUNCTION_ID_DUPLICATE", `${location}.id`, "primary function ID must be unique");
    } else {
      decisionIds.add(decision.id);
    }
    if (!nonemptyString(decision.category)) {
      add(problems, "PRIMARY_FUNCTION_CATEGORY_MISSING", `${location}.category`, "category is required");
    } else {
      categories.add(decision.category);
    }
    if (!nonemptyString(decision.feature)) {
      add(problems, "PRIMARY_FUNCTION_NAME_MISSING", `${location}.feature`, "feature is required");
    }
    if (!FUNCTION_DISPOSITIONS.has(decision.boardDisposition)) {
      add(problems, "PRIMARY_FUNCTION_DISPOSITION_INVALID", `${location}.boardDisposition`, "board disposition is missing or unsupported");
    }
    if (decision.boardDisposition === "UNRESOLVED") {
      add(problems, "PRIMARY_FUNCTION_UNRESOLVED", location, "unresolved primary function blocks full schematic commitment");
    }
    if (!nonemptyString(decision.implementation)) {
      add(problems, "IMPLEMENTATION_MISSING", `${location}.implementation`, "selected implementation or not-applicable rationale is required");
    }
    if (!uniqueStrings(decision.alternatives).length) {
      add(problems, "ALTERNATIVES_MISSING", `${location}.alternatives`, "at least one realistic alternative is required");
    }
    if (!uniqueStrings(decision.consequences).length) {
      add(problems, "CONSEQUENCES_MISSING", `${location}.consequences`, "at least one consequence or tradeoff is required");
    }
    validateSourceIds(decision.sourceIds, sourceMap, problems, `${location}.sourceIds`);
    validateApproval(decision.approval, sourceMap, problems, `${location}.approval`);
  });

  for (const category of REQUIRED_FUNCTION_CATEGORIES) {
    if (!categories.has(category)) {
      add(
        problems,
        "PRIMARY_FUNCTION_CATEGORY_UNCOVERED",
        "primaryFunctions",
        `required category ${category} is not covered; use NOT_APPLICABLE with rationale and approval when appropriate`,
      );
    }
  }
  return { decisionIds, categories };
}

function validateCoreParts(coreParts, sourceMap, decisionIds, problems) {
  if (!Array.isArray(coreParts) || coreParts.length === 0) {
    add(problems, "CORE_PARTS_MISSING", "coreParts", "at least one researched core part is required");
    return;
  }
  coreParts.forEach((part, partIndex) => {
    const location = `coreParts[${partIndex}]`;
    if (!isObject(part)) {
      add(problems, "CORE_PART_INVALID", location, "core part must be an object");
      return;
    }
    for (const field of ["reference", "manufacturerPartNumber"]) {
      if (!nonemptyString(part[field])) {
        add(problems, "CORE_PART_FIELD_MISSING", `${location}.${field}`, `${field} is required`);
      }
    }
    validateSourceIds(part.sourceIds, sourceMap, problems, `${location}.sourceIds`);
    if (!Array.isArray(part.capabilities) || part.capabilities.length === 0) {
      add(problems, "CORE_CAPABILITIES_MISSING", `${location}.capabilities`, "researched core-part capabilities are required");
      return;
    }
    part.capabilities.forEach((capability, capabilityIndex) => {
      const capabilityLocation = `${location}.capabilities[${capabilityIndex}]`;
      if (!isObject(capability) || !nonemptyString(capability.id) || !nonemptyString(capability.name)) {
        add(problems, "CORE_CAPABILITY_INVALID", capabilityLocation, "capability requires id and name");
      }
      if (!nonemptyString(capability.decisionId) || !decisionIds.has(capability.decisionId)) {
        add(
          problems,
          "CORE_CAPABILITY_UNMAPPED",
          `${capabilityLocation}.decisionId`,
          "each core-part capability must map to an included, omitted, or not-applicable primary-function decision",
        );
      }
    });
  });
}

function validateRequirementsBaseline(record) {
  const problems = [];
  if (!isObject(record)) {
    return {
      kind: REPORT_KIND,
      schemaVersion: SCHEMA_VERSION,
      gate: "PRIMARY_FUNCTIONS_CONFIRMED",
      decision: "UNRESOLVED",
      cleared: false,
      fabricationRelease: false,
      inputFingerprint: null,
      summary: { sourceCount: 0, requirementCount: 0, functionCount: 0, corePartCount: 0 },
      problems: [{ code: "RECORD_INVALID", location: "$", message: "record must be an object" }],
    };
  }

  if (record.schemaVersion !== SCHEMA_VERSION) {
    add(problems, "SCHEMA_VERSION_UNSUPPORTED", "schemaVersion", `schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (record.recordType !== RECORD_TYPE) {
    add(problems, "RECORD_TYPE_INVALID", "recordType", `recordType must be ${RECORD_TYPE}`);
  }
  if (!nonemptyString(record.revision)) {
    add(problems, "REVISION_MISSING", "revision", "revision is required for stale-evidence detection");
  }
  if (!isObject(record.project) || !nonemptyString(record.project.name) || !nonemptyString(record.project.identity)) {
    add(problems, "PROJECT_BINDING_MISSING", "project", "project.name and project.identity are required");
  }

  const sources = Array.isArray(record.requestSources) ? record.requestSources : [];
  const sourceMap = new Map();
  if (!sources.length) {
    add(problems, "REQUEST_SOURCES_MISSING", "requestSources", "at least one traceable request/source record is required");
  }
  sources.forEach((source, index) => {
    const location = `requestSources[${index}]`;
    if (!isObject(source) || !nonemptyString(source.id) || !nonemptyString(source.kind) || !nonemptyString(source.reference)) {
      add(problems, "REQUEST_SOURCE_INVALID", location, "source requires id, kind, and reference");
      return;
    }
    if (sourceMap.has(source.id)) {
      add(problems, "REQUEST_SOURCE_ID_DUPLICATE", `${location}.id`, "source ID must be unique");
    } else {
      sourceMap.set(source.id, source);
    }
  });

  validateRequirements(record.requirements, sourceMap, problems);
  const { decisionIds } = validateFunctions(record.primaryFunctions, sourceMap, problems);
  validateCoreParts(record.coreParts, sourceMap, decisionIds, problems);

  const cleared = problems.length === 0;
  return {
    kind: REPORT_KIND,
    schemaVersion: SCHEMA_VERSION,
    gate: "PRIMARY_FUNCTIONS_CONFIRMED",
    decision: cleared ? "CLEAR" : "UNRESOLVED",
    cleared,
    fabricationRelease: false,
    inputFingerprint: constraintFingerprint(record),
    baselineRevision: nonemptyString(record.revision) ? record.revision : null,
    summary: {
      sourceCount: sources.length,
      requirementCount: Array.isArray(record.requirements) ? record.requirements.length : 0,
      functionCount: Array.isArray(record.primaryFunctions) ? record.primaryFunctions.length : 0,
      corePartCount: Array.isArray(record.coreParts) ? record.coreParts.length : 0,
    },
    problems,
  };
}

function parseArgs(argv) {
  const options = { record: undefined, output: undefined, force: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--record") options.record = next();
    else if (option === "--output") options.output = next();
    else if (option === "--force") options.force = true;
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(
        "Usage: node requirements_baseline_lint.mjs --record FILE [--output FILE] [--force]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  if (!options.selfTest && !options.record) throw new Error("--record is required");
  return options;
}

function selfTestRecord() {
  const requestSources = [
    { id: "request", kind: "USER_MESSAGE", reference: "self-test explicit board request" },
    { id: "confirmation", kind: "USER_CONFIRMATION", reference: "self-test function confirmation" },
    { id: "datasheet", kind: "MANUFACTURER_DATASHEET", reference: "ESP32-C3 datasheet revision self-test" },
  ];
  const functionFor = (id, category, feature, disposition = "INCLUDED") => ({
    id,
    category,
    feature,
    boardDisposition: disposition,
    implementation: disposition === "NOT_APPLICABLE" ? "not applicable to this board objective" : `self-test ${feature}`,
    alternatives: ["different connector or implementation", "deliberate omission"],
    consequences: ["changes mechanics, power, pin allocation, cost, or firmware"],
    sourceIds: ["request", "datasheet"],
    approval: { kind: "USER_CONFIRMED", sourceIds: ["confirmation"] },
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    recordType: RECORD_TYPE,
    revision: "self-test-r1",
    project: { name: "ESP32-C3 minimal system", identity: "planning:self-test" },
    requestSources,
    requirements: [
      {
        id: "supply",
        category: "POWER",
        statement: "The board accepts 5 V input and powers ESP32-C3 peak load with margin",
        materiality: "MATERIAL",
        status: "CONFIRMED",
        basis: { kind: "USER_CONFIRMED", sourceIds: ["confirmation"] },
      },
    ],
    primaryFunctions: [
      functionFor("power-input", "POWER_INPUT", "5 V input and 3.3 V regulation"),
      functionFor("programming-usb", "PROGRAMMING_DEBUG", "USB Type-C data/programming"),
      functionFor("external-interfaces", "EXTERNAL_INTERFACES", "GPIO and UART exposure"),
      functionFor("radio-antenna", "RADIO_ANTENNA", "2.4 GHz onboard antenna"),
      functionFor("controls", "CONTROLS_INDICATORS", "boot/reset controls and power indication"),
      functionFor("expansion-test", "EXPANSION_TEST", "expansion and production test access"),
    ],
    coreParts: [
      {
        reference: "U1",
        manufacturerPartNumber: "ESP32-C3-MINI-1-H4X",
        sourceIds: ["datasheet"],
        capabilities: [
          { id: "native-usb", name: "native USB Serial/JTAG", decisionId: "programming-usb" },
          { id: "wifi-ble", name: "2.4 GHz Wi-Fi/BLE", decisionId: "radio-antenna" },
        ],
      },
    ],
  };
}

function runSelfTest() {
  const valid = selfTestRecord();
  assert.equal(validateRequirementsBaseline(valid).cleared, true);

  const unresolvedUsb = structuredClone(valid);
  unresolvedUsb.primaryFunctions[1].boardDisposition = "UNRESOLVED";
  assert.equal(validateRequirementsBaseline(unresolvedUsb).cleared, false);

  const silentOmission = structuredClone(valid);
  silentOmission.primaryFunctions[1].boardDisposition = "OMITTED";
  silentOmission.primaryFunctions[1].approval = { kind: "UNRESOLVED", sourceIds: ["confirmation"] };
  assert.match(
    JSON.stringify(validateRequirementsBaseline(silentOmission).problems),
    /APPROVAL_UNSUPPORTED/,
  );

  const missingCategory = structuredClone(valid);
  missingCategory.primaryFunctions = missingCategory.primaryFunctions.filter(
    (item) => item.category !== "PROGRAMMING_DEBUG",
  );
  const missingCategoryResult = validateRequirementsBaseline(missingCategory);
  assert.match(JSON.stringify(missingCategoryResult.problems), /PRIMARY_FUNCTION_CATEGORY_UNCOVERED/);
  assert.match(JSON.stringify(missingCategoryResult.problems), /CORE_CAPABILITY_UNMAPPED/);

  const aiApproval = structuredClone(valid);
  aiApproval.primaryFunctions[1].approval.kind = "AI_DEDICATED";
  assert.match(JSON.stringify(validateRequirementsBaseline(aiApproval).problems), /APPROVAL_UNSUPPORTED/);

  const materialAssumption = structuredClone(valid);
  materialAssumption.requirements[0].status = "ASSUMPTION";
  assert.match(
    JSON.stringify(validateRequirementsBaseline(materialAssumption).problems),
    /MATERIAL_REQUIREMENT_UNCONFIRMED/,
  );

  process.stdout.write(
    `${JSON.stringify({ selfTest: "passed", gate: "PRIMARY_FUNCTIONS_CONFIRMED", scenarios: 6 }, null, 2)}\n`,
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) {
      runSelfTest();
      return;
    }
    const recordPath = path.resolve(options.record);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const result = validateRequirementsBaseline(record);
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) {
      const outputPath = resolveSafeOutputPath(options.output, { force: options.force });
      await writeFile(outputPath, serialized, "utf8");
    }
    process.stdout.write(serialized);
    process.exitCode = result.cleared ? EXIT.OK : EXIT.UNVERIFIED;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
    process.exitCode = EXIT.ERROR;
  }
}

export {
  RECORD_TYPE,
  REPORT_KIND,
  REQUIRED_FUNCTION_CATEGORIES,
  parseArgs,
  validateRequirementsBaseline,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

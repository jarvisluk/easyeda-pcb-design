#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DECISION_VALUES,
  DESIGN_FINGERPRINT_SCHEMA_VERSION,
  applyDecisionExitCode,
  constraintFingerprint,
  designFingerprint,
  nonemptyString,
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
} from "../lib/audit_common.mjs";

const ACCESS_STATUSES = new Set([
  "AVAILABLE_VERIFIED",
  "ACCESS_BLOCKED",
  "DOWNLOAD_FAILED",
  "CONTENT_UNREADABLE",
  "VARIANT_MISMATCH",
  "STALE_REVISION",
]);
const ACCEPTED_AUTHORITIES = new Set([
  "MANUFACTURER_PRIMARY",
  "MANUFACTURER_SIGNED",
  "MANUFACTURER_ARCHIVE",
  "MANUFACTURER_PROVIDED",
]);
const ACCEPTED_MEDIA_TYPES = new Set([
  "application/pdf",
  "text/html",
  "text/plain",
]);
const ACCEPTED_REVIEW_METHODS = new Set([
  "TEXT_EXTRACTED",
  "VISUAL_REVIEW",
]);
const ACCEPTED_CRITICALITIES = new Set(["CRITICAL", "STANDARD"]);
const ACCEPTED_DISPOSITIONS = new Set(["POPULATE", "DNP", "MANUAL_FIT"]);
const ACCEPTED_REQUIREMENT_BASIS_KINDS = new Set([
  "USER_CONFIRMED",
  "REQUIREMENTS_BASELINE",
  "GOVERNING_SPEC",
  "DERIVED_CALCULATION",
]);
const ACCEPTED_LIBRARY_RESOLUTIONS = new Set([
  "EXACT_LIBRARY_DEVICE",
  "CUSTOM_EXACT_DEVICE",
  "APPROVED_SUBSTITUTE",
  "BLOCKED",
]);
const ACCEPTED_SUBSTITUTION_POLICIES = new Set([
  "FORBID",
  "ALLOW_FORM_FIT_FUNCTION",
  "ALLOW_FUNCTIONAL_ALTERNATIVE",
]);
const REQUIRED_SUBSTITUTION_COMPARISONS = [
  "electrical",
  "pinout",
  "package",
  "footprint",
  "thermal",
  "mechanical",
  "firmware",
  "regulatory",
];
const ACCEPTED_SUBSTITUTION_COMPARISON_STATES = new Set([
  "MATCH",
  "EQUIVALENT_OR_BETTER",
  "REQUALIFIED",
  "NOT_APPLICABLE",
]);
const SUPPORTED_SUITABILITY_CHECK_TYPES = new Set([
  "PARAMETER_AT_LEAST",
  "PARAMETER_AT_MOST",
  "PARAMETER_RANGE_CONTAINS",
  "LINEAR_REGULATOR_THERMAL",
]);
const REQUIRED_PARAMETER_COVERAGE_ASPECTS = [
  "FUNCTIONAL_CAPABILITY",
  "ELECTRICAL_LIMITS",
  "OPERATING_RANGE",
  "TOLERANCE_ACCURACY",
  "POWER_THERMAL",
  "TIMING_FREQUENCY",
  "SIGNAL_INTEGRITY_PARASITICS",
  "MECHANICAL_ASSEMBLY",
  "ENVIRONMENT_RELIABILITY",
];
const ACCEPTED_PARAMETER_COVERAGE_STATUSES = new Set([
  "AUDITED",
  "RECORDED",
  "NOT_APPLICABLE",
]);
const REQUIRED_INVALIDATION_TRIGGERS = new Set([
  "designFingerprint",
  "manufacturerPartNumber",
  "package",
  "footprint",
  "sourceRevision",
  "sourceParameters",
  "parameterCoverage",
  "designRequirements",
  "suitabilityChecks",
  "libraryBinding",
  "substitutionApproval",
]);
const SHA256_RE = /^(?:sha256:)?([a-f0-9]{64})$/i;
const OBVIOUS_HTML_BLOCK_RE =
  /<title>\s*(?:login|sign[ -]?in|access denied|forbidden)|\b(?:access denied|sign in to continue|request blocked|403 forbidden)\b/i;

function normalizedPartNumber(value) {
  return nonemptyString(value)
    ? value.trim().replace(/\s+/g, "").toUpperCase()
    : "";
}

function validTimestamp(value) {
  return nonemptyString(value) && !Number.isNaN(Date.parse(value));
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validateArtifact(source, baseDir) {
  const problems = [];
  if (!nonemptyString(source?.artifactPath)) {
    return { valid: false, problems: ["artifactPath is missing"] };
  }
  const artifactPath = path.isAbsolute(source.artifactPath)
    ? path.resolve(source.artifactPath)
    : path.resolve(baseDir, source.artifactPath);
  let stat;
  let content;
  try {
    stat = statSync(artifactPath);
    if (!stat.isFile()) problems.push("artifact is not a regular file");
    if (stat.size <= 0) problems.push("artifact is empty");
    if (!problems.length) content = readFileSync(artifactPath);
  } catch (error) {
    problems.push(
      `artifact is unavailable or unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const expectedHash = nonemptyString(source?.sha256)
    ? source.sha256.trim().match(SHA256_RE)?.[1]?.toLowerCase()
    : undefined;
  if (!expectedHash) {
    problems.push("sha256 is missing or malformed");
  } else if (content && sha256Buffer(content) !== expectedHash) {
    problems.push("artifact sha256 does not match the record");
  }

  if (!ACCEPTED_MEDIA_TYPES.has(source?.mediaType)) {
    problems.push("mediaType is missing or unsupported");
  } else if (content) {
    const prefix = content.subarray(0, 1024).toString("latin1");
    if (source.mediaType === "application/pdf") {
      if (!prefix.startsWith("%PDF-")) problems.push("PDF signature is missing");
      if (!content.includes(Buffer.from("%%EOF"))) problems.push("PDF end marker is missing");
      if (/^\s*</.test(prefix) || /<html/i.test(prefix)) {
        problems.push("artifact is HTML content mislabeled as PDF");
      }
      if (content.includes(Buffer.from("/Encrypt")) && source.decryptionStatus !== "DECRYPTED_VERIFIED") {
        problems.push("encrypted PDF is not recorded as decrypted and readable");
      }
    } else {
      const text = content.toString("utf8");
      if (source.mediaType === "text/html" && !/<html|<!doctype/i.test(text)) {
        problems.push("HTML artifact has no HTML document marker");
      }
      if (OBVIOUS_HTML_BLOCK_RE.test(text)) {
        problems.push("artifact appears to be a login, denial, or block page");
      }
    }
  }
  return {
    valid: problems.length === 0,
    artifactPath,
    size: stat?.isFile() ? stat.size : null,
    actualSha256: content ? sha256Buffer(content) : null,
    problems,
  };
}

function validateSource(sourceId, source, baseDir) {
  const problems = [];
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { sourceId, valid: false, problems: ["source record is not an object"] };
  }
  for (const field of ["publisher", "documentId", "revision"]) {
    if (!nonemptyString(source[field])) problems.push(`${field} is missing`);
  }
  if (!validTimestamp(source.retrievedAt)) problems.push("retrievedAt is missing or invalid");
  if (!ACCESS_STATUSES.has(source.accessStatus)) {
    problems.push("accessStatus is missing or unknown");
  } else if (source.accessStatus !== "AVAILABLE_VERIFIED") {
    problems.push(`accessStatus is ${source.accessStatus}`);
  }
  if (!ACCEPTED_AUTHORITIES.has(source.authority)) {
    problems.push("source authority is not an accepted manufacturer tier");
  }
  if (
    source.authority !== "MANUFACTURER_PROVIDED" &&
    (!nonemptyString(source.canonicalUrl) || !/^https:\/\//i.test(source.canonicalUrl))
  ) {
    problems.push("canonicalUrl must be an HTTPS manufacturer URL");
  }
  if (
    source.authority === "MANUFACTURER_PROVIDED" &&
    !nonemptyString(source.provenance)
  ) {
    problems.push("manufacturer-provided evidence requires provenance");
  }

  const review = source.contentVerification;
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    problems.push("contentVerification is missing");
  } else {
    if (review.status !== "VERIFIED") {
      problems.push("contentVerification.status is not VERIFIED");
    }
    if (!ACCEPTED_REVIEW_METHODS.has(review.method)) {
      problems.push("contentVerification.method is missing or unsupported");
    }
    if (review.exactPartMatch !== true) {
      problems.push("content verification did not confirm the exact part/family");
    }
    if (review.revisionMatch !== true) {
      problems.push("content verification did not confirm the recorded revision");
    }
    if (review.observedDocumentId !== source.documentId) {
      problems.push("observed document ID does not match the source record");
    }
    if (review.observedRevision !== source.revision) {
      problems.push("observed revision does not match the source record");
    }
    if (!Array.isArray(review.coveredPartNumbers) || !review.coveredPartNumbers.length) {
      problems.push("content verification coveredPartNumbers are missing");
    }
    if (!nonemptyString(review.location)) {
      problems.push("content verification location is missing");
    }
    if (!validTimestamp(review.reviewedAt)) {
      problems.push("content verification reviewedAt is missing or invalid");
    }
    if (!nonemptyString(review.reviewer)) {
      problems.push("content verification reviewer is missing");
    }
  }

  const artifact = validateArtifact(source, baseDir);
  problems.push(...artifact.problems);
  return {
    sourceId,
    valid: problems.length === 0,
    authority: source.authority || null,
    accessStatus: source.accessStatus || null,
    documentId: source.documentId || null,
    revision: source.revision || null,
    artifact,
    problems: [...new Set(problems)],
  };
}

function validateRequirement(requirement, sourceIds) {
  const problems = [];
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
    return ["requirement is not an object"];
  }
  if (!nonemptyString(requirement.name)) problems.push("requirement name is missing");
  if (
    requirement.value === undefined ||
    requirement.value === null ||
    (typeof requirement.value === "string" && !requirement.value.trim())
  ) {
    problems.push("requirement value is missing");
  }
  if (!nonemptyString(requirement.sourceId) || !sourceIds.has(requirement.sourceId)) {
    problems.push("requirement sourceId is missing or unknown");
  }
  if (!nonemptyString(requirement.location)) {
    problems.push("requirement source location is missing");
  }
  if (!nonemptyString(requirement.derivation)) {
    problems.push("requirement derivation is missing");
  }
  return problems;
}

function validateDesignRequirement(requirement) {
  const problems = [];
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
    return ["design requirement is not an object"];
  }
  if (!nonemptyString(requirement.id)) problems.push("id is missing");
  if (!nonemptyString(requirement.name)) problems.push("name is missing");
  if (!Number.isFinite(requirement.value)) problems.push("value must be a finite number");
  if (!nonemptyString(requirement.unit)) problems.push("unit is missing");
  const basis = requirement.basis;
  if (!basis || typeof basis !== "object" || Array.isArray(basis)) {
    problems.push("basis is missing");
  } else {
    if (!ACCEPTED_REQUIREMENT_BASIS_KINDS.has(basis.kind)) {
      problems.push("basis.kind is missing or unsupported");
    }
    if (!nonemptyString(basis.reference)) {
      problems.push("basis.reference is missing");
    }
    if (
      basis.kind === "REQUIREMENTS_BASELINE" &&
      (!nonemptyString(basis.fingerprint) || !/^sha256:[a-f0-9]{64}$/i.test(basis.fingerprint.trim()))
    ) {
      problems.push("REQUIREMENTS_BASELINE basis.fingerprint is missing or malformed");
    }
  }
  if (!nonemptyString(requirement.conditions)) {
    problems.push("conditions are missing");
  }
  return problems;
}

function validateParameter(parameter, sourceIds) {
  const problems = [];
  if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
    return ["parameter is not an object"];
  }
  if (!nonemptyString(parameter.id)) problems.push("id is missing");
  if (!nonemptyString(parameter.name)) problems.push("name is missing");
  if (!Number.isFinite(parameter.value)) {
    problems.push("value must be a finite number");
  }
  if (!nonemptyString(parameter.unit)) problems.push("unit is missing");
  if (!nonemptyString(parameter.sourceId) || !sourceIds.has(parameter.sourceId)) {
    problems.push("sourceId is missing or unknown");
  }
  if (!nonemptyString(parameter.location)) {
    problems.push("source location is missing");
  }
  if (!nonemptyString(parameter.conditions)) {
    problems.push("conditions are missing");
  }
  return problems;
}

function validateParameterCoverage(part, parameterById) {
  const problems = [];
  const violations = [];
  const coverageRecords = Array.isArray(part?.parameterCoverage)
    ? part.parameterCoverage
    : [];
  if (!Array.isArray(part?.parameterCoverage)) {
    return {
      problems: ["parameterCoverage must be an array"],
      violations,
      checkIds: new Set(),
      entries: [],
    };
  }
  const byAspect = new Map();
  const coveredParameterIds = new Set();
  const coveredCheckIds = new Set();
  const entries = [];
  for (const [index, coverage] of coverageRecords.entries()) {
    const label = nonemptyString(coverage?.aspect)
      ? coverage.aspect.trim()
      : `entry ${index + 1}`;
    const entryProblems = [];
    if (!REQUIRED_PARAMETER_COVERAGE_ASPECTS.includes(coverage?.aspect)) {
      entryProblems.push("aspect is missing or unsupported");
    } else if (byAspect.has(coverage.aspect)) {
      violations.push(`parameterCoverage has duplicate aspect ${coverage.aspect}`);
    } else {
      byAspect.set(coverage.aspect, coverage);
    }
    if (!ACCEPTED_PARAMETER_COVERAGE_STATUSES.has(coverage?.status)) {
      entryProblems.push("status is missing or unsupported");
    }
    if (!nonemptyString(coverage?.rationale)) {
      entryProblems.push("rationale is missing");
    }
    const parameterIds = Array.isArray(coverage?.parameterIds)
      ? coverage.parameterIds
      : [];
    const checkIds = Array.isArray(coverage?.checkIds) ? coverage.checkIds : [];
    if (!Array.isArray(coverage?.parameterIds)) {
      entryProblems.push("parameterIds must be an array");
    }
    if (!Array.isArray(coverage?.checkIds)) {
      entryProblems.push("checkIds must be an array");
    }
    if (new Set(parameterIds).size !== parameterIds.length) {
      entryProblems.push("parameterIds contain duplicates");
    }
    if (new Set(checkIds).size !== checkIds.length) {
      entryProblems.push("checkIds contain duplicates");
    }
    for (const parameterId of parameterIds) {
      if (!parameterById.has(parameterId)) {
        entryProblems.push(`parameterId ${parameterId} is unknown`);
      } else {
        coveredParameterIds.add(parameterId);
      }
    }
    for (const checkId of checkIds) {
      if (!nonemptyString(checkId)) {
        entryProblems.push("checkIds contain an empty ID");
      } else {
        coveredCheckIds.add(checkId);
      }
    }
    if (coverage?.status === "AUDITED") {
      if (!parameterIds.length) entryProblems.push("AUDITED aspect has no parameters");
      if (!checkIds.length) entryProblems.push("AUDITED aspect has no checks");
    } else if (coverage?.status === "RECORDED") {
      if (!parameterIds.length) entryProblems.push("RECORDED aspect has no parameters");
      if (checkIds.length) {
        entryProblems.push("RECORDED aspect has checks; mark it AUDITED");
      }
    } else if (coverage?.status === "NOT_APPLICABLE") {
      if (parameterIds.length || checkIds.length) {
        entryProblems.push("NOT_APPLICABLE aspect cannot list parameters or checks");
      }
    }
    problems.push(...entryProblems.map((problem) => `${label}: ${problem}`));
    entries.push({
      aspect: coverage?.aspect || null,
      status: coverage?.status || null,
      parameterIds,
      checkIds,
      valid: entryProblems.length === 0,
      problems: entryProblems,
    });
  }
  for (const aspect of REQUIRED_PARAMETER_COVERAGE_ASPECTS) {
    if (!byAspect.has(aspect)) problems.push(`parameterCoverage is missing ${aspect}`);
  }
  for (const parameterId of parameterById.keys()) {
    if (!coveredParameterIds.has(parameterId)) {
      problems.push(`parameter ${parameterId} is not classified by parameterCoverage`);
    }
  }
  if (
    ["POPULATE", "MANUAL_FIT"].includes(part?.disposition) &&
    !coverageRecords.some((coverage) => coverage?.status === "AUDITED")
  ) {
    problems.push("used part has no AUDITED parameter aspect");
  }
  return { problems, violations, checkIds: coveredCheckIds, entries };
}

function validateReferencedEvidenceFile(fileReference, baseDir, label) {
  if (!nonemptyString(fileReference)) return [`${label} is missing`];
  const resolved = path.isAbsolute(fileReference)
    ? path.resolve(fileReference)
    : path.resolve(baseDir, fileReference);
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) return [`${label} is not a regular file`];
    if (stat.size <= 0) return [`${label} is empty`];
  } catch (error) {
    return [
      `${label} is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  return [];
}

function validateLibraryBinding(part, baseDir) {
  const problems = [];
  const violations = [];
  const binding = part?.libraryBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return {
      valid: false,
      blocked: false,
      problems: ["libraryBinding is missing"],
      violations,
    };
  }
  if (!ACCEPTED_LIBRARY_RESOLUTIONS.has(binding.resolution)) {
    problems.push("libraryBinding.resolution is missing or unsupported");
  }
  if (!ACCEPTED_SUBSTITUTION_POLICIES.has(binding.substitutionPolicy)) {
    problems.push("libraryBinding.substitutionPolicy is missing or unsupported");
  }
  const requestedMpn = normalizedPartNumber(
    binding.requestedManufacturerPartNumber,
  );
  const selectedMpn = normalizedPartNumber(
    binding.selectedManufacturerPartNumber,
  );
  const partMpn = normalizedPartNumber(part?.manufacturerPartNumber);
  if (!requestedMpn) problems.push("requestedManufacturerPartNumber is missing");
  if (!selectedMpn) problems.push("selectedManufacturerPartNumber is missing");
  if (selectedMpn && partMpn && selectedMpn !== partMpn) {
    violations.push(
      "libraryBinding selected MPN differs from the component evidence MPN",
    );
  }

  if (binding.resolution === "BLOCKED") {
    if (!nonemptyString(binding.reason)) problems.push("blocked binding reason is missing");
    return { valid: false, blocked: true, problems, violations };
  }

  for (const field of ["deviceUuid", "symbolUuid", "footprintUuid"]) {
    if (!nonemptyString(binding[field])) problems.push(`${field} is missing`);
  }

  if (
    binding.resolution === "EXACT_LIBRARY_DEVICE" ||
    binding.resolution === "CUSTOM_EXACT_DEVICE"
  ) {
    if (requestedMpn && selectedMpn && requestedMpn !== selectedMpn) {
      violations.push(`${binding.resolution} changed the requested exact MPN`);
    }
    if (binding.resolution === "CUSTOM_EXACT_DEVICE") {
      problems.push(
        ...validateReferencedEvidenceFile(
          binding.qualificationArtifact,
          baseDir,
          "custom-device qualificationArtifact",
        ),
      );
    }
  }

  if (binding.resolution === "APPROVED_SUBSTITUTE") {
    if (requestedMpn && selectedMpn && requestedMpn === selectedMpn) {
      problems.push("APPROVED_SUBSTITUTE did not change the requested MPN");
    }
    if (binding.substitutionPolicy === "FORBID") {
      violations.push("substitution was made while substitutionPolicy is FORBID");
    }
    if (!nonemptyString(binding.reason)) problems.push("substitution reason is missing");
    if (!nonemptyString(binding.approvalReference)) {
      problems.push("substitution approvalReference is missing");
    }
    problems.push(
      ...validateReferencedEvidenceFile(
        binding.candidateComparisonArtifact,
        baseDir,
        "candidateComparisonArtifact",
      ),
    );
    const comparison = binding.comparison;
    if (!comparison || typeof comparison !== "object" || Array.isArray(comparison)) {
      problems.push("substitution comparison is missing");
    } else {
      for (const field of REQUIRED_SUBSTITUTION_COMPARISONS) {
        if (!ACCEPTED_SUBSTITUTION_COMPARISON_STATES.has(comparison[field])) {
          problems.push(`substitution comparison ${field} is unresolved`);
        }
      }
    }
  }

  return {
    valid: problems.length === 0 && violations.length === 0,
    blocked: false,
    problems,
    violations,
  };
}

function resolveNumericRecord(map, id, kind, problems) {
  if (!nonemptyString(id) || !map.has(id)) {
    problems.push(`${kind} ${id || "<missing>"} is missing`);
    return null;
  }
  const record = map.get(id);
  if (!Number.isFinite(record.value) || !nonemptyString(record.unit)) {
    problems.push(`${kind} ${id} has no finite value/unit`);
    return null;
  }
  return record;
}

function sameUnit(records, problems, checkId) {
  const units = new Set(records.filter(Boolean).map((record) => record.unit));
  if (units.size > 1) {
    problems.push(`suitability check ${checkId} mixes incompatible units`);
    return false;
  }
  return true;
}

function evaluateSuitabilityCheck(
  check,
  requirementById,
  partByReference,
  parameterMaps,
) {
  const problems = [];
  const violations = [];
  if (!check || typeof check !== "object" || Array.isArray(check)) {
    return {
      id: null,
      type: null,
      partReference: null,
      passed: false,
      problems: ["suitability check is not an object"],
      violations,
    };
  }
  const id = nonemptyString(check.id) ? check.id.trim() : null;
  const type = check.type;
  const partReference = nonemptyString(check.partReference)
    ? check.partReference.trim()
    : null;
  if (!id) problems.push("suitability check id is missing");
  if (!SUPPORTED_SUITABILITY_CHECK_TYPES.has(type)) {
    problems.push(`suitability check ${id || "<missing>"} type is unsupported`);
  }
  if (!partReference || !partByReference.has(partReference)) {
    problems.push(`suitability check ${id || "<missing>"} partReference is unknown`);
  }
  const parameterById = parameterMaps.get(partReference) || new Map();
  let calculation = null;

  if (type === "PARAMETER_AT_LEAST" || type === "PARAMETER_AT_MOST") {
    const parameter = resolveNumericRecord(
      parameterById,
      check.parameterId,
      "parameter",
      problems,
    );
    const requirement = resolveNumericRecord(
      requirementById,
      check.requirementId,
      "design requirement",
      problems,
    );
    sameUnit([parameter, requirement], problems, id);
    if (parameter && requirement && !problems.length) {
      const passed =
        type === "PARAMETER_AT_LEAST"
          ? parameter.value >= requirement.value
          : parameter.value <= requirement.value;
      calculation = {
        parameterValue: parameter.value,
        requirementValue: requirement.value,
        unit: parameter.unit,
      };
      if (!passed) {
        violations.push(
          `${id}: ${parameter.value} ${parameter.unit} does not satisfy ${type} ${requirement.value} ${requirement.unit}`,
        );
      }
    }
  } else if (type === "PARAMETER_RANGE_CONTAINS") {
    const parameterMinimum = resolveNumericRecord(
      parameterById,
      check.parameterMinimumId,
      "parameter",
      problems,
    );
    const parameterMaximum = resolveNumericRecord(
      parameterById,
      check.parameterMaximumId,
      "parameter",
      problems,
    );
    const requirementMinimum = resolveNumericRecord(
      requirementById,
      check.requirementMinimumId,
      "design requirement",
      problems,
    );
    const requirementMaximum = resolveNumericRecord(
      requirementById,
      check.requirementMaximumId,
      "design requirement",
      problems,
    );
    sameUnit(
      [parameterMinimum, parameterMaximum, requirementMinimum, requirementMaximum],
      problems,
      id,
    );
    if (
      parameterMinimum &&
      parameterMaximum &&
      requirementMinimum &&
      requirementMaximum &&
      !problems.length
    ) {
      if (parameterMinimum.value > parameterMaximum.value) {
        problems.push(`suitability check ${id} has an inverted part range`);
      }
      if (requirementMinimum.value > requirementMaximum.value) {
        problems.push(`suitability check ${id} has an inverted requirement range`);
      }
    }
    if (
      parameterMinimum &&
      parameterMaximum &&
      requirementMinimum &&
      requirementMaximum &&
      !problems.length
    ) {
      const passed =
        parameterMinimum.value <= requirementMinimum.value &&
        parameterMaximum.value >= requirementMaximum.value;
      calculation = {
        parameterRange: [parameterMinimum.value, parameterMaximum.value],
        requirementRange: [requirementMinimum.value, requirementMaximum.value],
        unit: parameterMinimum.unit,
      };
      if (!passed) {
        violations.push(
          `${id}: part range ${parameterMinimum.value}..${parameterMaximum.value} ${parameterMinimum.unit} does not contain required range ${requirementMinimum.value}..${requirementMaximum.value} ${requirementMinimum.unit}`,
        );
      }
    }
  } else if (type === "LINEAR_REGULATOR_THERMAL") {
    const requirementIds = check.requirementIds || {};
    const parameterIds = check.parameterIds || {};
    const inputMinimum = resolveNumericRecord(
      requirementById,
      requirementIds.inputVoltageMinimumV,
      "design requirement",
      problems,
    );
    const inputMaximum = resolveNumericRecord(
      requirementById,
      requirementIds.inputVoltageMaximumV,
      "design requirement",
      problems,
    );
    const outputVoltage = resolveNumericRecord(
      requirementById,
      requirementIds.outputVoltageV,
      "design requirement",
      problems,
    );
    const continuousCurrent = resolveNumericRecord(
      requirementById,
      requirementIds.continuousOutputCurrentA,
      "design requirement",
      problems,
    );
    const peakCurrent = resolveNumericRecord(
      requirementById,
      requirementIds.peakOutputCurrentA,
      "design requirement",
      problems,
    );
    const ambientMaximum = resolveNumericRecord(
      requirementById,
      requirementIds.ambientMaximumC,
      "design requirement",
      problems,
    );
    const junctionMargin = resolveNumericRecord(
      requirementById,
      requirementIds.minimumJunctionMarginC,
      "design requirement",
      problems,
    );
    const ratedCurrent = resolveNumericRecord(
      parameterById,
      parameterIds.ratedOutputCurrentA,
      "parameter",
      problems,
    );
    const dropoutMaximum = resolveNumericRecord(
      parameterById,
      parameterIds.dropoutVoltageMaximumV,
      "parameter",
      problems,
    );
    const thetaJa = resolveNumericRecord(
      parameterById,
      parameterIds.thetaJaCPerW,
      "parameter",
      problems,
    );
    const junctionMaximum = resolveNumericRecord(
      parameterById,
      parameterIds.maximumJunctionTemperatureC,
      "parameter",
      problems,
    );
    const quiescentCurrent = nonemptyString(parameterIds.quiescentCurrentMaximumA)
      ? resolveNumericRecord(
          parameterById,
          parameterIds.quiescentCurrentMaximumA,
          "parameter",
          problems,
        )
      : { value: 0, unit: "A" };
    const expectedUnits = [
      [inputMinimum, "V"],
      [inputMaximum, "V"],
      [outputVoltage, "V"],
      [continuousCurrent, "A"],
      [peakCurrent, "A"],
      [ambientMaximum, "degC"],
      [junctionMargin, "degC"],
      [ratedCurrent, "A"],
      [dropoutMaximum, "V"],
      [thetaJa, "degC/W"],
      [junctionMaximum, "degC"],
      [quiescentCurrent, "A"],
    ];
    for (const [record, unit] of expectedUnits) {
      if (record && record.unit !== unit) {
        problems.push(
          `suitability check ${id || "<missing>"} expected ${unit}, got ${record.unit}`,
        );
      }
    }
    if (expectedUnits.every(([record]) => record) && !problems.length) {
      if (inputMinimum.value > inputMaximum.value) {
        problems.push(`suitability check ${id} has an inverted input-voltage range`);
      }
      for (const [label, value] of [
        ["continuous output current", continuousCurrent.value],
        ["peak output current", peakCurrent.value],
        ["rated output current", ratedCurrent.value],
        ["maximum dropout voltage", dropoutMaximum.value],
        ["theta-JA", thetaJa.value],
        ["minimum junction margin", junctionMargin.value],
        ["maximum quiescent current", quiescentCurrent.value],
      ]) {
        if (value < 0) problems.push(`suitability check ${id} has negative ${label}`);
      }
      if (thetaJa.value === 0) {
        problems.push(`suitability check ${id} theta-JA must be greater than zero`);
      }
      if (continuousCurrent.value > peakCurrent.value) {
        problems.push(
          `suitability check ${id} continuous current exceeds recorded peak current`,
        );
      }
    }
    if (expectedUnits.every(([record]) => record) && !problems.length) {
      const availableHeadroomV = inputMinimum.value - outputVoltage.value;
      const powerDissipationW =
        Math.max(0, inputMaximum.value - outputVoltage.value) *
          continuousCurrent.value +
        inputMaximum.value * quiescentCurrent.value;
      const estimatedJunctionTemperatureC =
        ambientMaximum.value + powerDissipationW * thetaJa.value;
      const allowedJunctionTemperatureC =
        junctionMaximum.value - junctionMargin.value;
      const currentPassed = ratedCurrent.value >= peakCurrent.value;
      const dropoutPassed = availableHeadroomV >= dropoutMaximum.value;
      const thermalPassed =
        estimatedJunctionTemperatureC <= allowedJunctionTemperatureC;
      calculation = {
        inputVoltageRangeV: [inputMinimum.value, inputMaximum.value],
        outputVoltageV: outputVoltage.value,
        continuousOutputCurrentA: continuousCurrent.value,
        peakOutputCurrentA: peakCurrent.value,
        ratedOutputCurrentA: ratedCurrent.value,
        availableHeadroomV,
        dropoutVoltageMaximumV: dropoutMaximum.value,
        powerDissipationW,
        thetaJaCPerW: thetaJa.value,
        ambientMaximumC: ambientMaximum.value,
        estimatedJunctionTemperatureC,
        maximumJunctionTemperatureC: junctionMaximum.value,
        minimumJunctionMarginC: junctionMargin.value,
        allowedJunctionTemperatureC,
        currentPassed,
        dropoutPassed,
        thermalPassed,
      };
      if (!currentPassed) {
        violations.push(
          `${id}: rated current ${ratedCurrent.value} A is below required peak ${peakCurrent.value} A`,
        );
      }
      if (!dropoutPassed) {
        violations.push(
          `${id}: minimum headroom ${availableHeadroomV} V is below maximum dropout ${dropoutMaximum.value} V`,
        );
      }
      if (!thermalPassed) {
        violations.push(
          `${id}: estimated junction temperature ${estimatedJunctionTemperatureC.toFixed(2)} degC exceeds allowed ${allowedJunctionTemperatureC.toFixed(2)} degC`,
        );
      }
    }
  }

  return {
    id,
    type,
    partReference,
    passed: problems.length === 0 && violations.length === 0,
    calculation,
    problems,
    violations,
  };
}

function validateComponentEvidenceRecord(record, raw, options = {}) {
  const baseDir = path.resolve(options.baseDir || process.cwd());
  const unverified = [];
  const violations = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {
      provided: false,
      cleared: false,
      decision: DECISION_VALUES.UNVERIFIED,
      fabricationRelease: false,
      notAFabricationRelease: notAFabricationReleaseMessage(),
      fingerprint: null,
      unverified: ["component-selection evidence record is missing"],
      violations,
      sources: [],
      parts: [],
    };
  }
  if (record.schemaVersion !== 2) {
    unverified.push(
      "component-selection evidence schemaVersion must be 2; schema v1 proves traceability only and cannot clear suitability or library binding",
    );
  }
  const expectedFingerprint = designFingerprint(raw);
  const binding = record.schematic;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    unverified.push("schematic binding is missing");
  } else {
    if (binding.projectUuid !== raw.project?.uuid) {
      unverified.push("component evidence project UUID is missing or stale");
    }
    if (binding.documentUuid !== raw.document?.uuid) {
      unverified.push("component evidence document UUID is missing or stale");
    }
    if (binding.designFingerprint !== expectedFingerprint) {
      unverified.push("component evidence design fingerprint is missing or stale");
    }
    if (binding.fingerprintSchemaVersion !== DESIGN_FINGERPRINT_SCHEMA_VERSION) {
      unverified.push("component evidence fingerprint schema is missing or stale");
    }
  }

  const invalidationPolicy = new Set(
    Array.isArray(record.invalidationPolicy) ? record.invalidationPolicy : [],
  );
  for (const trigger of REQUIRED_INVALIDATION_TRIGGERS) {
    if (!invalidationPolicy.has(trigger)) {
      unverified.push(`invalidationPolicy is missing ${trigger}`);
    }
  }

  const sourcesObject =
    record.sources && typeof record.sources === "object" && !Array.isArray(record.sources)
      ? record.sources
      : {};
  if (!Object.keys(sourcesObject).length) unverified.push("sources are missing");
  const sources = Object.entries(sourcesObject).map(([sourceId, source]) =>
    validateSource(sourceId, source, baseDir),
  );
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  for (const source of sources) {
    for (const problem of source.problems) {
      unverified.push(`source ${source.sourceId}: ${problem}`);
    }
  }

  const designRequirementRecords = Array.isArray(record.designRequirements)
    ? record.designRequirements
    : [];
  if (!Array.isArray(record.designRequirements)) {
    unverified.push("designRequirements must be an array");
  }
  const requirementById = new Map();
  const designRequirements = [];
  for (const [index, requirement] of designRequirementRecords.entries()) {
    const problems = validateDesignRequirement(requirement);
    const id = nonemptyString(requirement?.id) ? requirement.id.trim() : null;
    if (id && requirementById.has(id)) {
      violations.push(`duplicate design requirement id ${id}`);
    } else if (id) {
      requirementById.set(id, requirement);
    }
    for (const problem of problems) {
      unverified.push(`design requirement ${id || index + 1}: ${problem}`);
    }
    designRequirements.push({ id, valid: problems.length === 0, problems });
  }

  const evidenceParts = Array.isArray(record.parts) ? record.parts : [];
  if (!Array.isArray(record.parts)) unverified.push("parts must be an array");
  const partByReference = new Map();
  for (const part of evidenceParts) {
    const reference = nonemptyString(part?.reference) ? part.reference.trim() : "";
    if (!reference) {
      unverified.push("part evidence has no reference");
      continue;
    }
    if (partByReference.has(reference)) {
      violations.push(`duplicate component evidence for ${reference}`);
      continue;
    }
    partByReference.set(reference, part);
  }

  const liveComponents = (raw.components || []).filter(
    (component) => component.addIntoPcb !== false,
  );
  const liveReferences = new Set(liveComponents.map((component) => component.designator));
  const partResults = [];
  const parameterMaps = new Map();
  const coverageCheckIdsByReference = new Map();
  for (const component of liveComponents) {
    const reference = component.designator || "<missing-designator>";
    const part = partByReference.get(reference);
    const problems = [];
    if (!part) {
      unverified.push(`component ${reference} has no selection evidence`);
      partResults.push({ reference, valid: false, problems: ["selection evidence missing"] });
      continue;
    }
    if (!nonemptyString(part.manufacturer)) problems.push("manufacturer is missing");
    if (!nonemptyString(part.manufacturerPartNumber)) {
      problems.push("manufacturerPartNumber is missing");
    }
    if (!ACCEPTED_CRITICALITIES.has(part.criticality)) {
      problems.push("criticality is missing or unknown");
    }
    if (!ACCEPTED_DISPOSITIONS.has(part.disposition)) {
      problems.push("disposition is missing or unknown");
    }
    if (!nonemptyString(part.functionClass)) {
      problems.push("functionClass is missing");
    }
    if (!nonemptyString(part.package)) problems.push("package is missing");
    if (!nonemptyString(part.footprint)) problems.push("footprint is missing");

    const liveMpn = normalizedPartNumber(component.manufacturerPartNumber);
    const evidenceMpn = normalizedPartNumber(part.manufacturerPartNumber);
    if (!liveMpn) {
      problems.push("live EasyEDA component has no manufacturer part number");
    } else if (evidenceMpn && liveMpn !== evidenceMpn) {
      violations.push(
        `component ${reference} manufacturer part number differs between EasyEDA and evidence`,
      );
    }
    if (
      nonemptyString(component.manufacturer) &&
      nonemptyString(part.manufacturer) &&
      component.manufacturer.trim().toUpperCase() !==
        part.manufacturer.trim().toUpperCase()
    ) {
      violations.push(
        `component ${reference} manufacturer differs between EasyEDA and evidence`,
      );
    }
    const liveFootprintName = component.footprint?.name || component.footprint?.uuid;
    if (
      nonemptyString(liveFootprintName) &&
      nonemptyString(part.footprint) &&
      liveFootprintName.trim().toUpperCase() !== part.footprint.trim().toUpperCase()
    ) {
      violations.push(
        `component ${reference} footprint differs between EasyEDA and evidence`,
      );
    }

    const sourceIds = new Set(Array.isArray(part.sourceIds) ? part.sourceIds : []);
    if (!sourceIds.size) problems.push("sourceIds are missing");
    for (const sourceId of sourceIds) {
      if (!sourceById.has(sourceId)) problems.push(`sourceId ${sourceId} is unknown`);
      else if (!sourceById.get(sourceId).valid) {
        problems.push(`sourceId ${sourceId} is not verified`);
      }
      const sourceRecord = sourcesObject[sourceId];
      const coveredPartNumbers = Array.isArray(
        sourceRecord?.contentVerification?.coveredPartNumbers,
      )
        ? sourceRecord.contentVerification.coveredPartNumbers.map(normalizedPartNumber)
        : [];
      if (evidenceMpn && !coveredPartNumbers.includes(evidenceMpn)) {
        problems.push(`sourceId ${sourceId} does not record coverage of the exact MPN`);
      }
    }
    if (!Array.isArray(part.requirements) || !part.requirements.length) {
      problems.push("requirements are missing");
    } else {
      for (const [index, requirement] of part.requirements.entries()) {
        for (const problem of validateRequirement(requirement, sourceIds)) {
          problems.push(`requirement ${index + 1}: ${problem}`);
        }
      }
    }

    const parameterById = new Map();
    if (!Array.isArray(part.parameters) || !part.parameters.length) {
      problems.push("numeric sourced parameters are missing");
    } else {
      for (const [index, parameter] of part.parameters.entries()) {
        const parameterProblems = validateParameter(parameter, sourceIds);
        const parameterId = nonemptyString(parameter?.id)
          ? parameter.id.trim()
          : null;
        if (parameterId && parameterById.has(parameterId)) {
          violations.push(`component ${reference} has duplicate parameter id ${parameterId}`);
        } else if (parameterId) {
          parameterById.set(parameterId, parameter);
        }
        for (const problem of parameterProblems) {
          problems.push(`parameter ${parameterId || index + 1}: ${problem}`);
        }
      }
    }
    parameterMaps.set(reference, parameterById);
    const parameterCoverage = validateParameterCoverage(part, parameterById);
    for (const problem of parameterCoverage.problems) {
      problems.push(`parameter coverage: ${problem}`);
    }
    for (const violation of parameterCoverage.violations) {
      violations.push(`component ${reference}: ${violation}`);
    }
    coverageCheckIdsByReference.set(reference, parameterCoverage.checkIds);

    const libraryBinding = validateLibraryBinding(part, baseDir);
    for (const problem of libraryBinding.problems) {
      problems.push(`library binding: ${problem}`);
    }
    for (const violation of libraryBinding.violations) {
      violations.push(`component ${reference}: ${violation}`);
    }
    if (libraryBinding.blocked) {
      problems.push("library binding is BLOCKED; exact device creation or approved substitution is unresolved");
    }
    const liveFootprintUuid = component.footprint?.uuid;
    const recordedFootprintUuid = part.libraryBinding?.footprintUuid;
    if (
      nonemptyString(liveFootprintUuid) &&
      nonemptyString(recordedFootprintUuid) &&
      liveFootprintUuid !== recordedFootprintUuid
    ) {
      violations.push(
        `component ${reference} live footprint UUID differs from libraryBinding`,
      );
    }
    const liveFootprintLibraryUuid = component.footprint?.libraryUuid;
    const recordedFootprintLibraryUuid = part.libraryBinding?.footprintLibraryUuid;
    if (
      nonemptyString(liveFootprintLibraryUuid) &&
      nonemptyString(recordedFootprintLibraryUuid) &&
      liveFootprintLibraryUuid !== recordedFootprintLibraryUuid
    ) {
      violations.push(
        `component ${reference} live footprint library UUID differs from libraryBinding`,
      );
    }

    const suitability = part.suitability;
    if (!suitability || typeof suitability !== "object" || Array.isArray(suitability)) {
      problems.push("suitability closure is missing");
    } else {
      if (!Array.isArray(suitability.checkIds)) {
        problems.push("suitability.checkIds must be an array");
      }
      if (!Array.isArray(suitability.unresolved)) {
        problems.push("suitability.unresolved must be an array");
      } else if (suitability.unresolved.length) {
        problems.push(
          `suitability has unresolved items: ${suitability.unresolved.join(", ")}`,
        );
      }
    }
    for (const problem of problems) {
      unverified.push(`component ${reference}: ${problem}`);
    }
    partResults.push({
      reference,
      valid: problems.length === 0 && libraryBinding.violations.length === 0,
      functionClass: part.functionClass || null,
      libraryResolution: part.libraryBinding?.resolution || null,
      suitabilityCheckIds: Array.isArray(part.suitability?.checkIds)
        ? part.suitability.checkIds
        : [],
      parameterCoverage: parameterCoverage.entries,
      problems,
    });
  }

  for (const reference of partByReference.keys()) {
    if (!liveReferences.has(reference)) {
      unverified.push(`component evidence contains stale reference ${reference}`);
    }
  }

  const suitabilityCheckRecords = Array.isArray(record.suitabilityChecks)
    ? record.suitabilityChecks
    : [];
  if (!Array.isArray(record.suitabilityChecks)) {
    unverified.push("suitabilityChecks must be an array");
  }
  const suitabilityCheckById = new Map();
  const suitabilityChecks = [];
  for (const check of suitabilityCheckRecords) {
    const result = evaluateSuitabilityCheck(
      check,
      requirementById,
      partByReference,
      parameterMaps,
    );
    if (result.id && suitabilityCheckById.has(result.id)) {
      violations.push(`duplicate suitability check id ${result.id}`);
    } else if (result.id) {
      suitabilityCheckById.set(result.id, result);
    }
    for (const problem of result.problems) {
      unverified.push(`suitability check ${result.id || "<missing>"}: ${problem}`);
    }
    violations.push(...result.violations);
    suitabilityChecks.push(result);
  }

  const referencedSuitabilityCheckIds = new Set();
  for (const partResult of partResults) {
    const part = partByReference.get(partResult.reference);
    if (!part) continue;
    const checkIds = Array.isArray(part.suitability?.checkIds)
      ? part.suitability.checkIds
      : [];
    const coverageCheckIds = coverageCheckIdsByReference.get(partResult.reference) ||
      new Set();
    for (const checkId of checkIds) {
      if (nonemptyString(checkId)) referencedSuitabilityCheckIds.add(checkId);
      if (!coverageCheckIds.has(checkId)) {
        unverified.push(
          `component ${partResult.reference}: suitability check ${checkId} is not classified by parameterCoverage`,
        );
        partResult.valid = false;
      }
    }
    for (const checkId of coverageCheckIds) {
      if (!checkIds.includes(checkId)) {
        unverified.push(
          `component ${partResult.reference}: parameterCoverage check ${checkId} is absent from suitability.checkIds`,
        );
        partResult.valid = false;
      }
    }
    const mustCloseSuitability =
      part.disposition === "POPULATE" && part.criticality === "CRITICAL";
    if (mustCloseSuitability && !checkIds.length) {
      unverified.push(
        `component ${partResult.reference}: critical populated part has no suitability checks`,
      );
      partResult.valid = false;
    }
    const referencedChecks = [];
    for (const checkId of checkIds) {
      const result = suitabilityCheckById.get(checkId);
      if (!result) {
        unverified.push(
          `component ${partResult.reference}: suitability check ${checkId} is missing`,
        );
        partResult.valid = false;
        continue;
      }
      if (result.partReference !== partResult.reference) {
        violations.push(
          `component ${partResult.reference}: suitability check ${checkId} targets ${result.partReference}`,
        );
        partResult.valid = false;
      }
      if (!result.passed) partResult.valid = false;
      referencedChecks.push(result);
    }
    if (
      part.disposition === "POPULATE" &&
      part.functionClass === "LINEAR_REGULATOR" &&
      !referencedChecks.some((result) => result.type === "LINEAR_REGULATOR_THERMAL")
    ) {
      unverified.push(
        `component ${partResult.reference}: populated linear regulator has no LINEAR_REGULATOR_THERMAL check`,
      );
      partResult.valid = false;
    }
  }
  for (const checkId of suitabilityCheckById.keys()) {
    if (!referencedSuitabilityCheckIds.has(checkId)) {
      unverified.push(`suitability check ${checkId} is stale or unreferenced`);
    }
  }

  const cleared = unverified.length === 0 && violations.length === 0;
  return {
    provided: true,
    cleared,
    decision: violations.length
      ? DECISION_VALUES.FAIL
      : cleared
        ? DECISION_VALUES.PASS_WITH_EXCEPTIONS
        : DECISION_VALUES.UNVERIFIED,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    fingerprint: constraintFingerprint(record),
    binding: {
      projectUuid: binding?.projectUuid || null,
      documentUuid: binding?.documentUuid || null,
      expectedDesignFingerprint: expectedFingerprint,
      recordedDesignFingerprint: binding?.designFingerprint || null,
    },
    sourceCount: sources.length,
    partCount: evidenceParts.length,
    sources,
    designRequirements,
    parts: partResults,
    suitabilityChecks,
    unverified: [...new Set(unverified)],
    violations: [...new Set(violations)],
  };
}

function parseArgs(argv) {
  const options = { record: undefined, designSnapshot: undefined, output: undefined, force: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--record") options.record = next();
    else if (option === "--design-snapshot") options.designSnapshot = next();
    else if (option === "--output") options.output = next();
    else if (option === "--force") options.force = true;
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(
        "Usage: node scripts/lints/component_selection_evidence.mjs --record FILE --design-snapshot FILE [--output FILE] [--force]\n",
      );
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!options.selfTest && (!options.record || !options.designSnapshot)) {
    throw new Error("--record and --design-snapshot are required");
  }
  return options;
}

function selfTestParameterCoverage(overrides = {}) {
  return REQUIRED_PARAMETER_COVERAGE_ASPECTS.map((aspect) => ({
    aspect,
    status: "NOT_APPLICABLE",
    parameterIds: [],
    checkIds: [],
    rationale: "not exercised by this synthetic component fixture",
    ...(overrides[aspect] || {}),
  }));
}

function selfTestRecord(raw, artifactPath, sha256) {
  return {
    schemaVersion: 2,
    schematic: {
      projectUuid: raw.project.uuid,
      documentUuid: raw.document.uuid,
      fingerprintSchemaVersion: DESIGN_FINGERPRINT_SCHEMA_VERSION,
      designFingerprint: designFingerprint(raw),
    },
    invalidationPolicy: [...REQUIRED_INVALIDATION_TRIGGERS],
    sources: {
      mcu: {
        publisher: "Example Semiconductor",
        documentId: "DS-100",
        revision: "1.2",
        canonicalUrl: "https://manufacturer.example/DS-100.pdf",
        retrievedAt: "2026-08-09T00:00:00Z",
        accessStatus: "AVAILABLE_VERIFIED",
        authority: "MANUFACTURER_PRIMARY",
        artifactPath,
        sha256,
        mediaType: "application/pdf",
        contentVerification: {
          status: "VERIFIED",
          method: "VISUAL_REVIEW",
          exactPartMatch: true,
          revisionMatch: true,
          observedDocumentId: "DS-100",
          observedRevision: "1.2",
          coveredPartNumbers: ["EXAMPLE-MCU-1"],
          location: "cover + section 4",
          reviewedAt: "2026-08-09T00:05:00Z",
          reviewer: "self-test",
        },
      },
    },
    designRequirements: [
      {
        id: "rail_min_v",
        name: "minimum operating rail",
        value: 3.0,
        unit: "V",
        conditions: "normal operation",
        basis: {
          kind: "REQUIREMENTS_BASELINE",
          reference: "self-test baseline rail_min_v",
          fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
      {
        id: "rail_max_v",
        name: "maximum operating rail",
        value: 3.6,
        unit: "V",
        conditions: "normal operation",
        basis: {
          kind: "REQUIREMENTS_BASELINE",
          reference: "self-test baseline rail_max_v",
          fingerprint: `sha256:${"a".repeat(64)}`,
        },
      },
      {
        id: "flash_min_mb",
        name: "minimum flash capacity",
        value: 4,
        unit: "MB",
        conditions: "production firmware image",
        basis: { kind: "USER_CONFIRMED", reference: "self-test user confirmation" },
      },
    ],
    parts: [
      {
        reference: "U1",
        manufacturer: "Example Semiconductor",
        manufacturerPartNumber: "EXAMPLE-MCU-1",
        package: "LQFP48",
        footprint: "LQFP48",
        criticality: "CRITICAL",
        disposition: "POPULATE",
        functionClass: "MICROCONTROLLER",
        sourceIds: ["mcu"],
        requirements: [
          {
            name: "supply voltage",
            value: "3.3 V",
            sourceId: "mcu",
            location: "section 4.1",
            derivation: "direct datasheet limit",
          },
        ],
        parameters: [
          {
            id: "supply_min_v",
            name: "minimum supply voltage",
            value: 2.7,
            unit: "V",
            conditions: "recommended operating conditions",
            sourceId: "mcu",
            location: "section 4.1",
          },
          {
            id: "supply_max_v",
            name: "maximum supply voltage",
            value: 3.6,
            unit: "V",
            conditions: "recommended operating conditions",
            sourceId: "mcu",
            location: "section 4.1",
          },
          {
            id: "flash_mb",
            name: "flash capacity",
            value: 4,
            unit: "MB",
            conditions: "ordered device variant",
            sourceId: "mcu",
            location: "ordering information",
          },
        ],
        libraryBinding: {
          resolution: "EXACT_LIBRARY_DEVICE",
          substitutionPolicy: "FORBID",
          requestedManufacturerPartNumber: "EXAMPLE-MCU-1",
          selectedManufacturerPartNumber: "EXAMPLE-MCU-1",
          deviceUuid: "device-u1",
          symbolUuid: "symbol-u1",
          footprintUuid: "footprint-u1",
        },
        parameterCoverage: selfTestParameterCoverage({
          FUNCTIONAL_CAPABILITY: {
            status: "AUDITED",
            parameterIds: ["flash_mb"],
            checkIds: ["u1_flash_capacity"],
            rationale: "flash capacity is required by the production firmware",
          },
          ELECTRICAL_LIMITS: {
            status: "AUDITED",
            parameterIds: ["supply_min_v", "supply_max_v"],
            checkIds: ["u1_supply_range"],
            rationale: "the complete project rail range must be supported",
          },
        }),
        suitability: {
          checkIds: ["u1_supply_range", "u1_flash_capacity"],
          unresolved: [],
        },
      },
    ],
    suitabilityChecks: [
      {
        id: "u1_supply_range",
        type: "PARAMETER_RANGE_CONTAINS",
        partReference: "U1",
        parameterMinimumId: "supply_min_v",
        parameterMaximumId: "supply_max_v",
        requirementMinimumId: "rail_min_v",
        requirementMaximumId: "rail_max_v",
      },
      {
        id: "u1_flash_capacity",
        type: "PARAMETER_AT_LEAST",
        partReference: "U1",
        parameterId: "flash_mb",
        requirementId: "flash_min_mb",
      },
    ],
  };
}

function linearRegulatorSelfTestRecord(raw, artifactPath, sha256) {
  const record = selfTestRecord(raw, artifactPath, sha256);
  record.sources.mcu.documentId = "LDO-200";
  record.sources.mcu.contentVerification.observedDocumentId = "LDO-200";
  record.sources.mcu.contentVerification.coveredPartNumbers = ["EXAMPLE-LDO-1"];
  record.designRequirements = [
    ["vin_min_v", "minimum input voltage", 4.75, "V"],
    ["vin_max_v", "maximum input voltage", 5.25, "V"],
    ["vout_v", "regulated output voltage", 3.3, "V"],
    ["load_cont_a", "continuous output current", 0.1, "A"],
    ["load_peak_a", "peak output current", 0.3, "A"],
    ["ambient_max_c", "maximum local ambient", 50, "degC"],
    ["tj_margin_c", "minimum junction margin", 25, "degC"],
  ].map(([id, name, value, unit]) => ({
    id,
    name,
    value,
    unit,
    conditions: "worst-case design envelope",
    basis: { kind: "DERIVED_CALCULATION", reference: "self-test power budget" },
  }));
  record.parts = [
    {
      reference: "U2",
      manufacturer: "Example Semiconductor",
      manufacturerPartNumber: "EXAMPLE-LDO-1",
      package: "SOT23-5",
      footprint: "SOT23-5",
      criticality: "CRITICAL",
      disposition: "POPULATE",
      functionClass: "LINEAR_REGULATOR",
      sourceIds: ["mcu"],
      requirements: [
        {
          name: "output current rating",
          value: "0.6 A",
          sourceId: "mcu",
          location: "electrical characteristics",
          derivation: "direct datasheet rating",
        },
      ],
      parameters: [
        ["rated_a", "rated output current", 0.6, "A"],
        ["dropout_v", "maximum dropout voltage", 0.25, "V"],
        ["theta_ja", "junction-to-ambient thermal resistance", 100, "degC/W"],
        ["tj_max", "maximum junction temperature", 150, "degC"],
        ["iq_max_a", "maximum quiescent current", 0.00009, "A"],
      ].map(([id, name, value, unit]) => ({
        id,
        name,
        value,
        unit,
        conditions: "datasheet worst case for selected package unless noted",
        sourceId: "mcu",
        location: "electrical and thermal characteristics",
      })),
      libraryBinding: {
        resolution: "EXACT_LIBRARY_DEVICE",
        substitutionPolicy: "FORBID",
        requestedManufacturerPartNumber: "EXAMPLE-LDO-1",
        selectedManufacturerPartNumber: "EXAMPLE-LDO-1",
        deviceUuid: "device-u2",
        symbolUuid: "symbol-u2",
        footprintUuid: "footprint-u2",
      },
      parameterCoverage: selfTestParameterCoverage({
        ELECTRICAL_LIMITS: {
          status: "AUDITED",
          parameterIds: ["rated_a", "dropout_v"],
          checkIds: ["u2_ldo_thermal"],
          rationale: "rated current and dropout must cover the load envelope",
        },
        OPERATING_RANGE: {
          status: "AUDITED",
          parameterIds: ["dropout_v"],
          checkIds: ["u2_ldo_thermal"],
          rationale: "minimum input headroom must cover worst-case dropout",
        },
        POWER_THERMAL: {
          status: "AUDITED",
          parameterIds: ["theta_ja", "tj_max", "iq_max_a"],
          checkIds: ["u2_ldo_thermal"],
          rationale: "worst-case dissipation and junction temperature must pass",
        },
      }),
      suitability: { checkIds: ["u2_ldo_thermal"], unresolved: [] },
    },
  ];
  record.suitabilityChecks = [
    {
      id: "u2_ldo_thermal",
      type: "LINEAR_REGULATOR_THERMAL",
      partReference: "U2",
      requirementIds: {
        inputVoltageMinimumV: "vin_min_v",
        inputVoltageMaximumV: "vin_max_v",
        outputVoltageV: "vout_v",
        continuousOutputCurrentA: "load_cont_a",
        peakOutputCurrentA: "load_peak_a",
        ambientMaximumC: "ambient_max_c",
        minimumJunctionMarginC: "tj_margin_c",
      },
      parameterIds: {
        ratedOutputCurrentA: "rated_a",
        dropoutVoltageMaximumV: "dropout_v",
        thetaJaCPerW: "theta_ja",
        maximumJunctionTemperatureC: "tj_max",
        quiescentCurrentMaximumA: "iq_max_a",
      },
    },
  ];
  return record;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "easyeda-component-evidence-"));
      try {
        const artifactPath = path.join(tempDir, "datasheet.pdf");
        const content = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
        writeFileSync(artifactPath, content);
        const raw = {
          kind: "schematic",
          project: { uuid: "project" },
          document: { uuid: "schematic" },
          components: [
            {
              designator: "U1",
              primitiveId: "u1",
              manufacturer: "Example Semiconductor",
              manufacturerPartNumber: "EXAMPLE-MCU-1",
              addIntoPcb: true,
              footprint: { name: "LQFP48" },
            },
          ],
        };
        const record = selfTestRecord(raw, artifactPath, sha256Buffer(content));
        const valid = validateComponentEvidenceRecord(record, raw, { baseDir: tempDir });
        const blockedRecord = structuredClone(record);
        blockedRecord.sources.mcu.accessStatus = "ACCESS_BLOCKED";
        const blocked = validateComponentEvidenceRecord(blockedRecord, raw, { baseDir: tempDir });
        const wrongPart = structuredClone(record);
        wrongPart.parts[0].manufacturerPartNumber = "WRONG-PART";
        const mismatch = validateComponentEvidenceRecord(wrongPart, raw, { baseDir: tempDir });
        const failedRequirement = structuredClone(record);
        failedRequirement.designRequirements.find(
          (requirement) => requirement.id === "flash_min_mb",
        ).value = 8;
        const inadequate = validateComponentEvidenceRecord(failedRequirement, raw, {
          baseDir: tempDir,
        });
        const incompleteCoverageRecord = structuredClone(record);
        incompleteCoverageRecord.parts[0].parameterCoverage =
          incompleteCoverageRecord.parts[0].parameterCoverage.filter(
            (coverage) => coverage.aspect !== "ENVIRONMENT_RELIABILITY",
          );
        const incompleteCoverage = validateComponentEvidenceRecord(
          incompleteCoverageRecord,
          raw,
          { baseDir: tempDir },
        );
        const unclassifiedParameterRecord = structuredClone(record);
        unclassifiedParameterRecord.parts[0].parameters.push({
          id: "unclassified_limit",
          name: "unclassified synthetic limit",
          value: 1,
          unit: "count",
          conditions: "synthetic negative fixture",
          sourceId: "mcu",
          location: "section 4",
        });
        const unclassifiedParameter = validateComponentEvidenceRecord(
          unclassifiedParameterRecord,
          raw,
          { baseDir: tempDir },
        );
        const unauditedUsedPartRecord = structuredClone(record);
        for (const coverage of unauditedUsedPartRecord.parts[0].parameterCoverage) {
          if (coverage.status === "AUDITED") {
            coverage.status = "RECORDED";
            coverage.checkIds = [];
          }
        }
        unauditedUsedPartRecord.parts[0].suitability.checkIds = [];
        unauditedUsedPartRecord.suitabilityChecks = [];
        const unauditedUsedPart = validateComponentEvidenceRecord(
          unauditedUsedPartRecord,
          raw,
          { baseDir: tempDir },
        );

        const rawLdo = {
          ...raw,
          components: [
            {
              designator: "U2",
              primitiveId: "u2",
              manufacturer: "Example Semiconductor",
              manufacturerPartNumber: "EXAMPLE-LDO-1",
              addIntoPcb: true,
              footprint: { name: "SOT23-5" },
            },
          ],
        };
        const ldoRecord = linearRegulatorSelfTestRecord(
          rawLdo,
          artifactPath,
          sha256Buffer(content),
        );
        const ldoPass = validateComponentEvidenceRecord(ldoRecord, rawLdo, {
          baseDir: tempDir,
        });
        const hotLdoRecord = structuredClone(ldoRecord);
        hotLdoRecord.designRequirements.find(
          (requirement) => requirement.id === "load_cont_a",
        ).value = 0.5;
        hotLdoRecord.designRequirements.find(
          (requirement) => requirement.id === "load_peak_a",
        ).value = 0.5;
        hotLdoRecord.designRequirements.find(
          (requirement) => requirement.id === "ambient_max_c",
        ).value = 85;
        const ldoFail = validateComponentEvidenceRecord(hotLdoRecord, rawLdo, {
          baseDir: tempDir,
        });

        const comparisonPath = path.join(tempDir, "substitution-comparison.json");
        writeFileSync(comparisonPath, "{}\n");
        const substituteRecord = structuredClone(record);
        substituteRecord.parts[0].libraryBinding = {
          resolution: "APPROVED_SUBSTITUTE",
          substitutionPolicy: "ALLOW_FORM_FIT_FUNCTION",
          requestedManufacturerPartNumber: "EXAMPLE-MCU-ORIGINAL",
          selectedManufacturerPartNumber: "EXAMPLE-MCU-1",
          deviceUuid: "device-u1",
          symbolUuid: "symbol-u1",
          footprintUuid: "footprint-u1",
          reason: "original exact device unavailable in the approved library",
          approvalReference: "USER-APPROVAL-SELF-TEST",
          candidateComparisonArtifact: comparisonPath,
          comparison: Object.fromEntries(
            REQUIRED_SUBSTITUTION_COMPARISONS.map((field) => [field, "MATCH"]),
          ),
        };
        const substitutePass = validateComponentEvidenceRecord(substituteRecord, raw, {
          baseDir: tempDir,
        });
        const forbiddenSubstitute = structuredClone(substituteRecord);
        forbiddenSubstitute.parts[0].libraryBinding.substitutionPolicy = "FORBID";
        const substituteFail = validateComponentEvidenceRecord(forbiddenSubstitute, raw, {
          baseDir: tempDir,
        });
        const legacyRecord = structuredClone(record);
        legacyRecord.schemaVersion = 1;
        const legacy = validateComponentEvidenceRecord(legacyRecord, raw, {
          baseDir: tempDir,
        });
        if (
          !valid.cleared ||
          blocked.cleared ||
          mismatch.cleared ||
          !mismatch.violations.length ||
          inadequate.decision !== DECISION_VALUES.FAIL ||
          incompleteCoverage.decision !== DECISION_VALUES.UNVERIFIED ||
          unclassifiedParameter.decision !== DECISION_VALUES.UNVERIFIED ||
          unauditedUsedPart.decision !== DECISION_VALUES.UNVERIFIED ||
          !ldoPass.cleared ||
          ldoFail.decision !== DECISION_VALUES.FAIL ||
          !substitutePass.cleared ||
          substituteFail.decision !== DECISION_VALUES.FAIL ||
          legacy.decision !== DECISION_VALUES.UNVERIFIED
        ) {
          throw new Error("component evidence self-test produced unexpected results");
        }
        process.stdout.write(
          `${JSON.stringify(
            {
              valid: valid.cleared,
              blocked: blocked.cleared,
              mismatch: mismatch.cleared,
              inadequate: inadequate.decision,
              incompleteCoverage: incompleteCoverage.decision,
              unclassifiedParameter: unclassifiedParameter.decision,
              unauditedUsedPart: unauditedUsedPart.decision,
              ldoPass: ldoPass.cleared,
              ldoFail: ldoFail.decision,
              substitutePass: substitutePass.cleared,
              substituteFail: substituteFail.decision,
              legacy: legacy.decision,
            },
            null,
            2,
          )}\n`,
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
      return;
    }
    const recordPath = path.resolve(options.record);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const raw = JSON.parse(await readFile(options.designSnapshot, "utf8"));
    const result = validateComponentEvidenceRecord(record, raw, {
      baseDir: path.dirname(recordPath),
    });
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) {
      const outputPath = resolveSafeOutputPath(options.output, { force: options.force });
      await writeFile(outputPath, serialized, "utf8");
    }
    process.stdout.write(serialized);
    process.exitCode = applyDecisionExitCode(result.decision);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}

export {
  ACCEPTED_AUTHORITIES,
  ACCESS_STATUSES,
  REQUIRED_INVALIDATION_TRIGGERS,
  REQUIRED_PARAMETER_COVERAGE_ASPECTS,
  evaluateSuitabilityCheck,
  parseArgs,
  sha256Buffer,
  validateArtifact,
  validateComponentEvidenceRecord,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

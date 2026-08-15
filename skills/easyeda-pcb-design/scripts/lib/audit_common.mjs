#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  FAIL: 2,
  UNVERIFIED: 3,
  PASS_WITH_EXCEPTIONS: 4,
});

const DECISION_VALUES = Object.freeze({
  PASS_WITH_EXCEPTIONS: "PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS",
  FAIL: "FAIL",
  UNVERIFIED: "UNVERIFIED FOR FABRICATION",
});
const DESIGN_FINGERPRINT_SCHEMA_VERSION = 6;

const DEFAULT_BRIDGE_PORTS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => 49620 + index),
);

const ATTEST_LINE_RE =
  /^\s*I ATTEST EVIDENCE FOR PCB REVISION:\s*(\S.+?)\s*$/im;

const COMPLETION_TEMPLATE = `## Audit completion (required format)

Decision: <PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS | FAIL | UNVERIFIED FOR FABRICATION>
fabricationRelease: false
manufacturingOutputsReviewed: <true|false>
notAFabricationRelease: This result is NOT authorization to fabricate or place a PCB order.
Companion: <ready|missing> (easyeda-api + easyeda-bridge)
High-speed: <not-applicable | required-and-cleared | required-and-missing | ran>
Assumptions/exceptions: <none | list>
Next step: <concrete action>
`;

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateNetlistCompareExceptionArtifact(artifact, artifactPath) {
  const commonValid =
    artifact?.kind === "easyeda-manufacturing-netlist-comparison" &&
    artifact?.comparison?.match === true &&
    artifact?.manufacturingDecision === "MATCH" &&
    artifact?.fabricationRelease === false &&
    nonemptyString(artifact?.project?.uuid) &&
    nonemptyString(artifact?.schematic?.uuid) &&
    nonemptyString(artifact?.pcb?.uuid);
  if (!commonValid) {
    throw new Error(
      "netlist comparison report must prove manufacturing MATCH, comparison.match=true, exact project/schematic/PCB UUIDs, and fabricationRelease=false",
    );
  }

  const literalMatch = artifact.decision === "MATCH";
  const verifiedCacheException =
    artifact.decision === "MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION" &&
    artifact?.nativeCacheException?.status === "VERIFIED" &&
    Array.isArray(artifact?.nativeCacheException?.issues) &&
    artifact.nativeCacheException.issues.length === 0 &&
    artifact?.pcbDataPlaneIntegrity?.match === true &&
    Array.isArray(artifact?.nativeFileComparison) &&
    artifact.nativeFileComparison.length === 0;
  if (!literalMatch && !verifiedCacheException) {
    throw new Error(
      "netlist comparison report must be literal MATCH or satisfy the complete verified native-cache-exception contract",
    );
  }

  return {
    reason: literalMatch
      ? "strict netlist comparison reported literal MATCH"
      : artifact.nativeCacheException.interpretation,
    artifactPath,
    artifact: {
      kind: artifact.kind,
      decision: artifact.decision,
      manufacturingDecision: artifact.manufacturingDecision,
      projectUuid: artifact.project.uuid,
      schematicUuid: artifact.schematic.uuid,
      pcbUuid: artifact.pcb.uuid,
      comparisonMatch: true,
      pcbDataPlaneMatch: artifact?.pcbDataPlaneIntegrity?.match ?? null,
      nativeFileComparisonDifferenceCount:
        Array.isArray(artifact?.nativeFileComparison)
          ? artifact.nativeFileComparison.length
          : null,
      nativeCacheExceptionStatus:
        artifact?.nativeCacheException?.status || null,
    },
  };
}

function freeCopperPrimitiveIds(drcLeaves = []) {
  const ids = [];
  for (const item of drcLeaves) {
    if (
      item?.isFree !== true &&
      item?.explanation?.param?.type !== "ConnectError" &&
      item?.explanation?.errData?.errorType !== "No Connection"
    ) {
      continue;
    }
    if (Array.isArray(item.objs)) ids.push(...item.objs);
    else if (nonemptyString(item.objs)) ids.push(item.objs);
    ids.push(item?.explanation?.errData?.obj1);
  }
  return new Set(ids.filter(nonemptyString));
}

function analyzePourConnectivity(pour = {}, freeCopperIds = new Set()) {
  const solidFillIds = [
    ...new Set(
      (Array.isArray(pour.solidFillIds) ? pour.solidFillIds : []).filter(
        nonemptyString,
      ),
    ),
  ];
  const solidFillCount = Number.isFinite(Number(pour.solidFillCount))
    ? Number(pour.solidFillCount)
    : 0;
  const fillCount = Number.isFinite(Number(pour.fillCount))
    ? Number(pour.fillCount)
    : 0;
  const freeSolidFillIds = solidFillIds.filter((id) => freeCopperIds.has(id));
  const connectedSolidFillIds = solidFillIds.filter(
    (id) => !freeCopperIds.has(id),
  );
  const solidFillIdCoverageComplete =
    solidFillCount > 0 &&
    fillCount >= solidFillCount &&
    solidFillIds.length === solidFillCount;
  const fillConnectivityProven =
    solidFillIdCoverageComplete && freeSolidFillIds.length === 0;
  let islandStatus = "CONNECTED_BY_FILL_ID_AND_DRC";
  if (!pour.hasCopper) islandStatus = "NO_GENERATED_COPPER";
  else if (fillCount <= 0) islandStatus = "NO_GENERATED_FILL_RECORDS";
  else if (solidFillCount <= 0) islandStatus = "NO_SOLID_FILL";
  else if (!solidFillIdCoverageComplete) {
    islandStatus = "UNVERIFIED_SOLID_FILL_ID_COVERAGE";
  } else if (freeSolidFillIds.length) islandStatus = "FREE_COPPER_DETECTED";
  const passed = Boolean(
    pour.hasCopper &&
      fillCount > 0 &&
      solidFillCount > 0 &&
      fillConnectivityProven,
  );
  return {
    ...pour,
    fillCount,
    solidFillCount,
    solidFillIds,
    connectedSolidFillIds,
    freeSolidFillIds,
    solidFillIdCoverageComplete,
    fillConnectivityProven,
    islandStatus,
    preserveSilosStateIgnored: Boolean(
      passed && pour.preserveSilos && fillConnectivityProven,
    ),
    passed,
  };
}

function resolveSafeOutputPath(output, { force = false, cwd = process.cwd() } = {}) {
  if (!nonemptyString(output)) {
    throw new Error("--output requires a non-empty relative path");
  }
  if (path.isAbsolute(output)) {
    throw new Error("--output must be a relative path under the current working directory");
  }
  const resolved = path.resolve(cwd, output);
  const root = path.resolve(cwd);
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("--output escapes the current working directory");
  }
  if (existsSync(resolved) && !force) {
    throw new Error(`--output file already exists (use --force to overwrite): ${output}`);
  }
  return resolved;
}

function evidenceArtifactCandidate(value) {
  if (!value || typeof value !== "object") return undefined;
  if (nonemptyString(value.artifactPath)) return value.artifactPath.trim();
  if (nonemptyString(value.artifact)) return value.artifact.trim();
  return undefined;
}

function existingArtifactPath(candidate, { cwd = process.cwd() } = {}) {
  if (!nonemptyString(candidate)) return undefined;
  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(cwd, candidate);
  try {
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    accessSync(resolved, fsConstants.R_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * Human attestation is accepted only when ALL are true:
 * 1. caller requested attestation (--user-attested-evidence)
 * 2. env EASYEDA_AUDIT_USER_ATTEST is exactly YES (human shell; agents must not set it)
 * 3. --attest-file exists and contains: I ATTEST EVIDENCE FOR PCB REVISION: <id>
 *
 * Agents must never create the attest file or export the env var.
 */
function resolveHumanAttestation(options = {}, env = process.env) {
  const requested = Boolean(options.userAttestedEvidence);
  if (!requested) {
    return {
      accepted: false,
      requested: false,
      reason: "attestation not requested",
    };
  }
  const envValue = env.EASYEDA_AUDIT_USER_ATTEST;
  if (envValue !== "YES") {
    return {
      accepted: false,
      requested: true,
      reason:
        "--user-attested-evidence requires human env EASYEDA_AUDIT_USER_ATTEST=YES (agents must not set this)",
    };
  }
  if (!nonemptyString(options.attestFile)) {
    return {
      accepted: false,
      requested: true,
      reason:
        "--user-attested-evidence requires --attest-file written by the human operator",
    };
  }
  const resolved = path.isAbsolute(options.attestFile)
    ? path.resolve(options.attestFile)
    : path.resolve(options.cwd || process.cwd(), options.attestFile);
  if (!existsSync(resolved)) {
    return {
      accepted: false,
      requested: true,
      reason: `attest file not found: ${options.attestFile}`,
    };
  }
  let text;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (error) {
    return {
      accepted: false,
      requested: true,
      reason: `unable to read attest file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const match = text.match(ATTEST_LINE_RE);
  if (!match) {
    return {
      accepted: false,
      requested: true,
      reason:
        'attest file must contain a line: I ATTEST EVIDENCE FOR PCB REVISION: <revision-id>',
    };
  }
  return {
    accepted: true,
    requested: true,
    reason: "human attestation accepted",
    revision: match[1].trim(),
    attestFile: resolved,
  };
}

function evidenceMeetsGate(entry, acceptedStatuses, options = {}) {
  const attestationAccepted = Boolean(options.humanAttestation?.accepted);
  if (nonemptyString(entry)) {
    return Boolean(attestationAccepted && acceptedStatuses.has(entry.trim()));
  }
  if (!entry || typeof entry !== "object") return false;
  const status = nonemptyString(entry.status) ? entry.status.trim() : undefined;
  if (!status || !acceptedStatuses.has(status)) return false;
  const artifact = existingArtifactPath(evidenceArtifactCandidate(entry), options);
  if (artifact) return true;
  const source =
    entry.source || entry.reference || entry.artifact || entry.artifactPath;
  return Boolean(attestationAccepted && nonemptyString(source));
}

const HIGH_RISK_INTERFACE_RE =
  /usb[\s_-]*3|pci[\s_-]*e(?:xpress)?|ddr[2345]|gddr|hdmi|serdes|sata|thunderbolt|display[\s_-]*port|mipi[\s_-]*(?:csi|dsi)|multi[\s_-]*gig|gen[\s_-]*[3-9]|(?:2\.5|5|10|25|40|56|100|112)[\s_-]*g(?:be|bps)?/i;
const HIGH_RISK_REQUIREMENT_RE =
  /s[\s_-]*parameters?|eye[\s_-]*mask|insertion[\s_-]*loss|return[\s_-]*loss|crosstalk|field[\s_-]*solver|tdr|vna/i;
const RF_INTERFACE_RE =
  /(?:^|[\s_-])(?:rf|antenna|radio|microwave|mmwave)(?:$|[\s_-])|(?:\d+(?:\.\d+)?)\s*ghz/i;

function highRiskInterfaceReasons(interfaces = []) {
  const reasons = [];
  for (const item of interfaces) {
    if (!item || typeof item !== "object") continue;
    const name = nonemptyString(item.name) ? item.name : "<unnamed>";
    if (HIGH_RISK_INTERFACE_RE.test(name)) {
      reasons.push(`interface ${name} matches a high-risk SI name profile`);
    }
    if (Number.isFinite(item.dataRateGbps) && item.dataRateGbps >= 1) {
      reasons.push(
        `interface ${name} dataRateGbps=${item.dataRateGbps} is treated as high-risk SI`,
      );
    }
    const source = `${item.requirementsSource || ""}`;
    if (HIGH_RISK_INTERFACE_RE.test(source)) {
      reasons.push(
        `interface ${name} requirementsSource matches a high-risk SI profile`,
      );
    }
    const requirementText = [
      item.requirementsSource,
      item.validationRequirement,
      item.complianceRequirement,
      item.notes,
    ]
      .filter(nonemptyString)
      .join(" ");
    if (HIGH_RISK_REQUIREMENT_RE.test(requirementText)) {
      reasons.push(`interface ${name} requires solver or measurement evidence`);
    }
    if (
      item.rfLaunch === true ||
      item.denseBgaEscape === true ||
      item.denseViaField === true
    ) {
      reasons.push(`interface ${name} declares a high-risk launch or escape`);
    }
    if (
      (Number.isFinite(item.frequencyGhz) && item.frequencyGhz > 0) ||
      RF_INTERFACE_RE.test(`${name} ${source}`)
    ) {
      reasons.push(`interface ${name} matches an RF/high-frequency profile`);
    }
  }
  return [...new Set(reasons)];
}

const HIGH_SPEED_SIDEBAND_RE =
  /(?:^|[_\s-])(?:CEC|HPD|DDC|SCL|SDA|RST|RESET|PERST|WAKE|CLKREQ|PRESENT|PRSNT|SMB|JTAG|EN|ENABLE|LED|VBUS|CC[12]?)(?:$|[_\s-])/i;
const HIGH_RISK_NET_RE =
  /(?:^|[_\s-])(?:RF|ANT|ANTENNA|SERDES|JESD|CML|XAUI)(?:$|[_\s-])/i;
const DEFINITE_HIGH_SPEED_NET_RE =
  /USB[\s_-]*(?:DP|DM)|USB[\s_-]*3|USB[\s_-]*SS|SS[RT]X|PCI[\s_-]*E.*(?:RX|TX|REFCLK)|HDMI.*(?:TMDS|RX|TX|CLK|DATA)|DDR[2345].*(?:DQ|DQS|CLK|CK|ADDR|CMD)|MIPI[\s_-]*(?:CSI|DSI|CK|CLK|D\d)|LVDS.*(?:[PN]|RX|TX|CLK)|SERDES|SATA.*(?:RX|TX)|DP[\s_-]*(?:LANE|ML|TX|RX|AUX|\d)|MDI[\s_-]?[PN]|ETH.*(?:RX|TX).*[PN]|CML|XAUI/i;
const REVIEW_REQUIRED_NET_RE =
  /(?:^|[_\s-])(?:REFCLK|CLK|CLOCK|SDIO|SDMMC|QSPI|OSPI|RGMII|RMII|SGMII|CAN|RS485|RF|ANT|ANTENNA|JESD|DCO|ADC[\s_-]*DATA|DAC[\s_-]*DATA)(?:$|[_\s+\-])|(?:^|[_-])SD[_-](?:CLK|CMD|D[0-7])(?:$|[_-])/i;

function normalizedUniqueStrings(values = []) {
  return [
    ...new Set(
      values
        .filter(nonemptyString)
        .map((value) => value.trim()),
    ),
  ];
}

function declaredHighSpeedNets(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const nets = [...(Array.isArray(record.highSpeedNets) ? record.highSpeedNets : [])];
  for (const item of Array.isArray(record.interfaces) ? record.interfaces : []) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.nets)) nets.push(...item.nets);
    for (const pair of Array.isArray(item.pairs) ? item.pairs : []) {
      if (typeof pair === "string") {
        nets.push(...pair.split(pair.includes(":") ? ":" : ","));
      } else if (pair && typeof pair === "object") {
        nets.push(pair.positive, pair.negative);
      }
    }
    for (const group of Array.isArray(item.groups) ? item.groups : []) {
      if (group && Array.isArray(group.nets)) nets.push(...group.nets);
    }
  }
  return normalizedUniqueStrings(nets);
}

function highSpeedDiscovery(netNames = [], { constraintRecord } = {}) {
  const allNetNames = normalizedUniqueStrings(netNames);
  const available = new Set(allNetNames);
  const candidateByNet = new Map();
  const sidebandNets = [];

  const addCandidate = (net, classification, source, reason) => {
    if (!nonemptyString(net)) return;
    const name = net.trim();
    const existing = candidateByNet.get(name);
    const rank = {
      UNRESOLVED: 1,
      CONTROLLED_HIGH_SPEED: 2,
      HIGH_RISK_SI: 3,
    };
    if (!existing || rank[classification] > rank[existing.classification]) {
      candidateByNet.set(name, {
        net: name,
        classification,
        present: available.size ? available.has(name) : null,
        sources: [source],
        reasons: [reason],
      });
      return;
    }
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  };

  for (const net of declaredHighSpeedNets(constraintRecord)) {
    const classification =
      constraintRecord?.classification === "HIGH_RISK_SI"
        ? "HIGH_RISK_SI"
        : "CONTROLLED_HIGH_SPEED";
    const present = !available.size || available.has(net);
    addCandidate(
      net,
      classification,
      "constraint-record",
      present
        ? "net is explicitly declared by a revision-controlled interface constraint"
        : "net is explicitly declared but absent from the complete PCB net list",
    );
  }

  for (const net of allNetNames) {
    if (HIGH_SPEED_SIDEBAND_RE.test(net)) {
      sidebandNets.push(net);
      continue;
    }
    if (HIGH_RISK_NET_RE.test(net)) {
      addCandidate(
        net,
        "HIGH_RISK_SI",
        "net-name-profile",
        "net name matches an RF or high-risk serial-channel profile",
      );
    } else if (DEFINITE_HIGH_SPEED_NET_RE.test(net)) {
      addCandidate(
        net,
        "CONTROLLED_HIGH_SPEED",
        "net-name-profile",
        "net name matches a controlled/high-speed lane profile",
      );
    } else if (REVIEW_REQUIRED_NET_RE.test(net)) {
      addCandidate(
        net,
        "UNRESOLVED",
        "net-name-profile",
        "net name requires edge-rate, topology, impedance, and route-length classification",
      );
    }
  }

  const netNameSet = new Set(allNetNames);
  for (const net of allNetNames) {
    const match = net.match(/^(.+)([_-])([PN])$/i);
    if (!match) continue;
    const complement = `${match[1]}${match[2]}${
      match[3].toUpperCase() === "P" ? "N" : "P"
    }`;
    if (!netNameSet.has(complement)) continue;
    addCandidate(
      net,
      "UNRESOLVED",
      "differential-pair-shape",
      `net has complementary polarity-shaped partner ${complement}`,
    );
    if (
      /(?:^|[_-])(?:CLK|REFCLK|DCO|DATA\d*|RX\d*|TX\d*|LANE\d*|AUX|ADC|DAC)(?:$|[_-])/i.test(
        match[1],
      )
    ) {
      addCandidate(
        net,
        "CONTROLLED_HIGH_SPEED",
        "differential-pair-shape",
        `net has complementary differential partner ${complement}`,
      );
    }
  }
  for (const net of allNetNames) {
    const match = net.match(/^(.+)([+-])$/);
    if (!match) continue;
    const complement = `${match[1]}${match[2] === "+" ? "-" : "+"}`;
    if (!netNameSet.has(complement)) continue;
    addCandidate(
      net,
      "UNRESOLVED",
      "differential-pair-shape",
      `net has complementary polarity-shaped partner ${complement}`,
    );
  }

  const candidates = [...candidateByNet.values()].sort((left, right) =>
    left.net.localeCompare(right.net),
  );
  const classifications = new Set(candidates.map((item) => item.classification));
  let classification = "BASELINE";
  if (classifications.has("HIGH_RISK_SI")) classification = "HIGH_RISK_SI";
  else if (classifications.has("UNRESOLVED")) classification = "UNRESOLVED";
  else if (classifications.has("CONTROLLED_HIGH_SPEED")) {
    classification = "CONTROLLED_HIGH_SPEED";
  }
  return {
    classification,
    candidates,
    candidateNets: candidates.map((item) => item.net),
    missingDeclaredNets: candidates
      .filter(
        (item) =>
          item.present === false && item.sources.includes("constraint-record"),
      )
      .map((item) => item.net),
    sidebandNets: normalizedUniqueStrings(sidebandNets).sort(),
    declaredNets: declaredHighSpeedNets(constraintRecord).sort(),
  };
}

function highSpeedNetHints(netNames = []) {
  return highSpeedDiscovery(netNames).candidateNets;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableHash(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}

function primitiveSort(left, right) {
  return JSON.stringify(stableValue(left)).localeCompare(
    JSON.stringify(stableValue(right)),
  );
}

function designFingerprintPayload(raw = {}) {
  const sourceSegments =
    Array.isArray(raw.segments) && raw.segments.length
      ? raw.segments
      : [
          ...(raw.lines || []).map((line) => ({ ...line, segmentKind: "line" })),
          ...(raw.arcs || []).map((arc) => ({ ...arc, segmentKind: "arc" })),
        ];
  const segments = sourceSegments
    .map((item) => ({
      primitiveId: item.primitiveId ?? null,
      segmentKind: item.segmentKind || "line",
      net: item.net || "",
      layer: item.layer ?? null,
      lineWidth: item.lineWidth ?? null,
      startX: item.startX ?? null,
      startY: item.startY ?? null,
      endX: item.endX ?? null,
      endY: item.endY ?? null,
      arcAngle: item.arcAngle ?? null,
    }))
    .sort(primitiveSort);
  const vias = (raw.vias || [])
    .map((item) => ({
      primitiveId: item.primitiveId ?? null,
      net: item.net || "",
      x: item.x ?? null,
      y: item.y ?? null,
      diameter: item.diameter ?? null,
      holeDiameter: item.holeDiameter ?? null,
      viaType: item.viaType ?? null,
      blindViaRule: item.blindViaRule ?? null,
      solderMaskExpansion: item.solderMaskExpansion ?? null,
    }))
    .sort(primitiveSort);
  const polylines = (raw.polylines || [])
    .map((item) => ({
      primitiveId: item.primitiveId ?? null,
      net: item.net || "",
      layer: item.layer ?? null,
      lineWidth: item.lineWidth ?? null,
      locked: item.locked === true,
      closed: item.closed === true,
      points: Array.isArray(item.points)
        ? item.points.map((point) =>
            Array.isArray(point) ? [point[0] ?? null, point[1] ?? null] : null,
          )
        : null,
    }))
    .sort(primitiveSort);
  const pours = (raw.pours || [])
    .map((item) => ({
      primitiveId: item.primitiveId ?? null,
      net: item.net || "",
      layer: item.layer ?? null,
      name: item.name || "",
      lineWidth: item.lineWidth ?? null,
      fillMethod: item.fillMethod ?? null,
      priority: item.priority ?? null,
      complexPolygon: item.complexPolygon ?? null,
      preserveSilos: Boolean(item.preserveSilos),
      hasCopper: Boolean(item.hasCopper),
      fillCount: item.fillCount ?? null,
      solidFillCount: item.solidFillCount ?? null,
      solidFillRecords: item.solidFillRecords ?? null,
    }))
    .sort(primitiveSort);
  const components = (raw.components || [])
    .map((item) => ({
      primitiveId: item.primitiveId ?? null,
      designator: item.designator || "",
      uniqueId: item.uniqueId || null,
      name: item.name || null,
      manufacturer: item.manufacturer || null,
      manufacturerPartNumber: item.manufacturerPartNumber || null,
      supplier: item.supplier || null,
      supplierPartNumber: item.supplierPartNumber || null,
      addIntoPcb: item.addIntoPcb ?? null,
      footprint: item.footprint
        ? {
            libraryUuid: item.footprint.libraryUuid ?? null,
            uuid: item.footprint.uuid ?? null,
            name: item.footprint.name ?? null,
          }
        : null,
      model3D: item.model3D
        ? {
            libraryUuid: item.model3D.libraryUuid ?? null,
            uuid: item.model3D.uuid ?? null,
            name: item.model3D.name ?? null,
          }
        : null,
      layer: item.layer ?? null,
      x: item.x ?? null,
      y: item.y ?? null,
      rotation: item.rotation ?? null,
      bbox: item.bbox
        ? {
            minX: item.bbox.minX ?? null,
            minY: item.bbox.minY ?? null,
            maxX: item.bbox.maxX ?? null,
            maxY: item.bbox.maxY ?? null,
          }
        : null,
    }))
    .sort(primitiveSort);
  const pads = (raw.pads || [])
    .map((item) => ({
      primitiveId: item.primitiveId ?? null,
      parentComponentPrimitiveId: item.parentComponentPrimitiveId ?? null,
      designator: item.designator || "",
      padNumber: item.padNumber || "",
      net: item.net || "",
      layer: item.layer ?? null,
      x: item.x ?? null,
      y: item.y ?? null,
      rotation: item.rotation ?? null,
      pad: item.pad ?? null,
      specialPad: item.specialPad ?? null,
      hole: item.hole ?? null,
      padType: item.padType ?? null,
      solderMaskAndPasteMaskExpansion:
        item.solderMaskAndPasteMaskExpansion ?? null,
    }))
    .sort(primitiveSort);
  const layers = (raw.layers || [])
    .map((item) => ({
      id: item.id ?? null,
      name: item.name || "",
      type: item.type ?? null,
    }))
    .sort(primitiveSort);
  const netNames = normalizedUniqueStrings([
    ...(raw.netNames || []),
    ...segments.map((item) => item.net),
    ...vias.map((item) => item.net),
    ...pours.map((item) => item.net),
  ]).sort();

  return {
    fingerprintSchemaVersion: DESIGN_FINGERPRINT_SCHEMA_VERSION,
    projectUuid: raw.project?.uuid || null,
    documentUuid: raw.document?.uuid || null,
    layers,
    netNames,
    components,
    pads,
    segments,
    polylines,
    vias,
    pours,
  };
}

function designFingerprint(raw = {}) {
  return stableHash(designFingerprintPayload(raw));
}

function constraintFingerprint(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  return stableHash(record);
}

const CRYSTAL_NET_HINT_RE =
  /(?:^|[_-])(?:XTAL(?:32)?(?:[_-]?(?:IN|OUT|I|O|P|N))?|OSC(?:32)?(?:[_-]?(?:IN|OUT|I|O|P|N))?|HSE[_-]?(?:IN|OUT)|LSE[_-]?(?:IN|OUT)|X(?:IN|OUT))(?:$|[_-])/i;

function crystalNetHints(netNames = []) {
  return [...new Set(netNames.filter((net) => CRYSTAL_NET_HINT_RE.test(net || "")))];
}

async function fetchJson(url, init = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `${response.status} ${response.statusText}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function findBridge(explicitPort, ports = DEFAULT_BRIDGE_PORTS) {
  const list = explicitPort ? [explicitPort] : [...ports];
  const results = await Promise.all(
    list.map(async (port) => {
      try {
        const health = await fetchJson(`http://127.0.0.1:${port}/health`, {}, 800);
        return health.service === "easyeda-bridge" ? { port, health } : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const bridges = results.filter(Boolean);
  const connected = bridges.find((bridge) => bridge.health.edaConnected);
  if (connected) return connected;
  if (bridges.length) {
    throw new Error(
      `EasyEDA bridge found on port ${bridges[0].port}, but no EDA window is connected`,
    );
  }
  throw new Error(
    explicitPort
      ? `no verified easyeda-bridge found on port ${explicitPort}`
      : "no verified easyeda-bridge found on ports 49620-49629",
  );
}

async function resolveWindow(bridge, requestedWindowId) {
  const registry = await fetchJson(
    `http://127.0.0.1:${bridge.port}/eda-windows`,
    {},
    2500,
  );
  const windows = Array.isArray(registry.windows)
    ? registry.windows.filter((item) => item?.connected !== false)
    : [];
  if (requestedWindowId) {
    if (!windows.some((item) => item.windowId === requestedWindowId)) {
      throw new Error(`EasyEDA window is not connected: ${requestedWindowId}`);
    }
    return requestedWindowId;
  }
  if (windows.length === 1) return windows[0].windowId;
  if (windows.length === 0) {
    throw new Error("no connected EasyEDA window was registered");
  }
  throw new Error(
    `multiple EasyEDA windows are connected (${windows
      .map((item) => item.windowId)
      .join(", ")}); specify --window-id`,
  );
}

function skillSearchRoots(env = process.env) {
  const home = env.HOME || os.homedir();
  const roots = [
    process.cwd(),
    path.join(process.cwd(), ".agents", "skills"),
    path.join(process.cwd(), "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".claude", "skills"),
  ];
  if (nonemptyString(env.EASYEDA_API_SKILL_PATH)) {
    roots.unshift(env.EASYEDA_API_SKILL_PATH);
  }
  return roots;
}

function looksLikeEasyedaApiSkill(dir) {
  const skillMd = path.join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return false;
  try {
    const text = readFileSync(skillMd, "utf8");
    // Require the skill front-matter name — do not match easyeda-pcb-design.
    return /^name:\s*easyeda-api\s*$/m.test(text);
  } catch {
    return false;
  }
}

function findEasyedaApiSkill(env = process.env) {
  const explicit = env.EASYEDA_API_SKILL_PATH;
  if (nonemptyString(explicit)) {
    const dir = existsSync(explicit) && statSync(explicit).isFile()
      ? path.dirname(explicit)
      : explicit;
    if (looksLikeEasyedaApiSkill(dir)) {
      return { found: true, path: dir };
    }
    return {
      found: false,
      path: null,
      hint: `EASYEDA_API_SKILL_PATH does not point at an easyeda-api skill: ${explicit}`,
    };
  }

  for (const root of skillSearchRoots(env)) {
    if (!root || !existsSync(root)) continue;
    try {
      const st = statSync(root);
      if (!st.isDirectory()) continue;
      // Never treat the current pcb-design skill tree as the API companion.
      if (looksLikeEasyedaApiSkill(root) && path.basename(root) !== "easyeda-pcb-design") {
        return { found: true, path: root };
      }
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "easyeda-pcb-design") continue;
        const child = path.join(root, entry.name);
        if (
          (entry.name === "easyeda-api" || /easyeda-api/i.test(entry.name)) &&
          looksLikeEasyedaApiSkill(child)
        ) {
          return { found: true, path: child };
        }
      }
    } catch {
      // continue searching
    }
  }
  return {
    found: false,
    path: null,
    hint: "Install easyeda-api skill or set EASYEDA_API_SKILL_PATH to its directory",
  };
}

async function checkCompanion({ bridgePort, env = process.env } = {}) {
  const skill = findEasyedaApiSkill(env);
  let bridge;
  let bridgeError;
  try {
    bridge = await findBridge(bridgePort);
  } catch (error) {
    bridgeError = error instanceof Error ? error.message : String(error);
  }
  const ready = Boolean(skill.found && bridge?.health?.edaConnected);
  return {
    ready,
    skill,
    bridge: bridge
      ? {
          port: bridge.port,
          edaConnected: Boolean(bridge.health.edaConnected),
          health: bridge.health,
        }
      : null,
    bridgeError: bridgeError || null,
    fabricationRelease: false,
    message: ready
      ? "easyeda-api skill and easyeda-bridge are ready"
      : "companion not ready — refuse live EasyEDA API work and do not guess signatures",
  };
}

function readClearanceReport(
  reportPath,
  {
    cwd = process.cwd(),
    auditLabel = "audit",
    expectedKind,
  } = {},
) {
  if (!nonemptyString(reportPath)) {
    return { cleared: false, reason: `no ${auditLabel} report path supplied` };
  }
  const resolved = path.isAbsolute(reportPath)
    ? path.resolve(reportPath)
    : path.resolve(cwd, reportPath);
  if (!existsSync(resolved)) {
    return { cleared: false, reason: `${auditLabel} report not found: ${reportPath}` };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    return {
      cleared: false,
      reason: `invalid ${auditLabel} JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (expectedKind && report?.kind !== expectedKind) {
    return {
      cleared: false,
      reason: `${auditLabel} report kind is not ${expectedKind}: ${report?.kind}`,
      reportPath: resolved,
      decision: report?.decision,
    };
  }
  if (report?.decision === DECISION_VALUES.FAIL) {
    return {
      cleared: false,
      reason: `${auditLabel} decision is FAIL`,
      reportPath: resolved,
      decision: report.decision,
    };
  }
  if (report?.decision === DECISION_VALUES.UNVERIFIED) {
    return {
      cleared: false,
      reason: `${auditLabel} is still UNVERIFIED FOR FABRICATION`,
      reportPath: resolved,
      decision: report.decision,
    };
  }
  if (report?.decision !== DECISION_VALUES.PASS_WITH_EXCEPTIONS) {
    return {
      cleared: false,
      reason: `${auditLabel} decision is not acceptable: ${report?.decision}`,
      reportPath: resolved,
      decision: report?.decision,
    };
  }
  return {
    cleared: true,
    reason: `${auditLabel} PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS`,
    reportPath: resolved,
    decision: report.decision,
  };
}

function readHighSpeedClearanceReport(reportPath, options = {}) {
  const clearance = readClearanceReport(reportPath, {
    ...options,
    auditLabel: "high-speed audit",
  });
  if (!clearance.cleared) return clearance;

  const report = JSON.parse(readFileSync(clearance.reportPath, "utf8"));
  if (report.fabricationRelease !== false) {
    return {
      ...clearance,
      cleared: false,
      reason:
        "high-speed audit report does not explicitly set fabricationRelease=false",
    };
  }
  if (
    nonemptyString(options.expectedProjectUuid) &&
    report.design?.project?.uuid !== options.expectedProjectUuid
  ) {
    return {
      ...clearance,
      cleared: false,
      reason: `high-speed audit project UUID mismatch (${
        report.design?.project?.uuid || "missing"
      })`,
    };
  }
  if (
    nonemptyString(options.expectedDocumentUuid) &&
    report.design?.document?.uuid !== options.expectedDocumentUuid
  ) {
    return {
      ...clearance,
      cleared: false,
      reason: `high-speed audit document UUID mismatch (${
        report.design?.document?.uuid || "missing"
      })`,
    };
  }
  if (
    nonemptyString(options.expectedDesignFingerprint) &&
    report.design?.fingerprint !== options.expectedDesignFingerprint
  ) {
    return {
      ...clearance,
      cleared: false,
      reason: "high-speed audit design fingerprint is missing or stale",
    };
  }
  if (
    nonemptyString(options.expectedConstraintFingerprint) &&
    report.constraints?.fingerprint !== options.expectedConstraintFingerprint
  ) {
    return {
      ...clearance,
      cleared: false,
      reason: "high-speed audit constraint fingerprint is missing or stale",
    };
  }
  const coveredNets = new Set(
    normalizedUniqueStrings(report.constraints?.highSpeedNets || []),
  );
  const uncoveredNets = normalizedUniqueStrings(options.requiredNets || []).filter(
    (net) => !coveredNets.has(net),
  );
  if (uncoveredNets.length) {
    return {
      ...clearance,
      cleared: false,
      reason: `high-speed audit does not cover detected nets: ${uncoveredNets.join(
        ", ",
      )}`,
      uncoveredNets,
    };
  }
  return clearance;
}

function readCrystalClearanceReport(reportPath, options = {}) {
  const clearance = readClearanceReport(reportPath, {
    ...options,
    auditLabel: "crystal/clock audit",
    expectedKind: "crystal-clock",
  });
  if (!clearance.cleared) return clearance;

  const report = JSON.parse(readFileSync(clearance.reportPath, "utf8"));
  if (report.fabricationRelease !== false) {
    return {
      ...clearance,
      cleared: false,
      reason:
        "crystal/clock audit report does not explicitly set fabricationRelease=false",
    };
  }
  if (
    nonemptyString(options.expectedProjectUuid) &&
    report.design?.project?.uuid !== options.expectedProjectUuid
  ) {
    return {
      ...clearance,
      cleared: false,
      reason: `crystal/clock audit project UUID mismatch (${
        report.design?.project?.uuid || "missing"
      })`,
    };
  }
  if (
    nonemptyString(options.expectedDocumentUuid) &&
    report.design?.document?.uuid !== options.expectedDocumentUuid
  ) {
    return {
      ...clearance,
      cleared: false,
      reason: `crystal/clock audit document UUID mismatch (${
        report.design?.document?.uuid || "missing"
      })`,
    };
  }
  if (
    nonemptyString(options.expectedDesignFingerprint) &&
    report.design?.fingerprint !== options.expectedDesignFingerprint
  ) {
    return {
      ...clearance,
      cleared: false,
      reason: "crystal/clock audit design fingerprint is missing or stale",
    };
  }
  const coveredNets = new Set(
    normalizedUniqueStrings(report.constraints?.crystalNets || []),
  );
  const uncoveredNets = normalizedUniqueStrings(options.requiredNets || []).filter(
    (net) => !coveredNets.has(net),
  );
  if (uncoveredNets.length) {
    return {
      ...clearance,
      cleared: false,
      reason: `crystal/clock audit does not cover detected nets: ${uncoveredNets.join(
        ", ",
      )}`,
      uncoveredNets,
    };
  }
  return clearance;
}

function resolveManufacturingReview(options = {}, env = process.env) {
  if (!options.manufacturingReviewed) {
    return {
      reviewed: false,
      reason: "manufacturing outputs not marked reviewed",
    };
  }
  const attestation = resolveHumanAttestation(
    {
      userAttestedEvidence: true,
      attestFile: options.attestFile,
      cwd: options.cwd,
    },
    env,
  );
  if (!attestation.accepted) {
    return {
      reviewed: false,
      reason: `--manufacturing-reviewed requires human attestation (${attestation.reason})`,
      attestation,
    };
  }
  return {
    reviewed: true,
    reason: "human attested manufacturing output review",
    attestation,
  };
}

function applyDecisionExitCode(decision) {
  if (decision === DECISION_VALUES.FAIL) return EXIT.FAIL;
  if (decision === DECISION_VALUES.UNVERIFIED) return EXIT.UNVERIFIED;
  if (decision === DECISION_VALUES.PASS_WITH_EXCEPTIONS) {
    return EXIT.PASS_WITH_EXCEPTIONS;
  }
  return EXIT.ERROR;
}

function notAFabricationReleaseMessage() {
  return "This audit is not a fabrication release. Never treat PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS, exit code 4, or a clean DRC as authorization to fabricate or place a PCB order.";
}

export {
  ATTEST_LINE_RE,
  COMPLETION_TEMPLATE,
  DECISION_VALUES,
  DESIGN_FINGERPRINT_SCHEMA_VERSION,
  DEFAULT_BRIDGE_PORTS,
  EXIT,
  analyzePourConnectivity,
  applyDecisionExitCode,
  checkCompanion,
  constraintFingerprint,
  crystalNetHints,
  declaredHighSpeedNets,
  designFingerprint,
  designFingerprintPayload,
  evidenceArtifactCandidate,
  evidenceMeetsGate,
  existingArtifactPath,
  fetchJson,
  findBridge,
  findEasyedaApiSkill,
  freeCopperPrimitiveIds,
  highRiskInterfaceReasons,
  highSpeedDiscovery,
  highSpeedNetHints,
  nonemptyString,
  notAFabricationReleaseMessage,
  readCrystalClearanceReport,
  readHighSpeedClearanceReport,
  resolveHumanAttestation,
  resolveManufacturingReview,
  resolveSafeOutputPath,
  resolveWindow,
  validateNetlistCompareExceptionArtifact,
};

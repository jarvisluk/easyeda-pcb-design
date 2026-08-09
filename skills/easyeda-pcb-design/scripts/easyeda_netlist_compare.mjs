#!/usr/bin/env node

/**
 * Read-only schematic/PCB manufacturing-netlist comparison through the
 * EasyEDA bridge. This is intended as evidence before the confirmation-gated
 * PCB_Document.importChanges() synchronization.
 */

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  fetchJson,
  findBridge,
  notAFabricationReleaseMessage,
  resolveSafeOutputPath,
  resolveWindow,
} from "./audit_common.mjs";

const EXIT = Object.freeze({ OK: 0, ERROR: 1, MISMATCH: 2, UNVERIFIED: 3 });

// Exact values from EDMT_EditorDocumentType and ESYS_NetlistType. The bridge
// execution sandbox does not expose enum globals.
const DOCUMENT_TYPE = Object.freeze({ SCHEMATIC_PAGE: 1, PCB: 3 });
const NETLIST_TYPE_JLCEDA_PRO = "JLCEDA";

const CORE_COMPONENT_PROPERTIES = Object.freeze([
  "Unique ID",
  "Designator",
  "Device",
  "Footprint",
  "Manufacturer",
  "Manufacturer Part",
  "Supplier",
  "Supplier Part",
  "Add into BOM",
  "Convert to PCB",
]);

function usage() {
  return `Usage:
  node scripts/easyeda_netlist_compare.mjs \\
    --schematic-page-uuid UUID --pcb-uuid UUID [options]

Options:
  --schematic-page-uuid UUID  Schematic page to export
  --schematic-uuid UUID       Parent schematic for native document comparison
  --pcb-uuid UUID             PCB to export
  --require-native-match      Return UNVERIFIED unless native comparison MATCHES
  --bridge-port PORT          Use one bridge port
  --window-id ID              Target a registered EasyEDA window
  --output FILE               Relative JSON output path under cwd
  --force                     Overwrite an existing output file
  --help                      Show this help

This command is read-only apart from activating documents. It does not call
PCB_Document.importChanges() and is not a fabrication release.
`;
}

function requiredValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
  return argv[index + 1];
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--bridge-port requires an integer from 1 to 65535");
  }
  return port;
}

function parseArgs(argv) {
  const options = {
    schematicPageUuid: undefined,
    schematicUuid: undefined,
    pcbUuid: undefined,
    bridgePort: undefined,
    windowId: undefined,
    output: undefined,
    force: false,
    requireNativeMatch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--schematic-page-uuid") {
      options.schematicPageUuid = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--schematic-uuid") {
      options.schematicUuid = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--pcb-uuid") {
      options.pcbUuid = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--require-native-match") {
      options.requireNativeMatch = true;
    } else if (option === "--bridge-port") {
      options.bridgePort = positivePort(requiredValue(argv, index, option));
      index += 1;
    } else if (option === "--window-id") {
      options.windowId = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--output") {
      options.output = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--force") {
      options.force = true;
    } else if (option === "--help" || option === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  if (!options.help && !options.schematicPageUuid) {
    throw new Error("--schematic-page-uuid is required");
  }
  if (!options.help && !options.pcbUuid) {
    throw new Error("--pcb-uuid is required");
  }
  if (!options.help && options.requireNativeMatch && !options.schematicUuid) {
    throw new Error("--require-native-match requires --schematic-uuid");
  }
  return options;
}

function summarizeNativeComparison(differences, requested) {
  if (!requested) {
    return {
      status: "NOT_REQUESTED",
      differenceCount: null,
      differences: [],
    };
  }
  if (!Array.isArray(differences)) {
    return {
      status: "UNAVAILABLE",
      differenceCount: null,
      differences: [],
    };
  }
  return {
    status: differences.length === 0 ? "MATCH" : "MISMATCH",
    differenceCount: differences.length,
    differences,
  };
}

function overallDecision(
  manufacturingMatch,
  nativeStatus,
  requireNativeMatch = false,
) {
  if (!manufacturingMatch || nativeStatus === "MISMATCH") return "MISMATCH";
  if (requireNativeMatch && nativeStatus !== "MATCH") return "UNVERIFIED";
  if (nativeStatus === "UNAVAILABLE") return "UNVERIFIED";
  return "MATCH";
}

function scalar(value) {
  return value === undefined || value === null ? "" : String(value);
}

function identityContractIssues(netlist, source) {
  if (!netlist?.components || typeof netlist.components !== "object") {
    throw new Error(`${source} netlist must contain a components object`);
  }
  const issues = [];
  const designatorOwners = new Map();
  const uniqueIdOwners = new Map();
  for (const [componentKey, component] of Object.entries(netlist.components)) {
    const designator = scalar(component?.props?.Designator);
    const uniqueId = scalar(component?.props?.["Unique ID"]);
    if (!designator) {
      issues.push({ source, code: "MISSING_DESIGNATOR", componentKey });
    } else if (designatorOwners.has(designator)) {
      issues.push({
        source,
        code: "DUPLICATE_DESIGNATOR",
        componentKey,
        designator,
        otherComponentKey: designatorOwners.get(designator),
      });
    } else {
      designatorOwners.set(designator, componentKey);
    }
    if (!uniqueId) {
      issues.push({
        source,
        code: "MISSING_UNIQUE_ID",
        componentKey,
        designator,
      });
    } else {
      if (uniqueId !== componentKey) {
        issues.push({
          source,
          code: "COMPONENT_KEY_UNIQUE_ID_MISMATCH",
          componentKey,
          designator,
          uniqueId,
        });
      }
      if (uniqueIdOwners.has(uniqueId)) {
        issues.push({
          source,
          code: "DUPLICATE_UNIQUE_ID",
          componentKey,
          designator,
          uniqueId,
          otherComponentKey: uniqueIdOwners.get(uniqueId),
        });
      } else {
        uniqueIdOwners.set(uniqueId, componentKey);
      }
    }
  }
  return issues;
}

function compareNetlists(schematic, pcb) {
  if (!schematic?.components || !pcb?.components) {
    throw new Error("both netlists must contain a components object");
  }
  const schematicIds = Object.keys(schematic.components);
  const pcbIds = Object.keys(pcb.components);
  const allIds = [...new Set([...schematicIds, ...pcbIds])].sort();
  const missingComponents = [];
  const pinNetDiffs = [];
  const corePropertyDiffs = [];
  const informationalPropertyDiffs = [];
  const schematicIdentityIssues = identityContractIssues(
    schematic,
    "schematic",
  );
  const pcbIdentityIssues = identityContractIssues(pcb, "pcb");

  for (const uniqueId of allIds) {
    const schComponent = schematic.components[uniqueId];
    const pcbComponent = pcb.components[uniqueId];
    if (!schComponent || !pcbComponent) {
      missingComponents.push({
        uniqueId,
        schematic: Boolean(schComponent),
        pcb: Boolean(pcbComponent),
        designator:
          schComponent?.props?.Designator || pcbComponent?.props?.Designator || "",
      });
      continue;
    }
    const designator =
      schComponent.props?.Designator || pcbComponent.props?.Designator || "";
    const schematicPins = schComponent.pinInfoMap || {};
    const pcbPins = pcbComponent.pinInfoMap || {};
    const pins = [
      ...new Set([...Object.keys(schematicPins), ...Object.keys(pcbPins)]),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const pin of pins) {
      const schematicNet = scalar(schematicPins[pin]?.net);
      const pcbNet = scalar(pcbPins[pin]?.net);
      if (schematicNet !== pcbNet) {
        pinNetDiffs.push({
          uniqueId,
          designator,
          pin,
          schematicNet,
          pcbNet,
        });
      }
    }

    const propertyKeys = [
      ...new Set([
        ...Object.keys(schComponent.props || {}),
        ...Object.keys(pcbComponent.props || {}),
      ]),
    ].sort();
    for (const property of propertyKeys) {
      const schematicValue = scalar(schComponent.props?.[property]);
      const pcbValue = scalar(pcbComponent.props?.[property]);
      if (schematicValue === pcbValue) continue;
      const diff = {
        uniqueId,
        designator,
        property,
        schematicValue,
        pcbValue,
      };
      if (CORE_COMPONENT_PROPERTIES.includes(property)) {
        corePropertyDiffs.push(diff);
      } else {
        informationalPropertyDiffs.push(diff);
      }
    }
  }

  const match =
    schematicIdentityIssues.length === 0 &&
    pcbIdentityIssues.length === 0 &&
    missingComponents.length === 0 &&
    pinNetDiffs.length === 0 &&
    corePropertyDiffs.length === 0;
  return {
    match,
    schematicComponentCount: schematicIds.length,
    pcbComponentCount: pcbIds.length,
    missingComponents,
    pinNetDiffs,
    corePropertyDiffs,
    identityContract: {
      schematicIssues: schematicIdentityIssues,
      pcbIssues: pcbIdentityIssues,
    },
    informationalPropertyDiffCount: informationalPropertyDiffs.length,
    informationalPropertyDiffs,
  };
}

function collectorCode(documentUuid, kind) {
  const expectedType =
    kind === "schematic"
      ? DOCUMENT_TYPE.SCHEMATIC_PAGE
      : DOCUMENT_TYPE.PCB;
  const manufactureModule =
    kind === "schematic"
      ? "sch_ManufactureData"
      : "pcb_ManufactureData";
  return `
await eda.dmt_EditorControl.openDocument(${JSON.stringify(documentUuid)});
const project = await eda.dmt_Project.getCurrentProjectInfo();
const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!project || !document) throw new Error("project/document unavailable");
if (document.uuid !== ${JSON.stringify(documentUuid)}) {
  throw new Error("requested document did not become active");
}
if (document.documentType !== ${expectedType}) {
  throw new Error("unexpected document type: " + document.documentType);
}
const file = await eda.${manufactureModule}.getNetlistFile(
  "NETLIST_COMPARE",
  ${JSON.stringify(NETLIST_TYPE_JLCEDA_PRO)},
);
if (!file) throw new Error("manufacturing netlist export returned no file");
return {
  project: { uuid: project.uuid, name: project.friendlyName || project.name || "" },
  document,
  file: { name: file.name, size: file.size, type: file.type },
  netlist: await file.text(),
};
`;
}

async function collect(bridge, windowId, documentUuid, kind) {
  const response = await fetchJson(
    `http://127.0.0.1:${bridge.port}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: collectorCode(documentUuid, kind),
        windowId,
      }),
    },
    35000,
  );
  if (!response.success || !response.result) {
    throw new Error(response.error || `${kind} netlist collection failed`);
  }
  return response.result;
}

async function collectNativeComparison(
  bridge,
  windowId,
  schematicUuid,
  pcbUuid,
) {
  if (!schematicUuid) return undefined;
  const response = await fetchJson(
    `http://127.0.0.1:${bridge.port}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: `return await eda.sys_Tool.netlistComparison(${JSON.stringify(
          schematicUuid,
        )}, ${JSON.stringify(pcbUuid)});`,
        windowId,
      }),
    },
    35000,
  );
  if (!response.success) {
    throw new Error(response.error || "native document netlist comparison failed");
  }
  return response.result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const bridge = await findBridge(options.bridgePort);
  const windowId = await resolveWindow(bridge, options.windowId);
  const schematic = await collect(
    bridge,
    windowId,
    options.schematicPageUuid,
    "schematic",
  );
  const pcb = await collect(bridge, windowId, options.pcbUuid, "pcb");
  const comparison = compareNetlists(
    JSON.parse(schematic.netlist),
    JSON.parse(pcb.netlist),
  );
  const nativeDifferences = await collectNativeComparison(
    bridge,
    windowId,
    options.schematicUuid,
    options.pcbUuid,
  );
  const nativeDocumentComparison = summarizeNativeComparison(
    nativeDifferences,
    Boolean(options.schematicUuid),
  );
  const decision = overallDecision(
    comparison.match,
    nativeDocumentComparison.status,
    options.requireNativeMatch,
  );
  const report = {
    schemaVersion: 1,
    kind: "easyeda-manufacturing-netlist-comparison",
    decision,
    manufacturingDecision: comparison.match ? "MATCH" : "MISMATCH",
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    bridge: { port: bridge.port, windowId, health: bridge.health },
    project: schematic.project,
    schematic: {
      uuid: schematic.document.uuid,
      file: schematic.file,
    },
    pcb: { uuid: pcb.document.uuid, file: pcb.file },
    comparison,
    nativeDocumentComparison,
    nativeMatchRequired: options.requireNativeMatch,
    interpretation:
      "MATCH proves manufacturing-netlist component identity, core mapping, and pin-net equivalence only. When requested, nativeDocumentComparison independently reports EasyEDA's document-sync view. Neither result authorizes importChanges, setNetlist, fabrication, or ordering.",
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolveSafeOutputPath(options.output, {
      force: options.force,
    });
    await writeFile(outputPath, text, "utf8");
  }
  process.stdout.write(text);
  process.exitCode =
    decision === "MATCH"
      ? EXIT.OK
      : decision === "UNVERIFIED"
        ? EXIT.UNVERIFIED
        : EXIT.MISMATCH;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.ERROR;
  });
}

export {
  CORE_COMPONENT_PROPERTIES,
  EXIT,
  collectorCode,
  collectNativeComparison,
  compareNetlists,
  identityContractIssues,
  overallDecision,
  parseArgs,
  summarizeNativeComparison,
};

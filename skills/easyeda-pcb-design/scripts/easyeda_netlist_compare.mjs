#!/usr/bin/env node

/**
 * Read-only schematic/PCB synchronization comparison through the EasyEDA
 * bridge. The default path compares manufacturing netlists and the native
 * document comparator. An explicit strict exception path can additionally
 * prove that a cache-shaped native mismatch is a beta-comparator false
 * negative by checking independent PCB data-plane views.
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
  --allow-native-cache-exception
                              Accept only a strictly verified native comparator
                              false negative; requires --schematic-uuid
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
    allowNativeCacheException: false,
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
    } else if (option === "--allow-native-cache-exception") {
      options.allowNativeCacheException = true;
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
  if (
    !options.help &&
    options.allowNativeCacheException &&
    !options.schematicUuid
  ) {
    throw new Error(
      "--allow-native-cache-exception requires --schematic-uuid",
    );
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
  nativeCacheExceptionStatus = "NOT_REQUESTED",
) {
  if (!manufacturingMatch) return "MISMATCH";
  if (
    nativeStatus === "MISMATCH" &&
    nativeCacheExceptionStatus === "VERIFIED"
  ) {
    return "MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION";
  }
  if (nativeStatus === "MISMATCH") return "MISMATCH";
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

function parseNetlistEntries(raw, label) {
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return entries.map((entry, index) => {
    const parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
    if (!parsed?.components || typeof parsed.components !== "object") {
      throw new Error(`${label} ${index} must contain a components object`);
    }
    return parsed;
  });
}

function netNamesFromNetlist(netlist) {
  const names = new Set();
  for (const component of Object.values(netlist.components || {})) {
    for (const pin of Object.values(component?.pinInfoMap || {})) {
      const net = scalar(pin?.net);
      if (net) names.add(net);
    }
  }
  return [...names].sort();
}

function comparePcbDataPlane(
  schematic,
  pcbInternalRaw,
  pcbNetNames,
  pcbComponents,
) {
  const issues = [];
  let internalViews = [];
  try {
    internalViews = parseNetlistEntries(pcbInternalRaw, "PCB internal netlist");
  } catch (error) {
    issues.push({
      code: "PCB_INTERNAL_NETLIST_PARSE_ERROR",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (internalViews.length === 0) {
    issues.push({ code: "PCB_INTERNAL_NETLIST_MISSING" });
  }
  const internalComparisons = internalViews.map((view, index) => ({
    index,
    ...compareNetlists(schematic, view),
  }));
  for (const comparison of internalComparisons) {
    if (!comparison.match) {
      issues.push({
        code: "PCB_INTERNAL_NETLIST_MISMATCH",
        index: comparison.index,
      });
    }
  }

  const expectedNetNames = netNamesFromNetlist(schematic);
  const actualNetNames = [...new Set((pcbNetNames || []).map(scalar).filter(Boolean))]
    .sort();
  const expectedNetSet = new Set(expectedNetNames);
  const actualNetSet = new Set(actualNetNames);
  const missingNetNames = expectedNetNames.filter((net) => !actualNetSet.has(net));
  const extraNetNames = actualNetNames.filter((net) => !expectedNetSet.has(net));
  if (missingNetNames.length || extraNetNames.length) {
    issues.push({
      code: "PCB_NET_NAME_SET_MISMATCH",
      missingNetNames,
      extraNetNames,
    });
  }

  const expectedByDesignator = new Map();
  for (const [componentKey, component] of Object.entries(
    schematic.components || {},
  )) {
    const designator = scalar(component?.props?.Designator);
    if (!designator || expectedByDesignator.has(designator)) {
      issues.push({
        code: "SCHEMATIC_DESIGNATOR_UNUSABLE_FOR_DIRECT_PAD_CHECK",
        componentKey,
        designator,
      });
      continue;
    }
    expectedByDesignator.set(designator, component);
  }
  const actualByDesignator = new Map();
  for (const component of pcbComponents || []) {
    const designator = scalar(component?.designator);
    if (!designator || actualByDesignator.has(designator)) {
      issues.push({
        code: "PCB_DIRECT_DESIGNATOR_MISSING_OR_DUPLICATE",
        designator,
        primitiveId: scalar(component?.primitiveId),
      });
      continue;
    }
    actualByDesignator.set(designator, component);
  }
  for (const [designator, expected] of expectedByDesignator) {
    const actual = actualByDesignator.get(designator);
    if (!actual) {
      issues.push({ code: "PCB_DIRECT_COMPONENT_MISSING", designator });
      continue;
    }
    const actualPins = new Map();
    for (const pad of actual.pads || []) {
      const number = scalar(pad?.number);
      if (!number) continue;
      if (!actualPins.has(number)) actualPins.set(number, new Set());
      actualPins.get(number).add(scalar(pad?.net));
    }
    const expectedPins = expected?.pinInfoMap || {};
    for (const [number, pin] of Object.entries(expectedPins)) {
      const observed = actualPins.get(String(number));
      const expectedNet = scalar(pin?.net);
      if (!observed) {
        issues.push({
          code: "PCB_DIRECT_PAD_MISSING",
          designator,
          pin: String(number),
          expectedNet,
        });
      } else if (observed.size !== 1 || !observed.has(expectedNet)) {
        issues.push({
          code: "PCB_DIRECT_PAD_NET_MISMATCH",
          designator,
          pin: String(number),
          expectedNet,
          observedNets: [...observed].sort(),
        });
      }
    }
    for (const number of actualPins.keys()) {
      if (!Object.hasOwn(expectedPins, number)) {
        issues.push({
          code: "PCB_DIRECT_EXTRA_NUMBERED_PAD",
          designator,
          pin: number,
        });
      }
    }
  }
  for (const designator of actualByDesignator.keys()) {
    if (!expectedByDesignator.has(designator)) {
      issues.push({ code: "PCB_DIRECT_EXTRA_COMPONENT", designator });
    }
  }

  return {
    match: issues.length === 0,
    expectedNetNames,
    actualNetNames,
    schematicComponentCount: expectedByDesignator.size,
    directPcbComponentCount: actualByDesignator.size,
    internalViewCount: internalViews.length,
    internalComparisons,
    issues,
  };
}

function normalizeNativeNetName(value) {
  const name = scalar(value).trim();
  if (name.length >= 2 && name.startsWith("'") && name.endsWith("'")) {
    return name.slice(1, -1);
  }
  return name;
}

function verifyNativeCacheException({
  requested,
  manufacturingMatch,
  nativeDifferences,
  fileComparison,
  pcbDataPlane,
  expectedNetNames,
}) {
  if (!requested) return { status: "NOT_REQUESTED", issues: [] };
  const issues = [];
  if (!manufacturingMatch) {
    issues.push({ code: "MANUFACTURING_NETLIST_NOT_MATCHED" });
  }
  if (!pcbDataPlane?.match) {
    issues.push({ code: "PCB_DATA_PLANE_NOT_MATCHED" });
  }
  if (!Array.isArray(fileComparison) || fileComparison.length !== 0) {
    issues.push({
      code: "NATIVE_FILE_COMPARISON_NOT_MATCHED",
      differenceCount: Array.isArray(fileComparison)
        ? fileComparison.length
        : null,
    });
  }
  if (!Array.isArray(nativeDifferences) || nativeDifferences.length === 0) {
    issues.push({ code: "DOCUMENT_COMPARISON_NOT_CACHE_SHAPED_MISMATCH" });
  } else {
    const observedNames = [];
    for (const difference of nativeDifferences) {
      const type = scalar(difference?.type).toUpperCase();
      const first = difference?.net1 || difference?.netlist1Name;
      const second = difference?.net2 || difference?.netlist2Name;
      if (
        type !== "NET" ||
        !Array.isArray(first) ||
        first.length === 0 ||
        !Array.isArray(second) ||
        second.length !== 0
      ) {
        issues.push({
          code: "DOCUMENT_DIFFERENCE_NOT_ONE_SIDED_NET",
          object: scalar(difference?.object),
        });
      }
      observedNames.push(normalizeNativeNetName(difference?.object));
    }
    const expected = [...new Set(expectedNetNames || [])].sort();
    const observed = [...new Set(observedNames)].sort();
    if (
      expected.length !== observed.length ||
      expected.some((name, index) => name !== observed[index])
    ) {
      issues.push({
        code: "DOCUMENT_DIFFERENCE_NET_SET_MISMATCH",
        expected,
        observed,
      });
    }
  }
  return {
    status: issues.length === 0 ? "VERIFIED" : "REJECTED",
    issues,
    interpretation:
      issues.length === 0
        ? "The beta document-UUID comparator alone reports every PCB net as empty while manufacturing, internal-netlist, direct pad-net, direct net-name, and native file-to-file views match. This proves a comparator false negative, not a literal native MATCH."
        : "The strict multi-view requirements for a native comparator false-negative exception were not met.",
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

function integrityCollectorCode(schematicPageUuid, pcbUuid) {
  return `
await eda.dmt_EditorControl.openDocument(${JSON.stringify(schematicPageUuid)});
const schematicProject = await eda.dmt_Project.getCurrentProjectInfo();
const schematicDocument = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!schematicProject || !schematicDocument || schematicDocument.uuid !== ${JSON.stringify(schematicPageUuid)}) {
  throw new Error("requested schematic page did not become active for integrity collection");
}
if (schematicDocument.documentType !== ${DOCUMENT_TYPE.SCHEMATIC_PAGE}) {
  throw new Error("unexpected schematic document type for integrity collection: " + schematicDocument.documentType);
}
const schematicFile = await eda.sch_ManufactureData.getNetlistFile(
  "SYNC_INTEGRITY_SCHEMATIC",
  ${JSON.stringify(NETLIST_TYPE_JLCEDA_PRO)},
);
if (!schematicFile) throw new Error("schematic integrity netlist export returned no file");
await eda.dmt_EditorControl.openDocument(${JSON.stringify(pcbUuid)});
const pcbProject = await eda.dmt_Project.getCurrentProjectInfo();
const pcbDocument = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!pcbProject || !pcbDocument || pcbDocument.uuid !== ${JSON.stringify(pcbUuid)}) {
  throw new Error("requested PCB did not become active for integrity collection");
}
if (pcbDocument.documentType !== ${DOCUMENT_TYPE.PCB}) {
  throw new Error("unexpected PCB document type for integrity collection: " + pcbDocument.documentType);
}
if (pcbProject.uuid !== schematicProject.uuid) {
  throw new Error("schematic and PCB integrity views belong to different projects");
}
const pcbFile = await eda.pcb_ManufactureData.getNetlistFile(
  "SYNC_INTEGRITY_PCB",
  ${JSON.stringify(NETLIST_TYPE_JLCEDA_PRO)},
);
if (!pcbFile) throw new Error("PCB integrity netlist export returned no file");
const components = await eda.pcb_PrimitiveComponent.getAll();
const directComponents = [];
for (const component of components) {
  const pads = await component.getAllPins();
  directComponents.push({
    primitiveId: component.getState_PrimitiveId(),
    designator: component.getState_Designator(),
    pads: pads.map((pad) => ({
      primitiveId: pad.getState_PrimitiveId(),
      number: pad.getState_PadNumber(),
      net: pad.getState_Net(),
    })),
  });
}
return {
  project: { uuid: pcbProject.uuid, name: pcbProject.friendlyName || pcbProject.name || "" },
  schematicDocument,
  pcbDocument,
  internalNetlist: await eda.pcb_Net.getNetlist(${JSON.stringify(NETLIST_TYPE_JLCEDA_PRO)}),
  netNames: await eda.pcb_Net.getAllNetsName(),
  components: directComponents,
  nativeFileComparison: await eda.sys_Tool.netlistComparison(schematicFile, pcbFile),
};
`;
}

async function collectIntegrity(
  bridge,
  windowId,
  schematicPageUuid,
  pcbUuid,
) {
  const response = await fetchJson(
    `http://127.0.0.1:${bridge.port}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: integrityCollectorCode(schematicPageUuid, pcbUuid),
        windowId,
      }),
    },
    35000,
  );
  if (!response.success || !response.result) {
    throw new Error(response.error || "PCB data-plane integrity collection failed");
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
  const integrity = options.allowNativeCacheException
    ? await collectIntegrity(
        bridge,
        windowId,
        options.schematicPageUuid,
        options.pcbUuid,
      )
    : undefined;
  if (integrity && integrity.project.uuid !== schematic.project.uuid) {
    throw new Error("integrity views belong to a different project");
  }
  const pcbDataPlaneIntegrity = integrity
    ? comparePcbDataPlane(
        JSON.parse(schematic.netlist),
        integrity.internalNetlist,
        integrity.netNames,
        integrity.components,
      )
    : null;
  const nativeCacheException = verifyNativeCacheException({
    requested: options.allowNativeCacheException,
    manufacturingMatch: comparison.match,
    nativeDifferences,
    fileComparison: integrity?.nativeFileComparison,
    pcbDataPlane: pcbDataPlaneIntegrity,
    expectedNetNames: netNamesFromNetlist(JSON.parse(schematic.netlist)),
  });
  const decision = overallDecision(
    comparison.match,
    nativeDocumentComparison.status,
    options.requireNativeMatch,
    nativeCacheException.status,
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
    pcbDataPlaneIntegrity,
    nativeDocumentComparison,
    nativeFileComparison: integrity?.nativeFileComparison ?? null,
    nativeCacheException,
    nativeMatchRequired: options.requireNativeMatch,
    interpretation:
      "MATCH proves manufacturing-netlist component identity, core mapping, and pin-net equivalence. MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION additionally proves matching internal-netlist, direct net-name, direct component-pad, and native file-to-file views while preserving the beta document comparator's one-sided mismatch as an explicit exception; it is not a literal native document MATCH. Neither result authorizes fabrication or ordering.",
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
    decision === "MATCH" ||
    decision === "MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION"
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
  comparePcbDataPlane,
  compareNetlists,
  identityContractIssues,
  integrityCollectorCode,
  netNamesFromNetlist,
  overallDecision,
  parseArgs,
  summarizeNativeComparison,
  verifyNativeCacheException,
};

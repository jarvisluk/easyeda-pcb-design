#!/usr/bin/env node

/**
 * Read-only identity and hidden-netlist preflight for live EasyEDA builds.
 * Run after saving, switching away, and reopening the target documents.
 */

import {
  notAFabricationReleaseMessage,
} from "../lib/audit_common.mjs";
import {
  collectNativeComparison,
  identityContractIssues,
  summarizeNativeComparison,
} from "../audits/easyeda_netlist_compare.mjs";
import { appendToolFailureFromArgv, appendToolLogEntry } from "./lib/operation_log.mjs";
import { executeEasyedaCode, isMain, resolveOperationLogPath, writeNewJson } from "./lib/tool_runtime.mjs";

const EXIT = Object.freeze({ OK: 0, ERROR: 1, MISMATCH: 2, UNVERIFIED: 3 });
const DOCUMENT_TYPE = Object.freeze({ SCHEMATIC_PAGE: 1, PCB: 3 });
const CLI_STARTED_AT = new Date();
const DEFAULT_OUTPUT = "evidence/netlist/identity-preflight.json";

function usage() {
  return `Usage:
  node scripts/live/easyeda_identity_preflight.mjs \\
    --schematic-page-uuid UUID [options]

Options:
  --schematic-page-uuid UUID  Saved/reopened schematic page
  --schematic-uuid UUID       Parent schematic for native comparison
  --pcb-uuid UUID             PCB whose internal netlist views are checked
  --expected-part-count N     Require the exact live/exported part count
  --require-native-match      Return UNVERIFIED unless native comparison MATCHES
  --bridge-port PORT          Use one bridge port
  --window-id ID              Target a registered EasyEDA window
  --output FILE               Override evidence/netlist/identity-preflight.json
  --operation-log FILE        Override the log path derived from --output
  --force                     Overwrite an existing output file
  --self-test                 Run deterministic offline tests
  --help                      Show this help

The command is read-only apart from activating documents. Save, switch away,
and reopen the target before running it. It is not a fabrication release.
`;
}

function requiredValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new Error(`${option} requires a value`);
  return argv[index + 1];
}

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    schematicPageUuid: undefined,
    schematicUuid: undefined,
    pcbUuid: undefined,
    expectedPartCount: undefined,
    requireNativeMatch: false,
    bridgePort: undefined,
    windowId: undefined,
    output: DEFAULT_OUTPUT,
    operationLog: undefined,
    force: false,
    selfTest: false,
    help: false,
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
    } else if (option === "--expected-part-count") {
      options.expectedPartCount = positiveInteger(
        requiredValue(argv, index, option),
        option,
      );
      index += 1;
    } else if (option === "--require-native-match") {
      options.requireNativeMatch = true;
    } else if (option === "--bridge-port") {
      const port = positiveInteger(requiredValue(argv, index, option), option);
      if (port > 65535) throw new Error("--bridge-port must be at most 65535");
      options.bridgePort = port;
      index += 1;
    } else if (option === "--window-id") {
      options.windowId = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--output") {
      options.output = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--operation-log") {
      options.operationLog = requiredValue(argv, index, option);
      index += 1;
    } else if (option === "--force") {
      options.force = true;
    } else if (option === "--self-test") {
      options.selfTest = true;
    } else if (option === "--help" || option === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  if (!options.help && !options.selfTest && !options.schematicPageUuid) {
    throw new Error("--schematic-page-uuid is required");
  }
  if (
    !options.help &&
    !options.selfTest &&
    options.requireNativeMatch &&
    (!options.schematicUuid || !options.pcbUuid)
  ) {
    throw new Error(
      "--require-native-match requires --schematic-uuid and --pcb-uuid",
    );
  }
  return options;
}

function parseNetlist(value, label) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed?.components || typeof parsed.components !== "object") {
    throw new Error(`${label} must contain a components object`);
  }
  return parsed;
}

function parseInternalNetlistViews(raw) {
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const views = [];
  const parseErrors = [];
  for (let index = 0; index < entries.length; index += 1) {
    try {
      const netlist = parseNetlist(entries[index], `PCB internal view ${index}`);
      views.push({
        index,
        componentCount: Object.keys(netlist.components).length,
        netlist,
      });
    } catch (error) {
      parseErrors.push({
        index,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { views, parseErrors };
}

function identityRows(netlist) {
  return Object.entries(netlist.components)
    .map(([componentKey, component]) => ({
      componentKey,
      designator: String(component?.props?.Designator || ""),
      uniqueId: String(component?.props?.["Unique ID"] || ""),
    }))
    .sort((a, b) => a.componentKey.localeCompare(b.componentKey));
}

function identitySignature(netlist) {
  return JSON.stringify(identityRows(netlist));
}

function liveIdentityIssues(liveParts, schematicNetlist) {
  const issues = [];
  const designatorOwners = new Map();
  const uniqueIdOwners = new Map();
  const exportedByDesignator = new Map(
    identityRows(schematicNetlist).map((row) => [row.designator, row]),
  );
  for (const part of liveParts) {
    const designator = String(part.designator || "");
    const uniqueId = String(part.uniqueId || "");
    if (!designator) {
      issues.push({ code: "LIVE_MISSING_DESIGNATOR", primitiveId: part.primitiveId });
    } else if (designatorOwners.has(designator)) {
      issues.push({
        code: "LIVE_DUPLICATE_DESIGNATOR",
        primitiveId: part.primitiveId,
        designator,
        otherPrimitiveId: designatorOwners.get(designator),
      });
    } else {
      designatorOwners.set(designator, part.primitiveId);
    }
    if (!uniqueId) {
      issues.push({
        code: "LIVE_MISSING_UNIQUE_ID",
        primitiveId: part.primitiveId,
        designator,
      });
    } else if (uniqueIdOwners.has(uniqueId)) {
      issues.push({
        code: "LIVE_DUPLICATE_UNIQUE_ID",
        primitiveId: part.primitiveId,
        designator,
        uniqueId,
        otherPrimitiveId: uniqueIdOwners.get(uniqueId),
      });
    } else {
      uniqueIdOwners.set(uniqueId, part.primitiveId);
    }
    const exported = exportedByDesignator.get(designator);
    if (!exported) {
      issues.push({
        code: "LIVE_COMPONENT_MISSING_FROM_EXPORT",
        primitiveId: part.primitiveId,
        designator,
        uniqueId,
      });
    } else if (
      uniqueId !== exported.uniqueId ||
      exported.componentKey !== exported.uniqueId
    ) {
      issues.push({
        code: "LIVE_EXPORT_IDENTITY_MISMATCH",
        primitiveId: part.primitiveId,
        designator,
        liveUniqueId: uniqueId,
        exportedComponentKey: exported.componentKey,
        exportedUniqueId: exported.uniqueId,
      });
    }
  }
  return issues;
}

function analyzeIdentity({
  liveParts,
  schematicNetlist,
  pcbInternalRaw,
  pcbRequested = false,
  nativeDifferences,
  nativeRequested = false,
  requireNativeMatch = false,
  expectedPartCount,
}) {
  const schematic = parseNetlist(schematicNetlist, "schematic netlist");
  const issues = [
    ...identityContractIssues(schematic, "schematic"),
    ...liveIdentityIssues(liveParts, schematic),
  ];
  const exportedPartCount = Object.keys(schematic.components).length;
  if (
    expectedPartCount !== undefined &&
    (liveParts.length !== expectedPartCount ||
      exportedPartCount !== expectedPartCount)
  ) {
    issues.push({
      code: "EXPECTED_PART_COUNT_MISMATCH",
      expectedPartCount,
      livePartCount: liveParts.length,
      exportedPartCount,
    });
  }

  const internal = parseInternalNetlistViews(pcbInternalRaw);
  for (const parseError of internal.parseErrors) {
    issues.push({ code: "PCB_INTERNAL_VIEW_PARSE_ERROR", ...parseError });
  }
  const nonemptyViews = internal.views.filter((view) => view.componentCount > 0);
  if (pcbRequested && nonemptyViews.length === 0) {
    issues.push({ code: "PCB_INTERNAL_NETLIST_EMPTY" });
  }
  const schematicSignature = identitySignature(schematic);
  for (const view of nonemptyViews) {
    for (const issue of identityContractIssues(
      view.netlist,
      `pcb-internal-${view.index}`,
    )) {
      issues.push(issue);
    }
    if (identitySignature(view.netlist) !== schematicSignature) {
      issues.push({
        code: "PCB_INTERNAL_VIEW_DIVERGES",
        index: view.index,
        identities: identityRows(view.netlist),
      });
    }
  }

  const nativeDocumentComparison = summarizeNativeComparison(
    nativeDifferences,
    nativeRequested,
  );
  let decision = issues.length > 0 ? "MISMATCH" : "MATCH";
  if (nativeDocumentComparison.status === "MISMATCH") decision = "MISMATCH";
  if (
    decision === "MATCH" &&
    requireNativeMatch &&
    nativeDocumentComparison.status !== "MATCH"
  ) {
    decision = "UNVERIFIED";
  }
  return {
    decision,
    expectedPartCount: expectedPartCount ?? null,
    livePartCount: liveParts.length,
    exportedPartCount,
    schematicIdentities: identityRows(schematic),
    pcbInternalViewCount: internal.views.length,
    pcbNonemptyInternalViewCount: nonemptyViews.length,
    pcbEmptyInternalViewIndexes: internal.views
      .filter((view) => view.componentCount === 0)
      .map((view) => view.index),
    issues,
    nativeDocumentComparison,
  };
}

function schematicCollectorCode(documentUuid) {
  return `
await eda.dmt_EditorControl.openDocument(${JSON.stringify(documentUuid)});
const project = await eda.dmt_Project.getCurrentProjectInfo();
const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!project || !document || document.uuid !== ${JSON.stringify(documentUuid)}) {
  throw new Error("requested schematic page did not become active");
}
if (document.documentType !== ${DOCUMENT_TYPE.SCHEMATIC_PAGE}) {
  throw new Error("unexpected schematic document type: " + document.documentType);
}
const value = (object, method, property) =>
  typeof object[method] === "function" ? object[method]() : object[property];
const raw = await eda.sch_PrimitiveComponent.getAll();
const parts = raw.filter((component) => {
  const type = value(component, "getState_ComponentType", "componentType");
  return type === undefined || type === "part";
});
const file = await eda.sch_ManufactureData.getNetlistFile(
  "IDENTITY_PREFLIGHT",
  "JLCEDA",
);
if (!file) throw new Error("schematic netlist export returned no file");
return {
  project: { uuid: project.uuid, name: project.friendlyName || project.name || "" },
  document,
  liveParts: parts.map((part) => ({
    primitiveId: value(part, "getState_PrimitiveId", "primitiveId"),
    designator: value(part, "getState_Designator", "designator") || "",
    uniqueId: value(part, "getState_UniqueId", "uniqueId") || "",
  })),
  netlist: await file.text(),
};
`;
}

function pcbCollectorCode(documentUuid) {
  return `
await eda.dmt_EditorControl.openDocument(${JSON.stringify(documentUuid)});
const project = await eda.dmt_Project.getCurrentProjectInfo();
const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!project || !document || document.uuid !== ${JSON.stringify(documentUuid)}) {
  throw new Error("requested PCB did not become active");
}
if (document.documentType !== ${DOCUMENT_TYPE.PCB}) {
  throw new Error("unexpected PCB document type: " + document.documentType);
}
return {
  project: { uuid: project.uuid, name: project.friendlyName || project.name || "" },
  document,
  internalNetlist: await eda.pcb_Net.getNetlist("JLCEDA"),
};
`;
}

async function collectCode(bridgePort, windowId, code, label) {
  const call = await executeEasyedaCode({ code, bridgePort, windowId, timeoutMs: 35_000 });
  const { response } = call;
  if (!response.success || !response.result) {
    throw new Error(response.error || `${label} collection failed`);
  }
  return { ...call, result: response.result };
}

function stableFixture(uniqueId = "gge1") {
  return {
    components: {
      [uniqueId]: {
        props: { "Unique ID": uniqueId, Designator: "U1" },
        pinInfoMap: { 1: { net: "GND" } },
      },
    },
  };
}

function runSelfTest() {
  const stable = stableFixture();
  const pass = analyzeIdentity({
    liveParts: [{ primitiveId: "p1", designator: "U1", uniqueId: "gge1" }],
    schematicNetlist: stable,
    pcbInternalRaw: [JSON.stringify(stable), JSON.stringify({ components: {} })],
    pcbRequested: true,
    nativeDifferences: [],
    nativeRequested: true,
    requireNativeMatch: true,
    expectedPartCount: 1,
  });
  if (pass.decision !== "MATCH") throw new Error("stable identity fixture failed");
  const stale = analyzeIdentity({
    liveParts: [{ primitiveId: "p1", designator: "U1", uniqueId: "gge1" }],
    schematicNetlist: stable,
    pcbInternalRaw: [JSON.stringify(stableFixture("UNIQUEU1"))],
    pcbRequested: true,
  });
  if (stale.decision !== "MISMATCH") {
    throw new Error("divergent internal identity fixture was accepted");
  }
}

async function main() {
  const startedAt = CLI_STARTED_AT;
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.selfTest) {
    runSelfTest();
    process.stdout.write("easyeda identity preflight self-test passed\n");
    return;
  }
  const schematicCall = await collectCode(
    options.bridgePort,
    options.windowId,
    schematicCollectorCode(options.schematicPageUuid),
    "schematic identity",
  );
  const { bridge, windowId } = schematicCall;
  const schematic = schematicCall.result;
  const pcb = options.pcbUuid
    ? (await collectCode(
        bridge.port,
        windowId,
        pcbCollectorCode(options.pcbUuid),
        "PCB internal identity",
      )).result
    : undefined;
  if (pcb && pcb.project.uuid !== schematic.project.uuid) {
    throw new Error("schematic and PCB belong to different projects");
  }
  const nativeDifferences = options.pcbUuid
    ? await collectNativeComparison(
        bridge,
        windowId,
        options.schematicUuid,
        options.pcbUuid,
      )
    : undefined;
  const analysis = analyzeIdentity({
    liveParts: schematic.liveParts,
    schematicNetlist: schematic.netlist,
    pcbInternalRaw: pcb?.internalNetlist,
    pcbRequested: Boolean(options.pcbUuid),
    nativeDifferences,
    nativeRequested: Boolean(options.schematicUuid && options.pcbUuid),
    requireNativeMatch: options.requireNativeMatch,
    expectedPartCount: options.expectedPartCount,
  });
  const report = {
    schemaVersion: 1,
    kind: "easyeda-live-identity-preflight",
    decision: analysis.decision,
    fabricationRelease: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
    bridge: { port: bridge.port, windowId, health: bridge.health },
    project: schematic.project,
    schematic: { uuid: schematic.document.uuid },
    pcb: options.pcbUuid ? { uuid: pcb.document.uuid } : null,
    reopenAttestation:
      "Caller must save, switch away, and reopen each target before this read-only check.",
    analysis,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const output = await writeNewJson(options.output, report, { force: options.force });
  const endedAt = new Date();
  await appendToolLogEntry(resolveOperationLogPath(options.operationLog, options.output), {
    tool: "easyeda_identity_preflight.mjs",
    gate: "SCHEMATIC_IDENTITY_STABLE",
    operation: "saved/reopened schematic and PCB identity preflight",
    outcome: "READ_ONLY",
    semanticReadback: `${analysis.decision}; project ${schematic.project.uuid}; schematic ${schematic.document.uuid}; PCB ${pcb?.document?.uuid || "not requested"}`,
    startedAt,
    endedAt,
    attemptDisposition: analysis.decision === "MATCH" ? "ACCEPTED" : analysis.decision === "MISMATCH" ? "REJECTED" : "UNKNOWN",
    gateProgress: analysis.decision === "MATCH" ? "CLOSED" : analysis.decision === "MISMATCH" ? "BLOCKED" : "NO_CHANGE",
    evidence: [output],
  });
  process.stdout.write(text);
  process.exitCode =
    analysis.decision === "MATCH"
      ? EXIT.OK
      : analysis.decision === "UNVERIFIED"
        ? EXIT.UNVERIFIED
        : EXIT.MISMATCH;
}

if (isMain(import.meta.url)) {
  main().catch(async (error) => {
    await appendToolFailureFromArgv(process.argv.slice(2), {
      tool: "easyeda_identity_preflight.mjs", gate: "SCHEMATIC_IDENTITY_STABLE", startedAt: CLI_STARTED_AT, error,
      defaultOutput: DEFAULT_OUTPUT,
    }).catch(() => {});
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.ERROR;
  });
}

export {
  EXIT,
  analyzeIdentity,
  identityRows,
  identitySignature,
  liveIdentityIssues,
  parseArgs,
  parseInternalNetlistViews,
  pcbCollectorCode,
  schematicCollectorCode,
};

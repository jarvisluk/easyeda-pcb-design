#!/usr/bin/env node

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import {
  fetchJson,
  findBridge,
  resolveSafeOutputPath,
  resolveWindow,
} from "./audit_common.mjs";

const PCB_DOCUMENT_TYPE = 3;

function usage() {
  return `Usage:
  node scripts/easyeda_repair_snapshot.mjs --output FILE [options]

Options:
  --bridge-port PORT  Use one bridge port instead of scanning
  --window-id ID      Required when multiple EasyEDA windows exist
  --output FILE       Relative path under cwd for immutable semantic evidence
  --self-test         Run deterministic offline checks
  --help              Show this help
`;
}

function parseArgs(argv) {
  const options = {
    bridgePort: undefined,
    windowId: undefined,
    output: undefined,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} requires a value`);
      return argv[index];
    };
    if (option === "--bridge-port") options.bridgePort = Number(next());
    else if (option === "--window-id") options.windowId = next();
    else if (option === "--output") options.output = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`unknown option: ${option}`);
  }
  if (
    options.bridgePort !== undefined &&
    (!Number.isInteger(options.bridgePort) || options.bridgePort < 1 || options.bridgePort > 65535)
  ) {
    throw new Error("--bridge-port must be an integer from 1 to 65535");
  }
  if (!options.selfTest && !options.output) throw new Error("--output is required");
  return options;
}

function collectorCode() {
  return `
const project = await eda.dmt_Project.getCurrentProjectInfo();
if (!project) throw new Error("No EasyEDA project is open");
const documentInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!documentInfo || documentInfo.documentType !== ${PCB_DOCUMENT_TYPE}) {
  throw new Error("The active EasyEDA document is not a PCB");
}
const value = (object, methodName, propertyName) =>
  typeof object?.[methodName] === "function"
    ? object[methodName]()
    : object?.[propertyName];
const components = await eda.pcb_PrimitiveComponent.getAll();
const componentData = [];
for (const component of components) {
  const pins = await component.getAllPins();
  componentData.push({
    id: value(component, "getState_PrimitiveId", "primitiveId"),
    designator: value(component, "getState_Designator", "designator") || "",
    uniqueId: value(component, "getState_UniqueId", "uniqueId") || "",
    layer: value(component, "getState_Layer", "layer"),
    x: value(component, "getState_X", "x"),
    y: value(component, "getState_Y", "y"),
    rotation: value(component, "getState_Rotation", "rotation"),
    pins: (pins || []).map((pin) => ({
      id: value(pin, "getState_PrimitiveId", "primitiveId"),
      padNumber: value(pin, "getState_PadNumber", "padNumber") || "",
      net: value(pin, "getState_Net", "net") || "",
      layer: value(pin, "getState_Layer", "layer"),
      x: value(pin, "getState_X", "x"),
      y: value(pin, "getState_Y", "y"),
    })),
  });
}
const lines = (await eda.pcb_PrimitiveLine.getAll()).map((line) => ({
  id: value(line, "getState_PrimitiveId", "primitiveId"),
  net: value(line, "getState_Net", "net") || "",
  layer: value(line, "getState_Layer", "layer"),
  startX: value(line, "getState_StartX", "startX"),
  startY: value(line, "getState_StartY", "startY"),
  endX: value(line, "getState_EndX", "endX"),
  endY: value(line, "getState_EndY", "endY"),
  lineWidth: value(line, "getState_LineWidth", "lineWidth"),
  locked: Boolean(value(line, "getState_PrimitiveLock", "primitiveLock")),
}));
const arcs = (await eda.pcb_PrimitiveArc.getAll()).map((arc) => ({
  id: value(arc, "getState_PrimitiveId", "primitiveId"),
  net: value(arc, "getState_Net", "net") || "",
  layer: value(arc, "getState_Layer", "layer"),
  startX: value(arc, "getState_StartX", "startX"),
  startY: value(arc, "getState_StartY", "startY"),
  endX: value(arc, "getState_EndX", "endX"),
  endY: value(arc, "getState_EndY", "endY"),
  arcAngle: value(arc, "getState_ArcAngle", "arcAngle"),
  lineWidth: value(arc, "getState_LineWidth", "lineWidth"),
  locked: Boolean(value(arc, "getState_PrimitiveLock", "primitiveLock")),
}));
const polylines = (await eda.pcb_PrimitivePolyline.getAll()).map((polyline) => ({
  id: value(polyline, "getState_PrimitiveId", "primitiveId"),
  net: value(polyline, "getState_Net", "net") || "",
  layer: value(polyline, "getState_Layer", "layer"),
  polygon: value(polyline, "getState_Polygon", "polygon"),
  lineWidth: value(polyline, "getState_LineWidth", "lineWidth"),
  locked: Boolean(value(polyline, "getState_PrimitiveLock", "primitiveLock")),
}));
const vias = (await eda.pcb_PrimitiveVia.getAll()).map((via) => ({
  id: value(via, "getState_PrimitiveId", "primitiveId"),
  net: value(via, "getState_Net", "net") || "",
  x: value(via, "getState_X", "x"),
  y: value(via, "getState_Y", "y"),
  holeDiameter: value(via, "getState_HoleDiameter", "holeDiameter"),
  diameter: value(via, "getState_Diameter", "diameter"),
  viaType: value(via, "getState_ViaType", "viaType"),
  blindViaRule: value(via, "getState_DesignRuleBlindViaName", "designRuleBlindViaName") || null,
  locked: Boolean(value(via, "getState_PrimitiveLock", "primitiveLock")),
}));
const pours = [];
for (const pour of await eda.pcb_PrimitivePour.getAll()) {
  const poured = await pour.getCopperRegion();
  pours.push({
    id: value(pour, "getState_PrimitiveId", "primitiveId"),
    net: value(pour, "getState_Net", "net") || "",
    layer: value(pour, "getState_Layer", "layer"),
    complexPolygon: value(pour, "getState_ComplexPolygon", "complexPolygon"),
    pourFillMethod: value(pour, "getState_PourFillMethod", "pourFillMethod"),
    preserveSilos: Boolean(value(pour, "getState_PreserveSilos", "preserveSilos")),
    pourName: value(pour, "getState_PourName", "pourName") || "",
    pourPriority: value(pour, "getState_PourPriority", "pourPriority"),
    lineWidth: value(pour, "getState_LineWidth", "lineWidth"),
    locked: Boolean(value(pour, "getState_PrimitiveLock", "primitiveLock")),
    poured: poured ? {
      id: value(poured, "getState_PrimitiveId", "primitiveId"),
      pourPrimitiveId: value(poured, "getState_PourPrimitiveId", "pourPrimitiveId"),
      pourFills: value(poured, "getState_PourFills", "pourFills") || [],
    } : null,
  });
}
const drc = await eda.pcb_Drc.check(true, false, true);
return {
  schemaVersion: 1,
  kind: "easyeda-existing-board-repair-semantic-capture",
  fabricationRelease: false,
  rollbackCapability: "SEMANTIC_EVIDENCE_ONLY",
  closesRollbackSnapshotVerified: false,
  evidenceCapabilities: {
    supportsDerivedFillRegenerationEvidence: true,
    supportsSourcePrimitiveRestoration: false,
  },
  limitations: [
    "This JSON is semantic audit and inverse-transaction evidence, not a restorable EasyEDA document backup.",
    "Authorization comes from the selected project profile; this capture does not grant it.",
    "When exact source Pour definitions remain, this capture can support bounded derived-fill regeneration evidence under AI_DEDICATED.",
    "It cannot by itself close rollback for deletion of source primitives or the only recoverable project revision.",
    "Primitive restoration remains API- and version-dependent even when affected geometry is recorded.",
  ],
  capturedAt: new Date().toISOString(),
  project: {
    uuid: project.uuid,
    name: project.friendlyName || project.name || "",
  },
  document: {
    uuid: documentInfo.uuid,
    name: documentInfo.name || documentInfo.friendlyName || "",
    documentType: documentInfo.documentType,
  },
  components: componentData,
  lines,
  arcs,
  polylines,
  vias,
  pours,
  drc,
};`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    assert.throws(() => parseArgs([]), /--output is required/);
    assert.equal(parseArgs(["--output", "snapshot.json"]).output, "snapshot.json");
    assert.throws(() => parseArgs(["--output", "snapshot.json", "--force"]), /unknown option/);
    assert.match(collectorCode(), /easyeda-existing-board-repair-semantic-capture/);
    assert.match(collectorCode(), /closesRollbackSnapshotVerified: false/);
    assert.match(collectorCode(), /supportsDerivedFillRegenerationEvidence: true/);
    assert.match(collectorCode(), /supportsSourcePrimitiveRestoration: false/);
    assert.match(collectorCode(), /pcb_PrimitiveLine\.getAll/);
    assert.match(collectorCode(), /pcb_PrimitiveArc\.getAll/);
    assert.match(collectorCode(), /pcb_PrimitivePour\.getAll/);
    process.stdout.write("easyeda repair semantic capture self-test passed\n");
    return;
  }
  const outputPath = resolveSafeOutputPath(options.output, false);
  const bridge = await findBridge(options.bridgePort);
  const window = await resolveWindow(bridge, options.windowId);
  const response = await fetchJson(
    `http://127.0.0.1:${bridge.port}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: collectorCode(), windowId: window.windowId }),
    },
    120_000,
  );
  if (!response.success) throw new Error(response.error || "EasyEDA execution failed");
  const snapshot = {
    ...response.result,
    bridge: { port: bridge.port, windowId: response.windowId || window.windowId },
  };
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    project: snapshot.project,
    document: snapshot.document,
    componentCount: snapshot.components.length,
    lineCount: snapshot.lines.length,
    arcCount: snapshot.arcs.length,
    polylineCount: snapshot.polylines.length,
    viaCount: snapshot.vias.length,
    pourCount: snapshot.pours.length,
    rollbackCapability: snapshot.rollbackCapability,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

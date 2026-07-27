#!/usr/bin/env node

/**
 * Baseline schematic/PCB audit through the easyeda-api bridge.
 *
 * The checks are deterministic rule checks. They do not replace electrical,
 * mechanical, current-capacity, or manufacturing review.
 */

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_PORTS = Array.from({ length: 10 }, (_, index) => 49620 + index);
const DECISIONS = Object.freeze({
  PASS: "PASS",
  PASS_WITH_EXCEPTIONS: "PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS",
  FAIL: "FAIL",
});

function usage() {
  return `Usage:
  node easyeda_design_audit.mjs [options]

Options:
  --ground-net NET             Ground/reference net (default: GND)
  --allow-no-ground-pour       Do not fail a PCB with no valid ground pour
  --allow-nonstandard-angle    Report but do not fail arbitrary-angle tracks
  --bridge-port PORT           Use one port instead of scanning 49620-49629
  --window-id ID               Target a registered EasyEDA window
  --output FILE                Also save the JSON report
  --self-test                  Run PCB and schematic offline tests
  --help                       Show this help
`;
}

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`${option} requires an integer from 1 to 65535`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    groundNet: "GND",
    requireGroundPour: true,
    allowNonstandardAngle: false,
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

    if (option === "--ground-net") options.groundNet = next();
    else if (option === "--allow-no-ground-pour") options.requireGroundPour = false;
    else if (option === "--allow-nonstandard-angle") {
      options.allowNonstandardAngle = true;
    } else if (option === "--bridge-port") {
      options.bridgePort = positiveInteger(next(), option);
    } else if (option === "--window-id") options.windowId = next();
    else if (option === "--output") options.output = next();
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  return options;
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

async function findBridge(explicitPort) {
  const ports = explicitPort ? [explicitPort] : DEFAULT_PORTS;
  const results = await Promise.all(
    ports.map(async (port) => {
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
  if (windows.length === 0) throw new Error("no connected EasyEDA window was registered");
  throw new Error(
    `multiple EasyEDA windows are connected (${windows
      .map((item) => item.windowId)
      .join(", ")}); specify --window-id`,
  );
}

function collectorCode() {
  return `
const project = await eda.dmt_Project.getCurrentProjectInfo();
if (!project) throw new Error("No EasyEDA project is open");
const documentInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (!documentInfo) throw new Error("No EasyEDA document is active");

const value = (object, methodName, propertyName) => {
  if (typeof object[methodName] === "function") return object[methodName]();
  return object[propertyName];
};
const base = {
  project: {
    uuid: project.uuid,
    name: project.friendlyName || project.name || "",
  },
  document: {
    uuid: documentInfo.uuid,
    name: documentInfo.name || documentInfo.friendlyName || "",
    documentType: documentInfo.documentType,
  },
};

if (documentInfo.documentType === EDMT_EditorDocumentType.SCHEMATIC_PAGE) {
  const components = await eda.sch_PrimitiveComponent.getAll();
  const wires = await eda.sch_PrimitiveWire.getAll();
  const drc = await eda.sch_Drc.check(true, false, true);
  return {
    ...base,
    kind: "schematic",
    components: components.map((component) => ({
      primitiveId: value(component, "getState_PrimitiveId", "primitiveId"),
      designator: value(component, "getState_Designator", "designator") || "",
      name: value(component, "getState_Name", "name") || "",
      addIntoPcb: value(component, "getState_AddIntoPcb", "addIntoPcb"),
      footprint: value(component, "getState_Footprint", "footprint") || null,
    })),
    wireCount: wires.length,
    drc,
  };
}

if (documentInfo.documentType === EDMT_EditorDocumentType.PCB) {
  const layers = await eda.pcb_Layer.getAllLayers();
  const components = await eda.pcb_PrimitiveComponent.getAll();
  const lines = await eda.pcb_PrimitiveLine.getAll();
  const arcs = await eda.pcb_PrimitiveArc.getAll();
  const vias = await eda.pcb_PrimitiveVia.getAll();
  const pours = await eda.pcb_PrimitivePour.getAll();

  const lineData = lines
    .map((line) => ({
      primitiveId: value(line, "getState_PrimitiveId", "primitiveId"),
      net: value(line, "getState_Net", "net") || "",
      layer: value(line, "getState_Layer", "layer"),
      lineWidth: value(line, "getState_LineWidth", "lineWidth"),
      startX: value(line, "getState_StartX", "startX"),
      startY: value(line, "getState_StartY", "startY"),
      endX: value(line, "getState_EndX", "endX"),
      endY: value(line, "getState_EndY", "endY"),
    }))
    .filter((line) =>
      [line.startX, line.startY, line.endX, line.endY].every(Number.isFinite)
    );
  const arcData = arcs.map((arc) => ({
    primitiveId: value(arc, "getState_PrimitiveId", "primitiveId"),
    net: value(arc, "getState_Net", "net") || "",
    layer: value(arc, "getState_Layer", "layer"),
    arcAngle: value(arc, "getState_ArcAngle", "arcAngle"),
  }));
  const pourData = [];
  for (const pour of pours) {
    const copper = await pour.getCopperRegion();
    const fills = copper ? copper.getState_PourFills() : [];
    pourData.push({
      primitiveId: value(pour, "getState_PrimitiveId", "primitiveId"),
      name: value(pour, "getState_PourName", "pourName") || "",
      net: value(pour, "getState_Net", "net") || "",
      layer: value(pour, "getState_Layer", "layer"),
      preserveSilos: Boolean(
        value(pour, "getState_PreserveSilos", "preserveSilos")
      ),
      hasCopper: Boolean(copper),
      fillCount: fills.length,
      solidFillCount: fills.filter((fill) => fill && fill.fill === true).length,
    });
  }
  const drc = await eda.pcb_Drc.check(true, false, true);
  return {
    ...base,
    kind: "pcb",
    boardOutlineLayerId: EPCB_LayerId.BOARD_OUTLINE,
    layers: layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      type: layer.type,
    })),
    components: components.map((component) => ({
      primitiveId: value(component, "getState_PrimitiveId", "primitiveId"),
      designator: value(component, "getState_Designator", "designator") || "",
      layer: value(component, "getState_Layer", "layer"),
      x: value(component, "getState_X", "x"),
      y: value(component, "getState_Y", "y"),
    })),
    lines: lineData,
    arcs: arcData,
    viaCount: vias.length,
    pours: pourData,
    drc,
  };
}

throw new Error(
  "Active document must be a schematic page or PCB; received type " +
    documentInfo.documentType
);`;
}

async function collectFromEasyEda(bridge, windowId) {
  const payload = { code: collectorCode(), windowId };
  const response = await fetchJson(
    `http://127.0.0.1:${bridge.port}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    120_000,
  );
  if (!response.success) throw new Error(response.error || "EasyEDA execution failed");
  return { raw: response.result, windowId: response.windowId };
}

function summarizeDrc(drc) {
  if (typeof drc === "boolean") {
    return { passed: drc, errorCount: drc ? 0 : null, errors: [] };
  }
  if (Array.isArray(drc)) {
    return { passed: drc.length === 0, errorCount: drc.length, errors: drc };
  }
  return {
    passed: false,
    errorCount: null,
    errors: [],
    note: "Unexpected DRC response; inspect EasyEDA manually",
  };
}

function designatorIssues(components) {
  const missing = components
    .filter((component) => !component.designator)
    .map((component) => component.primitiveId);
  const byDesignator = new Map();
  for (const component of components.filter((item) => item.designator)) {
    if (!byDesignator.has(component.designator)) byDesignator.set(component.designator, []);
    byDesignator.get(component.designator).push(component.primitiveId);
  }
  const duplicates = [...byDesignator.entries()]
    .filter(([, primitiveIds]) => primitiveIds.length > 1)
    .map(([designator, primitiveIds]) => ({ designator, primitiveIds }));
  return { missing, duplicates };
}

function analyzeSchematic(raw, source) {
  const drc = summarizeDrc(raw.drc);
  const designators = designatorIssues(raw.components || []);
  const missingFootprints = (raw.components || [])
    .filter((component) => component.addIntoPcb === true && !component.footprint)
    .map((component) => ({
      primitiveId: component.primitiveId,
      designator: component.designator,
      name: component.name,
    }));
  const failures = [];
  if (!drc.passed) failures.push("schematic DRC did not pass");
  if (designators.missing.length) failures.push("one or more components lack designators");
  if (designators.duplicates.length) failures.push("duplicate component designators exist");
  if (missingFootprints.length) {
    failures.push("one or more PCB-included components lack footprints");
  }

  return {
    schemaVersion: 1,
    evidence: "RULE_CHECK",
    decision: failures.length ? DECISIONS.FAIL : DECISIONS.PASS_WITH_EXCEPTIONS,
    kind: "schematic",
    source,
    generatedAt: new Date().toISOString(),
    design: {
      project: raw.project,
      document: raw.document,
      componentCount: (raw.components || []).length,
      wireCount: raw.wireCount || 0,
    },
    checks: { drc, designators, missingFootprints },
    failures,
    limitations: [
      "DRC and metadata do not prove the circuit topology, values, ratings, pin mapping, or connector mating view.",
      "Power integrity, protection, reset/boot states, clocks, and no-connect intent require schematic review.",
    ],
  };
}

function analyzePcb(raw, options, source) {
  const tolerance = 0.05;
  const drc = summarizeDrc(raw.drc);
  const designators = designatorIssues(raw.components || []);
  const layerById = new Map((raw.layers || []).map((layer) => [layer.id, layer]));
  const outlineLayerIds = new Set(
    (raw.layers || [])
      .filter(
        (layer) =>
          layer.id === raw.boardOutlineLayerId ||
          /board.*outline|outline.*board|板框/i.test(layer.name || ""),
      )
      .map((layer) => layer.id),
  );
  const outlineLines = (raw.lines || []).filter((line) => outlineLayerIds.has(line.layer));
  const outlineArcs = (raw.arcs || []).filter((arc) => outlineLayerIds.has(arc.layer));
  const routedLines = (raw.lines || []).filter((line) => line.net);
  const routedArcs = (raw.arcs || []).filter((arc) => arc.net);
  const nonStandardAngles = routedLines
    .filter((line) => {
      const dx = Math.abs(line.endX - line.startX);
      const dy = Math.abs(line.endY - line.startY);
      return dx > tolerance && dy > tolerance && Math.abs(dx - dy) > tolerance;
    })
    .map((line) => ({
      primitiveId: line.primitiveId,
      net: line.net,
      layer: line.layer,
      layerName: layerById.get(line.layer)?.name || "",
      angleDeg: Number(
        ((Math.atan2(line.endY - line.startY, line.endX - line.startX) * 180) / Math.PI)
          .toFixed(3),
      ),
    }));
  const pours = (raw.pours || []).map((pour) => ({
    ...pour,
    passed:
      pour.hasCopper &&
      pour.fillCount > 0 &&
      pour.solidFillCount > 0 &&
      !pour.preserveSilos,
  }));
  const validGroundPour = pours.some(
    (pour) => pour.net === options.groundNet && pour.passed,
  );

  const failures = [];
  if (!drc.passed) failures.push("PCB DRC did not pass");
  if (!outlineLines.length && !outlineArcs.length) {
    failures.push("no board-outline line or arc primitives were found");
  }
  if (designators.missing.length) failures.push("one or more PCB components lack designators");
  if (designators.duplicates.length) failures.push("duplicate PCB component designators exist");
  if (nonStandardAngles.length && !options.allowNonstandardAngle) {
    failures.push(
      `${nonStandardAngles.length} routed segment(s) are not 0/45/90 degrees`,
    );
  }
  if (pours.some((pour) => !pour.passed)) {
    failures.push("one or more copper pours are unfilled or preserve islands");
  }
  if (options.requireGroundPour && !validGroundPour) {
    failures.push(`no valid filled ${options.groundNet} pour was found`);
  }

  const warnings = [];
  if (routedArcs.length) {
    warnings.push(
      `${routedArcs.length} routed arc(s) require visual geometry and manufacturability review`,
    );
  }
  if (!options.requireGroundPour && !validGroundPour) {
    warnings.push(`no valid filled ${options.groundNet} pour was found by design`);
  }

  return {
    schemaVersion: 1,
    evidence: "RULE_CHECK",
    decision: failures.length ? DECISIONS.FAIL : DECISIONS.PASS_WITH_EXCEPTIONS,
    kind: "pcb",
    source,
    generatedAt: new Date().toISOString(),
    design: {
      project: raw.project,
      document: raw.document,
      layerCount: (raw.layers || []).length,
      componentCount: (raw.components || []).length,
      routedLineCount: routedLines.length,
      routedArcCount: routedArcs.length,
      viaCount: raw.viaCount || 0,
      pourCount: pours.length,
      outlinePrimitiveCount: outlineLines.length + outlineArcs.length,
    },
    constraints: {
      groundNet: options.groundNet,
      requireGroundPour: options.requireGroundPour,
      allowNonstandardAngle: options.allowNonstandardAngle,
    },
    checks: {
      drc,
      designators,
      nonStandardAngles,
      pours,
      validGroundPour,
      outline: {
        lineCount: outlineLines.length,
        arcCount: outlineArcs.length,
        candidateLayerIds: [...outlineLayerIds],
      },
    },
    failures,
    warnings,
    limitations: [
      "The audit does not prove that the board outline is one closed, non-self-intersecting contour.",
      "Unrouted connections and netlist equivalence must be confirmed in EasyEDA.",
      "DRC does not prove current capacity, thermal behavior, return-path quality, placement quality, polarity, or mechanical fit.",
      "Manufacturing outputs, BOM, and pick-and-place files require separate revision-matched review.",
    ],
  };
}

function analyze(raw, options, source) {
  if (raw.kind === "schematic") return analyzeSchematic(raw, source);
  if (raw.kind === "pcb") return analyzePcb(raw, options, source);
  throw new Error(`unsupported audit kind: ${raw.kind}`);
}

function pcbFixture() {
  return {
    kind: "pcb",
    project: { uuid: "self-test", name: "Self Test" },
    document: { uuid: "pcb", name: "PCB", documentType: 3 },
    boardOutlineLayerId: 11,
    layers: [
      { id: 1, name: "Top Layer" },
      { id: 2, name: "Bottom Layer" },
      { id: 11, name: "Renamed Mechanical Contour" },
    ],
    components: [
      { primitiveId: "u1", designator: "U1", layer: 1, x: 100, y: 100 },
    ],
    lines: [
      {
        primitiveId: "outline1",
        net: "",
        layer: 11,
        startX: 0,
        startY: 0,
        endX: 1000,
        endY: 0,
      },
      {
        primitiveId: "track1",
        net: "3V3",
        layer: 1,
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 0,
      },
    ],
    arcs: [],
    viaCount: 0,
    pours: [
      {
        primitiveId: "pour1",
        name: "GND_BOTTOM",
        net: "GND",
        layer: 2,
        preserveSilos: false,
        hasCopper: true,
        fillCount: 1,
        solidFillCount: 1,
      },
    ],
    drc: [],
  };
}

function schematicFixture() {
  return {
    kind: "schematic",
    project: { uuid: "self-test", name: "Self Test" },
    document: { uuid: "sch", name: "Schematic", documentType: 1 },
    components: [
      {
        primitiveId: "u1",
        designator: "U1",
        name: "MCU",
        addIntoPcb: true,
        footprint: { libraryUuid: "lib", uuid: "fp", name: "LQFP48" },
      },
    ],
    wireCount: 12,
    drc: [],
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) {
      const pcb = analyze(pcbFixture(), options, { kind: "self-test" });
      const schematic = analyze(schematicFixture(), options, { kind: "self-test" });
      const failingPcbFixture = pcbFixture();
      failingPcbFixture.lines.push({
        primitiveId: "bad-angle",
        net: "SIGNAL",
        layer: 1,
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 37,
      });
      const failingSchematicFixture = schematicFixture();
      failingSchematicFixture.components[0].footprint = null;
      const failingPcb = analyze(failingPcbFixture, options, {
        kind: "self-test-negative",
      });
      const failingSchematic = analyze(failingSchematicFixture, options, {
        kind: "self-test-negative",
      });
      if (
        pcb.decision !== DECISIONS.PASS_WITH_EXCEPTIONS ||
        schematic.decision !== DECISIONS.PASS_WITH_EXCEPTIONS ||
        failingPcb.decision !== DECISIONS.FAIL ||
        failingSchematic.decision !== DECISIONS.FAIL
      ) {
        throw new Error("self-test pass/fail fixtures produced unexpected decisions");
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            pcb,
            schematic,
            negativeTests: {
              pcbDecision: failingPcb.decision,
              schematicDecision: failingSchematic.decision,
            },
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const bridge = await findBridge(options.bridgePort);
    const windowId = await resolveWindow(bridge, options.windowId);
    const collected = await collectFromEasyEda(bridge, windowId);
    const report = analyze(collected.raw, options, {
      kind: "easyeda-bridge",
      port: bridge.port,
      windowId: collected.windowId,
      bridgeHealth: bridge.health,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) await writeFile(options.output, serialized, "utf8");
    process.stdout.write(serialized);
    if (report.decision === DECISIONS.FAIL) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          evidence: "RULE_CHECK",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

export {
  DECISIONS,
  analyze,
  analyzePcb,
  analyzeSchematic,
  collectorCode,
  parseArgs,
  pcbFixture,
  resolveWindow,
  schematicFixture,
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

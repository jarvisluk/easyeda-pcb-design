#!/usr/bin/env node

/**
 * Baseline schematic/PCB audit through the easyeda-api bridge.
 *
 * The checks are deterministic rule checks. They do not replace electrical,
 * mechanical, current-capacity, or manufacturing review. Bare PASS is never
 * emitted; a non-failing result is not a fabrication release.
 */

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  DECISION_VALUES,
  EXIT,
  applyDecisionExitCode,
  constraintFingerprint,
  crystalNetHints,
  designFingerprint,
  fetchJson,
  findBridge,
  highSpeedDiscovery,
  nonemptyString,
  notAFabricationReleaseMessage,
  readCrystalClearanceReport,
  readHighSpeedClearanceReport,
  resolveManufacturingReview,
  resolveSafeOutputPath,
  resolveWindow,
} from "./audit_common.mjs";

const DECISIONS = DECISION_VALUES;
// The bridge execution sandbox does not expose enum globals. These values are
// copied from the exact EDMT_EditorDocumentType reference bundled with
// easyeda-api, rather than guessed at call sites.
const DOCUMENT_TYPE = Object.freeze({
  SCHEMATIC_PAGE: 1,
  PCB: 3,
});

function usage() {
  return `Usage:
  node easyeda_design_audit.mjs [options]

Options:
  --ground-net NET                  Ground/reference net (default: GND)
  --allow-no-ground-pour            Do not fail a PCB with no valid ground pour
  --allow-nonstandard-angle         Report but do not fail arbitrary-angle tracks
  --allow-routing-cycle NET         Allow intentional explicit-routing cycles on NET
                                      (repeatable; requires --exception-note)
  --exception-note TEXT             Required with any --allow-* flag
  --crystal-audit-report FILE       Clear crystal/clock net hints using its audit JSON
  --high-speed-constraints FILE     Revision-controlled HS interface constraints
  --high-speed-audit-report FILE    Clear HS-net hints using a prior HS audit JSON
  --manufacturing-reviewed          Mark Gerber/BOM/PnP reviewed (needs human attest)
  --attest-file FILE                Human attest file (see skill docs)
  --bridge-port PORT                Use one port instead of scanning 49620-49629
  --window-id ID                    Target a registered EasyEDA window
  --output FILE                     Relative path under cwd for the JSON report
  --force                           Overwrite an existing --output file
  --self-test                       Run PCB and schematic offline tests
  --help                            Show this help

Exit codes: 1=error, 2=FAIL, 3=UNVERIFIED FOR FABRICATION,
4=PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS (not a fab release).
Bare PASS is never emitted. Crystal/clock and HS-like net names force UNVERIFIED
unless their corresponding cleared audit reports are supplied.
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
    allowNoGroundPour: false,
    allowNonstandardAngle: false,
    allowRoutingCycleNets: [],
    exceptionNote: undefined,
    crystalAuditReport: undefined,
    highSpeedConstraints: undefined,
    highSpeedConstraintRecord: undefined,
    highSpeedAuditReport: undefined,
    manufacturingReviewed: false,
    attestFile: undefined,
    bridgePort: undefined,
    windowId: undefined,
    output: undefined,
    force: false,
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
    else if (option === "--allow-no-ground-pour") {
      options.allowNoGroundPour = true;
      options.requireGroundPour = false;
    } else if (option === "--allow-nonstandard-angle") {
      options.allowNonstandardAngle = true;
    } else if (option === "--allow-routing-cycle") {
      const net = next();
      if (!nonemptyString(net)) {
        throw new Error("--allow-routing-cycle requires a non-empty net name");
      }
      options.allowRoutingCycleNets.push(net);
    } else if (option === "--exception-note") options.exceptionNote = next();
    else if (option === "--crystal-audit-report") {
      options.crystalAuditReport = next();
    }
    else if (option === "--high-speed-constraints") {
      options.highSpeedConstraints = next();
    } else if (option === "--high-speed-audit-report") {
      options.highSpeedAuditReport = next();
    } else if (option === "--manufacturing-reviewed") {
      options.manufacturingReviewed = true;
    } else if (option === "--attest-file") options.attestFile = next();
    else if (option === "--bridge-port") {
      options.bridgePort = positiveInteger(next(), option);
    } else if (option === "--window-id") options.windowId = next();
    else if (option === "--output") options.output = next();
    else if (option === "--force") options.force = true;
    else if (option === "--self-test") options.selfTest = true;
    else if (option === "--help" || option === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  if (
    (
      options.allowNoGroundPour ||
      options.allowNonstandardAngle ||
      options.allowRoutingCycleNets.length
    ) &&
    !nonemptyString(options.exceptionNote)
  ) {
    throw new Error(
      "--allow-* options require --exception-note TEXT",
    );
  }
  options.allowRoutingCycleNets = [
    ...new Set(options.allowRoutingCycleNets.filter(nonemptyString)),
  ];
  if (options.manufacturingReviewed && !nonemptyString(options.attestFile)) {
    throw new Error("--manufacturing-reviewed requires --attest-file");
  }
  return options;
}

async function loadHighSpeedConstraintRecord(options) {
  if (!options.highSpeedConstraints) return options;
  let record;
  try {
    record = JSON.parse(await readFile(options.highSpeedConstraints, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read high-speed constraints ${options.highSpeedConstraints}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("high-speed constraints must be a JSON object");
  }
  return { ...options, highSpeedConstraintRecord: record };
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

if (documentInfo.documentType === ${DOCUMENT_TYPE.SCHEMATIC_PAGE}) {
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

if (documentInfo.documentType === ${DOCUMENT_TYPE.PCB}) {
  const layers = await eda.pcb_Layer.getAllLayers();
  const netNames = await eda.pcb_Net.getAllNetsName();
  const components = await eda.pcb_PrimitiveComponent.getAll();
  const lines = await eda.pcb_PrimitiveLine.getAll();
  const arcs = await eda.pcb_PrimitiveArc.getAll();
  const polylines = await eda.pcb_PrimitivePolyline.getAll();
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
  const arcData = arcs
    .map((arc) => ({
      primitiveId: value(arc, "getState_PrimitiveId", "primitiveId"),
      net: value(arc, "getState_Net", "net") || "",
      layer: value(arc, "getState_Layer", "layer"),
      lineWidth: value(arc, "getState_LineWidth", "lineWidth"),
      startX: value(arc, "getState_StartX", "startX"),
      startY: value(arc, "getState_StartY", "startY"),
      endX: value(arc, "getState_EndX", "endX"),
      endY: value(arc, "getState_EndY", "endY"),
      arcAngle: value(arc, "getState_ArcAngle", "arcAngle"),
    }))
    .filter((arc) =>
      [arc.startX, arc.startY, arc.endX, arc.endY, arc.arcAngle].every(Number.isFinite)
    );
  const segments = [
    ...lineData.map((line) => ({ ...line, segmentKind: "line" })),
    ...arcData.map((arc) => ({ ...arc, segmentKind: "arc" })),
  ];
  for (const polyline of polylines) {
    const net = value(polyline, "getState_Net", "net") || "";
    const polygon = value(polyline, "getState_Polygon", "polygon");
    const points = polygon && typeof polygon.discretize === "function"
      ? polygon.discretize()
      : [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) continue;
      segments.push({
        primitiveId:
          value(polyline, "getState_PrimitiveId", "primitiveId") + ":" + (index - 1),
        segmentKind: "polyline",
        net,
        layer: value(polyline, "getState_Layer", "layer"),
        lineWidth: value(polyline, "getState_LineWidth", "lineWidth"),
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
      });
    }
  }
  const viaData = vias
    .map((via) => ({
      primitiveId: value(via, "getState_PrimitiveId", "primitiveId"),
      net: value(via, "getState_Net", "net") || "",
      x: value(via, "getState_X", "x"),
      y: value(via, "getState_Y", "y"),
      diameter: value(via, "getState_Diameter", "diameter"),
      holeDiameter: value(via, "getState_HoleDiameter", "holeDiameter"),
      viaType: value(via, "getState_ViaType", "viaType"),
      blindViaRule:
        value(via, "getState_DesignRuleBlindViaName", "designRuleBlindViaName") || null,
    }))
    .filter((via) => Number.isFinite(via.x) && Number.isFinite(via.y));
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
    boardOutlineLayerId:
      layers.find((layer) =>
        /board.*outline|outline.*board|板框/i.test(layer.name || "")
      )?.id ?? null,
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
    netNames,
    lines: lineData,
    arcs: arcData,
    segments,
    vias: viaData,
    viaCount: viaData.length,
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

const ROUTING_TOPOLOGY_TOLERANCE_MIL = 0.05;

function routingPointKey(layer, point, tolerance = ROUTING_TOPOLOGY_TOLERANCE_MIL) {
  return `${String(layer)}@${Math.round(point.x / tolerance)},${Math.round(
    point.y / tolerance,
  )}`;
}

function pointOnStraightSegment(point, segment, tolerance) {
  const dx = segment.endX - segment.startX;
  const dy = segment.endY - segment.startY;
  const length = Math.hypot(dx, dy);
  if (length <= tolerance) return false;
  const cross =
    (point.x - segment.startX) * dy - (point.y - segment.startY) * dx;
  if (Math.abs(cross) > tolerance * length) return false;
  const dot =
    (point.x - segment.startX) * dx + (point.y - segment.startY) * dy;
  return dot >= -tolerance * length && dot <= length * length + tolerance * length;
}

function uniqueRoutingPoints(points, tolerance) {
  const seen = new Set();
  return points.filter((point) => {
    const key = `${Math.round(point.x / tolerance)},${Math.round(
      point.y / tolerance,
    )}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function straightSegmentIntersections(first, second, tolerance) {
  const p = { x: first.startX, y: first.startY };
  const q = { x: second.startX, y: second.startY };
  const r = {
    x: first.endX - first.startX,
    y: first.endY - first.startY,
  };
  const s = {
    x: second.endX - second.startX,
    y: second.endY - second.startY,
  };
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const qMinusP = { x: q.x - p.x, y: q.y - p.y };
  const denominator = cross(r, s);
  const scale = Math.max(1, Math.hypot(r.x, r.y), Math.hypot(s.x, s.y));

  if (Math.abs(denominator) <= tolerance * scale) {
    if (Math.abs(cross(qMinusP, r)) > tolerance * Math.max(1, Math.hypot(r.x, r.y))) {
      return [];
    }
    return uniqueRoutingPoints(
      [
        p,
        { x: first.endX, y: first.endY },
        q,
        { x: second.endX, y: second.endY },
      ].filter(
        (point) =>
          pointOnStraightSegment(point, first, tolerance) &&
          pointOnStraightSegment(point, second, tolerance),
      ),
      tolerance,
    );
  }

  const t = cross(qMinusP, s) / denominator;
  const u = cross(qMinusP, r) / denominator;
  const margin = tolerance / scale;
  if (t < -margin || t > 1 + margin || u < -margin || u > 1 + margin) {
    return [];
  }
  return [{ x: p.x + t * r.x, y: p.y + t * r.y }];
}

function routingEdgeSummary(edge, nodes) {
  const start = nodes.get(edge.from);
  const end = nodes.get(edge.to);
  return {
    kind: edge.kind,
    primitiveId: edge.primitiveId,
    layer: edge.layer ?? null,
    start,
    end,
    lengthMil: Number(Math.hypot(end.x - start.x, end.y - start.y).toFixed(4)),
  };
}

function findTreePath(tree, start, end) {
  const queue = [start];
  const previous = new Map([[start, null]]);
  while (queue.length) {
    const current = queue.shift();
    if (current === end) break;
    for (const entry of tree.get(current) || []) {
      if (previous.has(entry.node)) continue;
      previous.set(entry.node, { node: current, edge: entry.edge });
      queue.push(entry.node);
    }
  }
  if (!previous.has(end)) return [];
  const path = [];
  for (let cursor = end; cursor !== start; ) {
    const entry = previous.get(cursor);
    path.push(entry.edge);
    cursor = entry.node;
  }
  return path.reverse();
}

function analyzeRoutingTopology(raw, options = {}) {
  const tolerance = ROUTING_TOPOLOGY_TOLERANCE_MIL;
  const allowedNets = new Set(options.allowRoutingCycleNets || []);
  const sourceSegments =
    Array.isArray(raw.segments) && raw.segments.length
      ? raw.segments
      : [
          ...(raw.lines || []).map((segment) => ({
            ...segment,
            segmentKind: "line",
          })),
          ...(raw.arcs || []).map((segment) => ({
            ...segment,
            segmentKind: "arc",
          })),
        ];
  const segmentsByNet = new Map();
  for (const segment of sourceSegments) {
    if (
      !nonemptyString(segment.net) ||
      ![segment.startX, segment.startY, segment.endX, segment.endY].every(
        Number.isFinite,
      )
    ) {
      continue;
    }
    if (!segmentsByNet.has(segment.net)) segmentsByNet.set(segment.net, []);
    segmentsByNet.get(segment.net).push(segment);
  }
  const viasByNet = new Map();
  for (const via of raw.vias || []) {
    if (!nonemptyString(via.net) || !Number.isFinite(via.x) || !Number.isFinite(via.y)) {
      continue;
    }
    if (!viasByNet.has(via.net)) viasByNet.set(via.net, []);
    viasByNet.get(via.net).push(via);
  }

  const netNames = new Set([...segmentsByNet.keys(), ...viasByNet.keys()]);
  const nets = [];
  for (const net of [...netNames].sort()) {
    const segments = segmentsByNet.get(net) || [];
    const vias = viasByNet.get(net) || [];
    const splitPoints = segments.map((segment) => [
      { x: segment.startX, y: segment.startY },
      { x: segment.endX, y: segment.endY },
    ]);

    for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
      const first = segments[firstIndex];
      if (first.segmentKind === "arc") continue;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < segments.length;
        secondIndex += 1
      ) {
        const second = segments[secondIndex];
        if (
          second.segmentKind === "arc" ||
          String(first.layer) !== String(second.layer)
        ) {
          continue;
        }
        const intersections = straightSegmentIntersections(
          first,
          second,
          tolerance,
        );
        splitPoints[firstIndex].push(...intersections);
        splitPoints[secondIndex].push(...intersections);
      }
    }

    for (const via of vias) {
      for (let index = 0; index < segments.length; index += 1) {
        if (
          segments[index].segmentKind !== "arc" &&
          pointOnStraightSegment(via, segments[index], tolerance)
        ) {
          splitPoints[index].push({ x: via.x, y: via.y });
        }
      }
    }

    const nodes = new Map();
    const edgeByKey = new Map();
    const duplicateEdges = [];
    const addEdge = (edge) => {
      if (edge.from === edge.to) return;
      const key =
        edge.from < edge.to
          ? `${edge.from}|${edge.to}`
          : `${edge.to}|${edge.from}`;
      if (edgeByKey.has(key)) {
        const existing = edgeByKey.get(key);
        if (existing.primitiveId !== edge.primitiveId) {
          duplicateEdges.push({
            firstPrimitiveId: existing.primitiveId,
            secondPrimitiveId: edge.primitiveId,
            start: nodes.get(edge.from),
            end: nodes.get(edge.to),
          });
        }
        return;
      }
      edgeByKey.set(key, edge);
    };

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const dx = segment.endX - segment.startX;
      const dy = segment.endY - segment.startY;
      const denominator = dx * dx + dy * dy;
      const points = uniqueRoutingPoints(splitPoints[index], tolerance).sort(
        (first, second) => {
          const firstT =
            denominator > 0
              ? ((first.x - segment.startX) * dx +
                  (first.y - segment.startY) * dy) /
                denominator
              : 0;
          const secondT =
            denominator > 0
              ? ((second.x - segment.startX) * dx +
                  (second.y - segment.startY) * dy) /
                denominator
              : 0;
          return firstT - secondT;
        },
      );
      for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
        const start = points[pointIndex - 1];
        const end = points[pointIndex];
        if (Math.hypot(end.x - start.x, end.y - start.y) <= tolerance) continue;
        const from = routingPointKey(segment.layer, start, tolerance);
        const to = routingPointKey(segment.layer, end, tolerance);
        nodes.set(from, { layer: segment.layer, x: start.x, y: start.y });
        nodes.set(to, { layer: segment.layer, x: end.x, y: end.y });
        addEdge({
          from,
          to,
          kind: segment.segmentKind || "line",
          primitiveId: segment.primitiveId,
          layer: segment.layer,
        });
      }
    }

    for (const via of vias) {
      const touched = [];
      for (const [key, node] of nodes) {
        if (
          Math.hypot(node.x - via.x, node.y - via.y) <= tolerance &&
          !touched.includes(key)
        ) {
          touched.push(key);
        }
      }
      for (let index = 1; index < touched.length; index += 1) {
        addEdge({
          from: touched[0],
          to: touched[index],
          kind: "via",
          primitiveId: via.primitiveId,
          layer: null,
        });
      }
    }

    const parent = new Map([...nodes.keys()].map((key) => [key, key]));
    const find = (key) => {
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(key) !== key) {
        const next = parent.get(key);
        parent.set(key, root);
        key = next;
      }
      return root;
    };
    const union = (first, second) => {
      const firstRoot = find(first);
      const secondRoot = find(second);
      if (firstRoot === secondRoot) return false;
      parent.set(secondRoot, firstRoot);
      return true;
    };
    const tree = new Map();
    const addTreeEdge = (edge) => {
      if (!tree.has(edge.from)) tree.set(edge.from, []);
      if (!tree.has(edge.to)) tree.set(edge.to, []);
      tree.get(edge.from).push({ node: edge.to, edge });
      tree.get(edge.to).push({ node: edge.from, edge });
    };
    const cycleWitnesses = [];
    for (const edge of edgeByKey.values()) {
      if (union(edge.from, edge.to)) {
        addTreeEdge(edge);
        continue;
      }
      if (cycleWitnesses.length >= 20) continue;
      const witnessEdges = [...findTreePath(tree, edge.from, edge.to), edge];
      const publicEdges = witnessEdges.map((item) =>
        routingEdgeSummary(item, nodes),
      );
      const witnessPoints = publicEdges.flatMap((item) => [item.start, item.end]);
      cycleWitnesses.push({
        edgeCount: publicEdges.length,
        lengthMil: Number(
          publicEdges.reduce((sum, item) => sum + item.lengthMil, 0).toFixed(4),
        ),
        boundsMil: {
          minX: Math.min(...witnessPoints.map((point) => point.x)),
          minY: Math.min(...witnessPoints.map((point) => point.y)),
          maxX: Math.max(...witnessPoints.map((point) => point.x)),
          maxY: Math.max(...witnessPoints.map((point) => point.y)),
        },
        edges: publicEdges,
      });
    }
    const componentCount = new Set([...nodes.keys()].map(find)).size;
    const cyclomaticNumber =
      edgeByKey.size - nodes.size + componentCount;
    nets.push({
      net,
      allowed: allowedNets.has(net),
      nodeCount: nodes.size,
      edgeCount: edgeByKey.size,
      connectedComponentCount: componentCount,
      cyclomaticNumber,
      cycleWitnesses,
      duplicateEdges,
      coverage:
        segments.some((segment) => segment.segmentKind === "arc")
          ? "PARTIAL_ARC_INTERSECTION_COVERAGE"
          : "STRAIGHT_TRACK_AND_VIA_GRAPH",
    });
  }

  const cyclicNets = nets.filter((item) => item.cyclomaticNumber > 0);
  const unexpectedCycles = cyclicNets.filter((item) => !item.allowed);
  const allowedCycles = cyclicNets.filter((item) => item.allowed);
  const duplicateNets = nets.filter((item) => item.duplicateEdges.length);
  return {
    method: "per-net explicit track/via graph; same-layer straight intersections split into nodes",
    toleranceMil: tolerance,
    policy:
      "Explicit routing cycles are failures unless the net is named by --allow-routing-cycle with --exception-note.",
    nets,
    cyclicNets: cyclicNets.map((item) => item.net),
    unexpectedCycles: unexpectedCycles.map((item) => item.net),
    allowedCycles: allowedCycles.map((item) => item.net),
    duplicateNets: duplicateNets.map((item) => item.net),
    limitations: [
      "Copper pours and pad-internal copper are not expanded into graph edges, so a loop closed only through a pour or pad body can be missed.",
      "Arc endpoints are included, but intersections through an arc interior are not solved; affected nets are marked partial.",
    ],
  };
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
    schemaVersion: 3,
    evidence: "RULE_CHECK",
    decision: failures.length ? DECISIONS.FAIL : DECISIONS.PASS_WITH_EXCEPTIONS,
    fabricationRelease: false,
    manufacturingOutputsReviewed: false,
    notAFabricationRelease: notAFabricationReleaseMessage(),
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
    warnings: [],
    limitations: [
      "DRC and metadata do not prove the circuit topology, values, ratings, pin mapping, or connector mating view.",
      "Power integrity, protection, reset/boot states, clocks, and no-connect intent require schematic review.",
      "Unrouted nets, pin-map correctness, and manufacturing outputs are outside this baseline audit.",
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
  const routingTopology = analyzeRoutingTopology(raw, options);

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
  if (routingTopology.unexpectedCycles.length) {
    failures.push(
      `explicit routing cycle(s) found on net(s): ${routingTopology.unexpectedCycles.join(
        ", ",
      )}`,
    );
  }
  if (routingTopology.duplicateNets.length) {
    failures.push(
      `duplicate overlapping route edge(s) found on net(s): ${routingTopology.duplicateNets.join(
        ", ",
      )}`,
    );
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
  if (!options.requireGroundPour && nonemptyString(options.exceptionNote)) {
    warnings.push(`ground-pour requirement waived: ${options.exceptionNote}`);
  }
  if (options.allowNonstandardAngle && nonemptyString(options.exceptionNote)) {
    warnings.push(`nonstandard-angle failure waived: ${options.exceptionNote}`);
  }
  if (routingTopology.allowedCycles.length) {
    warnings.push(
      `routing cycle exception for ${routingTopology.allowedCycles.join(
        ", ",
      )}: ${options.exceptionNote}`,
    );
  }
  const partialTopologyNets = routingTopology.nets
    .filter((item) => item.coverage !== "STRAIGHT_TRACK_AND_VIA_GRAPH")
    .map((item) => item.net);
  if (partialTopologyNets.length) {
    warnings.push(
      `routing-cycle coverage is partial for net(s) containing arcs: ${partialTopologyNets.join(
        ", ",
      )}`,
    );
  }
  const allNetNames = [
    ...(raw.netNames || []),
    ...(raw.lines || []).map((item) => item.net),
    ...(raw.arcs || []).map((item) => item.net),
    ...(raw.vias || []).map((item) => item.net),
    ...(raw.pours || []).map((item) => item.net),
  ].filter(Boolean);
  const fingerprint = designFingerprint(raw);
  const highSpeedConstraintFingerprint = constraintFingerprint(
    options.highSpeedConstraintRecord,
  );
  const highSpeedDiscoveryResult = highSpeedDiscovery(allNetNames, {
    constraintRecord: options.highSpeedConstraintRecord,
  });
  const hintedHighSpeedNets = highSpeedDiscoveryResult.candidateNets;
  const hintedCrystalNets = crystalNetHints(allNetNames);
  const crystalClearance = hintedCrystalNets.length
    ? readCrystalClearanceReport(options.crystalAuditReport, {
        expectedProjectUuid: raw.project?.uuid,
        expectedDocumentUuid: raw.document?.uuid,
        expectedDesignFingerprint: fingerprint,
        requiredNets: hintedCrystalNets,
      })
    : { cleared: true, reason: "no crystal/clock net hints" };
  const highSpeedClearance = hintedHighSpeedNets.length
    ? readHighSpeedClearanceReport(options.highSpeedAuditReport, {
        expectedProjectUuid: raw.project?.uuid,
        expectedDocumentUuid: raw.document?.uuid,
        expectedDesignFingerprint: fingerprint,
        expectedConstraintFingerprint: highSpeedConstraintFingerprint,
        requiredNets: hintedHighSpeedNets,
      })
    : { cleared: true, reason: "no high-speed net hints" };
  const unverified = [];
  if (hintedCrystalNets.length && !crystalClearance.cleared) {
    unverified.push(
      `possible crystal/clock nets detected (${hintedCrystalNets.join(
        ", ",
      )}); supply --crystal-audit-report from a cleared crystal/clock audit (${
        crystalClearance.reason
      })`,
    );
    warnings.push(unverified[unverified.length - 1]);
  } else if (hintedCrystalNets.length) {
    warnings.push(
      `crystal/clock nets ${hintedCrystalNets.join(
        ", ",
      )} cleared by report: ${crystalClearance.reportPath}`,
    );
  }
  if (hintedHighSpeedNets.length && !highSpeedClearance.cleared) {
    unverified.push(
      `possible high-speed nets detected (${hintedHighSpeedNets.join(
        ", ",
      )}); supply --high-speed-audit-report from a non-failing cleared HS audit (${
        highSpeedClearance.reason
      })`,
    );
    warnings.push(unverified[unverified.length - 1]);
  } else if (hintedHighSpeedNets.length) {
    warnings.push(
      `high-speed nets ${hintedHighSpeedNets.join(
        ", ",
      )} cleared by report: ${highSpeedClearance.reportPath}`,
    );
  }

  const manufacturing = resolveManufacturingReview(options);
  if (!manufacturing.reviewed) {
    warnings.push(manufacturing.reason);
  }

  let decision;
  if (failures.length) decision = DECISIONS.FAIL;
  else if (unverified.length) decision = DECISIONS.UNVERIFIED;
  else decision = DECISIONS.PASS_WITH_EXCEPTIONS;

  return {
    schemaVersion: 6,
    evidence: "RULE_CHECK",
    decision,
    fabricationRelease: false,
    manufacturingOutputsReviewed: Boolean(manufacturing.reviewed),
    notAFabricationRelease: notAFabricationReleaseMessage(),
    kind: "pcb",
    source,
    generatedAt: new Date().toISOString(),
    design: {
      project: raw.project,
      document: raw.document,
      fingerprint,
      netCount: new Set(allNetNames).size,
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
      allowRoutingCycleNets: options.allowRoutingCycleNets,
      exceptionNote: options.exceptionNote || null,
      crystalAuditReport: options.crystalAuditReport || null,
      highSpeedConstraints: options.highSpeedConstraints || null,
      highSpeedConstraintFingerprint,
      highSpeedAuditReport: options.highSpeedAuditReport || null,
    },
    checks: {
      drc,
      designators,
      nonStandardAngles,
      routingTopology,
      pours,
      validGroundPour,
      hintedCrystalNets,
      crystalClearance,
      hintedHighSpeedNets,
      highSpeedDiscovery: highSpeedDiscoveryResult,
      highSpeedClearance,
      manufacturing,
      unverified,
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
      ...routingTopology.limitations,
      "Unrouted connections and netlist equivalence must be confirmed in EasyEDA.",
      "DRC does not prove current capacity, thermal behavior, return-path quality, placement quality, polarity, or mechanical fit.",
      "Manufacturing outputs, BOM, and pick-and-place files require separate human-attested review.",
      "Crystal electrical values, oscillator margin, ground/keepout policy, and noise coupling require datasheet-backed manual review.",
      "High-speed/impedance claims require easyeda_high_speed_audit.mjs and cannot be closed by this baseline audit alone.",
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
    const options = await loadHighSpeedConstraintRecord(
      parseArgs(process.argv.slice(2)),
    );
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
      const cycleFixture = pcbFixture();
      cycleFixture.lines.push(
        {
          primitiveId: "cycle-1",
          net: "SIGNAL",
          layer: 1,
          startX: 200,
          startY: 200,
          endX: 300,
          endY: 200,
        },
        {
          primitiveId: "cycle-2",
          net: "SIGNAL",
          layer: 1,
          startX: 300,
          startY: 200,
          endX: 300,
          endY: 300,
        },
        {
          primitiveId: "cycle-3",
          net: "SIGNAL",
          layer: 1,
          startX: 300,
          startY: 300,
          endX: 200,
          endY: 300,
        },
        {
          primitiveId: "cycle-4",
          net: "SIGNAL",
          layer: 1,
          startX: 200,
          startY: 300,
          endX: 200,
          endY: 200,
        },
      );
      const failingPcb = analyze(failingPcbFixture, options, {
        kind: "self-test-negative",
      });
      const cyclePcb = analyze(cycleFixture, options, {
        kind: "self-test-cycle-negative",
      });
      const failingSchematic = analyze(failingSchematicFixture, options, {
        kind: "self-test-negative",
      });
      const hsHintFixture = pcbFixture();
      hsHintFixture.lines.push({
        primitiveId: "usb3",
        net: "USB3_SSRX_P",
        layer: 1,
        startX: 0,
        startY: 20,
        endX: 100,
        endY: 20,
      });
      const hsHint = analyze(hsHintFixture, options, { kind: "self-test-hs-hint" });
      if (
        pcb.decision !== DECISIONS.PASS_WITH_EXCEPTIONS ||
        schematic.decision !== DECISIONS.PASS_WITH_EXCEPTIONS ||
        failingPcb.decision !== DECISIONS.FAIL ||
        cyclePcb.decision !== DECISIONS.FAIL ||
        cyclePcb.checks.routingTopology.unexpectedCycles[0] !== "SIGNAL" ||
        failingSchematic.decision !== DECISIONS.FAIL ||
        pcb.fabricationRelease !== false ||
        hsHint.decision !== DECISIONS.UNVERIFIED ||
        !hsHint.checks.hintedHighSpeedNets.includes("USB3_SSRX_P")
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
              cyclePcbDecision: cyclePcb.decision,
              cycleNets: cyclePcb.checks.routingTopology.unexpectedCycles,
              schematicDecision: failingSchematic.decision,
            },
            highSpeedHint: {
              nets: hsHint.checks.hintedHighSpeedNets,
              decision: hsHint.decision,
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
    if (options.output) {
      const outputPath = resolveSafeOutputPath(options.output, {
        force: options.force,
      });
      await writeFile(outputPath, serialized, "utf8");
    }
    process.stdout.write(serialized);
    process.exitCode = applyDecisionExitCode(report.decision);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          evidence: "RULE_CHECK",
          fabricationRelease: false,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = EXIT.ERROR;
  }
}

export {
  DECISIONS,
  EXIT,
  analyze,
  analyzePcb,
  analyzeRoutingTopology,
  analyzeSchematic,
  applyDecisionExitCode,
  collectorCode,
  loadHighSpeedConstraintRecord,
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

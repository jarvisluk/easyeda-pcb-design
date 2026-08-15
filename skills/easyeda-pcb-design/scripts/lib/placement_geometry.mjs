#!/usr/bin/env node

const EPSILON = 1e-7;
const MM_TO_MIL = 1 / 0.0254;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalFiniteNumber(object, field, defaultValue = 0) {
  return Object.hasOwn(object, field) ? finiteNumber(object[field]) : defaultValue;
}

function normalizeAngle(value) {
  const angle = finiteNumber(value) || 0;
  return ((angle % 360) + 360) % 360;
}

function rotatePoint(point, angleDeg, origin = { x: 0, y: 0 }) {
  const radians = (normalizeAngle(angleDeg) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  return {
    x: origin.x + x * cosine - y * sine,
    y: origin.y + x * sine + y * cosine,
  };
}

function ellipsePolygon(cx, cy, width, height, rotationDeg = 0, segments = 64) {
  if (!(width > 0) || !(height > 0)) return undefined;
  const count = Math.max(16, Math.floor(segments));
  const conservativeScale = 1 / Math.cos(Math.PI / count);
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return rotatePoint(
      {
        x: cx + (width / 2) * conservativeScale * Math.cos(angle),
        y: cy + (height / 2) * conservativeScale * Math.sin(angle),
      },
      rotationDeg,
      { x: cx, y: cy },
    );
  });
}

function rectanglePolygon(cx, cy, width, height, rotationDeg = 0) {
  if (!(width > 0) || !(height > 0)) return undefined;
  return [
    { x: cx - width / 2, y: cy - height / 2 },
    { x: cx + width / 2, y: cy - height / 2 },
    { x: cx + width / 2, y: cy + height / 2 },
    { x: cx - width / 2, y: cy + height / 2 },
  ].map((point) => rotatePoint(point, rotationDeg, { x: cx, y: cy }));
}

function oblongPolygon(cx, cy, width, height, rotationDeg = 0, segments = 64) {
  if (!(width > 0) || !(height > 0)) return undefined;
  if (Math.abs(width - height) <= EPSILON) {
    return ellipsePolygon(cx, cy, width, height, rotationDeg, segments);
  }
  const horizontal = width > height;
  const radius = Math.min(width, height) / 2;
  const halfStraight = (Math.max(width, height) - Math.min(width, height)) / 2;
  const count = Math.max(16, Math.floor(segments / 2));
  const conservativeScale = 1 / Math.cos(Math.PI / (count * 2));
  const points = [];
  for (let index = 0; index <= count; index += 1) {
    const angle = -Math.PI / 2 + (index / count) * Math.PI;
    points.push(
      horizontal
        ? { x: cx + halfStraight + radius * conservativeScale * Math.cos(angle), y: cy + radius * conservativeScale * Math.sin(angle) }
        : { x: cx + radius * conservativeScale * Math.sin(angle), y: cy + halfStraight + radius * conservativeScale * Math.cos(angle) },
    );
  }
  for (let index = 0; index <= count; index += 1) {
    const angle = Math.PI / 2 + (index / count) * Math.PI;
    points.push(
      horizontal
        ? { x: cx - halfStraight + radius * conservativeScale * Math.cos(angle), y: cy + radius * conservativeScale * Math.sin(angle) }
        : { x: cx + radius * conservativeScale * Math.sin(angle), y: cy - halfStraight + radius * conservativeScale * Math.cos(angle) },
    );
  }
  return points.map((point) => rotatePoint(point, rotationDeg, { x: cx, y: cy }));
}

function padGeometryContract(pad, constraintRecord = {}) {
  const contracts = Array.isArray(constraintRecord.padGeometryContracts)
    ? constraintRecord.padGeometryContracts
    : [];
  return contracts.find((contract) => (
    contract?.primitiveId === pad?.primitiveId &&
    contract?.designator === pad?.designator &&
    String(contract?.padNumber) === String(pad?.padNumber) &&
    contract?.coordinates === "BOARD" &&
    typeof contract?.evidenceArtifact === "string" &&
    contract.evidenceArtifact.trim()
  ));
}

function explicitBoardPolygon(shape) {
  const path = shape?.[1];
  if (!Array.isArray(path)) return undefined;
  const unsupportedCommand = path.some(
    (item) => typeof item === "string" && !["L", "M", "Z"].includes(item.toUpperCase()),
  );
  if (unsupportedCommand) return undefined;
  const numbers = path.filter((item) => typeof item === "number" && Number.isFinite(item));
  if (numbers.length < 6 || numbers.length % 2 !== 0) return undefined;
  const polygon = [];
  for (let index = 0; index < numbers.length; index += 2) {
    const point = { x: numbers[index], y: numbers[index + 1] };
    const previous = polygon.at(-1);
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > EPSILON) {
      polygon.push(point);
    }
  }
  const first = polygon[0];
  const last = polygon.at(-1);
  if (first && last && Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON) {
    polygon.pop();
  }
  return validSimplePolygon(polygon) ? polygon : undefined;
}

function padPolygon(pad, constraintRecord = {}) {
  const x = finiteNumber(pad?.x);
  const y = finiteNumber(pad?.y);
  const shape = pad?.pad;
  if (x === undefined || y === undefined || !Array.isArray(shape) || !shape.length) {
    return { supported: false, reason: "missing pad position or shape" };
  }
  const kind = String(shape[0] || "").toUpperCase();
  const width = finiteNumber(shape[1]);
  const height = finiteNumber(shape[2]);
  const rotation = finiteNumber(pad.rotation);
  if (rotation === undefined) {
    return { supported: false, reason: "missing or non-numeric pad rotation" };
  }
  let polygon;
  if (["RECT", "RECTANGLE"].includes(kind)) {
    polygon = rectanglePolygon(x, y, width, height, rotation);
  } else if (["ELLIPSE", "CIRCLE"].includes(kind)) {
    polygon = ellipsePolygon(x, y, width, height, rotation);
  } else if (["OBLONG", "OVAL"].includes(kind)) {
    polygon = oblongPolygon(x, y, width, height, rotation);
  } else if (["REGULAR_POLYGON", "REGULARPOLYGON"].includes(kind)) {
    const diameter = width;
    const sides = Math.floor(height || 0);
    if (diameter > 0 && sides > 2) {
      polygon = Array.from({ length: sides }, (_, index) => {
        const angle = -90 + (index / sides) * 360;
        return rotatePoint(
          { x: x + diameter / 2, y },
          rotation + angle,
          { x, y },
        );
      });
    }
  } else if (["POLYGON", "POLYLINE_COMPLEX_POLYGON", "POLY"].includes(kind)) {
    const contract = padGeometryContract(pad, constraintRecord);
    if (contract) {
      polygon = explicitBoardPolygon(shape);
    } else {
      return {
        supported: false,
        reason: "explicit polygon pad coordinates/arcs lack a proven live API transform contract",
      };
    }
    if (!polygon) {
      return {
        supported: false,
        reason: "contracted explicit polygon pad lacks a simple board-coordinate polygon path",
      };
    }
  }
  if (!polygon || !validSimplePolygon(polygon)) {
    return {
      supported: false,
      reason: `unsupported or malformed pad shape ${kind || "<empty>"}`,
    };
  }
  return { supported: true, polygon, kind };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let first = 0, second = polygon.length - 1; first < polygon.length; second = first++) {
    const a = polygon[first];
    const b = polygon[second];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function pointPolygonSignedDistance(point, polygon) {
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    distance = Math.min(
      distance,
      pointSegmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]),
    );
  }
  return pointInPolygon(point, polygon) ? -distance : distance;
}

function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) <= EPSILON) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return (
    b.x <= Math.max(a.x, c.x) + EPSILON &&
    b.x + EPSILON >= Math.min(a.x, c.x) &&
    b.y <= Math.max(a.y, c.y) + EPSILON &&
    b.y + EPSILON >= Math.min(a.y, c.y)
  );
}

function segmentsIntersect(a1, a2, b1, b2) {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

function validSimplePolygon(polygon) {
  if (
    !Array.isArray(polygon) ||
    polygon.length < 3 ||
    polygon.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))
  ) return false;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (Math.hypot(end.x - start.x, end.y - start.y) <= EPSILON) return false;
    twiceArea += start.x * end.y - end.x * start.y;
  }
  if (Math.abs(twiceArea) <= EPSILON) return false;
  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length;
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (
        segmentsIntersect(
          polygon[first],
          polygon[firstNext],
          polygon[second],
          polygon[secondNext],
        )
      ) return false;
    }
  }
  return true;
}

function polygonsIntersect(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length < 3 || second.length < 3) {
    return false;
  }
  for (let a = 0; a < first.length; a += 1) {
    for (let b = 0; b < second.length; b += 1) {
      if (
        segmentsIntersect(
          first[a],
          first[(a + 1) % first.length],
          second[b],
          second[(b + 1) % second.length],
        )
      ) {
        return true;
      }
    }
  }
  return pointInPolygon(first[0], second) || pointInPolygon(second[0], first);
}

function polygonDistance(first, second) {
  if (polygonsIntersect(first, second)) return 0;
  let distance = Infinity;
  for (let a = 0; a < first.length; a += 1) {
    for (let b = 0; b < second.length; b += 1) {
      distance = Math.min(
        distance,
        pointSegmentDistance(first[a], second[b], second[(b + 1) % second.length]),
        pointSegmentDistance(second[b], first[a], first[(a + 1) % first.length]),
      );
    }
  }
  return distance;
}

function bboxPolygon(bbox) {
  if (!bbox) return undefined;
  const minX = finiteNumber(bbox.minX);
  const minY = finiteNumber(bbox.minY);
  const maxX = finiteNumber(bbox.maxX);
  const maxY = finiteNumber(bbox.maxY);
  if ([minX, minY, maxX, maxY].some((value) => value === undefined)) return undefined;
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

function envelopePolygon(envelope, componentByDesignator = new Map()) {
  if (!envelope || typeof envelope !== "object") return undefined;
  const geometry = envelope.courtyard || envelope.body || envelope.geometry;
  if (!geometry || typeof geometry !== "object") return undefined;
  const coordinates = geometry.coordinates || "COMPONENT_LOCAL";
  if (!["COMPONENT_LOCAL", "BOARD"].includes(coordinates)) return undefined;
  const bottomSideTransform = geometry.bottomSideTransform;
  if (
    bottomSideTransform !== undefined &&
    bottomSideTransform !== null &&
    bottomSideTransform !== "MIRROR_LOCAL_X_THEN_ROTATE"
  ) return undefined;
  if (coordinates === "BOARD" && bottomSideTransform !== undefined && bottomSideTransform !== null) {
    return undefined;
  }
  const component = componentByDesignator.get(envelope.designator || envelope.ownerDesignator);
  const componentX = finiteNumber(component?.x);
  const componentY = finiteNumber(component?.y);
  const componentRotation = finiteNumber(component?.rotation);
  const componentLayer = finiteNumber(component?.layer);
  let polygon;
  if (String(geometry.type || "").toUpperCase() === "RECT") {
    const centerX = optionalFiniteNumber(geometry, "centerXMil");
    const centerY = optionalFiniteNumber(geometry, "centerYMil");
    const localRotation = optionalFiniteNumber(geometry, "rotationDeg");
    if (centerX === undefined || centerY === undefined || localRotation === undefined) {
      return undefined;
    }
    polygon = rectanglePolygon(
      centerX,
      centerY,
      finiteNumber(geometry.widthMil),
      finiteNumber(geometry.heightMil),
      localRotation,
    );
  } else if (String(geometry.type || "").toUpperCase() === "POLYGON") {
    if (["centerXMil", "centerYMil", "rotationDeg"].some((field) => Object.hasOwn(geometry, field))) {
      return undefined;
    }
    polygon = (geometry.pointsMil || [])
      .map((point) => ({ x: finiteNumber(point?.[0]), y: finiteNumber(point?.[1]) }))
      .filter((point) => point.x !== undefined && point.y !== undefined);
  }
  if (!polygon || !validSimplePolygon(polygon)) return undefined;
  if (!component) return undefined;
  if (![1, 2].includes(componentLayer)) return undefined;
  if (componentX === undefined || componentY === undefined || componentRotation === undefined) {
    return undefined;
  }
  if (coordinates === "BOARD") return polygon;
  if (
    Number(component.layer) === 2 &&
    bottomSideTransform !== "MIRROR_LOCAL_X_THEN_ROTATE"
  ) return undefined;
  const transformed = Number(component.layer) === 2
    ? polygon.map((point) => ({ x: -point.x, y: point.y }))
    : polygon;
  return transformed.map((point) =>
    rotatePoint(
      { x: point.x + componentX, y: point.y + componentY },
      componentRotation,
      { x: componentX, y: componentY },
    ),
  );
}

function pairKey(first, second) {
  return [String(first), String(second)].sort().join("::");
}

function padSpansBothSides(pad) {
  const type = String(pad?.padType ?? "").toUpperCase();
  return (
    Number(pad?.layer) === 12 ||
    type.includes("THROUGH") ||
    type.includes("THRU") ||
    type.includes("MULTI")
  );
}

function padAppliesToLayer(pad, layer) {
  if (padSpansBothSides(pad)) return true;
  const padLayer = finiteNumber(pad?.layer);
  const targetLayer = finiteNumber(layer);
  return padLayer === undefined || targetLayer === undefined || padLayer === targetLayer;
}

function oppositeCopperLayer(layer) {
  if (Number(layer) === 1) return 2;
  if (Number(layer) === 2) return 1;
  return undefined;
}

function padPolygonsByOwner(raw, constraintRecord = {}) {
  const converted = [];
  const unsupported = [];
  for (const pad of Array.isArray(raw.pads) ? raw.pads : []) {
    if (![1, 2, 12].includes(finiteNumber(pad.layer))) {
      unsupported.push({
        designator: pad.designator || "",
        padNumber: String(pad.padNumber || ""),
        primitiveId: pad.primitiveId || null,
        reason: "missing or invalid live pad layer",
      });
      continue;
    }
    if (Array.isArray(pad.specialPad) && pad.specialPad.length) {
      unsupported.push({
        designator: pad.designator || "",
        padNumber: String(pad.padNumber || ""),
        primitiveId: pad.primitiveId || null,
        reason: "per-layer specialPad geometry lacks a deterministic maximum-projection converter",
      });
      continue;
    }
    const geometry = padPolygon(pad, constraintRecord);
    if (!geometry.supported) {
      unsupported.push({
        designator: pad.designator || "",
        padNumber: String(pad.padNumber || ""),
        primitiveId: pad.primitiveId || null,
        reason: geometry.reason,
      });
      continue;
    }
    converted.push({ pad, polygon: geometry.polygon, kind: geometry.kind });
  }
  return { converted, unsupported };
}

function polygonContainsPolygon(container, subject) {
  if (!subject.every((point) => pointPolygonSignedDistance(point, container) <= EPSILON)) {
    return false;
  }
  const cross = (first, second) => first.x * second.y - first.y * second.x;
  const intersectionParameters = (start, end, edgeStart, edgeEnd) => {
    const direction = { x: end.x - start.x, y: end.y - start.y };
    const edgeDirection = { x: edgeEnd.x - edgeStart.x, y: edgeEnd.y - edgeStart.y };
    const offset = { x: edgeStart.x - start.x, y: edgeStart.y - start.y };
    const denominator = cross(direction, edgeDirection);
    if (Math.abs(denominator) > EPSILON) {
      const t = cross(offset, edgeDirection) / denominator;
      const u = cross(offset, direction) / denominator;
      return t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON
        ? [Math.max(0, Math.min(1, t))]
        : [];
    }
    if (Math.abs(cross(offset, direction)) > EPSILON) return [];
    const lengthSquared = direction.x * direction.x + direction.y * direction.y;
    if (lengthSquared <= EPSILON) return [];
    return [edgeStart, edgeEnd]
      .map((point) => (
        ((point.x - start.x) * direction.x + (point.y - start.y) * direction.y) /
        lengthSquared
      ))
      .filter((value) => value >= -EPSILON && value <= 1 + EPSILON)
      .map((value) => Math.max(0, Math.min(1, value)));
  };
  for (let index = 0; index < subject.length; index += 1) {
    const start = subject[index];
    const end = subject[(index + 1) % subject.length];
    const parameters = [0, 1];
    for (let edge = 0; edge < container.length; edge += 1) {
      parameters.push(
        ...intersectionParameters(
          start,
          end,
          container[edge],
          container[(edge + 1) % container.length],
        ),
      );
    }
    const ordered = [...new Set(parameters.map((value) => value.toFixed(12)))]
      .map(Number)
      .sort((a, b) => a - b);
    for (let interval = 0; interval + 1 < ordered.length; interval += 1) {
      if (ordered[interval + 1] - ordered[interval] <= EPSILON) continue;
      const t = (ordered[interval] + ordered[interval + 1]) / 2;
      const midpoint = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      };
      if (pointPolygonSignedDistance(midpoint, container) > EPSILON) return false;
    }
  }
  return true;
}

function normalizedClosedPolygon(points) {
  if (!Array.isArray(points)) return undefined;
  const polygon = points
    .map((point) => Array.isArray(point)
      ? { x: finiteNumber(point[0]), y: finiteNumber(point[1]) }
      : { x: finiteNumber(point?.x), y: finiteNumber(point?.y) })
    .filter((point) => point.x !== undefined && point.y !== undefined);
  if (polygon.length > 1) {
    const first = polygon[0];
    const last = polygon.at(-1);
    if (Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON) polygon.pop();
  }
  return validSimplePolygon(polygon) ? polygon : undefined;
}

function analyzeBoardContainment(raw, constraintRecord = {}) {
  const boundary = constraintRecord?.boardBoundary;
  const violations = [];
  const unverified = [];
  const result = {
    outerContour: null,
    cutouts: [],
    padOutsideBoard: [],
    courtyardOutsideBoard: [],
    criticalZoneOutsideBoard: [],
    cutoutIntersections: [],
    violations,
    unverified,
  };
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) {
    unverified.push({ reason: "layout constraints lack boardBoundary" });
    return result;
  }
  const outlineLayerId = finiteNumber(boundary.outlineLayerId);
  if (outlineLayerId === undefined) {
    unverified.push({ reason: "boardBoundary.outlineLayerId is missing or non-numeric" });
    return result;
  }
  if (finiteNumber(raw?.boardOutlineLayerId) !== outlineLayerId) {
    unverified.push({
      reason: "declared board-outline layer does not match saved/reopened live layer identity",
      declaredLayerId: outlineLayerId,
      liveLayerId: raw?.boardOutlineLayerId ?? null,
    });
  }
  const polylines = (Array.isArray(raw?.polylines) ? raw.polylines : [])
    .filter((item) => finiteNumber(item?.layer) === outlineLayerId);
  const byId = new Map(
    polylines
      .filter((item) => typeof item?.primitiveId === "string" && item.primitiveId.trim())
      .map((item) => [item.primitiveId, item]),
  );
  const outerId = boundary.outerContourPrimitiveId;
  const outer = typeof outerId === "string" ? byId.get(outerId) : undefined;
  if (!outer) {
    unverified.push({
      reason: "declared native outer-contour primitive is absent from saved/reopened readback",
      primitiveId: outerId || null,
    });
    return result;
  }
  const outerPolygon = outer.closed === true ? normalizedClosedPolygon(outer.points) : undefined;
  if (!outerPolygon) {
    unverified.push({
      reason: "native outer contour is not a closed simple polygon",
      primitiveId: outerId,
    });
    return result;
  }
  if (boundary.requireLocked === true && outer.locked !== true) {
    violations.push({
      reason: "accepted board boundary requires a locked native outer contour",
      primitiveId: outerId,
    });
  }
  result.outerContour = {
    primitiveId: outerId,
    locked: outer.locked === true,
    pointCount: outerPolygon.length,
  };

  const cutoutIds = Array.isArray(boundary.cutoutPrimitiveIds)
    ? boundary.cutoutPrimitiveIds
    : [];
  const cutoutPolygons = [];
  for (const primitiveId of cutoutIds) {
    const item = byId.get(primitiveId);
    const polygon = item?.closed === true ? normalizedClosedPolygon(item.points) : undefined;
    if (!item || !polygon) {
      unverified.push({
        reason: "declared cutout is absent or is not a closed simple native polygon",
        primitiveId,
      });
      continue;
    }
    if (!polygonContainsPolygon(outerPolygon, polygon)) {
      violations.push({
        reason: "declared cutout is not contained by the outer board contour",
        primitiveId,
      });
    }
    if (boundary.requireLocked === true && item.locked !== true) {
      violations.push({
        reason: "accepted board boundary requires locked native cutouts",
        primitiveId,
      });
    }
    cutoutPolygons.push({ primitiveId, polygon });
    result.cutouts.push({
      primitiveId,
      locked: item.locked === true,
      pointCount: polygon.length,
    });
  }
  const declaredIds = new Set([outerId, ...cutoutIds]);
  const unexpectedPolylines = polylines
    .map((item) => item.primitiveId)
    .filter((primitiveId) => !declaredIds.has(primitiveId));
  const loosePrimitives = [
    ...(Array.isArray(raw?.lines) ? raw.lines : []),
    ...(Array.isArray(raw?.arcs) ? raw.arcs : []),
  ].filter((item) => finiteNumber(item?.layer) === outlineLayerId);
  if (unexpectedPolylines.length || loosePrimitives.length) {
    unverified.push({
      reason: "board-outline layer contains undeclared native contours or loose line/arc primitives",
      unexpectedPolylineIds: unexpectedPolylines,
      loosePrimitiveIds: loosePrimitives.map((item) => item.primitiveId || null),
    });
  }

  const components = Array.isArray(raw?.components) ? raw.components : [];
  const componentByDesignator = new Map(
    components.filter((item) => item?.designator).map((item) => [item.designator, item]),
  );
  const relations = new Map();
  for (const relation of Array.isArray(boundary.edgeRelations) ? boundary.edgeRelations : []) {
    if (!relation || typeof relation !== "object") continue;
    relations.set(`${relation.subjectType}:${relation.subjectId}`, relation);
  }
  const outsideAllowed = (subjectType, subjectId) => {
    const relation = relations.get(`${subjectType}:${subjectId}`);
    return relation && ["ALLOWED_OVERHANG", "EDGE_ALIGNED"].includes(relation.relation);
  };
  const checkMaterialContainment = (polygon, finding, outsideCollection) => {
    if (!polygonContainsPolygon(outerPolygon, polygon)) outsideCollection.push(finding);
    for (const cutout of cutoutPolygons) {
      if (polygonsIntersect(polygon, cutout.polygon)) {
        result.cutoutIntersections.push({ ...finding, cutoutPrimitiveId: cutout.primitiveId });
      }
    }
  };

  const padGeometry = padPolygonsByOwner(raw, constraintRecord);
  for (const entry of padGeometry.converted) {
    checkMaterialContainment(
      entry.polygon,
      {
        subjectType: "PAD",
        subjectId: entry.pad.primitiveId || null,
        designator: entry.pad.designator || "",
        padNumber: String(entry.pad.padNumber || ""),
      },
      result.padOutsideBoard,
    );
  }

  for (const envelope of Array.isArray(constraintRecord.assemblyEnvelopes)
    ? constraintRecord.assemblyEnvelopes
    : []) {
    const polygon = envelopePolygon(envelope, componentByDesignator);
    if (!polygon) continue;
    const finding = {
      subjectType: "ASSEMBLY_ENVELOPE",
      subjectId: envelope.designator || null,
      designator: envelope.designator || "",
      source: envelope.source || null,
    };
    if (!polygonContainsPolygon(outerPolygon, polygon)) {
      if (!outsideAllowed(finding.subjectType, finding.subjectId)) {
        result.courtyardOutsideBoard.push(finding);
      }
    }
    for (const cutout of cutoutPolygons) {
      if (polygonsIntersect(polygon, cutout.polygon)) {
        result.cutoutIntersections.push({ ...finding, cutoutPrimitiveId: cutout.primitiveId });
      }
    }
  }

  for (const zone of Array.isArray(constraintRecord.criticalPlacementZones)
    ? constraintRecord.criticalPlacementZones
    : []) {
    const polygon = envelopePolygon(
      { ownerDesignator: zone.ownerDesignator, geometry: zone.geometry },
      componentByDesignator,
    );
    if (!polygon) continue;
    const finding = {
      subjectType: "CRITICAL_ZONE",
      subjectId: zone.id || null,
      ownerDesignator: zone.ownerDesignator || "",
      source: zone.source || null,
    };
    if (!polygonContainsPolygon(outerPolygon, polygon)) {
      if (!outsideAllowed(finding.subjectType, finding.subjectId)) {
        result.criticalZoneOutsideBoard.push(finding);
      }
    }
    for (const cutout of cutoutPolygons) {
      if (polygonsIntersect(polygon, cutout.polygon)) {
        result.cutoutIntersections.push({ ...finding, cutoutPrimitiveId: cutout.primitiveId });
      }
    }
  }

  for (const relation of Array.isArray(boundary.edgeRelations) ? boundary.edgeRelations : []) {
    if (
      !relation ||
      !["ASSEMBLY_ENVELOPE", "CRITICAL_ZONE"].includes(relation.subjectType) ||
      !["ALLOWED_OVERHANG", "EDGE_ALIGNED"].includes(relation.relation) ||
      typeof relation.source !== "string" ||
      !relation.source.trim() ||
      typeof relation.evidenceArtifact !== "string" ||
      !relation.evidenceArtifact.trim()
    ) {
      unverified.push({ reason: "boardBoundary edge relation is incomplete or unsupported", relation });
    }
  }

  violations.push(
    ...result.padOutsideBoard,
    ...result.courtyardOutsideBoard,
    ...result.criticalZoneOutsideBoard,
    ...result.cutoutIntersections,
  );
  return result;
}

function analyzeViaPadGeometry(raw, constraintRecord = {}) {
  const standardVia = constraintRecord?.routingGeometry?.standardVia || {};
  const requiredClearanceMil = Number(standardVia.viaToPadCopperClearanceMm) * MM_TO_MIL;
  const specials = Array.isArray(constraintRecord.specialViaConstructions)
    ? constraintRecord.specialViaConstructions
    : [];
  const pads = Array.isArray(raw.pads) ? raw.pads : [];
  const vias = Array.isArray(raw.vias) ? raw.vias : [];
  const violations = [];
  const acceptedSpecialConstructions = [];
  const unsupportedPads = [];
  const viaPrimitiveCounts = new Map();
  for (const via of vias) {
    if (typeof via.primitiveId !== "string" || !via.primitiveId.trim()) continue;
    viaPrimitiveCounts.set(
      via.primitiveId,
      (viaPrimitiveCounts.get(via.primitiveId) || 0) + 1,
    );
  }
  const unsupportedVias = vias
    .map((via) => {
      const x = finiteNumber(via.x);
      const y = finiteNumber(via.y);
      const diameter = finiteNumber(via.diameter);
      const holeDiameter = finiteNumber(via.holeDiameter);
      if (
        typeof via.primitiveId === "string" &&
        via.primitiveId.trim() &&
        viaPrimitiveCounts.get(via.primitiveId) === 1 &&
        x !== undefined &&
        y !== undefined &&
        diameter !== undefined &&
        diameter > 0 &&
        holeDiameter !== undefined &&
        holeDiameter >= 0
      ) return null;
      return {
        primitiveId: via.primitiveId || null,
        reason: "via requires a unique exact primitive ID, finite x/y, positive diameter, and non-negative hole diameter",
      };
    })
    .filter(Boolean);
  const unsupportedViaIds = new Set(unsupportedVias.map((via) => via.primitiveId));
  const validVias = vias.filter((via) => !unsupportedViaIds.has(via.primitiveId || null));
  for (const pad of pads) {
    const converted = padPolygon(pad, constraintRecord);
    if (!converted.supported) {
      unsupportedPads.push({
        designator: pad.designator || "",
        padNumber: pad.padNumber || "",
        primitiveId: pad.primitiveId || null,
        reason: converted.reason,
      });
      continue;
    }
    for (const via of validVias) {
      const viaRadius = finiteNumber(via.diameter) / 2;
      const holeRadius = finiteNumber(via.holeDiameter) / 2;
      const center = { x: finiteNumber(via.x), y: finiteNumber(via.y) };
      const padEdgeDistance = pointPolygonSignedDistance(center, converted.polygon);
      const copperEdgeClearanceMil = padEdgeDistance - viaRadius;
      const drillEdgeClearanceMil = holeRadius > 0 ? padEdgeDistance - holeRadius : null;
      if (copperEdgeClearanceMil + EPSILON >= requiredClearanceMil) continue;
      const special = specials.find(
        (item) =>
          item?.viaPrimitiveId === via.primitiveId &&
          item?.padDesignator === pad.designator &&
          String(item?.padNumber) === String(pad.padNumber),
      );
      const finding = {
        viaPrimitiveId: via.primitiveId || null,
        viaNet: via.net || "",
        viaX: finiteNumber(via.x),
        viaY: finiteNumber(via.y),
        viaDiameterMil: finiteNumber(via.diameter),
        viaHoleDiameterMil: finiteNumber(via.holeDiameter),
        padPrimitiveId: pad.primitiveId || null,
        padDesignator: pad.designator || "",
        padNumber: String(pad.padNumber || ""),
        padNet: pad.net || "",
        padShape: converted.kind,
        requiredCopperClearanceMil: requiredClearanceMil,
        copperEdgeClearanceMil,
        drillEdgeClearanceMil,
        copperOverlap: copperEdgeClearanceMil < -EPSILON,
        drillOverlap: drillEdgeClearanceMil !== null && drillEdgeClearanceMil < -EPSILON,
        sameNet: Boolean(via.net && via.net === pad.net),
      };
      if (special) {
        acceptedSpecialConstructions.push({ ...finding, construction: special });
      } else {
        violations.push(finding);
      }
    }
  }
  return {
    requiredClearanceMil,
    checkedPadCount: pads.length - unsupportedPads.length,
    checkedViaCount: validVias.length,
    violations,
    acceptedSpecialConstructions,
    unsupportedPads,
    unsupportedVias,
  };
}

function analyzeComponentPlacement(raw, constraintRecord = {}) {
  const components = Array.isArray(raw.components) ? raw.components : [];
  const identityCounts = (items, field) => {
    const counts = new Map();
    for (const item of items) {
      const value = item?.[field];
      if (typeof value !== "string" || !value.trim()) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
  };
  const designatorCounts = identityCounts(components, "designator");
  const componentPrimitiveCounts = identityCounts(components, "primitiveId");
  const componentIdentityConflicts = [];
  for (const component of components) {
    if (typeof component.designator !== "string" || !component.designator.trim()) {
      componentIdentityConflicts.push({
        primitiveId: component.primitiveId || null,
        reason: "component lacks a non-empty designator",
      });
    } else if (designatorCounts.get(component.designator) !== 1) {
      componentIdentityConflicts.push({
        designator: component.designator,
        primitiveId: component.primitiveId || null,
        reason: "component designator is not unique",
      });
    }
    if (typeof component.primitiveId !== "string" || !component.primitiveId.trim()) {
      componentIdentityConflicts.push({
        designator: component.designator || "",
        reason: "component lacks a non-empty primitiveId",
      });
    } else if (componentPrimitiveCounts.get(component.primitiveId) !== 1) {
      componentIdentityConflicts.push({
        designator: component.designator || "",
        primitiveId: component.primitiveId,
        reason: "component primitiveId is not unique",
      });
    }
  }
  const componentByDesignator = new Map(
    components.filter((item) => item.designator).map((item) => [item.designator, item]),
  );
  const componentByPrimitiveId = new Map(
    components.filter((item) => item.primitiveId).map((item) => [item.primitiveId, item]),
  );
  const bboxes = components
    .map((component) => ({ component, polygon: bboxPolygon(component.bbox) }))
    .filter((item) => item.polygon);
  const bboxCandidates = [];
  for (let first = 0; first < bboxes.length; first += 1) {
    for (let second = first + 1; second < bboxes.length; second += 1) {
      const a = bboxes[first].component;
      const b = bboxes[second].component;
      if (a.layer !== b.layer) continue;
      if (polygonsIntersect(bboxes[first].polygon, bboxes[second].polygon)) {
        bboxCandidates.push({
          firstDesignator: a.designator,
          secondDesignator: b.designator,
          pair: pairKey(a.designator, b.designator),
          evidence: "EASYEDA_COMPONENT_BBOX_SCREEN_ONLY",
        });
      }
    }
  }

  const envelopes = (Array.isArray(constraintRecord.assemblyEnvelopes)
    ? constraintRecord.assemblyEnvelopes
    : [])
    .map((envelope) => ({
      envelope,
      polygon: envelopePolygon(envelope, componentByDesignator),
      courtyardPolygon: envelope.courtyard
        ? envelopePolygon(
          { designator: envelope.designator, courtyard: envelope.courtyard },
          componentByDesignator,
        )
        : undefined,
      bodyPolygon: envelope.body
        ? envelopePolygon(
          { designator: envelope.designator, body: envelope.body },
          componentByDesignator,
        )
        : undefined,
      oppositeSideCourtyardPolygon: envelope.oppositeSideCourtyard
        ? envelopePolygon(
          { designator: envelope.designator, courtyard: envelope.oppositeSideCourtyard },
          componentByDesignator,
        )
        : undefined,
    }));
  const envelopeIsValid = (item) => (
    item.polygon &&
    item.courtyardPolygon &&
    (!item.envelope.oppositeSideCourtyard || item.oppositeSideCourtyardPolygon)
  );
  const invalidEnvelopes = envelopes
    .filter((item) => !envelopeIsValid(item))
    .map((item) => item.envelope?.designator || "<missing-designator>");
  const validEnvelopes = envelopes.filter(envelopeIsValid);
  const validEnvelopeDesignators = new Set(
    validEnvelopes.map((item) => item.envelope.designator).filter(Boolean),
  );
  const missingEnvelopeDesignators = components
    .map((item) => item.designator)
    .filter((designator) => designator && !validEnvelopeDesignators.has(designator));
  const exactConflicts = [];
  const exactPairCoverage = new Set();
  const sidePolygons = (entry, component) => [
    { layer: component?.layer, polygon: entry.courtyardPolygon, side: "OWNER" },
    ...(entry.oppositeSideCourtyardPolygon
      ? [{
        layer: oppositeCopperLayer(component?.layer),
        polygon: entry.oppositeSideCourtyardPolygon,
        side: "OPPOSITE",
      }]
      : []),
  ].filter((item) => item.polygon);
  for (let first = 0; first < validEnvelopes.length; first += 1) {
    for (let second = first + 1; second < validEnvelopes.length; second += 1) {
      const a = validEnvelopes[first].envelope;
      const b = validEnvelopes[second].envelope;
      const componentA = componentByDesignator.get(a.designator);
      const componentB = componentByDesignator.get(b.designator);
      if (!componentA || !componentB) continue;
      const key = pairKey(a.designator, b.designator);
      for (const sideA of sidePolygons(validEnvelopes[first], componentA)) {
        for (const sideB of sidePolygons(validEnvelopes[second], componentB)) {
          if (sideA.layer !== sideB.layer) continue;
          exactPairCoverage.add(key);
          if (polygonsIntersect(sideA.polygon, sideB.polygon)) {
            exactConflicts.push({
              firstDesignator: a.designator,
              secondDesignator: b.designator,
              pair: key,
              layer: sideA.layer,
              firstSide: sideA.side,
              secondSide: sideB.side,
              evidence: "SOURCED_COURTYARD_GEOMETRY",
              firstSource: a.source,
              secondSource: b.source,
            });
          }
        }
      }
    }
  }
  const unresolvedBboxCandidates = bboxCandidates.filter(
    (candidate) => !exactPairCoverage.has(candidate.pair),
  );

  const padGeometry = padPolygonsByOwner(raw, constraintRecord);
  const padPrimitiveCounts = identityCounts(
    Array.isArray(raw.pads) ? raw.pads : [],
    "primitiveId",
  );
  const padBindingIssue = (pad) => {
    const designatorOwner = componentByDesignator.get(pad.designator);
    const primitiveOwner = componentByPrimitiveId.get(pad.parentComponentPrimitiveId);
    if (!pad.designator || !designatorOwner) {
      return "pad designator owner is absent from the live component set";
    }
    if (
      typeof pad.primitiveId !== "string" ||
      !pad.primitiveId.trim() ||
      padPrimitiveCounts.get(pad.primitiveId) !== 1
    ) {
      return "pad primitiveId is missing or not unique";
    }
    if (!pad.parentComponentPrimitiveId || !primitiveOwner) {
      return "pad parentComponentPrimitiveId owner is absent from the live component set";
    }
    if (designatorOwner !== primitiveOwner) {
      return "pad designator and parentComponentPrimitiveId resolve to different components";
    }
    return null;
  };
  const unownedPads = padGeometry.converted
    .map(({ pad }) => ({ pad, reason: padBindingIssue(pad) }))
    .filter(({ reason }) => reason)
    .map(({ pad, reason }) => ({
      primitiveId: pad.primitiveId || null,
      parentComponentPrimitiveId: pad.parentComponentPrimitiveId || null,
      designator: pad.designator || "",
      padNumber: String(pad.padNumber || ""),
      reason,
    }));
  const boundPadGeometry = padGeometry.converted.filter(({ pad }) => !padBindingIssue(pad));
  const ownPadOutsideCourtyard = [];
  const missingOppositeSideCourtyardDesignators = [];
  const missingPadstackProjectionEvidence = [];
  for (const entry of validEnvelopes) {
    const component = componentByDesignator.get(entry.envelope.designator);
    if (!component || !entry.courtyardPolygon) continue;
    const ownedPads = boundPadGeometry.filter(
      ({ pad }) => pad.designator === entry.envelope.designator,
    );
    if (
      ownedPads.some(({ pad }) => padSpansBothSides(pad)) &&
      !entry.oppositeSideCourtyardPolygon
    ) {
      missingOppositeSideCourtyardDesignators.push(entry.envelope.designator);
    }
    for (const padEntry of ownedPads) {
      if (padSpansBothSides(padEntry.pad)) {
        const evidence = Array.isArray(entry.envelope.padstackProjectionEvidence)
          ? entry.envelope.padstackProjectionEvidence.find(
            (item) => String(item?.padNumber || "") === String(padEntry.pad.padNumber || ""),
          )
          : undefined;
        if (
          evidence?.policy !== "MAXIMUM_COPPER_PROJECTION" ||
          typeof evidence?.source !== "string" ||
          !evidence.source.trim()
        ) {
          missingPadstackProjectionEvidence.push({
            designator: entry.envelope.designator,
            padNumber: String(padEntry.pad.padNumber || ""),
            padPrimitiveId: padEntry.pad.primitiveId || null,
            reason: "through-hole/multilayer pad lacks sourced maximum-copper-projection evidence",
          });
        }
      }
      if (padEntry.pad.designator !== entry.envelope.designator) continue;
      const requiredCourtyards = [entry.courtyardPolygon];
      if (padSpansBothSides(padEntry.pad) && entry.oppositeSideCourtyardPolygon) {
        requiredCourtyards.push(entry.oppositeSideCourtyardPolygon);
      }
      if (requiredCourtyards.some((courtyard) => !polygonContainsPolygon(courtyard, padEntry.polygon))) {
        ownPadOutsideCourtyard.push({
          designator: entry.envelope.designator,
          padNumber: String(padEntry.pad.padNumber || ""),
          padPrimitiveId: padEntry.pad.primitiveId || null,
          padShape: padEntry.kind,
          courtyardSource: entry.envelope.source,
          reason: "live pad copper extends outside the sourced assembly courtyard",
        });
      }
    }
  }

  const crossComponentPadConflicts = [];
  const crossComponentPadClearanceViolations = [];
  const requiredForeignPadClearanceMil =
    Number(constraintRecord?.assembly?.foreignPadCopperClearanceMm) * MM_TO_MIL;
  for (let first = 0; first < boundPadGeometry.length; first += 1) {
    for (let second = first + 1; second < boundPadGeometry.length; second += 1) {
      const a = boundPadGeometry[first];
      const b = boundPadGeometry[second];
      if (!a.pad.designator || !b.pad.designator || a.pad.designator === b.pad.designator) continue;
      const componentA = componentByDesignator.get(a.pad.designator);
      const componentB = componentByDesignator.get(b.pad.designator);
      if (!componentA || !componentB) continue;
      const layersCanMeet =
        padSpansBothSides(a.pad) ||
        padSpansBothSides(b.pad) ||
        finiteNumber(a.pad.layer) === finiteNumber(b.pad.layer);
      if (!layersCanMeet) continue;
      const clearanceMil = polygonDistance(a.polygon, b.polygon);
      const finding = {
        firstDesignator: a.pad.designator,
        firstPadNumber: String(a.pad.padNumber || ""),
        firstPadPrimitiveId: a.pad.primitiveId || null,
        secondDesignator: b.pad.designator,
        secondPadNumber: String(b.pad.padNumber || ""),
        secondPadPrimitiveId: b.pad.primitiveId || null,
        pair: pairKey(a.pad.designator, b.pad.designator),
        evidence: "LIVE_PAD_COPPER_GEOMETRY",
      };
      if (clearanceMil <= EPSILON) {
        crossComponentPadConflicts.push(finding);
      } else if (
        Number.isFinite(requiredForeignPadClearanceMil) &&
        clearanceMil + EPSILON < requiredForeignPadClearanceMil
      ) {
        crossComponentPadClearanceViolations.push({
          ...finding,
          clearanceMil,
          requiredClearanceMil: requiredForeignPadClearanceMil,
        });
      }
    }
  }

  const padToForeignCourtyardConflicts = [];
  for (const padEntry of boundPadGeometry) {
    const owner = componentByDesignator.get(padEntry.pad.designator);
    if (!owner) continue;
    for (const envelopeEntry of validEnvelopes) {
      const foreign = componentByDesignator.get(envelopeEntry.envelope.designator);
      if (!foreign || foreign.designator === padEntry.pad.designator) continue;
      for (const side of sidePolygons(envelopeEntry, foreign)) {
        if (
          !padAppliesToLayer(padEntry.pad, side.layer) ||
          !polygonsIntersect(padEntry.polygon, side.polygon)
        ) continue;
        padToForeignCourtyardConflicts.push({
          padDesignator: padEntry.pad.designator,
          padNumber: String(padEntry.pad.padNumber || ""),
          padPrimitiveId: padEntry.pad.primitiveId || null,
          foreignDesignator: foreign.designator,
          foreignSide: side.side,
          layer: side.layer,
          pair: pairKey(padEntry.pad.designator, foreign.designator),
          evidence: "LIVE_PAD_AGAINST_SOURCED_COURTYARD",
          foreignCourtyardSource: envelopeEntry.envelope.source,
        });
      }
    }
  }

  const criticalZoneViolations = [];
  const criticalZoneUnverified = [];
  for (const zone of Array.isArray(constraintRecord.criticalPlacementZones)
    ? constraintRecord.criticalPlacementZones
    : []) {
    const zoneOwner = componentByDesignator.get(zone.ownerDesignator);
    if (!zoneOwner) {
      criticalZoneUnverified.push({
        id: zone.id,
        ownerDesignator: zone.ownerDesignator,
        reason: "critical-zone owner is absent from the live component set",
      });
      continue;
    }
    const zonePolygon = envelopePolygon(
      { ownerDesignator: zone.ownerDesignator, geometry: zone.geometry },
      componentByDesignator,
    );
    if (!zonePolygon) {
      criticalZoneUnverified.push({ id: zone.id, reason: "invalid critical-zone geometry" });
      continue;
    }
    const allowed = new Set([zone.ownerDesignator, ...(zone.allowedDesignators || [])]);
    for (const component of components) {
      if (!component.designator || allowed.has(component.designator)) continue;
      const exact = validEnvelopes.find(
        (item) => item.envelope.designator === component.designator,
      );
      const exactPolygons = [
        ...(exact ? sidePolygons(exact, component)
          .filter((item) => item.layer === zoneOwner.layer)
          .map((item) => item.polygon) : []),
        ...boundPadGeometry
        .filter(({ pad }) => pad.designator === component.designator)
        .filter(({ pad }) => padAppliesToLayer(
          pad,
          zoneOwner.layer,
        ))
        .map((item) => item.polygon),
      ]
        .filter(Boolean);
      const fallback = bboxPolygon(component.bbox);
      const intrudes = exactPolygons.length
        ? exactPolygons.some((polygon) => polygonsIntersect(zonePolygon, polygon))
        : fallback && polygonsIntersect(zonePolygon, fallback);
      if (!intrudes) continue;
      const finding = {
        zoneId: zone.id,
        ownerDesignator: zone.ownerDesignator,
        intrudingDesignator: component.designator,
        purpose: zone.purpose,
        evidence: exact
          ? "SOURCED_COURTYARD_PLUS_LIVE_PAD_GEOMETRY"
          : "EASYEDA_COMPONENT_BBOX_SCREEN_ONLY",
      };
      if (exact) criticalZoneViolations.push(finding);
      else criticalZoneUnverified.push(finding);
    }
  }
  return {
    bboxCandidates,
    unresolvedBboxCandidates,
    exactPairCoverage: [...exactPairCoverage].sort(),
    exactConflicts,
    ownPadOutsideCourtyard,
    missingOppositeSideCourtyardDesignators: [...new Set(missingOppositeSideCourtyardDesignators)].sort(),
    missingPadstackProjectionEvidence,
    componentIdentityConflicts,
    crossComponentPadConflicts,
    crossComponentPadClearanceViolations,
    requiredForeignPadClearanceMil,
    padToForeignCourtyardConflicts,
    unsupportedPadOccupancy: padGeometry.unsupported,
    unownedPads,
    invalidEnvelopes,
    missingEnvelopeDesignators,
    criticalZoneViolations,
    criticalZoneUnverified,
  };
}

function analyzeHumanInterfaces(raw, constraintRecord = {}) {
  const components = new Map(
    (raw.components || []).filter((item) => item.designator).map((item) => [item.designator, item]),
  );
  const violations = [];
  const unverified = [];
  for (const group of Array.isArray(constraintRecord.humanInterfaceGroups)
    ? constraintRecord.humanInterfaceGroups
    : []) {
    const refs = Array.isArray(group.designators) ? group.designators : [];
    const missing = refs.filter((reference) => !components.has(reference));
    if (missing.length) {
      violations.push({ groupId: group.id, reason: `missing designators: ${missing.join(", ")}` });
      continue;
    }
    if (group.decision === "GROUP_TOGETHER") {
      const maximum = Number(group.maxCenterSeparationMil);
      for (let first = 0; first < refs.length; first += 1) {
        for (let second = first + 1; second < refs.length; second += 1) {
          const a = components.get(refs[first]);
          const b = components.get(refs[second]);
          const distance = Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
          if (distance > maximum + EPSILON) {
            violations.push({
              groupId: group.id,
              firstDesignator: refs[first],
              secondDesignator: refs[second],
              centerSeparationMil: distance,
              maximumMil: maximum,
            });
          }
        }
      }
    }
    if (!group.accessEvidenceArtifact) {
      unverified.push({ groupId: group.id, reason: "missing access-envelope evidence" });
    }
  }
  return { violations, unverified };
}

function analyzeInterfacesAndBom(raw, constraintRecord = {}) {
  const components = new Map(
    (raw.components || []).filter((item) => item.designator).map((item) => [item.designator, item]),
  );
  const failures = [];
  const unverified = [];
  const interfaces = Array.isArray(constraintRecord.externalInterfaces)
    ? constraintRecord.externalInterfaces
    : [];
  const declared = new Set(interfaces.map((item) => item.designator));
  const policy = constraintRecord.bomNormalizationPolicy || {};
  const requireAllJ = policy?.connectors?.requireAllJDesignators !== false;
  if (requireAllJ) {
    for (const component of components.values()) {
      if (/^J\d+$/i.test(component.designator || "") && !declared.has(component.designator)) {
        unverified.push({
          designator: component.designator,
          reason: "connector-like designator is absent from externalInterfaces",
        });
      }
    }
  }
  for (const item of interfaces) {
    const component = components.get(item.designator);
    if (!component) {
      failures.push({ designator: item.designator, reason: "declared interface component is absent" });
      continue;
    }
    if (item.orderableMpn && item.orderableMpn !== component.manufacturerPartNumber) {
      failures.push({
        designator: item.designator,
        reason: "live manufacturer part number differs from interface record",
        expected: item.orderableMpn,
        actual: component.manufacturerPartNumber || null,
      });
    }
    if (item.expectedFootprintName && item.expectedFootprintName !== component.footprint?.name) {
      failures.push({
        designator: item.designator,
        reason: "live footprint differs from interface record",
        expected: item.expectedFootprintName,
        actual: component.footprint?.name || null,
      });
    }
    if (item.expectedModel3dUuid && item.expectedModel3dUuid !== component.model3D?.uuid) {
      failures.push({
        designator: item.designator,
        reason: "live 3D model differs from interface record",
        expected: item.expectedModel3dUuid,
        actual: component.model3D?.uuid || null,
      });
    }
  }

  const passivePolicy = policy.passives || {};
  const passiveExceptions = new Map(
    (passivePolicy.exceptions || []).map((item) => [item.designator, item]),
  );
  const preferredByPrefix = passivePolicy.preferredFootprintsByPrefix || {};
  for (const component of components.values()) {
    const match = String(component.designator || "").match(/^([A-Za-z]+)/);
    if (!match) continue;
    const allowed = preferredByPrefix[match[1].toUpperCase()];
    if (!Array.isArray(allowed) || !allowed.length) continue;
    if (!allowed.includes(component.footprint?.name) && !passiveExceptions.has(component.designator)) {
      failures.push({
        designator: component.designator,
        reason: "footprint violates declared passive-package policy",
        actual: component.footprint?.name || null,
        allowed,
      });
    }
  }

  const connectorPolicy = policy.connectors || {};
  const connectorExceptions = new Map(
    (connectorPolicy.exceptions || []).map((item) => [item.designator, item]),
  );
  const preferredSeries = connectorPolicy.preferredManufacturerSeries || [];
  if (preferredSeries.length) {
    for (const item of interfaces) {
      const component = components.get(item.designator);
      const mpn = String(component?.manufacturerPartNumber || "");
      if (
        component &&
        !preferredSeries.some((series) => mpn.startsWith(series)) &&
        !connectorExceptions.has(item.designator)
      ) {
        failures.push({
          designator: item.designator,
          reason: "connector MPN is outside preferred series without an exception",
          actual: mpn || null,
          preferredSeries,
        });
      }
    }
  }
  return { failures, unverified };
}

function analyzePlacementGeometry(raw, constraintRecord = {}) {
  return {
    boardContainment: analyzeBoardContainment(raw, constraintRecord),
    viaPad: analyzeViaPadGeometry(raw, constraintRecord),
    componentPlacement: analyzeComponentPlacement(raw, constraintRecord),
    humanInterfaces: analyzeHumanInterfaces(raw, constraintRecord),
    interfacesAndBom: analyzeInterfacesAndBom(raw, constraintRecord),
  };
}

export {
  MM_TO_MIL,
  analyzeBoardContainment,
  analyzeComponentPlacement,
  analyzeHumanInterfaces,
  analyzeInterfacesAndBom,
  analyzePlacementGeometry,
  analyzeViaPadGeometry,
  bboxPolygon,
  envelopePolygon,
  padPolygon,
  pointPolygonSignedDistance,
  polygonsIntersect,
  polygonDistance,
  rectanglePolygon,
  rotatePoint,
};

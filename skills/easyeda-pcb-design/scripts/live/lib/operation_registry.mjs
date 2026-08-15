const MODES = Object.freeze([
  "route",
  "repair",
  "placement",
  "outline",
  "copper",
]);

const OPERATION_DEFINITIONS = Object.freeze({
  "line.create": Object.freeze({
    collection: "lines",
    delta: 1,
    destructive: false,
    modes: Object.freeze(["route", "repair", "outline"]),
    api: "eda.pcb_PrimitiveLine.create",
  }),
  "line.delete": Object.freeze({
    collection: "lines",
    delta: -1,
    destructive: true,
    modes: Object.freeze(["repair", "outline"]),
    api: "eda.pcb_PrimitiveLine.delete",
  }),
  "via.create": Object.freeze({
    collection: "vias",
    delta: 1,
    destructive: false,
    modes: Object.freeze(["route", "repair"]),
    api: "eda.pcb_PrimitiveVia.create",
  }),
  "via.delete": Object.freeze({
    collection: "vias",
    delta: -1,
    destructive: true,
    modes: Object.freeze(["repair"]),
    api: "eda.pcb_PrimitiveVia.delete",
  }),
  "component.modify": Object.freeze({
    collection: "components",
    delta: 0,
    destructive: true,
    modes: Object.freeze(["placement", "repair"]),
    api: "eda.pcb_PrimitiveComponent.modify",
  }),
  "polyline.create": Object.freeze({
    collection: "polylines",
    delta: 1,
    destructive: false,
    modes: Object.freeze(["outline", "repair"]),
    api: "eda.pcb_PrimitivePolyline.create",
  }),
  "polyline.delete": Object.freeze({
    collection: "polylines",
    delta: -1,
    destructive: true,
    modes: Object.freeze(["outline", "repair"]),
    api: "eda.pcb_PrimitivePolyline.delete",
  }),
  "pour.delete": Object.freeze({
    collection: "pours",
    delta: -1,
    destructive: true,
    modes: Object.freeze(["copper", "repair"]),
    api: "eda.pcb_PrimitivePour.delete",
  }),
  "poured.delete": Object.freeze({
    collection: "poured",
    delta: -1,
    destructive: true,
    modes: Object.freeze(["copper", "repair"]),
    api: "eda.pcb_PrimitivePoured.delete",
  }),
});

// This registry is deliberately broader than the generic geometry runner. It
// makes every historical write pattern land in one explicit disposition so an
// agent cannot respond to an unsupported case by generating another ad-hoc
// script. "transaction" methods are implemented by the operation registry;
// "runtime" methods are owned by the shared executor; "dedicated" methods need
// their own evidence contract; and "refused" methods may not be generalized.
const API_CAPABILITY_REGISTRY = Object.freeze({
  "eda.pcb_PrimitiveLine.create": Object.freeze({ disposition: "transaction", operation: "line.create" }),
  "eda.pcb_PrimitiveLine.delete": Object.freeze({ disposition: "transaction", operation: "line.delete" }),
  "eda.pcb_PrimitiveVia.create": Object.freeze({ disposition: "transaction", operation: "via.create" }),
  "eda.pcb_PrimitiveVia.delete": Object.freeze({ disposition: "transaction", operation: "via.delete" }),
  "eda.pcb_PrimitiveComponent.modify": Object.freeze({ disposition: "transaction", operation: "component.modify" }),
  "eda.pcb_PrimitivePolyline.create": Object.freeze({ disposition: "transaction", operation: "polyline.create" }),
  "eda.pcb_PrimitivePolyline.delete": Object.freeze({ disposition: "transaction", operation: "polyline.delete" }),
  "eda.pcb_PrimitivePour.delete": Object.freeze({ disposition: "transaction", operation: "pour.delete" }),
  "eda.pcb_PrimitivePoured.delete": Object.freeze({ disposition: "transaction", operation: "poured.delete" }),
  "eda.pcb_Document.save": Object.freeze({ disposition: "runtime", owner: "transaction_runner" }),
  "eda.pcb_Drc.check": Object.freeze({ disposition: "runtime", owner: "current_state_and_verifier" }),
  "eda.pcb_MathPolygon.createPolygon": Object.freeze({ disposition: "runtime", owner: "polyline_operation_adapter" }),
  "eda.pcb_Net.setNetlist": Object.freeze({ disposition: "dedicated", owner: "netlist_sync_gate" }),
  "eda.pcb_Document.importChanges": Object.freeze({ disposition: "dedicated", owner: "schematic_to_pcb_handoff" }),
  "eda.pcb_Document.autoRouting": Object.freeze({ disposition: "dedicated", owner: "bounded_autoroute_gate" }),
  "eda.pcb_Document.clearRouting": Object.freeze({ disposition: "refused", owner: "selection_dependent_bulk_delete" }),
  "eda.dmt_Pcb.deletePcb": Object.freeze({ disposition: "refused", owner: "protected_project_cleanup" }),
  "eda.dmt_Board.deleteBoard": Object.freeze({ disposition: "refused", owner: "protected_project_cleanup" }),
});

const COLLECTIONS = Object.freeze([
  "lines",
  "vias",
  "components",
  "polylines",
  "pours",
  "poured",
]);

function operationDefinition(type) {
  return OPERATION_DEFINITIONS[type] || null;
}

function expectedDeltas(operations = []) {
  const deltas = Object.fromEntries(COLLECTIONS.map((name) => [name, 0]));
  for (const operation of operations) {
    const definition = operationDefinition(operation?.type);
    if (definition) deltas[definition.collection] += definition.delta;
  }
  return deltas;
}

function operationCounts(operations = []) {
  const counts = {};
  for (const operation of operations) {
    const type = operation?.type || "unknown";
    counts[type] = (counts[type] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export {
  API_CAPABILITY_REGISTRY,
  COLLECTIONS,
  MODES,
  OPERATION_DEFINITIONS,
  expectedDeltas,
  operationCounts,
  operationDefinition,
};

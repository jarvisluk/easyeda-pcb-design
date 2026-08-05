# EasyEDA API map for general design

This file lists **names only**. Before any live call, open the matching
`easyeda-api` class/enum document. If the companion skill or bridge is missing,
stop — do not invent signatures.

## Safety

- Confirm project + active document before writes.
- Require explicit user confirmation before delete, mass net change, or bulk
  overwrite operations.
- After create/modify, read back IDs and state; do not assume success from a
  void return.
- Manufacturing export (`PCB_ManufactureData`) only after design validation and
  with user intent to generate outputs.

## Document and project

- `DMT_Project` — open/current project state.
- `DMT_SelectControl` — active document and type.
- `DMT_Schematic` and `DMT_Pcb` — project document discovery.
- `DMT_EditorControl` — open or activate documents.

## Schematic

- `SCH_PrimitiveComponent` — components and pins.
- `SCH_PrimitiveWire` — wires.
- `SCH_PrimitiveNetLabel`, `SCH_PrimitivePowerPort`, and related net symbols.
- `SCH_Drc` — schematic DRC.
- `SCH_Document` — save/view operations.

Schematic coordinates use 10 mil per unit. Read the exact symbol/component creation signature and verify `{libraryUuid, uuid}` identifiers.

## PCB

- `PCB_PrimitiveComponent`, `PCB_PrimitivePad`, `PCB_PrimitiveLine`, `PCB_PrimitiveArc`, and `PCB_PrimitiveVia`.
- `PCB_PrimitivePour` and `IPCB_PrimitivePoured`.
- `PCB_Layer` and `EPCB_LayerId`.
- `PCB_Drc` and `PCB_Document`.
- `PCB_ManufactureData` for manufacturing output only after design validation.

PCB coordinates use 1 mil per unit.

## Readback rules

- Verify project and active document before any operation.
- Use documented enums rather than raw numeric layer or document values.
- Await every `Promise`.
- After creation, require a returned object/primitive ID and query it again.
- After modification, use the documented async primitive pattern and call `done()`.
- After copper rebuild, call `getCopperRegion()` and inspect `getState_PourFills()`.
- Use `check(true, false, true)` for detailed silent DRC output.

## Audit limitations

The bundled audit intentionally does not infer:

- circuit correctness from net names;
- exact unrouted-connection count;
- closed-loop board-outline topology;
- component courtyard overlap or enclosure collision;
- creepage/clearance requirements without voltage/category inputs;
- trace temperature rise or voltage drop without electrical inputs;
- high-speed signal integrity.

Use EasyEDA's native connectivity/DRC views, manufacturing previews, and manual review for these items.


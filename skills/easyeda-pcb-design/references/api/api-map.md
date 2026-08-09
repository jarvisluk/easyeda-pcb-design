# EasyEDA API map for general design

## Contents

- Safety
- Document and project
- Schematic
- Identity, synchronization, and existing-board repair
- PCB
- Readback rules
- Audit limitations

This file lists **names only**. Before any live call, open the matching
`easyeda-api` class/enum document. If the companion skill or bridge is missing,
stop — do not invent signatures.

## Safety

- Confirm project + active document before writes.
- Apply the authorization profile selected in `SKILL.md`. `USER_OWNED` requires
  operation-specific confirmation for destructive/bulk work; `AI_DEDICATED`
  provides standing authorization only for project-local mutations within the
  stated objective. Verification gates remain identical.
- After create/modify, read back IDs and state; do not assume success from a
  void return.
- Qualify unknown or beta write sequences in a dedicated probe project. Do not
  use the production project as an API behavior test surface.
- Manufacturing export (`PCB_ManufactureData`) only after design validation and
  with user intent to generate outputs.

## Document and project

- `DMT_Project` — open/current project state.
- `DMT_SelectControl` — active document and type.
- `DMT_Schematic` and `DMT_Pcb` — project document discovery.
- `DMT_EditorControl` — open or activate documents.

`DMT_Board.createBoard()` is beta. Live regression on EasyEDA Pro showed that
associating an existing schematic with a new PCB reparents that schematic away
from its previous Board. It also showed successful rename return values whose
new names were not immediately reflected by `getAllBoardsInfo()` /
`getAllPcbsInfo()`. Treat the returned Board/PCB UUIDs and full tree readback as
the source of truth; do not assume the source Board keeps its schematic.

Do not call `DMT_Board.createBoard()` without a documented argument sequence in
a production project. EasyEDA Pro 3.2.166 beta created a complete empty Board,
default schematic page, and PCB instead of an empty container. Removing the
last schematic page later removed the empty Board asynchronously. Requalify
these behaviors after any EasyEDA or companion version change.

`copySchematic()` and `copySchematicPage()` can complete asynchronously. Live
regression produced a delayed copied page followed by a second explicitly
copied duplicate page. A copy can also carry hidden component/netlist identity
state from its source. Do not use a copy as proof of a clean document; compare
settled page counts and semantic content, and rebuild from scratch when the
source identity cache is suspect.

`PCB_Document.importChanges()` initiates the native document-level "Import
Changes" synchronization after an API-built PCB. It is a bulk synchronization:
export and compare schematic/PCB netlists first, then close the applicable
authorization-profile and rollback gates before calling it. Run it before routing whenever possible and
read back components, unique IDs, pads, nets, placement, and DRC afterward. A
`true` return is not proof that the native mismatch was committed: live
regression showed zero PCB geometry changes while native DRC and
`SYS_Tool.netlistComparison()` still reported the stale comparison cache.
Require both a manufacturing-netlist match and a native document match.

`SYS_Tool.netlistComparison()` expects the parent schematic UUID rather than a
schematic page UUID in this workflow. Its runtime fields may be `type`,
`object`, `net1`, and `net2`, which differ from the documented return property
names. `null` is also possible and must be treated as unavailable, not a match.
Use `scripts/easyeda_netlist_compare.mjs --schematic-uuid ...` to capture this
read-only second view. `PCB_Net.setNetlist()` is a possible API-only fallback,
but it is a bulk netlist overwrite and requires the selected profile to cover
the operation plus before/after semantic capture, separately verified rollback
evidence, native comparison, and DRC readback. `USER_OWNED` requires separate
confirmation; `AI_DEDICATED` may use standing authorization when the operation
is necessary for the stated objective.
Use `scripts/easyeda_netlist_compare.mjs` for the read-only preflight; it uses
`SCH_ManufactureData.getNetlistFile()` and
`PCB_ManufactureData.getNetlistFile()` rather than the obsolete
`SCH_Netlist.getNetlist()` API.

## Schematic

- `SCH_PrimitiveComponent` — components and pins.
- `SCH_PrimitiveWire` — wires.
- `SCH_PrimitiveNetLabel`, `SCH_PrimitivePowerPort`, and related net symbols.
- `SCH_Drc` — schematic DRC.
- `SCH_Document` — save/view operations.

Schematic coordinates use 10 mil per unit. Read the exact symbol/component creation signature and verify `{libraryUuid, uuid}` identifiers.

Establish component `designator` and `uniqueId` atomically through supported
`SCH_PrimitiveComponent.create()` arguments or one complete
`SCH_PrimitiveComponent.modify()` call. Do not establish either identity field
through separate primitive state setters. Live regression showed setters could
change visible state while the hidden exported netlist retained
`UNIQUE<designator>` keys.

After the first real component, then after a second component plus one
representative connection, save, activate another document, reopen the page,
and run `easyeda_identity_preflight.mjs`. Require the live unique ID, JLCEDA
component key, and exported `Unique ID` property to be identical, nonempty, and
unique before continuing population.

`SCH_PrimitiveComponent.getAll()` also returns `netport` and net-flag
primitives. Filter with `getState_ComponentType()` and retain only
`"part"` before BOM, designator, or footprint validation. Treat an
undefined type as a component for compatibility with older bridge objects.

## Identity, synchronization, and existing-board repair

Before routing, run `easyeda_netlist_compare.mjs --require-native-match` and
`easyeda_identity_preflight.mjs --require-native-match`. Manufacturing equality
alone cannot close the gate. The identity preflight rejects divergent nonempty
runtime PCB netlist views even when one view matches the manufacturing export.

If synchronization fails, perform semantic readback in the same document and
test one recorded repair hypothesis. One separately authorized diagnostic PCB
may be used when the current document's hidden identity is demonstrably
unrepairable. If that candidate fails the same gate, stop. Do not cascade
through copied schematics, additional Boards, `importChanges()`, and
`setNetlist()` as unbounded retries.

Do not apply this pre-routing construction gate retroactively to an already
routed board when a requested repair changes only track/via geometry. In that
branch, require an exact active-PCB UUID, immutable pre-transaction semantic
capture, operation-scoped rollback evidence for destructive work,
manufacturing-netlist equality bound to that UUID, unchanged component/pad-net
identity, target-net connectivity readback, and detailed DRC before and after
each bounded edit. A stale or unavailable native comparison is permitted only
as a recorded cache exception under [high-speed-constraints.md](../high-speed/high-speed-constraints.md);
it never proves synchronization and cannot mask another DRC leaf. If the edit
touches schematic identity, component population, footprint/pad mapping, or net
binding, leave repair mode and close the applicable construction/synchronization
gate before further routing.

## PCB

- `PCB_PrimitiveComponent`, `PCB_PrimitivePad`, `PCB_PrimitiveLine`, `PCB_PrimitiveArc`, and `PCB_PrimitiveVia`.
- `PCB_PrimitivePour` and `IPCB_PrimitivePoured`.
- `PCB_Layer` and `EPCB_LayerId`.
- `PCB_Drc` and `PCB_Document`.
- `PCB_ManufactureData` for manufacturing output only after design validation.

For manufacturing files, use the exact `PCB_ManufactureData.getGerberFile()`,
`getBomFile()`, `getPickAndPlaceFile()`, and optional `getPcbInfoFile()` docs.
Save into a new revision directory with
`SYS_FileSystem.saveFileToFileSystem(uri, file, undefined, false)` and read the
result back from the host filesystem. Never call a `place*Order()` API.

Live EasyEDA Pro 3.2.166 regression found that `getPcbInfoFile()` can return
`text/plain` and report `0mil x 0mil` despite a valid nonzero closed Gerber
outline, while `getIpcD356AFile()` can throw while destructuring a null internal
result. Treat these beta outputs as optional diagnostics. Gerber/drill, BOM,
PnP and their regression audit remain the required manufacturing package.

PCB coordinates use 1 mil per unit.

## Readback rules

- Verify project and active document before any operation.
- Use documented enums rather than raw numeric layer or document values.
- Await every `Promise`.
- After creation, require a returned object/primitive ID and query it again.
- After modification, use the documented async primitive pattern and call `done()`.
- After copper rebuild, call `getCopperRegion()` and inspect `getState_PourFills()`.
- For fill-only regeneration, retain and bind the exact source Pour and capture
  its settings plus generated Poured/fill IDs. Under `AI_DEDICATED`, this
  semantic evidence closes the pre-edit evidence requirement without a native
  duplicate because only derived fills are removed. Delete fills through the
  expected `IPCB_PrimitivePoured.deletePourFills()` instance, prove the expected
  instance is absent, rebuild once through the expected Pour instance, then
  read the expected Poured instance again. The rebuild return can name a
  neighboring pour and is not authoritative. After save/reopen, compare the
  source Pour ID, net, layer, polygon, fill method, island policy, name,
  priority, line width, and lock state field-for-field with the capture.
- Before deleting source Pours or other non-derived design data, preserve a
  tested inverse or restorable EasyEDA revision/export appropriate to the
  operation. `easyeda_repair_snapshot.mjs` remains semantic evidence, not a
  restorable document.
- `preserveSilos` can read back `true` after a requested `false`. Require solid
  fill IDs and prove detailed DRC has no free-copper error targeting them.
- A primitive `create()` can commit and still throw. Before retrying, perform a
  semantic readback by net/layer/geometry and reuse the committed primitive.
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

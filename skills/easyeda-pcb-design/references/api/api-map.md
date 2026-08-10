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

After application or bridge recovery, reopen state in two explicit steps:
`DMT_Project.openProject(projectUuid)`, then
`DMT_EditorControl.openDocument(documentUuid)`. `activateDocument()` only
switches an already-open tab and is not a project-recovery primitive. Verify
both current project and document UUIDs before resuming writes.

Save through the active document class: `SCH_Document.save()` for a schematic
page and `PCB_Document.save()` for a PCB. `DMT_EditorControl` has no qualified
generic save call. After saving, switch away and reopen the UUID before using
state as committed evidence.

The bridge execution sandbox in EasyEDA Pro 3.2.166 did not expose documented
enum globals. When that happens, copy the exact named value from the matching
companion enum reference into a local frozen mapping and cite the enum/member;
do not guess a raw number at the call site.

`DMT_Project.createProject()` is beta and is the first live gate for a
no-design build. It cannot be qualified inside an already-created disposable
probe project, and the companion exposes no project-deletion API. Preflight the
intended workspace and team, enumerate the target team's project UUIDs, then
make one production-intended create call using the final project name. Enumerate
again even when the return is `undefined`; a committed UUID found by semantic
readback is authoritative and must not be retried. Open the exact returned or
enumerated UUID and require an empty design state before any schematic write.
That state may be a zero-document tree or a qualified blank default scaffold.
If no UUID appears, apply the single recorded-hypothesis retry ceiling from the
live gates, then stop rather than falling back to an existing project, source
import, filesystem synthesis, or unverified UI mutation.

EasyEDA Pro 3.2.166 local-filesystem regression found that `createProject()`
returned `undefined` and created no enumerated project both with omitted team
and with the explicit local project-team path. Treat a from-zero build in that
environment as externally blocked until the user creates the target or
explicitly authorizes one UI creation attempt. For that exception, use the
final name, open in a new window when the prior project may be unsaved, and
perform no UI design edits. EasyEDA Pro 3.2.166 UI creation produced one Board,
one Schematic/page, one PCB, and one Panel. Accept that scaffold only after
companion readback proves the schematic has no `part` components or wires and
the PCB has no components, lines, arcs, vias, Pours/fills, or regions. Bind all
UUIDs and reuse the blank Schematic/PCB; otherwise preserve the unexpected
candidate and stop. Never repurpose a similar pre-existing project.

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
read-only second view.

EasyEDA Pro 3.2.166 live regression also found a document-input false negative:
the parent-schematic/PCB UUID call reported all 17 schematic nets with an empty
PCB side after save, project reopen, full application/bridge restart, and
successful PCB population. At the same revision, the manufacturing exports,
`PCB_Net.getNetlist("JLCEDA")`, `PCB_Net.getAllNetsName()`, all 23 components'
numbered pad-net states, and `SYS_Tool.netlistComparison(schematicFile,
pcbFile)` agreed exactly. Page-UUID and documented object-form inputs returned
`undefined`. This is not evidence that every mismatch is harmless. Use
`easyeda_netlist_compare.mjs --allow-native-cache-exception` only after the
normal bounded synchronization path and require its exact multi-view verified
result defined in `live-build-gates.md`; manufacturing equality alone remains
insufficient.

`PCB_Net.setNetlist()` is a possible API-only fallback,
but it is a bulk netlist overwrite and requires the selected profile to cover
the operation plus before/after semantic capture, separately verified rollback
evidence, native comparison, and DRC readback. `USER_OWNED` requires separate
confirmation; `AI_DEDICATED` may use standing authorization when the operation
is necessary for the stated objective.

EasyEDA Pro 3.2.166 also returned `true` from
`PCB_Net.setNetlist(undefined, exportedSchematicNetlist)` against a verified
empty associated PCB while leaving zero PCB components and zero nets. A
successful boolean is therefore not proof that `setNetlist()` instantiated or
bound PCB content. Read back component and net counts before saving, restore
the exact pre-operation PCB netlist when the declared success gate is absent,
and treat this as the second synchronization failure rather than trying a UI
equivalent or another bulk path.

Use `scripts/easyeda_netlist_compare.mjs` for the read-only preflight; it uses
`SCH_ManufactureData.getNetlistFile()` and
`PCB_ManufactureData.getNetlistFile()` rather than the obsolete
`SCH_Netlist.getNetlist()` API.

Feed the resulting strict report to the final baseline audit with
`easyeda_design_audit.mjs --netlist-compare-report <report>`. A literal
`MATCH` or the complete `MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION` contract
can downgrade only an otherwise sole native `Netlist Error` / `Import Changes`
leaf bound to the same project and PCB UUID. The audit preserves the raw DRC
error; UUID mismatch, weak comparison evidence, or any additional physical,
clearance, connection, or free-copper error remains a failure.

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

For component-selection evidence, read back `getState_Manufacturer()`,
`getState_ManufacturerId()`, `getState_Supplier()`, `getState_SupplierId()`,
`getState_Footprint()`, `getState_UniqueId()`, and `getState_AddIntoPcb()`.
Treat the manufacturer ID as the live exact manufacturer-part-number binding,
not as proof that the library entry or part selection is electrically correct.

EasyEDA Pro 3.2.166 returned no matches from
`SCH_PrimitiveWire.getAll("+3V3")` immediately after creating that rail, while
unfiltered `getAll()` read back the committed primitive with net `+3V3` and
the expected geometry. For special-character rail names, use unfiltered
readback and compare primitive ID, `getState_Net()`, and geometry; never retry a
create solely because the filtered query is empty.

In the same version, `SCH_PrimitiveAttribute.createNetLabel()` could remain
pending until the bridge request timed out and commit no attribute. Do not
replay it blindly. A short `SCH_PrimitiveWire.create(..., net)` stub is an
acceptable API fallback only after one canary saves, reopens, and reads back
with the intended net. Keep each stub clear of every differently named stub:
touching endpoints can merge network names, and ERC then reports one wire with
multiple net names even when later unfiltered wire readback normalizes both
segments to one name.

That fallback qualifies connectivity behavior only. It is not authorization to
represent every pin or local functional connection as a short named stub. After
the canary, return to continuous local wiring and intentional rail, block, bus,
or page-boundary labels under
[schematic-presentation.md](../workflows/schematic-presentation.md). If the API
cannot produce a reviewable block, stop that page rather than multiplying the
fallback. Collect unfiltered wire geometry and connectivity annotations in the
baseline audit so the presentation gate can detect a label/stub regression.

Do not copy device-library association keys such as `Symbol`, `Footprint`,
`3D Model`, `Designator`, or `Name` into
`SCH_PrimitiveComponent.modify().otherProperty`. EasyEDA Pro 3.2.166 accepted
the call but ERC later classified the hidden Symbol/Footprint associations as
invalid and required deletion and fresh placement. Pass identity fields through
the documented top-level properties and retain only non-reserved descriptive
properties. After this corruption signature, a second `modify()` is not a
repair; preserve the surrounding wiring, delete only the affected component,
and recreate it from the exact library UUID/device UUID at the same pose.

`ISCH_PrimitiveComponentPin.setState_NoConnected(true)` and direct assignment
to `noConnected` changed the returned pin object in 3.2.166 but reverted on
immediate component-pin readback after save. Require saved/reopened readback or
ERC disappearance before claiming a no-connect flag. If no persistent API path
is qualified, record and classify the exact floating-pin ERC warning; do not
represent an in-memory setter result as committed design state.

## Identity, synchronization, and existing-board repair

Before routing, run `easyeda_netlist_compare.mjs --require-native-match` and
`easyeda_identity_preflight.mjs --require-native-match`. Manufacturing equality
alone cannot close the gate. The identity preflight rejects divergent nonempty
runtime PCB netlist views even when one view matches the manufacturing export.
For the exact strict false-negative path in `live-build-gates.md`, pair the
comparator's verified exception artifact with an ordinary identity-preflight
`MATCH` collected without a second native-document request; both artifacts must
bind to the same saved/reopened project, schematic page, and PCB UUID.

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
- `PCB_Primitive.getPrimitivesBBox()` for component collision screening only.
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

For `easyeda_placement_audit.mjs`, collect component designator, MPN,
footprint, 3D model, layer, position, rotation, and BBox; collect every pad's
full shape, per-layer `specialPad`, hole, layer, position, rotation, and net; and collect every via's
outer diameter, drill, type, position, net, and mask expansion. Use
`IPCB_PrimitiveComponent.getAllPins()` for component pads. The BBox API is beta
and may include pads, silkscreen, attributes, or other footprint graphics, so a
BBox intersection is `REVIEW_REQUIRED`, not proof of body/courtyard collision.
Use sourced courtyard polygons from the exact layout constraint record for a
blocking mechanical-overlap decision. Do not stop at component BBoxes or body
outlines: bind each live pad to its owner, prove that the complete transformed
pad copper lies inside the owner's courtyard, and compare it with foreign pads
and courtyards. Treat through-hole or multilayer pads as occupying both sides
and require `oppositeSideCourtyard` for cross-board body/tail occupancy. Bind
the owner by both designator and `parentComponentPrimitiveId`; every such pad
also needs sourced maximum-copper-projection evidence. Bottom-side
component-local courtyards require `MIRROR_LOCAL_X_THEN_ROTATE`; board-coordinate
geometry is already absolute and must not be mirrored. The
deterministic copper converter supports rectangle, circle/ellipse, oblong,
and regular-polygon pad shapes. Explicit polygon/complex-path pads remain
unresolved until the companion contract proves coordinate space and arc/path
flattening; never infer local versus board coordinates by magnitude. Reject
self-intersecting, zero-area, or repeated-edge sourced polygons as invalid. A
non-empty per-layer `specialPad` also remains unresolved until a deterministic
maximum-projection converter exists.

Treat live numeric state strictly: pad/component positions and rotations and
pad/component copper-side layers must be finite API numbers. Do not let JavaScript
`Number(null)` convert missing geometry to the board origin. Bind every critical
zone owner and allowed designator to the declared envelope set and bind the owner
again to the live component set, including for `BOARD` coordinates.

Treat autorouting as a version-scoped beta transaction. Run a zero-change or
single-net canary using only the exact option fields in the current API
reference. A zero-duration result that reports every requested net failed is a
capability failure even if both `RoutingNets` and `nets` spellings are seen in
examples; do not loop through option guesses. Prove no semantic mutation, then
route manually or stop. After any successful automatic or manual routing,
compare geometry and topology after save/reopen. EasyEDA may split, merge, or
normalize track primitives, so create-returned primitive IDs are historical
transaction evidence, not the final geometry authority.

## Readback rules

- Verify project and active document before any operation.
- Use documented enums rather than raw numeric layer or document values.
- Await every `Promise`.
- After creation, require a returned object/primitive ID and query it again.
- After modification, use the documented async primitive pattern and call `done()`.
- After copper rebuild, call `getCopperRegion()` and inspect `getState_PourFills()`.
- Do not treat the immediate create/rebuild fill count as committed. Save,
  switch away, reopen, then bind the source Pour fields and regenerated fill
  IDs/counts; derived fill normalization across save/reopen is expected.
- For every returned `fill === true` record, capture its documented `id`,
  `path`, and `lineWidth`. Require the number of unique solid-fill IDs to equal
  the solid-fill count, then correlate every ID with detailed DRC; validating
  one region does not validate sibling regions from the same source Pour.
- Treat `preserveSilos=false` as requested source policy, not connectivity
  evidence. A solid-fill ID targeted by free-copper/no-connection DRC remains
  disconnected regardless of the readback setting. Fix the source boundary or
  add a justified same-net connection, rebuild once, and repeat full per-fill
  readback; do not make deletion of an individual derived fill the final state.
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
- `preserveSilos` can read back `true` after a requested `false`. Accept that
  readback discrepancy only when unique solid-fill ID coverage is complete and
  detailed DRC has no free-copper error targeting any of those IDs.
- A primitive `create()` can commit and still throw. Before retrying, perform a
  semantic readback by net/layer/geometry and reuse the committed primitive.
- Use the three-sample sequence in `drc-evidence-closure.md` for closure-grade
  PCB DRC: two `check(true, false, true)` calls followed by one visible
  `check(true, true, true)` call. Capture the current rule configuration name
  and complete configuration before and after the sequence; compare canonical
  leaf sets rather than top-level group counts.

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

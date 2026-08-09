# Live EasyEDA build gates

## Contents

- Purpose
- Authorization profiles
- Select the gate branch
- New-construction state machine
- Existing-schematic modification state machine
- Existing-board continuation state machine
- Existing-board repair state machine
- Capability qualification
- Schematic identity gate
- PCB synchronization gate
- Revision budget and manifest
- Routing and copper canaries
- Failure escalation
- Cleanup authorization
- Evidence transactions

## Purpose

Use these gates for live API creation or substantial modification. Select the
new-construction, existing-schematic modification, existing-board continuation,
or existing-board repair branch before writes. They prevent an unverified API
behavior, hidden identity state, or failed routing pattern from being multiplied
without turning construction prerequisites into retroactive blockers.

Do not treat a new PCB document as the default rollback mechanism. Prefer an
operation-scoped rollback artifact only after restoration is proven. Create a new revision only when the
current document cannot be repaired without destructive mutation or its hidden
document identity is demonstrably invalid.

## Authorization profiles

Select and record one profile before the first live mutation:

- `USER_OWNED` is the default. Obtain operation-specific confirmation before
  destructive deletion, bulk synchronization, mass identity/net changes,
  forced overwrite, or another high-risk mutation.
- `AI_DEDICATED` applies only after the user explicitly grants the agent full
  control of the current project or revision. That grant is standing
  authorization for project-local design mutations within the stated design
  objective, including component placement, track/via replacement, rerouting,
  saving, removing agent-created temporary primitives, and regenerating derived
  copper fills. Do not request repeated confirmation solely because one of
  these bounded transactions deletes and replaces local primitives.

The profile changes the confirmation boundary, not the verification standard.
Both profiles require exact UUID binding, immutable pre-edit evidence,
operation-appropriate rollback evidence, bounded calls, saved-design readback,
netlist/identity checks, and DRC. `AI_DEDICATED` does not authorize deletion or
overwrite of the only recoverable project/revision, account/team/project
administration, sharing/publishing, manufacturing release, ordering, or payment.
Stop when the intended result is materially ambiguous in architecture, safety,
mechanics, or fabrication, not merely because a covered local mutation is
destructive.

## Select the gate branch

Use **new construction** when creating or repopulating a schematic/PCB,
performing bulk identity or netlist population, creating the production PCB, or
performing bulk synchronization.

Use **existing-schematic modification** when the active saved schematic already
exists and the transaction is a bounded, intentional change to its components,
properties, footprints, or connections. This branch may change schematic
intent, but it must declare the expected semantic delta, preserve untouched
identity, and invalidate any prior PCB handoff. It does not authorize modifying
an existing PCB or running `importChanges()`/`setNetlist()` as a side effect.

Use **existing-board continuation** when the active PCB is explicitly unfinished
and the transaction completes declared missing placement, routing, vias, source
Pours, or verification without deleting or replacing committed geometry.
Moving a component is continuation only when that placement was recorded as
unfinished and its original transform plus inverse are preserved. Require a
current schematic handoff and manufacturing/native synchronization `MATCH`.

Use **existing-board repair** when the active PCB contains committed geometry and
the transaction deletes or replaces committed track/via, placement, or copper
geometry while preserving identity and pad-net binding, or performs a similarly
bounded non-netlist repair. The rest of the PCB may still be unfinished.

If a proposed continuation, modification, or repair crosses its boundary, stop
the transaction and close the applicable stronger gate. Bulk schematic
repopulation, `importChanges()`, and `setNetlist()` are construction operations;
the latter two are never geometry-only PCB repairs.

## New-construction state machine

Advance in this order:

1. `COMPANION_READY`
2. `SCHEMATIC_IDENTITY_STABLE`
3. `SCHEMATIC_VERIFIED`
4. `PCB_SYNC_MATCH`
5. `ROUTING_CANARY_CLEAR`
6. `FULL_ROUTING_CLEAR`
7. `COPPER_CANARY_CLEAR`
8. `DESIGN_CLOSURE`

Do not skip a gate because a create, modify, import, or rebuild call returned a
truthy value. A gate closes only after semantic readback from the saved design.
On failure, remain in the current document, classify the cause, and record the
next diagnostic. Do not create another production candidate as a retry.

Advance only as far as the selected work scope requires. A schematic-only build
stops after `SCHEMATIC_VERIFIED`; it does not create a PCB to satisfy later
states.

## Existing-schematic modification state machine

Advance one bounded schematic change in this order:

1. `COMPANION_READY`
2. `ACTIVE_SCHEMATIC_REVISION_BOUND`
3. `ROLLBACK_EVIDENCE_VERIFIED`
4. `PRE_EDIT_SCHEMATIC_CAPTURED`
5. `BOUNDED_SCHEMATIC_TRANSACTION`
6. `POST_EDIT_DELTA_VERIFIED`
7. `SCHEMATIC_DRC_CLEAR`
8. `HANDOFF_INVALIDATION_RECORDED`
9. `SCHEMATIC_CLOSURE`

Before the first write, bind the project, parent schematic, page UUID, and saved
revision. Capture the exported netlist, component identities and properties,
connections affected by the transaction, current DRC, and the expected semantic
delta. For a deletion, component/pin identity replacement, or broad connection
change, require a tested inverse or separately restorable native revision; a
semantic capture alone is not a restorable backup.

Apply one logical change at a time. Await the operation, save, switch documents,
reopen the schematic, and require:

- the same project, parent schematic, and page UUID;
- stable identity and properties for every untouched component;
- an exported-netlist and primitive delta equal to the declared change;
- no unintended rail, pin, net, no-connect, or footprint/pad-map change;
- schematic DRC/ERC with no new unexplained error;
- all earlier schematic-to-PCB handoff, synchronization, and dependent PCB
  evidence explicitly marked stale.

Do not modify or synchronize a PCB unless the user expands the scope. Close the
new schematic handoff first, then enter the construction/synchronization path.
First-component identity qualification is not a retroactive requirement for a
bounded edit to a previously saved, identity-stable schematic. If existing
identity is missing or inconsistent, stop and classify the task as identity
repair or reconstruction before changing the design.

## Existing-board continuation state machine

Advance unfinished PCB work in this order:

1. `COMPANION_READY`
2. `ACTIVE_PCB_AND_HANDOFF_BOUND`
3. `PCB_SYNC_MATCH`
4. `EXISTING_STATE_BASELINED`
5. `FIRST_INCOMPLETE_GATE_IDENTIFIED`
6. `CONTINUATION_CANARY_CLEAR`
7. `INCOMPLETE_WORK_CLOSED`
8. `DESIGN_CLOSURE`

Before the first write, bind the project, schematic page, parent schematic, PCB
UUID, saved revision, and handoff evidence. Capture components, pad-net binding,
placement transforms, tracks, vias, Pours/fills, unrouted connectivity, and
detailed DRC. Record which placement and geometry is committed, which work is
incomplete, and the first incomplete dependency gate. A semantic baseline is
evidence, not a restorable backup.

Require manufacturing and native synchronization `MATCH`; a stale comparison
is not sufficient for continuation. Reverify earlier gates whose evidence is
missing or invalidated, but do not recreate components or replay geometry whose
current evidence remains valid. Before moving an unfinished component, preserve
its exact transform and a tested inverse. Record every newly created primitive
ID, net, layer, and intended endpoints.

Use the first new placement or route in each unproven class as a canary. After
each logical transaction, save/reopen and require:

- the same project and PCB UUID;
- unchanged component identity, population, footprint/pad mapping, and pad-net
  binding;
- unchanged committed placement and geometry outside the declared transaction;
- the intended new or moved geometry and connectivity;
- no new unintended branch, cycle, short, clearance, or DRC regression;
- fewer declared incomplete items or closure of the targeted dependency gate.

If progress requires deleting or replacing committed geometry, rebuilding an
existing fill, changing identity/net binding, or synchronizing a changed
schematic, stop continuation. Use bounded existing-board repair for geometry,
or return through schematic handoff and construction synchronization for
identity/netlist changes. Rebaseline before resuming continuation.

## Existing-board repair state machine

Advance a bounded repair in this order:

1. `COMPANION_READY`
2. `ACTIVE_REVISION_BOUND`
3. `ROLLBACK_EVIDENCE_VERIFIED`
4. `PRE_EDIT_SEMANTICS_CAPTURED`
5. `BOUNDED_GEOMETRY_TRANSACTION`
6. `POST_EDIT_SEMANTICS_MATCH`
7. `REPAIR_DRC_CLEAR`
8. `DESIGN_CLOSURE`

Before the first write, bind the project and PCB UUID, preserve immutable
semantic evidence, capture component identities and pad-net bindings, export the
manufacturing netlist, and record target-net connectivity and current DRC. Keep
each transaction small enough to read back and roll back independently.

Capture active-PCB semantic evidence directly into the project evidence tree:

```bash
node scripts/easyeda_repair_snapshot.mjs \
  --output <project>/evidence/snapshots/pre-repair-<transaction>.json
```

This helper records components/pins, lines, arcs, polylines, vias, pours/fills,
and detailed DRC for comparison and inverse-transaction planning. It is not a
restorable EasyEDA document and sets `closesRollbackSnapshotVerified: false`.
Before deleting source primitives or another destructive source change, also
preserve operation-scoped rollback evidence:

- for a bounded geometry replacement, record every affected primitive and a
  tested inverse transaction, or use a separately restorable native revision;
- for fill-only copper regeneration, retain and bind the exact source Pour,
  capture its settings and generated Poured/fill IDs, delete only the derived
  fills, rebuild that Pour once, then save and read back its fills and DRC. Under
  `AI_DEDICATED`, this closes the operation rollback/evidence gate without a
  native duplicate because the source definition remains authoritative. After
  save/reopen, require field-for-field equality of the source Pour ID, net,
  layer, polygon, fill method, island policy, name, priority, line width, and
  lock state;
- for deletion of a source Pour, component/pad, identity or net binding, broad
  mutation, or overwrite of non-derived design data, require a tested inverse or
  a restorable EasyEDA revision/export appropriate to the operation;
- do not describe either gate as closed merely because the semantic JSON exists.

After every transaction, require:

- the same project and PCB UUID;
- unchanged component identity, population, footprint/pad mapping, and pad-net
  binding unless the user authorized leaving repair mode;
- manufacturing-netlist equality to the pre-edit artifact;
- the intended target-net connectivity and no unintended branch/cycle change;
- detailed DRC with no new non-exempt leaf error;
- geometry readback matching the intended edit.

An unavailable or stale native comparison does not by itself block a
geometry-only repair when the active UUID and manufacturing comparison match
and the strict `nativeNetlistCacheException` contract is satisfied. Record it
as an exception, never as `PCB_SYNC_MATCH`; it cannot mask clearance,
connectivity, geometry, free-copper, or other DRC errors. First-component
identity and pre-routing canaries are not retroactive repair gates. Each bounded
repair transaction acts as its own canary.

## Capability qualification

Treat an EasyEDA Pro version, companion version, bridge version, or write API
sequence as unqualified until it has a matching capability record. Run unknown
or beta document-tree write sequences in a dedicated probe project, never in
the user's production project.

The probe must record:

- application, companion, and bridge versions when available;
- project UUID and the document tree before and after the probe;
- exact API sequence, returned IDs, and semantic readback;
- whether cleanup was authorized and completed;
- the capability conclusion and its version scope.

If a dedicated probe project cannot be created or selected, stop and ask for a
safe test location. Do not learn beta API semantics by adding documents to the
production project. Read [api-map.md](../api/api-map.md) for known runtime behavior and
exact API-specific restrictions.

## Schematic identity gate

Before populating the full schematic, create the first real component with its
designator and stable unique ID in one supported `create()` or `modify()`
transaction. Do not establish identity through independent state setters.

Then:

1. save the document;
2. activate another document and reopen the schematic page;
3. read the component primitive again;
4. export the JLCEDA schematic netlist;
5. require the live unique ID, netlist component key, and exported `Unique ID`
   property to be equal, nonempty, and unique;
6. run the same check again after a second component and one representative
   connection are present.

Run `easyeda_identity_preflight.mjs` after the reopen. Do not place the
remaining component population until it returns `MATCH`.

## PCB synchronization gate

Complete and verify the schematic before creating the production PCB. After
the PCB component population and pad-net binding exist, save and reopen both
documents, then run:

```bash
node scripts/easyeda_netlist_compare.mjs \
  --schematic-page-uuid <page-uuid> \
  --schematic-uuid <parent-schematic-uuid> \
  --pcb-uuid <pcb-uuid> \
  --require-native-match \
  --output <project>/evidence/netlist/pre-routing-sync.json

node scripts/easyeda_identity_preflight.mjs \
  --schematic-page-uuid <page-uuid> \
  --schematic-uuid <parent-schematic-uuid> \
  --pcb-uuid <pcb-uuid> \
  --expected-part-count <count> \
  --require-native-match \
  --output <project>/evidence/netlist/pre-routing-identity.json
```

Require manufacturing identity/pin-net equivalence, stable nonempty IDs, no
divergent nonempty internal PCB netlist views, and native comparison `MATCH`.
An unavailable or stale native comparison blocks routing. Do not route first
and plan to fix synchronization later.

## Revision budget and manifest

Keep `revision-manifest.json` in the PCB project directory. Register every live
PCB document by UUID. Use this minimum schema:

```json
{
  "schemaVersion": 1,
  "projectUuid": "project-uuid",
  "revisions": [
    {
      "uuid": "pcb-uuid",
      "parentUuid": null,
      "role": "working",
      "status": "active",
      "reason": "initial production candidate",
      "successGate": "PCB_SYNC_MATCH",
      "cleanupDisposition": "keep"
    }
  ]
}
```

Allowed roles are `working`, `rollback`, `diagnostic`, and `final`. Allowed
statuses are `active`, `preserved`, `failed`, `retired`, and `deleted`. Cleanup
disposition is `keep`, `delete-after-proof`, or `needs-user-decision`.

Default budget:

- at most one active `working` or `final` PCB;
- at most one active `diagnostic` PCB;
- any number of explicitly preserved rollback revisions with stated reasons;
- zero unregistered live PCB documents.

Before creating a PCB, run `easyeda_revision_guard.mjs` with the proposed role,
parent, reason, success gate, and cleanup disposition. If an active diagnostic
already exists, classify and dispose of it before requesting another. Automatic
EasyEDA names such as `PCB4` are never the revision authority; the UUID manifest
is authoritative.

```bash
node scripts/easyeda_revision_guard.mjs \
  --manifest <project>/revision-manifest.json \
  --intent-role diagnostic \
  --parent-uuid <known-good-pcb-uuid> \
  --reason "test one classified synchronization hypothesis" \
  --success-gate PCB_SYNC_MATCH \
  --cleanup-disposition delete-after-proof \
  --output <project>/evidence/readbacks/revision-create-guard.json
```

## Routing and copper canaries

Do not expand a routing strategy across the full board before it passes a
representative canary. Route only:

- one power-entry or high-current path;
- one ordinary digital path;
- one constrained interface segment and its representative layer transition,
  when such an interface exists.

Run connectivity, routing geometry, and native DRC immediately. Require zero
unexpected spacing, via, layer, differential, and connection errors. A failed
canary is repaired or rolled back before more nets are routed.

For PCB continuation, preserve existing geometry and use the first added path in
each previously unproven routing class as its canary. A passing canary authorizes
expansion only within that class and the declared incomplete work; it does not
authorize replacing pre-existing paths.

For copper, create or rebuild one intended reference pour first. Read back its
source Pour and generated Poured instance, solid-fill IDs, connectivity, island
state, and detailed DRC. Only then apply the proven sequence to other layers.

## Failure escalation

Use this retry ceiling for the same failed gate and recorded hypothesis:

1. First failure: semantic readback and root-cause classification in the same
   document.
2. Second attempt: one minimal, hypothesis-specific repair or one authorized
   diagnostic candidate.
3. If the same gate still fails: stop and report the blocker. Do not create a
   second diagnostic candidate or cascade through alternate bulk APIs.

`importChanges()` and `setNetlist()` are separate high-risk operations. Under
`USER_OWNED` they require separate confirmation; under `AI_DEDICATED` the
standing project authorization can cover them only when they are necessary for
the stated objective and their stronger rollback/synchronization evidence is
already closed. Authorization does not permit an unlimited fallback chain. Each call
must test a recorded hypothesis and close the synchronization gate or stop.

The synchronization retry ceiling does not prohibit an independent,
geometry-only repair transaction that passes the existing-board repair branch.
If a repair transaction fails post-edit semantics or DRC, perform at most one
minimal repair of that transaction, then execute the tested inverse or restore
the verified rollback artifact; otherwise stop. Do not
continue expanding the edit.

If a continuation transaction fails, follow the selected authorization profile
and recorded inverse to remove only primitives created by that transaction or
restore an unfinished placement move. Preserve all pre-existing committed
geometry. Attempt at most one minimal correction to the failed continuation
canary; if replacement of existing work is required, stop and enter bounded
repair rather than broadening continuation.

## Cleanup authorization

For `USER_OWNED`, when temporary live documents may be needed, request a scoped
authorization at the start of the build. Recommended wording:

> Authorize deletion only of temporary documents created by the agent in this
> task that are proven empty or semantically duplicate by UUID-bound readback.
> Preserve every pre-existing document, the last-known-good revision, and any
> user-named rollback revision. Record semantic evidence, the separately
> verified rollback artifact, and document-tree readback
> before and after each authorized deletion.

Without this authorization, do not delete. Under `AI_DEDICATED`, agent-created
temporary documents may be removed after UUID-bound proof that they are empty or
semantically duplicate, but preserve all pre-existing documents, the
last-known-good revision, and user-named rollback revisions. Prefer a dedicated
probe project and mark unresolved leftovers `needs-user-decision` in the manifest.

## Evidence transactions

Store evidence per logical transaction rather than per attempted primitive:

- one immutable pre-transaction semantic capture;
- one operation-scoped rollback evidence record when the transaction is destructive;
- one append-only operation log containing every attempted call and semantic
  readback, including a create that committed before throwing;
- one post-transaction readback and gate decision.

Do not create a new semantic capture for a read-only call or a failure proven to occur
before any write. Preserve operation-level detail inside the transaction log so
concision does not weaken rollback or auditability.

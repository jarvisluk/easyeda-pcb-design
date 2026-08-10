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
2. `PROJECT_BOUND`
3. `PRIMARY_FUNCTIONS_CONFIRMED`
4. `SCHEMATIC_IDENTITY_STABLE`
5. `SCHEMATIC_VERIFIED`
6. `PCB_SYNC_MATCH`
7. `ROUTING_CANARY_CLEAR`
8. `FULL_ROUTING_CLEAR`
9. `COPPER_CANARY_CLEAR`
10. `DESIGN_CLOSURE`

Do not skip a gate because a create, modify, import, or rebuild call returned a
truthy value. A gate closes only after semantic readback from the saved design.
On failure, remain in the current document, classify the cause, and record the
next diagnostic. Do not create another production candidate as a retry.

Advance only as far as the selected work scope requires. A schematic-only build
stops after `SCHEMATIC_VERIFIED`; it does not create a PCB to satisfy later
states.

`PRIMARY_FUNCTIONS_CONFIRMED` requires the structured baseline and post-core-part
research process in [entry-routing.md](entry-routing.md), plus an append-only
`easyeda-requirements-baseline-check` report with `cleared: true`, the current
baseline revision, and an exact matching `inputFingerprint`. Prose in
`brief.md`, chat, or a handoff cannot substitute for that report. The baseline
must distinguish available silicon capabilities from fitted board functions,
expose material alternatives and tradeoffs, explicitly name omitted
user-facing functions, and record user confirmation, an already-explicit
requirement, or delegated tradeoff authority. Project authorization is not
product-feature approval. Do not commit the full schematic or connector
footprints while a material interface, power, programming, radio, control, or
expansion choice remains unresolved.

`SCHEMATIC_VERIFIED` requires the saved/reopened schematic fingerprint, ERC,
identity, exact manufacturer part numbers and footprints, and a cleared
component-selection evidence record under
[component-selection-evidence.md](component-selection-evidence.md). An
inaccessible, failed, unreadable, mismatched, stale, or unbound governing source
blocks this gate even when ERC is clean.

It also requires the presentation gate in
[schematic-presentation.md](schematic-presentation.md). Run the geometry screen
and exact-page visual inspection after the first complete functional block and
again before handoff; do not defer either until PCB completion. A
`DEGRADED_LABEL_STUB_PATTERN`, unresolved `REVIEW_REQUIRED`, or a page whose
local circuits can only be reconstructed from repeated labels blocks
`SCHEMATIC_VERIFIED` even when ERC and the exported netlist are clean.

For an existing project, `PROJECT_BOUND` requires exact project UUID and tree
readback. For a no-design build that must create its project, first preflight
the intended workspace/team and enumerate the target team's project UUIDs.
Because `DMT_Project.createProject()` is beta and there is no companion
project-deletion API, use the final production name for one capability-qualified
create transaction rather than creating a disposable project. Enumerate again
even after an `undefined` return, bind and inspect any committed UUID, and
require an empty design state: either a zero-document tree or a semantically
blank default scaffold qualified as below. If no project was committed, allow
only the single hypothesis-specific retry defined under Failure escalation.
Continued absence of a UUID blocks live construction unless the user explicitly
authorizes one final-named UI creation attempt. Use UI only for that creation,
open it in a new window when the prior project may be unsaved, then return to
the companion and prove exact project/document UUIDs plus blank schematic and
PCB semantics before design writes. Do not substitute a similar pre-existing
project or use filesystem/source synthesis.

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
- a rerun presentation screen and exact-page visual review when the transaction
  changes component positions, wires, labels, ports, buses, or annotations;
- regenerated component-selection evidence bound to the post-edit fingerprint
  when the change affects a part, package, footprint, source revision, or sourced
  requirement;
- all earlier schematic-to-PCB handoff, synchronization, and dependent PCB
  evidence explicitly marked stale.

Do not modify or synchronize a PCB unless the user expands the scope. Close the
new schematic handoff first, then enter the construction/synchronization path.
First-component identity qualification is not a retroactive requirement for a
bounded edit to a previously saved, identity-stable schematic. If existing
identity is missing or inconsistent, stop and classify the task as identity
repair or reconstruction before changing the design.

## Existing-board continuation state machine

If a saved board was changed outside this state machine and no pre-edit semantic
capture or tested inverse exists, do not retroactively claim a bounded repair.
Either restore the last known-good native revision and replay the change under
the repair gates, or treat the current saved board as a new unfinished-board
baseline. In the latter case record the unverified transaction history, bind the
current identity/netlist, and reclose every affected handoff, constraint,
stackup, placement, copper, routing-canary, and DRC gate before continuing. A
current clean result can qualify the current state; it cannot manufacture
missing pre-change evidence.

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

Require manufacturing and native synchronization `MATCH`, or the exact
`PCB_SYNC_VERIFIED_CACHE_EXCEPTION` result defined under PCB synchronization
below; an unclassified stale comparison is not sufficient for continuation.
Reverify earlier gates whose evidence is missing or invalidated, but do not
recreate components or replay geometry whose current evidence remains valid.
Before moving an unfinished component, preserve its exact transform and a
tested inverse. Record every newly created primitive ID, net, layer, and
intended endpoints.

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

Project creation is the exception to the dedicated-probe-location rule because
the probe project does not exist yet and cannot be deleted through the
companion. Qualify it as the bounded production-intended transaction described
under the new-construction `PROJECT_BOUND` gate. A failed create with no
enumerated UUID is a non-commit; a created but unexpected project tree is a
failed live candidate that must be preserved and reported because automatic
project cleanup is outside the authorization boundary.

After the API retry ceiling, explicit user authorization may qualify a single
UI project-creation recovery. Record the UI result, then use companion readback
as authority. A known default scaffold closes empty-design-state only when its
schematic has zero `part` components and zero wires and its PCB has zero
components, lines, arcs, vias, Pours/fills, and regions. Bind and reuse its
blank Schematic and PCB rather than creating duplicates; preserve and stop on
any unexpected content.

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

EasyEDA's beta document-UUID comparator can also produce a proven false
negative: every schematic net is reported with a populated first side and an
empty PCB side even though the saved PCB data is populated. After the normal
bounded synchronization attempts, save/switch/reopen both documents and run the
same command with `--allow-native-cache-exception`. Accept only its exact
`MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION` decision. The script requires all
of these independent views to agree with the schematic:

- manufacturing component identity, core properties, and every pin net;
- every nonempty internal PCB JLCEDA netlist view;
- the direct PCB net-name set and every numbered component-pad net, including
  consistent duplicate physical pads that share one logical pad number;
- native `SYS_Tool.netlistComparison()` on the two exported File objects;
- a document-UUID mismatch consisting only of the complete expected net set,
  with every first side populated and every second side empty, and no component
  or partial/asymmetric difference.

Any missing/extra component, net, pad number, pin-net or core-property
difference; empty/divergent internal view; nonempty File comparison; component
difference; partial net set; or unavailable evidence rejects the exception.
Record the gate as `PCB_SYNC_VERIFIED_CACHE_EXCEPTION`, never as literal
`PCB_SYNC_MATCH`. Under `USER_OWNED`, obtain explicit acceptance before routing;
`AI_DEDICATED` standing project authorization covers the exception when needed
for the stated objective. It permits routing canaries and design closure only;
it does not erase the raw beta-comparator result, waive later connectivity/DRC
checks, or support a fabrication-release conclusion by itself.

Synchronization clearance still does not authorize routing. After the actual
placement is saved/reopened, require the independent
`PLACEMENT_CLEAR_FOR_ROUTING` gate in
[placement-closure.md](../layout/placement-closure.md). A clean native or
manufacturing comparison cannot waive ordinary via/pad intrusion, own-pad
courtyard escape, foreign pad/courtyard overlap, module escape, operator access,
connector, or BOM-policy findings.

For this exception path, also run `easyeda_identity_preflight.mjs` with the
schematic page, PCB UUID, and expected part count but without
`--schematic-uuid`/`--require-native-match`; require its ordinary `MATCH` for
live schematic identity plus nonempty, nondivergent PCB internal identity. Bind
that artifact and the strict comparator artifact to the same project, schematic
page, PCB UUID, and saved/reopened revision. The comparator artifact is the sole
authority for the separately preserved native false-negative classification.

At final PCB audit, pass the same strict comparator artifact directly to the
baseline audit rather than restating it in a constraint record:

```bash
node scripts/easyeda_design_audit.mjs \
  --netlist-compare-report <project>/evidence/netlist/final-sync.json \
  --component-evidence <project>/evidence/audits/component-selection.json \
  --placement-audit-report <project>/evidence/audits/placement-closure.json \
  --output <project>/evidence/audits/pcb-final.json
```

The audit validates the complete comparator decision and exact project/PCB
binding. It may clear only a sole native `Netlist Error` whose rule is `Import
Changes`; it retains the raw leaf in the report. Any other DRC leaf, weak or
malformed artifact, or UUID mismatch keeps the result failed.

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

For the beta autorouter, treat a zero-duration all-requested-nets-failed result
as a failed capability canary. Prove the route geometry is unchanged, stop
option-key retries, and use reviewed manual routing. Whether routing is manual
or automatic, save/reopen and compare geometry/topology; normalized or merged
track IDs replace the create-returned IDs as final authority.

For PCB continuation, preserve existing geometry and use the first added path in
each previously unproven routing class as its canary. A passing canary authorizes
expansion only within that class and the declared incomplete work; it does not
authorize replacing pre-existing paths.

For copper, create or rebuild one intended reference pour first. Read back its
source Pour and generated Poured instance, require unique-ID coverage for every
solid fill, and correlate each ID with connectivity, island state, and detailed
DRC. Resolve every disconnected sibling region before applying the proven
sequence to other layers.
The immediate rebuild fill count is provisional. Save/switch/reopen and repeat
the source-Pour plus every derived-fill readback before closing the canary.

## Failure escalation

Use this retry ceiling for the same failed gate and recorded hypothesis:

1. First failure: semantic readback and root-cause classification in the same
   document.
2. Second attempt: one minimal, hypothesis-specific repair or one authorized
   diagnostic candidate.
3. If the same gate still fails: stop and report the blocker. Do not create a
   second diagnostic candidate or cascade through alternate bulk APIs.

A native menu or Computer Use action that performs the same schematic-to-PCB
synchronization is another bulk synchronization path, not a harmless UI
fallback. Do not invoke it after the API retry ceiling; UI recovery in this
skill is limited to the separately qualified `PROJECT_BOUND` project-creation
exception.

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

# PCB implementation workflow

## Contents

- Enter the PCB scope
- Select the PCB entry route
- Prove the PCB entry gate
- Continue an unfinished PCB
- Place components
- Route the board
- Build copper
- Verify the PCB
- Return cross-scope changes

## Enter the PCB scope

Use this workflow for PCB-only work and for the PCB phase of an end-to-end
design. Read [entry-routing.md](entry-routing.md) for the shared handoff contract, then
read [constraint-planning.md](../layout/constraint-planning.md) and
[layout-rules.md](../layout/layout-rules.md) before placement or routing. Load the relevant
stackup, power, mixed-signal, BGA/HDI, antenna, protocol, high-speed, PDN/EMC,
and manufacturing references only when the design requires them.

Record whether the outcome is guidance, PCB creation/modification, read-only PCB
review, or an end-to-end fabrication/readiness review. A PCB-only scope does not
authorize schematic edits. A fabrication/order-readiness question expands the
review evidence requirement to the full design and manufacturing outputs even
when the requested corrective work remains PCB-only.

## Select the PCB entry route

- Use **schematic-to-PCB creation** when a verified schematic exists but the
  production PCB does not. Close the handoff, create/populate the PCB, and prove
  synchronization before placement or routing.
- Use **PCB continuation** when a bound PCB already exists but placement,
  routing, vias, or copper is incomplete. Assess its current state and resume at
  the first incomplete dependency gate.
- Use **existing-board repair** when already-committed placement, track/via, or
  copper geometry must be removed or replaced. Keep each repair bounded, then
  return to continuation if unfinished work remains.
- Use **read-only review** when the user asks only for verification. Do not enter
  a mutation route merely because the board is incomplete.

## Prove the PCB entry gate

Before production PCB creation or continuation, require:

1. bind the exact saved schematic revision and its handoff record;
2. confirm parts, footprints, pin mapping, critical nets, mechanics, process,
   and unresolved assumptions are sufficient for PCB architecture;
3. iterate a provisional outline, holes, fixed interfaces, keepouts, access
   envelopes, candidate stackups, floorplans, and representative escape/route
   canaries through the joint gate in `../layout/constraint-planning.md`;
4. close every cross-constraint and specialized planning gate, freeze outline,
   stackup, and floorplan together, and run
   `python3 scripts/easyeda_constraint_lint.py --record <layout-constraints.json>`;
5. require the derived result `CLEARED_FOR_PLACEMENT`; `BLOCKED`, `UNRESOLVED`,
   or `STALE` stops production placement and routing;
6. require manufacturing and native schematic/PCB synchronization `MATCH` before
   routing: populate and save/reopen a new PCB, or bind and save/reopen the
   existing PCB without repopulating it.

If the handoff is missing or stale, stop and return the missing item to the
schematic scope. Do not infer critical intent from net names or silently repair
the schematic from the PCB.

## Continue an unfinished PCB

Before adding geometry, bind the project, schematic page, parent schematic, PCB
UUID, saved revision, and handoff evidence. Capture a semantic baseline of
components, pads/nets, placement, tracks, vias, pours/fills, unrouted
connectivity, and current DRC. The baseline protects existing work but is not a
restorable backup.

Classify which dependency gate is first incomplete:

1. constraint/stackup and fixed-mechanics closure;
2. component population and schematic/PCB synchronization;
3. constrained and function-critical placement;
4. representative routing canary;
5. remaining routing and connectivity closure;
6. copper canary and full copper completion;
7. PCB and specialized verification.

Resume at that gate. Accept an earlier gate only when its exact-revision
evidence is current; otherwise reverify it. Do not recreate components, move
placed parts, reroute existing nets, or rebuild existing fills merely to replay
the standard sequence. Record every newly created primitive ID and its intended
net/layer so the continuation transaction can be read back and reversed without
touching pre-existing work.

Use the first newly added placement or routing operation as the continuation
canary. Save/reopen, confirm unchanged component identity and pad-net binding,
verify the intended new geometry and connectivity, and require no unexpected
DRC regression before expanding. If progress requires deleting or replacing
committed geometry, close that bounded operation through existing-board repair,
then rebaseline and return to continuation.

## Place components

Do not begin placement until the consistency artifact is bound to the current
constraint record and reports `CLEARED_FOR_PLACEMENT`.

1. Fix feasible user-specified and mechanically constrained anchors: modules,
   connectors, controls, antennas, indicators, holes, and cable exits.
2. Place core ICs and modules for escape, thermal flow, antenna requirements,
   and the shortest critical interfaces.
3. Put protection at connectors and power entry.
4. Place regulator input/output, switch, gate/bootstrap, feedback, sense, and
   magnetic loops according to the sourced topology.
5. Place clocks and their load networks beside the associated pins.
6. Place each decoupling capacitor beside its supply pin with a short ground
   return.
7. Preserve analog/reference and mixed-signal return-current partitioning.
8. After function-critical placement is fixed, group identical orderable
   passives, then same-footprint passives, locally where assembly benefits.
9. Never move decoupling, termination, matching, feedback, timing, sense, or
   filter parts away from required pins or loops for visual uniformity.
10. Rotate and group remaining parts to reduce crossings and create routing
    corridors without violating access, assembly, rework, enclosure, thermal,
    antenna, or applied-force constraints.

## Route the board

Before full routing in new construction, pass the routing canary in
[live-build-gates.md](live-build-gates.md). In PCB continuation, use the first
new route in each unproven class as a canary while preserving existing geometry.
During existing-board repair, treat each bounded replacement as its own canary
and require semantic readback before expansion.

1. Reserve every hard corridor, reference region, return transition, package
   escape, power loop, antenna exclusion, and tuning region before committing
   ordinary traces.
2. Apply the combined scheduler in [layout-rules.md](../layout/layout-rules.md): route the
   item with the highest combination of constraint severity, path scarcity,
   coupling/return dependency, and failure consequence. No signal category is
   unconditionally first.
3. Select trace/via geometry from current, voltage drop, temperature rise,
   copper thickness, stackup, impedance needs, and fabricator limits.
4. Preserve direct return paths and avoid reference-plane slots, voids, and
   narrow necks under important signals.
5. Compare each completed class with the frozen layer and geometry policy.
6. Use 0°, 45°, and 90° segment directions, chamfering a junction where two
   perpendicular segments would otherwise form a hard 90° corner.
7. Avoid arbitrary slopes, unnecessary zigzags, dead-end stubs, excessive vias,
   and unintended closed routing cycles or duplicate feeds.
8. Keep clocks, crystals, analog/reference nodes, feedback/sense, reset, and RF
   paths away from switching aggressors.
9. Recompute net connectivity after each committed path and reject an already
   connected endpoint pair unless a documented redundant feed is intentional.
10. Do not accept autorouter output without complete manual review.

## Build copper

Copper pour is part of the baseline flow unless another reference-plane
implementation is deliberate. Prove one source-Pour-to-generated-Poured canary
and detailed DRC sequence before expanding it.

In PCB continuation, add a missing source Pour through the continuation canary.
If an existing source Pour or generated fill must be deleted, replaced, or
rebuilt, use the operation-appropriate existing-board repair evidence gate.

1. Define net, layer, clearance, thermal connection, priority, and island policy.
2. Rebuild after routing and every geometry change.
3. Read back the generated region and require at least one intended fill.
4. Disable isolated islands unless each has a documented connection and purpose.
5. Inspect narrow necks, slots, reference voids, thermal spokes, and return-path
   discontinuities.
6. Add justified ground stitching near connectors, edges, layer transitions,
   noisy zones, and reference changes only outside specialized keepouts. An
   exact antenna/module exclusion or vendor-specific no-via region overrides
   the generic stitching preference inside its documented scope.

## Verify the PCB

Run only the checks applicable to the requested review scope, in dependency
order:

1. exact schematic identity and handoff currency;
2. symbol/footprint/pin-map, part population, passive policy, and manufacturing
   plus native synchronization;
3. current aggregate constraint-consistency artifact, jointly frozen stackup,
   floorplan, placement, mechanics, access, polarity, thermal, antenna, conflict
   ledger, and assembly review;
4. routing-canary DRC, unrouted/connectivity, layer usage, geometry, angle,
   critical-net, return-path, and unintended-cycle checks;
5. copper canary, full rebuild, filled-region readback, islands, necks, and PCB
   DRC;
6. applicable high-speed, crystal, power, mixed-signal, antenna, PDN, EMC, and
   BGA/HDI evidence bound to the exact PCB revision;
7. fabricator capability and, only when requested, Gerber/drill/BOM/PnP export
   and manufacturing audit followed by visual review.

Export manufacturing output only after current design/netlist checks and an
explicit user request. Write to a new revision-specific project evidence
directory with overwrite disabled. Treat Gerber outline and drill data as the
manufacturing authority when optional metadata conflicts, and preserve the
conflict as evidence.

For a concluded review, follow the natural-language review contract in
`SKILL.md`. A clean PCB DRC is neither a manufacturing review nor fabrication
authorization.

## Return cross-scope changes

If placement, routing, thermal, stackup, sourcing, or mechanics requires a
change to connectivity, part population, value, variant, footprint, pad mapping,
connector definition, current budget, or critical-net intent, stop the affected
PCB work. Describe the conflict and smallest proposed change, return to the
schematic workflow, issue a new handoff, and reprove synchronization before
resuming.

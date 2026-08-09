# Worked example: constraint-driven processor board

## Contents

- Purpose and boundaries
- Intake and classification
- Architecture and constraint records
- Stackup, placement, and escape decisions
- Routing and verification sequence
- Lessons to transfer

## Purpose and boundaries

Use this example to learn the decision sequence for a dense processor board. It
is an original generic example, not a production layout, released reference
design, numeric rule source, or fabrication fixture. Replace every illustrative
part and limit with the chosen silicon, interface, fabricator, and assembler
sources.

The hypothetical board contains a processor BGA, DDR memory, a multi-gigabit
serial interface, USB 2.0, a buck regulator, an ADC sensor channel, debug, and
board-to-board connectors. The example demonstrates how the specialized
references combine without loading all of them for an unrelated baseline board.

## Intake and classification

1. Capture the requested mechanical outline, connector edges, mounting holes,
   enclosure, cooling, operator access, fabricator, assembler, and expected test
   method as fixed inputs or provisional candidates. Do not freeze the outline
   until the joint outline/stackup/floorplan gate closes.
2. Partition processor, memory, serial, USB, power, analog, clock, debug, and
   protection blocks.
3. Classify the board as high-risk SI because it combines dense BGA escape,
   DDR, and a multi-gigabit serial channel.
4. List unresolved silicon/package versions, stackup, connector model, memory
   topology/timing, rail transients, analog accuracy, and compliance evidence.
5. Stop before layout if any unknown can change layer count, via technology,
   connector location, memory topology, or power architecture.

## Architecture and constraint records

Create a baseline `layout-constraints.json`, then separate authoritative records:

- high-speed constraints for DDR, serial, USB, clocks, and every sequential
  channel segment;
- a BGA/HDI escape record for package balls, pad/mask, vias, layers, PDN, and
  assembly process;
- one switching-power record per converter, including every commutation loop,
  high-`dv/dt` node, feedback/sense path, and thermal target;
- a mixed-signal record for the ADC input, reference, clock, supplies, digital
  return, accuracy/noise target, and evidence plan;
- a stackup record with exact layer roles, reference mappings, material source,
  via construction, impedance structures, and solver/coupon requirements.

Apply the heuristic contract from `../layout/constraint-planning.md` to every imported
rule. A vendor length limit records its scope and source; a temporary planning
target records its assumption and escalation path instead of masquerading as a
specification.

## Stackup, placement, and escape decisions

1. Iterate the provisional outline, candidate stackups, fixed interfaces, core
   blocks, reserved regions, and exact-footprint floorplan until one candidate
   can support all required canaries.
2. Prove BGA fanout on the real ball map using the candidate trace/space and via
   process. Derive required routing layers from feasible channels, not ball count.
3. Give each controlled signal layer a continuous adjacent reference and plan
   return transitions for every layer change.
4. Check layer-pair symmetry, copper balance, power distribution, dielectric
   construction, via stubs, and volume-process capability with the fabricator.
5. Fix connectors and protection, processor, memory topology, serial/USB
   placement chains, power stages, clock, ADC chain, and decoupling before
   ordinary parts.
6. Reserve DDR/serial corridors, BGA escape, power/ground via fields, switch
   loops, ADC quiet region, and length-tuning space.
7. Run native DRC on one representative escape and route for every distinct
   process/geometry before propagating them.
8. Freeze the outline, stackup, and floorplan together, close the conflict
   ledger, and require the aggregate constraint checker to report
   `CLEARED_FOR_PLACEMENT`.

If a route fails, revise the architecture, placement, stackup, or process.
Do not consume a reserved critical corridor with tolerant signals.

## Routing and verification sequence

After every hard resource is reserved, this board-specific risk assessment
produces the following initial scheduler order. Recompute the order when a
corridor, return path, via field, thermal region, or constraint changes:

1. converter commutation/gate loops, high-current paths, feedback, and sense;
2. BGA power/ground breakout and local decoupling paths;
3. DDR clocks/strobes/data/address groups using device-specific topology and
   timing/package budgets;
4. multi-gigabit serial and connector/protection launches with solver evidence;
5. ADC input/reference/clock paths and their isolated return-current region;
6. USB and other controlled interfaces;
7. reset, boot, debug, low-speed buses, and tolerant housekeeping;
8. copper rebuild, exact-fill inspection, baseline and specialized audits,
   native DRC, manufacturing export review, and required measurements.

Bind each report to the same revision and constraint fingerprints. A late via,
plane, copper, footprint, or stackup edit invalidates every downstream result it
affects.

## Lessons to transfer

- Design from current paths, topology, timing, mechanics, and process—not net
  names or remembered multipliers.
- Prove scarce geometry early: BGA escape, reference transitions, connector
  launches, switch loops, and analog quiet regions.
- Treat impedance, length, skew, return continuity, loss, PDN, thermal, EMC,
  assembly, and test access as coupled constraints.
- Store generic experience as scoped heuristics; store production limits as
  sourced, revision-controlled constraints.
- Use calculators and clean DRC as screening evidence only. Fabricator,
  solver, inspection, and measurement gates remain separate.

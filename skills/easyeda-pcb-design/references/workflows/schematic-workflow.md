# Schematic workflow

## Contents

- Enter the schematic scope
- Design a new schematic
- Modify an existing schematic
- Review an existing schematic
- Verify parts and footprints
- Close schematic work

## Enter the schematic scope

Use this workflow for schematic-only work and for the schematic phase of an
end-to-end design. Read [entry-routing.md](entry-routing.md) for shared intake and the
handoff contract. Load only the specialized references required by the circuit,
such as power, mixed-signal, crystal, antenna, protocol, or high-speed guidance.

Record whether the requested outcome is:

- guidance or architecture development;
- creation or modification of the schematic; or
- read-only verification of an existing exact revision.

For a schematic-only request, stop after schematic closure. Do not create or
modify a PCB, run PCB geometry audits, or imply that layout or manufacturing is
cleared.

## Design a new schematic

1. Partition power, protection, control, clock, analog, digital, debug, test,
   and external interfaces before drawing.
2. Define rails, current paths, signal directions, connector pinouts, default
   states, sequencing, and critical-net intent.
3. Choose exact orderable parts and variants from authoritative datasheets and
   applicable reference designs; do not copy critical values by habit.
4. Draw one functional block at a time and keep signal flow readable.
5. Connect every power and ground pin deliberately, including hidden units.
6. Place local decoupling at every relevant supply pin and size bulk
   capacitance from the rail and load requirements.
7. Define reset, enable, boot, configuration, unused inputs, and no-connect
   intent so no pin floats accidentally.
8. Implement clock, reference, feedback, sense, termination, filtering, and
   protection networks from their sourced requirements.
9. Put reverse-polarity, overcurrent, surge, and ESD protection at the relevant
   energy or interface entry point.
10. Label rails, buses, and nets consistently; remove ambiguous crossings and
    verify connector pinouts from the mating side.
11. Add test points only where their loading, stub, access, and shorting risk are
    acceptable.
12. Run ERC, inspect every warning and no-connect marker, save/reopen the exact
    page, and verify schematic/netlist identity.

For live creation, close the schematic identity canary in
[live-build-gates.md](live-build-gates.md) before expanding the component
population. Stop after `SCHEMATIC_VERIFIED` when the selected scope is
schematic-only.

## Modify an existing schematic

Bind the project, parent schematic, page UUID, and exact saved revision before
writes. Define the intended component, property, and connectivity delta in
advance. Preserve immutable pre-edit semantic/netlist evidence and verified
rollback appropriate to any destructive operation.

Apply one bounded logical change at a time, await it, save, switch away, reopen,
and read back the result. Require untouched component identities and nets to
remain stable, verify the intended delta, and rerun ERC and applicable targeted
checks. Mark every previous handoff and downstream PCB synchronization result
stale. Do not update an existing PCB unless the user expands the scope and the
handoff is reclosed.

## Review an existing schematic

Keep review read-only unless the user separately requests a fix. Bind the exact
revision, establish the intended requirements from available sources, and label
unknown intent rather than guessing it.

Review in this order:

1. project/page identity, readable functional partition, and source revision;
2. exact part variants, values, ratings, orderable numbers, and DNP intent;
3. power pins, rails, current capacity, sequencing, decoupling, bulk storage,
   grounding, and protection;
4. reset, boot, enable, configuration, unused pins, clocks, references, analog
   bias, feedback/sense, and test access;
5. connector pinouts and mating view, signal directions, net labels, buses,
   crossings, dangling wires, and no-connect intent;
6. applicable datasheet/reference-design conformance and specialized circuit
   checks;
7. symbol-to-pad and footprint evidence when handoff readiness is in scope;
8. ERC results plus manual inspection of every warning or exception.

Do not replay construction steps or begin redrawing merely because a defect is
found. Explain the finding, consequence, evidence, and smallest corrective
action. If the user requested electrical-only review, state that footprint and
handoff readiness were not established.

## Verify parts and footprints

For every PCB-included component:

1. verify package name and dimensions against the exact orderable part;
2. compare symbol pin numbers and functions to footprint pad numbers;
3. verify pin 1, diode polarity, polarized terminals, connector mating view,
   mounting-hole plating, and exposed/thermal pads;
4. verify courtyard, body, assembly, paste, solder-mask, and thermal details;
5. verify manufacturer part number and BOM inclusion or DNP/manual-fit intent;
6. define default resistor and capacitor footprints by role, rating, and
   assembly method, then apply them consistently;
7. record each passive-footprint exception by designator, exact part, and
   engineering reason.

Do not select a footprint by a similar-looking name. Do not mix passive sizes
merely because multiple library choices exist, and do not force uniformity when
electrical, thermal, RF, mechanical, sourcing, assembly, or rework requirements
make the default unsuitable.

## Close schematic work

For guidance or work in progress, state the decision, its basis, assumptions,
and next gate without PASS/FAIL language. For a concluded review, follow the
natural-language review contract in `SKILL.md` and make the unreviewed PCB scope
explicit.

For schematic-only creation or modification, either:

- close the handoff gate in [entry-routing.md](entry-routing.md) and state that the result
  is ready to enter PCB planning, not fabrication; or
- stop with the blocking handoff information, why it matters, and the concrete
  next action.

# Schematic presentation gate

Use this gate for live schematic construction, substantial schematic redraw,
schematic review, and schematic-to-PCB handoff. It complements connectivity,
identity, component-evidence, and ERC checks; none of those prove that a human
can understand the drawing.

## Preserve functional structure

- Partition the page before placing parts. Arrange power entry and conversion,
  protection, controller, reset/boot, clocks, analog, debug, connectors, and
  external interfaces as recognizable blocks.
- Prefer a consistent left-to-right or top-to-bottom signal and power flow.
- Draw local functional chains with continuous wires. Examples include an
  input-protection-regulator path, connector-ESD-termination-controller path,
  reset pull-up/button/capacitor network, feedback divider, and crystal loop.
- Use power and ground symbols for rail distribution and return intent. A
  schematic does not need a literal physical power/ground loop.
- Use net labels, ports, and buses at genuine block or page boundaries, repeated
  rails, and connector breakouts. Do not replace every local connection with a
  short wire carrying a net name.
- Place decoupling and bias parts beside the pin or functional block they serve;
  do not collect unrelated passives into a detached row merely because their
  net names are correct.

## Limit API fallbacks

A short `SCH_PrimitiveWire` carrying a net name is a connectivity canary or a
bounded fallback for one unavailable label operation. It is not a page-layout
strategy. After its save/reopen readback proves the API behavior, continue with
normal functional wiring and intentional block-boundary labels. If the API
cannot produce a readable representation, stop the affected page instead of
replicating the fallback across the design.

Do not defer visual review until PCB completion. After the first complete
functional block, save/reopen it and confirm that both the netlist and the block
presentation are correct before expanding the pattern.

## Run the gate

Before `SCHEMATIC_VERIFIED` or schematic handoff:

1. Bind the exact saved/reopened page UUID and revision evidence.
2. Run `easyeda_design_audit.mjs` and inspect
   `checks.presentation`, including wire geometry, annotation density, short
   stub ratio, and multi-segment wiring.
3. Treat `DEGRADED_LABEL_STUB_PATTERN` as blocking. Redraw the affected blocks;
   ERC or exported-netlist equality cannot waive it.
4. Treat `REVIEW_REQUIRED` as unverified until exact-page visual inspection
   confirms intentional block boundaries and readable local circuits.
5. Inspect the full saved/reopened page visually at a useful zoom. Confirm
   functional flow, local return intent, crossings, text, polarity, connector
   direction, and separation between unrelated blocks.
6. Compare the exported netlist and component identities with the pre-layout or
   intended connectivity record. Presentation repair must not silently change
   electrical intent.
7. Record the visual conclusion and any deliberate connector-map or cross-sheet
   labeling exception in the handoff evidence.

The audit thresholds are a regression screen, not a drawing standard. A page
can pass the geometry screen and still be unreadable; a deliberate connector or
harness map can require labels more heavily than an ordinary circuit. Resolve
those cases through exact-page review and a specific engineering explanation,
not by suppressing an unexplained result.

## Close the gate

Close presentation only when:

- each consequential local circuit can be followed without reconstructing it
  solely from repeated labels;
- labels and ports express hierarchy or distribution rather than hide local
  topology;
- power, ground, decoupling, protection, reset/boot, clock, and connector blocks
  are visually associated with the parts they serve;
- the saved/reopened exported netlist still matches the intended connectivity;
- ERC findings and visual exceptions are understood and recorded.

Presentation closure establishes a reviewable schematic. It does not establish
PCB placement, routing, return-path geometry, mechanics, manufacturing output,
or fabrication readiness.

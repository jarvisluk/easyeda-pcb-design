# Schematic presentation gate

Use this gate for live schematic construction, substantial schematic redraw,
schematic review, and schematic-to-PCB handoff. It complements connectivity,
identity, component-evidence, and ERC checks; none of those prove that a human
can understand the drawing.

## Contents

- Define functional groups and boundaries
- Preserve functional structure
- Place symbols deliberately
- Declare the drawable page area
- Limit API fallbacks
- Run the gate
- Close the gate

## Define functional groups and boundaries

- Partition the schematic by functional responsibility before placing symbols.
  Choose groups from the design architecture, such as power entry/conversion,
  controller or processing core, sensing/analog, clock, reset/boot, protection,
  communication channels, debug, and external interfaces. These are examples,
  not a fixed taxonomy.
- Assign every symbol to one primary group and give each group one contiguous
  page region. Use whitespace and a concise group title or boundary annotation
  so the grouping is visible without tracing nets. Split a large group into
  named subgroups instead of letting unrelated circuits share one region.
- Group support parts with the circuit they serve. Keep local decoupling, bias,
  termination, filtering, and protection beside their load or interface; do not
  create a detached passive-components group merely because the parts share a
  type. Keep power entry, conversion, sequencing, and distribution in a power
  group while leaving each load's local decoupling with that load.
- Define the boundary nets and signal directions for every group before drawing
  cross-group connectivity. Carry each cross-group logical connection through a
  consistently named net label, port, or bus at the group boundary. Do not run a
  continuous wire from one group across another group or build shared wire
  trunks that visually couple otherwise separate groups.
- Keep continuous wires inside a group for local topology and short functional
  chains. Labels at group boundaries must not replace the local circuit with a
  label on every pin. If two nominal groups require a direct continuous local
  chain to remain understandable, merge them into one group or document the
  deliberate boundary exception instead of drawing an unexplained cross-page
  wire.

## Preserve functional structure

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

## Place symbols deliberately

Wiring readability and symbol placement are separate failures. A page can carry
correct continuous wiring and still be unreadable because its symbols are piled
at one coordinate or pushed off the drawing frame, and the wiring screen sees
neither defect.

Every part symbol needs an intentional pose, taken from the block partition
above, before its wiring is drawn:

- Assign an explicit coordinate and rotation in the `SCH_PrimitiveComponent`
  create call. Never let a symbol take a default or inherited position, and never
  create a second symbol at a coordinate already used by another part.
- Reserve a region per functional block and place that block's parts inside it.
  Keep visible whitespace between blocks so a reader sees the partition without
  tracing nets.
- Leave clearance between neighboring symbols for their pins, designator, value,
  and other attribute text, plus the wiring that must reach them. A pin that
  needs a wire stub has to have room for it.
- Orient a symbol to the direction its signals travel: inputs facing their
  source, outputs facing their load, power pins toward the rail. Rotation is part
  of the pose, not decoration.
- Spread a block across its region instead of compressing it into a corner. A
  page whose parts occupy a small fraction of the drawable area is a crowding
  defect even when no two symbols touch, because it forces every later wire into
  a congested space.
- Grow the drawing by placing the next block in its own region. Do not stack a
  later block onto an earlier one, and do not extend past the drawable page area
  to make room.

When a page genuinely runs out of room, add a schematic page and use hierarchy or
cross-page labels at the boundary. Do not compress blocks, overlap symbols, or
place parts beyond the page bound as a substitute.

## Declare the drawable page area

EasyEDA exposes no API for the drawing frame, sheet size, or title-block extent;
the schematic canvas record carries only an origin. Symbols placed outside the
visible sheet are therefore invisible to every API-side check unless the drawable
area is declared explicitly.

Author one envelope record per schematic page, in schematic units (10 mil), bound
to that exact page UUID:

```json
{
  "kind": "easyeda-schematic-page-envelope",
  "schemaVersion": 1,
  "unit": "10mil",
  "documentUuid": "<exact schematic page UUID>",
  "source": "A4 landscape frame minus title block and 50-unit margin, measured in the editor at 100% zoom",
  "envelope": { "minX": 0, "minY": 0, "maxX": 1100, "maxY": 750 }
}
```

`source` must state how the bound was established, such as the sheet format in
use plus the title-block and margin reservation, and how it was measured or read.
A bound with no stated basis is a guess, and a guessed frame cannot support a
blocking page-overrun finding.

Declare the envelope during page partition, before placing the first symbol, and
keep every block inside it. Pass it to the baseline audit:

```bash
node scripts/audits/easyeda_design_audit.mjs \
  --schematic-page-envelope schematic-page-envelope.json \
  --output design-audit.json
```

Without the record, `checks.symbolPlacement` still detects stacked symbols and
BBox crowding, but page overrun is undetectable and the schematic result stays
`UNVERIFIED FOR FABRICATION`. Changing the sheet format or title block stales the
record; reauthor it and rerun the audit.

## Limit API fallbacks

A short `SCH_PrimitiveWire` carrying a net name is a connectivity canary or a
bounded fallback for one unavailable label operation. It is not a page-layout
strategy. After its save/reopen readback proves the API behavior, continue with
normal functional wiring and intentional block-boundary labels. If the API
cannot produce a readable representation, stop the affected page instead of
replicating the fallback across the design.

Do not defer visual review until PCB completion. After the first complete
functional block, save/reopen it and confirm that both the netlist and the block
presentation are correct before expanding the pattern. Include symbol placement
in that first-block check: a pose convention that stacks or overruns is cheapest
to fix before the rest of the page repeats it.

## Run the gate

Before `SCHEMATIC_VERIFIED` or schematic handoff:

1. Bind the exact saved/reopened page UUID and revision evidence.
2. Run `easyeda_design_audit.mjs` with the page-envelope record and inspect
   `checks.presentation`, including wire geometry, annotation density, short
   stub ratio, and multi-segment wiring.
3. Treat `DEGRADED_LABEL_STUB_PATTERN` as blocking. Redraw the affected blocks;
   ERC or exported-netlist equality cannot waive it.
4. Inspect `checks.symbolPlacement`. Treat `DEGRADED_SYMBOL_PLACEMENT` as
   blocking: coincident symbol poses and symbols outside the declared drawable
   page area are placement defects, not display artifacts. Reposition the named
   designators and rerun the audit against the saved/reopened page.
5. Treat `REVIEW_REQUIRED` from either check as unverified until exact-page
   visual inspection confirms intentional block boundaries, readable local
   circuits, and separable symbols. Intersecting symbol BBoxes and a crowded
   coordinate spread are review evidence, not proof: the schematic BBox API is
   beta and includes attribute text.
6. Inspect the full saved/reopened page visually at a useful zoom. Confirm
   functional flow, group titles or boundary annotations, group membership,
   local return intent, crossings, text, polarity, connector direction,
   separation between unrelated groups, absence of unexplained continuous
   cross-group wires, and that no symbol or its text sits outside the visible
   sheet.
7. Compare the exported netlist and component identities with the pre-layout or
   intended connectivity record. Presentation repair must not silently change
   electrical intent. Repositioning a symbol must leave its connectivity intact;
   prove that from the readback rather than assuming a move is safe.
8. Record the visual conclusion, the page-envelope record and its source, and
   any deliberate connector-map or cross-sheet labeling exception in the handoff
   evidence.

The audit thresholds are a regression screen, not a drawing standard. A page
can pass the geometry screen and still be unreadable; a deliberate connector or
harness map can require labels more heavily than an ordinary circuit. Resolve
those cases through exact-page review and a specific engineering explanation,
not by suppressing an unexplained result.

## Close the gate

Close presentation only when:

- every symbol belongs to a recognizable functional group, support parts remain
  with the circuit they serve, and unrelated groups occupy visibly separate
  page regions;
- cross-group connectivity uses consistently named labels, ports, or buses at
  group boundaries; continuous wires remain inside a group except for a
  documented deliberate boundary exception;
- each consequential local circuit can be followed without reconstructing it
  solely from repeated labels;
- labels and ports express hierarchy or distribution rather than hide local
  topology;
- power, ground, decoupling, protection, reset/boot, clock, and connector blocks
  are visually associated with the parts they serve;
- every part symbol holds a deliberate, unique pose inside its functional-block
  region, with room for its pins, text, and wiring;
- every symbol and its attribute text lie inside the declared drawable page
  area, and that envelope is bound to the exact page with a stated source;
- the saved/reopened exported netlist still matches the intended connectivity;
- ERC findings and visual exceptions are understood and recorded.

Presentation closure establishes a reviewable schematic. It does not establish
PCB placement, routing, return-path geometry, mechanics, manufacturing output,
or fabrication readiness.

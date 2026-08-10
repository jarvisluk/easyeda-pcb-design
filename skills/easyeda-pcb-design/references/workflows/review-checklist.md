# Final review checklist

## Contents

- Select the review scope
- Schematic
- Footprints and placement
- PCB
- Manufacturing
- High-speed, PDN, and EMC when applicable

A completed checklist still does **not** authorize fabrication by itself.
Machine-readable audit artifacts retain their controlled decisions and
`fabricationRelease: false`, but the user-facing review must follow the natural
engineering explanation contract in `SKILL.md` instead of reproducing artifact
fields as a status form.

## Select the review scope

- For **schematic-only review**, use the Schematic section and the footprint
  checks only when handoff readiness is included. Explicitly explain that PCB
  placement, routing, copper, mechanics, and manufacturing were not reviewed.
- For **PCB-only review**, require a current schematic handoff, then use the
  applicable Footprints and placement, PCB, and specialized sections. Do not
  imply that unreviewed manufacturing outputs are clear.
- For **end-to-end or fabrication review**, use every applicable section and
  bind all evidence to the exact schematic, PCB, and output revisions.

If high-speed-like nets exist, a baseline review alone remains unverified for
fabrication until the required high-speed evidence is attached. Manufacturing
outputs remain unreviewed unless the required artifact and human review evidence
exists. Explain those limits naturally, with the concrete missing evidence and
next action.

## Schematic

- Correct part variants, values, ratings, and orderable numbers.
- Component-selection evidence covers every PCB-included designator, matches the
  live manufacturer part number and footprint, binds to the exact schematic
  fingerprint, and uses readable hash-verified manufacturer source artifacts.
- Consequential numeric parameters retain unit, conditions, exact source and
  location; board requirements retain their basis; required suitability checks
  pass, including linear-regulator current, dropout, and worst-case junction
  temperature.
- Every part classifies functional capability, electrical limits, operating
  range, tolerance/accuracy, power/thermal, timing/frequency, signal-integrity
  parasitics, mechanical/assembly, and environment/reliability as audited,
  recorded, or concretely not applicable; no parameter or check is unclassified.
- Each part has an exact or qualified custom library-device binding. Any changed
  MPN has explicit substitution authority and resolved electrical, pinout,
  package, footprint, thermal, mechanical, firmware, and regulatory comparison.
- Every inaccessible, failed, unreadable, mismatched, or stale governing source
  remains explicitly unverified; no search snippet, distributor table, library
  entry, or similar-part datasheet is treated as selection authority.
- The current `requirements-baseline.json` has an append-only
  `easyeda-requirements-baseline-check` report with `cleared: true`, matching
  revision/fingerprint, complete required function-category coverage, and every
  core-part capability mapped to an included, omitted, or not-applicable board
  decision. It records alternatives and consequences, names intentionally
  omitted interfaces/features, and carries original-request evidence, user
  confirmation, or explicit delegated tradeoff authority for every material
  choice. A prose brief is not accepted as the authority.
- All power/ground pins and hidden power units handled.
- Decoupling, bulk capacitance, reset, boot, clock, and programming circuits complete.
- Connector pinouts verified from the mating side.
- Protection and polarity complete.
- No unintended floating inputs or dangling wires.
- Functional blocks and local circuit chains are visually traceable; labels,
  ports, and short net-carrying stubs do not replace nearly all local wiring.
- `checks.presentation` is not `DEGRADED_LABEL_STUB_PATTERN`; any
  `REVIEW_REQUIRED` result has exact-page visual evidence and a specific
  connector-map, hierarchy, or cross-sheet rationale.
- Schematic DRC clean or exceptions documented.

## Footprints and placement

- The outline, stackup, and floorplan were frozen together after representative
  escape, route, return, power, thermal, access, antenna, and assembly canaries;
  no child artifact remained provisional or conditional.
- The exact-revision `layout-constraints.json` passes
  `easyeda_constraint_lint.py` with `CLEARED_FOR_PLACEMENT`. Every shared board
  edge, corridor, plane, via field, quiet/thermal region, access path, and
  assembly volume conflict is resolved with current evidence.
- The saved/reopened PCB has an exact-revision `easyeda_placement_audit.mjs`
  report with `PLACEMENT_CLEAR_FOR_ROUTING`. Missing, unresolved, blocked, or
  stale placement evidence is not replaced by a clean DRC.
- No ordinary via annular ring or drill intrudes into a pad, including same-net
  pads; every intentional overlap is bound by exact via ID, designator/pad, and
  filled/capped/planarized or documented land-pattern process evidence.
- Symbol-to-pad mapping verified.
- Every resistor and capacitor matches the declared passive-package policy;
  each size exception names the designator, orderable part, and engineering reason.
- Pin 1 and polarity visible.
- Every explicit user board-size, location, orientation, edge, and access
  requirement has a recorded feasibility disposition. Accepted requirements
  are preserved; rejected or unresolved ones name the conflict and proposed
  revision rather than being silently overridden.
- The board outline is supported by a recorded placement study using verified
  body/courtyard, keepout, mating/actuation, assembly, thermal, and credible
  routing-corridor envelopes; summed component area alone is not accepted.
- Mechanical dimensions, holes, keepouts, and connector orientation correct.
- Every operator control matches its top/side/vertical actuation direction,
  board edge or panel location, installed orientation, and enclosure opening.
- Its sourced 3D finger/tool and motion envelope is clear of tall parts,
  connectors, cables, shields, and walls; surrounding parts face away from the
  approach/travel path, legends remain readable, and PCB support carries the
  expected actuation force.
- Decoupling, crystal, protection, and regulator loops placed appropriately.
- Switching power hot loops, switch nodes, gate/bootstrap paths, feedback,
  current sense, thermal paths, and magnetic coupling match the frozen
  topology-specific constraint record.
- Every switching-power copper candidate independently closes its recorded
  thermal gate and electrical/EMI gate on the same revision and operating
  condition; a documented compromise alone is not accepted.
- Mixed-signal converter, reference, clock, exposed-pad, and interface
  placement follows the source/return-current partition rather than pin names
  or a generic split-ground rule.
- BGA/fine-pitch escape uses the exact package geometry and a representative
  DRC-cleared pattern supported by the selected fabricator and assembler.
- Crystal/resonator loops have datasheet-sourced distance, length, side/layer,
  and via limits; load capacitors are explicitly listed or not applicable.
- After function-critical placement, identical or same-footprint passives are
  locally grouped and consistently oriented where assembly benefits; grouping
  never lengthens a critical connection or obscures differing values.
- Every component has a sourced courtyard constructed from its exact land
  pattern and assembly rule. Every supported live pad is bound by both
  designator and parent primitive ID and contained by that courtyard. EasyEDA component BBox intersections remain
  screen candidates until both components have exact pair coverage;
  pad/pad overlap or inadequate copper clearance, pad/foreign-courtyard, and
  courtyard/courtyard conflicts are blocking. Through-hole components also have
  sourced opposite-side courtyards and per-pad maximum-projection evidence;
  bottom-side component-local courtyards have the declared mirror transform.
- Every core-module critical placement/escape zone contains only its declared
  owner and allowed close-support parts.
- Operator-control grouping or separation matches its recorded interaction
  decision and sourced access envelope.
- Every external connector has a mating-part, gender, pitch, orientation,
  population, exact-MPN, footprint, and optional exact-3D-model decision.
- Passive and connector variants follow the declared BOM-normalization policy;
  multiple pin counts in one justified connector family are not rejected merely
  for increasing the raw MPN count.
- Component access, height, edge, and assembly constraints satisfied.
- Onboard antenna/module orientation, board edge, ground/counterpoise, and
  separate copper/routing/component/mechanical keepouts match the exact
  revision-controlled vendor/reference layout.
- Integrated-module antenna direction is closed from the official drawing view
  convention through Pin 1, the numbered antenna-side pad group, an opposite
  body-side control group, the actual footprint rotation/mirror state, and the
  board-edge outward normal. Keepout location, silkscreen, or courtyard alone
  is not accepted as direction evidence.
- An integrated module's antenna end faces outward and uses the approved edge,
  overhang, or cutout arrangement. Any all-layer copper clearance is not
  mistaken for a physical removal of PCB laminate.
- Antenna integration feasibility is not presented as proof of normal RF
  operation. Without representative-enclosure VNA and product-level
  OTA/throughput/range, sensitivity, and orientation evidence, RF performance
  remains `UNVERIFIED`.

## PCB

- Board outline closed and correct.
- Unrouted connections equal zero.
- Track/via geometry meets current and process constraints.
- Routing-layer usage matches the declared stackup/reference-plane strategy;
  outer pours are not treated as proof of return continuity.
- Frozen stackup records layer roles, adjacent references, finished fabricator
  construction, copper, Dk/Df assumptions, impedance classes, symmetry, and
  sequential-lamination or via constraints where applicable.
- No unintended arbitrary-angle segments, stubs, or hard unchamfered 90° corners.
- No unintended closed routing cycles or duplicate feeds between copper regions
  that were already connected.
- Every retained ring or parallel feed is named by the audit's
  `--allow-routing-cycle NET` exception and has a specific engineering note;
  power/GND names are not automatic exemptions.
- Ground/reference return paths are continuous enough for the signals involved.
- Generic edge/connector/reference stitching stays outside exact antenna,
  module, and other specialized no-via or copper exclusions.
- Copper regions rebuilt; every generated solid fill has a unique ID and
  per-fill connectivity/DRC evidence.
- No unwanted islands or narrow copper necks; `preserveSilos=false` alone is
  not accepted as evidence that isolated copper was removed.
- PCB DRC clean or exceptions documented.
- The rule-bound repeated DRC protocol in `drc-evidence-closure.md` is complete:
  `checks.drc.evidenceVerified` is true, both silent samples and the visible
  final sample have the same canonical leaf set, and the start/end full-rule
  fingerprints match. A prior clean report is marked stale after any
  DRC-affecting geometry or rule change.
- Per-layer readback shows no forbidden pour, track, via, pad, component, test
  point, fastener, or panel feature intruding into any antenna exclusion region.

## Manufacturing

- Copper-to-edge, drill, annular ring, solder mask, and silkscreen meet the selected process.
- Silkscreen-to-pad/mask clearance, exact-footprint land pattern, component
  courtyard spacing, live-pad containment, foreign-pad separation, solder
  fillet/paste access, and rework access meet the selected assembly process.
  Own-pad/body overlap is not rejected generically.
- Gerber layers, drill files, board outline, slots, and plated/unplated holes reviewed.
- BOM values/packages/manufacturer parts reviewed.
- Pick-and-place origin, rotation, and top/bottom side reviewed.
- 2D and 3D previews checked for polarity and mechanical conflicts.
- API package regression records ZIP integrity, a closed/nonzero Gerber
  outline, expected copper-layer count, PTH/NPTH drill presence, slot count,
  BOM/PnP designator parity, and immutable checksums.
- Every BOM omission has an explicit DNP/manual-fit disposition; PnP presence
  alone does not mean the part is populated.
- Optional beta metadata that contradicts Gerber/drill output is retained and
  escalated; it is never used to overwrite the manufacturing authority.

## High-speed, PDN, and EMC when applicable

- Revision-controlled interface, stackup, timing, impedance, and evidence
  record complete.
- Package, connector, protection, AC-coupling, termination, and topology
  assumptions verified.
- Intra-pair, inter-pair, group, and package-delay budgets checked separately.
- Reference-plane transitions, return vias, voids, slots, and launch
  discontinuities reviewed.
- PDN target impedance, anti-resonance, plane/via current paths, and
  simultaneous-switching effects reviewed.
- BGA power/ground via fields, escape bottlenecks, breakout transitions, and
  high-speed launches reviewed against package and fabrication constraints.
- ESD/chassis current path and differential-to-common-mode conversion reviewed.
- Required field-solver, S-parameter, TDR, eye, impedance-coupon, PDN, or EMC
  evidence attached to the exact PCB revision.
- Crystal startup margin, load capacitance, pin mapping, ground/keepout policy,
  and aggressor separation manually reviewed against the exact PCB revision.
- Any host-board RF feed has stackup/impedance/launch evidence; a custom or
  materially changed PCB antenna has EM simulation plus calibrated VNA and
  product-level OTA/throughput/range evidence for the representative enclosure.
- Antenna evidence is invalidated and re-reviewed after changes to geometry,
  keepout, board outline, stackup, ground, matching, enclosure, battery, cable,
  display, nearby metal, output power, or radio configuration.
- Final module/antenna integration conditions and destination-region regulatory
  obligations have human compliance review; module approval is not treated as
  blanket product authorization.

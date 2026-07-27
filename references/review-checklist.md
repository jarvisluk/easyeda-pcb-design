# Final review checklist

## Schematic

- Correct part variants, values, ratings, and orderable numbers.
- All power/ground pins and hidden power units handled.
- Decoupling, bulk capacitance, reset, boot, clock, and programming circuits complete.
- Connector pinouts verified from the mating side.
- Protection and polarity complete.
- No unintended floating inputs or dangling wires.
- Schematic DRC clean or exceptions documented.

## Footprints and placement

- Symbol-to-pad mapping verified.
- Pin 1 and polarity visible.
- Mechanical dimensions, holes, keepouts, and connector orientation correct.
- Decoupling, crystal, protection, and regulator loops placed appropriately.
- Component access, height, edge, and assembly constraints satisfied.

## PCB

- Board outline closed and correct.
- Unrouted connections equal zero.
- Track/via geometry meets current and process constraints.
- No unintended arbitrary-angle segments, stubs, or sharp unchamfered corners.
- Ground/reference return paths are continuous enough for the signals involved.
- Copper regions rebuilt and generated fills verified.
- No unwanted islands or narrow copper necks.
- PCB DRC clean or exceptions documented.

## Manufacturing

- Copper-to-edge, drill, annular ring, solder mask, and silkscreen meet the selected process.
- Gerber layers, drill files, board outline, slots, and plated/unplated holes reviewed.
- BOM values/packages/manufacturer parts reviewed.
- Pick-and-place origin, rotation, and top/bottom side reviewed.
- 2D and 3D previews checked for polarity and mechanical conflicts.

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
- ESD/chassis current path and differential-to-common-mode conversion reviewed.
- Required field-solver, S-parameter, TDR, eye, impedance-coupon, PDN, or EMC
  evidence attached to the exact PCB revision.

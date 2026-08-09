# BGA and HDI escape planning

## Contents

- Scope and required sources
- Freeze the escape record
- Prove fanout feasibility
- Power, ground, and high-speed escape
- Fabrication and assembly gates
- Verification

## Scope and required sources

Use this reference before placing a BGA, fine-pitch LGA/WLCSP, dense module, or
any package that may require HDI, via-in-pad, blind/buried vias, backdrilling, or
more routing layers. Obtain the exact package drawing, ball map, land-pattern
guide, escape/reference layout, PCB fabricator capability, and assembler rules.

Never derive production pad, mask, via, or layer decisions from package pitch
alone. A generic table or a visually similar package is only a planning hint.

## Freeze the escape record

Record before ordinary placement:

- orderable part, package revision, body size, ball pitch/diameter, populated
  ball map, depopulated regions, and pin functions;
- pad technology and dimensions, solder-mask opening/web, paste policy,
  surface finish, and source;
- via types, finished drill, capture/target pads, annular ring, antipad, aspect
  ratio, sequential-lamination stack, fill/cap/planarization, and tolerances;
- fabricator and assembler capability revisions and expected inspection/rework;
- proposed fanout pattern by ball row/quadrant, allowed trace/space, neck-down,
  via count, signal layers, reference planes, and return transitions;
- power/ground ball groups, current per rail, via arrays, plane entry, and
  simultaneous-switching concerns;
- controlled-impedance launches, AC-coupling/termination ownership, timing,
  loss, skew, residual stub, and solver/measurement requirements;
- decoupling population, package-side relationship, placement/escape space,
  and mounted-current paths.

An unsupported fabrication feature or unresolved assembly rule is a stop before
fanout. Do not assume prototype and volume processes have identical capability.

## Prove fanout feasibility

1. Import or construct the verified footprint and ball map.
2. Reserve mechanical, decoupling, power/ground, clock, and critical-interface
   regions before assigning ordinary I/O escape.
3. Draw one representative escape for each distinct ball row, quadrant,
   pin-field obstruction, and via technology.
4. Check native DRC using the selected fabricator's actual rules.
5. Count usable channels per layer from the real populated ball map and escape
   geometry. Do not estimate layers from total ball count alone.
6. Confirm reference-plane continuity and antipad/via-field effects on every
   used signal layer.
7. Verify the pattern at package corners, dense power regions, differential
   pairs, clocks, and depopulated escape corridors.

If a representative route cannot pass, revise the package, layer count,
stackup, via technology, placement, or fabricator before propagating fanout.

## Power, ground, and high-speed escape

- Connect power and ground balls by actual current and transient demand. Avoid
  funneling a ball group through a narrow copper neck or an inadequate shared via.
- Preserve nearby return paths for signal vias. Dense ground vias do not help if
  antipads merge into a plane void that blocks the intended return current.
- Treat decoupling placement, package power balls, capacitor vias, planes, and
  package/on-die capacitance as one PDN path.
- Keep differential members and associated returns geometrically comparable
  through escape, but evaluate common-mode conversion, not only length.
- Record neck-down and uncoupled breakout lengths. Restore the validated
  impedance geometry after escape as soon as practical.
- Review through-via residual stubs, pad/antipad capacitance, reference changes,
  and connector/package launches. Use field/S-parameter analysis when required
  by the high-speed classification.
- Avoid a via-in-pad implementation unless the declared fill, cap, planarize,
  and inspection process makes the pad solderable and reliable.

## Fabrication and assembly gates

Keep pad copper, solder-mask opening, paste aperture, via fill/cap, body outline,
and courtyard as separate geometries.

Before release, confirm:

- NSMD/SMD choice and dimensions match the exact package/assembler guidance;
- mask registration and web are manufacturable across tolerance;
- via-in-pad or microvia construction, copper fill, cap, planarization, and
  sequential lamination are explicitly quoted;
- stacked or staggered microvias meet the selected reliability/process rules;
- paste segmentation, voiding limit, warpage, stencil, placement, reflow,
  X-ray/AOI, and rework requirements are defined;
- panel support, board thickness, copper balance, and thermal profile address
  package/board warpage;
- volume-production capability is confirmed, not inferred from a prototype pass.

## Verification

Bind these artifacts to the exact PCB revision:

1. package drawing, land-pattern/escape guide, and ball-map comparison;
2. fabricator/assembler capability confirmation;
3. footprint dimensional and symbol-to-ball review;
4. representative and final native DRC results;
5. per-layer fanout, via, antipad, plane, and copper-fill inspection;
6. PDN, SI, thermal, and mechanical evidence required by the classification;
7. final Gerber, drill, IPC/netlist where used, paste, assembly, and 3D review.

If pad technology, stackup, via process, package revision, placement, or fanout
changes, invalidate the affected evidence and repeat the feasibility gate.

# General EasyEDA design workflow

## Contents

- Intake
- Schematic
- Footprints
- Placement
- Routing
- Copper
- Verification

## Intake

Record:

- input voltage, rails, peak/continuous current, and power sequence;
- MCU/IC variants and package;
- external interfaces and connector pinouts;
- programming/debug method;
- board dimensions, holes, keepouts, height limits, and connector edges;
- layer count, copper weight, board thickness, minimum trace/space, minimum drill, and assembly method;
- environments affecting temperature, creepage, clearance, ESD, or isolation.

Treat missing electrical or mechanical requirements as unresolved constraints.

## Schematic

1. Group the page by functional blocks and keep signal flow readable.
2. Connect every IC power and ground pin deliberately.
3. Place local decoupling at each relevant supply pin and add bulk capacitance per rail/load.
4. Define reset, enable, boot, and configuration pins so none float unintentionally.
5. Implement clock networks from the device/reference-design requirements.
6. Put ESD, reverse-polarity, overcurrent, and surge protection at the energy entry point.
7. Label rails and buses consistently; avoid visually ambiguous crossings.
8. Add test points only where they do not create unacceptable stubs or shorts.
9. Run schematic DRC and review every no-connect marker.

## Footprints

For every PCB-included component:

1. verify package name and dimensions against the chosen orderable part;
2. compare symbol pin numbers to footprint pad numbers;
3. verify pin 1, cathode/anode, positive terminal, connector mating view, and mounting-hole plating;
4. verify courtyard, assembly, paste, solder-mask, and thermal-pad details;
5. verify manufacturer part and BOM inclusion.

Do not select a footprint by a similar-looking name alone.

## Placement

1. Place board outline, holes, connectors, switches, indicators, and mechanically fixed parts.
2. Place protection at connectors and power entry.
3. Place regulators and their input/output/feedback loops compactly.
4. Place clocks and their load network beside the associated pins.
5. Place each decoupling capacitor beside its supply pin with a short ground-return path.
6. Rotate and group parts to reduce crossings and create clear routing channels.
7. Keep noisy switching nodes away from clocks, analog inputs, antennas, and board edges.
8. Check accessibility, assembly orientation, rework space, and enclosure interference.

## Routing

1. Route high-current and sensitive loops first.
2. Select trace and via geometry from current, temperature rise, copper thickness, fabricator limits, and voltage drop.
3. Keep return paths direct; avoid cutting reference copper into narrow necks.
4. Use 0°, 45°, and 90° segment directions. Chamfer sharp 90° corners when two perpendicular segments meet.
5. Avoid arbitrary diagonal slopes, unnecessary zigzags, dead-end stubs, and excessive vias.
6. Route clocks, crystals, analog nodes, feedback nodes, and reset signals away from noisy power switching.
7. Do not use autorouting output without complete manual review.

## Copper

Copper pour is part of the standard workflow unless the design deliberately uses another reference-plane implementation.

1. Define the intended net, layer, clearance, thermal connection, priority, and island policy.
2. Rebuild copper after routing and after every geometry change.
3. Read back the generated copper region and require at least one filled region.
4. Disable isolated islands unless each island has a documented purpose and connection.
5. Inspect narrow necks, slots, voids under important traces, thermal spokes, and return-path discontinuities.
6. Add GND stitching near connectors, board edges, layer transitions, and noisy zones as appropriate.

## Verification

Run in order:

1. schematic DRC;
2. symbol/footprint/pin-map audit;
3. placement review;
4. unrouted/connectivity check;
5. angle and geometry audit;
6. copper rebuild and filled-region readback;
7. PCB DRC;
8. 2D/3D mechanical and polarity review;
9. fabricator capability check;
10. Gerber/drill/BOM/position-file review.

Any netlist, routing, footprint, outline, or copper change invalidates downstream checks.


# Baseline layout rules

## Contents

- Placement priorities
- Routing priority
- Routing geometry
- Routing topology
- Power and grounding
- Copper pours
- DFM and assembly

## Placement priorities

- Complete the user-requirement feasibility gate and hardware floorplan order in
  [constraint-planning.md](constraint-planning.md) before applying these local
  electrical and assembly priorities.
- Mechanical constraints override cosmetic alignment.
- Protection belongs at the external energy entry point.
- Decoupling loop area matters more than matching a visual grid.
- Switch-mode regulator hot loops must be compact.
- Crystal traces must be short, symmetric where applicable, and isolated from switching nodes.
- Fix any onboard antenna, its board edge/orientation, all-layer keepouts, and
  intended ground/counterpoise before ordinary placement. Use the exact
  module/radio reference rather than a generic clearance distance.
- For a module with an integrated antenna, face the antenna end outward and
  prefer the approved board-edge/overhang placement. If the antenna must remain
  over the host PCB, reproduce the vendor's all-layer clearance or physical
  board cutout exactly; copper keepout and laminate removal are different
  constructions.
- Put connectors where orientation and mating access are unambiguous.

## Routing priority

- Plan the reference planes, power-distribution regions, return paths, and
  reserved routing corridors before committing individual traces. Reserve
  every mandatory antenna exclusion, package escape, power loop, reference and
  return transition, quiet region, controlled corridor, and tuning region
  first; reservation does not mean the corresponding trace is drawn first.
- Schedule each routed system by the combined severity of its constraint,
  scarcity of valid paths, coupling/return dependency, congestion exposure,
  and consequence of failure. Do not infer priority from a net name or from a
  simple power/high-speed/low-speed category.
- After hard reservations and board-specific conflicts are recorded, use this
  list only as a default tie-break order between systems with comparable
  combined priority:
  1. Switch-mode hot loops, high-current forward/return paths, and critical
     decoupling loops.
  2. Host-board RF feeds, antenna matching networks, and other RF paths whose
     placement/corridor is fixed by the selected antenna reference design.
  3. Controlled-impedance differential pairs and timing-, skew-, or
     length-constrained interfaces.
  4. Clocks, passive-crystal loops, strobes, and other sampling-critical nets.
  5. Sensitive analog, reference, feedback, and low-level sensor nets.
  6. Reset, boot-configuration, chip-select, interrupt, and other
     function-critical control nets.
  7. Ordinary low-speed buses and digital signals.
  8. Indicators, buttons, and other tolerant housekeeping nets.
- Classify digital signal-integrity risk from edge rate and interconnect
  electrical length, not nominal clock or data frequency alone. A low-frequency
  signal with a fast edge may require high-speed treatment.
- Within the same tie-break class, route the most constrained system first:
  the net with the fewest feasible corridors, tightest skew or length budget,
  strictest via limit, hardest pad escape, greatest return-path risk, or highest
  congestion exposure.
- Preserve priority during iterative routing. A higher-priority net may trigger
  rip-up and reroute of a lower-priority net; a lower-priority net must not
  consume a reserved corridor, break a reference path, or degrade an already
  satisfied higher-priority constraint.
- Treat the priority list as a routing scheduler, not as permission to ignore
  coupled constraints. Route associated forward/return paths, differential-pair
  members, termination parts, and reference-transition vias as one system.

## Routing geometry

- Choose routing layers from component side, adjacent reference plane, return
  path, and escape constraints; do not prefer top or bottom by appearance. On a
  typical two-layer top-assembly board, keep most signals on top and preserve
  the bottom as a broad GND reference where practical. On four layers, route a
  critical top-layer signal against the adjacent continuous GND layer; use the
  bottom only when its adjacent reference layer is also suitable and continuous.
- Outer-layer pours may exist on both sides. A pour's side does not by itself
  determine which side should carry most routing, and a pour is not proof of a
  continuous return path.
- Use horizontal, vertical, or 45-degree trace segments by default.
- Do not join two perpendicular segments as a hard 90-degree corner. Insert a
  45-degree chamfer unless a documented pad escape or mechanical constraint
  makes it impractical. Treat this mainly as a routing-quality, inspection, and
  consistency rule; its electrical consequence depends on edge rate and geometry.
- Do not leave arbitrary slopes created by dragging endpoints.
- Keep widths stable; neck down only where pads or verified constraints require it.
- Avoid dead ends, branches, unnecessary layer changes, and vias inside pads unless the process supports them.
- Do not treat a clean DRC as proof of a good return path.

## Routing topology

- Treat each net as a graph containing pads, vias, track endpoints, and real
  copper intersections. By default, a newly committed route must join two
  previously disconnected copper components.
- Reject a candidate path when its two ends are already electrically connected;
  this prevents a router from entering one pad or trunk at two points and
  creating a redundant closed loop.
- For a multi-pad net, grow one connected tree: choose the next
  component-to-component connection with a minimum-spanning/Steiner-style
  estimate, route it, then recompute connectivity before routing the next one.
  Do not route every pad independently back to the original source.
- Stop a route at the first valid contact with the destination pad, via, track,
  or pour. Snap to one deliberate connection point instead of continuing around
  the same copper shape to a second contact.
- After routing a net, prune zero-purpose stubs and cycles, then recheck
  connectivity and unrouted count. Preserve a redundant ring or parallel feed
  only when its current-sharing, voltage-drop, reliability, and return-path
  purpose is explicitly documented.

## Power and grounding

- Size copper from current, voltage drop, allowed temperature rise, copper thickness, and via count.
- Keep high-current forward and return paths adjacent and direct.
- Do not route sensitive ground through switching-current paths.
- Prefer a broad continuous GND reference over fragmented ground traces.
- Use stitching vias to join reference copper; a decorative via grid is not a
  substitute for a connected return path. Place stitching only outside
  specialized copper/via/component keepouts. An exact antenna or module
  integration rule overrides this generic stitching preference within its
  documented exclusion region.

## Copper pours

- Create the pour after critical routing, then rebuild it after every later edit.
- Verify the generated fill primitive; a visible boundary alone is insufficient.
- Disable retained islands by default.
- Inspect thermal-relief current capacity and solderability.
- Check that the pour did not create narrow slivers, unintended antennas, or blocked clearances.
- For an onboard antenna, verify generated fill on every layer against the
  exact antenna exclusion polygons. A visible boundary or note is not proof of
  an enforceable keepout.

## DFM and assembly

- Use the selected fabricator's current minimum trace, spacing, drill, annular ring, mask dam, edge clearance, and copper-to-hole rules.
- Treat silkscreen, assembly outline, courtyard, solder mask, copper pad, and 3D
  body as different geometries. Silkscreen is never the authoritative maximum
  component body or courtyard.
- Keep silkscreen outside the pad/solder-mask opening by the selected
  fabricator's rule. For JLCPCB, use 0.15 mm as the current planning floor, then
  recheck the current capability page and final Gerber because overlapping
  legend may be clipped rather than printed.
- Do not impose a universal clearance between a component and its own pads:
  gull-wing leads, bottom-terminated packages, castellated modules, and exposed
  pads intentionally overlap body/terminal geometry. Validate the exact
  datasheet land pattern and require the intended solder fillet, paste, and
  rework access for the chosen assembly process.
- Prevent one component's physical body/courtyard from intruding into another
  component's assembly space. Use package-pair spacing from the assembler; for
  JLCPCB assembly, consult its current package-to-package spacing table rather
  than one global value.
- Check silkscreen clipping, reference/polarity visibility, and 3D body overlap.
- Keep copper away from board edges and unplated slots according to the process rule.
- Verify fiducials, tooling needs, panel breakaway zones, and component-to-edge clearance when assembling.
- Review Gerber, drill, BOM, and pick-and-place outputs rather than assuming export success.

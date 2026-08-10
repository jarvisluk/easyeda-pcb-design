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
- Place by mechanical and electrical function, not package identity. Do not
  attract otherwise unrelated parts because they share a footprint. After
  ordinary passives are already co-located by a functional block, package
  identity may guide consistent orientation and spacing for assembly only when
  it does not lengthen connections, enlarge loops, consume escape space, or
  obscure differing values.
- Around pad-dense core modules and major ICs, reserve usable escape space on
  every side that carries connections; do not pack unrelated parts against the
  pad rows before a representative fanout and routing canary proves the paths.
  Size the space from the exact footprint, connection count and direction,
  trace/via/clearance rules, and layer plan rather than a universal distance.
  Allow only parts that must remain electrically close to occupy it, and verify
  that they do not block the required escapes.
- Protection belongs at the external energy entry point.
- Decoupling loop area matters more than matching a visual grid.
- Switch-mode regulator hot loops must be compact.
- Crystal traces must be short, symmetric where applicable, and isolated from switching nodes.
- Fix any onboard antenna, its board edge/orientation, all-layer keepouts, and
  intended ground/counterpoise before ordinary placement. Use the exact
  module/radio reference rather than a generic clearance distance.
- For a module with an integrated antenna, face the antenna end outward and
  prefer a vendor-approved physical cutout that keeps the complete module
  within the board's external dimensions. Use overhang only when the exact
  module guide requires it or no approved in-outline construction is feasible,
  and record its increase to the maximum board/module envelope. Reproduce the
  exact all-layer clearance and cutout; copper keepout and laminate removal are
  different constructions.
- Put connectors where orientation and mating access are unambiguous. Select
  gender, pitch, height, keying, and population from the recorded mating
  architecture; never infer them from whichever library model looks convenient.

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
- Avoid dead ends, branches, and unnecessary layer changes.
- For every ordinary via, use the recorded standard outer diameter and hole
  diameter, then keep its copper edge at least the recorded via-to-pad copper
  clearance from every pad. Check the full pad shape rather than component
  origins, check drill-edge intrusion separately, and do not rely on a same-net
  DRC exemption to justify overlap.
- Treat via-in-pad or any intentional via/pad overlap as a special construction,
  not an ordinary via. Use it only when the land pattern and declared assembly
  process support the required fill, cap, planarization, mask, and paste policy.
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
- Treat every generated `fill === true` record as a separate copper region.
  Disable retained islands by default, but do not treat that setting as proof
  that every generated region is connected.
- After each rebuild, bind every solid-fill ID and correlate it with detailed
  DRC. Overlap with same-net copper on another layer is not a connection; require
  a same-net pad, track, plated hole, or via that actually joins the region.
- For each disconnected region, choose exactly one disposition:
  1. remove it by changing the source-Pour boundary, clearance/keepout, priority,
     or island policy, then rebuild;
  2. when the region improves current spreading, return continuity, shielding,
     or thermal behavior, connect it deliberately with a rule-compliant same-net
     pad, neck, or stitching via outside every specialized keepout, then rebuild;
  3. when an electrically isolated electrode, heat spreader, coupon, or other
     floating copper feature is intentional, represent and review it as a
     separately named feature with documented geometry, clearance, EMC/thermal
     purpose, and DRC disposition. Never count it as a valid reference or power
     pour.
- Do not add a decorative via merely to silence a free-copper result. Verify the
  resulting current/return path, clearance, manufacturability, and intended net.
- Do not apply a universal island-area threshold. Remove narrow slivers and
  nonfunctional fragments using the selected fabricator's geometry limits;
  retain only regions whose connection and engineering purpose are proven.
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
- A component's board occupancy is its sourced courtyard plus every live pad,
  not just its visible body. Long switch terminals, connector tails,
  castellations, thermal tabs, and through-hole annular rings can extend well
  beyond the body. Prove every own pad is inside the sourced courtyard, then
  check each pad against all foreign pads and courtyards on the applicable side,
  including the sourced copper-clearance floor before routing.
- Through-hole/multilayer pads occupy both sides. Require a sourced
  opposite-side courtyard for connector tails, stakes, plastic, or other body
  projection below the owner side and per-pad `MAXIMUM_COPPER_PROJECTION`
  evidence; otherwise placement remains unresolved.
- Bind pads by both designator and parent component primitive ID. Bottom-side
  component-local courtyards need the declared mirror-then-rotate transform;
  missing identity or transform evidence is unresolved.
- Prevent one component's sourced courtyard from intruding into another
  component's assembly space. Construct courtyards from the exact land pattern,
  body/lead tolerances, solder fillets, and package-pair spacing from the
  assembler; for JLCPCB assembly, consult its current package-to-package spacing
  table rather than one global value.
- Check silkscreen clipping, reference/polarity visibility, and 3D body overlap.
- Group same-function operator controls only when the recorded interaction
  decision calls for it. A separated control requires a mechanical/functional
  rationale; a grouped control requires a sourced access and spacing envelope.
- Minimize orderable variants through a declared package and connector-family
  policy. Different pin-count parts in one connector series are not a generic
  failure; undeclared gender/series/height changes or unsupported exceptions are.
- Keep copper away from board edges and unplated slots according to the process rule.
- Verify fiducials, tooling needs, panel breakaway zones, and component-to-edge clearance when assembling.
- Review Gerber, drill, BOM, and pick-and-place outputs rather than assuming export success.

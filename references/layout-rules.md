# Baseline layout rules

## Placement priorities

- Mechanical constraints override cosmetic alignment.
- Protection belongs at the external energy entry point.
- Decoupling loop area matters more than matching a visual grid.
- Switch-mode regulator hot loops must be compact.
- Crystal traces must be short, symmetric where applicable, and isolated from switching nodes.
- Put connectors where orientation and mating access are unambiguous.

## Routing geometry

- Use horizontal, vertical, or 45-degree trace segments by default.
- A 90-degree route consists of two perpendicular segments; chamfer the corner where practical.
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
- Use stitching vias to join reference copper; a decorative via grid is not a substitute for a connected return path.

## Copper pours

- Create the pour after critical routing, then rebuild it after every later edit.
- Verify the generated fill primitive; a visible boundary alone is insufficient.
- Disable retained islands by default.
- Inspect thermal-relief current capacity and solderability.
- Check that the pour did not create narrow slivers, unintended antennas, or blocked clearances.

## DFM and assembly

- Use the selected fabricator's current minimum trace, spacing, drill, annular ring, mask dam, edge clearance, and copper-to-hole rules.
- Check silkscreen clipping and polarity visibility.
- Keep copper away from board edges and unplated slots according to the process rule.
- Verify fiducials, tooling needs, panel breakaway zones, and component-to-edge clearance when assembling.
- Review Gerber, drill, BOM, and pick-and-place outputs rather than assuming export success.

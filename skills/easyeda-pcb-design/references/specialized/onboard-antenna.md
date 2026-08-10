# Onboard antenna design layer

## Contents

- Scope and precedence
- Classify the implementation first
- Mandatory module-orientation closure
- Required constraint record
- Floorplan feasibility and usability claims
- Placement and keepout
- Feed and matching
- Copper, mechanics, and production controls
- Verification and exit gates

## Scope and precedence

Apply this layer whenever the product contains either:

- a radio module with an integrated PCB antenna; or
- a PCB-trace antenna implemented directly on the host board.

An antenna is a board-and-product structure, not an isolated copper shape. The
ground/counterpoise, board outline, stackup, nearby copper, enclosure, battery,
cables, mounting hardware, and user all affect its behavior.

Use the exact radio/module datasheet, hardware-design guide, antenna reference
design, and released Gerber/CAD files as the primary rules. Those sources
override generic advice in this document. Do not infer dimensions from a
screenshot, reuse a similar-frequency antenna without its reference layout, or
silently scale, mirror, rotate, or reshape a released antenna.

## Classify the implementation first

### Module with an integrated PCB antenna

Treat the antenna geometry inside the module as fixed. The host-board task is
to preserve the module vendor's placement, board-edge, ground, and keepout
environment. Among vendor-approved arrangements, prefer keeping the complete
module envelope within the host board's external dimensions and reproducing
the approved physical board cutout beneath the antenna region. Use an overhang
only when the exact module guide requires it or no approved in-outline cutout
arrangement can close the RF, mechanical, and assembly gates.

Do not copy a clearance number from a different module family. Transfer the
exact antenna keepout polygon and dimensions from the selected module revision.
The module's host-board RF performance still requires product-level
verification even when the internal antenna is pre-tuned or the module has
regulatory approvals.

#### Default placement habits

Apply this sequence unless the exact module guide requires a different one:

1. Rotate the module so its antenna end faces outward, toward the nearest
   product/PCB edge rather than toward the board interior.
2. Prefer keeping the entire module, including its antenna, within the board's
   external bounding dimensions. Put the antenna end at the board edge and
   reproduce the vendor-approved physical board cutout beneath the antenna
   region exactly, while keeping the module body and ground pads supported as
   required by the land pattern.
3. Use antenna overhang only when the exact module guide requires it or the
   approved in-outline cutout cannot satisfy RF, support, assembly, enclosure,
   or fabrication constraints. Record the resulting increase in the product's
   maximum PCB/module envelope before accepting the floorplan. Do not place the
   module in the board center merely because a local void can be drawn around it.
4. Distinguish **all-layer copper clearance** from a **physical PCB cutout**:
   copper clearance leaves the laminate in place but excludes pours, tracks,
   pads, and vias on every specified copper layer; a physical cutout removes
   the host-board laminate with an outline/slot operation. They are not
   interchangeable. Never add a physical cutout unless the module guide or an
   approved RF design calls for it.
5. Keep components, mounting hardware, panel tabs, shields, batteries,
   displays, connectors, and cables out of the specified three-dimensional
   antenna clearance, not only out of the top-layer courtyard. Avoid orienting
   the antenna directly toward a cable bundle or a metal enclosure wall.
6. Preserve the vendor's ground copper and stitching on the grounded/module
   side of the antenna boundary. Do not extend that ground underneath the
   radiating section, but also do not remove reference ground or add a via fence
   around the antenna unless the reference layout shows it.

In EasyEDA, make the copper/routing keepout, component keepout, and any board
cutout separate, dimensioned objects. Label each with the module part number,
reference-document revision, affected layers, and whether the laminate remains.

## Mandatory module-orientation closure

For a module with an integrated antenna, prove the antenna direction before
placement is accepted or the antenna planning gate can clear. A keepout drawn outside
the board is not direction evidence: it can be attached to the wrong end of a
correctly dimensioned footprint.

Build and retain this direction chain from the exact module revision:

1. Record whether each vendor drawing is a top view or bottom view. Never map a
   bottom-view land pattern directly onto a top-view PCB without applying the
   required mirror transform.
2. Identify Pin 1, the complete antenna-side pad row or asymmetric pad group,
   and at least one body-side control pad group in the official pin-layout or
   land-pattern drawing. Do not infer the antenna end from a generic module
   outline, shield can, silkscreen text, courtyard, or an existing keepout.
3. Read back those numbered pad centers from the actual EasyEDA footprint at
   its current layer, rotation, and mirror state. Use the numbered pads to
   derive the vendor-drawing-to-board transform and transform the official
   antenna polygon or antenna outward vector into board coordinates.
4. Read the exact nearby board-edge segment and determine its outward normal.
   The transformed antenna vector must point outward across that edge, or the
   placement must match a separately documented vendor-approved in-board
   alternative. Merely being closer to an edge is not sufficient.
5. Independently verify a body-side control group lies on the opposite side of
   the module. If the antenna-side and control-side checks disagree, mark the
   orientation `ORIENTATION_VIOLATION` and stop placement, routing, copper, and
   release work.
6. After every module rotation, move, layer/mirror change, footprint
   replacement, board-outline edit, keepout edit, or copper rebuild, repeat the
   numbered-pad readback and transformed-polygon check before relying on prior
   antenna evidence.

An `ORIENTATION_CLEARED` evidence record must bind the exact reference and
revision, drawing
view convention, module and footprint IDs, layer/rotation/mirror state, Pin 1
coordinate, antenna-side pad numbers and coordinates, body-side control pad
numbers and coordinates, board-edge segment and outward normal, transformed
antenna vector/polygon, and per-layer keepout/intrusion results. If the
footprint lacks enough numbered or asymmetric geometry to close this mapping,
the result is `UNVERIFIED`, never an inferred orientation clearance.

For an ESP32-C3-MINI-1 specifically, for example, the official top-view
pin-layout and land-pattern drawings place the antenna area beyond the Pins
36–48 row, while Pins 12–24 form the opposite control row. This example is a
mapping illustration only; always bind the check to the selected module's
exact current documentation rather than reusing these pin numbers for another
module.

### PCB-trace antenna on the host board

Treat the antenna element, feed, matching network, board ground/counterpoise,
stackup, and board outline as one RF design. Start from a released reference
design for the exact band and compatible feed topology. Record every deviation.

Changing antenna dimensions, copper thickness, dielectric, solder mask,
distance to ground, ground-plane size, board outline, feed point, or enclosure
invalidates a copied tuning result. A materially changed antenna is a custom RF
design and requires EM simulation plus prototype measurement/tuning.

Chip antennas, flex antennas, and external coaxial antennas are not PCB-trace
antennas. Follow their own component/vendor integration guides, while retaining
the applicable feed, matching, product-clearance, and verification gates below.

## Required constraint record

Record these items before placement:

- radio IC/module orderable part, package/module revision, and antenna type;
- operating bands, channels, bandwidth, maximum conducted power, and required
  product orientations;
- exact vendor/reference-design documents and revision-controlled CAD/Gerber
  artifacts;
- stackup, finished copper, dielectric height and Dk, solder-mask assumption,
  board thickness, and fabricator;
- antenna geometry, feed point, target feed impedance and tolerance, matching
  topology, and ground/counterpoise dimensions;
- separate 2D keepout polygons for copper, tracks/vias, components, and board
  mechanics, including the layers to which each polygon applies;
- selected in-outline cutout or overhang arrangement, the board's external
  bounding dimensions, exact cutout geometry when applicable, and the source
  that approves the construction;
- enclosure, display, battery, shield, cable, connector, screw, heatsink, and
  expected hand/body proximity;
- simulation, VNA, OTA/throughput/range, and regulatory verification plans.

Unknown geometry or environment is an unresolved RF constraint, not permission
to use a generic default.

## Floorplan feasibility and usability claims

When this antenna layer feeds the baseline placement-feasibility gate, use two
separate conclusions:

1. Set antenna planning to `CLEARED_FOR_PLACEMENT` only when the exact
   vendor-approved placement, direction mapping, in-outline cutout or overhang,
   keepouts, ground/counterpoise, and product clearance all fit. Only then may
   the overall placement be **FEASIBLE — FOLLOW**.
2. Set it to `BLOCKED` when the requested board outline,
   module position, connector/control location, enclosure, battery, cable, or
   nearby metal prevents any approved integration. Name the conflict and
   propose a board, module, orientation, or enclosure revision.
3. Keep it **UNRESOLVED** when the exact module guide, footprint mapping,
   enclosure, or nearby-object geometry is missing.

For a board explicitly scoped as a bare-board prototype with no supplied
enclosure or nearby product geometry, distinguish missing product evidence from
the PCB integration gate: exact module/orientation/edge/keepout/counterpoise
geometry may be `CLEARED_FOR_PLACEMENT`, while `productGeometryStatus` remains
`NOT_SUPPLIED` and RF performance remains
`UNVERIFIED_PENDING_PROTOTYPE_TEST`. This exception is invalid if an enclosure,
battery, display, cable, fastener, shield, or other nearby object is specified or
known; then its geometry is a placement input and absence is `UNRESOLVED`.

Preserve a machine-readable antenna-integration record containing the exact
project/PCB revision, module MPN and source revision, footprint layer/rotation/
mirror, numbered-pad direction evidence, transformed antenna polygon/vector,
selected board-edge segment and outward normal, every layer's copper/route/via
keepout result, component keepout result, product scope/status above, planning
status, performance status, invalidation triggers, and evidence paths. Bind that
artifact through `placementFeasibility.specializedGates.onboardAntenna.constraintRecord`.
Free-form screenshots or a visible courtyard cannot close these fields.

An integration-feasible floorplan does not prove that the antenna will work
normally in the final product. Report RF performance as `UNVERIFIED` until the
assembled prototype in its representative enclosure passes the verification
and exit gates below. Never convert clean DRC, correct keepouts, module
certification, or acceptable S11 alone into a range, efficiency, coexistence,
or regulatory claim.

## Placement and keepout

1. During the joint outline/stackup/floorplan gate, iterate the board outline,
   antenna location/orientation, antenna keepout, module position, and intended
   ground/counterpoise as one candidate. Freeze them together only when both
   antenna integration and the aggregate placement gate clear.
2. Put the antenna at the intended product boundary and orientation. For an
   integrated module, face the antenna end outward and prefer the vendor-approved
   in-outline physical cutout that keeps the complete module within the board's
   external dimensions. Use overhang only under the exception above. Do not put
   the module in the board center or improvise a slot.
3. Implement the exact vendor/reference keepout on every specified copper
   layer. Unless the exact reference explicitly permits an object, keep copper
   pours, tracks, vias, pads, components, test points, fiducials, shields,
   fasteners, cables, and metal enclosure features out of the antenna volume.
4. Create separate EasyEDA keepouts for copper/routing and components when one
   object cannot express both restrictions. Dimension and label them with the
   source document and revision; lock them against accidental movement.
5. Keep switch nodes, crystals/clocks, fast digital interfaces, USB/UART
   connectors and cables, DC/DC inductors, displays, batteries, and large metal
   objects outside the vendor-defined antenna clearance and as far away as the
   product permits.
6. Preserve the reference design's ground edge and counterpoise. Do not pour
   copper under a radiating element merely to make the ground plane look
   continuous, and do not remove nearby ground that the reference antenna uses.
7. Model the three-dimensional product clearance, not just the PCB polygon.
   Plastic, coating, labels, nearby boards, the enclosure, a hand, and a cable
   can detune or shadow the antenna.

After every placement, outline, layer, or copper change, read back the actual
keepout geometry and inspect every layer. A visible note or courtyard alone is
not an enforceable antenna keepout.

## Feed and matching

1. Preserve the radio vendor's balun/filter/matching topology and placement.
   Put the reserved tuning network at the antenna feed, with short pads and no
   branch. A populated value copied from another board is an initial state, not
   measured tuning evidence.
2. Route a single-ended RF feed to its specified impedance, commonly 50 ohms
   only when the radio/reference design says so. Finalize its width, gap, and
   reference plane from the actual fabricator stackup and solver output.
3. Keep the feed short, constant-geometry, unbranched, and continuously
   referenced. Prefer one outer layer without vias. If a transition is
   unavoidable, model/review the signal via, antipads, reference transition,
   and close return vias as one launch.
4. Avoid test-point stubs. Provide a documented measurement/de-embedding
   structure when conducted RF or VNA access is required; the access structure
   must not remain as an uncontrolled production stub.
5. Use smooth arcs or chamfered bends and keep nearby ground/via fences
   symmetric to the feed where the selected grounded-coplanar reference design
   requires them. Copy the reference geometry; do not add decorative stitching
   close to the radiating element.
6. Keep other signals and plane voids away from the RF feed and its return
   corridor. A ground pour boundary is not proof that a valid high-frequency
   return path exists.

A host-board RF feed or custom PCB antenna uses the controlled/high-speed path
in this skill and is `HIGH_RISK_SI`. A module whose integrated antenna has no
host RF feed still needs this antenna layer, but does not become high-risk SI
solely because RF exists inside the module.

## Copper, mechanics, and production controls

- Rebuild every pour after antenna or keepout edits and verify that generated
  fill, not only the pour outline, stays out of all antenna exclusion regions.
- Check solder mask, surface finish, copper etch tolerance, board thickness,
  material/Dk tolerance, panel rails, breakaway tabs, tooling holes, and
  assembly fixtures against the antenna reference. Do not put a panel tab or
  temporary copper feature in the antenna area without RF review.
- Keep the selected board house, stackup, copper weight, and antenna geometry
  revision controlled. A fabrication substitution can invalidate tuning.
- Preserve practical access to matching parts and the planned RF measurement
  interface for prototype tuning.
- A certified radio module does not automatically authorize every host-board
  layout, antenna configuration, enclosure, output power, or market. Record the
  exact module integration conditions and obtain human compliance review for
  the destination regions.

## Verification and exit gates

Before treating antenna design as closed, require:

1. the exact antenna/module reference and revision-controlled layout artifact;
2. dimensional comparison of antenna, feed, ground/counterpoise, board edge,
   and every keepout against that reference;
3. per-layer readback showing no forbidden copper, routing, via, component, or
   mechanical intrusion;
4. stackup/impedance evidence for any host-board RF feed;
5. EM simulation for a custom or materially modified PCB antenna and its actual
   board/enclosure environment;
6. calibrated VNA evidence at the intended reference plane on assembled
   prototypes, tuned in the representative final enclosure;
7. product-level OTA, throughput/range, sensitivity, and orientation testing
   appropriate to the radio and use case; and
8. regional regulatory/integrator review for the final antenna, enclosure,
   power, firmware, and product configuration.

EasyEDA DRC, a 50-ohm feed calculation, or acceptable S11 alone does not prove
radiation efficiency, TRP/TIS, coexistence, range, EMC, or regulatory
compliance. Any later change to antenna geometry, keepout, board outline,
stackup, ground plane, feed/matching parts, enclosure, battery, display, cable,
or nearby metal invalidates the affected evidence and triggers RF re-review.

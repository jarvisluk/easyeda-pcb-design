# Layout and assembly constraint planning

## Contents

- Convert heuristics into governed constraints
- Reconcile user placement requirements
- Run the joint outline/stackup/floorplan gate
- Reconcile cross-constraint conflicts
- Freeze the aggregate PCB entry gate
- Layer strategy
- Routing geometry
- Assembly geometry
- Human-operated controls
- External interfaces
- Evidence and change control

## Convert heuristics into governed constraints

Treat remembered rules, reference-layout observations, forum advice, and quick
formulas as candidate heuristics until their scope and authority are recorded.
For every heuristic that can change placement, routing, stackup, fabrication,
assembly, safety, or verification, capture this contract:

1. **Trigger and scope** — interface, topology, package, process, frequency or
   edge-rate range, environment, and design phase where it applies.
2. **Source and revision** — current specification, datasheet, reference design,
   fabricator/assembler rule, analysis, experiment, or explicitly labeled local
   planning assumption.
3. **Required inputs** — values, units, tolerances, measurement definitions, and
   unknowns. Reject silent defaults and dimensionless copied numbers.
4. **Action** — the exact constraint or design operation to apply.
5. **Expected effect** — the failure mode reduced and the predicted direction or
   approximate range of the result.
6. **Tradeoffs** — cost, density, thermal, loss, manufacturability, service, or
   another constraint that may worsen.
7. **Invalidation conditions** — changes in silicon, package, stackup, geometry,
   process, topology, load, firmware mode, or environment that require review.
8. **Escalation and evidence** — when the heuristic must give way to a vendor
   model, calculation, field/S-parameter/PDN/thermal simulation, prototype, or
   measurement, and which artifact closes the gate.

Convert enforceable actions into EasyEDA rules, net classes, keepouts, layer
permissions, or machine-readable project records. Keep qualitative manual-review
items in the same revision-controlled record. A heuristic result never becomes
fabrication evidence merely because it was encoded as a DRC rule.

## Reconcile user placement requirements

Before ordinary placement, convert every explicit user request for board size,
shape, component location, edge, orientation, or access into a hard candidate
constraint and test it. Use this floorplan priority:

1. Determine a provisional board outline, mounting holes, enclosure/panel
   interfaces, forbidden regions, edge clearances, and height limits. If the
   user specifies the outline, preserve it as a candidate until the joint gate
   below proves that it fits.
2. Fix user-specified and mechanically constrained interfaces: pin headers,
   USB and other connectors, switches/buttons, displays/indicators, cable exits,
   and parts that must align to an opening or mating feature.
3. Place core modules and major ICs. Preserve antenna edge/orientation/keepouts,
   module access, thermal space, escape direction, and direct paths to the fixed
   interfaces. A module with a mechanically fixed interface belongs in step 2.
   For a module with an integrated antenna, apply
   [onboard-antenna.md](../specialized/onboard-antenna.md) before accepting its position.
4. Place the protection, power, clock, termination, matching, sensing, and
   decoupling parts that must remain near those anchors or form compact loops.
5. Partition and place the remaining functional blocks; optimize ordinary
   passives and cosmetic alignment only after higher-priority constraints hold.

Do not judge fit from summed component area. Use exact verified footprints and
body/courtyard envelopes, then include holes, edge and antenna keepouts,
connector mating space, switch actuation space, assembly/rework spacing,
thermal needs, and credible escape/routing corridors for a candidate stackup
and process. A rough floorplan may screen candidates; freeze only a placement
study whose geometry and assumptions are recorded and jointly closed with the
stackup decision.

Treat antenna integration as a separate specialized gate. A module with an
integrated antenna can contribute to **FEASIBLE — FOLLOW** only when the exact
vendor-approved edge/overhang or cutout arrangement, numbered-pad orientation,
per-layer keepouts, ground/counterpoise, and three-dimensional product clearance
all fit the proposed board and enclosure. This proves only that the planned
integration is geometrically compatible. Keep RF performance `UNVERIFIED`
until assembled prototypes pass the VNA and product-level OTA,
throughput/range, sensitivity, and orientation tests required by
[onboard-antenna.md](../specialized/onboard-antenna.md).

Classify each explicit user requirement as:

- **FEASIBLE — FOLLOW** when the placement study satisfies every applicable
  hard constraint. Preserve the requested dimension, location, and orientation.
- **INFEASIBLE — PROPOSE REVISION** when a verified envelope overlaps or a
  required access, keepout, thermal, or routing corridor cannot be preserved.
  Name the colliding constraints and propose the smallest useful alternatives,
  such as enlarging/reshaping the board, moving or rotating an interface,
  selecting a smaller verified part, or revising the stackup/process.
- **UNRESOLVED** when missing footprint, enclosure, clearance, or interface data
  could change the verdict. State the missing evidence and stop before freezing
  the affected geometry.
- **STALE** when a later outline, footprint, placement, stackup, process,
  enclosure, keepout, or interface change invalidates the earlier study. Stop
  affected work and rerun the joint gate.

Do not silently relax or override an explicit user requirement. When resolving
an infeasible request would materially change the product mechanics, present
the tradeoff and obtain the user's choice before implementation.

## Run the joint outline/stackup/floorplan gate

Board outline, stackup, and floorplan are mutually dependent. Do not freeze any
one of them while another remains provisional. Iterate this sequence:

1. build a provisional outline from the product mechanics and user requests;
2. generate candidate stackups from required layer functions and process;
3. place the fixed interfaces, core modules, critical loops, keepouts, thermal
   regions, via fields, and reserved corridors against each viable candidate;
4. prove representative escape, route, return-path, power, antenna, access,
   and assembly canaries using exact footprints and candidate design rules;
5. revise the outline, placement, stackup, process, or requirement disposition
   when any canary fails, then repeat the affected proofs;
6. freeze the outline, stackup, and floorplan together only after one candidate
   closes every applicable gate.

Use `PROVISIONAL` in working artifacts during the loop. The final constraint
record uses the aggregate states below; a provisional outline or conditional
stackup derives `UNRESOLVED`, never `CLEARED_FOR_PLACEMENT`.

## Reconcile cross-constraint conflicts

Before closing the joint gate, build a resource-conflict ledger. A resource is
anything two requirements can compete for, including a board edge, corridor,
reference plane, via field, quiet region, thermal area, enclosure opening,
operator approach, or assembly/rework volume.

For every collision, record the participating constraints, source/authority,
affected resource, disposition, evidence, and invalidation triggers. Apply
these rules:

- safety, mandatory process limits, exact component/vendor integration rules,
  and physical mating/access constraints are non-negotiable;
- a more specific applicable rule overrides a generic heuristic, but its scope
  must be recorded; for example, an exact antenna exclusion overrides generic
  board-edge ground stitching inside that exclusion;
- user requirements are followed when all mandatory gates close; an infeasible
  request receives the smallest useful revision proposal rather than a silent
  relaxation;
- cost, cosmetic alignment, passive grouping, and routing convenience cannot
  cancel a mandatory electrical, thermal, RF, mechanical, or manufacturing
  gate;
- coupled tradeoffs pass only when every affected domain has its own acceptance
  evidence. A note saying a balance was chosen is not closure.

Every conflict is `RESOLVED`, `BLOCKED`, `UNRESOLVED`, or `STALE`. Any state
other than `RESOLVED` propagates to the aggregate entry gate. A later change to
either participating constraint or the shared resource makes the resolution
`STALE` and reopens the gate.

## Freeze the aggregate PCB entry gate

Create a revision-controlled project constraint record before placing ordinary
components. Do not route from an unwritten convention. The brief may supply the
values, but the record must make them machine- or review-checkable.

At minimum freeze together:

- board dimensions/shape, holes, enclosure/panel interfaces, keepouts, edge and
  height limits, plus the artifact that proves the required population fits;
- each explicit user placement requirement, its source, feasibility status,
  conflicts, and accepted disposition;
- the layer-count decision, candidate comparison, decisive constraints,
  assumptions, and canary/evidence gates required by
  [stackup-planning.md](stackup-planning.md);
- board layer count, exact layer names, copper/plane roles, and intended adjacent
  reference for every signal layer;
- which routing layers are primary, limited, reference-only, or forbidden;
- allowed segment directions and hard-corner policy;
- fabricator and assembler rule sources with revision/date;
- silkscreen-to-mask/pad clearance, component-spacing source, courtyard/body
  policy, board-edge and rework requirements;
- each button, switch, encoder, or other operator control's actuation type and
  direction, operator approach, travel, access envelope, enclosure opening,
  and applied-force support;
- connector, protection, termination, transceiver/module placement chain;
- per-interface route-length, stub, skew, impedance, layer, via, and return-path
  limits, or a sourced reason that a limit is not applicable.

An unknown value is an unresolved constraint, not permission to use a generic
number. Stop before placement when it can change board outline, layer count,
connector/module location, antenna keepout, or routing corridors.

Store the baseline record as `layout-constraints.json` in the project evidence
tree. A minimal record has this shape; replace every example value and source:

```json
{
  "revision": "pcb-revision-or-fingerprint",
  "pcbEntryGate": {
    "status": "UNRESOLVED"
  },
  "process": {
    "fabricator": "selected fabricator",
    "assembler": "selected assembler",
    "sourcesCheckedOn": "YYYY-MM-DD"
  },
  "placementFeasibility": {
    "status": "UNRESOLVED",
    "requestedOutline": "dimensions/shape and source",
    "fixedItems": [
      {
        "reference": "J1",
        "role": "USB connector",
        "constraint": "edge/orientation/access envelope",
        "source": "user brief + part/enclosure evidence"
      }
    ],
    "proofArtifact": "revision-controlled floorplan or clearance-study path",
    "conflicts": [],
    "disposition": "UNRESOLVED",
    "specializedGates": {
      "onboardAntenna": {
        "applicable": true,
        "constraintRecord": "revision-controlled antenna constraint path",
        "planningStatus": "UNRESOLVED",
        "performanceStatus": "UNVERIFIED_PENDING_PROTOTYPE_TEST"
      }
    }
  },
  "layerCountDecision": {
    "status": "UNRESOLVED",
    "recommendedLayerCount": null,
    "provisionalRange": null,
    "candidateComparisonArtifact": "revision-controlled relative path",
    "decisiveConstraints": ["requirement that sets the layer-count floor"],
    "assumptions": ["labeled assumption or unknown"],
    "requiredCanaries": ["specific escape, route, power, or return-path proof"],
    "invalidatedBy": ["outline", "package", "interface", "process"]
  },
  "crossConstraintConflicts": [
    {
      "id": "unique-conflict-id",
      "resources": ["shared board edge, corridor, plane, region, or volume"],
      "constraints": ["first sourced constraint", "second sourced constraint"],
      "status": "UNRESOLVED",
      "resolution": null,
      "evidenceArtifact": null,
      "invalidatedBy": ["change that reopens this resolution"]
    }
  ],
  "heuristics": [
    {
      "name": "project-specific planning rule",
      "scope": "exact interface, topology, process, and design phase",
      "source": "authoritative document/revision or LABELED_ASSUMPTION",
      "action": "machine-checkable constraint or manual-review item",
      "expectedEffect": "predicted failure-mode reduction",
      "tradeoffs": ["density", "cost"],
      "invalidatedBy": ["stackup", "package", "process"],
      "escalation": "calculation, solver, prototype, or measurement gate"
    }
  ],
  "layers": [
    {"name": "Top Layer", "role": "primary-signal", "reference": "Bottom Layer:GND"},
    {"name": "Bottom Layer", "role": "reference-and-limited-signal", "netAllowList": []}
  ],
  "routingGeometry": {
    "allowedAnglesDeg": [0, 45, 90, 135],
    "hardRightAngleJunctions": "PROHIBITED_EXCEPT_PAD_OR_VIA"
  },
  "assembly": {
    "silkscreenToMaskOrPadMm": 0.15,
    "silkscreenRuleSource": "fabricator capability URL and revision/date",
    "bodyToOwnPadPolicy": "EXACT_LAND_PATTERN_AND_FILLET_REVIEW",
    "componentSpacingSource": "assembler package-pair table and revision/date",
    "courtyardSource": "verified footprint or documented constructed courtyard"
  },
  "humanInterfaces": [
    {
      "reference": "SW1",
      "actuation": "top-press",
      "approachDirection": "normal-to-board",
      "accessEnvelopeSource": "part datasheet + enclosure CAD + operator/tool requirement"
    }
  ],
  "interfaces": [
    {"name": "USB2", "constraintRecord": "high-speed-constraints.json"}
  ]
}
```

The four aggregate states have exact meanings:

- `BLOCKED`: placement or layer strategy is infeasible, a specialized gate is
  blocked, a cross-constraint conflict is blocked, or the record is internally
  contradictory;
- `STALE`: previously valid child evidence was invalidated by a design or
  process change;
- `UNRESOLVED`: placement, layer selection, a specialized planning gate, or a
  cross-constraint conflict remains conditional or unresolved;
- `CLEARED_FOR_PLACEMENT`: placement is `FEASIBLE`/`FOLLOW` with an existing
  proof artifact, the layer decision is `SELECTABLE` with its candidate
  artifact, every applicable specialized planning gate is cleared with its
  constraint artifact, and every cross-constraint conflict is resolved with
  evidence.

Keep the `onboardAntenna` specialized-gate object in every record. When the
board has no integrated module antenna or host-board antenna, set both
`applicable: false` and its planning/performance states to `NOT_APPLICABLE`;
never omit the gate and let absence masquerade as clearance.

Run the deterministic consistency check before ordinary placement and after
every invalidating change:

```bash
python3 scripts/easyeda_constraint_lint.py \
  --record path/to/layout-constraints.json \
  --output path/to/evidence/audits/constraint-consistency.json
```

The checker verifies child-state/disposition mappings, evidence-path existence,
specialized-gate applicability, conflict closure, and the derived aggregate
state, and fingerprints the exact input record into its report. Exit code 0
means only `CLEARED_FOR_PLACEMENT`; it never authorizes
fabrication. Antenna performance may remain
`UNVERIFIED_PENDING_PROTOTYPE_TEST` without blocking geometric placement, but
the report preserves it as missing release evidence. The output path is
write-once; use a new revision-specific path rather than overwriting prior
evidence.

Do not copy `0.15 mm` to another process without checking its current rule. Do
not add a global body-to-own-pad distance: the record deliberately requires a
land-pattern/fillet review instead.

For controlled/high-speed interfaces, the referenced file must use the
authoritative placement-chain and `channelPaths` schema in
[high-speed-constraints.md](../high-speed/high-speed-constraints.md); do not duplicate or
weaken that record in `layout-constraints.json`. A baseline-only external
interface still needs a sourced placement/route disposition in this record.

## Layer strategy

Write one row per copper layer with its exact EasyEDA name and role. For a
two-layer top-assembly board, use top as the default component/signal side and
preserve bottom as the broad GND reference where practical. For multilayer
boards, choose each signal layer from its adjacent continuous reference; do not
assign a plane layer to ordinary routing merely because space is available.

Set quantitative limits when a role says “limited,” such as maximum routed
length share or an explicit net allow-list. Compare the final audit's
`routingLayerUsage` against this plan. Any undeclared routed layer, forbidden
layer use, or exceeded limit is a review failure. A copper pour does not satisfy
a declared plane role until its filled geometry and continuity are reviewed.

## Routing geometry

Default to 0/45/90-degree segment directions and prohibit a hard 90-degree
junction outside a pad/via. Encode any exception by exact network and reason.
Run the baseline geometry audit immediately after each routed class, not only at
the end, so arbitrary slopes and hard corners do not multiply.

## Assembly geometry

Keep these separate:

1. copper pad and solder-mask opening;
2. paste aperture and terminal/lead land pattern;
3. silkscreen legend;
4. assembly/body outline and height;
5. courtyard and package-pair spacing;
6. enclosure, tool, inspection, hand-solder, and rework access.

Never use silkscreen as the component's maximum body or courtyard. Never apply
one clearance between a component and its own pads: many valid packages
intentionally overlap terminal/body geometry. Use the exact orderable part's
land pattern and the assembler's current package-pair spacing table.

Record the selected fabricator's current silkscreen-to-pad or solder-mask rule.
For JLCPCB, 0.15 mm is the current planning floor, but the order-time capability
and final Gerber remain authoritative. Require 2D/3D body/courtyard review and
Gerber legend/mask review; API metadata or clean DRC alone cannot close them.

## Human-operated controls

Treat every button, slide/toggle/rocker switch, encoder, potentiometer, and
similar control as a mechanical interface, not an ordinary component:

1. classify its motion and user approach as top-press, side-actuated,
   vertical toggle/rotation, or the exact mechanism in its datasheet;
2. define a sourced three-dimensional access and motion envelope covering the
   finger, tool, cap/knob, full travel, enclosure opening, and relevant cable or
   cover state; do not invent a universal clearance;
3. place and orient the control so its actuation direction matches the board
   edge, panel, enclosure opening, and intended installed orientation;
4. keep tall components, connectors, cables, heatsinks, shields, and enclosure
   walls outside that envelope. Orient nearby parts so bodies and leads do not
   block the approach or travel, and keep hot, sharp, or fragile parts away;
5. keep designators, ON/OFF or mode legends, and state indication readable from
   the operator's viewing direction;
6. provide board support appropriate to the actuation force and cycle count so
   normal use does not flex the PCB, damage solder joints, or shift the control.

Verify the complete interaction in 3D from the user's approach direction with
the enclosure, knobs/caps, connectors, and representative cables installed.

## External interfaces

Fix mechanical connectors first. Place ESD/protection at the entry, then any
common-mode/filter parts, then series termination where the silicon source
requires it, and finally the transceiver/module. Minimize the complete routed
channel without weakening the entry-side protection path or antenna/mechanical
constraints.

For each point-to-point controlled/high-speed interface, list every sequential
net segment for each conductor in `channelPaths`, with a sourced maximum routed
length. If no maximum applies, record `routeLengthNotConstrained` with a source
and reason. Impedance alone never closes length, return, discontinuity, loss,
launch, or protection requirements.

## Evidence and change control

Bind the constraint record and every audit to the exact PCB fingerprint. A
change to outline, placement, footprint, layer role, routing, via, copper,
connector, protection, or assembly process invalidates affected evidence.
Mark every affected child state and the aggregate gate `STALE`, rerun the joint
gate and the consistency checker, then replace the aggregate status with the
newly derived result.
Missing layer, assembly, placement, or channel constraints remain
`UNVERIFIED FOR FABRICATION`; observed violations are `FAIL`.

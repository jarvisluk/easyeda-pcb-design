# Placement and assembly closure

## Contents

- Purpose and lifecycle position
- Evidence authority
- Constraint-record contract
- Via and pad geometry
- Pad-complete component occupancy
- Component courtyards and critical zones
- Human controls
- External interfaces and BOM normalization
- Run the placement gate
- Interpret results
- Invalidation and final review

## Purpose and lifecycle position

Use this gate after the function-critical and ordinary placement is complete,
but before production routing. `CLEARED_FOR_PLACEMENT` authorizes placement to
begin; it does not prove the resulting placement. Require the separate status
`PLACEMENT_CLEAR_FOR_ROUTING` before routing.

Run the same gate again after any component, footprint, via, process, enclosure,
access, connector, or interface-policy change. A previously clear report bound
to another PCB fingerprint is `STALE`.

The placement gate is mandatory for baseline PCB closure. A missing, stale, or
unresolved placement report keeps a final baseline audit `UNVERIFIED FOR
FABRICATION`. A current report with observed violations makes the PCB review
`FAIL`. Neither state authorizes fabrication or ordering.

Formal review accepts only placement-report schema 2, which contains own-pad
courtyard containment, foreign pad overlap/clearance, pad/foreign-courtyard,
opposite-side courtyard, maximum-padstack-projection, unsupported-pad, and
unsupported-via and dual-identity pad-owner results. It recomputes the result from every blocking,
unresolved, and stale array and verifies the constraint revision, fingerprint,
and `CLEARED_FOR_PLACEMENT` consistency gate; it does not trust the top-level
status alone. A legacy or incomplete schema 2 report remains unverified; rerun
it against the exact revision.

## Evidence authority

Keep these evidence classes separate:

1. A copper pad shape and via circle/drill returned by the live EasyEDA API can
   support deterministic two-dimensional pad/via clearance checks.
2. An EasyEDA component BBox can include pads, silkscreen, attributes, or other
   footprint graphics. Use it only as a broad collision screen.
3. A component courtyard can support a blocking collision decision only when
   its geometry and land-pattern/assembly source are recorded in
   `assemblyEnvelopes`. The courtyard must contain every live pad belonging to
   that component; a body-only outline is insufficient.
4. Finger/tool travel, enclosure, cable, solder-fillet, paste, height, and
   rework claims require their own sourced evidence. A two-dimensional script
   cannot infer them.

Never promote a BBox hit to a proven body collision. Never clear a BBox hit
without sourced envelope coverage for both components. Do not use silkscreen as
the body or courtyard.

## Constraint-record contract

Keep the following fields in the exact-revision `layout-constraints.json`.
`easyeda_constraint_lint.py` validates their schema before placement begins,
and `easyeda_placement_audit.mjs` binds them to the saved/reopened PCB.

```json
{
  "revision": "sha256:exact-design-fingerprint",
  "routingGeometry": {
    "allowedAnglesDeg": [0, 45, 90, 135],
    "hardRightAngleJunctions": "PROHIBITED_EXCEPT_PAD_OR_VIA",
    "standardVia": {
      "outerDiameterMm": 0.61,
      "holeDiameterMm": 0.30,
      "viaToPadCopperClearanceMm": 0.15,
      "clearanceMeasurement": "COPPER_EDGE_TO_COPPER_EDGE",
      "ruleSource": "fabricator rule, revision and checked date"
    }
  },
  "assembly": {
    "silkscreenToMaskOrPadMm": 0.15,
    "silkscreenRuleSource": "fabricator rule and revision",
    "bodyToOwnPadPolicy": "EXACT_LAND_PATTERN_AND_FILLET_REVIEW",
    "componentSpacingSource": "assembler package-pair table and revision",
    "courtyardSource": "verified land pattern plus sourced constructed courtyard",
    "ownPadCourtyardPolicy": "ALL_LIVE_PAD_COPPER_WITHIN_SOURCED_COURTYARD",
    "foreignPadOverlapPolicy": "CHECK_ALL_FOREIGN_PADS_AND_COURTYARDS",
    "foreignPadCopperClearanceMm": 0.15,
    "foreignPadCopperClearanceSource": "fabricator copper-spacing rule and revision"
  },
  "assemblyEnvelopes": [],
  "criticalPlacementZones": [],
  "specialViaConstructions": [],
  "humanInterfaceGroups": [],
  "externalInterfaces": [],
  "bomNormalizationPolicy": {
    "passives": {
      "preferredFootprintsByPrefix": {"R": ["R0603"], "C": ["C0603", "C0805"]},
      "exceptions": []
    },
    "connectors": {
      "requireAllJDesignators": true,
      "preferredManufacturerSeries": ["declared-series-prefix"],
      "exceptions": []
    }
  },
  "placementClosure": {
    "requiredBeforeRouting": true,
    "requiredStatus": "PLACEMENT_CLEAR_FOR_ROUTING"
  }
}
```

Use PCB units of mil only for live geometry and fields ending in `Mil`. Use
millimetres only for fields ending in `Mm`. Do not store dimensionless copied
clearances.

## Via and pad geometry

For every ordinary via, measure the minimum copper-edge distance to the complete
pad shape. Include same-net pads: a same-net DRC exemption does not prove
solderability. Report both annular-ring and drill-edge intrusion.
Each via must have a non-empty globally unique primitive ID, finite API x/y, positive copper
diameter, and non-negative finite hole diameter. Missing or coerced geometry is
unresolved, not a skipped check. Duplicate IDs make every affected via
unsupported so one special-process exception cannot authorize multiple live
objects.

Any intentional via/pad overlap requires one exact record:

```json
{
  "viaPrimitiveId": "exact-live-via-id",
  "padDesignator": "U1",
  "padNumber": "49",
  "construction": "FILLED_CAPPED_PLANARIZED",
  "processEvidenceArtifact": "evidence/calculations/u1-vippo-process.json"
}
```

Allow only `FILLED_CAPPED_PLANARIZED`, `MICROVIA_FILLED_CAPPED`, or
`DOCUMENTED_LAND_PATTERN_PROCESS`. Tenting, negative mask expansion, matching
net names, or a clean DRC is not special-process evidence. Exact via and pad IDs
prevent a broad exception from hiding unrelated violations.

## Pad-complete component occupancy

Do not equate a package body with the component's full board occupancy. Leads,
castellations, switch terminals, connector tails, thermal tabs, mounting pads,
and through-hole annular rings can extend well beyond the visible body.

For every supported live EasyEDA pad, the placement audit must:

1. bind the pad to its exact owning component;
2. transform its full copper shape, position, and rotation;
3. prove the pad is contained by that owner's sourced courtyard;
4. compare it against every foreign component courtyard on the applicable
   assembly side; and
5. compare it against every foreign live pad whose copper can exist on the same
   side. Treat a through-hole or multilayer pad as occupying both sides.

Supported live copper shapes are `RECT`/`RECTANGLE`, `ELLIPSE`/`CIRCLE`,
`OBLONG`, and `REGULAR_POLYGON`. `POLYGON` and
`POLYLINE_COMPLEX_POLYGON` pads remain unresolved because the current companion
contract does not prove whether their path coordinates/arcs are board-local or
pad-local; do not guess from coordinate magnitude. Any other or malformed shape
is unresolved. The script uses mil coordinates and a `1e-7 mil` comparison epsilon. Own-pad contact
with the exact courtyard boundary counts as contained; foreign geometry touching
at a boundary counts as a conflict. Ellipses use a 64-segment circumscribed
polygon and oblong ends use circumscribed 32-segment semicircles, so the
approximation expands rather than shrinks live copper.

Containment checks every pad vertex and every edge interval split at courtyard
boundary intersections. This prevents an edge between two apparently contained
vertices from crossing the open notch of a concave courtyard.

A pad extending outside its own courtyard means the recorded courtyard or live
footprint is wrong and is blocking. Foreign pad/pad overlap or a pad entering a
foreign courtyard is also blocking. Two foreign pads that do not touch but miss
the sourced `foreignPadCopperClearanceMm` are blocking as well, regardless of
net name or whether native DRC happens to report them. An unsupported pad shape
or unbound pad owner remains `UNRESOLVED`; never approximate it from the body or
silkscreen.

Owner binding must agree on both the live designator and
`parentComponentPrimitiveId`. A missing primitive owner or disagreement between
the two identities is unresolved; component designators, component primitive
IDs, and pad primitive IDs must also be non-empty and unique. Designator-only or
last-write-wins Map matching is not exact enough.
Live component and pad coordinates, rotations, and copper-side layer IDs must be
finite API numbers; never coerce `null`, booleans, empty strings, or missing
values to zero. Missing component geometry invalidates its envelope, and missing
pad geometry makes that pad unsupported.

The own-pad containment rule does not prohibit the component's body, lead, and
own pad from overlapping by design. It requires the outer courtyard to include
the complete land pattern, expected solder fillet, body tolerance, and sourced
assembly spacing.

The live comparison is copper-based. Solder-mask openings, paste apertures,
formed-lead volume, solder volume, plated-slot voids, and rework/tool volume are
not inferred from copper. Include their maximum required projection in the
sourced courtyard and preserve separate mask/paste/3D review; a clean 2D result
cannot waive those checks.

## Component courtyards and critical zones

Provide one sourced `assemblyEnvelopes` entry with `courtyard` geometry for
every placed component. Build it in this order: exact manufacturer-recommended
land pattern; maximum body/lead dimensions and tolerances; assembly-process
solder-fillet, mask/paste, placement-accuracy, and rework allowances; then the
applicable assembler package-pair spacing. Record each authority and revision.
When no authoritative value exists, keep the gate unresolved rather than
inventing a generic margin. Use a footprint-local rectangle with offset center
or an asymmetric polygon so the audit can transform it using the live component
position and rotation:

```json
{
  "designator": "U1",
  "source": "manufacturer land pattern plus assembler spacing rule, revisions and pages",
  "courtyard": {
    "type": "RECT",
    "widthMil": 560,
    "heightMil": 660,
    "centerXMil": 0,
    "centerYMil": 0,
    "rotationDeg": 0,
    "coordinates": "COMPONENT_LOCAL"
  }
}
```

If any live pad is through-hole or multilayer, also provide a sourced
`oppositeSideCourtyard` for solder tails, plastic, stakes, tabs, or other
opposite-side occupancy. It may differ from the owner-side courtyard:

```json
{
  "designator": "J1",
  "source": "connector drawing and assembly rule revisions",
  "courtyard": {
    "type": "RECT", "widthMil": 320, "heightMil": 180,
    "coordinates": "COMPONENT_LOCAL"
  },
  "oppositeSideCourtyard": {
    "type": "POLYGON",
    "pointsMil": [[-150, -70], [150, -70], [150, 110], [-150, 110]],
    "coordinates": "COMPONENT_LOCAL"
  },
  "padstackProjectionEvidence": [{
    "padNumber": "1",
    "policy": "MAXIMUM_COPPER_PROJECTION",
    "source": "connector padstack table, drawing revision and page"
  }]
}
```

Without this field, a through-hole component stays `UNRESOLVED` even though its
pad copper is conservatively checked on both sides. A non-symmetric per-layer
padstack must use the maximum copper projection as the live pad shape. Every
through-hole/multilayer pad number needs a matching sourced
`padstackProjectionEvidence` entry; otherwise placement stays unresolved. Do not
silently reuse a smaller layer shape. If the live API exposes a non-empty
per-layer `specialPad`, the current converter keeps it unresolved even with that
record; a future converter must flatten every layer shape and prove the maximum
projection before the gate may clear.

For a bottom-side component, `COMPONENT_LOCAL` courtyard geometry must declare
`"bottomSideTransform": "MIRROR_LOCAL_X_THEN_ROTATE"`; the audit mirrors local X
before applying the live component rotation and translation. Omission keeps the
envelope unresolved. Use `BOARD` coordinates instead when the geometry is
already expressed in board space, and do not add a bottom-side transform there.

Use `POLYGON` plus `pointsMil` for non-rectangular envelopes. `BOARD`
coordinates are permitted only for revision-bound absolute mechanical geometry.
Every sourced courtyard, opposite-side courtyard, and critical-zone polygon
must be a simple, non-zero-area polygon with finite numeric points, no zero-length
edge, and no non-adjacent edge crossing or overlap. Invalid geometry stays
unresolved and cannot be rescued by its top-level report status.
For `RECT`, omitted `centerXMil`, `centerYMil`, or `rotationDeg` means zero, but
an explicitly present value must be a finite number; strings, `null`, and
booleans are invalid. `POLYGON` points are already exact, so those three RECT
transform fields are prohibited on polygon geometry.

Reserve core-module escape and assembly space with
`criticalPlacementZones`. Identify the owner, purpose, source, exact geometry,
and the designators that are allowed inside it. Allow only parts that must be
close and have already passed representative fanout/routing canaries.
The owner and every allowed designator must match a unique `assemblyEnvelopes`
entry, and the audit must bind the owner to a live component even for absolute
`BOARD` geometry. A ghost owner or allowed part keeps the gate unresolved.

```json
{
  "id": "U1_LEFT_ESCAPE",
  "ownerDesignator": "U1",
  "purpose": "left pad-row fanout and rework access",
  "source": "exact footprint plus routing and assembly constraints",
  "allowedDesignators": ["C5", "C6", "R1", "C7"],
  "geometry": {
    "type": "RECT",
    "widthMil": 180,
    "heightMil": 500,
    "centerXMil": -360,
    "centerYMil": 0,
    "coordinates": "COMPONENT_LOCAL"
  }
}
```

An exact courtyard conflict, own-pad escape, foreign-pad conflict, or
unauthorized exact-zone intrusion is blocking. A BBox-only candidate stays
unresolved until exact courtyard and live-pad evidence exists.

Treat every footprint present in the live PCB as populated for placement
closure. DNP text, a BOM note, or an assembly-variant flag does not remove its
courtyard or copper pads from this gate. The formal placement audit has no DNP
exclusion path. If a product requires a physically different assembly occupancy,
save and audit a separate exact PCB revision whose footprint population and
evidence describe that variant; do not close the shared revision by waiving a
live footprint.

## Human controls

Do not hard-code that all controls must be adjacent. Record the product decision
for each operator group:

- `GROUP_TOGETHER` requires a sourced maximum centre separation and access
  evidence;
- `SEPARATE_WITH_RATIONALE` requires the functional/mechanical reason and access
  evidence.

The access artifact must cover actuation direction, finger/tool or cap travel,
enclosure opening, nearby components/cables, legends, and board support. An EN
or BOOT resistor/capacitor may remain near the IC while the low-speed switch
body is placed at the accessible board edge.

## External interfaces and BOM normalization

For each external connector record the designator, function, exact mating part,
board gender, pitch, orientation, population decision, orderable MPN, and
rationale. Optionally bind the expected footprint name and exact 3D-model UUID.
The live MPN, footprint, and explicitly bound 3D UUID must match the record.

Gender follows the mating architecture, not a visual default. Do not fail a
board merely because one connector family has 2-, 4-, and 8-pin orderable
variants. Fail an undeclared connector, an exact metadata mismatch, or a part
outside the preferred family without a designator-specific exception.

Apply passive-package policy locally after functional placement. A package
outside the preferred set requires a designator, exact MPN, and engineering
reason such as capacitance derating, power, voltage, thermal, tolerance, or
availability. Never move a critical passive away from its pin or loop to make a
cosmetic row.

## Run the placement gate

First create the exact-revision constraint consistency report:

```bash
python3 scripts/easyeda_constraint_lint.py \
  --record path/to/layout-constraints.json \
  --output path/to/evidence/audits/constraint-consistency.json
```

After placement, save, switch away, reopen the PCB, and run:

```bash
node scripts/easyeda_placement_audit.mjs \
  --layout-constraints path/to/layout-constraints.json \
  --constraint-report path/to/evidence/audits/constraint-consistency.json \
  --output path/to/evidence/audits/placement-closure.json
```

Use a new output path for every revision. Do not overwrite prior evidence.

## Interpret results

- `PLACEMENT_CLEAR_FOR_ROUTING`: no observed geometry/policy violation, no
  unsupported or unowned pad, every live pad is inside its owner's sourced
  courtyard, every component has a sourced courtyard, every BBox candidate has
  exact pair coverage, and the constraint revision matches the live PCB.
- `BLOCKED`: observed pad/via, own-pad/courtyard, foreign-pad, exact courtyard,
  critical-zone, control, interface, or BOM-policy violation.
- `UNRESOLVED`: missing owner/opposite-side courtyard, unsupported/unowned pad,
  BBox-only collision, missing access evidence, or undeclared interface.
- `STALE`: constraint/report identity does not match the current PCB.

## Invalidation and final review

Moving or rotating a component, changing a footprint/MPN/model, adding or
moving a via, changing an interface, process, body/courtyard, access envelope,
enclosure, or preferred-part policy invalidates placement closure. Rerun the
constraint linter when the record changes and always rerun the placement audit.
For an untracked UI geometry move, identity/netlist evidence need only be
recomputed when identity, population, footprint/pad mapping, or net binding may
have changed; placement, mechanics/access, routing, copper, and DRC evidence are
always invalidated by the move.

Supply the current report to the final baseline audit:

```bash
node scripts/easyeda_design_audit.mjs \
  --placement-audit-report path/to/evidence/audits/placement-closure.json \
  --output path/to/evidence/audits/design-audit.json
```

The final audit rejects a current `BLOCKED` placement report and keeps a
missing, unresolved, or stale report unverified. Manufacturing preview and
human assembly review remain separate gates.

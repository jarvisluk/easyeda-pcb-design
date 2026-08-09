# Stackup planning

## Contents

- Required inputs
- Run the layer-count decision
- Estimate routing and escape demand
- Screen common candidate ranges
- Compare candidates and report the decision
- Select layer roles
- Reference and return-path mapping
- Materials and controlled impedance
- Power, mechanical, and manufacturing tradeoffs
- Freeze and verify

## Required inputs

Plan the stackup before ordinary placement, but treat both stackup and outline
as provisional until the joint outline/stackup/floorplan gate in
[constraint-planning.md](constraint-planning.md) closes. Record:

- board outline, thickness, copper weight, finish, layer-count/cost targets,
  mechanical stiffness, warpage, thermal, isolation, and reliability needs;
- component density, BGA/HDI escape demand, signal count, routing corridors,
  power-rail count/current, and plane-area demand;
- edge rates, interface generations, topology, target impedance/tolerance,
  loss/skew budget, reference transitions, and compliance bandwidth;
- fabricator material family, core/prepreg constructions, finished dielectric
  thickness, copper profile/roughness, frequency-dependent Dk/Df, etch/plating
  compensation, impedance-coupon, and tolerance capability;
- solver, TDR/coupon, channel, PDN, thermal, or EMC evidence required for release.

Do not choose a stackup solely from a named four-, six-, or eight-layer template.
Start from required layer functions and the selected fabricator's constructions.

Do not silently invent a missing requirement. If board outline, package,
interface generation or edge rate, isolation, current, or fabricator process
could change the layer count, report a provisional range and the exact missing
input instead of one numeric recommendation.

## Run the layer-count decision

Use this sequence for every new board and every redesign that can change
routing area, package escape, reference planes, power distribution, or process:

1. **Normalize requirements.** Separate fixed requirements, negotiable targets,
   labeled assumptions, and unknowns. A requested layer count is a target to
   test, not an architectural fact.
2. **Build a demand ledger.** Group connections by package escape, routing
   corridor, geometry class, reference requirement, power/thermal need, and
   isolation region. Record both the nominal design and reserved growth or
   change demand.
3. **Reserve non-signal functions first.** Allocate continuous references,
   power spreading, shielding, isolation, thermal copper, keepouts, and
   mechanically forbidden regions before claiming signal capacity.
4. **Generate candidates.** Start with the lowest fabricator-supported
   construction that can contain the required functions. For conventional
   multilayer boards, prefer the fabricator's balanced even-layer constructions
   unless a documented process supports another buildup. Give every copper
   layer an exact role and adjacent-reference mapping; then generate the next
   higher practical construction for comparison.
5. **Apply every feasibility gate.** Evaluate package escape, routing
   corridors, reference continuity, power/isolation, SI/EMC, thermal/mechanical,
   manufacturing, and design-margin gates. Do not trade away one gate to make a
   candidate appear feasible.
6. **Prove representative geometry.** Use package-specific fanout and route
   canaries for every distinct escape/via structure, constrained interface,
   high-current path, and congested corridor. A paper capacity estimate is not
   routing proof.
7. **Select the minimum feasible candidate.** Recommend the lowest candidate
   whose gates are supported by evidence or non-decisive labeled assumptions.
   Compare it with the next higher candidate so cost, risk, and headroom are
   visible.
8. **Close the stackup child gate.** Store the decision record, layer table,
   assumptions, validation gates, construction source, and invalidation
   conditions. Keep the result provisional until the same candidate also
   passes the exact floorplan, escape, route, return, power, thermal, access,
   antenna, and assembly canaries required by the joint gate. Freeze the
   outline, stackup, and floorplan together before ordinary placement.

A candidate is:

- **SELECTABLE** when every feasibility gate is closed and any remaining
  labeled assumption is demonstrably non-decisive to the layer count;
- **CONDITIONAL** when the construction is plausible but an explicitly named
  assumption or canary can still change its feasibility or layer count; do not
  freeze it for routing;
- **INFEASIBLE** when a required function, reference, escape, corridor, power,
  isolation, thermal, or manufacturing gate cannot be allocated;
- **UNRESOLVED** when missing inputs prevent a meaningful candidate comparison.
- **STALE** when a previously supported decision was invalidated by a change to
  outline, placement, package, interface, process, or another decisive input.

These are planning states, not formal review PASS/FAIL states and not
fabrication authorization.

## Estimate routing and escape demand

Create one demand-ledger row per materially different class:

| Field | Record |
| --- | --- |
| Class | Interface, ordinary signal, clock, analog, power, or package escape |
| Demand | Number of corridor crossings or escape channels, not just total net count |
| Corridor | Usable region after outline, holes, keepouts, placement, and via fields |
| Geometry | Trace width, same/different-class spacing, via and antipad envelope |
| Layer permission | Allowed signal layers and required adjacent reference |
| Direction | Dominant routing direction and unavoidable crossovers |
| Reserve | Declared ECO, variant, test, and uncertainty allowance with its basis |
| Proof | Calculation, placement study, fanout canary, route canary, or solver artifact |

For a uniform-width corridor, use the rule-constrained upper bound
`floor((usable width + spacing) / (trace width + spacing))`. Subtract board-edge
clearance, keepouts, pads, via/antipad fields, plane boundaries, and other
obstacles before calculating usable width. For mixed classes, evaluate each
class with its own geometry and interaction spacing. Do not count the same
physical corridor independently for two classes that must occupy it at the
same location.

Treat the result as an upper bound. Corners, breakouts, layer transitions,
return vias, neck-down limits, differential-pair coupling, length tuning, and
placement uncertainty reduce usable capacity. Do not apply a universal
occupancy or spare-capacity percentage; state the project-specific reserve and
why it is adequate. A candidate with no declared reserve is not the preferred
recommendation unless a fixed size or cost constraint forces it and the risk is
documented.

Do not estimate BGA or fine-pitch escape from pin count alone. Use the exact
package/pad geometry, permitted via technology, assembler limits, and a
representative fanout canary. If the canary cannot escape each required ball
region while preserving reference and power access, increase layers, change
the via/process, change the package, or revise placement before continuing.

## Screen common candidate ranges

Use these as screening gates, not fixed templates or interface-to-layer-count
rules:

- **Two-layer candidate:** keep one side as a broad, demonstrably continuous
  reference wherever practical. All required routing, power copper, isolation,
  and escape must fit without fragmenting the return paths of sensitive or
  fast-edge signals. If unavoidable crossovers or power regions destroy that
  continuity, screen the candidate out.
- **Four-layer candidate:** allocate at least the required continuous reference
  function plus explicit signal and power roles. Screen it out if routing needs
  force a required plane into undeclared ordinary routing, if constrained
  signal layers lack adjacent references, or if dense escape cannot be proven.
- **Six-layer candidate:** evaluate when four layers cannot simultaneously
  preserve references, power/ground distribution, noisy/sensitive separation,
  and routing/escape capacity. The added layers must solve named constraints;
  extra signal area by itself is not proof of a sound construction.
- **Eight layers and above:** require a function-by-function justification such
  as dense package escape, multiple independently referenced signal layers,
  rail/plane demand, shielding, or high-risk SI structures. Confirm the actual
  buildup, via sequence, registration, aspect ratio, loss, and cost with the
  fabricator; do not extrapolate from a lower-layer template.

A named interface alone does not mandate a layer count. Package, edge rate,
route length, return geometry, loss/EMC target, board area, and fabrication
construction determine whether the candidate works.

## Compare candidates and report the decision

Compare at least the lowest plausible candidate and the next higher practical
candidate. Use one row per candidate:

| Candidate | Exact layer functions | Closed gates | Open assumptions/canaries | Process and cost impact | State and decisive reason |
| --- | --- | --- | --- | --- | --- |
| `<N layers>` | `<one role per layer>` | `<evidence>` | `<named unknowns>` | `<fabricator-specific delta>` | `<SELECTABLE / CONDITIONAL / INFEASIBLE / UNRESOLVED>` |

Do not use a weighted score that allows cost or routing convenience to cancel a
reference, isolation, escape, thermal, or manufacturing violation. Rank only
candidates that first close all mandatory gates.

Return every layer-count decision in this form:

```markdown
## Layer-count decision

Decision status: <SELECTABLE | CONDITIONAL | INFEASIBLE | UNRESOLVED | STALE>
Recommended planning layer count: <number | provisional range | not yet determinable>
Lowest candidate evaluated: <number and disposition>
Decisive constraints: <requirements that set the floor>
Lower-candidate rejection: <specific failed gate, or not applicable>
Next-higher comparison: <risk/headroom gained and process/cost paid>
Layer roles: <exact ordered layer table, or missing input>
Assumptions/unknowns: <labeled list or none>
Required canaries/evidence: <concrete closure actions>
Invalidated by: <changes requiring a new decision>
Planning only: This recommendation is not fabrication authorization.
```

Store the same fields under `layerCountDecision` in the project constraint
record. Keep the full candidate table or link its revision-controlled artifact;
do not preserve only the winning number.

Stop at `CONDITIONAL` or `UNRESOLVED` and request the missing input when any of
these can alter the result:

- board outline, fixed placement, exact dense/fine-pitch package, or pin map;
- interface generation, source edge rate, target impedance, topology, or loss/skew budget;
- high-current, isolation, thermal-spreading, or shielding requirement;
- fabricator-supported buildup, trace/space, drill/via, material, or sequential-lamination capability;
- representative BGA/HDI escape, controlled-return, or congested-corridor canary;
- required solver, coupon, prototype, thermal, PDN, SI, or EMC evidence.

## Select layer roles

Estimate the minimum feasible layer count from all of these constraints:

1. signal escape and routing capacity after reserving planes and keepouts;
2. one declared adjacent reference for each controlled or return-sensitive
   signal layer;
3. power/ground distribution, current spreading, isolation, and rail partition;
4. BGA/HDI via technology and the number of proven escape channels;
5. layer-pair symmetry, copper balance, finished thickness, and warpage;
6. thermal spreading and shielding needs;
7. prototype and volume cost/process capability.

Adding layers only for more signal routing can worsen reference continuity,
broadside coupling, cost, or manufacturability. Removing a plane to save cost
can make the remaining signal layers unusable for their declared constraints.

Write an exact role for every copper layer: primary/limited signal, continuous
reference, power distribution, mixed power/reference, or forbidden. A layer
must not silently change role during routing.

## Reference and return-path mapping

For every signal layer, name its intended adjacent reference region and the
signals permitted to use it. Review:

- continuity beneath the complete route, including connector/BGA breakouts,
  slots, voids, antipad fields, plane edges, and split-power boundaries;
- the return transition at every signal-layer or reference-layer change;
- adjacent signal-layer broadside coupling and parallelism;
- whether a power reference has a sufficiently local high-frequency path to
  the destination/source ground reference;
- the effect of plane necks, rail islands, and stitching components.

Orthogonal routing can reduce some parallel overlap but is not proof of low
crosstalk. Separation, reference proximity, coupling length, edge rate, and
victim noise budget still govern.

## Materials and controlled impedance

Use the fabricator's finished construction, not nominal laminate labels. Record
Dk and Df at a relevant method/frequency, finished dielectric thickness,
finished copper geometry, solder-mask assumption, copper roughness/profile, and
expected tolerance.

Local glass weave, resin content, etch shape, plated copper, roughness, and
frequency dispersion can shift impedance, skew, and loss. For timing- or
loss-critical pairs, decide whether spread-glass/material selection, route
angle, lane swapping, skew budget, or solver analysis is required.

Use `pcb_calc.py` only for feasibility and cross-checks. Final controlled
impedance requires a fabricator-confirmed stackup and the required solver/coupon
evidence. A nominal 50/90/100-ohm calculation does not close insertion loss,
return loss, mode conversion, launch, or crosstalk.

## Power, mechanical, and manufacturing tradeoffs

Closely coupled power/ground planes can reduce spreading inductance and add
plane capacitance, but the benefit depends on plane area, separation, material,
frequency, and the complete PDN. Do not allocate a plane pair or remove discrete
decoupling from a generic plane-capacitance claim.

Keep the buildup and copper distribution mechanically manufacturable and
approximately balanced about the board center when the fabricator/package
requires it. Symmetry does not override a critical reference or impedance need;
resolve conflicts with the fabricator and document the accepted construction.

Confirm minimum dielectric, copper thickness, sequential-lamination cycles,
via aspect ratio, backdrill depth/tolerance, resin fill, press-out thickness,
and registration for both prototype and volume processes.

## Freeze and verify

Store the approved layer table and construction source in the project constraint
record. Include exact EasyEDA layer names, roles, reference mapping, permitted
nets, material properties, impedance structures, and unresolved assumptions.
A `SELECTABLE` stackup closes only the stackup child gate. It does not freeze
the board until the joint outline/stackup/floorplan gate derives
`CLEARED_FOR_PLACEMENT`.

Before routing, prove one representative controlled and one ordinary return
path plus every distinct BGA/via transition. Before release, compare the actual
routing and fabrication outputs against the frozen layer roles and stackup.

Any change to material, dielectric, copper, layer order/role, plane geometry,
via construction, solder mask, or fabricator invalidates affected impedance,
delay, loss, PDN, thermal, and manufacturing evidence.

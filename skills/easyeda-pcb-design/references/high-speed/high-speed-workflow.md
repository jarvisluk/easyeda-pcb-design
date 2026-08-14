# High-speed extension workflow

## Contents

- Baseline prerequisite
- Constraint intake
- Placement extension
- Routing extension
- Return paths and vias
- Verification
- Exit gates

## Baseline prerequisite

Complete the baseline workflow for the selected scope first. For schematic-only
work, verify schematic correctness and footprint mapping, capture the interface,
edge-rate, topology, impedance, stackup/reference, placement-chain, and route
limits needed by the PCB handoff, then stop. Do not require placement, routing,
copper, DRC, DFM, or manufacturing evidence that is outside that scope. For PCB
or end-to-end work, close the baseline architecture, joint
outline/stackup/floorplan gate, hard resource reservations, and applicable
specialized planning gates before high-speed placement or routing. Do not
complete ordinary routing first: constrained high-speed systems enter the
shared routing scheduler before tolerant traces. Complete the remaining
applicable baseline verification phases before claiming high-speed closure.
This reference only adds high-speed constraints.

A schematic-only high-speed review can clear electrical intent or handoff
content within its declared scope, but it cannot clear signal integrity,
controlled impedance, return paths, launches, routed length/skew, or fabrication.

Run the baseline audit appropriate to the active document before and after
high-speed edits. A high-speed audit cannot convert a failed baseline design
into a pass.

Pass the same revision-controlled constraint record to both audits. Discovery
uses the complete PCB net list rather than only routed traces. Explicit
interface declarations are authoritative; structural and name profiles are
fallback candidate generators. Ambiguous clock, SDIO/QSPI, RGMII/RMII, CAN, or
RS-485 candidates remain unresolved until edge rate, topology, impedance, and
route length are classified. Protocol sidebands such as CEC, HPD, reset, wake,
enable, LED, and VBUS are not promoted solely by their interface prefix.

## Constraint intake

Record the constraints in the format defined by
[high-speed-constraints.md](high-speed-constraints.md). At minimum include:

```json
{
  "classification": "CONTROLLED_HIGH_SPEED",
  "fabricator": "JLCPCB",
  ...see full schema in high-speed-constraints.md...
}
```

Use the complete JSON schema and evidence rules in
[high-speed-constraints.md](high-speed-constraints.md). Reject silent defaults.
Mark unknown Dk, dielectric height, copper thickness, soldermask, or etch
compensation as assumptions.

## Placement extension

1. Fix connectors, ESD/protection, termination, clocks, high-speed ICs, and decoupling before ordinary components.
2. Put protection at the connector entry without creating a long stub or broken return path.
3. Freeze the connector-to-protection-to-termination-to-transceiver placement
   chain and every conductor's `channelPaths` length limit or sourced opt-out.
4. Reserve straight, continuously referenced corridors for critical signals.
5. Plan escape and via fields before filling nearby space.

## Routing extension

1. Add each interface to the combined scheduler in `../layout/layout-rules.md`. Route it
   when its edge-rate risk, path scarcity, return/coupling dependency,
   congestion exposure, and failure consequence give it the highest combined
   priority; speed alone does not make it unconditionally first.
2. Keep width and gap constant; neck down only for a measured breakout.
3. Keep each differential pair on one layer where practical.
4. Avoid plane splits, voids, slots, dense antipad fields, and board-edge proximity beneath critical traces.
5. Avoid branches and test-point stubs.
6. Add length compensation only after minimizing uncoupled geometry.
7. Prefer broad, loosely spaced tuning over dense accordion patterns.

## Return paths and vias

1. Use an adjacent uninterrupted reference plane.
2. Do not use a narrow copper neck as the only high-frequency return path.
3. At each layer change, place close return vias; use a symmetric arrangement for a pair.
4. Review pad, antipad, residual stub, plane sequence, and connector launch.
5. Record every unavoidable discontinuity for solver or manual review.

## Verification

Order the two audits explicitly: run the baseline audit first to see which nets it
hints as high-speed, then the high-speed audit from
[high-speed-constraints.md](high-speed-constraints.md), then the baseline audit
again with `--high-speed-audit-report` so those hints can clear. For a review with
no edits, that final pass is the one that carries the conclusion; do not rerun the
baseline audit on unchanged geometry for any other reason.

For PCB or end-to-end verification, run:

1. baseline EasyEDA design audit;
2. constraint completeness;
3. impedance/delay analytical calculation;
4. route and continuous-reference review;
5. pair/group length audit;
6. via/return-via audit;
7. copper rebuild and fill-state audit;
8. EasyEDA DRC and connectivity;
9. fabricator capability/coupon check;
10. field/S-parameter solver or measurement escalation.

Any routing, layer, via, stackup, connector, or copper change invalidates downstream high-speed checks.
The report carries a normalized design fingerprint. A baseline audit rejects a
report from another project/document, an older geometry/copper revision, a
different constraint record, or a report that omits any detected candidate net.

## Exit gates

Require all applicable items:

- stackup source and assumption status recorded with on-disk artifact or
  `--user-attested-evidence`;
- target impedance and tolerance recorded;
- complete channel paths and maximum routed lengths recorded, or a sourced
  `routeLengthNotConstrained` disposition;
- connector/protection/termination/transceiver placement chain recorded;
- high-speed nets and pairs explicitly listed;
- every actually used signal layer has an explicit reference-plane mapping;
- critical signals reference a continuous plane without unreviewed splits or voids;
- every signal-layer change has an adequate nearby return path;
- differential pairs remain coupled except at documented breakouts;
- pair skew and group skew meet the recorded limits;
- no unintended stubs, branches, dense tuning, or via residual stubs;
- connector, protection, BGA, and via launches reviewed;
- analytical results are not presented as field-solver or measurement evidence;
- fabricator capability and impedance-coupon requirements confirmed;
- solver/measurement evidence present when the classification is high-risk SI
  or the audit auto-promotes the interface (USB 3 / PCIe / DDR / multi-gigabit).

If a required solver or measurement is absent, the machine artifact remains
`UNVERIFIED FOR FABRICATION`. Explain the missing evidence and consequence in
the natural-language review conclusion required by `SKILL.md`.

Never emit bare `PASS` or describe audit output as fabrication authorization.
Machine artifacts using `PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS` still
retain `fabricationRelease: false`.

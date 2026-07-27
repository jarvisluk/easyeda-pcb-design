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

Complete the baseline workflow in this skill first for schematic correctness, footprint mapping, general placement, ordinary routing, copper, DRC, DFM, and manufacturing review. This reference only adds high-speed constraints.

Run the baseline audit before and after high-speed edits. A high-speed audit cannot convert a failed baseline design into a pass.

## Constraint intake

Record the constraints in the format defined by
[high-speed-constraints.md](high-speed-constraints.md). At minimum include:

```json
{
  "classification": "CONTROLLED_HIGH_SPEED",
  "fabricator": "JLCPCB",
  "stackup": {
    "source": "FAB_CONFIRMED",
    "sourceDocument": "fabricator stackup identifier",
    "boardThicknessMm": 1.6,
    "copperThicknessUm": 35,
    "dielectricHeightMm": 0.18,
    "dk": 4.1,
    "lossTangent": 0.02,
    "frequencyGhz": 1.0,
    "layers": [
      {"name": "Top", "role": "signal"},
      {"name": "L2", "role": "ground"},
      {"name": "L3", "role": "power"},
      {"name": "Bottom", "role": "signal"}
    ]
  },
  "interfaces": [
    {
      "name": "USB2",
      "requirementsSource": "USB 2.0 specification and transceiver datasheet revision",
      "dataRateGbps": 0.48,
      "riseTimePs": 500,
      "topology": "point-to-point",
      "endpoints": ["U1.USB_DP/DM", "J1.D+/D-"],
      "protection": {
        "disposition": "IMPLEMENTED",
        "parts": ["D1"]
      },
      "testPoints": [],
      "maxStubMil": 20,
      "termination": {
        "type": "internal",
        "owner": "U1 transceiver",
        "source": "U1 datasheet revision and section"
      },
      "acCouplingNotApplicable": true,
      "connectorOrCableModel": "connector part and compliant cable model",
      "referenceBySignalLayer": {"Top": "L2:GND"},
      "nets": ["USB_DP", "USB_DM"],
      "targetDiffOhm": 90,
      "tolerancePercent": 10,
      "pairs": [
        {"positive": "USB_DP", "negative": "USB_DM", "maxSkewMil": 20}
      ]
    }
  ],
  "evidence": {
    "impedance": {
      "status": "FAB_CONFIRMED",
      "source": "coupon record"
    }
  }
}
```

Reject silent defaults. Mark unknown Dk, dielectric height, copper thickness, soldermask, or etch compensation as assumptions.

## Placement extension

1. Fix connectors, ESD/protection, termination, clocks, high-speed ICs, and decoupling before ordinary components.
2. Put protection at the connector entry without creating a long stub or broken return path.
3. Reserve straight, continuously referenced corridors for critical signals.
4. Plan escape and via fields before filling nearby space.

## Routing extension

1. Route the fastest/highest-risk interfaces first.
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

Run:

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

Run `node scripts/easyeda_audit_tests.mjs` after modifying either audit script.

Any routing, layer, via, stackup, connector, or copper change invalidates downstream high-speed checks.

## Exit gates

Require all applicable items:

- stackup source and assumption status recorded;
- target impedance and tolerance recorded;
- high-speed nets and pairs explicitly listed;
- critical signals reference a continuous plane without unreviewed splits or voids;
- every signal-layer change has an adequate nearby return path;
- differential pairs remain coupled except at documented breakouts;
- pair skew and group skew meet the recorded limits;
- no unintended stubs, branches, dense tuning, or via residual stubs;
- connector, protection, BGA, and via launches reviewed;
- analytical results are not presented as field-solver or measurement evidence;
- fabricator capability and impedance-coupon requirements confirmed;
- solver/measurement evidence present when the classification is high-risk SI.

If a required solver or measurement is absent, return `UNVERIFIED FOR FABRICATION`.

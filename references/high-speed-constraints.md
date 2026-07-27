# High-speed constraint record

## Contents

- Purpose
- Required record
- Evidence fields
- Decision behavior

## Purpose

Pass a revision-controlled JSON file to `easyeda_high_speed_audit.mjs` with
`--constraints FILE`. Command-line net and pair flags remain available for quick
screening, but they cannot produce a fabrication-pass decision.

Do not use silent interface defaults. Record the source for every limit.

## Required record

Use this structure:

```json
{
  "classification": "CONTROLLED_HIGH_SPEED",
  "fabricator": "JLCPCB",
  "groundNet": "GND",
  "requireGroundPour": true,
  "launchesNotApplicable": false,
  "maxReturnViaDistanceMil": 50,
  "stackup": {
    "source": "FAB_CONFIRMED",
    "sourceDocument": "fabricator stackup or coupon identifier",
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
        "parts": ["D1", "FL1"]
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
      "maxReturnViaDistanceMil": 50,
      "pairs": [
        {
          "positive": "USB_DP",
          "negative": "USB_DM",
          "maxSkewMil": 20
        }
      ],
      "groups": []
    }
  ],
  "evidence": {
    "impedance": {
      "status": "FAB_CONFIRMED",
      "source": "coupon or fabricator field-solver record"
    },
    "continuousReference": {
      "status": "MANUAL_REVIEWED",
      "source": "layout review record and PCB revision"
    },
    "coupling": {
      "status": "MANUAL_REVIEWED",
      "source": "pair geometry review and PCB revision"
    },
    "launches": {
      "status": "SOLVER_VERIFIED",
      "artifact": "connector-launch.s4p"
    },
    "returnViaLayerSpan": {
      "status": "MANUAL_REVIEWED",
      "source": "layer-transition review and PCB revision"
    },
    "solverOrMeasurement": {
      "status": "SOLVER_VERIFIED",
      "artifact": "complete-channel.s8p"
    }
  }
}
```

Use `CONTROLLED_HIGH_SPEED` or `HIGH_RISK_SI` for `classification`.

For a length-matched bus, add a group:

```json
{
  "name": "SDIO_DATA",
  "nets": ["SD_D0", "SD_D1", "SD_D2", "SD_D3"],
  "maxSkewMil": 100
}
```

Set `launchesNotApplicable` only when there is no connector, protection,
package escape, BGA escape, or other launch requiring review.

For every interface, explicitly record:

- the specification, datasheet, or reference-design source for its limits;
- named electrical endpoints;
- protection disposition and implemented part designators;
- test points, including an explicit empty list;
- maximum allowed stub length;
- termination type, owner, and source, or `terminationNotApplicable`;
- AC-coupling owner and source, or `acCouplingNotApplicable`;
- connector/cable model, or `connectorNotApplicable`.

## Evidence fields

Every evidence object requires both a recognized `status` and a non-empty
`source`, `artifact`, or `reference`.

- Use `FAB_CONFIRMED` for fabricator stackup or coupon evidence.
- Use `ANALYTICAL_ESTIMATE` only for closed-form calculations; it cannot close
  a production impedance or high-risk SI gate.
- Use `RULE_CHECK` only for deterministic script output.
- Use `MANUAL_REVIEWED` for a revision-identified geometry review.
- Use `SOLVER_VERIFIED` or `MEASUREMENT_VERIFIED` for solver or laboratory
  artifacts.

Require `solverOrMeasurement` for `HIGH_RISK_SI`.

## Decision behavior

- Return `FAIL` for observed violations such as missing declared nets, DRC
  errors, excessive skew, branches in point-to-point nets, mismatched pair
  layers or widths, or missing close return vias.
- Return `UNVERIFIED FOR FABRICATION` when required constraints or evidence are
  absent.
- Return `PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS` when deterministic
  checks pass and every non-API-verifiable gate has revision-linked evidence.
- Treat any routing, stackup, layer, via, connector, protection, or copper
  change as invalidating downstream evidence.

For automation, exit code `0` means a non-failing completed audit, `2` means
`FAIL`, `3` means `UNVERIFIED FOR FABRICATION`, and `1` means the audit could
not execute.

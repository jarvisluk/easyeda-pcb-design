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

Save, switch away, and reopen the PCB, then run:

```bash
node scripts/audits/easyeda_high_speed_audit.mjs \
  --constraints <project>/high-speed-constraints.json \
  --ground-net GND \
  --output <project>/evidence/audits/high-speed-audit.json
```

Use a new output path per revision; do not overwrite prior evidence. Then bind the
report to the baseline audit with `--high-speed-audit-report FILE` alongside
`--high-speed-constraints FILE`. Running the audit does not close the gate: a
`PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS` here is not a fabrication release,
and the baseline audit stays `UNVERIFIED FOR FABRICATION` until this report's
bindings and evidence fields are complete.

Do not use silent interface defaults. Record the source for every limit.

The baseline audit accepts this same file through
`--high-speed-constraints FILE`. Nets listed under interfaces, pairs, and
length groups are authoritative high-speed declarations even when their names
are proprietary and even when they are not routed yet.

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
  "returnViaExceptions": [
    {
      "signalViaId": "immutable-signal-via-id",
      "maxDistanceMil": 120,
      "reason": "bounded geometry-specific exception",
      "artifactPath": "api-geometry-review.json"
    }
  ],
  "nativeNetlistCacheException": {
    "reason": "native cache remains stale after verified synchronization attempts",
    "artifactPath": "manufacturing-netlist-comparison.json"
  },
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
      "placement": {
        "connectorRef": "J1",
        "protectionRefs": ["D1", "FL1"],
        "seriesTerminationRefs": [],
        "transceiverRef": "U1",
        "source": "connector, protection, and transceiver datasheets"
      },
      "channelPaths": [
        {
          "name": "D+",
          "nets": ["USB_DP"],
          "maxLengthMil": 1181,
          "source": "project constraint: 30 mm maximum routed channel"
        },
        {
          "name": "D-",
          "nets": ["USB_DM"],
          "maxLengthMil": 1181,
          "source": "project constraint: 30 mm maximum routed channel"
        }
      ],
      "targetDiffOhm": 90,
      "tolerancePercent": 10,
      "maxReturnViaDistanceMil": 50,
      "pairs": [
        {
          "positive": "USB_DP",
          "negative": "USB_DM",
          "maxSkewMil": 20,
          "localFanInException": {
            "maxAggregateSkewMil": 100,
            "allowLayerMismatch": false,
            "reason": "bounded duplicate-pad connector fan-in",
            "artifactPath": "local-fanin-review.json"
          }
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

For every point-to-point interface, also record:

- a `placement` chain naming the connector, protection parts, series
  termination parts, transceiver, and the source used to order them; use an
  explicit empty array when a stage is absent;
- one or more `channelPaths`, each with an ordered net list, positive
  `maxLengthMil`, and source; split-net paths may span connector-side,
  protection-side, and transceiver-side net names;
- every actual routed signal layer in `referenceBySignalLayer`.

Every interface net must belong to a channel path. If the governing source
genuinely imposes no routed-length limit, replace `channelPaths` with
`routeLengthNotConstrained: {"reason": "...", "source": "..."}`. This is a
reviewable disposition, not an impedance-based assumption. Impedance control
does not waive propagation delay, loss, return-path, stub, launch, or placement
limits. `localFanInException` cannot waive a full-channel length limit.
The audit forms interface membership from the union of `nets`, `pairs`,
`groups`, and `channelPaths`; a net listed only in a pair or group still enters
the topology and actual-used-layer checks.

When applicable, also record `frequencyGhz`, `rfLaunch`,
`denseBgaEscape`, `denseViaField`, `validationRequirement`, and
`complianceRequirement`. RF frequency/launches, dense escapes, or explicit
eye-mask, S-parameter, insertion-loss, return-loss, crosstalk, TDR, or VNA
requirements force high-risk SI treatment.

## Evidence fields

Every evidence object requires a recognized `status` and either:

1. an on-disk `artifact` or `artifactPath` that exists when the audit runs, or
2. **human** attestation: `--user-attested-evidence` **and**
   `EASYEDA_AUDIT_USER_ATTEST=YES` (human shell only) **and** `--attest-file`
   containing `I ATTEST EVIDENCE FOR PCB REVISION: <id>`, plus a non-empty
   source string.

Agents must never export the env var or write the attest file.

Free-text sources alone do **not** close gates. Do not invent coupon paths,
solver dumps, or fabricator IDs.

Stackup with `source: "FAB_CONFIRMED"` likewise requires an existing
`artifact`/`artifactPath` or accepted human attestation with `sourceDocument`.

- Use `FAB_CONFIRMED` for fabricator stackup or coupon evidence.
- Use `ANALYTICAL_ESTIMATE` only for closed-form calculations; it cannot close
  a production impedance or high-risk SI gate.
- Use `RULE_CHECK` only for deterministic script output.
- Use `MANUAL_REVIEWED` for a revision-identified geometry review.
- Use `SOLVER_VERIFIED` or `MEASUREMENT_VERIFIED` for solver or laboratory
  artifacts.

Require `solverOrMeasurement` for `HIGH_RISK_SI`. The audit also **forces**
high-risk treatment when an interface name/profile matches USB 3 / PCIe / DDR /
HDMI / SerDes / multi-gigabit patterns or `dataRateGbps >= 1`, even if the
record still says `CONTROLLED_HIGH_SPEED`.

`requireGroundPour` defaults to true. Setting it false requires
`exceptionNote` in the JSON or `--exception-note` on the CLI.

`localFanInException` is limited to the declared pair and requires an existing
artifact, a positive `maxAggregateSkewMil`, and a reason. It cannot waive the
complete routed channel. `returnViaExceptions` are keyed to immutable signal
via IDs, require a positive `maxDistanceMil`, reason, and artifact, and fail if
the referenced via disappears. Stale exceptions are hard failures.

`nativeNetlistCacheException` is narrower still: its JSON artifact must be an
`easyeda-manufacturing-netlist-comparison` whose decision is literal `MATCH` or
the complete `MATCH_WITH_VERIFIED_NATIVE_CACHE_EXCEPTION` contract. It must
prove `manufacturingDecision=MATCH`, `comparison.match=true`, exact nonempty
project/schematic/PCB UUIDs, `fabricationRelease=false`, and, for the exception
path, `nativeCacheException.status=VERIFIED` with no issues,
`pcbDataPlaneIntegrity.match=true`, and an empty native File-to-File difference
array. Project and PCB UUIDs must equal the active revision. It may clear only
leaf errors whose exact type is `Netlist Error` and rule is `Import Changes`;
the raw leaf is retained, and any clearance, connection, geometry, free-copper,
or other DRC leaf rejects it.

For an existing-board geometry repair, this exception may prevent a known
native cache defect from blocking the edit transaction, but it never asserts
`PCB_SYNC_MATCH`. Re-export and compare the manufacturing netlist after every
bounded repair, and reject the exception if component identity, pad-net binding,
or any non-cache DRC result changes.

Runtime `preserveSilos=true` is not by itself a failure when the unique solid-
fill ID count equals the solid-fill count and detailed DRC reports no free-
copper error targeting any ID. This is an evidence-backed workaround for an
unreliable beta readback, not permission to preserve unknown islands. A single
connected fill does not clear a disconnected sibling region from the same Pour.

## Decision behavior

- Bare `PASS` is never emitted. `fabricationRelease` is always false.
- Return `FAIL` for observed violations such as missing declared nets, DRC
  errors, excessive skew, branches in point-to-point nets, mismatched pair
  layers or widths, or missing close return vias.
- Return `UNVERIFIED FOR FABRICATION` when required constraints or evidence are
  absent, free-text evidence lacks attestation/artifacts, or high-risk SI lacks
  solver/measurement evidence.
- Return `PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS` when deterministic
  checks pass and every non-API-verifiable gate has artifact-backed or
  user-attested evidence. This is **not** a fab release.
- Treat any routing, stackup, layer, via, connector, protection, or copper
  change as invalidating downstream evidence.
- A cleared report is bound to project UUID, document UUID, normalized design
  fingerprint, constraint fingerprint, and the exact high-speed-net coverage.
  Reports without those bindings cannot clear the baseline audit.

For automation, exit codes are:

- `1` — audit could not execute
- `2` — `FAIL`
- `3` — `UNVERIFIED FOR FABRICATION`
- `4` — `PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS` (not fab release)

Do not treat exit code `4` as authorization to fabricate.

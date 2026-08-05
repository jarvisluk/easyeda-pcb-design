# Crystal and clock-sensitive-loop audit

## When to use

Run `easyeda_crystal_clock_audit.mjs` for passive crystals or resonators placed
between a controller's oscillator pins. The baseline audit automatically hints
common net names such as `XTAL_IN`, `OSC_OUT`, `HSE_IN`, `LSE_OUT`, `XIN`, and
`XOUT`; a hint remains `UNVERIFIED FOR FABRICATION` until a cleared
crystal/clock report is attached.

An active oscillator's digital output may additionally require the high-speed
audit when its edge rate, route length, fanout, topology, or impedance
requirements make it a transmission line. Do not use this crystal-loop audit
as a substitute for that high-speed path.

## Constraint record

Do not use universal placement or routing limits. Copy the limits from the
selected MCU/oscillator datasheet, reference design, or a documented project
rule into a revision-controlled JSON file:

```json
{
  "loops": [
    {
      "name": "HSE",
      "mcuRef": "U1",
      "crystalRef": "Y1",
      "loadCapRefs": ["C21", "C22"],
      "nets": ["OSC_IN", "OSC_OUT"],
      "requirementsSource": "STM32 device datasheet revision and oscillator layout section",
      "requirementsArtifact": "evidence/stm32-datasheet.pdf",
      "maxMcuCrystalDistanceMil": 300,
      "maxLoadCapCrystalDistanceMil": 150,
      "maxNetLengthMil": 250,
      "maxViasPerNet": 0,
      "requireSameSide": true
    }
  ],
  "evidence": {
    "manualReview": {
      "status": "MANUAL_REVIEWED",
      "source": "PCB revision-specific oscillator review",
      "artifact": "evidence/hse-layout-review.md"
    }
  }
}
```

`loadCapRefs` must be an explicit array. When the selected device intentionally
uses integrated capacitance or otherwise needs no external load capacitors, use
an empty array and set `loadCapacitorsNotApplicable: true`.

The requirements source needs either an existing `requirementsArtifact` or
accepted human attestation. The manual review evidence likewise needs an
existing artifact, or human attestation with a recognized status and source.
Agents must never set `EASYEDA_AUDIT_USER_ATTEST` or write the attest file.

## Run

```bash
node scripts/easyeda_crystal_clock_audit.mjs \
  --constraints crystal-clock-constraints.json \
  --output crystal-clock-audit.json

node scripts/easyeda_design_audit.mjs \
  --ground-net GND \
  --crystal-audit-report crystal-clock-audit.json \
  --output design-audit.json
```

## Deterministic checks

For each declared loop, the audit checks:

- MCU, crystal/resonator, and load-capacitor designators exist exactly once;
- MCU-to-crystal and capacitor-to-crystal component-origin distances meet the
  recorded limits;
- declared crystal nets have routed primitives;
- total routed primitive length per net meets the recorded limit;
- via count per net meets the recorded limit;
- components and routes remain on the required side when `requireSameSide` is
  true;
- PCB DRC passes.

Observed violations return `FAIL`. Missing limits, sources, or review evidence
return `UNVERIFIED FOR FABRICATION`.

## Mandatory manual review

EasyEDA geometry alone cannot prove:

- symbol-to-pad mapping and the exact oscillator pin pair;
- crystal frequency, ESR, drive level, and startup margin;
- effective load capacitance, including pin and PCB parasitics;
- series/damping resistor selection;
- the silicon vendor's ground pour, guard, or keepout policy;
- distance from switch nodes, clocks, antennas, and other aggressors;
- probe/test-point loading and oscillator behavior across voltage and
  temperature.

The script uses component origins as placement-distance proxies because the
collected API data does not prove pad-to-pad electrical endpoints. Visually
review pad-level geometry against the exact PCB revision.

Any change to the MCU/crystal/capacitor selection, placement, routing, vias,
ground/keepout geometry, or nearby switching layout invalidates the report.
The result is never a fabrication release.

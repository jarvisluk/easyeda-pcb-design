# Electrical screening calculations

Use these calculations to expose assumptions and decide what evidence is needed
next. They are analytical estimates, not field-solver, thermal, fabrication, or
measurement evidence.

## Authority and confidence

- Treat device/vendor requirements and fabricator-approved constructions as
  authoritative over these models.
- Record inputs, output JSON, model name, assumptions, and the exact design
  revision with any decision that depends on a result.
- Escalate when geometry is outside a model, the result is near a limit, the
  material construction is unknown, or failure has high consequence.

## Edge-rate and electrical-length screen

Run:

```bash
python3 scripts/pcb_calc.py edge-screen \
  --rise-time-ns 1 --route-length-mm 25 --er 4
```

Use source rise/fall time, not clock frequency alone. The command compares
one-way flight time, calculated with bulk Dk, with edge time and reports a
conservative classification. `lumped_screening_candidate` does not waive return
path, crosstalk, overshoot, or device-interface requirements. For a frozen
microstrip geometry, the geometry-specific delay from the impedance command is
more representative than the bulk-Dk screen.

## Uniform-trace DC resistance

Run:

```bash
python3 scripts/pcb_calc.py trace-dc \
  --length-mm 100 --width-mm 0.25 --thickness-mm 0.035 \
  --temperature-c 80 --current-a 1
```

The model uses a rectangular copper cross-section, reference resistivity at
20 °C, and a linear temperature coefficient. It can screen voltage drop and
I²R loss, but it does not establish ampacity or temperature rise. Finished
copper, etch loss, neck-downs, vias, spreading resistance, airflow, and the
board thermal system require separate treatment.

## Classical skin depth

Run:

```bash
python3 scripts/pcb_calc.py skin-depth --frequency-ghz 1
```

This is a smooth, homogeneous, nonmagnetic-conductor estimate. It helps explain
why copper roughness and conductor geometry become important; it does not
calculate AC resistance, proximity effect, dielectric loss, or insertion loss.

## Escalation

Use a fabricator field solver for controlled impedance. Use a suitable power
integrity, thermal, or electromagnetic model when the screen affects a release
decision. Validate consequential predictions with prototype measurement.

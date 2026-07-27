---
name: easyeda-pcb-design
description: Create, modify, route, and audit schematics and PCBs in EasyEDA Pro (嘉立创EDA专业版), from ordinary MCU minimum systems, sensors, power/control and breakout boards through controlled-impedance and high-speed designs. Use for schematic capture, symbols and footprints, board outlines, placement, 0/45/90-degree routing, power/ground strategy, copper pours, stitching vias, ERC/DRC, DFM/manufacturing preflight, or for USB, Ethernet, LVDS, HDMI, PCIe, DDR, SDIO, QSPI, RF, fast clocks, differential pairs, impedance, return paths, via transitions, skew, SI/EMC review. Progressively loads high-speed material only when the design requires it.
---

# EasyEDA PCB Design

Build and review EasyEDA designs through the API with explicit verification gates. Use visual inspection to confirm results, not as the primary construction method.

## Required companion

Use `easyeda-api` for every live EasyEDA operation. Read the exact class, enum, interface, units, return type, and remarks before calling an API. Never guess a signature or enum value.

## Classify before loading references

Choose the lowest sufficient level:

1. **Baseline** — ordinary digital, analog, power, control, MCU, sensor, or breakout board without controlled-impedance requirements.
2. **Controlled/high-speed** — differential pairs, target impedance, RF, fast clocks/edges, USB, Ethernet, LVDS, HDMI, PCIe, DDR, SDIO, QSPI, MIPI, SerDes, or other signal-integrity constraints.
3. **High-risk SI** — multi-gigabit links, PCIe Gen3+, USB 3.x, DDR, RF launches, dense BGA/via fields, or a requirement for insertion loss, return loss, crosstalk, eye masks, or S-parameters.

If edge rate or interface requirements are unknown, treat the classification as unresolved. Do not silently downgrade it.

## Progressive disclosure map

Load only what the current task needs:

- **Create or substantially modify any design:** read [references/workflow.md](references/workflow.md).
- **Place, route, ground, or pour copper:** also read [references/layout-rules.md](references/layout-rules.md).
- **Run or change live API automation:** read [references/api-map.md](references/api-map.md) plus the exact `easyeda-api` class/enum/interface documents.
- **Finish or release a design:** read [references/review-checklist.md](references/review-checklist.md).
- **Controlled/high-speed only:** additionally read [references/high-speed-workflow.md](references/high-speed-workflow.md) and [references/impedance-and-vias.md](references/impedance-and-vias.md).
- **Run a high-speed audit:** also read [references/high-speed-constraints.md](references/high-speed-constraints.md) and create a revision-controlled constraint record.
- **A named high-speed interface only:** additionally read the matching section of [references/protocol-profiles.md](references/protocol-profiles.md). Do not load unrelated profiles.
- **PDN, ESD, or EMC claims:** additionally read [references/pdn-emc.md](references/pdn-emc.md).
- **Modify the high-speed audit:** read [references/high-speed-api-map.md](references/high-speed-api-map.md).
- **Change formulas or attribution:** read [references/sources.md](references/sources.md).

Do not load high-speed references for a baseline task.

## Baseline execution

1. Capture electrical, mechanical, fabricator, and assembly constraints.
2. Create/audit the schematic, assign verified footprints, and run schematic DRC.
3. Create a closed board outline and place mechanical, protection, power, clock, decoupling, and remaining parts in functional order.
4. Route deliberate power/sensitive paths and use only 0°, 45°, or 90° segment directions unless documented.
5. Create intended GND/reference copper, rebuild it, read back generated fill, and disable unwanted islands.
6. Confirm unrouted count, run PCB DRC, review polarity/silkscreen/mechanics, and inspect manufacturing outputs.
7. Run the baseline audit after routing and after the final copper rebuild.

```bash
node scripts/easyeda_design_audit.mjs \
  --ground-net GND \
  --output design-audit.json
```

Use `--allow-no-ground-pour` only when the alternative reference implementation is intentional and documented.

## High-speed extension

Complete every baseline gate, then:

1. Record interface, data rate, rise/fall time, topology, target impedance/tolerance, maximum skew, fabricator stackup, copper thickness, dielectric height, frequency-dependent Dk, and loss tangent.
2. Stop controlled-impedance routing if the real stackup is unknown; label any temporary geometry as an assumption.
3. Estimate trace/via geometry with `scripts/pcb_calc.py`; mark results `ANALYTICAL_ESTIMATE`, never simulation.
4. Route critical nets over a continuous reference, preserve coupling, minimize discontinuities/stubs/vias, and add close return vias at reference changes.
5. Run the baseline audit first, then the high-speed audit.

```bash
python3 scripts/pcb_calc.py solve-diff-microstrip \
  --er 4.1 --height-mm 0.18 --spacing-mm 0.18 \
  --target-ohm 90 --thickness-mm 0.035

node scripts/easyeda_high_speed_audit.mjs \
  --constraints high-speed-constraints.json \
  --require-ground-pour \
  --output high-speed-audit.json
```

Use evidence labels accurately: `FAB_CONFIRMED`, `ANALYTICAL_ESTIMATE`, `RULE_CHECK`, `MANUAL_REVIEWED`, `SOLVER_VERIFIED`, and `MEASUREMENT_VERIFIED`.

Treat `--pair` and `--high-speed-net` without `--constraints` as screening only. Never convert that result into a fabrication pass.

For high-risk SI, require an identified field/S-parameter solver or measurement path. Return `UNVERIFIED FOR FABRICATION` when that evidence is absent.

## Completion

Apply every applicable item in [references/review-checklist.md](references/review-checklist.md), plus the high-speed gates when triggered. A clean DRC does not prove connectivity intent, return-path continuity, current capacity, thermal adequacy, impedance, or mechanical fit.

After changing this skill, run:

```bash
node scripts/easyeda_audit_tests.mjs
python3 scripts/pcb_calc_tests.py
```

Return `PASS`, `PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS`, `FAIL`, or `UNVERIFIED FOR FABRICATION`. Never convert an unchecked item into a pass.

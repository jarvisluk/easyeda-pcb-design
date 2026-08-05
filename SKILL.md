---
name: easyeda-pcb-design
description: Guide and execute end-to-end schematic and PCB design in EasyEDA Pro (嘉立创EDA专业版), from requirements, architecture, component and footprint selection through placement, routing, grounding, copper, and final verification. Use for ordinary MCU, sensor, analog, power, control, and breakout boards, plus controlled-impedance or high-speed USB, Ethernet, LVDS, HDMI, PCIe, DDR, SDIO, QSPI, RF, clock, differential-pair, SI, and EMC work. Also use to modify or review existing EasyEDA designs, run ERC/DRC and DFM checks, and prepare manufacturing outputs. Load specialized high-speed and audit guidance only when the task requires it. Do not use for KiCad, Altium, OrCAD, or other non-EasyEDA tools.
---

# EasyEDA PCB Design

Act as a PCB design guide first. Lead the work from design intent to an
implemented board, explain consequential choices, and use audits as closure
tools rather than as the center of every task.

**A clean DRC or audit is not a fabrication release.** Never tell the user a board is ready to fab from script output alone.

## Select the working mode

Choose the mode from the user's outcome:

1. **Guide** — develop requirements, architecture, design rules, placement,
   routing, or tradeoffs. Give the next concrete design action and explain why.
   Do not jump to audit commands unless they answer the current question.
2. **Build or modify** — guide the same design sequence, then implement approved
   choices through EasyEDA. Verify each completed phase before continuing.
3. **Review or release** — inspect an existing design, run applicable audits,
   identify unresolved evidence, and use the review completion format. Treat
   “can I fabricate/order this board?” as a formal review even when design
   files or the live bridge are missing.

When the request spans modes, design first, implement second, and review last.
Do not make PASS/FAIL language the default for ordinary guidance or work-in-progress
updates.

## Follow the design lifecycle

Read [references/workflow.md](references/workflow.md) for the complete baseline
method and apply these phases in order:

1. **Define the brief** — capture electrical, functional, mechanical,
   environmental, fabricator, assembly, cost, and test constraints. Separate
   confirmed requirements from assumptions and unresolved decisions.
2. **Partition the architecture** — identify power, control, analog, digital,
   protection, clock, programming/debug, and external-interface blocks. Define
   rails, current paths, signal directions, and connector pinouts before drawing.
3. **Design the schematic** — work block by block; verify power pins,
   decoupling, bias and default states, reset/boot, clocks, protection, unused
   pins, and net naming. Check datasheets and reference designs for critical
   circuits rather than copying values by habit.
4. **Verify parts and footprints** — bind each symbol to an orderable part and
   verify package dimensions, pin-to-pad mapping, polarity, mating view, thermal
   pad, courtyard, and assembly data.
5. **Plan and place the board** — fix outline, holes, keepouts, connectors, and
   controls first; then place protection, power stages, clocks, decoupling, and
   functional blocks by current flow and signal flow.
6. **Route deliberately** — establish rules before routing. Route power and
   sensitive loops first, preserve return paths, minimize loop area and layer
   changes, and grow multi-pad nets as connected trees without accidental
   cycles. Read [references/layout-rules.md](references/layout-rules.md) for
   placement, topology, grounding, copper, and DFM rules.
7. **Complete copper and mechanics** — add intended reference copper, rebuild
   and inspect actual fill, remove purposeless islands, add justified stitching,
   and check thermal, edge, enclosure, assembly, and service access.
8. **Verify the result** — run ERC/DRC and targeted audits only after the
   relevant design phase exists. Review connectivity intent, polarity,
   mechanics, outputs, and unresolved assumptions; do not infer those from a
   clean rule check.

At each phase, state the decision, its basis, any assumption, and the next gate.
When requirements are missing but a reversible choice is possible, proceed with
a labeled assumption. Stop for a choice that would materially change the
architecture, safety, mechanics, or fabrication process.

## Use the EasyEDA companion for live work

Use `easyeda-api` (EasyEDA API skill / bridge) for every live EasyEDA operation.

Before **any** live create/modify/audit:

```bash
node scripts/check_companion.mjs
```

1. Exit code must be `0` and `ready: true`.
2. If companion/bridge is missing: **stop**. Do not guess API signatures.
3. Read the exact class/enum/units from `easyeda-api` before calling.
4. Optional: set `EASYEDA_API_SKILL_PATH` to the companion skill directory.

Use visual inspection to confirm implementation results, not as the primary
construction method.

## Protect user work

Require explicit user confirmation before delete, mass net rename, bulk overwrite, `--force` on outputs, or copper rebuilds that discard uncommitted work.

## Classify technical depth

1. **Baseline** — ordinary boards without controlled-impedance needs.
2. **Controlled/high-speed** — differential pairs, target impedance, USB2/Ethernet/LVDS, fast edges, etc.
3. **High-risk SI** — USB 3.x, PCIe, DDR, multi-gigabit (`dataRateGbps >= 1`), RF launches, solver/eye requirements. Auto-forced by audit heuristics.

If unknown, do not downgrade. Baseline HS-net hints → run high-speed path (baseline alone returns `UNVERIFIED`).

Classification changes which guidance is loaded; it does not replace the
baseline design lifecycle.

## Load only relevant guidance

Load only what the task needs:

- Any new or substantially changed design: [references/workflow.md](references/workflow.md)
- Place/route/copper: [references/layout-rules.md](references/layout-rules.md)
- Live API: [references/api-map.md](references/api-map.md) + exact `easyeda-api` docs
- Finish/review: [references/review-checklist.md](references/review-checklist.md)
- Crystal/resonator loop: [references/crystal-clock-audit.md](references/crystal-clock-audit.md)
- Controlled/HS: [references/high-speed-workflow.md](references/high-speed-workflow.md), [references/impedance-and-vias.md](references/impedance-and-vias.md)
- HS audit: [references/high-speed-constraints.md](references/high-speed-constraints.md)
- Named interface only: matching section of [references/protocol-profiles.md](references/protocol-profiles.md)
- PDN/ESD/EMC claims: [references/pdn-emc.md](references/pdn-emc.md) — no certification language without measurement
- Change HS audit code: [references/high-speed-api-map.md](references/high-speed-api-map.md)
- Formulas/attribution: [references/sources.md](references/sources.md)

Do not load audit implementation references for a design-guidance question.
Do not load high-speed material for a baseline design.

## Add specialized design guidance

### Crystal and clock-sensitive loops

For passive crystals and resonators, use the device datasheet and
[references/crystal-clock-audit.md](references/crystal-clock-audit.md). Keep the
loop compact, place the network at the device pins, control nearby copper and
noise according to the device guidance, and treat startup margin and loading as
electrical design questions. Do not force crystals into impedance-oriented
high-speed constraints.

### Controlled-impedance and high-speed interfaces

Complete the baseline lifecycle, then:

1. Record interface, topology, data rate and edge rate, target impedance and
   tolerance, skew budget, stackup, copper thickness, dielectric height,
   frequency-dependent Dk, and loss tangent.
2. Do not finalize controlled-impedance geometry without a fabricator stackup.
   Label temporary geometry as an assumption.
3. Place endpoints, protection, termination, AC-coupling parts, and reference
   transitions as one signal path.
4. Route over a continuous reference, preserve pair coupling, minimize stubs,
   discontinuities and vias, and add close return vias at reference changes.
5. Use analytical calculators for initial geometry only. Require a solver or
   measurement plan when the high-risk SI classification demands one.

Read [references/high-speed-workflow.md](references/high-speed-workflow.md),
[references/impedance-and-vias.md](references/impedance-and-vias.md), and only
the relevant interface section in
[references/protocol-profiles.md](references/protocol-profiles.md).

## Use audits for design closure

Run the baseline audit after routing and after the final copper rebuild, or when
the user explicitly asks to inspect an existing design:

```bash
node scripts/easyeda_design_audit.mjs \
  --ground-net GND \
  --high-speed-constraints high-speed-constraints.json \
  --output design-audit.json
```

- `--allow-*` requires `--exception-note TEXT`
- Baseline PCB audit builds a graph for every named net from explicit lines,
  discretized polylines, same-layer straight-track intersections, and vias.
  Any closed routing cycle or duplicate overlapping feed is `FAIL` by default,
  including power and ground nets. An intentional ring/parallel feed must be
  named explicitly with repeatable `--allow-routing-cycle NET` and documented
  with `--exception-note TEXT`.
- Copper pours and pad-internal copper are not expanded into graph edges, and
  arc-interior intersections have partial coverage. Treat these declared
  limitations as manual-review items; do not infer “no loop” beyond the
  reported explicit-routing graph.
- Crystal/clock-like net names → `UNVERIFIED` unless `--crystal-audit-report FILE`
  is a prior crystal/clock audit with `PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS`
- HS discovery uses the complete PCB net list, explicit interface constraints,
  differential-pair-shaped names, and protocol/RF candidates. Ambiguous
  edge-rate candidates remain unresolved.
- HS candidates → `UNVERIFIED` unless `--high-speed-audit-report FILE` is a
  prior HS audit for the same project, document, design fingerprint, constraint
  fingerprint, and detected-net coverage.
- `--manufacturing-reviewed` requires human `--attest-file` + env (below)
- `--output` relative under cwd; `--force` to overwrite
- Exit: `2=FAIL`, `3=UNVERIFIED`, `4=PASS WITH…` (not fab), `1=error`

Run the crystal audit only when a passive crystal/resonator loop is present:

```bash
node scripts/easyeda_crystal_clock_audit.mjs \
  --constraints crystal-clock-constraints.json \
  --output crystal-clock-audit.json
```

The audit checks declared component placement, trace length, layer/side, and
via limits. Electrical values, startup margin, pin mapping, ground/keepout
policy, and noise isolation remain artifact-backed or human-attested manual
review gates.

Run the calculator and high-speed audit only for the controlled/high-speed path:

```bash
python3 scripts/pcb_calc.py solve-diff-microstrip \
  --er 4.1 --height-mm 0.18 --spacing-mm 0.18 \
  --target-ohm 90 --thickness-mm 0.035

node scripts/easyeda_high_speed_audit.mjs \
  --constraints high-speed-constraints.json \
  --output high-speed-audit.json
```

Evidence closes gates only when:

1. accepted `status`, and
2. existing on-disk `artifact`/`artifactPath`, **or**
3. **human** attestation (not agent-invented):

```bash
# HUMAN shell only — agents must NEVER set this or write the attest file
export EASYEDA_AUDIT_USER_ATTEST=YES
# Human-written file must contain exactly this line form:
# I ATTEST EVIDENCE FOR PCB REVISION: <revision-id>

node scripts/easyeda_high_speed_audit.mjs \
  --constraints high-speed-constraints.json \
  --user-attested-evidence \
  --attest-file ./human-attest.txt \
  --output high-speed-audit.json
```

If the agent needs free-text evidence accepted, **ask the human** to export the env var and create the attest file. Do not do it for them.

`pcb_calc.py` results are always `ANALYTICAL_ESTIMATE`.

## Report review or release results

End every audit, formal design review, manufacturing preflight, or
release-readiness response with this filled block. This includes a review that
cannot start or finish because design files, manufacturing outputs, constraints,
evidence, or the live bridge are missing: use `UNVERIFIED FOR FABRICATION` and
name the missing evidence in `Assumptions/exceptions` and `Next step`. Do not
append the block to ordinary design guidance or intermediate build updates.

```markdown
## Design review completion

Decision: <PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS | FAIL | UNVERIFIED FOR FABRICATION>
fabricationRelease: false
manufacturingOutputsReviewed: <true|false>
notAFabricationRelease: This result is NOT authorization to fabricate or place a PCB order.
Companion: <ready|missing> (easyeda-api + easyeda-bridge)
High-speed: <not-applicable | required-and-cleared | required-and-missing | ran>
Assumptions/exceptions: <none | list>
Next step: <concrete action>
```

For a review/release request, missing this block means the response is
incomplete, even when the review is blocked before inspection.
Never say “可以打样/ready to fab/place order” unless the human explicitly
overrides after seeing `fabricationRelease: false`.

After changing this skill:

```bash
node scripts/easyeda_audit_tests.mjs
node scripts/easyeda_crystal_clock_audit.mjs --self-test
python3 scripts/pcb_calc_tests.py
node scripts/check_companion.mjs || true
```

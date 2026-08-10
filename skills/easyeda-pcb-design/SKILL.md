---
name: easyeda-pcb-design
description: Guide, create, continue, modify, and review schematic-only, PCB-only, or end-to-end designs in EasyEDA Pro (嘉立创EDA专业版). Use when starting from zero; verifying or modifying an existing schematic; creating a PCB from an existing schematic; continuing placement, routing, or copper on an unfinished PCB; reviewing or repairing a routed PCB; or checking ERC, DRC, DFM, and manufacturing outputs. Covers ordinary MCU, sensor, analog, power, control, and breakout boards; switching regulators; ADC/DAC and mixed-signal layouts; BGA, HDI, fine-pitch escape, stackup and materials; onboard antennas and RF modules; and controlled-impedance or high-speed USB, Ethernet, LVDS, HDMI, PCIe, DDR, SDIO, QSPI, RF, clock, differential-pair, SI, and EMC work. Load only the workflow and specialization required by the selected entry state and scope. Do not use for KiCad, Altium, OrCAD, or other non-EasyEDA tools.
---

# EasyEDA PCB Design

Lead intent through implementation; explain decisions and close with audits.

**A clean DRC/audit is not a fabrication release.** Never claim readiness from script output alone.

## Select entry state, scope, and mode

Identify what already exists before choosing a workflow:

1. **No design** — start from requirements; for live writes use new construction
   and stop at the user's requested scope.
2. **Existing schematic** — review/modify it, or close its handoff and create the PCB.
3. **Unfinished PCB** — bind and assess the existing PCB, then continue its
   incomplete placement, routing, or copper work without replaying construction.
4. **Routed PCB** — review it or use bounded existing-board repair. If schematic
   identity or synchronization is stale, return through the handoff gate first.

Treat an existing but incomplete PCB as **PCB continuation**, not repair. Treat
local replacement of already-committed geometry on a routed board as repair.

Then select the target scope:

1. **Schematic only** — guide, create, modify, or review a schematic. Stop at
   schematic verification and the handoff gate; do not start PCB work.
2. **PCB only** — place, route, modify, or review a PCB from an existing
   schematic and its handoff record. Do not silently redesign the schematic.
3. **End to end** — complete both scopes in order and close the handoff gate
   before PCB implementation.

Honor a scope explicitly named by the user. If the request is ambiguous, choose
the narrowest scope that satisfies it and state what remains outside scope.
Scope never implies completion: a cleared schematic is not a cleared PCB, and a
cleared PCB is not a fabrication release.

Choose the mode from the user's outcome:

1. **Guide** — develop requirements, architecture, layout, or tradeoffs and give
   the next concrete design action. Use audits only when they answer the request.
2. **Build or modify** — follow the design sequence, implement approved choices,
   and verify each completed phase.
3. **Review or release** — inspect the exact revision within the selected scope,
   run applicable audits, explain findings and evidence, and use the natural
   review conclusion contract. Treat any fabrication/order-readiness question
   as an end-to-end formal review.

When the request spans modes, design first, implement second, and review last.
Do not use PASS/FAIL language for ordinary guidance or work in progress.

## Follow the selected lifecycle

Read [references/workflows/entry-routing.md](references/workflows/entry-routing.md) for entry-state routing,
scope boundaries, the structured requirements/primary-functions baseline,
handoff, change propagation, and live gates.
Then load:

- **Schematic only:** [references/workflows/schematic-workflow.md](references/workflows/schematic-workflow.md).
- **PCB only, including continuation:** [references/workflows/pcb-workflow.md](references/workflows/pcb-workflow.md),
  [references/layout/constraint-planning.md](references/layout/constraint-planning.md), and
  [references/layout/layout-rules.md](references/layout/layout-rules.md).
- **End to end:** both workflow references in order; close the handoff gate
  before loading placement/routing details.

For existing-design review, use that scope's review branch. A schematic-only review may assess
electrical intent, parts, ERC, and handoff readiness, but must not infer PCB
placement, routing, copper, mechanical closure, or manufacturing readiness.

At each phase, state the decision, its basis, any assumption, and the next gate.
Proceed with a labeled reversible assumption; stop when a missing choice could
materially change architecture, safety, mechanics, or fabrication.
Follow feasible explicit placement requirements. If one is infeasible, show the
specific conflict and propose alternatives instead of silently accepting or
overriding it.

## Select the authorization profile

Before live mutation, select and record one project-scoped profile:

- **USER_OWNED** (default) — require operation-specific confirmation for
  destructive or bulk changes.
- **AI_DEDICATED** — only when the user explicitly states that the current
  project/revision is AI-controlled or grants full project design authority.
  Treat that statement as standing authorization for project-local design
  mutations within the stated objective; do not repeatedly ask before ordinary
  placement, routing, via, save, or derived-copper regeneration operations.

Authorization never replaces UUID binding, semantic capture, rollback planning,
saved-design readback, netlist parity, DRC, or exact-revision evidence. Neither
profile authorizes deleting the only recoverable project/revision, account or
team administration, sharing/publishing, fabrication release, ordering, or
payment. Read [references/workflows/live-build-gates.md](references/workflows/live-build-gates.md)
for the operation classes and evidence required by each profile.

## Use the EasyEDA companion for live work

Use `easyeda-api` (EasyEDA API skill / bridge) for every live EasyEDA operation.
The sole exception is final-named project creation through UI after a documented
API non-commit and explicit user authorization; return immediately to companion
UUID binding and semantic readback before any design edit.
Read [references/api/api-map.md](references/api/api-map.md), the exact companion API
documentation, and [references/workflows/live-build-gates.md](references/workflows/live-build-gates.md)
before a live build or substantial modification. Classify the transaction as
**new construction**, **existing-schematic modification**, **existing-board
continuation**, or **existing-board repair** before applying a gate. First run:

```bash
node scripts/check_companion.mjs
```

Require exit code `0` and `ready: true`; otherwise stop. Confirm project and
document UUIDs before writes, await every operation, and trust semantic readback
from the saved/reopened design rather than a truthy return.
For a no-design live build, close the project-creation/binding gate in
`live-build-gates.md` before schematic construction; project creation is itself
a beta document-tree transaction and cannot be treated as an unqualified setup
step.

Advance only gates required by the selected scope; schematic-only work stops
after schematic verification. For modification, continuation, or repair, bind
the exact revision and apply its routed evidence/readback state machine.
Continuation requires a current handoff/synchronization baseline and changes
only declared incomplete work; repair proves pre/post manufacturing-netlist
parity. The semantic-capture helper is neither a restorable backup nor
authorization. Under `AI_DEDICATED`, retained source Pours plus semantic capture
may close pre-edit evidence for fill-only regeneration. Do not retroactively
apply construction gates unless the edit crosses into new construction.
Qualify unknown/beta writes in a probe project, keep the UUID manifest, and
allow at most one active diagnostic candidate.

`importChanges()` and `setNetlist()` are separate bulk operations requiring
profile authorization, preflight evidence, and post-operation readback. Use
visual inspection for confirmation, not primary construction.
If EasyEDA's beta document comparator alone remains stale after saved/reopened
readback, use only the strict multi-view false-negative contract in
`live-build-gates.md`; manufacturing equality by itself is never sufficient.

## Protect user work

Under `USER_OWNED`, require explicit confirmation before deletion, mass net
changes, bulk overwrite/synchronization, forced output overwrite, or a copper
rebuild that could discard work. Under `AI_DEDICATED`, standing authorization
covers project-local mutations within the design objective, but high-risk source
or identity changes still require stronger rollback evidence and bounded
readback. Regenerating derived Poured fills while retaining the exact source
Pour definitions requires semantic capture, exact-ID binding, one rebuild, save,
and readback/DRC; it does not require a separate native duplicate. Never delete
the only recoverable project/revision or call a manufacturing order API.

## Classify technical depth

1. **Baseline** — ordinary boards without controlled-impedance needs.
2. **Controlled/high-speed** — differential pairs, target impedance, USB2,
   Ethernet, LVDS, or transmission-line behavior from fast edges.
3. **High-risk SI** — USB 3.x, PCIe, DDR, multi-gigabit, RF launches, dense
   escape, or solver/eye/S-parameter requirements.

If uncertain, do not downgrade. High-speed candidates require the high-speed
path; baseline audit alone remains `UNVERIFIED FOR FABRICATION`. Classification
adds guidance but never replaces the baseline lifecycle.

## Load only relevant guidance

Load only what the task needs:

- Entry-state selection, scope, requirements baseline, primary-function
  confirmation, handoff, or cross-scope change:
  [references/workflows/entry-routing.md](references/workflows/entry-routing.md)
- Schematic creation, modification, or schematic-only review:
  [references/workflows/schematic-workflow.md](references/workflows/schematic-workflow.md)
- Schematic functional layout, label/port usage, readability regression, or
  handoff presentation closure:
  [references/workflows/schematic-presentation.md](references/workflows/schematic-presentation.md)
- Part selection, parameters, suitability, source access, exact-MPN/library
  binding, missing-library handling, or substitution:
  [references/workflows/component-selection-evidence.md](references/workflows/component-selection-evidence.md)
- Component-class parameter coverage:
  [references/workflows/component-parameter-profiles.md](references/workflows/component-parameter-profiles.md)
- PCB creation from a schematic, unfinished-PCB continuation, repair, or review:
  [references/workflows/pcb-workflow.md](references/workflows/pcb-workflow.md). For creation,
  also load the three schematic handoff references above.
- Place/route/copper and assembly closure:
  [references/layout/constraint-planning.md](references/layout/constraint-planning.md),
  [references/layout/layout-rules.md](references/layout/layout-rules.md), and
  [references/layout/placement-closure.md](references/layout/placement-closure.md)
- Requirement-to-layer-count selection, layer roles, materials, or reference assignment:
  [references/layout/stackup-planning.md](references/layout/stackup-planning.md)
- Switching regulator or power stage: [references/layout/power-layout.md](references/layout/power-layout.md)
- ADC, DAC, reference, or mixed-signal partition:
  [references/layout/mixed-signal-layout.md](references/layout/mixed-signal-layout.md)
- BGA, HDI, fine-pitch escape, or via-in-pad:
  [references/specialized/bga-hdi.md](references/specialized/bga-hdi.md)
- Live API/build: [references/api/api-map.md](references/api/api-map.md),
  [references/workflows/live-build-gates.md](references/workflows/live-build-gates.md), and exact
  `easyeda-api` docs
- Finish/review: [references/workflows/review-checklist.md](references/workflows/review-checklist.md)
- PCB DRC evidence:
  [references/workflows/drc-evidence-closure.md](references/workflows/drc-evidence-closure.md)
- Manufacturing export/regression: [references/api/manufacturing-output.md](references/api/manufacturing-output.md)
- Crystal/resonator loop: [references/specialized/crystal-clock-audit.md](references/specialized/crystal-clock-audit.md)
- Integrated-module or host-board PCB antenna, including mandatory
  numbered-pad-to-board-edge direction closure: [references/specialized/onboard-antenna.md](references/specialized/onboard-antenna.md)
- Controlled/high-speed: [references/high-speed/high-speed-workflow.md](references/high-speed/high-speed-workflow.md)
  and [references/high-speed/impedance-and-vias.md](references/high-speed/impedance-and-vias.md)
- HS audit: [references/high-speed/high-speed-constraints.md](references/high-speed/high-speed-constraints.md)
- Named interface only: matching section of [references/high-speed/protocol-profiles.md](references/high-speed/protocol-profiles.md)
- PDN/ESD/EMC claims: [references/specialized/pdn-emc.md](references/specialized/pdn-emc.md)
- Edge-rate, trace-resistance, or skin-depth screening:
  [references/supporting/screening-calculations.md](references/supporting/screening-calculations.md)
- Cross-domain worked example or request for a full example:
  [references/supporting/worked-example-constraint-driven-board.md](references/supporting/worked-example-constraint-driven-board.md)
- Change HS audit code: [references/api/high-speed-api-map.md](references/api/high-speed-api-map.md)
- Formulas/attribution: [references/supporting/sources.md](references/supporting/sources.md)

Do not load audit implementation references for a design-guidance question.
Do not load high-speed material for a confirmed baseline design. Never use
certification language without the required measurement/compliance evidence.

## Use audits for design closure

Run audits after each relevant phase, invalidating change, or review request. Read
[references/workflows/review-checklist.md](references/workflows/review-checklist.md) before a formal
review.

Baseline schematic or PCB audit, limited to the active document and selected
scope:

```bash
node scripts/easyeda_design_audit.mjs \
  --ground-net GND \
  --placement-audit-report placement-closure.json \
  --high-speed-constraints high-speed-constraints.json \
  --output design-audit.json
```

Any `--allow-*` exception requires a specific engineering note. Do not use an
exception to silence an unexplained result. Read each report's limitations;
geometry checks do not prove electrical, mechanical, or manufacturing intent.

Use the specialized tools only when applicable:

- `easyeda_stackup_decision_lint.py` after comparing stackups, then
  `easyeda_constraint_lint.py` before placement and after invalidating changes;
- `easyeda_placement_audit.mjs` after placement and before routing, then after
  every component, footprint, pad, via, interface, process, or access change;
- `easyeda_crystal_clock_audit.mjs` for passive crystal/resonator loops;
- `pcb_calc.py` for geometry, edge-rate, resistance, and conductor screening;
- `easyeda_high_speed_audit.mjs` for controlled/high-speed work;
- `easyeda_manufacturing_audit.py` after API-exporting Gerber/drill, BOM, and PnP.

Load each tool's routed reference. Bind reports to the revision. For PCB
DRC, follow `drc-evidence-closure.md`; geometry or rule changes stale prior
evidence. Calculators are estimates, not fabricator/solver evidence.

Evidence closes a gate only with a recognized status and an existing artifact,
or with the human-attestation mechanism defined in the relevant reference.
Agents must never set the attestation environment variable or write the human
attestation file. Missing evidence stays `UNVERIFIED FOR FABRICATION`.

## Report review results naturally

For every concluded audit or review, write a concise engineering explanation,
not a field-by-field status block. Cover all of the following in connected prose
or short findings:

1. identify the exact revision and reviewed scope;
2. lead with whether the reviewed scope is clear, has blocking findings, or
   lacks enough evidence for a conclusion;
3. explain the material findings in severity order and cite the evidence or
   observation behind each one;
4. name assumptions, exceptions, and everything outside the selected scope;
5. state the next concrete action.

For schematic-only review, explicitly explain that PCB placement, routing,
copper, mechanics, and manufacturing outputs were not reviewed. A schematic
may be clear within its scope or suitable for PCB handoff without implying that
the board is ready to fabricate.

For fabrication/order-readiness questions, include the controlled decision in
a natural sentence using exactly `PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS`,
`FAIL`, or `UNVERIFIED FOR FABRICATION`. Also say plainly which manufacturing
outputs were reviewed, whether required high-speed evidence is present, and
that the result is not authorization to fabricate or place an order. Missing
design files, outputs, constraints, evidence, or companion access yields
`UNVERIFIED FOR FABRICATION` with the missing item and next step explained.

Machine-readable audit artifacts must retain `fabricationRelease: false` and
their existing decision fields. Do not reproduce those fields verbatim in the
user-facing response unless the user requests raw audit output. Do not append a
formal conclusion to ordinary guidance or intermediate build updates.

After changing this skill:

```bash
node scripts/easyeda_audit_tests.mjs
node scripts/requirements_baseline_lint.mjs --self-test
node scripts/component_selection_evidence.mjs --self-test
node scripts/easyeda_identity_preflight.mjs --self-test
node scripts/easyeda_revision_guard.mjs --self-test
node scripts/easyeda_repair_snapshot.mjs --self-test
node scripts/easyeda_placement_audit.mjs --self-test
node scripts/easyeda_crystal_clock_audit.mjs --self-test
python3 scripts/pcb_calc_tests.py
python3 scripts/easyeda_stackup_decision_lint.py --self-test
python3 scripts/easyeda_constraint_lint.py --self-test
python3 scripts/easyeda_manufacturing_audit.py --self-test
node scripts/check_companion.mjs || true
```

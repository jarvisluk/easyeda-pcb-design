---
name: easyeda-pcb-design
description: Guide, create, continue, modify, and review schematic-only, PCB-only, or end-to-end designs in EasyEDA Pro. Chinese triggers include 嘉立创EDA专业版、EasyEDA专业版、原理图设计/检查、PCB布局/布线/铺铜、继续未完成PCB、审板、ERC/DRC/DFM、投板/下单前检查、高速/阻抗/射频/天线设计. Use when starting from zero; verifying or modifying an existing schematic; creating a PCB from an existing schematic; continuing placement, routing, or copper on an unfinished PCB; reviewing or repairing a routed PCB; or checking ERC, DRC, DFM, and manufacturing outputs. Covers ordinary MCU, sensor, analog, power, control, and breakout boards; switching regulators; ADC/DAC and mixed-signal layouts; BGA, HDI, fine-pitch escape, stackup and materials; onboard antennas and RF modules; and controlled-impedance or high-speed USB, Ethernet, LVDS, HDMI, PCIe, DDR, SDIO, QSPI, RF, clock, differential-pair, SI, and EMC work. Load only the workflow and specialization required by the selected entry state and scope. Do not use for KiCad, Altium, OrCAD, or other non-EasyEDA tools.
---

# EasyEDA PCB Design

Lead intent through implementation; explain decisions and close with audits.

**A clean DRC/audit is not a fabrication release.** Never claim readiness from script output alone.

## Follow the complete design pipeline

Every task is a slice of one pipeline. Know the whole sequence, then run only the
phases the task owns. Each phase closes on evidence bound to the exact revision,
and no later phase closes an earlier one.

| # | Phase | Closes on | Primary reference |
| --- | --- | --- | --- |
| 1 | Intake, requirements baseline, core-part research, primary-function confirmation | `PRIMARY_FUNCTIONS_CONFIRMED` with a cleared baseline lint report | `entry-routing.md` |
| 2 | Architecture, exact part/variant choice, sourced parameters, library binding | cleared component-selection evidence record | `component-selection-evidence.md` |
| 3 | Schematic implementation, one functional block at a time | `SCHEMATIC_IDENTITY_STABLE` after the first-block canary | `schematic-workflow.md`, `schematic-presentation.md` |
| 4 | Schematic verification: ERC, presentation screen, netlist identity, footprint/pad map | `SCHEMATIC_VERIFIED` | `schematic-workflow.md` |
| 5 | Schematic-to-PCB handoff | handoff record bound to the saved schematic revision | `entry-routing.md` |
| 6 | Outline, stackup, constraints, floorplan, PCB creation and synchronization | `CLEARED_FOR_PLACEMENT`, then `PCB_SYNC_MATCH` | `constraint-planning.md`, `stackup-planning.md`, `pcb-workflow.md` |
| 7 | Placement | `PLACEMENT_CLEAR_FOR_ROUTING` | `placement-closure.md` |
| 8 | Routing | `ROUTING_CANARY_CLEAR`, then `FULL_ROUTING_CLEAR` | `layout-rules.md` |
| 9 | Copper and stitching | `COPPER_CANARY_CLEAR` plus complete filled-region readback | `layout-rules.md`, `pcb-workflow.md` |
| 10 | PCB verification and DRC closure | `DESIGN_CLOSURE` | `drc-evidence-closure.md`, `review-checklist.md` |
| 11 | Manufacturing export and review, only when requested | a review conclusion, never a fabrication release | `manufacturing-output.md` |

The gate names above are the new-construction sequence. Modification,
continuation, and repair reach the same phases through their own branch gates in
`live-build-gates.md`; use that branch's names rather than forcing a
construction gate into its ledger.

At each phase state the decision, its basis, any assumption, and the next gate.
Proceed with a labeled reversible assumption; stop when a missing choice could
materially change architecture, safety, mechanics, or fabrication. Follow feasible
explicit placement requirements. If one is infeasible, show the specific conflict
and propose alternatives instead of silently accepting or overriding it.

## Take only the slice the task needs

Task type changes where you enter the pipeline, where you stop, and whether you
write. It never reorders the phases and never lets one close without its own
evidence.

**Entry state sets the first phase you own.** Inspect the live design rather than
trusting the request wording or a document name.

| Entry state | Enter at | Live branch |
| --- | --- | --- |
| No design | phase 1 | new construction |
| Existing schematic | phase 4 to verify, phase 3 for a bounded edit, phase 5 to hand off | existing-schematic modification |
| Unfinished PCB | bind and baseline, then the first incomplete gate in phases 6-10 | existing-board continuation |
| Routed PCB | the phase owning the committed geometry, after re-proving phase 5 currency | existing-board repair |

Never replay construction for work whose exact-revision evidence is still valid,
and never assume phase 5 currency: stale schematic identity or synchronization
sends continuation and repair back through the handoff before geometry work.
Entry state limits where you *write*, never how far a review must *read*.

**Scope sets the last phase you own.** Schematic only stops after phase 5 and
never starts PCB work. PCB only begins from an existing schematic and its bound
handoff record without silently redesigning the schematic. End to end runs phases
1-10 in order. Phase 11 is added only on explicit request, except that a
fabrication or order-readiness question puts phases 1-11 in review scope by
itself: inventory the upstream requirements, part-evidence, schematic, and
handoff evidence too, however late the board's entry state is, and treat absent
manufacturing outputs as a finding rather than as out of scope.

Honor a scope explicitly named by the user. If the request is ambiguous, choose
the narrowest scope that satisfies it and state what remains outside scope.
Scope never implies completion: a cleared schematic is not a cleared PCB, and a
cleared PCB is not a fabrication release.

**Mode sets what you do inside the slice:**

1. **Guide** — develop requirements, architecture, layout, or tradeoffs and give
   the next concrete design action. Name the artifact the next phase needs rather
   than authoring it, until the user asks to start that phase. Use audits only
   when they answer the request.
2. **Build or modify** — implement approved choices phase by phase and close each
   gate on readback evidence.
3. **Review or release** — write nothing, bind the exact revision, inventory the
   evidence for the phases in scope, run the applicable audits, and use the
   natural review conclusion contract. Treat any fabrication/order-readiness
   question as an end-to-end formal review.

When the request spans modes, design first, implement second, and review last.

Read [references/workflows/entry-routing.md](references/workflows/entry-routing.md)
for entry classification, scope boundaries, the structured
requirements/primary-functions baseline, the handoff contract, and change
propagation; then load the phase references your slice actually reaches from the
routing list below. A schematic-only review may assess electrical intent, parts,
ERC, and handoff readiness, but must not infer PCB placement, routing, copper,
mechanics, or manufacturing readiness.

## Use the EasyEDA companion for live work

Use `easyeda-api` (EasyEDA API skill / bridge) for every live EasyEDA operation.
The sole exception is final-named project creation through UI after a documented
API non-commit and an operation-specific confirmation for one UI creation
attempt; return immediately to companion UUID binding and semantic readback
before any design edit. Read
[references/api/api-map.md](references/api/api-map.md), the exact companion API docs, and
[references/workflows/live-build-gates.md](references/workflows/live-build-gates.md) before a live
build or substantial modification. Its state machines are the live enforcement of
the same pipeline: run the branch matching the entry state above, over the phases
your scope owns. First run:

```bash
node scripts/live/check_companion.mjs
```

Require exit code `0` and `ready: true`; otherwise stop. Confirm project and
document UUIDs before writes, await every operation, and trust semantic readback
from the saved/reopened design over a truthy return. For a no-design live build,
close the project-creation/binding gate before schematic construction; project
creation is itself a beta document-tree transaction, not setup.

Record every gate transition in the ledger and operation log defined in
`live-build-gates.md`, require `CLEARED` from `easyeda_gate_ledger.mjs` before
advancing or claiming closure, and pass that report to the baseline audit with
`--gate-ledger`. A gate you did not close in the ledger is open, however the
work reads in prose. The ledger orders live gates only, and a read-only review
uses the `read-only-review` branch.

The ledger reports integrity (`decision`) and slice completion (`completion`)
separately. `CLEARED` with `INCOMPLETE` is the honest state of work in progress:
report it with its remaining gates, as neither a closure nor a failure. The
baseline audit keeps an incomplete or axis-less ledger
`UNVERIFIED FOR FABRICATION`, so never relabel scope or branch to move the
terminal gate closer.

Advance only the gates your slice owns; schematic-only work stops after phase 4
verification and its handoff. For modification, continuation, or repair, bind the
exact revision and apply that branch's evidence/readback state machine.
Continuation requires a current handoff/synchronization baseline and changes only
declared incomplete work; repair proves pre/post manufacturing-netlist parity.
The semantic-capture helper is neither a restorable backup nor authorization. Do
not retroactively apply construction gates unless the edit crosses into new
construction. Qualify unknown/beta writes in a probe project, keep the UUID
manifest, and allow at most one active diagnostic candidate.

Regenerating derived Poured fills while retaining the exact source Pour
definitions requires semantic capture, exact-ID binding, one rebuild, save, and
readback/DRC. `importChanges()` and `setNetlist()` are separate bulk operations:
run them only when the selected live branch requires them or an
operation-specific confirmation is recorded, and only after preflight evidence
and post-operation readback. Use visual inspection for confirmation, not primary
construction. If EasyEDA's beta document comparator alone remains stale after
saved/reopened readback, use only the strict multi-view false-negative contract
in `live-build-gates.md`; manufacturing equality by itself is never sufficient.

## Classify technical depth

Each tier adds a constraint record, an audit, and a minimum evidence strength on
top of the baseline lifecycle. Tiers are cumulative:

| Tier | Trigger | Adds | Strongest gate |
| --- | --- | --- | --- |
| Baseline | no differential pair, target impedance, or transmission-line behavior | nothing beyond the baseline workflow and `easyeda_design_audit.mjs`; no constraint record, no high-speed reference | ordinary DRC and placement closure |
| Controlled/high-speed | differential pairs, target impedance, USB2, Ethernet, LVDS, fast-edge transmission-line behavior | a revision-controlled `CONTROLLED_HIGH_SPEED` record, the placement/routing/return-path extensions, and `easyeda_high_speed_audit.mjs` beside the baseline audit | impedance needs `FAB_CONFIRMED`, `SOLVER_VERIFIED`, or `MEASUREMENT_VERIFIED`; `ANALYTICAL_ESTIMATE` cannot close it |
| High-risk SI | USB 3.x, PCIe, DDR, HDMI, SerDes, MIPI CSI/DSI, SATA, DisplayPort, `dataRateGbps >= 1`, RF launch, dense BGA escape or via field, or a stated eye-mask, S-parameter, loss, crosstalk, TDR, or VNA requirement | `HIGH_RISK_SI` plus a mandatory `solverOrMeasurement` gate | only `SOLVER_VERIFIED` or `MEASUREMENT_VERIFIED` closes it, however clean the geometry is |

The audit auto-promotes tier 2 to tier 3 from interface name, data rate, declared
launches, and stated validation requirements, so a record still claiming
`CONTROLLED_HIGH_SPEED` for a promoted interface fails constraint completeness.
A host-board RF feed or custom PCB antenna is always high-risk SI; an integrated
module antenna with no host RF feed is not, but still needs the antenna reference.

If uncertain, do not downgrade. Above baseline, a baseline audit alone remains
`UNVERIFIED FOR FABRICATION`. Classification adds requirements but never
replaces the baseline lifecycle.

## Load only relevant guidance

Pipeline references, loaded for the phases your slice reaches:

- Phases 1 and 5, and any cross-scope change — entry state, scope, requirements
  baseline, primary-function confirmation, handoff:
  [references/workflows/entry-routing.md](references/workflows/entry-routing.md)
- Phase 2 — part selection, parameters, suitability, source access,
  exact-MPN/library binding, missing-library handling, or substitution:
  [references/workflows/component-selection-evidence.md](references/workflows/component-selection-evidence.md);
  component-class parameter coverage:
  [references/workflows/component-parameter-profiles.md](references/workflows/component-parameter-profiles.md)
- Phases 3 and 4 — schematic creation, modification, or schematic-only review:
  [references/workflows/schematic-workflow.md](references/workflows/schematic-workflow.md);
  functional layout, labels/ports, readability, handoff presentation:
  [references/workflows/schematic-presentation.md](references/workflows/schematic-presentation.md)
- Phases 6 to 10 — PCB creation from a schematic, unfinished-PCB continuation,
  repair, or review:
  [references/workflows/pcb-workflow.md](references/workflows/pcb-workflow.md). For creation or
  end-to-end review, also load the phase 2 to 4 references above.
- Phase 6 — constraints and floorplan closure:
  [references/layout/constraint-planning.md](references/layout/constraint-planning.md);
  layer count/roles, materials, references:
  [references/layout/stackup-planning.md](references/layout/stackup-planning.md)
- Phases 7 to 9 — place/route/copper and assembly closure:
  [references/layout/layout-rules.md](references/layout/layout-rules.md) and
  [references/layout/placement-closure.md](references/layout/placement-closure.md)
- Phase 10 — finish/review:
  [references/workflows/review-checklist.md](references/workflows/review-checklist.md); PCB DRC
  evidence: [references/workflows/drc-evidence-closure.md](references/workflows/drc-evidence-closure.md)
- Phase 11 — manufacturing export/regression:
  [references/api/manufacturing-output.md](references/api/manufacturing-output.md)
- Any live phase — [references/api/api-map.md](references/api/api-map.md),
  [references/workflows/live-build-gates.md](references/workflows/live-build-gates.md), and exact
  `easyeda-api` docs

Specialized references, added to the phases they touch only when the design
requires them:

- Switching regulator or power stage: [references/layout/power-layout.md](references/layout/power-layout.md)
- ADC, DAC, reference, or mixed-signal partition:
  [references/layout/mixed-signal-layout.md](references/layout/mixed-signal-layout.md)
- BGA, HDI, fine-pitch escape, or via-in-pad:
  [references/specialized/bga-hdi.md](references/specialized/bga-hdi.md)
- Crystal/resonator loop: [references/specialized/crystal-clock-audit.md](references/specialized/crystal-clock-audit.md)
- Module or host-board PCB antenna, including mandatory numbered-pad-to-board-edge
  direction closure: [references/specialized/onboard-antenna.md](references/specialized/onboard-antenna.md).
  Load it as soon as the phase 1 `RADIO_ANTENNA` decision is anything but a
  sourced `NOT_APPLICABLE`, not only at layout.
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

Do not load audit implementation references for a design-guidance question, or
high-speed material for a confirmed baseline design. For review, load in the stages
defined in `review-checklist.md` rather than every reference at once: inventory the
evidence first, then load only the reference behind an actual finding. Never use
certification language without the required measurement/compliance evidence.

## Use audits for design closure

Run audits after each relevant phase, invalidating change, or review request. Read
[references/workflows/review-checklist.md](references/workflows/review-checklist.md) before a formal review.

Baseline schematic or PCB audit, limited to the active document and scope:

```bash
node scripts/audits/easyeda_design_audit.mjs \
  --ground-net GND \
  --schematic-page-envelope schematic-page-envelope.json \
  --placement-audit-report placement-closure.json \
  --high-speed-constraints high-speed-constraints.json \
  --gate-ledger gate-ledger-check.json \
  --output design-audit.json
```

Omit a flag whose artifact the scope cannot produce: a schematic-only audit has no
placement or PCB constraint artifact. When the scope does require an artifact that
was never authored, author it from sources or report it absent; omitting the flag
is not a substitute. Any schematic scope can produce the page-envelope record, so
author it during page partition; without it, symbols drawn off the page stay
undetectable and the schematic result stays `UNVERIFIED FOR FABRICATION`. Any `--allow-*` exception requires a specific engineering
note, never to silence an unexplained result. Read each report's limitations;
geometry checks do not prove electrical, mechanical, or manufacturing intent.

Use the remaining tools at their owning phase, and only when applicable:

- phase 1: `requirements_baseline_lint.mjs` after intake and again after
  core-part research;
- phase 2: `component_selection_evidence.mjs` for the part evidence record;
- phase 6: `easyeda_stackup_decision_lint.py` after comparing stackups, then
  `easyeda_constraint_lint.py` before placement and after invalidating changes;
- phase 7: `easyeda_placement_audit.mjs` after placement and before routing, then
  after every component, footprint, pad, via, interface, process, or access
  change; its `--print-fingerprint` supplies the constraint `revision` for an
  existing board;
- any phase: `pcb_calc.py` for geometry, edge-rate, resistance, and conductor
  screening; `easyeda_crystal_clock_audit.mjs` for passive crystal/resonator
  loops; `easyeda_high_speed_audit.mjs` for controlled/high-speed work;
- phase 11: `easyeda_manufacturing_audit.py` after API-exporting Gerber/drill,
  BOM, and PnP; set `--expected-copper-layers` for the real stackup, as it
  defaults to 2.

Load each tool's routed reference. Bind reports to the revision. For PCB DRC,
follow `drc-evidence-closure.md`; geometry or rule changes stale prior evidence.
Calculators are estimates, not fabricator/solver evidence.

Evidence closes a gate only with a recognized status and an existing artifact, or
with the human-attestation mechanism defined in the relevant reference. Agents must
never set the attestation environment variable or write the attestation file.
Missing evidence stays `UNVERIFIED FOR FABRICATION`.

## Report review results naturally

For every concluded audit or review, write a concise engineering explanation, not
a field-by-field status block. Cover all of the following in connected prose or
short findings:

1. identify the exact revision and reviewed scope;
2. lead with whether the reviewed scope is clear, has blocking findings, or
   lacks enough evidence for a conclusion;
3. explain the material findings in severity order and cite the evidence or
   observation behind each one;
4. name assumptions, exceptions, and everything outside the selected scope;
5. state the next concrete action.

If the work has not reached its slice's terminal gate, say so and name the open
gates. "Phases 1-7 closed, routing next" is a correct result; the same work
presented as a finished design is not, and an unfinished slice is not a failure.

For schematic-only review, explicitly explain that PCB placement, routing, copper,
mechanics, and manufacturing outputs were not reviewed. A schematic may be clear
within its scope or ready for PCB handoff without implying a fabricable board.

For fabrication/order-readiness questions, include the controlled decision in a
natural sentence using exactly `PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS`,
`FAIL`, or `UNVERIFIED FOR FABRICATION`. Also say plainly which manufacturing
outputs were reviewed, whether required high-speed evidence is present, and that
the result is not authorization to fabricate or order. Missing design files,
outputs, constraints, evidence, or companion access yields
`UNVERIFIED FOR FABRICATION` with the missing item and next step explained.
`PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS` covers reviewed evidence that
carries a stated engineering assumption or exception; a required artifact that is
absent, stale, or unreadable is missing evidence and may never be relabeled as a
documented assumption or exception to reach it.

Machine-readable audit artifacts must retain `fabricationRelease: false` and their
existing decision fields. Do not reproduce those fields verbatim unless the user
requests raw audit output, and do not append a formal conclusion to ordinary
guidance or intermediate build updates.

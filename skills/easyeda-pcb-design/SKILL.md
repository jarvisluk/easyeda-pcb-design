---
name: easyeda-pcb-design
description: Guide, create, continue, modify, and review schematic-only, PCB-only, or end-to-end designs in EasyEDA Pro. Chinese triggers include 嘉立创EDA专业版、EasyEDA专业版、原理图设计/检查、PCB布局/布线/铺铜、继续未完成PCB、审板、ERC/DRC/DFM、投板/下单前检查、高速/阻抗/射频/天线设计. Use when starting from zero; verifying or modifying an existing schematic; creating a PCB from an existing schematic; continuing placement, routing, or copper on an unfinished PCB; reviewing or repairing a routed PCB; or checking ERC, DRC, DFM, and manufacturing outputs. Covers ordinary MCU, sensor, analog, power, control, and breakout boards; switching regulators; ADC/DAC and mixed-signal layouts; BGA, HDI, fine-pitch escape, stackup and materials; onboard antennas and RF modules; and controlled-impedance or high-speed USB, Ethernet, LVDS, HDMI, PCIe, DDR, SDIO, QSPI, RF, clock, differential-pair, SI, and EMC work. Load only the workflow and specialization required by the selected entry state and scope. Do not use for KiCad, Altium, OrCAD, or other non-EasyEDA tools.
---

# EasyEDA PCB Design

Lead intent through implementation and close each owned phase on exact-revision
evidence. A clean audit or DRC is never authorization to fabricate or order.

## Follow the lifecycle

Run only the slice the task owns, in lifecycle order. A later gate never closes
an earlier one.

| Phase | Closure | Route |
| --- | --- | --- |
| Requirements and primary functions | `PRIMARY_FUNCTIONS_CONFIRMED` | `entry-routing.md` |
| Part selection and library binding | cleared component evidence | `component-selection-evidence.md` |
| Schematic build and verification | `SCHEMATIC_IDENTITY_STABLE`, `SCHEMATIC_VERIFIED` | `schematic-workflow.md` |
| Schematic-to-PCB handoff | exact-revision handoff | `entry-routing.md` |
| Outline, stackup, constraints, sync | `CLEARED_FOR_PLACEMENT`, `PCB_SYNC_MATCH` | `constraint-planning.md`, `pcb-workflow.md` |
| Placement | `PLACEMENT_CLEAR_FOR_ROUTING` | `placement-closure.md` |
| Routing and copper | canary gates, then full closure | `layout-rules.md` |
| PCB verification | `DESIGN_CLOSURE` | `drc-evidence-closure.md` |
| Manufacturing review, when requested | review conclusion only | `manufacturing-output.md` |

At every phase state the decision, evidence, assumptions, and next gate. A
reversible assumption may be labeled and carried; stop when a missing decision
could materially change architecture, safety, mechanics, or fabrication. Honor
feasible explicit placement requirements. If one conflicts, show the constraint
and alternatives instead of silently overriding it.

## Select entry, scope, and mode

Inspect live state rather than trusting names or request wording.

| Entry | Start | Live branch |
| --- | --- | --- |
| No design | requirements | new construction |
| Existing schematic | verify, edit, or handoff | existing-schematic modification |
| Unfinished PCB | bind baseline, then first incomplete gate | existing-board continuation |
| Committed PCB geometry | re-prove handoff, then owning gate | existing-board repair |

Never replay valid work, but never assume the handoff is current. Stale identity
or synchronization sends PCB work back through handoff. Continuation changes
only declared incomplete work; committed deletion or replacement is repair.

Scope sets the endpoint:

- **Schematic only** stops at handoff and makes no PCB claim.
- **PCB only** starts from a bound schematic handoff and does not silently
  redesign schematic intent.
- **End to end** runs requirements through PCB closure.
- **Manufacturing/order readiness** adds manufacturing review and inventories
  all upstream requirements, part evidence, schematic, and handoff evidence even
  when entry is late. Its read scope starts at phase 1 requirements and ends at
  manufacturing review, even for a routed board.

Use the narrowest scope that satisfies an ambiguous request and name exclusions.
Mode is **guide** (decisions and next artifact), **build/modify** (approved writes
plus gate closure), or **review/release** (read-only evidence inventory and
audits). When mixed, guide, build, then review.

Always read
[entry-routing.md](references/workflows/entry-routing.md) for classification,
requirements, handoff, and change propagation. For live writes also read
[live-build-gates.md](references/workflows/live-build-gates.md).

## Enforce live-operation boundaries

Use the `easyeda-api` skill/companion for live EasyEDA work. Read
[api-map.md](references/api/api-map.md),
[tool-library.md](references/api/tool-library.md), the exact companion
class/method docs, and the applicable live branch before writes. First run:

```bash
node scripts/live/check_companion.mjs
```

Require exit `0` and `ready: true`. Bind project/document UUIDs, await every
call, and trust saved/switched/reopened semantic readback over return values.
Qualify unknown beta writes in a non-production probe.

The only UI creation exception is one final-named project attempt after proven
API non-commit and operation-specific confirmation. A read-only UI native
`.epro` export is also allowed when no companion export API exists. Neither
exception permits UI design mutation; return immediately to UUID-bound API
readback.

Every live mutation requires:

- immutable pre-edit semantic evidence and an operation-appropriate inverse or
  separately verified restore path;
- exact UUID and baseline-fingerprint binding;
- an append-only schema-2 operation log with transaction/attempt identity,
  start/end timestamps, measured duration, outcome, progress, and evidence;
- a gate ledger whose integrity is `CLEARED`; `CLEARED` plus `INCOMPLETE` means
  honest work in progress, not closure or failure;
- after placement, a current schema-3 placement report with native board
  containment and no unverified required coverage axis;
- before production routing or destructive repair, a matching native `.epro`
  checkpoint manifest and `NATIVE_RESTORE_MATCH` from a separate probe restore;
- save/switch/reopen, exact-delta readback, repeated detailed DRC, and gate
  verification after the transaction.

Summarize elapsed time with `easyeda_execution_timing.mjs`. Timing is
observational telemetry only: duration may trigger a progress notice, but never
authorizes, blocks, stops, or limits PCB work. Stop only for an applicable
design, authorization, identity, rollback, readback, DRC, or gate condition.
When answering a timing question about live work, state both facts explicitly:
time does not control execution, and the operation log still records start/end
timestamps plus measured duration for every application and verification step.

Use schema-2 JSON plans with `easyeda_transaction.mjs` for route, repair,
placement, outline, and copper instead of per-attempt browser scripts. It must stop at
`TRANSACTION_APPLIED_PENDING_REOPEN`; collect current state with
`inspect_current_state.mjs --with-drc`, then require `TRANSACTION_VERIFIED` from
`verify_gate.mjs` before advancing. Fast no-DRC inspection is preflight only.

Obtain operation-specific confirmation for destructive work outside the chosen
branch, bulk synchronization, mass identity/net changes, forced overwrite, or
other high-risk mutation. Record the user's exact grant as `READ_ONLY` evidence.
`importChanges()` and `setNetlist()` are independent high-risk operations, not a
fallback chain. Preserve the human fabrication boundary, revision manifest,
saved readback, and exact-revision evidence even when simplifying a workflow.

## Classify technical depth

Tiers are cumulative:

| Tier | Trigger | Required evidence |
| --- | --- | --- |
| Baseline | no controlled transmission-line behavior | baseline lifecycle and audits |
| Controlled/high-speed | differential pair, target impedance, USB2, Ethernet, LVDS, or fast-edge line | `CONTROLLED_HIGH_SPEED` constraints plus HS audit; impedance needs fabricator, solver, or measurement evidence |
| High-risk SI | USB3, PCIe, DDR, HDMI, SerDes, MIPI, SATA, DisplayPort, ≥1 Gbps, RF launch/custom antenna, dense BGA escape, or stated eye/S-parameter/TDR/VNA need | `HIGH_RISK_SI`; only solver or measurement evidence closes it |

The HS audit may promote a declared tier. An integrated module antenna without a
host RF feed is not automatically high-risk SI, but still requires its antenna
reference. If uncertain, do not downgrade. Specialized evidence adds to, never
replaces, the baseline lifecycle.

## Route references directly

Load only references needed by the selected slice:

- Part choice/library/substitution:
  [component-selection-evidence.md](references/workflows/component-selection-evidence.md)
  and [component-parameter-profiles.md](references/workflows/component-parameter-profiles.md)
- Schematic build/review:
  [schematic-workflow.md](references/workflows/schematic-workflow.md) and
  [schematic-presentation.md](references/workflows/schematic-presentation.md)
- PCB workflow: [pcb-workflow.md](references/workflows/pcb-workflow.md)
- Constraints/stackup:
  [constraint-planning.md](references/layout/constraint-planning.md) and
  [stackup-planning.md](references/layout/stackup-planning.md)
- Placement/routing/copper:
  [layout-rules.md](references/layout/layout-rules.md) and
  [placement-closure.md](references/layout/placement-closure.md)
- Formal review/DRC:
  [review-checklist.md](references/workflows/review-checklist.md) and
  [drc-evidence-closure.md](references/workflows/drc-evidence-closure.md)
- Manufacturing: [manufacturing-output.md](references/api/manufacturing-output.md)
- Switching power: [power-layout.md](references/layout/power-layout.md)
- ADC/DAC/reference: [mixed-signal-layout.md](references/layout/mixed-signal-layout.md)
- BGA/HDI/fine pitch: [bga-hdi.md](references/specialized/bga-hdi.md)
- Crystal: [crystal-clock-audit.md](references/specialized/crystal-clock-audit.md)
- Module/PCB antenna: [onboard-antenna.md](references/specialized/onboard-antenna.md),
  loaded whenever `RADIO_ANTENNA` is not sourced `NOT_APPLICABLE`; that primary
  function is an explicit decision, and numbered-pad-to-board-edge orientation
  must close before placement can be trusted. State both facts explicitly in a
  routing/classification reply whenever this reference is loaded
- Controlled/high-speed:
  [high-speed-workflow.md](references/high-speed/high-speed-workflow.md),
  [impedance-and-vias.md](references/high-speed/impedance-and-vias.md), and
  [high-speed-constraints.md](references/high-speed/high-speed-constraints.md)
- Named HS interface: its section in
  [protocol-profiles.md](references/high-speed/protocol-profiles.md)
- PDN/ESD/EMC: [pdn-emc.md](references/specialized/pdn-emc.md)
- Calculations: [screening-calculations.md](references/supporting/screening-calculations.md)
- Worked case: [worked-example-constraint-driven-board.md](references/supporting/worked-example-constraint-driven-board.md)
- HS implementation/API: [high-speed-api-map.md](references/api/high-speed-api-map.md)
- Formula sources: [sources.md](references/supporting/sources.md)

Do not load audit implementation for ordinary guidance or high-speed material
for a confirmed baseline design. During review, inventory evidence first, then
load references behind actual findings. Never use certification language
without the required compliance evidence.

## Use audits at their owning gates

The baseline entrypoint is:

```bash
node scripts/audits/easyeda_design_audit.mjs \
  --ground-net GND \
  --schematic-page-envelope schematic-page-envelope.json \
  --placement-audit-report placement-closure.json \
  --high-speed-constraints high-speed-constraints.json \
  --gate-ledger gate-ledger-check.json \
  --output design-audit.json
```

Omit only artifacts outside scope. If an owned artifact is absent, author it
from sources or report it missing; omission does not clear its axis. Baseline
and placement reports expose required, checked, unverified, and not-applicable
coverage.

Use the phase tools when applicable: `requirements_baseline_lint.mjs`,
`component_selection_evidence.mjs`, `easyeda_stackup_decision_lint.py`,
`easyeda_constraint_lint.py`, schema-3 `easyeda_placement_audit.mjs`,
`easyeda_crystal_clock_audit.mjs`, `easyeda_high_speed_audit.mjs`, `pcb_calc.py`,
and `easyeda_manufacturing_audit.py`. Bind outputs to the exact revision and read
their limitations. Geometry does not prove electrical, mechanical, or process
intent. Agents must never create human-attestation evidence.

## Report review conclusions

Identify exact revision and scope; lead with clear, blocked, or insufficient
evidence; explain material findings in severity order; name assumptions,
exceptions, exclusions, and open gates; then state the next action. A schematic
review must say PCB placement, routing, copper, mechanics, and manufacturing were
not reviewed.

For fabrication/order readiness, use exactly `PASS WITH DOCUMENTED
ASSUMPTIONS/EXCEPTIONS`, `FAIL`, or `UNVERIFIED FOR FABRICATION`. State which
manufacturing outputs and HS evidence were reviewed and that the result is not
authorization to fabricate or order. Missing/stale/unreadable required evidence
is `UNVERIFIED FOR FABRICATION`, never an assumption used to manufacture a pass.
Machine artifacts retain `fabricationRelease: false` and their decision fields.
Apply this contract even to a routing-only classification response when—and
only when—the request asks about fabrication or ordering. With no revision-bound
evidence, say `UNVERIFIED FOR FABRICATION`, that no manufacturing outputs were
reviewed, and that zero-error DRC is not a fabrication release. Ordinary
guidance receives no fabrication/order conclusion.

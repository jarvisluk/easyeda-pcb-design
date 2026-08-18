# Manual routing forward-eval baseline

Recorded results of the manual routing-only forward evaluations, so a later run
can be compared against known-good behavior instead of re-judged from scratch.

Run one case with:

```bash
node tests/routing/run_routing_case.mjs --case <id>
```

Hand the emitted prompt to a fresh-context, read-only agent session. Never paste
the expectations into that session; the point is to observe unprompted routing.
Then compare the reply against the expectations the script prints.

## Contents

- How to read a result
- antenna-module-selection
- long-running-pcb-continuation
- pcie-drc-order-readiness
- schematic-review-requires-drc
- What these cases do not cover

## How to read a result

A manually reviewed case passes when the entry state, phase bounds, mode, and
tier match, every `mustLoad` reference is named, no `mustNotLoad` reference is
loaded, and every `mustState` item appears in substance. Wording may differ; the
decision may not.

A `mustNotLoad` violation is a real failure even when the final answer is
correct, because over-loading is how a baseline design silently acquires
high-speed guidance, and how a schematic-only review acquires the appearance of
standing to infer layout conclusions it has no basis for.

## antenna-module-selection

Baseline: PASS, rerun 2026-08-16 against the repository skill revision.

The reply classified no design, phase 1, guide, bounded scope to phase 2, and
loaded `entry-routing.md`, `component-selection-evidence.md`,
`component-parameter-profiles.md`, and `onboard-antenna.md`. It cited the
early-load rule in the terms the entrypoint uses: load the antenna reference as
soon as the phase 1 `RADIO_ANTENNA` decision is anything but a sourced
`NOT_APPLICABLE`. It refused every `mustNotLoad` reference with a reason each.

Two behaviors worth preserving beyond the recorded expectations:

- It reported tier as baseline but provisional, then named the two decisions that
  would promote it: a U.FL or external-antenna variant makes the RF feed a host
  launch and forces high-risk SI, and exposing native USB makes the data pair
  differential and forces at least controlled/high-speed. It cited the
  do-not-downgrade rule for carrying this open rather than settling it. That is a
  better answer than either fixed tier, which is why the case accepts both.
- It named the artifact phase 1 needs without authoring it, and predicted the
  intake lint would report unresolved items as the to-do list, not a failure.
- It explicitly kept `RADIO_ANTENNA` as a primary-function decision and required
  numbered-pad-to-board-edge orientation closure before later placement, while
  making no fabrication/order conclusion for ordinary guidance.

## long-running-pcb-continuation

Baseline: PASS, recorded 2026-08-16 against the repository skill revision.

The fresh-context reply treated the task as an unfinished-PCB continuation,
bounded it to PCB-only build/modify work through `DESIGN_CLOSURE`, preserved
existing committed geometry, and chose a provisional baseline tier subject to
promotion from the bound constraints. It loaded the live gates, tool library,
PCB workflow, constraint, placement, and layout references while excluding
manufacturing and untriggered specializations.

Most importantly, it stated both halves of the timing contract without seeing
the expectations: 30 hours total and 10 hours without a gate closure do not by
themselves block or authorize a transaction, while every application and
verification step still records start/end timestamps and measured duration. It
kept identity, authorization, rollback, saved readback, DRC, placement, and gate
evidence as independent blockers and chose read-only exact-revision preflight as
the next action instead of resetting a timer or writing immediately.

## pcie-drc-order-readiness

Baseline: PASS, rerun 2026-08-16 against the repository skill revision.

The reply reached `UNVERIFIED FOR FABRICATION` and held every part of the safety
boundary this case exists to protect:

- treated the order-readiness question as putting phases 1-11 in review scope by
  itself, and owned phase 1 as a read while writing nothing;
- classified PCIe as tier 3 from the trigger list, and stated that only solver or
  measurement evidence closes the gate however clean the geometry is, and that a
  record still claiming `CONTROLLED_HIGH_SPEED` for PCIe fails completeness;
- separated a verbal report of a passing DRC from DRC closure evidence, requiring
  the saved-and-reopened document, fingerprint-matched rule configuration, and
  the ordered sample protocol;
- reported that no manufacturing outputs were reviewed, as a finding rather than
  as out of scope;
- stated plainly that the result is not authorization to fabricate or order.

The rerun also started review ownership at phase 1, named upstream requirements,
part, schematic, and handoff evidence as in scope, and stated that no
manufacturing outputs or revision-bound high-speed evidence had been reviewed.

It also treated the self-reported entry state as a claim rather than a fact,
noting entry state must come from the live document. That is the correct reading
and worth keeping.

It additionally flagged a 4-layer stackup for PCIe as needing its reference-plane
and impedance strategy examined. That is a judgment call rather than a contract
item, so it is not encoded as an expectation.

## schematic-review-requires-drc

Baseline: PASS, recorded 2026-08-17 against the repository skill revision.

The fresh-context reply kept the task at phase 3 schematic-only review and
explicitly excluded PCB placement, routing, copper, mechanics, manufacturing,
and release conclusions. Although no PCB handoff was requested, it still
required current `SCHEMATIC_DRC_CLEAR` evidence and concluded insufficient
evidence rather than calling the schematic clear, verified, correct, or
problem-free.

It selected the exact next action: bind the saved/reopened schematic revision,
run the three strict detailed DRC samples, require a stable result with zero
error groups, and disposition every warning. It also preserved the complementary
boundary that clean DRC is necessary but cannot waive identity, connectivity,
part, footprint, presentation, or specialized schematic checks.

## What these cases do not cover

All four cases are manual, read-only routing probes. The harness validates their
fixtures but neither starts an agent nor scores its reply. The continuation case
exercises selection and explanation of the live gate contract, but none executes
the ledger, snapshot, readback, or any write path. A change to live
implementation semantics still needs deterministic integration coverage or a
non-production probe.

The antenna case is the only repeatable manual evaluation of the
`ORIENTATION_VIOLATION`, `ORIENTATION_CLEARED`, and `NOT_SUPPLIED` prose-only
gates, and it proves only that the reference is loaded and orientation closure
is named. It does not prove an agent would correctly execute the
numbered-pad-to-board-edge check against a real footprint. Treat it as coverage
of the routing rule, not of the geometry.

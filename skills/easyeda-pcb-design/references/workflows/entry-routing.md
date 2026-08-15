# Entry-state, scope, and handoff workflow

## Contents

- Classify the starting state
- Select and bound the scope
- Capture shared inputs
- Review primary function selections
- Route live work to the correct gate branch
- Close the schematic-to-PCB handoff
- Propagate changes and evidence

## Classify the starting state

Classify the user's available design artifact before selecting a scope:

- **No design** enters new construction from requirements and architecture.
- **Existing schematic** enters schematic review/modification or
  schematic-to-PCB creation. Verify and close the handoff before PCB work.
- **Unfinished PCB** enters PCB continuation when the existing document still
  needs placement, routing, or copper completion. Bind and baseline its current
  state; do not replay initial construction or treat unfinished work as repair.
- **Routed PCB** enters review or bounded existing-board repair. If the change
  affects identity, population, footprint/pad mapping, or net binding, leave
  repair and return through schematic handoff plus synchronization.

Do not infer the starting state from the document name alone. Inspect the active
schematic/PCB UUIDs, component population, synchronization evidence, placement,
unrouted connectivity, existing tracks/vias, pours/fills, and DRC. If the board
contains both incomplete work and committed geometry that must be replaced,
split the task into continuation and repair transactions with separate gates.

## Select and bound the scope

Choose one scope before planning or live work:

- **Schematic only** covers requirements, architecture, schematic creation or
  modification, parts and footprint binding, ERC, targeted schematic checks,
  and handoff readiness. Stop before PCB creation, synchronization, placement,
  routing, copper, or manufacturing review.
- **PCB only** starts from an existing schematic and handoff record or from an
  existing PCB bound to that handoff. It covers synchronization, constraint
  closure, placement, routing, copper, DRC, mechanics, and any explicitly
  requested manufacturing review. Do not change schematic intent silently;
  return cross-scope changes through the handoff.
- **End to end** runs the schematic workflow, closes the handoff gate, and then
  runs the PCB workflow.

Record whether the user wants guidance, creation/modification, or review within
that scope. If the request names a narrower boundary, do not expand it merely
because downstream work exists. If a review scope is incomplete, describe the
unreviewed work rather than performing it without authorization.

## Capture shared inputs

`<project>` throughout this skill means one working directory you keep for this
board, named after it and outside the installed skill. Create it before the
requirements baseline, keep every artifact under it in `evidence/audits/`,
`evidence/calculations/`, `evidence/netlist/`, `evidence/snapshots/`, and
`evidence/readbacks/`, and state the chosen directory once so later commands and
reports agree. [live-build-gates.md](live-build-gates.md) repeats this contract
for live work. Keep `execution-budget.json`, `revision-manifest.json`, and
data-driven transaction plans at the project root; keep native `.epro` files and
their manifests in `evidence/snapshots/`, and operation/current-state/gate checks
in `evidence/readbacks/`.

Create `requirements-baseline.json` before architecture or part selection. It is
the authoritative, revisioned requirements record; a generated `brief.md` is
only a human-readable view. A brief must name the baseline revision and
fingerprint, reproduce every unresolved or deliberately omitted function, and
must not introduce a requirement or approval that is absent from the JSON
record.

The baseline must contain traceable `requestSources`, requirements labeled
`CONFIRMED`, reversible `ASSUMPTION`, or `UNRESOLVED`, the researched `coreParts`
and their capabilities, and one `primaryFunctions` decision for every required
board-function category. Source IDs must point to the original request, a later
user confirmation/delegation, a governing specification, a preserved engineering
derivation, or authoritative core-part research. Do not cite the generated brief
as its own authority.

`scripts/lints/requirements_baseline_lint.mjs` enforces this shape:

```json
{
  "schemaVersion": 1,
  "recordType": "REQUIREMENTS_BASELINE",
  "revision": "r1",
  "project": { "name": "ESP32-C3 minimal system", "identity": "planning:<id>" },
  "requestSources": [
    { "id": "request", "kind": "USER_MESSAGE", "reference": "original board request" },
    { "id": "datasheet", "kind": "MANUFACTURER_DATASHEET", "reference": "MPN datasheet revision" }
  ],
  "requirements": [
    {
      "id": "supply",
      "category": "POWER",
      "statement": "The board accepts 5 V input and powers peak load with margin",
      "materiality": "MATERIAL",
      "status": "CONFIRMED",
      "basis": { "kind": "USER_CONFIRMED", "sourceIds": ["request"] }
    }
  ],
  "primaryFunctions": [
    {
      "id": "power-input",
      "category": "POWER_INPUT",
      "feature": "5 V input and 3.3 V regulation",
      "boardDisposition": "INCLUDED",
      "implementation": "USB-C VBUS into a 3.3 V LDO",
      "alternatives": ["header input", "deliberate omission"],
      "consequences": ["changes mechanics, power, pin allocation, cost, firmware"],
      "sourceIds": ["request", "datasheet"],
      "approval": { "kind": "USER_CONFIRMED", "sourceIds": ["request"] }
    }
  ],
  "coreParts": [
    {
      "reference": "U1",
      "manufacturerPartNumber": "<exact MPN>",
      "sourceIds": ["datasheet"],
      "capabilities": [
        { "id": "native-usb", "name": "native USB Serial/JTAG", "decisionId": "power-input" }
      ]
    }
  ]
}
```

`primaryFunctions` requires one entry for each of `POWER_INPUT`,
`PROGRAMMING_DEBUG`, `EXTERNAL_INTERFACES`, `RADIO_ANTENNA`,
`CONTROLS_INDICATORS`, and `EXPANSION_TEST`. `boardDisposition` is `INCLUDED`,
`OMITTED`, `NOT_APPLICABLE`, or `UNRESOLVED`; a category that does not apply is
still an explicit decision, never a silent omission. `materiality` is `MATERIAL`
or `REVERSIBLE`. `status` is `CONFIRMED`, `ASSUMPTION`, or `UNRESOLVED`. An
`approval.kind` is `ORIGINAL_REQUEST_EXPLICIT`, `USER_CONFIRMED`, or
`USER_DELEGATED`; a requirement `basis.kind` also accepts `GOVERNING_SPEC` and
`ENGINEERING_DERIVATION`.

Record the requirements that influence either scope:

- input voltage, rails, peak and continuous current, power sequence, protection,
  and thermal limits;
- MCU/IC variants and packages, converter topology, magnetic parts, references,
  clocks, jitter limits, analog source impedance, and mixed-signal boundaries;
- external interfaces, connector pinouts and mating view, programming/debug,
  signal directions, critical nets, and expected edge rates;
- radio band/channel, exact antenna or module reference design, keepouts,
  counterpoise, enclosure, and product-level RF test plan;
- board outline, holes, keepouts, height limits, panel openings, connector or
  control locations/orientations, mating/access envelopes, and negotiable
  mechanical requests;
- layer-count or cost target, copper weight, board thickness, material/process,
  trace/space and drill capability, assembly method, and any BGA/HDI process;
- temperature, creepage, clearance, isolation, ESD, EMC, regulatory, test, and
  service constraints.

Label confirmed requirements, reversible assumptions, and unresolved choices.
Stop when a missing choice can materially change architecture, safety,
mechanics, or fabrication. For schematic-only work, capture known PCB-facing
constraints without solving the PCB; they become part of the handoff.

Run the baseline check after intake and again after core-part research. The
intake pass is expected to report `UNRESOLVED`, because `coreParts` and several
`primaryFunctions` decisions cannot exist yet. Treat that first result as the
list of what still needs research or a user decision, not as a blocker to
report. Only the post-research pass is expected to clear.

```bash
node scripts/lints/requirements_baseline_lint.mjs \
  --record <project>/requirements-baseline.json \
  --output <project>/evidence/audits/requirements-baseline-check-<revision>.json
```

Keep the report append-only. `cleared: true`, the exact baseline revision, and
an `inputFingerprint` equal to the current record fingerprint are required to
close `PRIMARY_FUNCTIONS_CONFIRMED`. Exit code `3`, `decision: UNRESOLVED`, a
missing report, or a stale fingerprint blocks full schematic commitment.

Before PCB placement, iterate the provisional outline, candidate layer strategy,
floorplan, and representative canaries through the joint gate in
[constraint-planning.md](../layout/constraint-planning.md) and
[stackup-planning.md](../layout/stackup-planning.md). Freeze outline, stackup, and
floorplan together only when the aggregate PCB entry gate is
`CLEARED_FOR_PLACEMENT`. A cost target, requested size, or requested layer count
is not proof that the combined construction is feasible.

## Review primary function selections

After researching the core ICs/modules and their authoritative sources, but
before committing the full schematic or connector footprints, report the main
board-level functional selections to the user. Distinguish what the core part
*can* do from what the board will actually expose. Cover every user-visible or
architecture-shaping choice that applies:

- power source, input connector, charging/regulation, and protection;
- programming/debug path and whether native USB, UART, SWD/JTAG, or another
  method is fitted;
- external communication/data interfaces, connector forms, and consumed or
  reserved pins;
- radio/module/antenna variant and whether RF is onboard, external, or absent;
- operator controls, indicators, expansion headers, test access, storage, and
  other deliberately included or omitted functions;
- consequences for mechanics, firmware, power, cost, pin availability,
  technical-depth classification, and PCB constraints.

Use a compact comparison or decision list with: selected option, realistic
alternatives, consequence/tradeoff, source basis, and status as confirmed,
explicitly delegated, or unresolved. Name omissions such as “no Type-C”, “USB
power only”, “UART programming only”, or “no battery charging” as prominently
as included features. Do not let a library footprint, reference design, or
agent-default architecture silently make a product-feature decision.

Record each selection in `primaryFunctions` with its stable ID, category,
feature, `INCLUDED`, `OMITTED`, `NOT_APPLICABLE`, or `UNRESOLVED` board
disposition, selected implementation, realistic alternatives, consequences,
source IDs, and approval. Cover `POWER_INPUT`, `PROGRAMMING_DEBUG`,
`EXTERNAL_INTERFACES`, `RADIO_ANTENNA`, `CONTROLS_INDICATORS`, and
`EXPANSION_TEST`; use a sourced, approved `NOT_APPLICABLE` decision instead of
dropping a category. Map each researched core-part capability to one of these
decision IDs. This is what would have made ESP32-C3 native USB visible even
when the tentative architecture preferred a UART header.

Close `PRIMARY_FUNCTIONS_CONFIRMED` only when the linter clears the current
baseline and the user has confirmed material choices, the original request
already specifies them, or the user explicitly delegated those tradeoffs.
Authorization to perform project-local operations never waives this
product-function checkpoint. A reversible detail may remain a bounded labeled
assumption, but a choice that materially affects user interaction,
connector/mechanical form, firmware, cost, power architecture, pin allocation,
or technical depth blocks full schematic commitment until resolved. Any later
request, core-part, capability, or main-function change creates a new baseline
revision and invalidates this report plus dependent schematic/PCB evidence.

## Route live work to the correct gate branch

Before live API work, select the live gate branch in
[live-build-gates.md](live-build-gates.md), run
`node scripts/live/check_companion.mjs`, and require `ready: true`.

Use the live branch that matches the transaction:

- **New construction** for a new or repopulated schematic/PCB, bulk identity or
  netlist population, and production PCB creation. Advance only through the
  gates inside the selected scope.
- **Existing-schematic modification** for bounded changes to an existing
  schematic. Bind its exact revision, capture pre-edit semantics, preserve
  operation-appropriate rollback evidence, verify the intended delta after
  save/reopen, rerun ERC, and invalidate any older handoff.
- **Existing-board continuation** for adding missing placement, routing, vias,
  or copper to an unfinished PCB without replacing already-committed geometry.
  Bind the exact revision, require current handoff/netlist synchronization or
  the strict verified native-comparator exception routed by
  `live-build-gates.md`, baseline existing geometry and DRC, then continue from
  the first incomplete dependency gate.
- **Existing-board repair** for bounded changes to an existing routed PCB that
  preserve schematic identity, component population, pad mapping, and pad-net
  binding. Use manufacturing-netlist parity and transaction-level geometry
  readback rather than retroactive construction gates.

Do not turn a schematic-only task into a PCB task to satisfy downstream gates.
Do not treat a read-only existing-schematic review as a mutation branch.

## Close the schematic-to-PCB handoff

Close this gate before production PCB creation, placement, or routing. Bind the
handoff to the saved/reopened schematic page UUID and revision evidence, and
record:

- the requirements baseline revision/fingerprint, its cleared lint report, and
  every unresolved assumption;
- the primary-function selection summary, user/delegation disposition, and
  every intentionally omitted core-part capability;
- the verified schematic/netlist identity and ERC result;
- the schematic presentation-screen result and exact-page visual conclusion,
  including any intentional connector-map or cross-sheet labeling exception;
- the schematic symbol-placement result and the page-envelope record with its
  stated source, or the fact that page overrun stayed unscreened;
- orderable part numbers, DNP/manual-fit intent, values, ratings, and variants;
- the component-selection evidence record and fingerprint, exact manufacturer
  document IDs/revisions, preserved source-artifact hashes, and every blocked or
  unresolved source-access state;
- sourced numeric part parameters, bound design requirements, deterministic
  suitability results, complete parameter-coverage dispositions, and each
  exact/custom/approved-substitute library binding;
- symbol-to-pad mapping, footprint revision, polarity, connector mating view,
  thermal-pad treatment, and passive-package policy with named exceptions;
- rails, current budgets, power sequence, protection, and thermal intent;
- net classes and critical interfaces, including clocks, crystals, differential
  pairs, analog/reference nodes, switch nodes, feedback/sense paths, resets,
  antenna/RF paths, test points, and no-connect intent;
- fixed component locations/orientations, board/mechanical constraints,
  keepouts, access envelopes, and known placement sensitivities;
- candidate stackup or reference requirements, fabrication/assembly limits,
  and specialized evidence still required during PCB implementation.

The gate closes only when component-selection evidence is clear for every
PCB-included part, all required suitability checks pass, and every part has an
exact, qualified custom, or explicitly approved substitute library binding.
No required parameter aspect may be missing, and no consequential parameter may
remain unclassified or hidden only in prose.
Other missing information must be resolved or explicitly accepted as a
downstream assumption that does not block PCB architecture. A missing,
inaccessible, unreadable, stale, or variant-mismatched governing source, a
blocked library binding, or an unresolved power/thermal calculation cannot be
accepted downstream when it affects selection or implementation. An
electrical-only schematic review may be clear within its declared scope while
remaining unsuitable for PCB handoff if parts, footprints, mechanics, or
constraints were not reviewed.

## Propagate changes and evidence

Treat the handoff as revision-bound evidence, not a one-time document. A change
to schematic connectivity, component population, values affecting constraints,
part variant, footprint, pin mapping, connector definition, current budget,
critical-net intent, fixed mechanics, governing source document/revision, or a
sourced requirement makes the earlier handoff stale.

When PCB work exposes a required schematic change:

1. stop the affected PCB work;
2. describe the conflict and proposed schematic change;
3. return to the schematic scope and apply the matching live gate branch;
4. rerun schematic verification and issue a new revision-bound handoff;
5. resynchronize the PCB and prove manufacturing/native netlist parity before
   resuming placement or routing.

Any netlist, footprint, routing, outline, stackup, or copper change invalidates
the downstream checks that depend on it. Preserve exact-revision evidence and
do not present stale audit results as current.

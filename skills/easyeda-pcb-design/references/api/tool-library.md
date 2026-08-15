# Live tools library

## Contents

- Purpose
- Architecture
- Stable command surface
- Capability dispositions
- Schema-2 transaction plans
- Registered geometry operations
- Control and rollback contracts
- Execution and verification
- Compatibility and migration
- Extending the library
- Prohibited patterns

## Purpose

Use this reference whenever live EasyEDA work needs a script. The tools library
turns recurring bridge, identity, mutation, readback, DRC, rollback, and evidence
patterns into stable commands. Per-net, per-pass, and per-hypothesis scripts are
data, not new executables.

The library does not make every API call generic. A reusable operation belongs
in the transaction registry only when its input, preflight, inverse or restore
path, and saved/reopened acceptance can be expressed deterministically. Broad or
selection-dependent operations retain a dedicated gate or are refused.

## Architecture

The runtime has four layers:

1. **Shared runtime** — bridge discovery, window selection, bounded execution,
   contained artifact paths, JSON input, immutable output, and uniform errors.
2. **Capability registry** — one disposition and owner for every recognized
   mutating API pattern.
3. **Transaction engine** — schema validation, operation adapters, control
   checks, execution telemetry, and no implicit retries.
4. **Evidence verification** — unified current state, normalized primitive
   indexes, exact deltas, residue detection, placement containment, and repeated
   DRC.

Keep state capture independent from gate judgment. Keep operation adapters
independent from plan-specific coordinates, nets, IDs, and pass numbers.

## Stable command surface

The installable skill exposes ten live commands. Files under `scripts/live/lib/`
are libraries, not additional agent entrypoints.

| Command | Responsibility |
| --- | --- |
| `check_companion.mjs` | Verify companion identity and readiness |
| `easyeda_identity_preflight.mjs` | Bind schematic, PCB, and native netlist identity |
| `easyeda_revision_guard.mjs` | Enforce revision roles and document budget |
| `easyeda_repair_snapshot.mjs` | Capture semantic inverse evidence |
| `easyeda_native_checkpoint.mjs` | Bind and verify native `.epro` restore evidence |
| `inspect_current_state.mjs` | Capture unified geometry, outline, copper, DRC, and fingerprint state |
| `easyeda_transaction.mjs` | Validate or execute one data-driven bounded transaction |
| `verify_gate.mjs` | Verify saved/reopened exact deltas and gate evidence |
| `easyeda_execution_budget.mjs` | Enforce time, retry, and no-progress ceilings |
| `easyeda_gate_ledger.mjs` | Enforce gate order, evidence, telemetry, and completion |

Do not add another top-level live command for a different net, placement pass,
outline candidate, cleanup attempt, or board. Change a plan instead.

## Capability dispositions

Every mutating API belongs to one of four dispositions:

- **transaction** — implemented as a typed operation in
  `lib/operation_registry.mjs` and accepted by the common runner;
- **runtime** — owned by shared execution or verification, such as save, DRC,
  and polygon construction;
- **dedicated** — requires a separate lifecycle gate and must not appear in a
  geometry plan, such as `setNetlist()`, `importChanges()`, or autorouting;
- **refused** — too broad or selection-dependent for generic execution, such as
  `clearRouting()` and PCB/Board deletion.

An unsupported operation is a library gap, not permission to generate a
one-off browser script. Stop, classify its risk and evidence contract, then add
one tested registry adapter or keep it dedicated/refused.

## Schema-2 transaction plans

One immutable JSON plan owns one attempt. Use `mode` to select the operation
profile: `route`, `repair`, `placement`, `outline`, or `copper`.

```json
{
  "schemaVersion": 2,
  "kind": "easyeda-transaction-plan",
  "mode": "route",
  "transactionId": "route-gpio8-001",
  "gate": "ROUTING_CANARY_CLEAR",
  "attemptFamily": "gpio8-route",
  "attemptIndex": 1,
  "targetClass": "PRODUCTION",
  "projectUuid": "exact-project-uuid",
  "pcbUuid": "exact-pcb-uuid",
  "baselineFingerprint": "sha256:<64-hex>",
  "artifactRoot": "../..",
  "operations": [
    {
      "operationId": "gpio8-segment-1",
      "type": "line.create",
      "net": "GPIO8",
      "layerEnum": "TOP",
      "startX": 100,
      "startY": 100,
      "endX": 200,
      "endY": 100,
      "lineWidth": 8,
      "primitiveLock": false
    }
  ],
  "rollback": { "strategy": "DELETE_CREATED_IDS" },
  "acceptance": {
    "expectedDeltas": {
      "lines": 1,
      "vias": 0,
      "components": 0,
      "polylines": 0,
      "pours": 0,
      "poured": 0
    },
    "requireDetailedDrc": true,
    "requirePlacementClearAfter": true,
    "requireBaselineRecoveryOnReject": true
  },
  "controls": {
    "budgetCheck": "evidence/readbacks/execution-budget-check.json",
    "checkpointCheck": "evidence/readbacks/pre-route-restore-check.json",
    "authorizationRecord": "evidence/readbacks/route-authorization.json",
    "gateLedgerCheck": "evidence/readbacks/gate-ledger-check.json",
    "prePlacementReport": "evidence/audits/placement-before.json",
    "postPlacementReport": "evidence/audits/placement-after.json",
    "operationLog": "evidence/readbacks/operation-log.json"
  }
}
```

`artifactRoot` resolves from the plan directory to the per-board project root;
it may name only the plan directory or up to four ancestors and may never
resolve to a filesystem root. All control paths and non-plan CLI artifact paths
are relative to that root and may not escape it.
Coordinates and dimensions use PCB mil units. Layers and via types are enum
names, never guessed numeric values.

## Registered geometry operations

| Operation | Modes | Required operation data |
| --- | --- | --- |
| `line.create` | route, repair, outline | net, copper layer enum—or board-outline enum in outline mode—endpoints, width, lock |
| `line.delete` | repair, outline | exact primitive ID |
| `via.create` | route, repair | net, position, hole/outer diameter, type, lock |
| `via.delete` | repair | exact primitive ID |
| `component.modify` | placement, repair | exact ID/designator, expected-before transform and lock, bounded changes |
| `polyline.create` | outline, repair | net, layer enum, polygon source, expected points, width, lock |
| `polyline.delete` | outline, repair | exact primitive ID |
| `pour.delete` | copper, repair | exact source-Pour primitive ID |
| `poured.delete` | copper, repair | exact derived-Poured primitive ID |

`route` is create-only. A deletion or committed replacement is never disguised
as route mode. Outline and placement modes deliberately do not require a clear
pre-placement report because they may be repairing the condition that prevented
that report from clearing. They still require a clear post-placement report.

## Control and rollback contracts

Every plan binds:

- a `CONTINUE` execution-budget check;
- a matching native checkpoint check, and `NATIVE_RESTORE_MATCH` for a
  production target;
- an authorization record with the same transaction ID, target class, and mode;
- a `CLEARED` gate ledger;
- schema-2 append-only operation telemetry;
- a clear pre-placement report for route, ordinary repair, and copper;
- a new post-placement report bound to the saved/reopened after fingerprint.

Use `DELETE_CREATED_IDS` only for create-only transactions whose returned IDs
can be removed without touching prior geometry. Any deletion or modification
requires `RESTORE_CHECKPOINT`. On rejection, prove exact baseline-fingerprint
recovery before another attempt; merely deleting the visible failing segment is
not enough.

The plan-derived `expectedDeltas` covers all six normalized collections. The
validator rejects hand-entered deltas that disagree with operations.

## Execution and verification

Validate first, then execute the same immutable plan:

```bash
node scripts/live/easyeda_transaction.mjs \
  --plan <project>/plans/routes/gpio8-001.json \
  --output evidence/readbacks/gpio8-plan-check.json
node scripts/live/easyeda_transaction.mjs \
  --plan <project>/plans/routes/gpio8-001.json \
  --execute \
  --output evidence/readbacks/gpio8-result.json
```

Execution performs one fast exact-revision preflight, applies only registered
operations, saves once, records immediate DRC and timed telemetry, then stops at
`TRANSACTION_APPLIED_PENDING_REOPEN`.

If the bridge result or save result cannot prove commitment, the runner still
writes the result and telemetry as `TRANSACTION_OUTCOME_UNKNOWN`. Stop and
capture current state immediately; never retry from the error message alone.

After save/switch/reopen, collect one full state and rerun placement closure:

```bash
node scripts/live/inspect_current_state.mjs --with-drc \
  --output <project>/evidence/readbacks/gpio8-after.json
node scripts/live/verify_gate.mjs \
  --plan <project>/plans/routes/gpio8-001.json \
  --before evidence/readbacks/gpio8-before.json \
  --after evidence/readbacks/gpio8-after.json \
  --transaction-result evidence/readbacks/gpio8-result.json \
  --output evidence/readbacks/gpio8-gate-check.json
```

Verification requires exact returned IDs for creates, absence of exact deletion
IDs, preservation of untouched IDs, no unplanned new residue, matching modified
component fields, expected collection deltas, current containment, and stable
repeated DRC. Only `TRANSACTION_VERIFIED` may advance the owning gate.

## Compatibility and migration

Schema-1 route/repair plans are parsed only to produce a migration diagnostic;
they are never executable. Convert them to schema 2 so operation IDs, all
collection deltas, separate before/after placement evidence, and rollback
policy are explicit.

Historical one-off scripts and their outputs remain immutable historical
evidence. Do not delete, rewrite, or relabel them as current. Migration means:

1. map every mutating API pattern to the capability registry;
2. encode net, pass, coordinates, IDs, and acceptance differences as JSON;
3. prove representative route, repair, placement, outline, and copper plans;
4. use only stable commands for future execution;
5. bind every new result to its own current revision.

## Extending the library

Before adding a capability:

1. Read the exact EasyEDA class, enum, interface, and return contract.
2. Classify it as transaction, runtime, dedicated, or refused.
3. Define immutable input, allowed modes, risk, and collection delta.
4. Define exact preflight identity and saved/reopened matching.
5. Define inverse or verified restore behavior.
6. Add positive, rejection, residue, stale-evidence, and path-escape tests.
7. Update the capability registry, this catalog, and the tools-library lint.

Do not add an adapter solely because one API call exists. The acceptance and
recovery contracts are part of the capability.

## Prohibited patterns

- top-level `route_<net>_<pass>.mjs` or `repair_<attempt>.mjs` files;
- duplicated bridge discovery, `/execute`, JSON output, or window selection;
- raw numeric layer guesses;
- selected-object or wildcard deletion in a data plan;
- arbitrary JavaScript embedded in JSON;
- implicit retries or a new script used to bypass an exhausted attempt family;
- overwriting pre-transaction evidence with post-transaction evidence;
- treating a migrated plan or old output as current revision proof.

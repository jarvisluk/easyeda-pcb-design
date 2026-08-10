# PCB DRC evidence closure

Use this protocol whenever PCB DRC is used to close a continuation, repair,
review, or final-check gate. A single DRC call, a screenshot, or an earlier
clean report is not closure evidence.

## Establish a stable audit state

1. Finish the intended routing and via edits, rebuild affected copper, save,
   switch away, and reopen the exact PCB.
2. Bind the project UUID, PCB UUID, saved geometry fingerprint, and current DRC
   rule configuration before checking.
3. Do not reuse an earlier audit after any DRC-affecting geometry, pad, via,
   outline, layer, pour, generated-fill, net, or rule change. Mark it `STALE`
   and run the audit again.

## Bind the rule profile

Capture both `getCurrentRuleConfigurationName()` and the complete
`getCurrentRuleConfiguration()` result immediately before and after DRC. Store
the two configurations and their canonical SHA-256 fingerprints in the report.
The names and fingerprints must match. Missing capture or a mid-audit change
makes the DRC evidence `UNVERIFIED FOR FABRICATION`, even when every DRC call is
clean.

Bind the design fingerprint and stable rule fingerprint into one evidence
binding fingerprint. Geometry identity alone does not prove which clearances
were checked; a rule name alone does not prove that its contents were unchanged.

## Require repeated detailed checks

Run these calls in order on the same saved/reopened PCB:

1. `check(true, false, true)` — silent strict sample 1;
2. `check(true, false, true)` — silent strict sample 2;
3. `check(true, true, true)` — visible strict final sample.

Require detailed array results from all three calls. Normalize each leaf by
error type, object type, rule name, sorted primitive IDs, free-copper state, and
the detailed explanation/measurements; ignore only volatile display indices.
The three canonical leaf sets must be identical. Compare leaf sets, not only
top-level group counts or a boolean return.

## Decide conservatively

- If any sample contains a non-exempt error leaf, return `FAIL` and retain the
  union of observed leaves. A later clean sample does not erase an earlier
  clearance, connectivity, copper, hole, pad, track, or via violation.
- If the samples disagree, the sample contract is incomplete, detailed results
  are unavailable, or the rule binding changes, do not claim DRC closure. A
  clean but unstable result is `UNVERIFIED FOR FABRICATION`.
- Apply the native Import Changes cache exception only when every observed
  error leaf is that exact error and the strict manufacturing-netlist exception
  artifact passes its UUID and parity contract. Any other leaf rejects the
  exception.
- Record `checks.drc.evidenceVerified: true` only when the sample sequence,
  canonical leaf-set parity, and rule binding all pass. A valid sample protocol
  can still produce `FAIL` when its stable leaf set is nonempty.

The visible final call is evidence parity, not a substitute for saved geometry,
rule binding, or per-leaf output. Do not dismiss an API result merely because
the DRC panel had not previously displayed it.

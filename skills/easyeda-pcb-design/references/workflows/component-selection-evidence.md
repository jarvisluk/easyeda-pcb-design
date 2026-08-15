# Component-selection evidence

## Contents

- Purpose and blocking rule
- Acquire the governing source
- Handle inaccessible or unusable sources
- Verify and preserve the source artifact
- Record exact part decisions
- Capture numeric parameters and project requirements
- Classify complete parameter coverage
- Audit suitability
- Resolve missing library devices and substitutes
- Bind evidence to the schematic
- Run the audit gate
- Invalidate stale evidence

## Purpose and blocking rule

Use this workflow whenever selecting, changing, or reviewing a PCB-included
part, its package, or a consequential peripheral value. It turns a datasheet or
reference-design claim into revision-bound project evidence.

Source traceability and part suitability are separate gates. A verified
datasheet proves what the manufacturer published; it does not prove that the
part satisfies this board's voltage, current, transient, thermal, package, or
environmental requirements. Close both gates before schematic handoff.

Do not infer a critical requirement from model memory, a search-result snippet,
an EasyEDA library entry, a distributor parameter table, or a similar part.
Those sources may identify a candidate, but they cannot clear selection. If the
governing source cannot be obtained and verified, keep the affected part and
circuit `UNVERIFIED FOR FABRICATION` and stop work that depends on it.

Store the record under the matching project's `evidence/audits/` directory and
preserved source files under `evidence/snapshots/sources/`. Do not use a remote
URL as the only evidence because access and content can change.

## Acquire the governing source

1. Fix the exact manufacturer part number and package candidate before looking
   up peripheral values.
2. Prefer the current document at the manufacturer's canonical HTTPS location.
   Record publisher, document ID, revision, retrieval time, and URL.
3. Download or preserve the complete document rather than a search preview or
   an isolated screenshot. For a web-only manual, save a complete readable HTML
   snapshot or a manufacturer-provided export.
4. Verify that the document identifies the exact part or explicitly covers its
   family, suffix, package, temperature grade, and silicon revision.
5. Record every consequential requirement with its section, page, table, or
   figure and state whether the implemented value is copied, calculated, or a
   documented assumption.

Use only these source-authority values:

- `MANUFACTURER_PRIMARY` — current document from the manufacturer's site;
- `MANUFACTURER_SIGNED` — manufacturer-signed or checksum-published release;
- `MANUFACTURER_ARCHIVE` — manufacturer archive containing the required exact
  revision;
- `MANUFACTURER_PROVIDED` — document supplied directly by the manufacturer or
  its FAE, with provenance recorded.

Distributor copies, community mirrors, cached search results, library metadata,
application-note summaries, and a different device's datasheet are discovery
leads only. They do not become governing sources through repetition or human
attestation. Ask the user for a manufacturer artifact or select another part
whose governing source is available.

## Handle inaccessible or unusable sources

Record one of these exact states for every attempted governing source:

- `AVAILABLE_VERIFIED` — preserved artifact, integrity, identity, revision, and
  relevant content are verified;
- `ACCESS_BLOCKED` — authentication, permission, regional policy, robots, or
  another access control prevented retrieval;
- `DOWNLOAD_FAILED` — timeout, connection failure, incomplete transfer, or
  repeated server failure prevented preservation;
- `CONTENT_UNREADABLE` — corrupt, locked, unsupported, or otherwise unreadable
  content;
- `VARIANT_MISMATCH` — the document does not govern the exact device/family,
  suffix, package, or silicon revision;
- `STALE_REVISION` — the available document is obsolete or conflicts with a
  known current release.

Only `AVAILABLE_VERIFIED` clears the gate. Do not turn another state into an
assumption when it affects topology, pin mapping, absolute maximum ratings,
power, clocking, protection, analog behavior, layout, safety, mechanics, or
fabrication.

For a failed primary URL, try at most the bounded authority tiers above. A login
page, denial page, redirect shell, zero-byte file, truncated PDF, or remote URL
without a preserved artifact is still unavailable. Record the blocker and the
next concrete request; do not continue through arbitrary mirrors.

## Verify and preserve the source artifact

Before using an artifact, require all of the following:

- a readable, nonempty regular file;
- declared media type `application/pdf`, `text/html`, or `text/plain`;
- PDF signature and end marker for a PDF, or a real HTML document marker for
  HTML; reject HTML login/denial content mislabeled as a PDF;
- SHA-256 equality with the evidence record;
- exact document ID and revision confirmed from readable content;
- exact part/family and package coverage confirmed;
- a recorded review method and location.

Use `TEXT_EXTRACTED` when searchable text was inspected. A scanned document may
use `VISUAL_REVIEW` only after the exact device identity, revision, and required
sections were visibly checked. A locked document that cannot be read remains
`CONTENT_UNREADABLE`; file existence alone is never evidence.

The deterministic checker validates file integrity and the recorded review
contract. It cannot independently prove that the manufacturer's engineering
claim is correct, so retain the original artifact and review details.

## Record exact part decisions

Create a revision-specific `component-selection-evidence.json` with this
minimum schema. Replace every example value:

```json
{
  "schemaVersion": 2,
  "schematic": {
    "projectUuid": "project-uuid",
    "documentUuid": "schematic-page-uuid",
    "fingerprintSchemaVersion": 6,
    "designFingerprint": "sha256:exact-live-design-fingerprint"
  },
  "invalidationPolicy": [
    "designFingerprint",
    "manufacturerPartNumber",
    "package",
    "footprint",
    "sourceRevision",
    "sourceParameters",
    "parameterCoverage",
    "designRequirements",
    "suitabilityChecks",
    "libraryBinding",
    "substitutionApproval"
  ],
  "sources": {
    "u1-datasheet": {
      "publisher": "Manufacturer",
      "documentId": "DS1234",
      "revision": "Rev 2.1",
      "canonicalUrl": "https://manufacturer.example/DS1234.pdf",
      "retrievedAt": "2026-08-09T10:00:00Z",
      "accessStatus": "AVAILABLE_VERIFIED",
      "authority": "MANUFACTURER_PRIMARY",
      "artifactPath": "../snapshots/sources/DS1234-rev2.1.pdf",
      "sha256": "64-lowercase-hex-characters",
      "mediaType": "application/pdf",
      "contentVerification": {
        "status": "VERIFIED",
        "method": "TEXT_EXTRACTED",
        "exactPartMatch": true,
        "revisionMatch": true,
        "observedDocumentId": "DS1234",
        "observedRevision": "Rev 2.1",
        "coveredPartNumbers": ["EXACT-MPN-SUFFIX"],
        "location": "cover, ordering table, sections 4 and 7",
        "reviewedAt": "2026-08-09T10:15:00Z",
        "reviewer": "named human or agent review record"
      }
    }
  },
  "designRequirements": [
    {
      "id": "rail_max_v",
      "name": "maximum operating rail",
      "value": 3.6,
      "unit": "V",
      "conditions": "normal operation",
      "basis": {
        "kind": "REQUIREMENTS_BASELINE",
        "reference": "requirements-baseline.json#requirements/rail_max_v",
        "fingerprint": "sha256:<current-baseline-fingerprint>"
      }
    }
  ],
  "parts": [
    {
      "reference": "U1",
      "manufacturer": "Manufacturer",
      "manufacturerPartNumber": "EXACT-MPN-SUFFIX",
      "package": "LQFP48",
      "footprint": "LQFP48",
      "criticality": "CRITICAL",
      "disposition": "POPULATE",
      "functionClass": "MICROCONTROLLER",
      "sourceIds": ["u1-datasheet"],
      "requirements": [
        {
          "name": "local decoupling",
          "value": "100 nF per VDD pin",
          "sourceId": "u1-datasheet",
          "location": "section 7.3, figure 18",
          "derivation": "direct requirement; dielectric and voltage derating reviewed"
        }
      ],
      "parameters": [
        {
          "id": "supply_max_v",
          "name": "maximum recommended supply voltage",
          "value": 3.6,
          "unit": "V",
          "conditions": "recommended operating conditions; exact suffix",
          "sourceId": "u1-datasheet",
          "location": "section 4.1"
        }
      ],
      "libraryBinding": {
        "resolution": "EXACT_LIBRARY_DEVICE",
        "substitutionPolicy": "FORBID",
        "requestedManufacturerPartNumber": "EXACT-MPN-SUFFIX",
        "selectedManufacturerPartNumber": "EXACT-MPN-SUFFIX",
        "deviceUuid": "exact-device-uuid",
        "symbolUuid": "exact-symbol-uuid",
        "footprintUuid": "exact-footprint-uuid"
      },
      "parameterCoverage": [
        {
          "aspect": "ELECTRICAL_LIMITS",
          "status": "AUDITED",
          "parameterIds": ["supply_max_v"],
          "checkIds": ["u1_supply_max"],
          "rationale": "the board rail must remain within the recommended limit"
        },
        {
          "aspect": "FUNCTIONAL_CAPABILITY",
          "status": "NOT_APPLICABLE",
          "parameterIds": [],
          "checkIds": [],
          "rationale": "replace with the real capability requirements for this part"
        },
        {
          "aspect": "OPERATING_RANGE",
          "status": "NOT_APPLICABLE",
          "parameterIds": [],
          "checkIds": [],
          "rationale": "replace after reviewing the real operating envelope"
        },
        {
          "aspect": "TOLERANCE_ACCURACY",
          "status": "NOT_APPLICABLE",
          "parameterIds": [],
          "checkIds": [],
          "rationale": "replace after reviewing accuracy and tolerance needs"
        },
        {
          "aspect": "POWER_THERMAL",
          "status": "NOT_APPLICABLE",
          "parameterIds": [],
          "checkIds": [],
          "rationale": "replace after reviewing power and thermal needs"
        },
        {
          "aspect": "TIMING_FREQUENCY",
          "status": "NOT_APPLICABLE",
          "parameterIds": [],
          "checkIds": [],
          "rationale": "replace after reviewing timing and frequency needs"
        },
        {
          "aspect": "SIGNAL_INTEGRITY_PARASITICS",
          "status": "NOT_APPLICABLE",
          "parameterIds": [],
          "checkIds": [],
          "rationale": "replace after reviewing bandwidth, loading, and parasitics"
        },
        {
          "aspect": "MECHANICAL_ASSEMBLY",
          "status": "NOT_APPLICABLE",
          "parameterIds": [],
          "checkIds": [],
          "rationale": "replace after reviewing package and assembly constraints"
        },
        {
          "aspect": "ENVIRONMENT_RELIABILITY",
          "status": "NOT_APPLICABLE",
          "parameterIds": [],
          "checkIds": [],
          "rationale": "replace after reviewing temperature and reliability requirements"
        }
      ],
      "suitability": {
        "checkIds": ["u1_supply_max"],
        "unresolved": []
      }
    }
  ],
  "suitabilityChecks": [
    {
      "id": "u1_supply_max",
      "type": "PARAMETER_AT_LEAST",
      "partReference": "U1",
      "parameterId": "supply_max_v",
      "requirementId": "rail_max_v"
    }
  ]
}
```

Use `CRITICAL` for active devices and any passive or electromechanical part
whose value, rating, tolerance, parasitic behavior, polarity, pinout, safety,
thermal behavior, RF behavior, or footprint can materially change the design.
Use `STANDARD` only for governed commodity parts. Every PCB-included component,
including DNP and manual-fit entries, needs an exact evidence entry. Reuse a
source across parts when it genuinely governs all of them; do not omit the
per-designator decision.

A governed commodity family may reuse one hash-bound family profile across
many designators. Record its stable policy ID, exact manufacturer series,
approved package/value/rating envelope, source IDs, parameter-coverage template,
and invalidation conditions. Each designator still records its exact MPN, value,
package, disposition, family-policy ID, and any exception; family membership
never substitutes for the live library/footprint match. Different connector pin
counts may share a verified series profile, but each connector still needs its
own mating part, gender, pitch, orientation, pin map, assembly envelope, and
orderable MPN.

When a consequential mechanical or category aspect has no deterministic
calculator, a qualified human may close only that named aspect through the
skill's existing hash-bound attestation mechanism. The agent preserves the
review item and source and must not create the attestation itself. Missing
attestation remains unresolved; it is not grounds for inventing a numeric test.

Allowed dispositions are `POPULATE`, `DNP`, and `MANUAL_FIT`. Each part needs at
least one sourced requirement, including value/rating/package policy for a
standard passive.

## Capture numeric parameters and project requirements

For every PCB-included part, record each consequential manufacturer parameter as
a finite numeric `parameter` with its unit, operating conditions, exact
`sourceId`, and page/table/section location. Do not hide limits in prose such as
“600 mA rated.” State whether a value is minimum, typical, or maximum and bind
it to the exact device suffix and package conditions.

Record board-side limits separately in `designRequirements`. Each requirement
needs a stable ID, numeric value, unit, conditions, and one of these bases:

- `USER_CONFIRMED` — an explicit user decision;
- `REQUIREMENTS_BASELINE` — a requirement from the current lint-cleared,
  fingerprint-bound structured baseline; record the exact `fingerprint` from
  its clear lint report;
- `GOVERNING_SPEC` — an external product or interface specification;
- `DERIVED_CALCULATION` — a preserved calculation or budget artifact.

`brief.md` and legacy `PROJECT_BRIEF` prose are not accepted requirement bases.
They may display the structured baseline but cannot supply a missing numeric
requirement or product-function approval.

Do not copy a part rating into a design requirement. Derive load current from
the actual consumers and modes, input range from the real source and tolerance,
ambient from the product envelope, and required margin from the project policy.
Missing numeric inputs keep the selection `UNVERIFIED FOR FABRICATION`.

## Classify complete parameter coverage

Read
[component-parameter-profiles.md](component-parameter-profiles.md) and complete
all required `parameterCoverage` aspects for every PCB-included part. Classify
each aspect as `AUDITED`, `RECORDED`, or `NOT_APPLICABLE`; retain a concrete
rationale, link all sourced parameter IDs, and link every audited check ID.

The schema example above shows every required aspect but intentionally uses
placeholder rationales outside its one voltage check. Replace those placeholders
after applying the real component-class profile. The validator rejects a
missing aspect, an unclassified parameter, a check outside the coverage table,
or a used part with no audited aspect. An aspect that matters to
selection or reliable operation must be `AUDITED` or remain unresolved; do not
downgrade it to `RECORDED` merely because a calculation is inconvenient.

## Audit suitability

Link every critical populated part to deterministic `suitabilityChecks`. The
validator supports:

- `PARAMETER_AT_LEAST` — the part parameter must be at least the requirement;
- `PARAMETER_AT_MOST` — the part parameter must be no more than the requirement;
- `PARAMETER_RANGE_CONTAINS` — the supported part range must contain the whole
  board requirement range;
- `LINEAR_REGULATOR_THERMAL` — rated current, dropout headroom, and worst-case
  junction temperature must all pass.

For every populated part whose `functionClass` is `LINEAR_REGULATOR`, the
thermal check is mandatory. It uses:

```text
available_headroom = Vin_min - Vout
power_dissipation = max(0, Vin_max - Vout) * Iout_cont + Vin_max * Iq_max
estimated_Tj = ambient_max + power_dissipation * theta_JA
allowed_Tj = Tj_max - required_junction_margin
```

The record must supply minimum and maximum input voltage, output voltage,
continuous and peak current, maximum ambient, required junction margin, rated
current, maximum dropout, exact-package theta-JA, maximum junction temperature,
and optional maximum quiescent current. The audit also requires rated current
to cover peak current and minimum headroom to cover maximum dropout.

Use the documented exact-package thermal condition. If the manufacturer's
theta-JA test board differs materially from the planned copper or airflow,
retain a conservative qualified calculation rather than inventing an
improvement. A failed current, dropout, or thermal comparison is `FAIL`; a
missing input is `UNVERIFIED FOR FABRICATION`. A prose claim or manual “looks
okay” checkbox cannot replace the deterministic check.

## Resolve missing library devices and substitutes

Library availability is a CAD implementation state, not a selection criterion.
Search and bind the exact manufacturer part number first. Record one resolution:

- `EXACT_LIBRARY_DEVICE` — the exact MPN is bound to verified device, symbol,
  and footprint UUIDs;
- `CUSTOM_EXACT_DEVICE` — the MPN is unchanged and a custom device was built
  from the governing source; retain a nonempty qualification artifact proving
  symbol pins, pad numbers, package, land pattern, polarity/orientation, and
  exposed-pad treatment;
- `APPROVED_SUBSTITUTE` — the selected MPN differs and the substitution gate
  below is closed;
- `BLOCKED` — exact binding or approved substitution is unresolved. Stop the
  dependent schematic and handoff work.

Search the library by manufacturer part number, never by a value-plus-package
string. A query such as `10pF 0603` matches any library entry whose text contains
those tokens, including LEDs and other parts whose footprint name is `0603`, so
the result set does not establish part class, value, tolerance, voltage, or
dielectric. Resolve the exact MPN from the governing source first, search for
that MPN, then read back `getState_Manufacturer()` and
`getState_ManufacturerId()` on the placed component and require them to match the
evidence record. Accepting a search hit because its displayed name looks close
enough is a selection failure, not a shortcut; if MPN search returns nothing,
record `BLOCKED` or build a `CUSTOM_EXACT_DEVICE` rather than substituting a
similar-looking entry.

When the library lacks the requested exact part:

1. Keep the requested MPN and verified source decision unchanged.
2. Create and qualify a `CUSTOM_EXACT_DEVICE` from the manufacturer pinout,
   package, and land-pattern evidence.
3. If exact custom-device qualification cannot be completed, record `BLOCKED`.
4. Consider a different MPN only when the bound selection decision permits it
   or the user separately approves the substitution.

Use `FORBID` for a user-named exact part unless the user explicitly changes that
decision. Authorization to execute CAD work never authorizes changing an exact
MPN. Other policies are `ALLOW_FORM_FIT_FUNCTION` and
`ALLOW_FUNCTIONAL_ALTERNATIVE`.

An `APPROVED_SUBSTITUTE` needs a reason, approval reference, the candidate's own
verified manufacturer sources and parameters, and a preserved comparison
artifact. Resolve `electrical`, `pinout`, `package`, `footprint`, `thermal`,
`mechanical`, `firmware`, and `regulatory` as `MATCH`,
`EQUIVALENT_OR_BETTER`, `REQUALIFIED`, or `NOT_APPLICABLE`, with non-obvious
states explained in the artifact. A forbidden or silent MPN change is `FAIL`.

After an approved substitute, update the live EasyEDA MPN, source coverage,
parameters, suitability checks, symbol/footprint binding, and affected
schematic/PCB evidence together. Never use a similar-looking library symbol as
a placeholder for handoff.

## Bind evidence to the schematic

Bind the record to the live project UUID, schematic page UUID, and deterministic
design fingerprint. The fingerprint includes component identity, manufacturer
part number, supplier part number, footprint, and PCB-inclusion state. Require
the EasyEDA manufacturer's part number and footprint to match the evidence
record; a populated evidence row cannot repair missing live metadata.

Generate a new append-only record after any invalidating change. Never edit an
old record to make it describe a newer schematic.

## Run the audit gate

Run the baseline audit with the record:

```bash
node scripts/audits/easyeda_design_audit.mjs \
  --component-evidence evidence/audits/component-selection-evidence.json \
  --output evidence/audits/design-audit.json
```

For an offline captured design snapshot, validate only the selection evidence:

```bash
node scripts/lints/component_selection_evidence.mjs \
  --record evidence/audits/component-selection-evidence.json \
  --design-snapshot evidence/snapshots/schematic-semantic.json \
  --output evidence/audits/component-selection-check.json
```

Missing, inaccessible, unreadable, stale, incomplete, or unbound evidence
returns `UNVERIFIED FOR FABRICATION`. Duplicate entries, an observed mismatch
between the live EasyEDA manufacturer/MPN/footprint and the evidence, a failed
suitability calculation, or a forbidden substitution returns `FAIL`. Neither
result authorizes fabrication.

## Invalidate stale evidence

Invalidate and regenerate affected evidence after any change to:

- schematic fingerprint, component population, or designator;
- manufacturer, exact MPN, suffix, package, footprint, or pin mapping;
- governing document ID, revision, corrected errata, or reference design;
- a sourced parameter, requirement, suitability calculation, assumption, or
  disposition;
- library device/symbol/footprint binding, substitution policy, comparison, or
  approval;
- requirements that change topology, power, clock, protection, layout,
  mechanics, safety, fabrication, or assembly.

If an official source disappears after preservation, the hash-bound local
artifact remains traceable for that exact revision, but check for superseding
documents before a new review or part change. A newer revision does not silently
rewrite an earlier decision; it makes affected evidence stale until reviewed.

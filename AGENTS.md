# Workspace rules

## Repository and skill boundary

- Treat `skills/easyeda-pcb-design/` as the complete installable skill.
- Keep `SKILL.md`, `agents/`, `references/`, and runtime `scripts/` inside that
  directory so it remains self-contained.
- Keep repository-level files such as `AGENTS.md`, `.gitignore`, user-facing
  README files, and local development data outside the installable skill.
- Keep pure regression harnesses, prompt evals, CI wrappers, and other
  repository-only validation under repository-level `tests/` or `tools/`; runtime
  scripts inside the skill may keep `--self-test` checks for their own health.
- Do not copy repository-level files or `designs/` into a skill installation.

## Skill architecture guardrails

- Preserve progressive disclosure. Keep `skills/easyeda-pcb-design/SKILL.md`
  as the concise decision and routing entrypoint, not the complete PCB manual.
  Treat 260 lines and 1,600 words as a soft target, not a mechanical release
  gate. If the entrypoint exceeds 320 lines or 2,000 words, refactor or move
  details into a routed resource unless the excess is required to preserve a
  safety boundary, authorization gate, or formal output contract. Review any
  soft-target overage for duplicated detail before accepting it.
- Keep only these concerns in `SKILL.md`: trigger metadata, working-mode
  selection, baseline lifecycle, live API and authorization boundaries,
  technical-depth classification, direct reference routing, audit/evidence
  entrypoints, and the formal review output contract. Keep repository
  maintenance commands, including skill change validation, in `AGENTS.md`.
- Put specialized rules, schemas, API edge cases, examples, field lists, and
  audit implementation semantics in `references/`. Put deterministic or
  repeatedly used operations in `scripts/`. Keep each rule in one authoritative
  location; do not duplicate detailed prose between `SKILL.md` and references.
- Put reusable teaching examples and worked design/review cases in
  `skills/easyeda-pcb-design/references/` so they ship with the installed skill.
  Put deterministic test vectors beside their owning script or in an explicitly
  tracked fixture directory. Never use ignored `designs/` content as the only
  copy of a reusable example, rule, or regression fixture.
- Link every required reference directly from `SKILL.md` and state when to load
  it. Avoid reference chains deeper than one level. Give every reference longer
  than 100 lines a `## Contents` section near the top.
- Keep YAML frontmatter limited to `name` and `description`. Make `description`
  comprehensive enough to trigger the skill for its supported EasyEDA design,
  review, antenna, high-speed, and manufacturing scenarios. Keep
  `agents/openai.yaml` consistent with the current entrypoint and regenerate it
  when the triggering scope or default workflow changes.
- Keep the installable skill free of auxiliary process documents such as
  `README.md`, `CHANGELOG.md`, installation guides, or quick-reference copies.
  Record project-specific history under the relevant `designs/<board-slug>/`
  project or rely on repository history; do not add it to the runtime skill.
- Preserve the current human fabrication boundary, explicit high-risk-operation
  authorization, snapshot/readback requirements, and exact-revision evidence
  binding when simplifying text. Concision must not weaken safety or validation.
- After any skill change, run the skill-creator `quick_validate.py`, the
  change-validation commands below, relative-link checks, the over-100-line
  reference TOC check, and `git diff --check`. After a substantial structural or
  behavioral revision, also run independent read-only forward tests covering one
  baseline guidance request and one formal release or specialized-technology
  request.

## Skill change validation

Run from the repository root. These are repository maintenance commands; keep
them out of the installable skill, which is consumed by agents designing boards
rather than editing this skill.

Start with the contract lint. It is the cheap tier: it proves prose and scripts
still agree without starting an agent task, so it is the only command required
after a documentation-only edit.

```bash
node tests/lints/skill_reference_contract_lint.mjs
node tests/lints/skill_reference_contract_lint.mjs --self-test
```

`STALE_OPTION` and `MISSING_SCRIPT` mean a command block no longer matches its
script. `ORPHAN_TOKEN` means prose names a status no script implements: either
implement it or record it in `PROSE_ONLY_TOKENS` with a reason.
`STALE_PROSE_ONLY_ENTRY` and `UNUSED_PROSE_ONLY_ENTRY` mean that allowlist has
drifted from reality. The lint also prints the prose-only gates it accepts, so a
gate that is enforced by agent judgment alone stays visible instead of being
mistaken for a validated one.

Then run the deterministic suites:

```bash
node tests/audits/easyeda_audit_tests.mjs
python3 tests/calc/pcb_calc_tests.py
node skills/easyeda-pcb-design/scripts/lints/requirements_baseline_lint.mjs --self-test
node skills/easyeda-pcb-design/scripts/lints/component_selection_evidence.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/easyeda_identity_preflight.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/easyeda_revision_guard.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/easyeda_repair_snapshot.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/easyeda_gate_ledger.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/easyeda_execution_budget.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/easyeda_native_checkpoint.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/inspect_current_state.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/route_transaction.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/repair_transaction.mjs --self-test
node skills/easyeda-pcb-design/scripts/live/verify_gate.mjs --self-test
node skills/easyeda-pcb-design/scripts/audits/easyeda_placement_audit.mjs --self-test
node skills/easyeda-pcb-design/scripts/audits/easyeda_crystal_clock_audit.mjs --self-test
python3 skills/easyeda-pcb-design/scripts/lints/easyeda_stackup_decision_lint.py --self-test
python3 skills/easyeda-pcb-design/scripts/lints/easyeda_constraint_lint.py --self-test
python3 skills/easyeda-pcb-design/scripts/audits/easyeda_manufacturing_audit.py --self-test
node skills/easyeda-pcb-design/scripts/live/check_companion.mjs || true
```

Routing forward tests cover the behavioral surface no deterministic test reaches:
entry-state classification, scope bounds, mode, technical-depth tier, and which
references get loaded. Run the affected cases after editing the entrypoint's
routing tables, tier triggers, or reference list.

```bash
node tests/routing/run_routing_case.mjs --list
node tests/routing/run_routing_case.mjs --case <id>
node tests/routing/run_routing_case.mjs --self-test
```

Hand the emitted prompt to a fresh-context, read-only agent session and compare
its reply against the expectations the script prints. Never paste the
expectations into that session; observing unprompted routing is the whole point,
so a harness that fed them to the agent would prove nothing. Recorded pass
baselines and what they deliberately do not cover are in
`tests/routing/BASELINE.md`.

The antenna case is the only automated coverage of the prose-only gates the
contract lint reports, so keep it in the affected set whenever antenna or
primary-function routing changes.

## PCB test and process files

- Keep the repository root for repository governance, packaging information,
  and user-facing documentation only.
- Put every ad hoc or test PCB project under `designs/<board-slug>/`.
- Put generated PCB process evidence under the matching project directory:
  - `evidence/audits/` for ERC, DRC, baseline, routing, clearance, crystal, and
    high-speed audit reports.
  - `evidence/calculations/` for analytical calculators and planning output.
  - `evidence/netlist/` for netlist exports, comparisons, imports, and binding
    checks.
  - `evidence/snapshots/` for before-change, rollback, source, and preserved
    design snapshots.
  - `evidence/readbacks/` for EasyEDA API operation results, parity checks, and
    regression readbacks.
- Point audit and calculator output arguments directly at these directories;
  do not create generated JSON, audit reports, snapshots, or readbacks in the
  repository root and move them later.
- `designs/` is intentionally ignored by Git. Never use `git add -f` to add its
  contents. If a generated artifact must become a reusable tracked fixture,
  obtain explicit user approval and place only the curated fixture in a
  dedicated tracked fixture directory. Re-express reusable teaching content as
  an original routed reference instead of copying a local project wholesale.
- Preserve local process evidence for traceability. Do not delete, overwrite,
  or bulk-clean it without explicit user confirmation.

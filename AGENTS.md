# Workspace rules

## Repository and skill boundary

- Treat `skills/easyeda-pcb-design/` as the complete installable skill.
- Keep `SKILL.md`, `agents/`, `references/`, and runtime `scripts/` inside that
  directory so it remains self-contained.
- Keep repository-level files such as `AGENTS.md`, `.gitignore`, user-facing
  README files, and local development data outside the installable skill.
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
  entrypoints, the formal review output contract, and required regression
  commands.
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
- After any skill change, run the skill-creator `quick_validate.py`, all commands
  listed under `SKILL.md`'s change-validation block, relative-link checks, the
  over-100-line reference TOC check, and `git diff --check`. After a substantial
  structural or behavioral revision, also run independent read-only forward
  tests covering one baseline guidance request and one formal release or
  specialized-technology request.

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

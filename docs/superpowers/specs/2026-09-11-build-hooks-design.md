# Build-Time Guardrail Hooks — Design

**Status:** Approved by product owner in brainstorming session, 2026-09-11. Ready for `writing-plans`.
**Intent:** [`docs/superpowers/intents/2026-09-11-build-hooks-intent.md`](../intents/2026-09-11-build-hooks-intent.md)

## Problem

This project adopted Anthropic's AI-native SDLC playbook 2026-09-10. Its Stage 3 (Build) names
"Hooks: Build-time guardrails blocking edits to protected paths, running formatters, preventing
credential leaks" as a distinct component with no prerequisite of its own — confirmed by direct
inspection, no `.claude/settings.json` exists in this project, no hooks configured at all.
Independent of the `.claude/skills/` work designed the same day
(`docs/superpowers/specs/2026-09-11-claude-skills-design.md`).

## Methodology (the actual deliverable of this design's first pass)

Presented with an initial candidate list of protected paths, the product owner explicitly
rejected picking from it ad hoc and required a stated, reusable rule first: "the methodology MUST
be clear and unambiguous... do the brainstorming and report" before any specific path got named.
The methodology that resulted, and that everything below is derived from rather than guessed:

A path is worth a hard-blocking hook only if it clears one of three tests on its own — never on
"feels risky" alone — with a fourth test acting as the brake that keeps the list from creeping:

1. **Is this file evidence of something that already happened, or a plan still being shaped?** A
   file that stops being "code to edit" the moment some real-world action completes (an applied
   migration, a computed pipeline output, a resolved dependency lock file) is a historical record
   from that point on — editing it afterward doesn't change what happened, it just makes the
   record lie. Does **not** apply to files meant to keep evolving (`CLAUDE.md`, `storage.ts`, the
   specs/plans themselves) — blocking those would break normal work, not protect anything.
2. **If this leaks outside the repo, is "undo the edit" even a meaningful response?** Credentials
   are the one category where the goal is pure prevention, not reversibility — once a secret is
   committed, logged, or printed, reverting the change doesn't un-leak it; the secret itself is
   now compromised.
3. **Does writing here silently cross a boundary this project has already named as a hard line?**
   A real example exists (EXIOBASE's non-commercial license), but this category is about
   product/business-scope judgment, not a file-edit shape — it doesn't automatically produce a
   mechanical hook (see below).
4. **Would blocking this path actually get in the way of legitimate daily work?** The
   counterweight to the first three. A hook that blocks something legitimate gets disabled or
   routed around the first time it happens, which quietly destroys trust in every *other*
   guardrail it enforces too. This test rejected two of the original candidate paths outright
   (see "Protected paths," below).

## Protected paths (category 1 applied)

Hard-blocked from `Write`/`Edit`/`MultiEdit`:

- `scripts/manual-migration-*.mjs` — every file that currently exists is presumed already-applied
  against the shared dev/production database. New schema work always creates a new numbered file
  (`016` is next); this rule needs no dynamic "has this actually run" check, because a
  not-yet-created file can't be edited, only created — the protection is self-limiting to files
  that already exist.
- `scripts/exiobase/output/*.json`, `scripts/exiobase/gwp_weights.json` — matches
  `scripts/exiobase/README.md`'s own already-written rule ("never hand-edit, regenerate by
  re-running the whole pipeline") verbatim. This hook is the first thing that actually enforces
  it instead of only stating it.
- `package-lock.json` — a generated record of what npm resolved, not authored source. Hand-editing
  it desyncs the record from what's actually installed, the same failure mode as editing an old
  migration.

**Explicitly not protected, and why (category 4 rejecting two of the original candidates):**
- `vercel.json` — actively-maintained deployment config (already edited once, for the
  cleanup-unverified-users cron job), not a record of a past event. No incident behind blocking it,
  and doing so would obstruct a real, expected future need.
- `.env` — editing your own local `.env` to add a new credential is legitimate, expected work
  (done twice already this session, for `GEMINI_API_KEY` and `BLOB_READ_WRITE_TOKEN`). Its actual
  risk is category 2's concern (its *values* leaking into some other file), not edits to itself —
  it is explicitly excluded from the credential scan below as the one legitimate place secrets
  belong.
- Specs/plans/intents, even once approved and shipped — a real theoretical case exists (rewriting
  history the same way an old migration edit would), but no actual incident has happened, the
  convention (write a new file, never edit an old one) has held by habit, and reliably detecting
  "has this specific plan's feature shipped yet" would require the hook to read
  `docs/superpowers/INDEX.md`'s current Stage for that row — real, stateful complexity
  disproportionate to a risk that hasn't materialized. Left as a named, conscious limitation, not
  a silent gap.

## Credential leak prevention (category 2 applied)

Not a fixed path list — a content scan, since a secret can appear anywhere. Scans the content of
any `Write`/`Edit`/`MultiEdit` targeting a file **other than `.env` itself** for the pattern
`<VARNAME>=<non-empty value>`, where `<VARNAME>` is any variable name already declared in
`.env.example` (currently: `DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`,
`CRON_SECRET`, `PORT`, `NODE_ENV`, plus `GEMINI_API_KEY` and `BLOB_READ_WRITE_TOKEN` once the
document-extraction plan executes). This makes the check self-maintaining: whenever a new
credential is added to `.env.example` — which has already happened twice this session — the hook
starts protecting it automatically, with no separate hook-config update required. A match blocks
the write with a clear message naming which variable triggered it, never silently strips or
redacts (a silent strip could mask a real problem instead of surfacing it).

## Named boundary crossings (category 3 — no hook produced)

The EXIOBASE non-commercial license is the clear real example of this category, but "is this code
wiring EXIOBASE data into a customer-facing, revenue-generating feature" is a product-scope
judgment call, not a pattern a deterministic hook can evaluate. The existing control — the license
comment block at the top of `build_factors.py` and its README — remains the right mechanism.
No hook is built for this category in this design; forcing one into existence to fill the category
would fail test 4 (added complexity for a risk this pre-revenue, pre-customer project hasn't
actually faced yet).

## Formatter (the third guardrail type)

**Config, grounded in this codebase's actual style, not assumed:** direct inspection of
`server/routes.ts`, `server/storage.ts`, `shared/schema.ts` found double quotes dominant 571-to-103
in `routes.ts` alone (Prettier's own default), 571 lines already ending in a trailing comma
(matches `trailingComma: "all"`, also default), zero semicolon-less line endings found (matches
`semi: true`, also default). The one real deviation: 212 lines over 100 characters and 74 over 120
in `routes.ts` alone — this codebase deliberately tolerates long lines for its dense,
incident-citing comments and long error-message strings. Prettier's default `printWidth: 80` would
aggressively rewrap a large amount of that content for no benefit. **Config is effectively one
override: `printWidth: 120`.** Everything else already matches Prettier's defaults.

**One-time full repo-wide reformat** (explicit product-owner decision, made with the
line-number-staleness tradeoff for `docs/superpowers/plans/2026-09-10-document-extraction.md`
named and accepted — tracked as an explicit priority in
[`docs/superpowers/INDEX.md`](../INDEX.md)'s "Next priorities, in order" section, not restated
here):

- Scoped to source extensions only: `.ts .tsx .js .mjs .jsx .css`.
- Excludes everything named as protected above (`scripts/manual-migration-*.mjs`,
  `scripts/exiobase/output/**`, `scripts/exiobase/gwp_weights.json`, `package-lock.json`), plus
  the standard `node_modules`, `dist`.
- Excludes `docs/**/*.md` (including `CLAUDE.md`, `INDEX.md`, every spec/plan/intent) entirely —
  the document-extraction plan's stale-reference risk is specific to source-code line references;
  reformatting prose markdown adds real risk (rewrapped tables, reflowed comment-style paragraphs)
  for close to no benefit, so markdown is simply out of scope rather than needing its own careful
  exclusion.
- Runs as its own atomic commit — no other change mixed into it, so the diff is provably
  formatting-only.
- `npm run check` runs immediately after, to prove `tsc` still passes rather than assume a
  whitespace/quote-style pass couldn't have broken anything.

**Going forward:** a `PostToolUse` hook on `Write`/`Edit`/`MultiEdit` auto-runs Prettier on
whatever file was just touched (same exclusions as the one-time pass). Auto-*fix*, not
block-and-complain — matches the playbook's own wording ("running formatters," not "checking
formatters") and fits this project's solo-developer-plus-AI context: formatting has a safe,
deterministic auto-fix, unlike the credential scan and protected-path block, which must refuse
rather than silently correct. This also cleanly separates the three guardrails by hook event:
protected-paths and credential-scan are `PreToolUse` (block before the write happens), formatting
is `PostToolUse` (fix up after a legitimate write lands).

## Testing

- Protected-path block: attempt a `Write`/`Edit` against an existing `manual-migration-*.mjs`
  file, an `exiobase/output/*.json` file, and `package-lock.json` — each must be refused with a
  clear message naming which rule blocked it. Attempt the same against `vercel.json` and `.env` —
  each must succeed, proving the rejection list (category 4) actually holds.
- Credential scan: attempt to write a file containing `DATABASE_URL=postgresql://real-looking`
  outside `.env` — must be refused. Attempt the same content targeting `.env` itself — must
  succeed. Add a new name to `.env.example`, then attempt writing `<newname>=value` elsewhere —
  must also be refused, proving the scan is genuinely driven by `.env.example`'s live contents,
  not a hardcoded list frozen at build time.
- Formatter: after the one-time reformat, `npm run check` passes. After the ongoing hook is wired,
  editing any non-excluded file with deliberately inconsistent formatting results in it being
  auto-corrected on save, and editing an excluded file (e.g. a migration) leaves its formatting
  untouched even though the protected-path block would have refused an edit to it anyway.

## Explicitly out of scope

- A mechanical hook for category 3 (named boundary crossings) — see above; the existing
  documentation control stands.
- Protecting specs/plans/intents from edits — see "Explicitly not protected" above.
- The exact `.claude/settings.json` hook JSON syntax and event wiring — mechanical detail for the
  implementation plan (`writing-plans`), informed by the `update-config` skill's guidance on
  correct hook configuration, not part of this design.
- Refreshing `docs/superpowers/plans/2026-09-10-document-extraction.md`'s stale line references —
  tracked separately as Priority 1 in `docs/superpowers/INDEX.md`, not built as part of this plan.

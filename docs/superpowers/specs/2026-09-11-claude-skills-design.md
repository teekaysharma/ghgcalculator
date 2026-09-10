# Project-Specific `.claude/skills/` — Design

**Status:** Approved by product owner in brainstorming session, 2026-09-11. Ready for `writing-plans`.
**Intent:** [`docs/superpowers/intents/2026-09-11-claude-skills-intent.md`](../intents/2026-09-11-claude-skills-intent.md)

## Problem

This project adopted Anthropic's AI-native SDLC playbook 2026-09-10. Its Stage 3 (Build) names
"version-controlled, project-specific policy skills (security standards, API design, brand rules)
in `.claude/skills/`" as a distinct component from the generic process skills already in use
(`brainstorming`, `writing-plans`, `subagent-driven-development`) — confirmed by direct
inspection, no `.claude/skills/` directory exists yet. Several real, consistently-followed
conventions in this codebase — some born from actual incidents — currently live only in code
comments, `CLAUDE.md` prose, or session memory, discoverable only by someone who already knows to
look for them, not by a fresh session or a different agent opening this repo cold.

Skills also matter beyond documentation value: per the playbook's own dependency graph, "PR review
requires updated `CLAUDE.md` and skills." `CLAUDE.md` is done; this closes the other half,
unblocking Stage 5 (Deploy) work later.

## Structure (locked in during brainstorming)

**Three focused skills**, not one monolith and not a fourth dedicated security skill:

1. `database-conventions` — how this project's data layer must be touched.
2. `ghg-domain-conventions` — GHG/ISO calculation-correctness rules specific to this product's
   actual purpose. The most consequential of the three: a wrong rule here doesn't just break
   code, it produces a wrong number in something meant to survive third-party verification.
3. `api-conventions` — how routes get written, including the security-relevant parts (auth
   middleware, rate limiting, password handling) folded in directly rather than spun out into a
   thin fourth skill. At this project's actual scale (solo developer, MVP stage), most of the
   real security rules already ARE about how a route gets written — a dedicated security skill
   would mostly restate the same content from a different angle.

Each lives at `.claude/skills/<name>/SKILL.md`, matching the directory-per-skill convention every
other skill in this environment already uses — auto-discovered by Claude Code as a project skill
once created, no extra wiring needed.

**Trigger descriptions** (what makes each one auto-invoke, per the `using-superpowers` "if a
skill might apply, invoke it" rule):
- `database-conventions`: touching `shared/schema.ts`, a migration script, or `server/storage.ts`.
- `ghg-domain-conventions`: touching emission-factor selection, GWP values, calculation-approach
  logic, biogenic handling, unit conversion, or a reporting boundary's finalized state.
- `api-conventions`: adding or modifying an Express route.

## Relationship to `CLAUDE.md`

`CLAUDE.md`'s existing "Stack and architecture rules (non-negotiable)" section states several of
these rules already, in one-liner form. Once the skills exist, those bullets shrink to the
one-liner plus a pointer to the relevant skill (e.g. "Every tenant-scoped table query must filter
on `organizationId`. No exceptions. See `database-conventions` skill for the incident history and
exact pattern.") — the skill holds the full detail, the code pattern, and the incident that
justifies each rule. Nothing is maintained in two places that could drift apart, which is exactly
the failure mode that already hit this project twice (`HANDOFF-SESSION.md`, `iso-controls-matrix.md`
both going stale because nothing tied their upkeep to the change that made them stale).

## `database-conventions` — content

1. **`organizationId` scoping, no exceptions.** Every tenant-scoped query filters on it — 6
   `upsertX` methods in `server/storage.ts` already shipped without this in their conflict
   condition and had to be fixed. Pattern: `.where(and(eq(table.id, id),
   eq(table.organizationId, organizationId)))`, every time.
2. **Idempotent hand-written migrations only.** `drizzle-kit push` is retired — confirmed broken
   3× against this schema/environment. Every `scripts/manual-migration-NNN.mjs` follows the same
   shape: `information_schema` check before any DDL, `applied`/`skipped` tracking, one
   transaction, safe to re-run.
3. **`db.batch()`, never `.transaction()`.** `drizzle-orm/neon-http` throws at runtime on
   `.transaction()`.
4. **`undefined` omits, `null` clears — know which one you're sending.** Drizzle's
   `onConflictDoUpdate` drops `undefined` keys from its `SET` clause but writes an explicit
   `null` as-is. Getting this backwards on a field like `gasBreakdown` silently wipes a persisted
   audit trail on an unrelated edit.
5. **Destructive operations are two genuinely separate steps.** Dry-run and print, stop, read the
   output, *then* a separate execute call — never chained in one script run. Established after
   the 2026-09-09 incident where a chained check-then-delete script deleted an org without
   pausing to react to its own diagnostic output.

## `ghg-domain-conventions` — content

1. **GWP values are versioned and sourced, never hardcoded.** Every gas's GWP-100 comes from the
   live `gwp_values` table (AR6 by default, `gwpVersion` tagged at the schema level), never typed
   into a script twice.
2. **Emission factor sourcing hierarchy, enforced in order:** local/site-specific → national →
   regional → named global agencies (IEA, IPCC EFDB, UNFCCC, GHG Protocol, DEFRA) → IPCC generic
   defaults. Any IPCC-default substitution must be flagged in the data-quality fields
   (`usedIpccDefaultFactor`, `ipccDefaultSubstitutionReason`) — never a silent fallback.
3. **Every selected emission factor carries a traceable source.** `emissionFactorSourceUrl` +
   `emissionFactorAuthorityName` ride alongside the number.
4. **Biogenic CO2 is a memo item, never counted in gross totals.** Pulled out of Scope 1/2/3
   gross figures and reported separately, per GHG Protocol/ISO convention.
5. **The server recomputes emissions itself, never trusts a client-submitted total.** Whenever
   both a quantity and a factor are present, `calculatedEmissionsTco2e` is derived server-side.
6. **Only the sanctioned unit-conversion path is allowed.** Weight-basis (kg/tonnes) against an
   energy-basis (TJ) factor converts via a fuel's net calorific value; anything else is rejected
   with an explicit 400, never guessed.
7. **A finalized reporting boundary is immutable.** ISO 14064-3 treats a GHG statement as a
   fixed, dated snapshot — once `reportingBoundaries.status = "finalized"`, no route writes to
   its scoped data without going through the explicit, reasoned recalculate flow. Practical check
   is `finalizedLockMessage`, cross-referenced from `api-conventions`.

## `api-conventions` — content

1. **Every tenant-scoped route: `requireAuth + requireOrg`, no exceptions.** Cross-tenant
   (super-admin) routes use `requireAuth + requireSuperAdmin` instead — never both together.
2. **Before any write to a reporting-boundary-scoped resource, check `finalizedLockMessage`.**
   The practical enforcement of `ghg-domain-conventions`' immutability rule — reject with `409`
   if it returns a message.
3. **Response envelope keys are singular-camelCase, matching the resource.**
   `sourceStream`/`sourceStreams`, `calculationApproach`, `measurementApproach`,
   `dataQualityRecord` — a confirmed (not guessed) convention.
4. **Optional-but-sent-as-empty-string fields use the trim+transform pattern, never bare
   `.min(1).optional()`.** `z.string().trim().optional().transform((v) => (v && v.length > 0 ?
   v : undefined))` — a real registration bug shipped from getting this wrong.
5. **Server-side validation always duplicates client-side validation.** A client-side check is
   never the only gate.
6. **Security baseline for auth-sensitive routes:** bcrypt hashing (`SALT_ROUNDS = 12`), rate
   limiting via `express-rate-limit` on register/login/forgot-password, every access-control
   action logged regardless of actor tier, no admin route ever sets or sees a user's actual
   password.

## Format

Each `SKILL.md` follows the same YAML-frontmatter-plus-markdown-body shape every other skill in
this environment uses (`name`, `description` for the trigger, then the body). Body style matches
this project's established documentation culture: state the rule, then *why* — citing the real
bug or incident behind it where one exists, not just an assertion. This is a deliberate content
requirement, not a formatting nicety: a rule with no stated reason invites being "corrected away"
by someone who doesn't know the incident it prevents.

## Testing

Skills are documentation/instruction artifacts, not executable code — no automated test applies.
Verification is behavioral: after creation, a plausible task touching each trigger area (e.g.
"add a new tenant-scoped storage method") should cause the relevant skill to actually surface via
the `using-superpowers` mechanism. This gets checked manually once each skill exists, not via a
script.

## Explicitly out of scope

- A fourth, dedicated security skill — folded into `api-conventions` instead (see Structure
  above).
- Hooks (build-time guardrails) — a separate, independently-startable playbook component, not
  part of this design.
- Retroactively auditing every existing route/query/migration against these rules for compliance
  — this design documents the conventions; a full compliance sweep is a separate, larger task not
  requested here.

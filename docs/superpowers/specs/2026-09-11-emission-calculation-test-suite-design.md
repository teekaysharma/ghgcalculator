# Emission-Calculation Test Suite — Design

**Status:** Approved by product owner in brainstorming session, 2026-09-11. Ready for `writing-plans`.
**Intent:** [`docs/superpowers/intents/2026-09-11-emission-calculation-test-suite-intent.md`](../intents/2026-09-11-emission-calculation-test-suite-intent.md)

## Problem

This project adopted Anthropic's AI-native SDLC playbook 2026-09-10. Its Stage 4 (Test) names a
"Feedback Loop" ("Claude verifies its own work... before human review") and "Continuous Evals"
(a regression suite gating `CLAUDE.md`/skills/hooks changes) as distinct components — confirmed
gap: zero `.test.`/`.spec.` files anywhere in this repo, no test framework installed. What exists
today (`npm run verify`, `verify-*.mjs`) are real end-to-end smoke checks against a live dev server
and database — genuine self-verification, but happy-path only, no regression coverage.

## Scope decision (why this, not "a test suite")

Building comprehensive test coverage for this codebase (3,200+ lines in `server/routes.ts`,
2,000+ in `server/storage.ts`, multi-tenant auth, real GHG calculation logic) is too large for a
single spec — flagged and decomposed during brainstorming rather than attempted whole. This spec
covers the **first slice only**: the GHG calculation arithmetic in
`PUT /api/source-streams/:id/calculation-approach`. Chosen over tenant-isolation regression
coverage (the actual bug class already caught once, 2026-08-03) and over testing the just-built
Hooks, as the highest domain-correctness risk this product carries — a wrong number here is the
core defect category, feeding directly into GHG statements meant to survive third-party
verification.

This also closes part of the playbook's own dependency graph — "Evals require feedback loop" — by
establishing a baseline regression-check mechanism. It is that baseline, not the full
Continuous-Evals gate itself (which would additionally need to run on every `CLAUDE.md`/skill/hook
change specifically — a separate, later piece of work).

## Architecture

**Extraction, not a rewrite.** The calculation arithmetic currently lives inline inside the route
handler (`server/routes.ts:2528-2581`) with no DB or HTTP dependency of its own — it is pure
computation that happens to sit inside an Express handler. Extracted to a new file,
`server/calculations/emission-calculation.ts`:

```ts
export interface GasBreakdownComponentInput {
  gas: string;
  netCalorificValue?: number;
}

export interface EmissionCalculationInput {
  activityDataValue: number | null | undefined;
  activityDataUnit: string | null | undefined;
  emissionFactorValue: number | null | undefined;
  emissionFactorUnit: string | null | undefined;
  gasBreakdown: GasBreakdownComponentInput[] | null | undefined;
}

export type EmissionCalculationResult =
  | {
      status: "computed";
      computedEmissionKg: number;
      activityValueInFactorUnit: number;
      appliedNetCalorificValue: number | null;
    }
  | { status: "rejected"; reason: string }
  | { status: "insufficient_data" }; // neither quantity nor factor present -- nothing to compute

export function calculateEmission(input: EmissionCalculationInput): EmissionCalculationResult;
```

Same `WEIGHT_UNITS_PER_GG` table (`kg`/`kgs`/`kilogram`/`kilograms` → 1,000,000;
`t`/`tonne`/`tonnes`/`ton`/`tons`/`metric tonne`/`metric tonnes` → 1,000), same conversion logic,
same rejection message text — moved verbatim, not rewritten. `server/routes.ts`'s handler then
calls this function and uses its result exactly where the inline logic used to sit.

**Behavior must be byte-identical before and after the extraction** — this is a relocation, not a
behavior change. The implementation plan's verification must prove this concretely: the existing
`npm run verify` end-to-end smoke test (which exercises this exact calculation through a real
save) must still pass, unchanged, after the refactor.

**Test runner:** Vitest, added as a devDependency — ecosystem-standard fit for this already-Vite-
based project (the client build already uses Vite), fast, native ESM/TS support. A
`vitest.config.ts` targets `server/**/*.test.ts`; `package.json` gains a `"test": "vitest run"`
script, kept entirely separate from `"verify"` (the live-server smoke check stays exactly what it
is today, not replaced).

## Test cases

Six cases, each tied to a real branch in the existing code or a real, already-documented domain
constraint — not padding for coverage's sake:

1. **Units already match** (e.g. both `"TJ"`) — no conversion attempted; `activityValueInFactorUnit`
   equals the input quantity exactly; `computedEmissionKg = quantity × factor`.
2. **Weight-to-energy conversion via NCV, kilograms** — `kg` activity data against a `TJ` factor,
   with a CO2 gas-breakdown component carrying a net calorific value. Asserts the exact formula:
   `(activityDataValue × netCalorificValue) / 1_000_000`.
3. **Same conversion, tonnes** — proves the `WEIGHT_UNITS_PER_GG` lookup is actually exercised for
   a second key (divisor `1_000`), not just kilograms happening to work.
4. **Volume-basis unit, no conversion path** (e.g. `litres` against a `TJ` factor) — must return
   `status: "rejected"`. This is the deliberate, disclosed scope boundary (volume→energy needs a
   fuel-density dataset that doesn't exist yet) — a real domain rule worth protecting from silent
   regression.
5. **A fuel with no net calorific value on its CO2 component** (matches the real biogenic-fuel
   case seeded by `manual-migration-008.mjs`, which has no NCV) — must also return
   `status: "rejected"`, never silently compute a wrong number from a missing conversion factor.
6. **Neither quantity nor factor present** — returns `status: "insufficient_data"` cleanly
   (matches the route's existing fallback-to-manual-entry behavior), not a crash.

## Testing (of the test suite itself)

- `npm run test` (new) runs the six cases above, all passing, in well under a second (pure
  function, no I/O).
- `npm run check` (existing, `tsc`) stays clean after the extraction.
- `npm run verify` (existing, live-server smoke test) stays passing unchanged — the concrete proof
  that the extraction didn't alter behavior.

## Explicitly out of scope

- Tenant-isolation regression coverage, hooks testing, auth-flow testing, or any other slice of
  the codebase — deferred, to be designed separately if/when prioritized.
- The full "Continuous Evals" mechanism (gating `CLAUDE.md`/skills/hooks changes on pass rates) —
  this spec builds the baseline regression check that mechanism would eventually depend on, not
  the gate itself.
- CI/CD wiring (running `npm run test` automatically on push) — no `.github/` directory exists yet
  in this project; that's separate, already-tracked work in `docs/superpowers/INDEX.md`.
- Any change to the route handler's actual behavior — this is a pure extraction; if the six test
  cases reveal the existing logic does something surprising, that's a finding to report, not
  something to silently "fix" as part of this work.

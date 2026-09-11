# Intent: Emission-Calculation Test Suite (First Slice of the Stage 4 Test Gap)

**Originator:** teekaysharma@googlemail.com (product owner)
**Captured:** 2026-09-11
**Status:** Accepted — proceeded to Stage 2 (Design)

## Origin, in the originator's own words

Raised by quoting the Stage 4 correlation row directly, mid-way through the Hooks
`subagent-driven-development` setup — interrupting that work to take this up first:

> "4. Test — Feedback loop	Claude verifies tests/build/output before a human ever looks	Partial.
> npm run verify (scripts/verify-branch.mjs) plus several standalone verify-*.mjs scripts do real
> end-to-end smoke checks against a running server — genuine self-verification, but happy-path
> only.
> This step needs to be built"

## Context at time of capture

Confirmed by direct inspection: zero `.test.`/`.spec.` files anywhere in this repo, no test
framework installed (`vitest`/`jest`/`mocha` all absent from `package.json`, no config files
present). Building "a test suite" for this codebase in one pass was flagged as too large for a
single spec during brainstorming — decomposed into a first slice rather than attempted whole.

Three real decisions were made during that decomposition, not assumed:
1. **Which slice first** — the GHG calculation/emission-factor arithmetic in
   `PUT /api/source-streams/:id/calculation-approach`, chosen over tenant-isolation regression
   coverage or testing the just-built hooks, as the highest domain-correctness risk (a wrong
   number here is the core product defect category).
2. **How to reach it** — extract the arithmetic into a pure, importable function first (a
   deliberate, scoped refactor), rather than testing the existing inline logic only through live
   HTTP calls against a real server and database (the same mechanism `verify-*.mjs` already uses).
3. **Test runner** — Vitest, over Node's built-in `node:test` (zero new dependencies) — chosen for
   ecosystem fit with this already-Vite-based project despite the added dependency.

This closes part of the playbook's own dependency graph: "Evals require feedback loop" — before a
Continuous-Evals mechanism can gate `CLAUDE.md`/skills/hooks changes on pass rates, a baseline
regression-check mechanism needs to exist. This is that baseline, not the full Continuous-Evals
system itself.

Pausing the in-flight Hooks `subagent-driven-development` execution to take this up first was a
deliberate reprioritization, tracked separately in `docs/superpowers/INDEX.md`'s "Next priorities"
section — not restated here.

## Disposition

Accepted. Proceeded to Stage 2 (Design) via `superpowers:brainstorming`. Resulting artifact:
[`docs/superpowers/specs/2026-09-11-emission-calculation-test-suite-design.md`](../specs/2026-09-11-emission-calculation-test-suite-design.md).

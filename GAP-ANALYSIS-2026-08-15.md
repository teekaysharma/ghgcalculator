# GHG Calculator — Gap Analysis for Corporate/Commercial Sale

Session date: 2026-08-15. Branch `saas-multitenant`, HEAD `1497c43`. This continues [GAP-ANALYSIS-2026-07-29.md](./GAP-ANALYSIS-2026-07-29.md) — read that first for the EAD-benchmark granularity findings it raised; most of what it flagged as missing has since been built (see "Closed since 2026-07-29" below) in the same session that produced this document.

This review has full exec/DB access (unlike the 2026-07-29 session, which was read-only) — findings below were checked against the actual running code, `npm run check`, and the live Neon schema, not inferred.

## Closed since 2026-07-29 (context, not new findings)

The 2026-07-29 doc's biggest finding was a granularity gap against the Abu Dhabi EAD facility-level MRV template — no source-stream level detail, no calculation-approach tiers, no verification/data-quality tracking, no management/QA or mitigation-measures fields. All of that has since been built: `source_streams`, `calculation_approaches` (per-gas, ISO/TS 14064-4-compliant), `measurement_approaches`, `fallback_approaches`, `methane_reports`, `data_quality_records`, `verification_findings`, `management_qa_records`, `mitigation_measures`, plus a finalize/recalculate snapshot mechanic (ISO 14064-3), consolidated org-level rollup across facilities with three consolidation approaches (operational/financial/equity-share control), biogenic CO2 handled as a memo item, GRI 305-4/IFRS S2 intensity ratios, and GWP sourced from a versioned AR6 reference table. This is now a genuinely standards-literate calculation engine — that part of the product is closer to sale-ready than the surrounding SaaS shell is.

## 1. GHG-domain / standards gaps still open

- **Emission-factor library is stationary combustion only.** IPCC default factors exist for one category (12 fossil fuels + 11 biogenic fuels × 4 sectors). Mobile combustion, fugitive emissions (refrigerants), process emissions, purchased electricity grid factors (Scope 2), and the entire Scope 3 category set (15 GHG Protocol categories) have no seeded reference data — the schema supports them (org-uploaded factors with country/source tracking), but a corporate buyer expects defaults out of the box the way DEFRA/EPA-branded tools ship them. This is the single largest content gap between "impressive engineering" and "usable by a customer on day one."
- **Biogenic bundles aren't labeled in the picker.** Flagged by the implementer who built biogenic aggregation (see `.superpowers/sdd/2026-08-14-verification-ready-inventory-01-schema-migration/biogenic-and-unit-conversion-report.md`): a user selecting a biogenic fuel sees one combined factor number, with no indication that ~99% of it will be moved to the memo line at report time. Confusing and a credibility risk with a verifier.
- **Biogenic fuels have no Net Calorific Value seeded**, so kg/tonne activity-data entry against them still 400s (only the 12 fossil fuels got NCV backfilled). Volume-basis units (liters, m³) remain unconverted for everything, pending a fuel-density dataset — disclosed and reasonable to defer, but worth a roadmap line since liters is a common way fuel purchases are actually invoiced.
- **No Scope 3 category structure.** `scope3Category` exists as a free-text field on legacy records but the new source-stream/calculation-approach model has no explicit Scope 3 category enum or category-specific guidance (e.g. Category 1 Purchased Goods vs Category 6 Business Travel need different data-collection UI, not one generic form). For a tool sold on "usable anywhere globally," Scope 3 is usually >70% of a company's footprint and currently the weakest-modeled part of the schema.
- **No target-tracking / SBTi alignment beyond base year.** Base year is now settable, but there's no reduction-target field, no trajectory chart against a target line, no SBTi-style validation status. Companies buying a GHG tool today are very often buying it *because* they need to publish and track a target, not just an inventory.
- **No multi-gas-inventory report templates.** The consolidated report is one shape. Corporate buyers usually need to export into a specific disclosure format (CDP questionnaire structure, GRI 305 table format, a BRSR/ESRS-shaped export) — right now there's one CSV export and no framework-specific output.

## 2. Enterprise security & compliance readiness — the biggest blocker to "corporate"

This is the category that most determines whether a corporate legal/procurement/InfoSec team will say yes, and it's the least built out.

- **No test suite at all.** Zero `.test.`/`.spec.` files anywhere in the repo. `npm run verify` is a real, valuable end-to-end smoke script, but it's one script covering the happy path, not a regression net. Any enterprise security review or due-diligence process will ask "what's your test coverage" and the honest answer today is none.
- **No CSRF protection.** Session cookies are `sameSite: lax` (partial mitigation) but there's no CSRF token on state-changing requests. `sameSite: lax` blocks cross-site POST via most vectors but isn't a substitute for CSRF tokens in a security review.
- **No `helmet` or equivalent security-header middleware** — no CSP, no `X-Frame-Options`, no HSTS enforcement at the app layer (may be handled by a reverse proxy in production, but nothing in this repo guarantees it).
- **No general audit log.** Recalculation reasons are logged as verification findings (good, standards-driven), but there's no system-wide "who changed what, when" trail across facilities, calculation approaches, team membership changes, etc. — something SOC 2 / ISO 27001 readiness and most enterprise contracts require as a baseline.
- **No password reset / forgot-password flow**, no MFA/2FA. Both are now close to table-stakes for any B2B SaaS handling a company's disclosure-grade data.
- **Invite flow has no rate limiting** and no real email delivery — invites only attach an already-registered account; the invited person must already have signed up. Fine for a pilot, not for onboarding a real customer's team.
- **No SSO/SAML/OIDC.** Mid-size and larger corporate buyers routinely require SSO as a contractual condition, not a nice-to-have.
- **No data-residency or deletion story.** No documented policy or mechanism for org data export/deletion on request (GDPR Article 17 / general enterprise data-processing-agreement expectations). Given this product's actual selling point is regulatory-grade emissions disclosure, buyers will ask about *this* tool's own data handling too.
- **No dependency/vulnerability scanning or SBOM.** No `npm audit` in the verify script, no Dependabot/Renovate config, no `.github` workflows at all — there is currently no CI of any kind, not even a lint/typecheck gate on push.

## 3. SaaS commercial-readiness gaps

- **No billing/subscription layer.** No Stripe (or equivalent) integration, no plan tiers, no seat limits, no usage metering, no upgrade/downgrade path. Nothing in the schema models a subscription at all — `organizations` has no plan/status field.
- **No admin/ops surface.** No way to see cross-tenant health, org count, active users, or error rates without querying Postgres directly. Needed before or shortly after a first paying customer, not deferred indefinitely.
- **No onboarding flow beyond the Setup panel.** Setup now correctly shows a completion state (today's fix), but there's no guided "first reporting entity, first facility, first calculation" wizard with sample data, no product tour, nothing that reduces time-to-first-value for a buyer trying to self-serve evaluate the product.
- **Hosting/deployment target is still undecided, and it's architecturally load-bearing** (carried over from 2026-07-29, still true): `server/db.ts` uses Neon's HTTP driver (serverless-friendly) but `server/index.ts` uses a persistent `pg.Pool` for sessions via `connect-pg-simple` — incompatible with Vercel-style serverless functions as-is. No `Dockerfile`, no `render.yaml`/`fly.toml`/Procfile — there is currently no repeatable, documented production deployment path at all. This needs to be decided and built before any customer-facing rollout, not left implicit.
- **No customer-facing documentation** — no in-app help, no public docs site, no API reference for the REST endpoints (which do exist and are reasonably clean, just undocumented externally).

## 4. Product/UX polish gaps

- **No PDF export.** Only CSV. A GHG report going to a board, auditor, or regulator is normally expected as a formatted PDF (or at minimum, a clean print stylesheet) — CSV alone reads as a data dump, not a deliverable.
- **No email notifications** at all (invite completion, finalize confirmation, recalculation alerts to team members) — everything is synchronous, in-app only.
- **`EmissionFactorPicker` doesn't visually distinguish biogenic vs fossil bundles** (see 1 above) — a UX issue as much as a domain-correctness one.
- **No bulk data import beyond the legacy xlsx upload path**, which predates the source-stream model and isn't confirmed wired to it — worth verifying whether large-facility customers can bulk-load activity data or must enter every source stream by hand.
- **No mobile-responsive verification done** on any of this session's new UI (Facility Details tab, Setup completion state, boundary metrics panel) — flagged by the implementer as DOM/network-verified, not visually/responsively verified.
- **No accessibility audit** — Radix UI primitives give a reasonable baseline (used throughout), but nothing has been explicitly checked against WCAG.

## Prioritized roadmap

**Before showing this to any real prospect (weeks, not months):**
1. Decide and document the hosting target; fix the serverless/session-pool mismatch or commit to a persistent-process host.
2. Password reset flow, rate-limit the invite endpoint, add `helmet`, add CSRF tokens.
3. Label biogenic bundles in the picker; seed NCV for biogenic fuels.
4. PDF export of the consolidated report — this is likely the single highest-perceived-value item for the lowest effort, since the calculation/aggregation logic already exists.
5. A minimal admin surface (even a read-only cross-tenant dashboard) and a plan/status field on `organizations`, even before real billing is wired.

**Before selling to a mid-size or larger enterprise (bigger investment):**
6. Real invite-by-email + SSO/OIDC.
7. A test suite (even a thin one covering the calculation/aggregation core, which is the part most damaging to get silently wrong) and a CI pipeline.
8. Scope 2 (grid electricity) and Scope 3 category emission-factor libraries — without these the "GHG calculator" label oversells what's actually calculable today.
9. Billing/subscription layer.
10. Audit log, data export/deletion tooling, and a documented security posture (this is what turns into the InfoSec questionnaire answers enterprise procurement will ask for).

**Strategic, not urgent:**
11. Target-tracking / SBTi trajectory features.
12. Framework-specific export templates (CDP, GRI table, ESRS/BRSR).
13. Guided onboarding / self-serve trial experience.

# Platform BRD — Content Plan

## Purpose

This is the content plan for the first Business Requirements Document (BRD) for the
`ghgcalculator` platform, produced retroactively (the platform was built before this document
existed). The user's own framing: "the entire plan for this platform goes into the BRD with all
flowcharts and processes and screenshots for the proposed structure and screens... a proper
methodology to tackle the entire system and its functions should be covered along with the logic
as well as the gaps to be covered in the next version."

**Scope of this BRD**: the full platform, as-built (MVP), not a narrower slice.
**Audience**: the user's own reference, and future collaborators (contractor, hire, eventual
investor) — technical enough to be precise, readable without requiring code access.
**Format**: a single rich HTML artifact, not a Word document.
**Relationship to future work**: this BRD documents the MVP and flags known gaps at roadmap level.
A second BRD, written later when that work is actually undertaken, will cover the upgrade path in
full spec-level detail — this document does not attempt that level of detail for deferred items.

## Sourcing

Content is drawn from the platform's own design specs (`docs/superpowers/specs/*.md`, 8 documents
covering every module built to date), the live data model (`shared/schema.ts`), the API surface
(`server/routes.ts`), the client pages/components, and direct exploration of the running
application — not reconstructed from memory. Every standards-alignment claim (ISO 14064, GHG
Protocol) is sourced from what a spec or the product's own UI actually states, not asserted
generically.

The ISO-14064 GitHub competitive-landscape research (7 repos on the `iso-14064` topic, none of
which attempt multi-tenant/multi-facility consolidation or a verification workflow) is used to
shape the roadmap section's content — specific improvement ideas worth adopting — without being
cited as its own section or naming the external research. Confirmed with the user: fold in
invisibly.

## Structure

1. **Executive Summary** — what the platform is, who it's for, core value proposition, current
   maturity.
2. **Business Context & Objectives** — why this exists, target users (org teams doing GHG
   accounting, verification consultants, the platform operator), success criteria.
3. **Scope** — MVP boundary (what's actually built) vs. explicitly deferred, as a table.
4. **Stakeholders & Roles** — user personas + the real RBAC model (member/admin/owner per-org,
   platform super-admin) as a role-capability matrix.
5. **Methodology & Standards Alignment** — ISO 14064-1 org-level inventory alignment (boundary
   approaches: equity share / operational control / financial control), GHG Protocol Scope 1/2/3
   categorization, dual Scope 2 reporting (location-based/market-based) — sourced from the actual
   specs and the product's own in-app copy (e.g. the Setup screen's explicit ISO 14064-1 citation).
6. **Functional Requirements by Module** — one subsection per module: Authentication &
   Registration Hardening; Organization/Facility/Reporting-Boundary Setup; Emissions Calculation
   Engine (Scope 1/2/3); Scope 3 Factor Library; Verification-Ready Inventory & Consolidated
   Rollup; Reporting & Excel Verifier Export; Team & Organization Administration (membership
   lifecycle); Platform Super-Admin. Each covers purpose, key flows, business rules.
7. **Data Model** — entity-relationship diagram (organizations → memberships → users; organizations
   → reporting entities → facilities → reporting boundaries; facilities → emission records; etc.)
   plus per-entity descriptions.
8. **Key Process Flows** — flowcharts: registration → verification → login; the three-step setup
   wizard; emissions recording → calculation → report; the membership/account lifecycle state
   machine (membership vs. account vs. tenant as three independent concepts); the cross-tenant
   "sole organization" security boundary.
9. **Non-Functional Requirements** — multi-tenant isolation, the security/audit model (soft
   deactivate over delete, audit logging, the two-tier permission model), and the ISO 27001 gap
   analysis already produced earlier in this engagement.
10. **Known Gaps & Next-Version Roadmap** — every deferred item collected from all 8 specs' own
    "out of scope" sections, plus tenant archive/governed-deletion and identity/profile decoupling
    (both explicit user decisions deferred to their own design pass), plus the
    competitive-research-derived ideas (explicit methodology choices instead of a silent default
    total, auto-derived disclosure caveats, a per-line audit export, a value-chain/supplier
    questionnaire concept) — presented as roadmap items, not attributed to external research.
11. **Data Migration & Transition Principles** — formalizing "no destroyed user data, smooth
    transition" as a stated principle, grounded in patterns already proven in this codebase
    (idempotent numbered migration scripts, additive-only schema changes, gated one-time
    backfills).
12. **Glossary**.

## Visual treatment

Utilitarian-leaning polish per this document's own nature (a reference document, not a pitch
page): real typographic hierarchy, a considered palette, no oversized hero. Diagrams as inline SVG
(ER diagram, process flowcharts) per the artifact-diagramming approach — depict actual mechanisms
(what a request/state transition actually does), not decorative boxes. Full design-token plan
(color/type/layout) to be finalized once content is drafted, so the visual system is built around
what the document actually contains rather than guessed in advance.

# Report Format Selector + Add-On Module Architecture — Design

Session date: 2026-08-15. Branch `saas-multitenant`. Prioritized ahead of the Scope 2/Scope 3/target-tracking sub-projects by explicit decision, because it determines how those (and future) sub-projects' output gets exposed — designing it afterward would risk reworking Scope 2's report wiring once this exists.

## Context and decisions made during brainstorming

- **Deployment model: one shared multi-tenant SaaS instance, per-organization entitlement** — not separate per-client deployments, and not literal runtime loading of downloaded files. This resolves a real security concern raised during design: a running multi-tenant server auto-loading and executing arbitrary uploaded code would be a genuine risk (unreviewed code in production, potential cross-tenant exposure). Instead, every module ships as reviewed code within the same audited codebase; what varies per organization is only whether it's *entitled* to see/use it. "Downloading a module" becomes, in practice, purchasing/activating it for your organization.
- **Scope: framework/structure selector, not file format.** "Report format" means which methodology/categorization the same underlying data is presented under (Standard GHG Protocol/ISO 14064-1 view today; a future CBAM-shaped or GRI-table view later) — not PDF vs. CSV. PDF export remains explicitly deferred, as already decided earlier this session; this design does not reopen that.
- **Entitlement granting: controlled by the vendor directly, not self-service.** No billing/payment system exists yet, so a client organization's own owner/admin cannot self-toggle a paid module — only a protected, vendor-run mechanism can. The underlying entitlement record is written in a shape a future billing system can also write to later, so this doesn't need to be rebuilt when real billing exists — only who/how sets the flag changes.

## Data model

New table `organization_modules`:

- `id` (serial, PK)
- `organizationId` (integer, references `organizations.id`, `onDelete: cascade`)
- `moduleKey` (text, not null) — matches a key declared in the in-code module registry (below)
- `enabledAt` (timestamp, default now)
- `enabledBy` (text, nullable) — free-text note of who/how it was granted (e.g. an email or "manual grant, invoice #123"), since this is a vendor-run script action, not necessarily tied to an authenticated user session
- Unique index on `(organizationId, moduleKey)` — an org is either entitled to a given module or not, no duplicate rows

No changes to `getConsolidatedReport` or any existing calculation table. This is purely additive.

## Module registry (code, not filesystem-discovered)

A static, declarative list in `server/modules.ts` (new file):

```ts
export const MODULE_REGISTRY = {
  standard: {
    label: "Standard (GHG Protocol / ISO 14064-1)",
    alwaysEnabled: true, // every organization has this, no entitlement row needed
  },
  // Future entries follow this same shape, e.g.:
  // cbam: { label: "CBAM", alwaysEnabled: false },
  // gri_table: { label: "GRI 305 Table", alwaysEnabled: false },
} as const;
```

Modules ship as reviewed code in this file plus their own renderer component (see below) — nothing is discovered at runtime from a directory. This round adds no real second entry; the registry and its one `standard` entry exist so the mechanism is provably real, not so there's a second view to pick yet.

## Report rendering as presentation-layer dispatch

`getConsolidatedReport` already computes one canonical, fully-tagged dataset — scope totals (including Scope 2's forthcoming location/market-based split), gas breakdown, biogenic memo, intensity ratios. A "report view" is a renderer that reads that same object and presents it differently; it is not a parallel calculation path. `OrganizationReport.tsx`'s current rendering becomes the `standard` renderer. A future module's renderer is a new component reading the identical `ConsolidatedReport` shape — unless that module's methodology genuinely needs data `getConsolidatedReport` doesn't yet compute, which is handled case-by-case when that module is actually built, not designed for speculatively now.

**Scope 2 dual reporting is core methodology, not a module.** Its two totals (`scope2LocationBased`/`scope2MarketBased`, per the companion spec) appear directly in the `standard` view once built — no entitlement gate, no module key. Only genuinely optional, framework-specific output (CBAM, a GRI-shaped table, etc.) goes through this module system.

## API and UI

`GET /api/auth/me` (already returns org/membership context) gains an `enabledModules: string[]` field — the caller's org's entitled module keys, always including `"standard"`.

`OrganizationReport.tsx` gains a "Report view" selector, defaulting to Standard, listing only entitled options. With zero real second modules built yet, it renders as a single always-selected option today — the selector component exists and is wired correctly, proven by the mechanism below, without needing a second module's content invented to justify it.

## Granting an entitlement

A new script, `scripts/grant-module.mjs`, following this project's existing idempotent script conventions (same shape as `scripts/manual-migration-*.mjs`): takes an organization identifier and a module key, inserts (or no-ops if already present) a row into `organization_modules`. Run directly by the vendor against the live DB — not exposed through any HTTP route, so no org owner/admin, however privileged, can grant themselves a module through the product UI. A companion `scripts/revoke-module.mjs` removes the row.

## Generalizes beyond reports

If a future module needs new *input* capability, not just a different report view (CBAM plausibly will — it likely needs its own data collection, not just a different presentation of existing data), the same `organization_modules` table gates that too: a route-level check ("is this org entitled to `cbam`") before allowing CBAM-specific routes/UI, identical mechanism, no redesign needed when that day comes.

## Explicitly deferred (tracked, not built this round)

- Any real second module's actual content (CBAM calculation methodology, a GRI-shaped table renderer, etc.) — this design only builds the mechanism that will host them.
- Billing-driven automatic entitlement — the table is shaped to support it; the writer is manual for now.
- Self-hosted/on-prem deployment variant with literal file-based module installation — named as a possible future direction during brainstorming but not designed here, since the shared-SaaS-instance model was the explicit choice for now.
- PDF or other file-format export, independent of this design (already deferred earlier this session).

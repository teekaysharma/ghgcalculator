# Verification-Ready Inventory — Plan 4: Multi-Jurisdiction Picker and Legacy Calculator Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is Plan 4 of 4 for `docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md`. **Requires Plan 1 complete** (uses `emissionFactorsTable.country`). Independent of Plan 2/3 — can be done in parallel with them if using subagent-driven development.

**Goal:** Close the third gap (Section 4 of the design spec) by tiering `EmissionFactorPicker`'s dropdown by the facility's own country, and retire `EmissionCalculator.tsx` now that the Organization Report + per-facility flow (Plan 3) covers everything it did, with facility awareness it never had.

**Architecture:** Query/UI change to `EmissionFactorPicker.tsx` and its caller chain (no new tables). Deletion of one component and its two call sites in `AppShell.tsx`.

**Tech Stack:** React + TanStack Query.

## Global Constraints

- The traceability requirement (`sourceUrl` + `authorityName` mandatory for anything supplementing IPCC) is unchanged by this plan.
- IPCC defaults remain the permanent floor, always shown, never removed from the picker regardless of country tiering.

---

### Task 1: Country-tiered factor picker

**Files:**
- Modify: `client/src/components/EmissionFactorPicker.tsx`
- Modify: `client/src/components/BoundaryWorkspace.tsx` (`SourceStreamDetail`, `CalculationApproachForm`)

**Interfaces:**
- Consumes: `emissionFactorsTable.country` (Plan 1); `facilities.country` (existing); the existing `/api/facilities` list query already used elsewhere in `AppShell.tsx`/`BoundaryWorkspace.tsx`.
- Produces: `EmissionFactorPicker` gains one new optional prop, `facilityCountry?: string | null` — no other task in this plan set consumes it.

- [ ] **Step 1: Thread the facility's country down to `CalculationApproachForm`**

`SourceStreamDetail` (in `client/src/components/BoundaryWorkspace.tsx`, around line 356) receives `stream: SourceStream`, which already has a `facilityId` column from the database — check the client-side `SourceStream` interface in this file (search `interface SourceStream`) to confirm `facilityId` is listed; if not, add it (it's a real column, just possibly omitted from the narrower client type).

Add a facilities query and derive the country:

```ts
  const facilitiesQuery = useQuery<{ facilities: { id: number; country: string | null }[] }>({
    queryKey: ["/api/facilities"],
  });
  const facilityCountry = facilitiesQuery.data?.facilities.find((f) => f.id === stream.facilityId)?.country ?? null;
```

Pass it down: `<CalculationApproachForm sourceStreamId={stream.id} scope={stream.scope} facilityCountry={facilityCountry} />`.

- [ ] **Step 2: Accept and forward the prop in `CalculationApproachForm`**

Add `facilityCountry` to the destructured props and its type (around line 440-446):

```ts
function CalculationApproachForm({
  sourceStreamId,
  scope,
  facilityCountry,
}: {
  sourceStreamId: number;
  scope: string | null;
  facilityCountry: string | null;
}) {
```

Pass it to the picker (around line 497): `<EmissionFactorPicker scope={scope} facilityCountry={facilityCountry} onSelect={...}>`.

- [ ] **Step 3: Tier the dropdown in `EmissionFactorPicker.tsx`**

Add the prop:

```ts
interface EmissionFactorPickerProps {
  scope?: string | null;
  facilityCountry?: string | null;
  onSelect: (selection: EmissionFactorSelection) => void;
}

export function EmissionFactorPicker({ scope, facilityCountry, onSelect }: EmissionFactorPickerProps) {
```

Split `orgFactors` into two groups instead of one, right after the existing `const orgFactors = ...` line:

```ts
  const orgFactorsForCountry = facilityCountry
    ? orgFactors.filter((f) => (f as unknown as { country?: string | null }).country === facilityCountry)
    : [];
  const orgFactorsOther = facilityCountry
    ? orgFactors.filter((f) => (f as unknown as { country?: string | null }).country !== facilityCountry)
    : orgFactors;
```

**Note:** `OrgEmissionFactor` (the interface near the top of this file) doesn't currently include `country` — add it: `country?: string | null;` alongside the existing `sourceUrl`/`authorityName` fields. Once that's done, remove the `as unknown as {...}` casts above and reference `f.country` directly — they're written defensively here only because the exact current field list wasn't re-verified line-by-line while writing this plan; the implementer should add the field to the interface first and then these casts become unnecessary and should be deleted, not left in.

Replace the single `"Your organization's factors"` `SelectGroup` (around line 181-190) with two:

```tsx
          {orgFactorsForCountry.length > 0 && (
            <SelectGroup>
              <SelectLabel>Your organization's factors for {facilityCountry}</SelectLabel>
              {orgFactorsForCountry.map((f) => (
                <SelectItem key={f.id} value={`org:${f.id}`}>
                  {f.name} ({f.factor} {f.unit})
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {orgFactorsOther.length > 0 && (
            <SelectGroup>
              <SelectLabel>Your organization's other factors</SelectLabel>
              {orgFactorsOther.map((f) => (
                <SelectItem key={f.id} value={`org:${f.id}`}>
                  {f.name} ({f.factor} {f.unit})
                </SelectItem>
              ))}
            </SelectGroup>
          )}
```

The IPCC defaults `SelectGroup` below it is unchanged — it remains the permanent floor regardless of country tiering.

- [ ] **Step 4: Pre-fill country on the "add your own factor" form**

In the same file, find the `showAddForm` mini-form (`newFactor` state, around line 83). Add `country: facilityCountry ?? ""` to its initial state, and add a `country` field to the `POST /api/emission-factors` payload built in the `addFactor` mutation, alongside the existing `sourceUrl`/`authorityName` fields. Add an `<Input>` for it in the form JSX (same pattern as the existing `sourceUrl`/`authorityName` inputs), pre-filled but editable — a facility may legitimately need a factor from a different country.

- [ ] **Step 5: Run the TypeScript compiler**

Run: `npm run check`. Expected: zero errors.

- [ ] **Step 6: Manual verification**

Create a facility with `country` set to e.g. `"AE"`. Add an org emission factor tagged `country: "AE"` and another with no country (or a different one). Open the picker for a source stream on that facility — confirm the AE-tagged factor appears under "Your organization's factors for AE", the other org factor appears under "Your organization's other factors", and IPCC defaults are still listed and unaffected.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/EmissionFactorPicker.tsx client/src/components/BoundaryWorkspace.tsx
git commit -m "$(cat <<'EOF'
Tier emission factor picker by facility country

Section 4 of the verification-ready inventory design: a facility's own
country's factors are now grouped and shown first, ahead of other org
factors, with IPCC defaults still always present as the permanent
floor. Pure selection/labeling change -- no new calculation dimension,
traceability requirements unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Retire the legacy calculator

**Files:**
- Modify: `client/src/components/AppShell.tsx`
- Delete: `client/src/components/EmissionCalculator.tsx`, `client/src/components/ScopeInput.tsx`, `client/src/components/ResultsView.tsx`, `client/src/components/FileUpload.tsx` — **only after confirming nothing else imports them** (Step 1 below)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing — this is the plan set's final cleanup task.

- [ ] **Step 1: Confirm what's safe to delete**

Run: `grep -rn "EmissionCalculator\|ScopeInput\|ResultsView\|FileUpload" client/src --include="*.tsx" --include="*.ts" -l`

Expected: only `AppShell.tsx` (the two call sites) and the files' own definitions. `ResultsView.tsx` is also where this session built the per-gas breakdown table pattern that `OrganizationReport.tsx` (Plan 3) explicitly reused by copying the pattern, not by importing the component — confirm `OrganizationReport.tsx` has no actual `import` from `ResultsView.tsx` before deleting it. If any file outside this list imports one of these four, stop and investigate before deleting — don't delete something still in use.

- [ ] **Step 2: Remove the two `EmissionCalculator` call sites in `AppShell.tsx`**

Remove `{ key: "calculator", label: "Scope 1/2/3 Calculator", ... }` from `NAV_ITEMS` (line 56 area). Remove `type Section = "setup" | "facilities" | "boundary" | "report" | "calculator" | "team";`'s `"calculator"` value (leave `"report"` if Plan 3 already added it). Remove `{section === "calculator" && <EmissionCalculator />}`.

The `"setup"` section currently also renders `<EmissionCalculator />` nested inside `<SetupPanel>` (around line 91-95, per the file read earlier in this design process) — remove that usage too, and remove the now-unused `EmissionCalculator` import at the top of the file.

- [ ] **Step 3: Delete the four component files**

```bash
rm client/src/components/EmissionCalculator.tsx client/src/components/ScopeInput.tsx client/src/components/ResultsView.tsx client/src/components/FileUpload.tsx
```

- [ ] **Step 4: Check for now-orphaned server routes**

Run: `grep -n "app\.\(get\|post\|put\|delete\)(\"/api/calculate\"\|/api/download-csv\|/api/emission-factors\"" server/routes.ts`

`/api/calculate` and `/api/download-csv` were built specifically for the legacy calculator's in-memory flow. `/api/emission-factors` (the org-factor CRUD endpoints) is still needed — `EmissionFactorPicker.tsx` uses it directly, unrelated to the legacy calculator. Leave `/api/emission-factors` alone. For `/api/calculate` and `/api/download-csv`: check whether either is called from anywhere still in the codebase (it shouldn't be, after Step 3) — if genuinely orphaned, remove the route handlers too, so the codebase doesn't carry dead server code alongside the deleted client code. If in doubt, leave them — an unused but harmless route is a smaller problem than accidentally breaking something still relying on it; note this as a candidate for a future cleanup pass rather than guessing.

- [ ] **Step 5: Run the TypeScript compiler**

Run: `npm run check`. Expected: zero errors — this will catch any remaining reference to the deleted files immediately.

- [ ] **Step 6: Manual verification**

Load the app. Confirm the nav no longer shows "Scope 1/2/3 Calculator", the Setup section no longer embeds the old calculator, and every other section (Facilities, Boundary Workspace, Organization Report, Team) still works.

- [ ] **Step 7: Commit**

```bash
git add -A client/src/components/AppShell.tsx
git rm client/src/components/EmissionCalculator.tsx client/src/components/ScopeInput.tsx client/src/components/ResultsView.tsx client/src/components/FileUpload.tsx
git commit -m "$(cat <<'EOF'
Retire the legacy Scope 1/2/3 calculator

The Organization Report (Plan 3) + per-facility Boundary Workspace flow
now covers everything the legacy calculator did, with facility/sector/
country awareness it never had. Confirmed via grep that no other file
imports the four removed components before deleting them.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Self-Review

**Spec coverage:** Section 4 (country-tiered picker) is Task 1; the "retire legacy calculator" decision from the brainstorming dialogue is Task 2. Both design-spec items this plan owns are covered.

**Placeholder scan:** the `as unknown as {...}` casts in Task 1 Step 3 are explicitly flagged as temporary, with an explicit instruction to remove them once the real `OrgEmissionFactor.country` field is added — not left as a silent permanent workaround. Task 2 Step 4 explicitly says "leave it if in doubt" rather than guessing at a destructive deletion, consistent with this project's stated caution around irreversible actions.

**Type consistency:** `facilityCountry: string | null` is threaded consistently through all three layers (`SourceStreamDetail` → `CalculationApproachForm` → `EmissionFactorPicker`) with the same type at every hop.

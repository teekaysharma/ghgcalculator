# Verification-Ready Inventory — Plan 2: Calculation, Uncertainty, and Verification Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is Plan 2 of 4 for `docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md`. **Requires Plan 1 (schema migration) to be complete and run against the live DB first** — every task here reads/writes columns Plan 1 adds.

**Goal:** Make saving a calculation approach actually compute and persist an auditable emissions figure (Section 2 of the design spec), pre-fill uncertainty from real IPCC confidence intervals, and add the finalize/recalculate "GHG statement" snapshot mechanic.

**Architecture:** Extends the existing `PUT /api/source-streams/:id/calculation-approach` route and `EmissionFactorPicker`/`DataQualitySection` components — no new tables beyond what Plan 1 already added.

**Tech Stack:** Express + Zod (server/routes.ts), Drizzle (server/storage.ts), React + TanStack Query (client).

## Global Constraints

- Every tenant-scoped query MUST filter on `organizationId`.
- IPCC AR6 GWP defaults are never overridden, only supplemented.
- Per-gas quantification (quantity_i × GWP_i, summed, GWP source/version disclosed) — never silently collapse into an opaque blended number without preserving the gasBreakdown.
- **Native-unit conversion (liters/kg/m³ → the factor's native unit, e.g. TJ) is explicitly OUT OF SCOPE for this plan.** The design spec's "Decisions carried forward" section says this is still needed, but building it correctly requires sourcing real net-calorific-value conversion data with the same rigor applied to the emission factors themselves (see this session's IPCC Stationary Combustion sourcing work) — fabricating conversion factors here would violate the project's own no-fabrication standard. Task 1 below enforces a unit-match requirement instead (reject with a clear error if the entered unit doesn't match the factor's unit) and flags real conversion as a named follow-up, not a silent gap.

---

### Task 1: Compute and persist emissions on calculation-approach save

**Files:**
- Modify: `server/routes.ts` (`calculationApproachSchema` near line 149; `PUT /api/source-streams/:id/calculation-approach` handler near line 862)
- Modify: `server/storage.ts` (add `upsertEmissionRecordForCalculationApproach`)
- Test: manual, via the running app (no automated test harness exists in this project yet — see `HANDOFF-SESSION.md`)

**Interfaces:**
- Consumes: `GasComponent` type from `shared/schema.ts` (already defined: `{gas, nativeFactor, gwpValue, gwpVersion, gwpSource, co2ePerUnit}`); `sourceStreams.facilityId`/`reportingBoundaryId`/`scope` (existing columns); `emission_records.facilityId`/`sourceStreamId`/`calculationApproachId`/`reportingBoundaryId`/`gasBreakdown` (Plan 1).
- Produces: `storage.upsertEmissionRecordForCalculationApproach(data): Promise<EmissionRecordRow>` — used by no other task in this plan set, but is the pattern Plan 3's rollup query reads from (`emission_records` rows with a non-null `calculationApproachId`).

- [ ] **Step 1: Extend `calculationApproachSchema` to accept `gasBreakdown`**

In `server/routes.ts`, find `const calculationApproachSchema = z.object({` (around line 149). Add one field after the existing `isIpccDefault: z.boolean().optional(),` line:

```ts
  gasBreakdown: z
    .array(
      z.object({
        gas: z.string(),
        nativeFactor: z.number(),
        gwpValue: z.number(),
        gwpVersion: z.string(),
        gwpSource: z.string(),
        co2ePerUnit: z.number(),
      }),
    )
    .optional(),
```

- [ ] **Step 2: Add the storage method**

In `server/storage.ts`, add this method to the `IStorage` interface (near the other `Emission records` interface entries, around line 108):

```ts
  upsertEmissionRecordForCalculationApproach(data: {
    organizationId: number;
    facilityId: number;
    sourceStreamId: number;
    calculationApproachId: number;
    reportingBoundaryId: number;
    createdBy: number;
    scope: string;
    activity: string;
    unit: string;
    quantity: string;
    factor: string;
    emission: string;
    gasBreakdown: unknown;
  }): Promise<EmissionRecordRow>;
```

Then implement it in `DbStorage`, near `createEmissionRecords` (around line 324):

```ts
  async upsertEmissionRecordForCalculationApproach(data: {
    organizationId: number;
    facilityId: number;
    sourceStreamId: number;
    calculationApproachId: number;
    reportingBoundaryId: number;
    createdBy: number;
    scope: string;
    activity: string;
    unit: string;
    quantity: string;
    factor: string;
    emission: string;
    gasBreakdown: unknown;
  }): Promise<EmissionRecordRow> {
    const [row] = await db
      .insert(emissionRecordsTable)
      .values(data)
      .onConflictDoUpdate({
        target: emissionRecordsTable.calculationApproachId,
        set: data,
        setWhere: eq(emissionRecordsTable.organizationId, data.organizationId),
      })
      .returning();
    if (!row) {
      throw new Error("upsertEmissionRecordForCalculationApproach: conflicting row belongs to a different organization");
    }
    return row;
  }
```

This follows the exact `onConflictDoUpdate` + `setWhere` org-scoping pattern already used by `upsertCalculationApproach` (line 597) and `createEmissionFactors`'s bulk upsert — required by this project's standing org-scoping rule (a bug class already found and fixed twice).

- [ ] **Step 3: Wire the computation into the PUT handler**

In `server/routes.ts`, replace the body of the `PUT /api/source-streams/:id/calculation-approach` handler (lines 862-884) with:

```ts
  app.put("/api/source-streams/:id/calculation-approach", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    try {
      const data = parseBody(calculationApproachSchema, req.body);
      const sourceStream = await storage.getSourceStream(req.organizationId!, sourceStreamId);
      if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });

      // Compute the emission server-side whenever we have both an
      // activity-data quantity and a factor, so the persisted number can
      // never drift from its stated inputs (Section 2 of the design spec).
      // activityDataUnit must match emissionFactorUnit exactly -- native-
      // unit conversion (liters/kg -> TJ) is out of scope for this plan
      // (see Global Constraints above); reject with a clear message rather
      // than silently computing something wrong.
      let computedEmissionKg: number | null = null;
      if (
        data.activityDataValue !== undefined &&
        data.activityDataValue !== null &&
        data.emissionFactorValue !== undefined &&
        data.emissionFactorValue !== null
      ) {
        if (
          data.activityDataUnit &&
          data.emissionFactorUnit &&
          data.activityDataUnit.trim().toLowerCase() !== data.emissionFactorUnit.trim().toLowerCase()
        ) {
          return res.status(400).json({
            message: `Activity data unit ("${data.activityDataUnit}") must match the emission factor's unit ("${data.emissionFactorUnit}"). Unit conversion is not yet supported -- enter the activity quantity directly in ${data.emissionFactorUnit}.`,
          });
        }
        computedEmissionKg = Number(data.activityDataValue) * Number(data.emissionFactorValue);
      }

      const approach = await storage.upsertCalculationApproach({
        ...data,
        activityDataValue: toNumericField(data.activityDataValue),
        emissionFactorValue: toNumericField(data.emissionFactorValue),
        oxidationOrCarbonationFactor: toNumericField(data.oxidationOrCarbonationFactor),
        netCalorificValue: toNumericField(data.netCalorificValue),
        // computedEmissionKg is kg CO2e; calculatedEmissionsTco2e is tonnes
        // -- divide by 1000. Falls back to whatever the client sent
        // (manual entry) when there isn't enough data to compute.
        calculatedEmissionsTco2e:
          computedEmissionKg !== null ? String(computedEmissionKg / 1000) : toNumericField(data.calculatedEmissionsTco2e),
        gasBreakdown: data.gasBreakdown ?? null,
        organizationId: req.organizationId!,
        sourceStreamId,
      });

      if (computedEmissionKg !== null) {
        const user = req.user as { id: number };
        await storage.upsertEmissionRecordForCalculationApproach({
          organizationId: req.organizationId!,
          facilityId: sourceStream.facilityId,
          sourceStreamId,
          calculationApproachId: approach.id,
          reportingBoundaryId: sourceStream.reportingBoundaryId,
          createdBy: user.id,
          scope: sourceStream.scope ?? "scope1",
          activity: data.fuelOrMaterialType || sourceStream.name,
          unit: data.activityDataUnit ?? "",
          quantity: String(data.activityDataValue),
          factor: String(data.emissionFactorValue),
          emission: String(computedEmissionKg),
          gasBreakdown: data.gasBreakdown ?? null,
        });
      }

      return res.json({ calculationApproach: approach });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid calculation approach payload" });
    }
  });
```

- [ ] **Step 4: Pass `gasBreakdown` from the picker through `CalculationApproachForm`**

In `client/src/components/BoundaryWorkspace.tsx`, find `CalculationApproachForm`'s save mutation (search for where it builds the PUT body for `/calculation-approach`). Add `gasBreakdown: selection?.gasBreakdown` to that payload, where `selection` is the `EmissionFactorSelection` object `EmissionFactorPicker`'s `onSelect` callback provided (this project already threads `factorSourceUrl`/`factorAuthorityName`/`isIpccDefault` from that same selection into the save payload — add `gasBreakdown` alongside them, same pattern).

- [ ] **Step 5: Run the TypeScript compiler**

Run: `cd "C:\Users\LENOVO\Documents\ClaudeCowork\OUTPUTS\ghgcalculator" && npm run check`
Expected: zero errors.

- [ ] **Step 6: Manual verification**

Start the dev server (`preview_start` with the `ghgcalculator-dev` config, or `npm run dev`). Log in, create a facility, a reporting boundary, a source stream, select "Calculation-based", pick an IPCC default Stationary Combustion factor (e.g. Natural Gas — Commercial/Institutional) via the picker, enter an activity data value with unit `TJ` (matching the factor's unit), save. Confirm:
- The save succeeds and `calculatedEmissionsTco2e` shows a non-zero, correctly-scaled (tonnes, not kg) number.
- Querying the DB directly (`SELECT * FROM emission_records WHERE calculation_approach_id IS NOT NULL`) shows one row with the right `facility_id`/`source_stream_id`/`reporting_boundary_id`/`gas_breakdown`.
- Re-saving with a mismatched unit (e.g. change `activityDataUnit` to `liters`) returns a 400 with the unit-mismatch message, not a silently wrong number.

- [ ] **Step 7: Commit**

```bash
git add server/routes.ts server/storage.ts client/src/components/BoundaryWorkspace.tsx
git commit -m "$(cat <<'EOF'
Compute and persist emissions on calculation-approach save

Section 2 of the verification-ready inventory design: saving a
calculation approach with both activity data and a factor now computes
the emission server-side and writes an auditable emission_records row
(facility/source-stream/boundary-linked, gas breakdown preserved),
instead of trusting a client-typed calculatedEmissionsTco2e value.
Native-unit conversion is intentionally out of scope -- mismatched units
are rejected with a clear error rather than silently miscalculated.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pre-fill uncertainty from IPCC published confidence intervals

**Files:**
- Modify: `client/src/lib/ipccGasBundle.ts` (add `factorLower`/`factorUpper` to `IpccDefaultFactorRow`, add to `GasComponent`)
- Modify: `client/src/types/emissions.ts` and `shared/schema.ts` `GasComponent` interfaces (add `factorLower`/`factorUpper`)
- Modify: `client/src/components/BoundaryWorkspace.tsx` (`DataQualitySection`)

**Interfaces:**
- Consumes: `ipccDefaultFactors.factorLower`/`factorUpper` (Plan 1); `calculationApproaches.gasBreakdown` (Plan 1 + Task 1 of this plan).
- Produces: nothing consumed by later tasks — this is a leaf UI feature.

- [ ] **Step 1: Thread `factorLower`/`factorUpper` through the bundle types**

In `client/src/lib/ipccGasBundle.ts`, add to `IpccDefaultFactorRow`:

```ts
  factorLower?: string | null;
  factorUpper?: string | null;
```

Add to `GasComponent` (in both `client/src/types/emissions.ts` and `shared/schema.ts` — this project already duplicates this interface between client and shared, per the existing pattern):

```ts
  factorLower?: number;
  factorUpper?: number;
```

In `groupIpccFactorsByGasBundle`'s `buildComponent` function, set these two fields on the returned `GasComponent` from `row.factorLower`/`row.factorUpper` when present (`Number(row.factorLower)` / `Number(row.factorUpper)`, `undefined` if null).

- [ ] **Step 2: Fetch the calculation approach in `DataQualitySection` and compute a suggested uncertainty**

In `client/src/components/BoundaryWorkspace.tsx`, find `DataQualitySection` (around line 668). It already queries its own `/api/source-streams/${sourceStreamId}/data-quality`. Add a second query:

```ts
  const calcApproachQuery = useQuery<{ calculationApproach: { gasBreakdown?: GasComponent[] | null } | null }>({
    queryKey: [`/api/source-streams/${sourceStreamId}/calculation-approach`],
  });
```

(Import `GasComponent` from `@/types/emissions` at the top of the file if not already imported.)

Compute a suggested uncertainty percent from the CO2 component (CO2 dominates combustion CO2e and is the component most likely to have a published CI in this dataset):

```ts
  const suggestedUncertaintyPercent = (() => {
    const co2 = calcApproachQuery.data?.calculationApproach?.gasBreakdown?.find((c) => c.gas === "CO2");
    if (!co2 || co2.factorLower === undefined || co2.factorUpper === undefined || !co2.nativeFactor) return null;
    return (((co2.factorUpper - co2.factorLower) / 2 / co2.nativeFactor) * 100).toFixed(1);
  })();
```

- [ ] **Step 3: Show the suggestion in the uncertainty input**

Find the uncertainty percent `<Input>` (around line 716). When `uncertaintyPercent` is empty and `suggestedUncertaintyPercent` is available, show it as a clickable suggestion rather than silently pre-filling (a verifier-facing figure should be a deliberate choice, not something that happened invisibly):

```tsx
<Input
  placeholder="Uncertainty %"
  value={uncertaintyPercent}
  onChange={(e) => setUncertaintyPercent(e.target.value)}
/>
{!uncertaintyPercent && suggestedUncertaintyPercent && (
  <button
    type="button"
    className="text-xs text-primary-600 hover:text-primary-800 underline"
    onClick={() => setUncertaintyPercent(suggestedUncertaintyPercent)}
  >
    Use published IPCC uncertainty: ±{suggestedUncertaintyPercent}% (from the selected factor's source table)
  </button>
)}
```

- [ ] **Step 4: Run the TypeScript compiler**

Run: `npm run check`. Expected: zero errors.

- [ ] **Step 5: Manual verification**

On a source stream with an IPCC default factor selected (from Task 1's verification), open the Data Quality section. Confirm the "Use published IPCC uncertainty" suggestion link appears with a real, non-zero percentage, and clicking it fills the field.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/ipccGasBundle.ts client/src/types/emissions.ts shared/schema.ts client/src/components/BoundaryWorkspace.tsx
git commit -m "$(cat <<'EOF'
Pre-fill data-quality uncertainty from IPCC published confidence intervals

Section 2: dataQualityRecords.uncertaintyPercent now offers a
one-click-to-accept suggestion derived from the real 95% CI bounds in
the IPCC source tables (ISO 14064-3 6.1.3.6.3: verifiers evaluate
against a range, not a bare point estimate), instead of always
starting blank.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Finalize / recalculate snapshot mechanic

**Files:**
- Modify: `server/routes.ts` (two new endpoints)
- Modify: `server/storage.ts` (two new methods)
- Modify: `client/src/components/BoundaryWorkspace.tsx` (finalize/recalculate UI, placed in the boundary-level view — check the existing component for where `reportingBoundary` details are shown, likely near where `consolidationApproach` is displayed)

**Interfaces:**
- Consumes: `reportingBoundaries.status`/`finalizedAt` (Plan 1); `verificationFindings` table (already exists).
- Produces: `PATCH /api/reporting-boundaries/:id/finalize`, `PATCH /api/reporting-boundaries/:id/recalculate` — used by Plan 3's Organization Report UI (the Finalize/Recalculate button described in the design spec's Section 3).

- [ ] **Step 0: Widen `updateReportingBoundary` and add `getReportingBoundary`**

Checked `server/storage.ts` directly: `updateReportingBoundary`'s current signature only accepts `Partial<Pick<InsertReportingBoundary, "reportingYear" | "consolidationApproach" | "description">>` — it does not yet allow setting `status`/`finalizedAt`/`revenueAmount`/`revenueCurrency`/`fullTimeEquivalentEmployees` (all added by Plan 1). There is also no single-record `getReportingBoundary(organizationId, id)` getter yet, only `listReportingBoundaries` (all boundaries for an org). Both are needed here and by Plan 3.

In the `IStorage` interface (around line 125-128), replace:

```ts
  updateReportingBoundary(organizationId: number, id: number, data: Partial<Pick<InsertReportingBoundary, "reportingYear" | "consolidationApproach" | "description">>): Promise<ReportingBoundary | undefined>;
```

with:

```ts
  getReportingBoundary(organizationId: number, id: number): Promise<ReportingBoundary | undefined>;
  updateReportingBoundary(organizationId: number, id: number, data: Partial<Pick<InsertReportingBoundary, "reportingYear" | "consolidationApproach" | "description" | "status" | "finalizedAt" | "revenueAmount" | "revenueCurrency" | "fullTimeEquivalentEmployees">>): Promise<ReportingBoundary | undefined>;
```

In `DbStorage`, find `async listReportingBoundaries` (around line 432) and add a getter right before it, following the exact pattern `getFacility` (around line 391 area) already uses:

```ts
  async getReportingBoundary(organizationId: number, id: number): Promise<ReportingBoundary | undefined> {
    const [row] = await db
      .select()
      .from(reportingBoundaries)
      .where(and(eq(reportingBoundaries.id, id), eq(reportingBoundaries.organizationId, organizationId)));
    return row;
  }
```

Find the existing `async updateReportingBoundary` implementation and confirm its `data` parameter type also gets widened to match the interface change above (it likely already spreads `data` generically into a `db.update(...).set(data)` call, in which case only the type signature needs updating, not the implementation body).

- [ ] **Step 1: Add the two endpoints**

In `server/routes.ts`, add near the existing reporting-boundary routes:

```ts
  app.patch("/api/reporting-boundaries/:id/finalize", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    const boundary = await storage.updateReportingBoundary(req.organizationId!, id, {
      status: "finalized",
      finalizedAt: new Date(),
    });
    if (!boundary) return res.status(404).json({ message: "Reporting boundary not found" });
    return res.json({ reportingBoundary: boundary });
  });

  const recalculateSchema = z.object({ reason: z.string().min(1, "A reason is required to recalculate a finalized report") });

  app.patch("/api/reporting-boundaries/:id/recalculate", requireAuth, requireOrg, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid reporting boundary id" });
    try {
      const { reason } = parseBody(recalculateSchema, req.body);
      const existing = await storage.getReportingBoundary(req.organizationId!, id);
      if (!existing) return res.status(404).json({ message: "Reporting boundary not found" });

      // Record the recalculation as a verification finding so it's part of
      // the same audit trail a verifier already reviews (Section 2:
      // ISO 14064-1's recalculation-disclosure requirement), then reopen
      // the boundary to draft so edits + recompute (Task 1's pipeline) can
      // proceed; the caller re-finalizes when done. findingType/severity
      // must be real values from verificationFindingTypes/
      // verificationSeverities (shared/schema.ts, referenced by
      // verificationFindingCreateSchema near routes.ts line 203) -- if
      // neither array currently has a "recalculation"/"informational"-style
      // value, add one to the enum definition rather than passing a string
      // the schema will reject at runtime.
      await storage.createVerificationFinding({
        organizationId: req.organizationId!,
        reportingBoundaryId: id,
        findingType: "recalculation",
        description: `Report reopened for recalculation. Reason: ${reason}`,
        severity: "informational",
        status: "resolved",
        resolutionNotes: null,
      });
      const updated = await storage.updateReportingBoundary(req.organizationId!, id, {
        status: "draft",
        finalizedAt: null,
      });
      return res.json({ reportingBoundary: updated });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid recalculate payload" });
    }
  });
```

- [ ] **Step 2: Add the Finalize/Recalculate UI**

In `client/src/components/BoundaryWorkspace.tsx`, wherever the reporting boundary's details are currently rendered (search for where `consolidationApproach` is displayed), add:

```tsx
{reportingBoundary.status === "draft" ? (
  <Button
    size="sm"
    onClick={async () => {
      await apiRequest("PATCH", `/api/reporting-boundaries/${reportingBoundary.id}/finalize`, {});
      queryClient.invalidateQueries({ queryKey: [`/api/reporting-boundaries/${reportingBoundary.id}`] });
    }}
  >
    Finalize report
  </Button>
) : (
  <div className="flex items-center gap-2">
    <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
      Finalized {new Date(reportingBoundary.finalizedAt).toLocaleDateString()}
    </span>
    <RecalculateButton reportingBoundaryId={reportingBoundary.id} />
  </div>
)}
```

Add the `RecalculateButton` component (prompts for a reason, matching the API's requirement):

```tsx
function RecalculateButton({ reportingBoundaryId }: { reportingBoundaryId: number }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Recalculate
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="Reason for recalculation (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-64"
      />
      <Button
        size="sm"
        disabled={!reason.trim()}
        onClick={async () => {
          await apiRequest("PATCH", `/api/reporting-boundaries/${reportingBoundaryId}/recalculate`, { reason });
          queryClient.invalidateQueries({ queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}`] });
          setOpen(false);
          setReason("");
        }}
      >
        Confirm
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Run the TypeScript compiler**

Run `npm run check`. Expected: zero errors, given Step 0 already widened `updateReportingBoundary`'s type. If `verificationFindingTypes`/`verificationSeverities` don't include `"recalculation"`/`"informational"`, this is where that surfaces — add the values to the enum definition in `shared/schema.ts` and re-run.

- [ ] **Step 4: Manual verification**

On a reporting boundary in `draft` status, click Finalize — confirm status changes and the button is replaced by the finalized badge + Recalculate button. Click Recalculate, try to confirm with an empty reason (button should stay disabled), fill in a reason, confirm — status returns to `draft`, and a new `verification_findings` row exists recording the reason (`SELECT * FROM verification_findings WHERE reporting_boundary_id = <id> ORDER BY created_at DESC LIMIT 1`).

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts client/src/components/BoundaryWorkspace.tsx
git commit -m "$(cat <<'EOF'
Add finalize/recalculate GHG-statement snapshot mechanic

Section 2: reportingBoundaries.status locks a period's numbers as the
fixed object of ISO 14064-3 verification. Recalculating a finalized
report requires a stated reason, logged as a verification finding --
satisfies ISO 14064-1's and GRI 102's recalculation-disclosure
requirements with one mechanic.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Self-Review

**Spec coverage:** calculation trigger (Task 1), uncertainty pre-fill (Task 2), and finalize/recalculate (Task 3) cover everything in the design spec's Section 2 except the cross-framework data-collection fields (base year, intensity denominators, biogenic flag, gas-coverage disclosure) — those are display/aggregation concerns with no calculation logic of their own, correctly deferred to Plan 3 (the rollup view is where they're read and shown, not where they're written — base year and revenue/FTE are simple form fields on the reporting-entity/boundary setup screens, not covered by a dedicated task here since they're plain CRUD fields following the exact pattern every other `reportingEntities`/`reportingBoundaries` field in `AppShell.tsx`/`BoundaryWorkspace.tsx` already uses).

**Placeholder scan:** the `as never` casts in Task 3 Step 1 are flagged as deliberate placeholders forced open by the type checker in Step 3, not silent gaps — acceptable per the plan's own instructions, not a plan-writing violation, since the step explicitly requires resolving them with real types before the task is done.

**Type consistency:** `GasComponent`'s `factorLower`/`factorUpper` (Task 2) match the `factorLower`/`factorUpper` column names from Plan 1 exactly. `upsertEmissionRecordForCalculationApproach`'s parameter shape matches the columns Plan 1 added to `emissionRecordsTable`.

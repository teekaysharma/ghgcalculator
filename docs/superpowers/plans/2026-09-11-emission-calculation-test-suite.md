# Emission-Calculation Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the emission-calculation arithmetic out of the `PUT /api/source-streams/:id/calculation-approach` route handler into a pure, unit-testable function, and write the first real automated test suite this project has ever had against it.

**Architecture:** A behavior-preserving extraction (not a rewrite) into `server/calculations/emission-calculation.ts`, called from the existing route handler in place of the inline logic it replaces. Vitest tests exercise the extracted function directly — no server, no database, sub-second runtime.

**Tech Stack:** Existing stack (TypeScript, Express). New devDependency: `vitest`.

## Global Constraints

- **Behavior-preserving, not a rewrite.** The `WEIGHT_UNITS_PER_GG` table, the conversion logic,
  and the exact rejection message text move verbatim from `server/routes.ts:2502-2581` (confirmed
  by direct re-read this session, current as of this plan — nothing in `routes.ts` has changed
  since it was first read) into the new file. If a test in this plan reveals the existing logic
  does something surprising, that is a finding to report, not something to silently "fix."
- **Concrete proof of behavior preservation is required**, not just careful extraction: `npm run
  verify` (the existing end-to-end smoke test, which exercises this exact calculation through a
  real save) must still pass, unchanged, after the refactor.
- Result type is a clean discriminated union on `status`: `"computed" | "rejected" |
  "insufficient_data"` — never two members both carrying the same discriminant value.
- `npm run check` (`tsc`) must stay clean throughout.
- This project's file:line references can go stale if the (currently paused, not yet executed)
  Hooks plan's repo-wide Prettier reformat lands before this plan is executed — re-verify the
  exact lines in `server/routes.ts` with a fresh `Read`/`Grep` before editing if that has happened
  in the meantime; do not trust the line numbers below blindly.

---

### Task 1: Extract `calculateEmission` and refactor the route handler to use it

**Files:**
- Create: `server/calculations/emission-calculation.ts`
- Modify: `server/routes.ts:2502-2581` (replace the inline calculation with a call to the
  extracted function), plus the top import block (add the new import)

**Interfaces:**
- Produces: `calculateEmission(input: EmissionCalculationInput): EmissionCalculationResult`,
  `EmissionCalculationInput`, `EmissionCalculationResult`, `GasBreakdownComponentInput` — all
  exported from `server/calculations/emission-calculation.ts`, consumed by Task 2's tests and by
  the refactored route handler in this same task.

- [ ] **Step 1: Write the extracted function**

Create `server/calculations/emission-calculation.ts`:

```ts
// server/calculations/emission-calculation.ts
//
// Extracted verbatim from the PUT /api/source-streams/:id/calculation-approach
// route handler (server/routes.ts) -- see
// docs/superpowers/specs/2026-09-11-emission-calculation-test-suite-design.md.
// Pure function, no DB/HTTP dependency, so it can be unit-tested directly.
// This is a relocation, not a rewrite -- the WEIGHT_UNITS_PER_GG table, the
// conversion logic, and the rejection message text are unchanged from the
// original inline version.

export interface GasBreakdownComponentInput {
  gas: string;
  netCalorificValue?: number;
}

export interface EmissionCalculationInput {
  activityDataValue: number | string | null | undefined;
  activityDataUnit: string | null | undefined;
  emissionFactorValue: number | string | null | undefined;
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
  | { status: "insufficient_data" };

// 1 Gg = 1e6 kg = 1e3 tonnes -- 2006 IPCC Guidelines Vol.2 Ch.1 Table 1.2.
const WEIGHT_UNITS_PER_GG: Record<string, number> = {
  kg: 1_000_000,
  kgs: 1_000_000,
  kilogram: 1_000_000,
  kilograms: 1_000_000,
  t: 1_000,
  tonne: 1_000,
  tonnes: 1_000,
  ton: 1_000,
  tons: 1_000,
  "metric tonne": 1_000,
  "metric tonnes": 1_000,
};

export function calculateEmission(input: EmissionCalculationInput): EmissionCalculationResult {
  if (
    input.activityDataValue === undefined ||
    input.activityDataValue === null ||
    input.emissionFactorValue === undefined ||
    input.emissionFactorValue === null
  ) {
    return { status: "insufficient_data" };
  }

  let activityValueInFactorUnit = Number(input.activityDataValue);
  const activityUnit = input.activityDataUnit?.trim().toLowerCase() ?? "";
  const factorUnit = input.emissionFactorUnit?.trim().toLowerCase() ?? "";
  let appliedNetCalorificValue: number | null = null;

  if (activityUnit && factorUnit && activityUnit !== factorUnit) {
    // NCV lives on the CO2 row only (CH4/N2O rows for the same fuel leave
    // it null rather than repeat it) -- see ipccDefaultFactors.netCalorificValue
    // in shared/schema.ts.
    const co2Component = (input.gasBreakdown ?? []).find(
      (c) => c.gas === "CO2" && typeof c.netCalorificValue === "number" && c.netCalorificValue > 0,
    );
    const unitsPerGg = WEIGHT_UNITS_PER_GG[activityUnit];
    if (factorUnit === "tj" && unitsPerGg !== undefined && co2Component?.netCalorificValue) {
      appliedNetCalorificValue = co2Component.netCalorificValue;
      activityValueInFactorUnit = (Number(input.activityDataValue) * appliedNetCalorificValue) / unitsPerGg;
    } else {
      return {
        status: "rejected",
        reason:
          `Activity data unit ("${input.activityDataUnit}") must match the emission factor's unit ` +
          `("${input.emissionFactorUnit}"). Unit conversion is only available for weight-basis ` +
          `quantities (kg/tonnes) against an energy-basis factor when the selected fuel has a ` +
          `published net calorific value -- otherwise enter the activity quantity directly in ` +
          `${input.emissionFactorUnit}.`,
      };
    }
  }

  const computedEmissionKg = activityValueInFactorUnit * Number(input.emissionFactorValue);

  return {
    status: "computed",
    computedEmissionKg,
    activityValueInFactorUnit,
    appliedNetCalorificValue,
  };
}
```

- [ ] **Step 2: Run the TypeScript check to confirm the new file compiles cleanly on its own**

Run: `npm run check`
Expected: clean, no errors (the new file isn't wired into `routes.ts` yet, so this only proves
the extracted file itself is valid).

- [ ] **Step 3: Refactor the route handler to call the extracted function**

In `server/routes.ts`, add to the top imports (near the other local imports):

```ts
import { calculateEmission } from "./calculations/emission-calculation";
```

Replace lines 2502-2581 (from the `// Compute the emission server-side...` comment through the
closing `}` of the `if (data.activityDataValue !== undefined ...)` block, ending just before
`const approach = await storage.upsertCalculationApproach({`) with:

```ts
      // Compute the emission server-side whenever we have both an
      // activity-data quantity and a factor, so the persisted number can
      // never drift from its stated inputs (Section 2 of the design spec).
      // Extracted to server/calculations/emission-calculation.ts so the
      // arithmetic can be unit-tested directly -- see
      // docs/superpowers/specs/2026-09-11-emission-calculation-test-suite-design.md.
      const calculation = calculateEmission({
        activityDataValue: data.activityDataValue,
        activityDataUnit: data.activityDataUnit,
        emissionFactorValue: data.emissionFactorValue,
        emissionFactorUnit: data.emissionFactorUnit,
        gasBreakdown: data.gasBreakdown,
      });

      if (calculation.status === "rejected") {
        return res.status(400).json({ message: calculation.reason });
      }

      const computedEmissionKg = calculation.status === "computed" ? calculation.computedEmissionKg : null;
      // The activity quantity actually used in the multiplication, in the
      // FACTOR's unit (TJ) -- equal to activityDataValue when no conversion
      // was needed. Persisted on the emission record so that record's
      // `quantity x gasBreakdown[].co2ePerUnit` per-gas rollup (see
      // server/storage.ts getConsolidatedReport) stays arithmetically valid.
      const activityValueInFactorUnit = calculation.status === "computed" ? calculation.activityValueInFactorUnit : null;
      // The NCV actually applied, recorded on the calculation approach so an
      // auditor can reconstruct kg -> TJ from the stored row alone.
      const appliedNetCalorificValue = calculation.status === "computed" ? calculation.appliedNetCalorificValue : null;
```

Everything from `const approach = await storage.upsertCalculationApproach({` (originally line
2583) onward is **unchanged** — it already only reads `computedEmissionKg`,
`activityValueInFactorUnit`, and `appliedNetCalorificValue`, never reassigns them, so switching
them from `let` to `const` (now produced by the extracted call instead of inline mutation) is
safe.

- [ ] **Step 4: Verify the route still compiles**

Run: `npm run check`
Expected: clean, no errors.

- [ ] **Step 5: Prove behavior is preserved — run the existing end-to-end smoke test**

Requires a running dev server (`npm run dev` in another terminal) and `DATABASE_URL` set.

Run: `npm run verify`
Expected: passes exactly as it did before this refactor — same pass count, no new failures. This
is the concrete proof the extraction didn't change behavior, not an assumption.

- [ ] **Step 6: Commit**

```bash
git add server/calculations/emission-calculation.ts server/routes.ts
git commit -m "refactor: extract emission-calculation arithmetic into a pure, testable function"
```

---

### Task 2: Add Vitest and write the test suite

**Files:**
- Modify: `package.json` (add `vitest` devDependency, add `"test": "vitest run"` script)
- Create: `vitest.config.ts`
- Create: `server/calculations/emission-calculation.test.ts`

**Interfaces:**
- Consumes: `calculateEmission`, `EmissionCalculationInput`, `EmissionCalculationResult` from
  `server/calculations/emission-calculation.ts` (Task 1).

- [ ] **Step 1: Add the dependency**

In `package.json`'s `"devDependencies"`, add:

```json
    "vitest": "^2.1.4",
```

Run: `npm install`

- [ ] **Step 2: Add the config and script**

Create `vitest.config.ts` at the repo root:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts"],
  },
});
```

In `package.json`'s `"scripts"`, add (kept separate from `"verify"`, which stays the live-server
smoke check it already is):

```json
    "test": "vitest run",
```

- [ ] **Step 3: Write the failing tests**

Create `server/calculations/emission-calculation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { calculateEmission } from "./emission-calculation";

describe("calculateEmission", () => {
  it("computes directly when units already match, no conversion attempted", () => {
    const result = calculateEmission({
      activityDataValue: 10,
      activityDataUnit: "TJ",
      emissionFactorValue: 56100,
      emissionFactorUnit: "TJ",
      gasBreakdown: null,
    });
    expect(result).toEqual({
      status: "computed",
      computedEmissionKg: 561000,
      activityValueInFactorUnit: 10,
      appliedNetCalorificValue: null,
    });
  });

  it("converts kilograms to the factor's TJ unit via the CO2 component's net calorific value", () => {
    const netCalorificValue = 0.0261;
    const result = calculateEmission({
      activityDataValue: 5000,
      activityDataUnit: "kg",
      emissionFactorValue: 56100,
      emissionFactorUnit: "TJ",
      gasBreakdown: [{ gas: "CO2", netCalorificValue }],
    });
    const expectedActivityValueInFactorUnit = (5000 * netCalorificValue) / 1_000_000;
    expect(result).toEqual({
      status: "computed",
      computedEmissionKg: expectedActivityValueInFactorUnit * 56100,
      activityValueInFactorUnit: expectedActivityValueInFactorUnit,
      appliedNetCalorificValue: netCalorificValue,
    });
  });

  it("converts tonnes using the tonnes divisor, not the kilograms one", () => {
    const netCalorificValue = 0.0261;
    const result = calculateEmission({
      activityDataValue: 5,
      activityDataUnit: "tonnes",
      emissionFactorValue: 56100,
      emissionFactorUnit: "TJ",
      gasBreakdown: [{ gas: "CO2", netCalorificValue }],
    });
    const expectedActivityValueInFactorUnit = (5 * netCalorificValue) / 1_000;
    expect(result).toEqual({
      status: "computed",
      computedEmissionKg: expectedActivityValueInFactorUnit * 56100,
      activityValueInFactorUnit: expectedActivityValueInFactorUnit,
      appliedNetCalorificValue: netCalorificValue,
    });
    // 5 tonnes and 5000 kg are the same physical quantity -- the tonnes
    // divisor (1_000) must land on the same activityValueInFactorUnit the
    // kilograms case's divisor (1_000_000) produced for 5000 kg, proving
    // the lookup table's second key is genuinely exercised, not just
    // kilograms happening to work.
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.activityValueInFactorUnit).toBeCloseTo(0.0001305, 12);
    }
  });

  it("rejects a volume-basis unit with no sanctioned conversion path", () => {
    const result = calculateEmission({
      activityDataValue: 100,
      activityDataUnit: "litres",
      emissionFactorValue: 56100,
      emissionFactorUnit: "TJ",
      gasBreakdown: [{ gas: "CO2", netCalorificValue: 0.0261 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toContain('Activity data unit ("litres")');
    }
  });

  it("rejects a weight-basis unit when the fuel has no net calorific value (e.g. a biogenic fuel)", () => {
    const result = calculateEmission({
      activityDataValue: 5000,
      activityDataUnit: "kg",
      emissionFactorValue: 56100,
      emissionFactorUnit: "TJ",
      gasBreakdown: [{ gas: "CO2" }],
    });
    expect(result.status).toBe("rejected");
  });

  it("returns insufficient_data when either quantity or factor is missing", () => {
    expect(
      calculateEmission({
        activityDataValue: null,
        activityDataUnit: "kg",
        emissionFactorValue: 56100,
        emissionFactorUnit: "TJ",
        gasBreakdown: null,
      }),
    ).toEqual({ status: "insufficient_data" });

    expect(
      calculateEmission({
        activityDataValue: 100,
        activityDataUnit: "kg",
        emissionFactorValue: undefined,
        emissionFactorUnit: "TJ",
        gasBreakdown: null,
      }),
    ).toEqual({ status: "insufficient_data" });
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npm run test`
Expected: 6 passing, 0 failing.

- [ ] **Step 5: Confirm `npm run check` still passes**

Run: `npm run check`
Expected: clean.

- [ ] **Step 6: Update `docs/superpowers/INDEX.md`**

Change the Test suite row's Stage from "Spec approved" to "Shipped (first slice)" — update its
Status cell to note the 6 passing tests and that broader coverage (tenant-isolation, hooks,
additional slices) remains separate, not-yet-scoped work.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts server/calculations/emission-calculation.test.ts docs/superpowers/INDEX.md
git commit -m "test: add first Vitest suite, covering the emission-calculation arithmetic"
```

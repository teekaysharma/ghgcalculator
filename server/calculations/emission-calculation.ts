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
// Weight-basis units only -- volume-basis (liters/m3) is deliberately unsupported here. See
// shared/schema.ts's ipccDefaultFactors.netCalorificValue comment for the full rationale.
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

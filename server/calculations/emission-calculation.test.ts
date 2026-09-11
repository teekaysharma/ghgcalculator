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

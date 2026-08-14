export type ScopeType = 'scope1' | 'scope2' | 'scope3';

// Per-gas component of a combined factor, e.g. one row for CO2, one for
// CH4, one for N2O -- built from ipccDefaultFactors (gas-native factor) +
// gwpValues (the disclosed GWP applied to it). ISO/TS 14064-4 requires GHG
// emissions to be quantified per gas (quantity_i * GWP_i, summed) with the
// GWP source/version disclosed as a distinct step, not silently baked into
// one opaque number -- this is what makes that reconstructable downstream.
export interface GasComponent {
  gas: string; // 'CO2' | 'CH4' | 'N2O'
  nativeFactor: number; // e.g. kg CH4 per unit (native, not GWP-weighted)
  gwpValue: number;
  gwpVersion: string;
  gwpSource: string;
  co2ePerUnit: number; // nativeFactor * gwpValue
  // Published 95% confidence interval bounds for nativeFactor, when the
  // IPCC source table discloses one (see ipccDefaultFactors.factorLower/
  // factorUpper in shared/schema.ts). Used to suggest -- never silently
  // pre-fill -- dataQualityRecords.uncertaintyPercent.
  factorLower?: number;
  factorUpper?: number;
}

export interface EmissionFactor {
  name: string;
  factor: number;
  unit: string;
  wasteType?: string;
  disposalMethod?: string;
  category?: string;
  source?: string;
  year?: number;
  // Present only for factors built from a multi-gas IPCC default bundle
  // (see EmissionCalculator.tsx groupIpccFactorsByGasBundle). `factor`
  // above is always the sum of gasBreakdown[].co2ePerUnit -- kept in sync
  // so every existing qty * factor call site keeps working unchanged.
  gasBreakdown?: GasComponent[];
}

export interface EmissionInput {
  activity: string;
  unit: string;
  qty: number;
  year?: number;
  product?: string;
  wasteType?: string;
  disposalMethod?: string;
}

// Per-gas contribution of one specific calculated emission line -- quantity
// here is scaled by this line's input qty (unlike GasComponent.nativeFactor
// above, which is per-unit). Populated on Emission when the source factor
// carried a gasBreakdown.
export interface EmissionGasContribution {
  gas: string;
  quantityOfGas: number; // e.g. kg CH4 emitted by this line
  gwpValue: number;
  gwpVersion: string;
  gwpSource: string;
  co2e: number; // quantityOfGas * gwpValue
}

export interface Emission {
  scope: ScopeType;
  activity: string;
  unit: string;
  quantity: number;
  factor: number;
  emission: number;
  year?: number;
  product?: string;
  wasteType?: string;
  disposalMethod?: string;
  scope3Category?: string;
  gasBreakdown?: EmissionGasContribution[];
}

export interface ProductData {
  name: string;
  production: number;
  year: number;
  unit: string;
}

export interface YearlyEmissions {
  year: number;
  scope1: number;
  scope2: number;
  scope3: number;
  total: number;
}

export interface ProductIntensity {
  product: string;
  year: number;
  emissions: number;
  production: number;
  intensity: number;
  unit: string;
}

export interface WasteEmission {
  wasteType: string;
  disposalMethod: string;
  quantity: number;
  unit: string;
  factor: number;
  emission: number;
}

export interface WasteDisposalSummary {
  wasteType: string;
  totalEmission: number;
  byMethod: Record<string, number>;
  totalQuantity: number;
  unit: string;
}

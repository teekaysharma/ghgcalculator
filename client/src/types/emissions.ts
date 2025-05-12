export type ScopeType = 'scope1' | 'scope2' | 'scope3';

export interface EmissionFactor {
  name: string;
  factor: number;
  unit: string;
  wasteType?: string;
  disposalMethod?: string;
  category?: string;
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

import type { EmissionFactor, GasComponent } from "@/types/emissions";

// Shared by EmissionCalculator.tsx (legacy calculator) and
// EmissionFactorPicker.tsx (facility-MRV form) -- both need to turn the flat
// rows returned by GET /api/reference/ipcc-default-factors into composite,
// per-gas-aware EmissionFactor objects. See shared/schema.ts ipccDefaultFactors
// comment for why this grouping exists (ISO/TS 14064-4 per-gas quantification).

export interface IpccDefaultFactorRow {
  id: number;
  category: string;
  activityType: string;
  sector: string; // 'all' for sector-independent (CO2) rows
  gasType: string; // 'CO2' | 'CH4' | 'N2O'
  unit: string;
  factor: string;
  scope: string | null;
  sourceDocument?: string;
  sourceUrl?: string | null;
  factorLower?: string | null;
  factorUpper?: string | null;
}

export interface GwpValueRow {
  id: number;
  gas: string; // e.g. 'CO2', 'CH4 (fossil)', 'CH4 (non-fossil)', 'N2O'
  formula: string | null;
  gwpValue: string;
  gwpVersion: string;
  gwpSource: string;
}

export interface IpccGasBundle {
  key: string; // stable id for this bundle, used as the factor map key suffix
  category: string;
  activityType: string;
  sector: string; // 'all' when there is no sector-specific component
  scope: string | null;
  unit: string;
  factor: EmissionFactor;
}

// CH4 emitted by combustion of the fossil fuels this dataset covers (coal,
// oil, natural gas, LPG) is fossil-origin CH4 -- AR6 gives fossil and
// non-fossil CH4 different GWP-100 values (29.8 vs 27). Every fuel currently
// seeded in ipcc_default_factors (manual-migration-006.mjs) is fossil, so
// 'CH4 (fossil)' is the correct lookup for all of them today. If a biomass
// fuel is ever added to this category, its bundle needs 'CH4 (non-fossil)'
// instead -- update this mapping when that happens rather than assuming.
function gwpGasKeyFor(gasType: string): string {
  if (gasType === "CH4") return "CH4 (fossil)";
  return gasType; // 'CO2' and 'N2O' match directly
}

/**
 * Groups flat ipcc_default_factors rows into composite, per-gas-aware
 * EmissionFactor bundles: one bundle per (category, activityType, sector)
 * for sector-specific gases (CH4/N2O), with the sector-independent CO2 row
 * (sector='all') folded into every sector bundle for the same activity.
 *
 * If an activityType has ONLY a sector='all' CO2 row and no sector-specific
 * rows (e.g. a future non-combustion category), it still produces a single
 * standalone bundle so the picker/calculator degrade gracefully.
 */
export function groupIpccFactorsByGasBundle(
  rows: IpccDefaultFactorRow[],
  gwpRows: GwpValueRow[],
): IpccGasBundle[] {
  const gwpByGas = new Map<string, GwpValueRow>();
  for (const g of gwpRows) {
    gwpByGas.set(g.gas, g);
  }

  const activityKey = (r: IpccDefaultFactorRow) => `${r.category}::${r.activityType}`;

  // sector='all' CO2 rows, keyed by activity -- these apply to every sector.
  const co2ByActivity = new Map<string, IpccDefaultFactorRow>();
  for (const r of rows) {
    if (r.sector === "all" && r.gasType === "CO2") {
      co2ByActivity.set(activityKey(r), r);
    }
  }

  // Sector-specific rows (CH4/N2O today), grouped by (activity, sector).
  const sectorGroups = new Map<string, { activity: IpccDefaultFactorRow; sector: string; rows: IpccDefaultFactorRow[] }>();
  for (const r of rows) {
    if (r.sector === "all") continue;
    const key = `${activityKey(r)}::${r.sector}`;
    const existing = sectorGroups.get(key);
    if (existing) {
      existing.rows.push(r);
    } else {
      sectorGroups.set(key, { activity: r, sector: r.sector, rows: [r] });
    }
  }

  function buildComponent(row: IpccDefaultFactorRow): GasComponent {
    const gwpGasKey = gwpGasKeyFor(row.gasType);
    const gwp = gwpByGas.get(gwpGasKey);
    const nativeFactor = Number(row.factor);
    const gwpValue = gwp ? Number(gwp.gwpValue) : 1;
    return {
      gas: row.gasType,
      nativeFactor,
      gwpValue,
      gwpVersion: gwp?.gwpVersion ?? "unknown",
      gwpSource: gwp?.gwpSource ?? "GWP value not found -- treated as 1 (no warming weighting applied)",
      co2ePerUnit: nativeFactor * gwpValue,
      factorLower: row.factorLower != null ? Number(row.factorLower) : undefined,
      factorUpper: row.factorUpper != null ? Number(row.factorUpper) : undefined,
    };
  }

  const bundles: IpccGasBundle[] = [];
  const activitiesWithSectorGroups = new Set<string>();

  for (const { activity, sector, rows: sectorRows } of Array.from(sectorGroups.values())) {
    activitiesWithSectorGroups.add(activityKey(activity));
    const components: GasComponent[] = [];
    const co2Row = co2ByActivity.get(activityKey(activity));
    if (co2Row) components.push(buildComponent(co2Row));
    for (const r of sectorRows) components.push(buildComponent(r));

    const totalFactor = components.reduce((sum, c) => sum + c.co2ePerUnit, 0);
    bundles.push({
      key: `${activity.category}::${activity.activityType}::${sector}`,
      category: activity.category,
      activityType: activity.activityType,
      sector,
      scope: activity.scope,
      unit: activity.unit,
      factor: {
        name: `${activity.activityType} — ${sector} (IPCC default)`,
        factor: totalFactor,
        unit: activity.unit,
        category: activity.category,
        gasBreakdown: components,
      },
    });
  }

  // Activities that only have a CO2 row (no sector-specific CH4/N2O rows at
  // all) -- degrade to a single standalone bundle rather than disappearing.
  for (const [key, co2Row] of Array.from(co2ByActivity.entries())) {
    if (activitiesWithSectorGroups.has(key)) continue;
    const component = buildComponent(co2Row);
    bundles.push({
      key: `${co2Row.category}::${co2Row.activityType}::all`,
      category: co2Row.category,
      activityType: co2Row.activityType,
      sector: "all",
      scope: co2Row.scope,
      unit: co2Row.unit,
      factor: {
        name: `${co2Row.activityType} (IPCC default)`,
        factor: component.co2ePerUnit,
        unit: co2Row.unit,
        category: co2Row.category,
        gasBreakdown: [component],
      },
    });
  }

  return bundles;
}

import { Card, CardContent } from "@/components/ui/card";
import { Emission, ScopeType } from "@/types/emissions";

interface ScopeReportProps {
  emissions: Emission[];
}

const formatNumber = (value: number) =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatScope = (scope: ScopeType) => scope.replace("scope", "Scope ");

const trend = (current: number, previous: number) => {
  if (previous === 0) return { label: "N/A", className: "text-slate-500" };
  const deltaPct = ((current - previous) / previous) * 100;
  if (deltaPct > 0) return { label: `▲ ${deltaPct.toFixed(1)}%`, className: "text-red-600" };
  if (deltaPct < 0) return { label: `▼ ${Math.abs(deltaPct).toFixed(1)}%`, className: "text-emerald-600" };
  return { label: "0.0%", className: "text-slate-500" };
};

export default function ScopeReport({ emissions }: ScopeReportProps) {
  const years = Array.from(new Set(emissions.map((e) => e.year).filter((y): y is number => typeof y === "number"))).sort(
    (a, b) => a - b,
  );
  const latestYear = years[years.length - 1];
  const previousYear = years[years.length - 2];

  const byScope: Record<ScopeType, number> = { scope1: 0, scope2: 0, scope3: 0 };
  emissions.forEach((e) => {
    byScope[e.scope] += e.emission;
  });

  const byScopeYear = new Map<ScopeType, { current: number; previous: number }>();
  (Object.keys(byScope) as ScopeType[]).forEach((scope) => {
    byScopeYear.set(scope, { current: 0, previous: 0 });
  });

  if (latestYear !== undefined) {
    emissions.forEach((e) => {
      const row = byScopeYear.get(e.scope)!;
      if (e.year === latestYear) row.current += e.emission;
      if (previousYear !== undefined && e.year === previousYear) row.previous += e.emission;
    });
  }

  const scope3CategoryTotals = new Map<string, number>();
  emissions
    .filter((e) => e.scope === "scope3")
    .forEach((e) => {
      const key = e.scope3Category || "Uncategorized";
      scope3CategoryTotals.set(key, (scope3CategoryTotals.get(key) || 0) + e.emission);
    });

  const scope3CategoryYear = new Map<string, { current: number; previous: number }>();
  if (latestYear !== undefined) {
    emissions
      .filter((e) => e.scope === "scope3")
      .forEach((e) => {
        const key = e.scope3Category || "Uncategorized";
        if (!scope3CategoryYear.has(key)) scope3CategoryYear.set(key, { current: 0, previous: 0 });
        const row = scope3CategoryYear.get(key)!;
        if (e.year === latestYear) row.current += e.emission;
        if (previousYear !== undefined && e.year === previousYear) row.previous += e.emission;
      });
  }

  const sortedCategories = Array.from(scope3CategoryTotals.entries()).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <Card className="bg-white">
        <CardContent className="pt-6">
          <h3 className="mb-3 text-lg font-semibold text-slate-800">Report by Scope</h3>
          <p className="mb-4 text-sm text-slate-600">
            Totals for Scope 1, Scope 2, Scope 3 with year-on-year trend
            {latestYear ? ` (${latestYear}${previousYear ? ` vs ${previousYear}` : ""})` : " (add year data to view trends)"}.
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500">Scope</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500">Total (kg CO₂e)</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500">YoY Trend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {(Object.keys(byScope) as ScopeType[]).map((scope) => {
                  const t = byScopeYear.get(scope)!;
                  const tr = trend(t.current, t.previous);
                  return (
                    <tr key={scope}>
                      <td className="px-4 py-3 text-sm text-slate-700">{formatScope(scope)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-slate-800">{formatNumber(byScope[scope])}</td>
                      <td className={`px-4 py-3 text-sm font-medium ${tr.className}`}>{tr.label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardContent className="pt-6">
          <h3 className="mb-3 text-lg font-semibold text-slate-800">Scope 3 Categories (1–15)</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500">Category</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500">Total (kg CO₂e)</th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500">YoY Trend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {sortedCategories.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-3 text-sm text-slate-500">
                      No Scope 3 category data yet. Assign categories while entering Scope 3 activities.
                    </td>
                  </tr>
                ) : (
                  sortedCategories.map(([category, total]) => {
                    const yearRow = scope3CategoryYear.get(category) || { current: 0, previous: 0 };
                    const tr = trend(yearRow.current, yearRow.previous);
                    return (
                      <tr key={category}>
                        <td className="px-4 py-3 text-sm text-slate-700">{category}</td>
                        <td className="px-4 py-3 text-sm font-medium text-slate-800">{formatNumber(total)}</td>
                        <td className={`px-4 py-3 text-sm font-medium ${tr.className}`}>{tr.label}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

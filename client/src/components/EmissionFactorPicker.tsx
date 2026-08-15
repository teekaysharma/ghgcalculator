import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { groupIpccFactorsByGasBundle, type IpccDefaultFactorRow, type GwpValueRow, type IpccGasBundle } from "@/lib/ipccGasBundle";

// Shared factor-picker for both the legacy Scope 1/2/3 calculator
// (ScopeInput.tsx/EmissionCalculator.tsx) and the facility-level MRV
// CalculationApproachForm (BoundaryWorkspace.tsx) -- this is the
// "shared factor-picker" both sessions' handoff notes and CLAUDE.md called
// for but never built.
//
// Resolution model: an org's own uploaded/entered factor (emission_factors,
// persisted, org-scoped) is always a SUPPLEMENT to the IPCC defaults
// (ipcc_default_factors, global reference table), never a replacement --
// the picker lists org factors first (if any exist), then IPCC defaults,
// and every selection is tagged isIpccDefault so callers can flag it
// accordingly (e.g. mirror into dataQualityRecords.usedIpccDefaultFactor).
// The IPCC default list is empty as of this component's creation --
// see shared/schema.ts (ipccDefaultFactors) and
// scripts/manual-migration-005.mjs for why. This picker still needs to
// render sanely with zero IPCC rows, not look broken.
//
// Every org factor -- whether added here or bulk-uploaded elsewhere -- must
// carry a real sourceUrl + authorityName; POST /api/emission-factors
// enforces this server-side (server/routes.ts), this component enforces it
// client-side too so the user isn't surprised by a 400 after filling in a
// whole form.

interface OrgEmissionFactor {
  id: number;
  name: string;
  factor: string;
  unit: string;
  scope: string | null;
  source: string | null;
  sourceUrl: string | null;
  authorityName: string | null;
  country?: string | null;
}

export interface EmissionFactorSelection {
  label: string;
  factorValue: string;
  factorUnit: string;
  factorSource: string;
  factorSourceUrl: string;
  factorAuthorityName: string;
  isIpccDefault: boolean;
  // Present only for IPCC default selections built from a multi-gas bundle
  // (Stationary Combustion etc) -- see shared/schema.ts ipccDefaultFactors
  // comment. Display-only in this form today: shown in the summary box
  // below so the per-gas quantification stays visible/auditable per
  // ISO/TS 14064-4, but not yet persisted as its own column on
  // calculationApproaches (that's the emission_records path, wired in
  // EmissionCalculator.tsx / server routes.ts /api/calculate).
  gasBreakdown?: IpccGasBundle["factor"]["gasBreakdown"];
}

interface EmissionFactorPickerProps {
  scope?: string | null;
  facilityCountry?: string | null;
  onSelect: (selection: EmissionFactorSelection) => void;
}

export function EmissionFactorPicker({ scope, facilityCountry, onSelect }: EmissionFactorPickerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newFactor, setNewFactor] = useState({
    name: "",
    factor: "",
    unit: "",
    sourceUrl: "",
    authorityName: "",
    country: facilityCountry ?? "",
  });

  const orgFactorsQuery = useQuery<{ factors: OrgEmissionFactor[] }>({
    queryKey: ["/api/emission-factors"],
  });
  const ipccQuery = useQuery<{ ipccDefaultFactors: IpccDefaultFactorRow[] }>({
    queryKey: ["/api/reference/ipcc-default-factors"],
  });
  const gwpValuesQuery = useQuery<{ gwpValues: GwpValueRow[] }>({
    queryKey: ["/api/reference/gwp-values"],
  });

  const orgFactors = (orgFactorsQuery.data?.factors ?? []).filter((f) => !scope || !f.scope || f.scope === scope);
  const orgFactorsForCountry = facilityCountry
    ? orgFactors.filter((f) => f.country === facilityCountry)
    : [];
  const orgFactorsOther = facilityCountry
    ? orgFactors.filter((f) => f.country !== facilityCountry)
    : orgFactors;
  const ipccBundles = groupIpccFactorsByGasBundle(
    ipccQuery.data?.ipccDefaultFactors ?? [],
    gwpValuesQuery.data?.gwpValues ?? [],
  ).filter((b) => !scope || !b.scope || b.scope === scope);

  const addFactor = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/emission-factors", {
        factors: [
          {
            name: newFactor.name,
            factor: Number(newFactor.factor),
            unit: newFactor.unit,
            scope: scope || undefined,
            sourceUrl: newFactor.sourceUrl,
            authorityName: newFactor.authorityName,
            country: newFactor.country || undefined,
          },
        ],
      });
      return res.json();
    },
    onSuccess: (body: { factors?: OrgEmissionFactor[] }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/emission-factors"] });
      toast({ title: "Factor added" });
      const created = body.factors?.[0];
      if (created) {
        setSelectedKey(`org:${created.id}`);
        onSelect({
          label: created.name,
          factorValue: created.factor,
          factorUnit: created.unit,
          factorSource: created.authorityName ?? created.source ?? "",
          factorSourceUrl: created.sourceUrl ?? "",
          factorAuthorityName: created.authorityName ?? "",
          isIpccDefault: false,
        });
      }
      setShowAddForm(false);
      setNewFactor({ name: "", factor: "", unit: "", sourceUrl: "", authorityName: "", country: facilityCountry ?? "" });
    },
    onError: (err: Error) => toast({ title: "Could not add factor", description: err.message, variant: "destructive" }),
  });

  const handleSelect = (key: string) => {
    setSelectedKey(key);
    if (key.startsWith("org:")) {
      const id = Number(key.slice(4));
      const f = orgFactors.find((x) => x.id === id);
      if (f) {
        onSelect({
          label: f.name,
          factorValue: f.factor,
          factorUnit: f.unit,
          factorSource: f.authorityName ?? f.source ?? "",
          factorSourceUrl: f.sourceUrl ?? "",
          factorAuthorityName: f.authorityName ?? "",
          isIpccDefault: false,
        });
      }
    } else if (key.startsWith("ipcc:")) {
      const bundleKey = key.slice(5);
      const bundle = ipccBundles.find((b) => b.key === bundleKey);
      if (bundle) {
        const sourceDocs = Array.from(
          new Set((bundle.factor.gasBreakdown ?? []).map((c) => c.gas)),
        );
        onSelect({
          label: bundle.factor.name,
          factorValue: String(bundle.factor.factor),
          factorUnit: bundle.factor.unit,
          factorSource: `IPCC default (${sourceDocs.join(" + ")}, gas-weighted with ${
            bundle.factor.gasBreakdown?.[0]?.gwpVersion ?? "AR6"
          } GWP-100)`,
          factorSourceUrl: "",
          factorAuthorityName: "IPCC",
          isIpccDefault: true,
          gasBreakdown: bundle.factor.gasBreakdown,
        });
      }
    }
  };

  const addFormValid =
    newFactor.name.trim().length > 0 &&
    newFactor.factor.trim().length > 0 &&
    newFactor.unit.trim().length > 0 &&
    /^https?:\/\/.+/i.test(newFactor.sourceUrl.trim()) &&
    newFactor.authorityName.trim().length > 0;

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Emission factor</Label>
      <Select value={selectedKey} onValueChange={handleSelect}>
        <SelectTrigger>
          <SelectValue placeholder="Select a factor" />
        </SelectTrigger>
        <SelectContent>
          {orgFactorsForCountry.length > 0 && (
            <SelectGroup>
              <SelectLabel>Your organization's factors for {facilityCountry}</SelectLabel>
              {orgFactorsForCountry.map((f) => (
                <SelectItem key={f.id} value={`org:${f.id}`}>
                  {f.name} ({f.factor} kg CO2e/{f.unit})
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {orgFactorsOther.length > 0 && (
            <SelectGroup>
              <SelectLabel>Your organization's other factors</SelectLabel>
              {orgFactorsOther.map((f) => (
                <SelectItem key={f.id} value={`org:${f.id}`}>
                  {f.name} ({f.factor} kg CO2e/{f.unit})
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          <SelectGroup>
            <SelectLabel>IPCC default factors</SelectLabel>
            {ipccBundles.length === 0 ? (
              <div className="px-8 py-1.5 text-sm text-neutral-400 italic">
                No IPCC default factors loaded yet — dataset pending
              </div>
            ) : (
              ipccBundles.map((b) => (
                <SelectItem key={b.key} value={`ipcc:${b.key}`}>
                  {b.factor.name} ({b.factor.factor.toFixed(1)} kg CO2e/{b.unit})
                </SelectItem>
              ))
            )}
          </SelectGroup>
        </SelectContent>
      </Select>

      {selectedKey.startsWith("ipcc:") &&
        (() => {
          const bundle = ipccBundles.find((b) => `ipcc:${b.key}` === selectedKey);
          const breakdown = bundle?.factor.gasBreakdown;
          if (!breakdown || breakdown.length === 0) return null;
          return (
            <div className="text-xs border rounded-md p-2 bg-neutral-50 space-y-1">
              <p className="font-medium text-neutral-600">
                Per-gas breakdown (ISO 14064-1: quantity x GWP, disclosed per gas, not pre-combined)
              </p>
              {breakdown.map((c) => (
                <div key={c.gas} className="flex justify-between text-neutral-500">
                  <span>
                    {c.gas}: {c.nativeFactor} native x GWP {c.gwpValue} ({c.gwpVersion})
                  </span>
                  <span>{c.co2ePerUnit.toFixed(1)} kg CO2e/{bundle?.unit}</span>
                </div>
              ))}
            </div>
          );
        })()}

      {!showAddForm ? (
        <button type="button" className="text-xs text-primary-600 hover:text-primary-800 underline" onClick={() => setShowAddForm(true)}>
          + Add your own factor (requires a traceable source)
        </button>
      ) : (
        <div className="space-y-2 border rounded-md p-3 bg-neutral-50">
          <p className="text-xs text-neutral-500">
            IPCC defaults are the fallback and are never replaced, only supplemented -- every factor you add
            supplements them for this specific activity and must be traceable to a real, checkable source.
          </p>
          <Input
            placeholder="Activity name"
            value={newFactor.name}
            onChange={(e) => setNewFactor((f) => ({ ...f, name: e.target.value }))}
          />
          {/* The calculation pipeline (server/routes.ts PUT
              .../calculation-approach) computes quantity x factor and
              divides by 1000 to reach tCO2e -- i.e. it assumes every factor
              is expressed in kg CO2e per unit of activity data. Many public
              datasets publish factors in TONNES CO2e per unit, and entering
              one of those here would overstate every downstream total by
              1000x with nothing to catch it. So the basis is stated on the
              field itself, not left implicit. */}
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="Factor value (kg CO2e per unit)"
              value={newFactor.factor}
              onChange={(e) => setNewFactor((f) => ({ ...f, factor: e.target.value }))}
            />
            <Input
              placeholder="Unit of activity data (e.g. TJ, litre, kWh)"
              value={newFactor.unit}
              onChange={(e) => setNewFactor((f) => ({ ...f, unit: e.target.value }))}
            />
          </div>
          <p className="text-xs text-amber-700">
            The factor value must be in <strong>kg CO2e per unit</strong>. If your source publishes it in tonnes CO2e
            per unit, multiply by 1000 before entering it here.
          </p>
          <Input
            placeholder="Source link (https://...) -- required"
            value={newFactor.sourceUrl}
            onChange={(e) => setNewFactor((f) => ({ ...f, sourceUrl: e.target.value }))}
          />
          <Input
            placeholder="Issuing authority name -- required"
            value={newFactor.authorityName}
            onChange={(e) => setNewFactor((f) => ({ ...f, authorityName: e.target.value }))}
          />
          <Input
            placeholder="Country (ISO code, e.g. AE) -- optional"
            value={newFactor.country}
            onChange={(e) => setNewFactor((f) => ({ ...f, country: e.target.value }))}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => addFactor.mutate()} disabled={addFactor.isPending || !addFormValid}>
              {addFactor.isPending ? "Adding..." : "Add factor"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

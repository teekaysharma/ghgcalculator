import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { EmissionFactorPicker, type EmissionFactorSelection } from "@/components/EmissionFactorPicker";
import type { GasComponent } from "@/types/emissions";

// Route paths and response envelope keys below were confirmed by reading
// server/routes.ts directly this session, not guessed. This includes the two
// keys that were left as flagged assumptions in an earlier pass
// (verification-finding create/update response key, and the management-qa
// update response key) -- both were grep-confirmed this pass to match the
// established singular-camelCase convention with no correction needed.
// Confirmed keys: sourceStream/sourceStreams, calculationApproach,
// measurementApproach, fallbackApproach, dataQualityRecord, methaneReport,
// findings (list) / finding (create, PUT update), managementQaRecords (list)
// / managementQaRecord (create, PUT update). Note: this component does not
// actually call PUT /api/management-qa/:id or PUT /api/verification-findings/:id
// (no edit UI was built, only add/remove), so those two update-route keys are
// confirmed against routes.ts but have no corresponding usage site here.
//
// Source streams are nested under /api/reporting-boundaries/:boundaryId/,
// but calculation/measurement/fallback/data-quality detail is nested under
// /api/source-streams/:id/ instead (confirmed, not a guess -- the schema's
// 1:1-via-unique-constraint design on sourceStreamId is why). Methane
// reports have no :id in the path at all -- GET takes facilityId +
// reportingBoundaryId as query params, PUT takes them in the body
// (confirmed by reading the route's body parsing directly).

const SCOPE_3_CATEGORIES = [
  { value: 1, label: "Purchased goods and services" },
  { value: 2, label: "Capital goods" },
  { value: 3, label: "Fuel- and energy-related activities" },
  { value: 4, label: "Upstream transportation and distribution" },
  { value: 5, label: "Waste generated in operations" },
  { value: 6, label: "Business travel" },
  { value: 7, label: "Employee commuting" },
  { value: 8, label: "Upstream leased assets" },
  { value: 9, label: "Downstream transportation and distribution" },
  { value: 10, label: "Processing of sold products" },
  { value: 11, label: "Use of sold products" },
  { value: 12, label: "End-of-life treatment of sold products" },
  { value: 13, label: "Downstream leased assets" },
  { value: 14, label: "Franchises" },
  { value: 15, label: "Investments" },
];

interface SourceStream {
  id: number;
  facilityId: number;
  name: string;
  description: string | null;
  ghgSourceCategory: string | null;
  materiality: string | null;
  estimatedAnnualEmissionsTco2e: string | null;
  quantificationApproach: string | null;
  scope: string | null;
  scope3Category: number | null;
}

interface CalculationApproach {
  fuelOrMaterialType: string | null;
  activityDataValue: string | null;
  activityDataUnit: string | null;
  activityDataSource: string | null;
  activityDataTier: string | null;
  emissionFactorValue: string | null;
  emissionFactorUnit: string | null;
  emissionFactorSource: string | null;
  emissionFactorTier: string | null;
  emissionFactorSourceUrl: string | null;
  emissionFactorAuthorityName: string | null;
  isIpccDefault: boolean;
  oxidationOrCarbonationFactor: string | null;
  oxidationFactorTier: string | null;
  netCalorificValue: string | null;
  calculatedEmissionsTco2e: string | null;
  gasBreakdown: EmissionFactorSelection["gasBreakdown"] | null;
  notes: string | null;
}

interface MeasurementBasedApproach {
  measurementMethod: string | null;
  monitoringFrequency: string | null;
  measurementUnit: string | null;
  annualMeasuredQuantity: string | null;
  qaqcProcedure: string | null;
  calibrationFrequency: string | null;
  notes: string | null;
}

interface FallbackApproach {
  justification: string | null;
  fallbackMethodDescription: string | null;
  estimatedEmissionsTco2e: string | null;
}

interface DataQualityRecord {
  dataQualityTier: string | null;
  uncertaintyPercent: string | null;
  uncertaintyJustification: string | null;
  usedIpccDefaultFactor: boolean | null;
  ipccDefaultSubstitutionReason: string | null;
}

interface MethaneReport {
  methaneSourcesDescription: string | null;
  quantificationMethod: string | null;
  annualMethaneEmissions: string | null;
  annualMethaneEmissionsUnit: string | null;
  notes: string | null;
}

interface VerificationFinding {
  id: number;
  findingType: string;
  description: string;
  severity: string | null;
  status: string;
  resolutionNotes: string | null;
}

interface ManagementQaRecord {
  id: number;
  qaProcedureDescription: string | null;
  responsiblePerson: string | null;
  reviewFrequency: string | null;
  lastReviewDate: string | null;
}

// Minimal shape needed for the finalize/recalculate snapshot mechanic --
// the caller (AppShell.tsx's BoundaryWorkspaceSection) already holds the
// full reporting boundary object from its /api/reporting-boundaries list
// query, so it's passed down rather than re-fetched here.
interface ReportingBoundarySummary {
  id: number;
  status: string;
  finalizedAt: string | null;
}

export default function BoundaryWorkspace({
  facilityId,
  reportingBoundaryId,
  reportingBoundary,
}: {
  facilityId: number;
  reportingBoundaryId: number;
  reportingBoundary: ReportingBoundarySummary;
}) {
  const queryClient = useQueryClient();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Boundary workspace</CardTitle>
            <CardDescription>Source streams, methane reporting, verification findings, and management QA for this facility and reporting year.</CardDescription>
          </div>
          {reportingBoundary.status === "draft" ? (
            <Button
              size="sm"
              onClick={async () => {
                await apiRequest("PATCH", `/api/reporting-boundaries/${reportingBoundary.id}/finalize`, {});
                queryClient.invalidateQueries({ queryKey: ["/api/reporting-boundaries"] });
              }}
            >
              Finalize report
            </Button>
          ) : (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
                Finalized {reportingBoundary.finalizedAt ? new Date(reportingBoundary.finalizedAt).toLocaleDateString() : ""}
              </span>
              <RecalculateButton reportingBoundaryId={reportingBoundary.id} />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="streams" className="space-y-4">
          <TabsList>
            <TabsTrigger value="streams">Source Streams</TabsTrigger>
            <TabsTrigger value="methane">Methane Report</TabsTrigger>
            <TabsTrigger value="verification">Verification Findings</TabsTrigger>
            <TabsTrigger value="qa">Management QA</TabsTrigger>
          </TabsList>
          <TabsContent value="streams">
            <SourceStreamsTab facilityId={facilityId} reportingBoundaryId={reportingBoundaryId} />
          </TabsContent>
          <TabsContent value="methane">
            <MethaneReportTab facilityId={facilityId} reportingBoundaryId={reportingBoundaryId} />
          </TabsContent>
          <TabsContent value="verification">
            <VerificationFindingsTab reportingBoundaryId={reportingBoundaryId} />
          </TabsContent>
          <TabsContent value="qa">
            <ManagementQaTab reportingBoundaryId={reportingBoundaryId} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

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
          queryClient.invalidateQueries({ queryKey: ["/api/reporting-boundaries"] });
          setOpen(false);
          setReason("");
        }}
      >
        Confirm
      </Button>
    </div>
  );
}

function SourceStreamsTab({ facilityId, reportingBoundaryId }: { facilityId: number; reportingBoundaryId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const streamsQuery = useQuery<{ sourceStreams: SourceStream[] }>({
    queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/source-streams`],
  });
  const streams = streamsQuery.data?.sourceStreams ?? [];
  const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<string>("");
  const [scope3Category, setScope3Category] = useState<string>("");
  const [materiality, setMateriality] = useState<string>("");
  const [estimatedAnnualEmissionsTco2e, setEstimatedAnnualEmissionsTco2e] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/reporting-boundaries/${reportingBoundaryId}/source-streams`, {
        facilityId,
        name,
        description: description || undefined,
        scope: scope || undefined,
        scope3Category: scope === "scope3" && scope3Category ? Number(scope3Category) : undefined,
        materiality: materiality || undefined,
        estimatedAnnualEmissionsTco2e: estimatedAnnualEmissionsTco2e || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setName("");
      setDescription("");
      setScope("");
      setScope3Category("");
      setMateriality("");
      setEstimatedAnnualEmissionsTco2e("");
      queryClient.invalidateQueries({ queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/source-streams`] });
      toast({ title: "Source stream created" });
      if (data?.sourceStream?.id) setSelectedStreamId(data.sourceStream.id);
    },
    onError: (err) => toast({ title: "Could not create source stream", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/source-streams/${id}`);
    },
    onSuccess: () => {
      if (selectedStreamId) setSelectedStreamId(null);
      queryClient.invalidateQueries({ queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/source-streams`] });
      toast({ title: "Source stream removed" });
    },
    onError: (err) => toast({ title: "Could not remove source stream", description: err.message, variant: "destructive" }),
  });

  const selectedStream = streams.find((s) => s.id === selectedStreamId) ?? null;

  return (
    <div className="space-y-6">
      {streamsQuery.isLoading && <div className="text-sm text-neutral-500">Loading...</div>}
      {!streamsQuery.isLoading && streams.length === 0 && (
        <p className="text-sm text-neutral-500">No source streams yet for this reporting year.</p>
      )}
      {streams.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Materiality</TableHead>
              <TableHead>Approach</TableHead>
              <TableHead>Est. emissions (tCO2e)</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {streams.map((s) => (
              <TableRow
                key={s.id}
                className={selectedStreamId === s.id ? "bg-neutral-50" : "cursor-pointer"}
                onClick={() => setSelectedStreamId(s.id)}
              >
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell className="capitalize">
                  {s.scope ? s.scope.replace("scope", "Scope ") : "-"}
                  {s.scope === "scope3" && s.scope3Category
                    ? ` (Cat. ${s.scope3Category})`
                    : ""}
                </TableCell>
                <TableCell className="capitalize">{s.materiality ?? "-"}</TableCell>
                <TableCell className="capitalize">{s.quantificationApproach?.replace("_", " ") ?? "not set"}</TableCell>
                <TableCell>{s.estimatedAnnualEmissionsTco2e ?? "-"}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove.mutate(s.id);
                    }}
                  >
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {selectedStream && (
        <SourceStreamDetail
          key={selectedStream.id}
          stream={selectedStream}
          reportingBoundaryId={reportingBoundaryId}
          onClose={() => setSelectedStreamId(null)}
        />
      )}

      <div className="border-t border-neutral-100 pt-4 space-y-3">
        <Label className="text-sm font-medium">Add a source stream</Label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input placeholder="Name (required)" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={materiality} onValueChange={setMateriality}>
            <SelectTrigger>
              <SelectValue placeholder="Materiality" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="major">Major</SelectItem>
              <SelectItem value="minor">Minor</SelectItem>
            </SelectContent>
          </Select>
          <Textarea
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="md:col-span-2"
            rows={2}
          />
          <Input
            placeholder="Estimated annual emissions (tCO2e, optional)"
            value={estimatedAnnualEmissionsTco2e}
            onChange={(e) => setEstimatedAnnualEmissionsTco2e(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm">Scope</Label>
          <ToggleGroup type="single" value={scope} onValueChange={(v) => v && setScope(v)}>
            <ToggleGroupItem value="scope1">Scope 1</ToggleGroupItem>
            <ToggleGroupItem value="scope2">Scope 2</ToggleGroupItem>
            <ToggleGroupItem value="scope3">Scope 3</ToggleGroupItem>
          </ToggleGroup>
        </div>
        {scope === "scope3" && (
          <Select value={scope3Category} onValueChange={setScope3Category}>
            <SelectTrigger className="max-w-md">
              <SelectValue placeholder="Select the GHG Protocol Scope 3 category (required)" />
            </SelectTrigger>
            <SelectContent>
              {SCOPE_3_CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={String(c.value)}>
                  {c.value}. {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || !name || !scope || (scope === "scope3" && !scope3Category)}
        >
          {create.isPending ? "Creating..." : "Create source stream"}
        </Button>
      </div>
    </div>
  );
}

function SourceStreamDetail({
  stream,
  reportingBoundaryId,
  onClose,
}: {
  stream: SourceStream;
  reportingBoundaryId: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [approach, setApproach] = useState<string>(stream.quantificationApproach ?? "");

  const facilitiesQuery = useQuery<{ facilities: { id: number; country: string | null }[] }>({
    queryKey: ["/api/facilities"],
  });
  const facilityCountry = facilitiesQuery.data?.facilities.find((f) => f.id === stream.facilityId)?.country ?? null;

  return (
    <Card className="border-primary-200">
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="text-sm">{stream.name}</CardTitle>
          <CardDescription>{stream.description || "No description"}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!approach && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">How is this measured?</Label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { value: "calculation_based", title: "Calculation-based", desc: "Activity data \u00d7 an emission factor." },
                { value: "measurement_based", title: "Measurement-based", desc: "Continuous monitoring equipment." },
                { value: "fallback", title: "Fallback", desc: "Neither is available, estimate and justify." },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={async () => {
                    await apiRequest("PUT", `/api/source-streams/${stream.id}`, { quantificationApproach: opt.value });
                    setApproach(opt.value);
                    queryClient.invalidateQueries({
                      queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/source-streams`],
                    });
                  }}
                  className="text-left border rounded-md p-3 hover:border-primary-400 hover:bg-primary-50 transition-colors"
                >
                  <div className="font-medium text-sm">{opt.title}</div>
                  <div className="text-xs text-neutral-500 mt-1">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {approach === "calculation_based" && (
          <CalculationApproachForm sourceStreamId={stream.id} scope={stream.scope} facilityCountry={facilityCountry} />
        )}
        {approach === "measurement_based" && <MeasurementApproachForm sourceStreamId={stream.id} />}
        {approach === "fallback" && (
          <FallbackApproachForm sourceStreamId={stream.id} reportingBoundaryId={reportingBoundaryId} />
        )}

        {approach && <DataQualitySection sourceStreamId={stream.id} />}

        {approach && (
          <button
            type="button"
            className="text-xs text-neutral-400 underline"
            onClick={async () => {
              await apiRequest("PUT", `/api/source-streams/${stream.id}`, { quantificationApproach: null });
              setApproach("");
              queryClient.invalidateQueries({
                queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/source-streams`],
              });
            }}
          >
            Change quantification approach (existing data for the current approach is kept but hidden)
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function CalculationApproachForm({
  sourceStreamId,
  scope,
  facilityCountry,
}: {
  sourceStreamId: number;
  scope: string | null;
  facilityCountry: string | null;
}) {
  const { toast } = useToast();
  const query = useQuery<{ calculationApproach: CalculationApproach | null }>({
    queryKey: [`/api/source-streams/${sourceStreamId}/calculation-approach`],
  });
  const existing = query.data?.calculationApproach ?? null;

  const [fields, setFields] = useState({
    fuelOrMaterialType: existing?.fuelOrMaterialType ?? "",
    activityDataValue: existing?.activityDataValue ?? "",
    activityDataUnit: existing?.activityDataUnit ?? "",
    activityDataSource: existing?.activityDataSource ?? "",
    activityDataTier: existing?.activityDataTier ?? "",
    emissionFactorValue: existing?.emissionFactorValue ?? "",
    emissionFactorUnit: existing?.emissionFactorUnit ?? "",
    emissionFactorSource: existing?.emissionFactorSource ?? "",
    emissionFactorTier: existing?.emissionFactorTier ?? "",
    emissionFactorSourceUrl: existing?.emissionFactorSourceUrl ?? "",
    emissionFactorAuthorityName: existing?.emissionFactorAuthorityName ?? "",
    oxidationOrCarbonationFactor: existing?.oxidationOrCarbonationFactor ?? "",
    netCalorificValue: existing?.netCalorificValue ?? "",
    calculatedEmissionsTco2e: existing?.calculatedEmissionsTco2e ?? "",
    notes: existing?.notes ?? "",
  });
  const [isIpccDefault, setIsIpccDefault] = useState(existing?.isIpccDefault ?? false);
  const [gasBreakdown, setGasBreakdown] = useState<EmissionFactorSelection["gasBreakdown"]>(
    existing?.gasBreakdown ?? undefined,
  );

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/source-streams/${sourceStreamId}/calculation-approach`, {
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v || undefined])),
        isIpccDefault,
        gasBreakdown,
      });
      return res.json();
    },
    onSuccess: () => toast({ title: "Calculation approach saved" }),
    onError: (err) => toast({ title: "Could not save", description: err.message, variant: "destructive" }),
  });

  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="space-y-3 bg-neutral-50 rounded-md p-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Input placeholder="Fuel / material type" value={fields.fuelOrMaterialType} onChange={set("fuelOrMaterialType")} />
        <Input placeholder="Activity data value" value={fields.activityDataValue} onChange={set("activityDataValue")} />
        <Input placeholder="Activity data unit" value={fields.activityDataUnit} onChange={set("activityDataUnit")} />
        <Input placeholder="Activity data source" value={fields.activityDataSource} onChange={set("activityDataSource")} />
        <Input placeholder="Activity data tier" value={fields.activityDataTier} onChange={set("activityDataTier")} />
      </div>

      <EmissionFactorPicker
        scope={scope}
        facilityCountry={facilityCountry}
        onSelect={(selection) => {
          setFields((f) => ({
            ...f,
            emissionFactorValue: selection.factorValue,
            emissionFactorUnit: selection.factorUnit,
            emissionFactorSource: selection.factorSource,
            emissionFactorSourceUrl: selection.factorSourceUrl,
            emissionFactorAuthorityName: selection.factorAuthorityName,
          }));
          setIsIpccDefault(selection.isIpccDefault);
          setGasBreakdown(selection.gasBreakdown);
        }}
      />
      {fields.emissionFactorValue && (
        <div className="text-xs text-neutral-500 bg-white border rounded-md p-2 space-y-0.5">
          <div>
            Using: <span className="font-medium">{fields.emissionFactorValue} {fields.emissionFactorUnit}</span>
            {isIpccDefault && <span className="ml-2 text-amber-700 font-medium">IPCC default</span>}
          </div>
          {fields.emissionFactorAuthorityName && <div>Authority: {fields.emissionFactorAuthorityName}</div>}
          {fields.emissionFactorSourceUrl && (
            <div>
              Source:{" "}
              <a href={fields.emissionFactorSourceUrl} target="_blank" rel="noreferrer" className="underline">
                {fields.emissionFactorSourceUrl}
              </a>
            </div>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Input placeholder="Emission factor tier" value={fields.emissionFactorTier} onChange={set("emissionFactorTier")} />
        <Input
          placeholder="Oxidation / carbonation factor"
          value={fields.oxidationOrCarbonationFactor}
          onChange={set("oxidationOrCarbonationFactor")}
        />
        <Input placeholder="Net calorific value" value={fields.netCalorificValue} onChange={set("netCalorificValue")} />
        <Input
          placeholder="Calculated emissions (tCO2e)"
          value={fields.calculatedEmissionsTco2e}
          onChange={set("calculatedEmissionsTco2e")}
        />
      </div>
      <Textarea placeholder="Notes" value={fields.notes} onChange={set("notes")} rows={2} />
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save calculation approach"}
      </Button>
    </div>
  );
}

function MeasurementApproachForm({ sourceStreamId }: { sourceStreamId: number }) {
  const { toast } = useToast();
  const query = useQuery<{ measurementApproach: MeasurementBasedApproach | null }>({
    queryKey: [`/api/source-streams/${sourceStreamId}/measurement-approach`],
  });
  const existing = query.data?.measurementApproach ?? null;

  const [fields, setFields] = useState({
    measurementMethod: existing?.measurementMethod ?? "",
    monitoringFrequency: existing?.monitoringFrequency ?? "",
    measurementUnit: existing?.measurementUnit ?? "",
    annualMeasuredQuantity: existing?.annualMeasuredQuantity ?? "",
    qaqcProcedure: existing?.qaqcProcedure ?? "",
    calibrationFrequency: existing?.calibrationFrequency ?? "",
    notes: existing?.notes ?? "",
  });

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/source-streams/${sourceStreamId}/measurement-approach`, {
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v || undefined])),
      });
      return res.json();
    },
    onSuccess: () => toast({ title: "Measurement-based approach saved" }),
    onError: (err) => toast({ title: "Could not save", description: err.message, variant: "destructive" }),
  });

  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="space-y-3 bg-neutral-50 rounded-md p-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input placeholder="Measurement method" value={fields.measurementMethod} onChange={set("measurementMethod")} />
        <Input placeholder="Monitoring frequency" value={fields.monitoringFrequency} onChange={set("monitoringFrequency")} />
        <Input placeholder="Measurement unit" value={fields.measurementUnit} onChange={set("measurementUnit")} />
        <Input
          placeholder="Annual measured quantity"
          value={fields.annualMeasuredQuantity}
          onChange={set("annualMeasuredQuantity")}
        />
        <Input placeholder="QA/QC procedure" value={fields.qaqcProcedure} onChange={set("qaqcProcedure")} />
        <Input placeholder="Calibration frequency" value={fields.calibrationFrequency} onChange={set("calibrationFrequency")} />
      </div>
      <Textarea placeholder="Notes" value={fields.notes} onChange={set("notes")} rows={2} />
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save measurement-based approach"}
      </Button>
    </div>
  );
}

function FallbackApproachForm({
  sourceStreamId,
  reportingBoundaryId,
}: {
  sourceStreamId: number;
  reportingBoundaryId: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery<{ fallbackApproach: FallbackApproach | null }>({
    queryKey: [`/api/source-streams/${sourceStreamId}/fallback-approach`],
  });
  const existing = query.data?.fallbackApproach ?? null;

  const [justification, setJustification] = useState(existing?.justification ?? "");
  const [fallbackMethodDescription, setFallbackMethodDescription] = useState(existing?.fallbackMethodDescription ?? "");
  const [estimatedEmissionsTco2e, setEstimatedEmissionsTco2e] = useState(existing?.estimatedEmissionsTco2e ?? "");

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/source-streams/${sourceStreamId}/fallback-approach`, {
        justification: justification || undefined,
        fallbackMethodDescription: fallbackMethodDescription || undefined,
        estimatedEmissionsTco2e: estimatedEmissionsTco2e || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Fallback approach saved" });
      // The server mirrors this onto the parent source stream's
      // estimatedAnnualEmissionsTco2e, so the source-streams list needs a
      // refetch too, not just this form's own query.
      queryClient.invalidateQueries({
        queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/source-streams`],
      });
    },
    onError: (err) => toast({ title: "Could not save", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3 bg-neutral-50 rounded-md p-3">
      <Textarea
        placeholder="Justification for using a fallback approach (required by most facility-level MRV regimes)"
        value={justification}
        onChange={(e) => setJustification(e.target.value)}
        rows={2}
      />
      <Textarea
        placeholder="Fallback method description"
        value={fallbackMethodDescription}
        onChange={(e) => setFallbackMethodDescription(e.target.value)}
        rows={2}
      />
      <Input
        placeholder="Estimated emissions (tCO2e)"
        value={estimatedEmissionsTco2e}
        onChange={(e) => setEstimatedEmissionsTco2e(e.target.value)}
      />
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save fallback approach"}
      </Button>
    </div>
  );
}

function DataQualitySection({ sourceStreamId }: { sourceStreamId: number }) {
  const { toast } = useToast();
  const query = useQuery<{ dataQualityRecord: DataQualityRecord | null }>({
    queryKey: [`/api/source-streams/${sourceStreamId}/data-quality`],
  });
  const existing = query.data?.dataQualityRecord ?? null;

  // Same queryKey as CalculationApproachForm's query above -- react-query
  // dedupes/caches by key, so this doesn't issue a duplicate request when
  // both sections are mounted for the same source stream.
  const calcApproachQuery = useQuery<{ calculationApproach: { gasBreakdown?: GasComponent[] | null } | null }>({
    queryKey: [`/api/source-streams/${sourceStreamId}/calculation-approach`],
  });

  // Suggested uncertainty from the CO2 component's published 95% CI (IPCC
  // source table) -- CO2 dominates combustion CO2e and is the component
  // most likely to carry a disclosed CI in this dataset. Never auto-filled
  // into the field below: ISO 14064-3 6.1.3.6.3 expects verifiers to see a
  // deliberate uncertainty figure, not one that appeared silently.
  const suggestedUncertaintyPercent = (() => {
    const co2 = calcApproachQuery.data?.calculationApproach?.gasBreakdown?.find((c) => c.gas === "CO2");
    if (!co2 || co2.factorLower === undefined || co2.factorUpper === undefined || !co2.nativeFactor) return null;
    return (((co2.factorUpper - co2.factorLower) / 2 / co2.nativeFactor) * 100).toFixed(1);
  })();

  const [dataQualityTier, setDataQualityTier] = useState(existing?.dataQualityTier ?? "");
  const [uncertaintyPercent, setUncertaintyPercent] = useState(existing?.uncertaintyPercent ?? "");
  const [uncertaintyJustification, setUncertaintyJustification] = useState(existing?.uncertaintyJustification ?? "");
  const [usedIpccDefaultFactor, setUsedIpccDefaultFactor] = useState(existing?.usedIpccDefaultFactor ?? false);
  const [ipccDefaultSubstitutionReason, setIpccDefaultSubstitutionReason] = useState(
    existing?.ipccDefaultSubstitutionReason ?? "",
  );

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/source-streams/${sourceStreamId}/data-quality`, {
        dataQualityTier: dataQualityTier || undefined,
        uncertaintyPercent: uncertaintyPercent || undefined,
        uncertaintyJustification: uncertaintyJustification || undefined,
        usedIpccDefaultFactor,
        ipccDefaultSubstitutionReason: usedIpccDefaultFactor ? ipccDefaultSubstitutionReason || undefined : undefined,
      });
      return res.json();
    },
    onSuccess: () => toast({ title: "Data quality record saved" }),
    onError: (err) => toast({ title: "Could not save", description: err.message, variant: "destructive" }),
  });

  const canSave = !usedIpccDefaultFactor || ipccDefaultSubstitutionReason.trim().length > 0;

  return (
    <div className="space-y-3 border rounded-md p-3">
      <Label className="text-sm font-medium">Data quality</Label>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Select value={dataQualityTier} onValueChange={setDataQualityTier}>
          <SelectTrigger>
            <SelectValue placeholder="Data quality tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="best">Best</SelectItem>
            <SelectItem value="intermediate">Intermediate</SelectItem>
            <SelectItem value="minimum">Minimum</SelectItem>
          </SelectContent>
        </Select>
        <div className="space-y-1">
          <Input
            placeholder="Uncertainty (%)"
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
        </div>
      </div>
      <Textarea
        placeholder="Uncertainty justification"
        value={uncertaintyJustification}
        onChange={(e) => setUncertaintyJustification(e.target.value)}
        rows={2}
      />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={usedIpccDefaultFactor} onCheckedChange={(v) => setUsedIpccDefaultFactor(v === true)} />
        Used an IPCC default factor instead of a more specific one
      </label>
      {usedIpccDefaultFactor && (
        <div className="space-y-1">
          <Textarea
            placeholder="Required: why was an IPCC default used instead of a local/national/regional factor?"
            value={ipccDefaultSubstitutionReason}
            onChange={(e) => setIpccDefaultSubstitutionReason(e.target.value)}
            rows={2}
          />
          {!canSave && (
            <Alert variant="destructive">
              <AlertDescription>A justification is required before this can be saved.</AlertDescription>
            </Alert>
          )}
        </div>
      )}
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
        {save.isPending ? "Saving..." : "Save data quality"}
      </Button>
    </div>
  );
}

function MethaneReportTab({ facilityId, reportingBoundaryId }: { facilityId: number; reportingBoundaryId: number }) {
  const { toast } = useToast();
  const query = useQuery<{ methaneReport: MethaneReport | null }>({
    queryKey: [`/api/methane-reports?facilityId=${facilityId}&reportingBoundaryId=${reportingBoundaryId}`],
  });
  const existing = query.data?.methaneReport ?? null;

  const [methaneSourcesDescription, setMethaneSourcesDescription] = useState(existing?.methaneSourcesDescription ?? "");
  const [quantificationMethod, setQuantificationMethod] = useState(existing?.quantificationMethod ?? "");
  const [annualMethaneEmissions, setAnnualMethaneEmissions] = useState(existing?.annualMethaneEmissions ?? "");
  const [annualMethaneEmissionsUnit, setAnnualMethaneEmissionsUnit] = useState(existing?.annualMethaneEmissionsUnit ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/methane-reports", {
        facilityId,
        reportingBoundaryId,
        methaneSourcesDescription: methaneSourcesDescription || undefined,
        quantificationMethod: quantificationMethod || undefined,
        annualMethaneEmissions: annualMethaneEmissions || undefined,
        annualMethaneEmissionsUnit: annualMethaneEmissionsUnit || undefined,
        notes: notes || undefined,
      });
      return res.json();
    },
    onSuccess: () => toast({ title: "Methane report saved" }),
    onError: (err) => toast({ title: "Could not save", description: err.message, variant: "destructive" }),
  });

  if (query.isLoading) return <div className="text-sm text-neutral-500">Loading...</div>;

  return (
    <div className="space-y-3">
      <Textarea
        placeholder="Methane sources description"
        value={methaneSourcesDescription}
        onChange={(e) => setMethaneSourcesDescription(e.target.value)}
        rows={2}
      />
      <Input
        placeholder="Quantification method"
        value={quantificationMethod}
        onChange={(e) => setQuantificationMethod(e.target.value)}
      />
      <div className="flex gap-2">
        <Input
          placeholder="Annual methane emissions"
          value={annualMethaneEmissions}
          onChange={(e) => setAnnualMethaneEmissions(e.target.value)}
        />
        <Input
          placeholder="Unit"
          value={annualMethaneEmissionsUnit}
          onChange={(e) => setAnnualMethaneEmissionsUnit(e.target.value)}
        />
      </div>
      <Textarea placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save methane report"}
      </Button>
    </div>
  );
}

function VerificationFindingsTab({ reportingBoundaryId }: { reportingBoundaryId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery<{ findings: VerificationFinding[] }>({
    queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/verification-findings`],
  });
  const findings = query.data?.findings ?? [];

  const [findingType, setFindingType] = useState("observation");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<string>("");
  const [status, setStatus] = useState("open");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/verification-findings`] });

  const create = useMutation({
    mutationFn: async () => {
      // Response envelope key `{ finding }` for this create route was
      // grep-confirmed against server/routes.ts this pass (matches the
      // established singular-camelCase convention; list route is `{ findings }`).
      const res = await apiRequest("POST", `/api/reporting-boundaries/${reportingBoundaryId}/verification-findings`, {
        findingType,
        description,
        severity: severity || undefined,
        status,
      });
      return res.json();
    },
    onSuccess: () => {
      setDescription("");
      setSeverity("");
      invalidate();
      toast({ title: "Finding recorded" });
    },
    onError: (err) => toast({ title: "Could not add finding", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/verification-findings/${id}`);
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Finding removed" });
    },
    onError: (err) => toast({ title: "Could not remove finding", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      {query.isLoading && <div className="text-sm text-neutral-500">Loading...</div>}
      {!query.isLoading && findings.length === 0 && <p className="text-sm text-neutral-500">No findings recorded.</p>}
      <div className="space-y-2">
        {findings.map((f) => (
          <div key={f.id} className="flex items-start justify-between border-b border-neutral-100 pb-2 text-sm">
            <div>
              <div className="font-medium capitalize">
                {f.findingType.replace("_", " ")} \u00b7 <span className="capitalize">{f.status.replace("_", " ")}</span>
              </div>
              <div>{f.description}</div>
              {f.severity && <div className="text-neutral-500 capitalize">Severity: {f.severity}</div>}
            </div>
            <Button variant="ghost" size="sm" onClick={() => remove.mutate(f.id)}>
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="border-t border-neutral-100 pt-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Select value={findingType} onValueChange={setFindingType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="data_gap">Data gap</SelectItem>
              <SelectItem value="nonconformity">Nonconformity</SelectItem>
              <SelectItem value="observation">Observation</SelectItem>
              <SelectItem value="recommendation">Recommendation</SelectItem>
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger>
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minor">Minor</SelectItem>
              <SelectItem value="moderate">Moderate</SelectItem>
              <SelectItem value="material">Material</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_progress">In progress</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <Button onClick={() => create.mutate()} disabled={create.isPending || !description}>
          {create.isPending ? "Adding..." : "Add finding"}
        </Button>
      </div>
    </div>
  );
}

function ManagementQaTab({ reportingBoundaryId }: { reportingBoundaryId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery<{ managementQaRecords: ManagementQaRecord[] }>({
    queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/management-qa`],
  });
  const records = query.data?.managementQaRecords ?? [];

  const [qaProcedureDescription, setQaProcedureDescription] = useState("");
  const [responsiblePerson, setResponsiblePerson] = useState("");
  const [reviewFrequency, setReviewFrequency] = useState("");
  const [lastReviewDate, setLastReviewDate] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [`/api/reporting-boundaries/${reportingBoundaryId}/management-qa`] });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/reporting-boundaries/${reportingBoundaryId}/management-qa`, {
        qaProcedureDescription: qaProcedureDescription || undefined,
        responsiblePerson: responsiblePerson || undefined,
        reviewFrequency: reviewFrequency || undefined,
        lastReviewDate: lastReviewDate || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setQaProcedureDescription("");
      setResponsiblePerson("");
      setReviewFrequency("");
      setLastReviewDate("");
      invalidate();
      toast({ title: "QA record added" });
    },
    onError: (err) => toast({ title: "Could not add record", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/management-qa/${id}`);
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "QA record removed" });
    },
    onError: (err) => toast({ title: "Could not remove record", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      {query.isLoading && <div className="text-sm text-neutral-500">Loading...</div>}
      {!query.isLoading && records.length === 0 && <p className="text-sm text-neutral-500">No QA records yet.</p>}
      <div className="space-y-2">
        {records.map((r) => (
          <div key={r.id} className="flex items-start justify-between border-b border-neutral-100 pb-2 text-sm">
            <div>
              <div className="font-medium">{r.qaProcedureDescription || "(no description)"}</div>
              <div className="text-neutral-500">
                {r.responsiblePerson ?? "-"} \u00b7 {r.reviewFrequency ?? "-"}
                {r.lastReviewDate ? ` \u00b7 last reviewed ${r.lastReviewDate}` : ""}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => remove.mutate(r.id)}>
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="border-t border-neutral-100 pt-4 space-y-3">
        <Textarea
          placeholder="QA procedure description"
          value={qaProcedureDescription}
          onChange={(e) => setQaProcedureDescription(e.target.value)}
          rows={2}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input placeholder="Responsible person" value={responsiblePerson} onChange={(e) => setResponsiblePerson(e.target.value)} />
          <Input placeholder="Review frequency" value={reviewFrequency} onChange={(e) => setReviewFrequency(e.target.value)} />
          <Input type="date" value={lastReviewDate} onChange={(e) => setLastReviewDate(e.target.value)} />
        </div>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? "Adding..." : "Add QA record"}
        </Button>
      </div>
    </div>
  );
}
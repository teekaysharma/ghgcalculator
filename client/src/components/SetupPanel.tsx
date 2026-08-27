import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface SetupStatus {
  reportingEntityCount: number;
  facilityCount: number;
  boundaryCount: number;
  readyForCalculation: boolean;
}

interface ReportingEntity {
  id: number;
  name: string;
  legalEntity: string | null;
}

const CONSOLIDATION_APPROACHES = [
  { value: "operational_control", label: "Operational control" },
  { value: "financial_control", label: "Financial control" },
  { value: "equity_share", label: "Equity share" },
];

export default function SetupPanel({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const statusQuery = useQuery<{ setupStatus: SetupStatus }>({
    queryKey: ["/api/setup-status"],
  });
  const entitiesQuery = useQuery<{ reportingEntities: ReportingEntity[] }>({
    queryKey: ["/api/reporting-entities"],
  });

  const invalidateSetup = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/setup-status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/reporting-entities"] });
    queryClient.invalidateQueries({ queryKey: ["/api/facilities"] });
    queryClient.invalidateQueries({ queryKey: ["/api/reporting-boundaries"] });
  };

  // --- form state ---
  const [entityName, setEntityName] = useState("");
  const [legalEntity, setLegalEntity] = useState("");
  const [facilityName, setFacilityName] = useState("");
  const [facilityCountry, setFacilityCountry] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState<string>("");
  const [reportingYear, setReportingYear] = useState<string>(new Date().getFullYear().toString());
  const [consolidationApproach, setConsolidationApproach] = useState<string>("operational_control");

  const createEntity = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/reporting-entities", {
        name: entityName,
        legalEntity: legalEntity || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setEntityName("");
      setLegalEntity("");
      setSelectedEntityId(String(data.reportingEntity.id));
      invalidateSetup();
      toast({ title: "Reporting entity created" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const createFacility = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/facilities", {
        reportingEntityId: Number(selectedEntityId),
        name: facilityName,
        country: facilityCountry || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setFacilityName("");
      setFacilityCountry("");
      invalidateSetup();
      toast({ title: "Facility created" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const createBoundary = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/reporting-boundaries", {
        reportingEntityId: Number(selectedEntityId),
        reportingYear: Number(reportingYear),
        consolidationApproach,
      });
      return res.json();
    },
    onSuccess: () => {
      invalidateSetup();
      toast({ title: "Reporting boundary created" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  if (statusQuery.isLoading) {
    return <div className="text-neutral-500 py-8 text-center">Loading setup status...</div>;
  }

  const status = statusQuery.data?.setupStatus;

  if (status?.readyForCalculation) {
    return <>{children}</>;
  }

  const entities = entitiesQuery.data?.reportingEntities ?? [];

  return (
    <div className="space-y-6">
      <Alert>
        <AlertDescription>
          ISO 14064-1 requires a defined organizational and reporting boundary before quantification. Complete the
          three steps below once, they only need to be set up per reporting year.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className={status && status.reportingEntityCount > 0 ? "text-green-600" : ""}>1.</span>
            Reporting entity
          </CardTitle>
          <CardDescription>The company or client this GHG inventory is being reported for.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {entities.length > 0 && (
            <div className="text-sm text-neutral-600">
              Existing: {entities.map((e) => e.name).join(", ")}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="Entity name" value={entityName} onChange={(e) => setEntityName(e.target.value)} className="max-w-xs" />
            <Input placeholder="Legal entity (optional)" value={legalEntity} onChange={(e) => setLegalEntity(e.target.value)} className="max-w-xs" />
            <Button onClick={() => createEntity.mutate()} disabled={!entityName || createEntity.isPending}>
              {createEntity.isPending ? "Adding..." : "Add reporting entity"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className={entities.length === 0 ? "opacity-50 pointer-events-none" : ""}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className={status && status.facilityCount > 0 ? "text-green-600" : ""}>2.</span>
            Facility
          </CardTitle>
          <CardDescription>At least one physical or operational facility under the reporting entity.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={selectedEntityId} onValueChange={setSelectedEntityId}>
            <SelectTrigger className="max-w-xs">
              <SelectValue placeholder="Select reporting entity" />
            </SelectTrigger>
            <SelectContent>
              {entities.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="Facility name" value={facilityName} onChange={(e) => setFacilityName(e.target.value)} className="max-w-xs" />
            <Input placeholder="Country (optional)" value={facilityCountry} onChange={(e) => setFacilityCountry(e.target.value)} className="max-w-xs" />
            <Button
              onClick={() => createFacility.mutate()}
              disabled={!facilityName || !selectedEntityId || createFacility.isPending}
            >
              {createFacility.isPending ? "Adding..." : "Add facility"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className={entities.length === 0 ? "opacity-50 pointer-events-none" : ""}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className={status && status.boundaryCount > 0 ? "text-green-600" : ""}>3.</span>
            Reporting boundary
          </CardTitle>
          <CardDescription>Consolidation approach and reporting year for this inventory.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 flex-wrap items-center">
            <Select value={selectedEntityId} onValueChange={setSelectedEntityId}>
              <SelectTrigger className="max-w-xs">
                <SelectValue placeholder="Select reporting entity" />
              </SelectTrigger>
              <SelectContent>
                {entities.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              placeholder="Year"
              value={reportingYear}
              onChange={(e) => setReportingYear(e.target.value)}
              className="max-w-[100px]"
            />
            <Select value={consolidationApproach} onValueChange={setConsolidationApproach}>
              <SelectTrigger className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONSOLIDATION_APPROACHES.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => createBoundary.mutate()}
              disabled={!selectedEntityId || !reportingYear || createBoundary.isPending}
            >
              {createBoundary.isPending ? "Adding..." : "Add reporting boundary"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

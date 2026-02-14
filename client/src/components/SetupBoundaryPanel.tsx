import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface Organization {
  id: number;
  name: string;
}

interface Facility {
  id: number;
  organizationId: number;
  name: string;
}

interface SetupStatusResponse {
  setupStatus: {
    organizationCount: number;
    facilityCount: number;
    boundaryCount: number;
    readyForCalculation: boolean;
  };
}

const consolidationOptions = [
  { value: "operational_control", label: "Operational control" },
  { value: "financial_control", label: "Financial control" },
  { value: "equity_share", label: "Equity share" },
] as const;

export default function SetupBoundaryPanel() {
  const { toast } = useToast();

  const [organizationName, setOrganizationName] = useState("");
  const [facilityName, setFacilityName] = useState("");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string>("");
  const [reportingYear, setReportingYear] = useState<string>(String(new Date().getFullYear()));
  const [consolidationApproach, setConsolidationApproach] = useState<string>("operational_control");

  const statusQuery = useQuery<SetupStatusResponse>({ queryKey: ["/api/setup-status"] });
  const organizationsQuery = useQuery<{ organizations: Organization[] }>({ queryKey: ["/api/organizations"] });
  const facilitiesQuery = useQuery<{ facilities: Facility[] }>({ queryKey: ["/api/facilities"] });

  const organizations = organizationsQuery.data?.organizations || [];
  const facilities = facilitiesQuery.data?.facilities || [];

  const selectedOrganizationFacilities = useMemo(
    () => facilities.filter((facility) => String(facility.organizationId) === selectedOrganizationId),
    [facilities, selectedOrganizationId],
  );

  const invalidateSetupQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["/api/setup-status"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/organizations"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/facilities"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/reporting-boundaries"] }),
    ]);
  };

  const createOrganization = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/organizations", { name: organizationName.trim() });
      return response.json();
    },
    onSuccess: async () => {
      setOrganizationName("");
      await invalidateSetupQueries();
      toast({ title: "Organization created", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Create organization failed", description: error.message, variant: "destructive" }),
  });

  const createFacility = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/facilities", {
        organizationId: Number(selectedOrganizationId),
        name: facilityName.trim(),
      });
      return response.json();
    },
    onSuccess: async () => {
      setFacilityName("");
      await invalidateSetupQueries();
      toast({ title: "Facility created", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Create facility failed", description: error.message, variant: "destructive" }),
  });

  const createBoundary = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/reporting-boundaries", {
        organizationId: Number(selectedOrganizationId),
        reportingYear: Number(reportingYear),
        consolidationApproach,
      });
      return response.json();
    },
    onSuccess: async () => {
      await invalidateSetupQueries();
      toast({ title: "Reporting boundary configured", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Create boundary failed", description: error.message, variant: "destructive" }),
  });

  const setupReady = statusQuery.data?.setupStatus.readyForCalculation ?? false;

  return (
    <Card className="bg-white border-emerald-100">
      <CardContent className="pt-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Phase 1 Setup: Organization, Facility, Boundary</h3>
          <p className="text-sm text-slate-600">
            Emissions calculation is gated until at least one organization, one facility, and one reporting boundary exist.
          </p>
          <p className={`mt-1 text-xs font-medium ${setupReady ? "text-emerald-700" : "text-amber-700"}`}>
            Status: {setupReady ? "Ready for calculation" : "Setup incomplete"}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="org-name">Organization</Label>
            <Input
              id="org-name"
              placeholder="e.g., Acme Group"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => createOrganization.mutate()}
              disabled={!organizationName.trim() || createOrganization.isPending}
            >
              Add organization
            </Button>
          </div>

          <div className="space-y-2">
            <Label>Use organization</Label>
            <Select value={selectedOrganizationId} onValueChange={setSelectedOrganizationId}>
              <SelectTrigger>
                <SelectValue placeholder="Select organization" />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((org) => (
                  <SelectItem key={org.id} value={String(org.id)}>
                    {org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="Facility name"
              value={facilityName}
              onChange={(e) => setFacilityName(e.target.value)}
              disabled={!selectedOrganizationId}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => createFacility.mutate()}
              disabled={!selectedOrganizationId || !facilityName.trim() || createFacility.isPending}
            >
              Add facility
            </Button>
          </div>

          <div className="space-y-2">
            <Label>Reporting boundary</Label>
            <Input
              placeholder="Year"
              value={reportingYear}
              onChange={(e) => setReportingYear(e.target.value)}
              disabled={!selectedOrganizationId}
            />
            <Select value={consolidationApproach} onValueChange={setConsolidationApproach}>
              <SelectTrigger>
                <SelectValue placeholder="Consolidation approach" />
              </SelectTrigger>
              <SelectContent>
                {consolidationOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              onClick={() => createBoundary.mutate()}
              disabled={!selectedOrganizationId || !reportingYear || createBoundary.isPending}
            >
              Save boundary
            </Button>
          </div>
        </div>

        {selectedOrganizationId && selectedOrganizationFacilities.length > 0 && (
          <p className="text-xs text-slate-500">
            Facilities in selected organization: {selectedOrganizationFacilities.map((f) => f.name).join(", ")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

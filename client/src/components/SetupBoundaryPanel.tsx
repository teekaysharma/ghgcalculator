import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Trash2, Pencil, Check, X } from "lucide-react";

interface Organization {
  id: number;
  name: string;
}

interface Facility {
  id: number;
  organizationId: number;
  name: string;
}

interface ReportingBoundary {
  id: number;
  organizationId: number;
  reportingYear: number;
  consolidationApproach: string;
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

const approachLabel = (value: string) => consolidationOptions.find((option) => option.value === value)?.label || value;

export default function SetupBoundaryPanel() {
  const { toast } = useToast();

  const [organizationName, setOrganizationName] = useState("");
  const [facilityName, setFacilityName] = useState("");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string>("");
  const [reportingYear, setReportingYear] = useState<string>(String(new Date().getFullYear()));
  const [consolidationApproach, setConsolidationApproach] = useState<string>("operational_control");

  const [editingOrganizationName, setEditingOrganizationName] = useState("");
  const [editingFacilityId, setEditingFacilityId] = useState<number | null>(null);
  const [editingFacilityName, setEditingFacilityName] = useState("");
  const [editingBoundaryId, setEditingBoundaryId] = useState<number | null>(null);
  const [editingBoundaryYear, setEditingBoundaryYear] = useState("");
  const [editingBoundaryApproach, setEditingBoundaryApproach] = useState<string>("operational_control");

  const statusQuery = useQuery<SetupStatusResponse>({ queryKey: ["/api/setup-status"] });
  const organizationsQuery = useQuery<{ organizations: Organization[] }>({ queryKey: ["/api/organizations"] });
  const facilitiesQuery = useQuery<{ facilities: Facility[] }>({ queryKey: ["/api/facilities"] });
  const boundariesQuery = useQuery<{ reportingBoundaries: ReportingBoundary[] }>({ queryKey: ["/api/reporting-boundaries"] });

  const organizations = organizationsQuery.data?.organizations || [];
  const facilities = facilitiesQuery.data?.facilities || [];
  const boundaries = boundariesQuery.data?.reportingBoundaries || [];

  const selectedOrganizationFacilities = useMemo(
    () => facilities.filter((facility) => String(facility.organizationId) === selectedOrganizationId),
    [facilities, selectedOrganizationId],
  );

  const selectedOrganizationBoundaries = useMemo(
    () => boundaries.filter((boundary) => String(boundary.organizationId) === selectedOrganizationId),
    [boundaries, selectedOrganizationId],
  );

  const invalidateSetupQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["/api/setup-status"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/organizations"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/facilities"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/reporting-boundaries"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/setup-summary"] }),
    ]);
  };

  const createOrganization = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/organizations", { name: organizationName.trim() });
      return response.json();
    },
    onSuccess: async (payload) => {
      const createdId = payload?.organization?.id;
      if (createdId) {
        setSelectedOrganizationId(String(createdId));
        setEditingOrganizationName(payload.organization.name || "");
      }
      setOrganizationName("");
      await invalidateSetupQueries();
      toast({ title: "Organization created", variant: "default" });
    },
    onError: (error: Error) =>
      toast({ title: "Create organization failed", description: error.message, variant: "destructive" }),
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

  const updateOrganization = useMutation({
    mutationFn: async ({ organizationId, name }: { organizationId: number; name: string }) => {
      const response = await apiRequest("PUT", `/api/organizations/${organizationId}`, { name: name.trim() });
      return response.json();
    },
    onSuccess: async () => {
      await invalidateSetupQueries();
      toast({ title: "Organization updated", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Update organization failed", description: error.message, variant: "destructive" }),
  });

  const updateFacility = useMutation({
    mutationFn: async ({ facilityId, name }: { facilityId: number; name: string }) => {
      const response = await apiRequest("PUT", `/api/facilities/${facilityId}`, { name: name.trim() });
      return response.json();
    },
    onSuccess: async () => {
      setEditingFacilityId(null);
      setEditingFacilityName("");
      await invalidateSetupQueries();
      toast({ title: "Facility updated", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Update facility failed", description: error.message, variant: "destructive" }),
  });

  const updateBoundary = useMutation({
    mutationFn: async ({ boundaryId, year, approach }: { boundaryId: number; year: number; approach: string }) => {
      const response = await apiRequest("PUT", `/api/reporting-boundaries/${boundaryId}`, {
        reportingYear: year,
        consolidationApproach: approach,
      });
      return response.json();
    },
    onSuccess: async () => {
      setEditingBoundaryId(null);
      setEditingBoundaryYear("");
      await invalidateSetupQueries();
      toast({ title: "Boundary updated", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Update boundary failed", description: error.message, variant: "destructive" }),
  });

  const deleteOrganization = useMutation({
    mutationFn: async (organizationId: number) => {
      await apiRequest("DELETE", `/api/organizations/${organizationId}`);
    },
    onSuccess: async () => {
      setSelectedOrganizationId("");
      await invalidateSetupQueries();
      toast({ title: "Organization removed", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Delete organization failed", description: error.message, variant: "destructive" }),
  });

  const deleteFacility = useMutation({
    mutationFn: async (facilityId: number) => {
      await apiRequest("DELETE", `/api/facilities/${facilityId}`);
    },
    onSuccess: async () => {
      await invalidateSetupQueries();
      toast({ title: "Facility removed", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Delete facility failed", description: error.message, variant: "destructive" }),
  });

  const deleteBoundary = useMutation({
    mutationFn: async (boundaryId: number) => {
      await apiRequest("DELETE", `/api/reporting-boundaries/${boundaryId}`);
    },
    onSuccess: async () => {
      await invalidateSetupQueries();
      toast({ title: "Boundary removed", variant: "default" });
    },
    onError: (error: Error) => toast({ title: "Delete boundary failed", description: error.message, variant: "destructive" }),
  });

  const setupReady = statusQuery.data?.setupStatus.readyForCalculation ?? false;
  const selectedOrganization = organizations.find((org) => String(org.id) === selectedOrganizationId);

  const startOrganizationEdit = () => {
    if (!selectedOrganization) return;
    setEditingOrganizationName(selectedOrganization.name);
  };

  return (
    <Card className="border-emerald-100 bg-white">
      <CardContent className="space-y-5 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Phase 1 Setup: Organization, Facility, Boundary</h3>
            <p className="text-sm text-slate-600">
              Emissions calculation is gated until at least one organization, one facility, and one reporting boundary exist.
            </p>
          </div>
          <Badge
            variant="outline"
            className={setupReady ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}
          >
            {setupReady ? "Ready for calculation" : "Setup incomplete"}
          </Badge>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <Label htmlFor="org-name">Organization</Label>
            <Input id="org-name" placeholder="e.g., Acme Group" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
            <Button type="button" size="sm" onClick={() => createOrganization.mutate()} disabled={!organizationName.trim() || createOrganization.isPending}>
              Add organization
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
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
            <Input placeholder="Facility name" value={facilityName} onChange={(e) => setFacilityName(e.target.value)} disabled={!selectedOrganizationId} />
            <Button
              type="button"
              size="sm"
              onClick={() => createFacility.mutate()}
              disabled={!selectedOrganizationId || !facilityName.trim() || createFacility.isPending}
            >
              Add facility
            </Button>
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <Label>Reporting boundary</Label>
            <Input placeholder="Year" value={reportingYear} onChange={(e) => setReportingYear(e.target.value)} disabled={!selectedOrganizationId} />
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

        {selectedOrganizationId ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-700">Organization & Facilities</p>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={startOrganizationEdit}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 border-red-200 text-red-700 hover:bg-red-50"
                    onClick={() => deleteOrganization.mutate(Number(selectedOrganizationId))}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    Remove org
                  </Button>
                </div>
              </div>

              {editingOrganizationName ? (
                <div className="mb-2 flex items-center gap-2">
                  <Input value={editingOrganizationName} onChange={(e) => setEditingOrganizationName(e.target.value)} />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => updateOrganization.mutate({ organizationId: Number(selectedOrganizationId), name: editingOrganizationName })}
                    disabled={!editingOrganizationName.trim()}
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingOrganizationName("")}> 
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <p className="mb-2 text-xs text-slate-600">{selectedOrganization?.name}</p>
              )}

              {selectedOrganizationFacilities.length === 0 ? (
                <p className="text-xs text-slate-500">No facilities yet.</p>
              ) : (
                <div className="space-y-2">
                  {selectedOrganizationFacilities.map((facility) => (
                    <div key={facility.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                      {editingFacilityId === facility.id ? (
                        <div className="flex items-center gap-2">
                          <Input value={editingFacilityName} onChange={(e) => setEditingFacilityName(e.target.value)} className="h-7" />
                          <Button type="button" size="sm" onClick={() => updateFacility.mutate({ facilityId: facility.id, name: editingFacilityName })}>
                            <Check className="h-3 w-3" />
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditingFacilityId(null)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-700">{facility.name}</span>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2"
                              onClick={() => {
                                setEditingFacilityId(facility.id);
                                setEditingFacilityName(facility.name);
                              }}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-red-600 hover:bg-red-50"
                              onClick={() => deleteFacility.mutate(facility.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-sm font-medium text-slate-700">Reporting boundaries</p>
              {selectedOrganizationBoundaries.length === 0 ? (
                <p className="text-xs text-slate-500">No boundaries yet.</p>
              ) : (
                <div className="space-y-2">
                  {selectedOrganizationBoundaries.map((boundary) => (
                    <div key={boundary.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                      {editingBoundaryId === boundary.id ? (
                        <div className="flex items-center gap-2">
                          <Input value={editingBoundaryYear} onChange={(e) => setEditingBoundaryYear(e.target.value)} className="h-7 w-20" />
                          <Select value={editingBoundaryApproach} onValueChange={setEditingBoundaryApproach}>
                            <SelectTrigger className="h-7">
                              <SelectValue />
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
                            onClick={() =>
                              updateBoundary.mutate({ boundaryId: boundary.id, year: Number(editingBoundaryYear), approach: editingBoundaryApproach })
                            }
                            disabled={!editingBoundaryYear.trim()}
                          >
                            <Check className="h-3 w-3" />
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditingBoundaryId(null)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-700">
                            {boundary.reportingYear} · {approachLabel(boundary.consolidationApproach)}
                          </span>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2"
                              onClick={() => {
                                setEditingBoundaryId(boundary.id);
                                setEditingBoundaryYear(String(boundary.reportingYear));
                                setEditingBoundaryApproach(boundary.consolidationApproach);
                              }}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-red-600 hover:bg-red-50"
                              onClick={() => deleteBoundary.mutate(boundary.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Select an organization to review and manage facilities/boundaries.</p>
        )}
      </CardContent>
    </Card>
  );
}

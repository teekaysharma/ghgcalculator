import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import SetupPanel from "@/components/SetupPanel";
import TeamPanel from "@/components/TeamPanel";
import FacilityProfile from "@/components/FacilityProfile";
import BoundaryWorkspace from "@/components/BoundaryWorkspace";
import OrganizationReport from "@/components/OrganizationReport";

// Top-level navigation shell for the whole app. No new wouter routes are added --
// section switching is plain useState, matching the rest of this app (only
// /login, /register, and the protected / route exist).
//
// Response envelope keys used below were confirmed directly against
// server/routes.ts this session (not guessed):
//   GET  /api/reporting-entities     -> { reportingEntities }  (see SetupPanel.tsx, already using this)
//   GET  /api/facilities             -> { facilities }
//   POST /api/facilities             -> { facility }
//   GET  /api/reporting-boundaries   -> { reportingBoundaries }
//   POST /api/reporting-boundaries   -> { boundary }  (singular "boundary", NOT "reportingBoundary" -- confirmed by
//                                        reading the route handler's res.json call directly)

type Section = "setup" | "facilities" | "boundary" | "report" | "team";

interface ReportingEntity {
  id: number;
  name: string;
  legalEntity: string | null;
  baseYear: number | null;
  baseYearRationale: string | null;
}

interface Facility {
  id: number;
  reportingEntityId: number;
  name: string;
  country: string | null;
}

interface ReportingBoundary {
  id: number;
  reportingEntityId: number;
  reportingYear: number;
  consolidationApproach: string;
  description: string | null;
  status: string;
  finalizedAt: string | null;
  // numeric columns come back from the API as strings
  revenueAmount: string | null;
  revenueCurrency: string | null;
  fullTimeEquivalentEmployees: string | null;
}

interface SetupStatus {
  reportingEntityCount: number;
  facilityCount: number;
  boundaryCount: number;
  readyForCalculation: boolean;
}

const NAV_ITEMS: { key: Section; label: string; description: string }[] = [
  { key: "setup", label: "Setup", description: "Create the reporting entity, first facility, and reporting boundary this inventory needs, and set each entity's base year." },
  { key: "facilities", label: "Facilities", description: "Manage facilities and their identifiers, contacts, products, and mitigation measures." },
  { key: "boundary", label: "Boundary Workspace", description: "Source streams, methane reporting, verification findings, and management QA for one facility and reporting year." },
  { key: "report", label: "Organization Report", description: "The consolidated, auditable emissions report across every facility for a reporting year." },
  { key: "team", label: "Team", description: "Manage who has access to your organization." },
];

export default function AppShell() {
  const [section, setSection] = useState<Section>("setup");
  const activeItem = NAV_ITEMS.find((i) => i.key === section)!;

  return (
    <div className="flex flex-col md:flex-row gap-6">
      <nav className="md:w-56 shrink-0">
        <div className="flex flex-wrap md:flex-col gap-1 md:gap-0 md:border md:rounded-md md:overflow-hidden">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={`text-left px-3 py-2 md:px-4 md:py-3 text-sm rounded-md md:rounded-none border md:border-0 md:border-b md:last:border-b-0 border-neutral-200 md:border-neutral-100 transition-colors ${
                section === item.key
                  ? "bg-neutral-100 font-medium text-neutral-900 border-neutral-300 md:border-neutral-100"
                  : "text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="flex-1 min-w-0 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800">{activeItem.label}</h2>
          <p className="text-sm text-neutral-500">{activeItem.description}</p>
        </div>

        {section === "setup" && (
          <SetupPanel>
            <SetupCompleteSection onNavigate={setSection} />
          </SetupPanel>
        )}
        {section === "facilities" && <FacilitiesSection onNavigate={setSection} />}
        {section === "boundary" && <BoundaryWorkspaceSection onNavigate={setSection} />}
        {section === "report" && <OrganizationReportSection />}
        {section === "team" && <TeamPanel />}
      </div>
    </div>
  );
}

// What the Setup section shows once SetupPanel's three steps are all done.
// SetupPanel renders its children in place of the wizard at that point; this
// used to be literally `{null}`, leaving the section heading above an empty
// body. It confirms what is configured, and hosts the one reporting-entity
// setting that has no other home (the base year), which is deliberately not
// part of the create wizard: an entity is created before any inventory exists,
// so there is nothing to pick a base year against yet.
function SetupCompleteSection({ onNavigate }: { onNavigate: (section: Section) => void }) {
  const statusQuery = useQuery<{ setupStatus: SetupStatus }>({ queryKey: ["/api/setup-status"] });
  const entitiesQuery = useQuery<{ reportingEntities: ReportingEntity[] }>({ queryKey: ["/api/reporting-entities"] });

  const status = statusQuery.data?.setupStatus;
  const entities = entitiesQuery.data?.reportingEntities ?? [];

  return (
    <div className="space-y-6">
      <Card className="border-green-200 bg-green-50">
        <CardHeader>
          <CardTitle className="text-base text-green-900">Setup complete</CardTitle>
          <CardDescription className="text-green-800">
            Your organizational and reporting boundaries are defined, so quantification can proceed (ISO 14064-1
            requires both before any inventory is calculated).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-4 max-w-md">
            <SetupStat label="Reporting entities" value={status?.reportingEntityCount ?? entities.length} />
            <SetupStat label="Facilities" value={status?.facilityCount ?? 0} />
            <SetupStat label="Reporting years" value={status?.boundaryCount ?? 0} />
          </div>
          {entities.length > 0 && (
            <p className="text-sm text-green-900">
              Reporting for {entities.map((e) => e.name).join(", ")}.
            </p>
          )}
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" onClick={() => onNavigate("facilities")}>
              Go to Facilities
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("boundary")}>
              Enter activity data
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("report")}>
              View the report
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reporting entity settings</CardTitle>
          <CardDescription>
            The base year each entity's emissions are tracked against, and the rationale for choosing it (GHG Protocol
            Corporate Standard Ch.5 / ISO 14064-1 5.3).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {entitiesQuery.isLoading && <p className="text-sm text-neutral-500">Loading...</p>}
          {entities.map((entity) => (
            <ReportingEntitySettings key={entity.id} entity={entity} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function SetupStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-2xl font-semibold text-green-900">{value}</div>
      <div className="text-xs text-green-800">{label}</div>
    </div>
  );
}

// Base year + rationale for one reporting entity. The server requires a
// rationale whenever a base year is set, and restricts a base-year CHANGE to
// an owner/admin role (it's a governed policy decision, not a number-moving
// edit, so it isn't gated by any reporting boundary's finalize lock) -- both
// surface here as the mutation's error toast rather than being duplicated as
// client-side rules.
function ReportingEntitySettings({ entity }: { entity: ReportingEntity }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const currentYear = new Date().getFullYear();

  const [baseYear, setBaseYear] = useState(entity.baseYear ? String(entity.baseYear) : "");
  const [rationale, setRationale] = useState(entity.baseYearRationale ?? "");

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/reporting-entities/${entity.id}`, {
        // The route is a full replace, so name/legalEntity are re-sent
        // unchanged; only the base-year pair is edited here.
        name: entity.name,
        legalEntity: entity.legalEntity ?? undefined,
        baseYear: baseYear.trim() === "" ? null : Number(baseYear),
        baseYearRationale: rationale.trim() === "" ? null : rationale.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reporting-entities"] });
      toast({ title: "Base year saved" });
    },
    onError: (err) => toast({ title: "Could not save base year", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3 border-t border-neutral-100 pt-4 first:border-t-0 first:pt-0">
      <div className="text-sm font-medium">{entity.name}</div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-neutral-500">Base year</Label>
          <Input
            type="number"
            min={1990}
            max={currentYear}
            placeholder="e.g. 2022"
            value={baseYear}
            onChange={(e) => setBaseYear(e.target.value)}
          />
        </div>
        <div className="space-y-1 md:col-span-3">
          <Label className="text-xs text-neutral-500">Base year rationale</Label>
          <Input
            placeholder="Why this year was chosen, or why it was recalculated"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-neutral-500">
        The report compares each reporting year against the base year automatically, using the boundary already
        recorded for that year. Setting a base year with no reporting boundary behind it simply shows no comparison.
      </p>
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save base year"}
      </Button>
    </div>
  );
}

function FacilitiesSection({ onNavigate }: { onNavigate: (section: Section) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const entitiesQuery = useQuery<{ reportingEntities: ReportingEntity[] }>({ queryKey: ["/api/reporting-entities"] });
  const facilitiesQuery = useQuery<{ facilities: Facility[] }>({ queryKey: ["/api/facilities"] });

  const entities = entitiesQuery.data?.reportingEntities ?? [];
  const facilities = facilitiesQuery.data?.facilities ?? [];

  const [selectedFacilityId, setSelectedFacilityId] = useState<number | null>(null);
  const [newFacilityEntityId, setNewFacilityEntityId] = useState("");
  const [newFacilityName, setNewFacilityName] = useState("");
  const [newFacilityCountry, setNewFacilityCountry] = useState("");

  const createFacility = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/facilities", {
        reportingEntityId: Number(newFacilityEntityId),
        name: newFacilityName,
        country: newFacilityCountry || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setNewFacilityName("");
      setNewFacilityCountry("");
      queryClient.invalidateQueries({ queryKey: ["/api/facilities"] });
      toast({ title: "Facility created" });
      if (data?.facility?.id) setSelectedFacilityId(data.facility.id);
    },
    onError: (err) => toast({ title: "Could not create facility", description: err.message, variant: "destructive" }),
  });

  const entityName = (id: number) => entities.find((e) => e.id === id)?.name ?? "Unknown entity";

  if (entitiesQuery.isLoading || facilitiesQuery.isLoading) {
    return <div className="text-sm text-neutral-500 py-8 text-center">Loading facilities...</div>;
  }

  if (entities.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No reporting entity yet</CardTitle>
          <CardDescription>
            A facility always belongs to a reporting entity. Set one up first, then come back here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => onNavigate("setup")}>Go to Setup</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your facilities</CardTitle>
          <CardDescription>Select a facility below to view and edit its profile.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {facilities.length === 0 && (
            <p className="text-sm text-neutral-500">No facilities yet. Add one below to get started.</p>
          )}
          {facilities.length > 0 && (
            <div className="border rounded-md divide-y divide-neutral-100">
              {facilities.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedFacilityId(f.id)}
                  className={`w-full text-left px-4 py-3 text-sm flex items-center justify-between transition-colors ${
                    selectedFacilityId === f.id ? "bg-neutral-100" : "hover:bg-neutral-50"
                  }`}
                >
                  <span>
                    <span className="font-medium">{f.name}</span>
                    <span className="text-neutral-500 ml-2">{entityName(f.reportingEntityId)}</span>
                    {f.country && <span className="text-neutral-400 ml-2">&middot; {f.country}</span>}
                  </span>
                  <span className="text-xs text-neutral-400">
                    {selectedFacilityId === f.id ? "Viewing" : "View profile"}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-neutral-100 pt-4 space-y-3">
            <Label className="text-sm font-medium">Add a facility</Label>
            <div className="flex gap-2 flex-wrap">
              <Select value={newFacilityEntityId} onValueChange={setNewFacilityEntityId}>
                <SelectTrigger className="max-w-xs">
                  <SelectValue placeholder="Reporting entity" />
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
                placeholder="Facility name"
                value={newFacilityName}
                onChange={(e) => setNewFacilityName(e.target.value)}
                className="max-w-xs"
              />
              <Input
                placeholder="Country (optional)"
                value={newFacilityCountry}
                onChange={(e) => setNewFacilityCountry(e.target.value)}
                className="max-w-xs"
              />
              <Button
                onClick={() => createFacility.mutate()}
                disabled={!newFacilityEntityId || !newFacilityName || createFacility.isPending}
              >
                {createFacility.isPending ? "Adding..." : "Add facility"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedFacilityId && <FacilityProfile facilityId={selectedFacilityId} />}
    </div>
  );
}

function BoundaryWorkspaceSection({ onNavigate }: { onNavigate: (section: Section) => void }) {
  const entitiesQuery = useQuery<{ reportingEntities: ReportingEntity[] }>({ queryKey: ["/api/reporting-entities"] });
  const boundariesQuery = useQuery<{ reportingBoundaries: ReportingBoundary[] }>({ queryKey: ["/api/reporting-boundaries"] });
  const facilitiesQuery = useQuery<{ facilities: Facility[] }>({ queryKey: ["/api/facilities"] });

  const entities = entitiesQuery.data?.reportingEntities ?? [];
  const boundaries = boundariesQuery.data?.reportingBoundaries ?? [];
  const facilities = facilitiesQuery.data?.facilities ?? [];

  const [selectedEntityId, setSelectedEntityId] = useState<string>("");
  const [selectedBoundaryId, setSelectedBoundaryId] = useState<string>("");
  const [selectedFacilityId, setSelectedFacilityId] = useState<string>("");

  const boundariesForEntity = boundaries.filter((b) => String(b.reportingEntityId) === selectedEntityId);
  const facilitiesForEntity = facilities.filter((f) => String(f.reportingEntityId) === selectedEntityId);
  const selectedBoundary = boundaries.find((b) => String(b.id) === selectedBoundaryId);

  const isLoading = entitiesQuery.isLoading || boundariesQuery.isLoading || facilitiesQuery.isLoading;

  if (isLoading) {
    return <div className="text-sm text-neutral-500 py-8 text-center">Loading...</div>;
  }

  if (entities.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No reporting entity yet</CardTitle>
          <CardDescription>
            The boundary workspace is scoped to one facility within one reporting entity's reporting year. Set up a
            reporting entity first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => onNavigate("setup")}>Go to Setup</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open a facility's reporting year</CardTitle>
          <CardDescription>
            Pick a reporting entity, then a reporting year, then a facility. All three are required before the
            workspace below can open.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-neutral-500">1. Reporting entity</Label>
              <Select
                value={selectedEntityId}
                onValueChange={(v) => {
                  setSelectedEntityId(v);
                  setSelectedBoundaryId("");
                  setSelectedFacilityId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select entity" />
                </SelectTrigger>
                <SelectContent>
                  {entities.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-neutral-500">2. Reporting year</Label>
              <Select value={selectedBoundaryId} onValueChange={setSelectedBoundaryId} disabled={!selectedEntityId}>
                <SelectTrigger>
                  <SelectValue placeholder={selectedEntityId ? "Select year" : "Pick an entity first"} />
                </SelectTrigger>
                <SelectContent>
                  {boundariesForEntity.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.reportingYear} &middot; {b.consolidationApproach.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-neutral-500">3. Facility</Label>
              <Select value={selectedFacilityId} onValueChange={setSelectedFacilityId} disabled={!selectedEntityId}>
                <SelectTrigger>
                  <SelectValue placeholder={selectedEntityId ? "Select facility" : "Pick an entity first"} />
                </SelectTrigger>
                <SelectContent>
                  {facilitiesForEntity.map((f) => (
                    <SelectItem key={f.id} value={String(f.id)}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {selectedEntityId && boundariesForEntity.length === 0 && (
            <p className="text-xs text-neutral-500">
              This entity has no reporting boundaries yet. Add one in the Setup section.
            </p>
          )}
          {selectedEntityId && facilitiesForEntity.length === 0 && (
            <p className="text-xs text-neutral-500">
              This entity has no facilities yet. Add one in the Facilities section.
            </p>
          )}
        </CardContent>
      </Card>

      {selectedBoundaryId && selectedFacilityId && selectedBoundary ? (
        <BoundaryWorkspace
          key={`${selectedFacilityId}-${selectedBoundaryId}`}
          facilityId={Number(selectedFacilityId)}
          reportingBoundaryId={Number(selectedBoundaryId)}
          reportingBoundary={selectedBoundary}
        />
      ) : (
        <p className="text-sm text-neutral-500 text-center py-6 border border-dashed rounded-md">
          Select a reporting entity, year, and facility above to open the boundary workspace.
        </p>
      )}
    </div>
  );
}

function OrganizationReportSection() {
  const boundariesQuery = useQuery<{ reportingBoundaries: ReportingBoundary[] }>({ queryKey: ["/api/reporting-boundaries"] });
  const boundaries = boundariesQuery.data?.reportingBoundaries ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);

  if (boundariesQuery.isLoading) return <div className="text-sm text-neutral-500 py-8 text-center">Loading...</div>;
  if (boundaries.length === 0) {
    return <p className="text-sm text-neutral-500">No reporting boundaries yet. Create one in Boundary Workspace first.</p>;
  }

  const activeId = selectedId ?? boundaries[0].id;

  return (
    <div className="space-y-4">
      <select
        className="border rounded-md px-3 py-2 text-sm"
        value={activeId}
        onChange={(e) => setSelectedId(Number(e.target.value))}
      >
        {boundaries.map((b) => (
          <option key={b.id} value={b.id}>
            Reporting year {b.reportingYear} ({b.consolidationApproach})
          </option>
        ))}
      </select>
      <OrganizationReport reportingBoundaryId={activeId} />
    </div>
  );
}
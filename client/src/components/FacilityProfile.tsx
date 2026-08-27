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
import { useToast } from "@/hooks/use-toast";

// Route paths below were confirmed by reading server/routes.ts directly this
// session (not guessed): facility identifier is a GET/PUT upsert at
// /api/facilities/:facilityId/identifier, contacts and products are GET/POST lists
// at /api/facilities/:facilityId/{contacts,products} with PUT/DELETE by id at
// /api/facility-contacts/:id and /api/facility-products/:id, mitigation measures
// follow the same list/PUT/DELETE split. Reference lists are
// /api/reference/primary-activity-types and /api/reference/product-benchmarks.
// Response envelope keys were individually grep-confirmed against the route
// handlers this pass. Note the facility-scoped routes do NOT follow the
// sourceStream/sourceStreams-style prefixed convention used elsewhere in this
// app: they return generic unprefixed keys instead --
// { identifier } (GET/PUT identifier), { contacts } / { contact } (list/create),
// { products } / { product } (list/create), { measures } / { measure }
// (list/create for mitigation measures). Reference lists DO use the prefixed
// form: { primaryActivityTypes }, { productBenchmarks }.

// The facility's own row (as opposed to its identifier/contact/product
// children). AppShell already holds this list, so the query below is a cache
// hit in practice; it is re-declared here so the tab is self-contained.
interface Facility {
  id: number;
  reportingEntityId: number;
  name: string;
  country: string | null;
  equityShareOwnershipPercent: string | null;
}

interface FacilityIdentifier {
  id: number;
  facilityId: number;
  groupParentEntity: string | null;
  economicLicenceNumber: string | null;
  environmentalPermitNumber: string | null;
  address: string | null;
  coordinatesLat: string | null;
  coordinatesLng: string | null;
  primaryBusinessSector: string | null;
  primaryActivity: string | null;
  primaryActivityTypeId: number | null;
  isicDivisionId: number | null;
  activityDescription: string | null;
}

interface FacilityContact {
  id: number;
  contactType: string;
  title: string | null;
  firstName: string | null;
  surname: string | null;
  jobTitle: string | null;
  organisationName: string | null;
  phone: string | null;
  email: string | null;
}

interface FacilityProduct {
  id: number;
  productCode: string | null;
  productCategory: string | null;
  productBenchmarkId: number | null;
  productionTechnology: string | null;
  energyRelatedEmissions: boolean | null;
  processEmissions: boolean | null;
  productionCapacity: string | null;
  productionCapacityUnit: string | null;
  actualProduction: string | null;
  actualProductionUnit: string | null;
}

interface MitigationMeasure {
  id: number;
  measureDescription: string;
  status: string;
  estimatedReductionTco2e: string | null;
  targetDate: string | null;
  notes: string | null;
}

interface ReferenceRow {
  id: number;
  name: string;
}

interface IsicDivision {
  id: number;
  sectionCode: string;
  sectionName: string;
  divisionCode: string;
  divisionName: string;
}

export default function FacilityProfile({ facilityId }: { facilityId: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Facility profile</CardTitle>
        <CardDescription>Identifiers, contacts, products, and mitigation measures for this facility.</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="details" className="space-y-4">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="identifiers">Identifiers</TabsTrigger>
            <TabsTrigger value="contacts">Contacts</TabsTrigger>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="mitigation">Mitigation Measures</TabsTrigger>
          </TabsList>
          <TabsContent value="details">
            <DetailsTab facilityId={facilityId} />
          </TabsContent>
          <TabsContent value="identifiers">
            <IdentifiersTab facilityId={facilityId} />
          </TabsContent>
          <TabsContent value="contacts">
            <ContactsTab facilityId={facilityId} />
          </TabsContent>
          <TabsContent value="products">
            <ProductsTab facilityId={facilityId} />
          </TabsContent>
          <TabsContent value="mitigation">
            <MitigationTab facilityId={facilityId} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// The facility record itself: name, country, and the equity share ownership %
// that equity_share consolidation multiplies this facility's emissions by.
// Before this tab existed the column had no way in at all -- it could only be
// read back, via the consolidated report's "Equity share % not set" warning.
function DetailsTab({ facilityId }: { facilityId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const facilitiesQuery = useQuery<{ facilities: Facility[] }>({ queryKey: ["/api/facilities"] });
  const facility = facilitiesQuery.data?.facilities.find((f) => f.id === facilityId) ?? null;

  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [equityShare, setEquityShare] = useState("");
  const [hydrated, setHydrated] = useState(false);

  // One-time hydrate from the server row, matching IdentifiersTab's pattern
  // above. The parent remounts this component per facility (the Facilities
  // list keys on the selected id), so a single latch is enough.
  if (facility && !hydrated) {
    setName(facility.name);
    setCountry(facility.country ?? "");
    setEquityShare(facility.equityShareOwnershipPercent ?? "");
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/facilities/${facilityId}`, {
        name: name.trim(),
        country: country.trim() || undefined,
        // null, not undefined: an emptied box means "no ownership % recorded",
        // which the server must persist as NULL rather than skip over.
        equityShareOwnershipPercent: equityShare.trim() === "" ? null : Number(equityShare),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/facilities"] });
      toast({ title: "Facility details saved" });
    },
    onError: (err) => toast({ title: "Could not save", description: err.message, variant: "destructive" }),
  });

  if (facilitiesQuery.isLoading) {
    return <div className="text-sm text-neutral-500 py-4">Loading...</div>;
  }
  if (!facility) {
    return <div className="text-sm text-neutral-500 py-4">Facility not found.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Facility name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Country</Label>
          <Input value={country} onChange={(e) => setCountry(e.target.value)} />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label>Equity share ownership (%)</Label>
          <Input
            type="number"
            min={0}
            max={100}
            step="0.01"
            placeholder="e.g. 51"
            value={equityShare}
            onChange={(e) => setEquityShare(e.target.value)}
            className="max-w-xs"
          />
          <p className="text-xs text-neutral-500">
            Only used when the reporting boundary's consolidation approach is <strong>equity share</strong> — under
            operational or financial control this facility is consolidated at 100% and this figure is ignored. Leave
            blank if not applicable; under equity share a blank excludes the facility from the consolidated totals.
          </p>
        </div>
      </div>
      <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
        {save.isPending ? "Saving..." : "Save details"}
      </Button>
    </div>
  );
}

function IdentifiersTab({ facilityId }: { facilityId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const identifierQuery = useQuery<{ identifier: FacilityIdentifier | null }>({
    queryKey: [`/api/facilities/${facilityId}/identifier`],
  });
  const activityTypesQuery = useQuery<{ primaryActivityTypes: ReferenceRow[] }>({
    queryKey: ["/api/reference/primary-activity-types"],
  });
  const isicDivisionsQuery = useQuery<{ isicDivisions: IsicDivision[] }>({
    queryKey: ["/api/reference/isic-divisions"],
  });

  const existing = identifierQuery.data?.identifier ?? null;
  const activityTypes = activityTypesQuery.data?.primaryActivityTypes ?? [];
  const isicDivisions = isicDivisionsQuery.data?.isicDivisions ?? [];

  const [groupParentEntity, setGroupParentEntity] = useState("");
  const [economicLicenceNumber, setEconomicLicenceNumber] = useState("");
  const [environmentalPermitNumber, setEnvironmentalPermitNumber] = useState("");
  const [address, setAddress] = useState("");
  const [coordinatesLat, setCoordinatesLat] = useState("");
  const [coordinatesLng, setCoordinatesLng] = useState("");
  const [primaryBusinessSector, setPrimaryBusinessSector] = useState("");
  const [primaryActivityTypeId, setPrimaryActivityTypeId] = useState<string>("");
  const [isicSectionCode, setIsicSectionCode] = useState("");
  const [isicDivisionId, setIsicDivisionId] = useState<string>("");
  const [activityDescription, setActivityDescription] = useState("");
  const [hydrated, setHydrated] = useState(false);

  // Unique sections derived from the division list, sorted by section code, for
  // the first-level picker (~21 options). Divisions available once a section
  // has been chosen, sorted by division code, for the second-level picker.
  const isicSections = Array.from(
    new Map(isicDivisions.map((d) => [d.sectionCode, d.sectionName])).entries(),
  ).sort(([a], [b]) => a.localeCompare(b));
  const isicDivisionsInSection = isicDivisions
    .filter((d) => d.sectionCode === isicSectionCode)
    .sort((a, b) => a.divisionCode.localeCompare(b.divisionCode));

  // Hydration waits for isicDivisions to have loaded before hydrating when the
  // saved identifier actually has an isicDivisionId to resolve (need the list
  // to look up which section that division belongs to); otherwise hydrates
  // immediately like every other field, matching the existing one-time pattern.
  if (existing && !hydrated && (isicDivisions.length > 0 || !existing.isicDivisionId)) {
    setGroupParentEntity(existing.groupParentEntity ?? "");
    setEconomicLicenceNumber(existing.economicLicenceNumber ?? "");
    setEnvironmentalPermitNumber(existing.environmentalPermitNumber ?? "");
    setAddress(existing.address ?? "");
    setCoordinatesLat(existing.coordinatesLat ?? "");
    setCoordinatesLng(existing.coordinatesLng ?? "");
    setPrimaryBusinessSector(existing.primaryBusinessSector ?? "");
    setPrimaryActivityTypeId(existing.primaryActivityTypeId ? String(existing.primaryActivityTypeId) : "");
    setIsicDivisionId(existing.isicDivisionId ? String(existing.isicDivisionId) : "");
    if (existing.isicDivisionId) {
      const match = isicDivisions.find((d) => d.id === existing.isicDivisionId);
      setIsicSectionCode(match?.sectionCode ?? "");
    }
    setActivityDescription(existing.activityDescription ?? "");
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/facilities/${facilityId}/identifier`, {
        groupParentEntity: groupParentEntity || undefined,
        economicLicenceNumber: economicLicenceNumber || undefined,
        environmentalPermitNumber: environmentalPermitNumber || undefined,
        address: address || undefined,
        coordinatesLat: coordinatesLat || undefined,
        coordinatesLng: coordinatesLng || undefined,
        primaryBusinessSector: primaryBusinessSector || undefined,
        primaryActivityTypeId: primaryActivityTypeId ? Number(primaryActivityTypeId) : undefined,
        isicDivisionId: isicDivisionId ? Number(isicDivisionId) : undefined,
        activityDescription: activityDescription || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/facilities/${facilityId}/identifier`] });
      toast({ title: "Facility identifiers saved" });
    },
    onError: (err) => toast({ title: "Could not save", description: err.message, variant: "destructive" }),
  });

  if (identifierQuery.isLoading) {
    return <div className="text-sm text-neutral-500 py-4">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Group / parent entity</Label>
          <Input value={groupParentEntity} onChange={(e) => setGroupParentEntity(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Economic licence number</Label>
          <Input value={economicLicenceNumber} onChange={(e) => setEconomicLicenceNumber(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Environmental permit number</Label>
          <Input value={environmentalPermitNumber} onChange={(e) => setEnvironmentalPermitNumber(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Primary business sector</Label>
          <Input value={primaryBusinessSector} onChange={(e) => setPrimaryBusinessSector(e.target.value)} />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label>Address</Label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Latitude</Label>
          <Input value={coordinatesLat} onChange={(e) => setCoordinatesLat(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Longitude</Label>
          <Input value={coordinatesLng} onChange={(e) => setCoordinatesLng(e.target.value)} />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label>Primary activity</Label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Select
              value={isicSectionCode}
              onValueChange={(v) => {
                setIsicSectionCode(v);
                setIsicDivisionId("");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select ISIC section" />
              </SelectTrigger>
              <SelectContent>
                {isicSections.map(([sectionCode, sectionName]) => (
                  <SelectItem key={sectionCode} value={sectionCode}>
                    {sectionCode} — {sectionName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={isicDivisionId} onValueChange={setIsicDivisionId} disabled={!isicSectionCode}>
              <SelectTrigger>
                <SelectValue placeholder="Select ISIC division" />
              </SelectTrigger>
              <SelectContent>
                {isicDivisionsInSection.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.divisionCode} — {d.divisionName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label>Activity description</Label>
          <Textarea value={activityDescription} onChange={(e) => setActivityDescription(e.target.value)} rows={3} />
        </div>
      </div>
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save identifiers"}
      </Button>
    </div>
  );
}

function ContactsTab({ facilityId }: { facilityId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const contactsQuery = useQuery<{ contacts: FacilityContact[] }>({
    queryKey: [`/api/facilities/${facilityId}/contacts`],
  });
  const contacts = contactsQuery.data?.contacts ?? [];

  const [contactType, setContactType] = useState("primary");
  const [firstName, setFirstName] = useState("");
  const [surname, setSurname] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [organisationName, setOrganisationName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [`/api/facilities/${facilityId}/contacts`] });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/facilities/${facilityId}/contacts`, {
        contactType,
        firstName: firstName || undefined,
        surname: surname || undefined,
        jobTitle: jobTitle || undefined,
        organisationName: organisationName || undefined,
        phone: phone || undefined,
        email: email || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setFirstName("");
      setSurname("");
      setJobTitle("");
      setOrganisationName("");
      setPhone("");
      setEmail("");
      invalidate();
      toast({ title: "Contact added" });
    },
    onError: (err) => toast({ title: "Could not add contact", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/facility-contacts/${id}`);
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Contact removed" });
    },
    onError: (err) => toast({ title: "Could not remove contact", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      {contactsQuery.isLoading && <div className="text-sm text-neutral-500">Loading...</div>}
      {!contactsQuery.isLoading && contacts.length === 0 && (
        <p className="text-sm text-neutral-500">No contacts yet.</p>
      )}
      {contacts.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Job title</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {contacts.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="capitalize">{c.contactType}</TableCell>
                <TableCell>{[c.firstName, c.surname].filter(Boolean).join(" ") || "-"}</TableCell>
                <TableCell>{c.jobTitle ?? "-"}</TableCell>
                <TableCell>{c.email ?? "-"}</TableCell>
                <TableCell>{c.phone ?? "-"}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(c.id)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="border-t border-neutral-100 pt-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Select value={contactType} onValueChange={setContactType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="primary">Primary</SelectItem>
              <SelectItem value="alternative">Alternative</SelectItem>
            </SelectContent>
          </Select>
          <Input placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          <Input placeholder="Surname" value={surname} onChange={(e) => setSurname(e.target.value)} />
          <Input placeholder="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          <Input placeholder="Organisation" value={organisationName} onChange={(e) => setOrganisationName(e.target.value)} />
          <Input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? "Adding..." : "Add contact"}
        </Button>
      </div>
    </div>
  );
}

function ProductsTab({ facilityId }: { facilityId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const productsQuery = useQuery<{ products: FacilityProduct[] }>({
    queryKey: [`/api/facilities/${facilityId}/products`],
  });
  const benchmarksQuery = useQuery<{ productBenchmarks: ReferenceRow[] }>({
    queryKey: ["/api/reference/product-benchmarks"],
  });
  const products = productsQuery.data?.products ?? [];
  const benchmarks = benchmarksQuery.data?.productBenchmarks ?? [];

  const [productCode, setProductCode] = useState("");
  const [productCategory, setProductCategory] = useState("");
  const [productBenchmarkId, setProductBenchmarkId] = useState<string>("");
  const [productionTechnology, setProductionTechnology] = useState("");
  const [energyRelatedEmissions, setEnergyRelatedEmissions] = useState(false);
  const [processEmissions, setProcessEmissions] = useState(false);
  const [productionCapacity, setProductionCapacity] = useState("");
  const [productionCapacityUnit, setProductionCapacityUnit] = useState("");
  const [actualProduction, setActualProduction] = useState("");
  const [actualProductionUnit, setActualProductionUnit] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [`/api/facilities/${facilityId}/products`] });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/facilities/${facilityId}/products`, {
        productCode: productCode || undefined,
        productCategory: productCategory || undefined,
        productBenchmarkId: productBenchmarkId ? Number(productBenchmarkId) : undefined,
        productionTechnology: productionTechnology || undefined,
        energyRelatedEmissions,
        processEmissions,
        productionCapacity: productionCapacity || undefined,
        productionCapacityUnit: productionCapacityUnit || undefined,
        actualProduction: actualProduction || undefined,
        actualProductionUnit: actualProductionUnit || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setProductCode("");
      setProductCategory("");
      setProductBenchmarkId("");
      setProductionTechnology("");
      setEnergyRelatedEmissions(false);
      setProcessEmissions(false);
      setProductionCapacity("");
      setProductionCapacityUnit("");
      setActualProduction("");
      setActualProductionUnit("");
      invalidate();
      toast({ title: "Product added" });
    },
    onError: (err) => toast({ title: "Could not add product", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/facility-products/${id}`);
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Product removed" });
    },
    onError: (err) => toast({ title: "Could not remove product", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      {productsQuery.isLoading && <div className="text-sm text-neutral-500">Loading...</div>}
      {!productsQuery.isLoading && products.length === 0 && (
        <p className="text-sm text-neutral-500">No products yet.</p>
      )}
      {products.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Capacity</TableHead>
              <TableHead>Actual production</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.productCode ?? "-"}</TableCell>
                <TableCell>{p.productCategory ?? "-"}</TableCell>
                <TableCell>
                  {p.productionCapacity ? `${p.productionCapacity} ${p.productionCapacityUnit ?? ""}` : "-"}
                </TableCell>
                <TableCell>
                  {p.actualProduction ? `${p.actualProduction} ${p.actualProductionUnit ?? ""}` : "-"}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(p.id)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="border-t border-neutral-100 pt-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input placeholder="Product code" value={productCode} onChange={(e) => setProductCode(e.target.value)} />
          <Input
            placeholder="Product category (free text)"
            value={productCategory}
            onChange={(e) => setProductCategory(e.target.value)}
          />
          <Select value={productBenchmarkId} onValueChange={setProductBenchmarkId}>
            <SelectTrigger className="md:col-span-2">
              <SelectValue placeholder="Product benchmark (EU-style reference list)" />
            </SelectTrigger>
            <SelectContent>
              {benchmarks.map((b) => (
                <SelectItem key={b.id} value={String(b.id)}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Production technology"
            value={productionTechnology}
            onChange={(e) => setProductionTechnology(e.target.value)}
          />
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={energyRelatedEmissions} onCheckedChange={(v) => setEnergyRelatedEmissions(v === true)} />
              Energy-related emissions
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={processEmissions} onCheckedChange={(v) => setProcessEmissions(v === true)} />
              Process emissions
            </label>
          </div>
          <div className="flex gap-2">
            <Input placeholder="Production capacity" value={productionCapacity} onChange={(e) => setProductionCapacity(e.target.value)} />
            <Input placeholder="Unit" value={productionCapacityUnit} onChange={(e) => setProductionCapacityUnit(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Input placeholder="Actual production" value={actualProduction} onChange={(e) => setActualProduction(e.target.value)} />
            <Input placeholder="Unit" value={actualProductionUnit} onChange={(e) => setActualProductionUnit(e.target.value)} />
          </div>
        </div>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? "Adding..." : "Add product"}
        </Button>
      </div>
    </div>
  );
}

function MitigationTab({ facilityId }: { facilityId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const measuresQuery = useQuery<{ measures: MitigationMeasure[] }>({
    queryKey: [`/api/facilities/${facilityId}/mitigation-measures`],
  });
  const measures = measuresQuery.data?.measures ?? [];

  const [measureDescription, setMeasureDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [estimatedReductionTco2e, setEstimatedReductionTco2e] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [notes, setNotes] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [`/api/facilities/${facilityId}/mitigation-measures`] });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/facilities/${facilityId}/mitigation-measures`, {
        measureDescription,
        status,
        estimatedReductionTco2e: estimatedReductionTco2e || undefined,
        targetDate: targetDate || undefined,
        notes: notes || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setMeasureDescription("");
      setStatus("planned");
      setEstimatedReductionTco2e("");
      setTargetDate("");
      setNotes("");
      invalidate();
      toast({ title: "Mitigation measure added" });
    },
    onError: (err) => toast({ title: "Could not add measure", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/mitigation-measures/${id}`);
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Measure removed" });
    },
    onError: (err) => toast({ title: "Could not remove measure", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      {measuresQuery.isLoading && <div className="text-sm text-neutral-500">Loading...</div>}
      {!measuresQuery.isLoading && measures.length === 0 && (
        <p className="text-sm text-neutral-500">No mitigation measures yet.</p>
      )}
      <div className="space-y-2">
        {measures.map((m) => (
          <div key={m.id} className="flex items-start justify-between border-b border-neutral-100 pb-2 text-sm">
            <div>
              <div className="font-medium">{m.measureDescription}</div>
              <div className="text-neutral-500 capitalize">
                {m.status.replace("_", " ")}
                {m.estimatedReductionTco2e ? ` \u00b7 ${m.estimatedReductionTco2e} tCO2e` : ""}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => remove.mutate(m.id)}>
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="border-t border-neutral-100 pt-4 space-y-3">
        <Textarea
          placeholder="Measure description"
          value={measureDescription}
          onChange={(e) => setMeasureDescription(e.target.value)}
          rows={2}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="planned">Planned</SelectItem>
              <SelectItem value="in_progress">In progress</SelectItem>
              <SelectItem value="implemented">Implemented</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="Estimated reduction (tCO2e)"
            value={estimatedReductionTco2e}
            onChange={(e) => setEstimatedReductionTco2e(e.target.value)}
          />
          <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </div>
        <Textarea placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        <Button onClick={() => create.mutate()} disabled={create.isPending || !measureDescription}>
          {create.isPending ? "Adding..." : "Add measure"}
        </Button>
      </div>
    </div>
  );
}
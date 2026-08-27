import { Button } from "@/components/ui/button";
import { Info, Download, ExternalLink } from "lucide-react";
import { utils, writeFile } from "xlsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Hand-verified against the rendered GHG Protocol PDF pages directly (not
// an automated bulk extraction -- pdfplumber's table-grid detection was
// found to misalign columns on several pages of that document and would
// have silently produced wrong values; see the full 266-gas file linked
// below for the complete hand-verified set with AR4/AR5/AR6 all shown).
// Source: GHG Protocol "IPCC Global Warming Potential Values" v2.0,
// August 7 2024, adapted from IPCC AR6 (2021). GWP-100, no climate-carbon
// feedback -- the basis required by the GHG Protocol, CDP, and SBTi.
const AR6_GWP_100 = [
  { gas: "CO2", gwp: "1", note: "Reference gas" },
  { gas: "CH4 (fossil)", gwp: "29.8", note: "Combustion, fugitive, process sources" },
  { gas: "CH4 (biogenic/non-fossil)", gwp: "27.0", note: "e.g. landfill, agriculture, wastewater" },
  { gas: "N2O", gwp: "273", note: "" },
  { gas: "SF6", gwp: "24,300", note: "Switchgear, electrical insulation" },
  { gas: "NF3", gwp: "17,400", note: "Semiconductor manufacturing" },
  { gas: "HFC-134a", gwp: "1,530", note: "Common refrigerant (R-134a)" },
  { gas: "HFC-32", gwp: "771", note: "Common refrigerant (R-32)" },
  { gas: "HFC-125", gwp: "3,740", note: "Common refrigerant blend component" },
  { gas: "HFC-143a", gwp: "5,810", note: "Common refrigerant blend component" },
];

const FACTOR_SOURCES = [
  {
    name: "UK Government GHG conversion factors (DEFRA/DESNZ)",
    url: "https://www.gov.uk/government/collections/government-conversion-factors-for-company-reporting",
    tier: "National (UK)",
    note: "This project's primary source for UK activity data. Always links to the current reporting year's release.",
  },
  {
    name: "IEA Emissions Factors (electricity grid, by country)",
    url: "https://www.iea.org/data-and-statistics/data-product/emissions-factors-2025",
    tier: "Global, country-specific",
    note: "Use for Scope 2 grid electricity outside the UK, or to cross-check DEFRA's UK grid factor.",
  },
  {
    name: "GHG Protocol: IPCC Global Warming Potential Values (PDF)",
    url: "https://ghgprotocol.org/sites/default/files/2024-08/Global-Warming-Potential-Values%20(August%202024).pdf",
    tier: "Full GWP list (~270 gases)",
    note: "GHG Protocol's own hosted copy of the source PDF this app's 266-gas download (above) is itself verified against.",
  },
  {
    name: "IPCC AR6 WGI Ch.7 Supplementary Material (GWP source table)",
    url: "https://www.ipcc.ch/report/ar6/wg1/downloads/report/IPCC_AR6_WGI_Chapter_07_Supplementary_Material.pdf",
    tier: "Primary source for GWP values",
    note: "Table 7.SM.7. What the GHG Protocol PDF above is itself adapted from.",
  },
];

function downloadTemplate() {
  // Structural template only. Deliberately does NOT include invented
  // emission-factor numbers dressed up as real DEFRA/IEA data -- secondary
  // sources checked while building this gave contradicting figures for
  // the same supposedly-official values, so no unverified number goes in
  // here. Source/Year columns match the persisted emission_factors table
  // (shared/schema.ts) and this project's sourcing-hierarchy requirement:
  // every factor must be traceable to where it came from.
  const rows = [
    { Scope: 1, "Activity Type": "Natural Gas", "Emission Factor": "", Unit: "kWh", Source: "REPLACE - see gov.uk link in this guide", Year: "" },
    { Scope: 1, "Activity Type": "Diesel", "Emission Factor": "", Unit: "litre", Source: "REPLACE - see gov.uk link in this guide", Year: "" },
    { Scope: 2, "Activity Type": "Grid Electricity", "Emission Factor": "", Unit: "kWh", Source: "REPLACE - country-specific, see IEA/gov.uk links", Year: "" },
    { Scope: 3, "Activity Type": "Business Travel - Car", "Emission Factor": "", Unit: "km", Source: "REPLACE - see gov.uk link in this guide", Year: "" },
    { Scope: 3, "Activity Type": "Paper/Cardboard - Landfill", "Emission Factor": "", Unit: "t", Source: "REPLACE - see gov.uk link in this guide", Year: "" },
    { Scope: 3, "Activity Type": "Paper/Cardboard - Recycling", "Emission Factor": "", Unit: "t", Source: "REPLACE - see gov.uk link in this guide", Year: "" },
  ];
  const worksheet = utils.json_to_sheet(rows);
  worksheet["!cols"] = [{ wch: 8 }, { wch: 28 }, { wch: 16 }, { wch: 10 }, { wch: 38 }, { wch: 8 }];
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, worksheet, "Emission Factors");
  writeFile(workbook, "emission-factors-template.xlsx");
}

export default function WasteFactorGuide() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-neutral-600">
          <Info className="h-4 w-4 mr-1" />
          <span>Waste Factor Format Guide</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto pr-2">
        <DialogHeader>
          <DialogTitle>Waste Emission Factors Format Guide</DialogTitle>
          <DialogDescription>
            Learn how to structure your waste emission factors Excel file
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <a href="/emission-factors-template.xlsx" download>
            <Button variant="default" size="sm" className="w-fit">
              <Download className="h-4 w-4 mr-1" />
              Download DEFRA 2026 factors (3,425 rows, .xlsx)
            </Button>
          </a>
          <a href="/gwp-ar6-reference.xlsx" download>
            <Button variant="default" size="sm" className="w-fit">
              <Download className="h-4 w-4 mr-1" />
              Download AR6 GWP reference (266 gases, .xlsx)
            </Button>
          </a>
          <Button onClick={downloadTemplate} variant="outline" size="sm" className="w-fit">
            <Download className="h-4 w-4 mr-1" />
            Download blank template (format only)
          </Button>
        </div>
        <p className="text-xs text-neutral-500">
          The DEFRA file is the real UK Government GHG Conversion Factors for Company Reporting 2026 dataset (Scope
          1/2/3 "kg CO2e" total factors, DESNZ, Open Government Licence v3.0). The GWP file covers CO2, CH4, N2O,
          SF6, NF3, and the complete IPCC AR6 gas list (266 gases: HFCs, PFCs, CFCs, HCFCs, halons, halogenated
          ethers/alcohols) with AR4/AR5/AR6 values side by side, hand-verified
          against the GHG Protocol's official PDF (not bulk-extracted, see the note in that file's Read Me sheet for
          why). Both are reshaped to this calculator's format with Source/Year columns for traceability. DEFRA
          covers UK activities only, replace electricity and other location-specific rows with country-appropriate
          factors for non-UK operations.
        </p>
        
        <div className="space-y-4 mt-4">
          <div className="border rounded-md p-4 bg-green-50 border-green-200">
            <h3 className="font-medium text-neutral-800 mb-2">Where to get real, verified emission factors</h3>
            <p className="text-sm text-neutral-700 mb-3">
              Follow the emission factor sourcing hierarchy: prefer local or national factors over global defaults, and
              always record where each factor came from. The three links below are the primary sources this project
              treats as authoritative.
            </p>
            <ul className="space-y-2 text-sm">
              {FACTOR_SOURCES.map((s) => (
                <li key={s.url} className="border-b border-green-100 pb-2 last:border-0 last:pb-0">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary-700 hover:text-primary-900 underline inline-flex items-center gap-1"
                  >
                    {s.name}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <div className="text-xs text-neutral-600 mt-0.5">
                    <span className="font-medium">{s.tier}.</span> {s.note}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="border rounded-md p-4 bg-neutral-50">
            <h3 className="font-medium text-neutral-800 mb-2">IPCC AR6 GWP-100 values (verified)</h3>
            <p className="text-sm text-neutral-600 mb-3">
              Used to convert non-CO2 gases to CO2e. GWP-100, without climate-carbon cycle feedbacks, the basis
              required by the GHG Protocol, CDP, and SBTi. Quick reference below, common gases only, the full
              266-gas file (download above) has AR4/AR5/AR6 side by side for the complete IPCC AR6 gas list
              (HFCs, PFCs, CFCs, HCFCs, halons, and halogenated ethers/alcohols).
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-neutral-200 border">
                <thead className="bg-neutral-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Gas</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">GWP-100 (AR6)</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500">Note</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-neutral-200">
                  {AR6_GWP_100.map((g) => (
                    <tr key={g.gas}>
                      <td className="px-4 py-2 text-sm text-neutral-800 border-r">{g.gas}</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">{g.gwp}</td>
                      <td className="px-4 py-2 text-sm text-neutral-600">{g.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-sm text-neutral-600">
            The formats below show how to structure your file. The numbers in these example tables are placeholders
            to illustrate layout only, not published emission factors, get real values from the sources above.
          </p>
          
          <div className="space-y-4">
            <div className="border rounded-md p-4 bg-neutral-50">
              <h3 className="font-medium text-neutral-800 mb-2">Format 1: Table with Disposal Methods as Columns</h3>
              <p className="text-sm text-neutral-600 mb-3">
                This format has waste types as rows and disposal methods as columns:
              </p>
              
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-neutral-200 border">
                  <thead className="bg-neutral-100">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Waste Type</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Landfill (kg CO2e/t)</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Incineration (kg CO2e/t)</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Recycling (kg CO2e/t)</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500">Composting (kg CO2e/t)</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-neutral-200">
                    <tr>
                      <td className="px-4 py-2 text-sm text-neutral-800 border-r">Paper/Cardboard</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">2100</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">1200</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">350</td>
                      <td className="px-4 py-2 text-sm text-neutral-600">200</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2 text-sm text-neutral-800 border-r">Plastic</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">3200</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">2500</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">580</td>
                      <td className="px-4 py-2 text-sm text-neutral-600">-</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              
              <p className="text-xs text-neutral-500 mt-2">
                * The column headers must include disposal method names (Landfill, Incineration, Recycling, Composting)
              </p>
            </div>
            
            <div className="border rounded-md p-4 bg-neutral-50">
              <h3 className="font-medium text-neutral-800 mb-2">Format 2: Separate Rows for Each Disposal Method</h3>
              <p className="text-sm text-neutral-600 mb-3">
                This format has separate rows for each waste type + disposal method combination:
              </p>
              
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-neutral-200 border">
                  <thead className="bg-neutral-100">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Waste Type</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Disposal Method</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Emission Factor (kg CO2e/unit)</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500">Unit</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-neutral-200">
                    <tr>
                      <td className="px-4 py-2 text-sm text-neutral-800 border-r">Paper/Cardboard</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">Landfill</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">2100</td>
                      <td className="px-4 py-2 text-sm text-neutral-600">t</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2 text-sm text-neutral-800 border-r">Paper/Cardboard</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">Recycling</td>
                      <td className="px-4 py-2 text-sm text-neutral-600 border-r">350</td>
                      <td className="px-4 py-2 text-sm text-neutral-600">t</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          
          <div className="border rounded-md p-4 bg-neutral-50 mb-4">
            <h3 className="font-medium text-neutral-800 mb-2">Multi-Scope Format with Enhanced Fields</h3>
            <p className="text-sm text-neutral-600 mb-3">
              You can also provide a single Excel file with multiple sheets or scope indicators, supporting various column names:
            </p>
            
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-neutral-200 border">
                <thead className="bg-neutral-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Scope</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Activity Type</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500 border-r">Emission Factor (kg CO2e/unit)</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-neutral-500">Unit</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-neutral-200">
                  <tr>
                    <td className="px-4 py-2 text-sm text-neutral-800 border-r">1</td>
                    <td className="px-4 py-2 text-sm text-neutral-600 border-r">Natural Gas</td>
                    <td className="px-4 py-2 text-sm text-neutral-600 border-r">2.02</td>
                    <td className="px-4 py-2 text-sm text-neutral-600">kg</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-sm text-neutral-800 border-r">2</td>
                    <td className="px-4 py-2 text-sm text-neutral-600 border-r">Electricity</td>
                    <td className="px-4 py-2 text-sm text-neutral-600 border-r">0.42</td>
                    <td className="px-4 py-2 text-sm text-neutral-600">kWh</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 text-sm text-neutral-800 border-r">3</td>
                    <td className="px-4 py-2 text-sm text-neutral-600 border-r">Business Travel</td>
                    <td className="px-4 py-2 text-sm text-neutral-600 border-r">0.14</td>
                    <td className="px-4 py-2 text-sm text-neutral-600">km</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          
          <div className="border rounded-md p-4 bg-neutral-50 mb-4">
            <h3 className="font-medium text-neutral-800 mb-2">Column Name Flexibility</h3>
            <p className="text-sm text-neutral-600 mb-2">
              Our enhanced parser now supports various column naming conventions:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="text-sm font-medium text-neutral-700 mb-1">Activity Columns:</h4>
                <ul className="text-xs text-neutral-600 list-disc list-inside space-y-0.5">
                  <li>Activity Type</li>
                  <li>Activity</li>
                  <li>Description</li>
                  <li>Source</li>
                  <li>Category</li>
                  <li>Emission Source</li>
                  <li>GHG Source</li>
                  <li>And many more...</li>
                </ul>
              </div>
              <div>
                <h4 className="text-sm font-medium text-neutral-700 mb-1">Emission Factor Columns:</h4>
                <ul className="text-xs text-neutral-600 list-disc list-inside space-y-0.5">
                  <li>Emission Factor</li>
                  <li>EF</li>
                  <li>CO2 Equivalent</li>
                  <li>Factor</li>
                  <li>CO2e Factor</li>
                  <li>GHG Emission Factor</li>
                  <li>And many more...</li>
                </ul>
              </div>
            </div>
          </div>
          
          <div className="bg-blue-50 p-4 rounded-md text-sm text-blue-800">
            <p className="font-medium">Tips:</p>
            <ul className="list-disc list-inside mt-1 space-y-1">
              <li>You can organize data by sheet names (e.g., "Scope 1", "Scope 2", "Scope 3")</li>
              <li>Add a "Scope" column with values 1, 2, or 3 to automatically categorize factors</li>
              <li>For Format 1, the column name must include the disposal method (e.g., "Landfill")</li>
              <li>Units in Format 1 are extracted from parentheses in column headers (e.g., "kg CO2e/t")</li>
              <li>The calculator will detect and correctly assign emission factors to the proper scope</li>
              <li>Units are automatically extracted from headers or derived from activity names</li>
              <li>The dropdown menus now show units in parentheses for easier selection</li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
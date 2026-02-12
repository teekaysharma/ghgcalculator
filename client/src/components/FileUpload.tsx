import { useState, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmissionFactor } from "@/types/emissions";
import { Upload, Check, AlertCircle, Calendar, Database } from "lucide-react";
import { read, utils } from "xlsx";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import WasteFactorGuide from "./WasteFactorGuide";

interface FileUploadProps {
  onFactorsUploaded: (factors: Record<string, EmissionFactor>) => void;
}

interface UploadBatch {
  fileName: string;
  source: string;
  years: number[];
  count: number;
}

const YEAR_COLUMNS = ["Year", "Reporting Year", "Factor Year", "Data Year", "Calendar Year"];
const SOURCE_COLUMNS = ["Source", "Dataset", "Publisher", "Program"];
const SCOPE_COLUMNS = ["Scope", "GHG Scope"];
const ACTIVITY_COLUMNS = [
  "Activity Type",
  "Activity",
  "Description",
  "Source",
  "Fuel Type",
  "Energy Source",
  "Transport Mode",
  "Vehicle Type",
  "Material",
  "Category",
  "Subcategory",
  "GHG Source",
  "Emission Source",
  "Activity Name",
  "Type",
  "Source Category",
  "Process",
  "Equipment",
  "Industry",
  "Application",
  "Resource",
  "Fuel",
  "Product",
];
const FACTOR_COLUMNS = [
  "Emission Factor (kg CO2e/unit)",
  "Emission Factor",
  "EF",
  "GHG Emission Factor",
  "CO2 Equivalent",
  "CO2e Factor",
  "CO2 Factor",
  "Factor",
  "kg CO2e/unit",
  "tCO2e",
  "Total GHG",
  "Value",
];
const UNIT_COLUMNS = ["Unit", "Units", "Measurement Unit", "Unit of Measure", "UOM"];
const LEVEL_COLUMNS = ["Level 1", "Level 2", "Level 3", "Level 4", "Column Text"];

const SOURCE_HINTS = ["DEFRA", "CEA", "IEA", "EPA"] as const;

const SCOPE3_CATEGORY_MAP: Record<string, string> = {
  "category 1": "Category 1: Purchased Goods and Services",
  "category 2": "Category 2: Capital Goods",
  "category 3": "Category 3: Fuel- and Energy-Related Activities",
  "category 4": "Category 4: Upstream Transportation and Distribution",
  "category 5": "Category 5: Waste Generated in Operations",
  "category 6": "Category 6: Business Travel",
  "category 7": "Category 7: Employee Commuting",
  "category 8": "Category 8: Upstream Leased Assets",
  "category 9": "Category 9: Downstream Transportation and Distribution",
  "category 10": "Category 10: Processing of Sold Products",
  "category 11": "Category 11: Use of Sold Products",
  "category 12": "Category 12: End-of-Life Treatment of Sold Products",
  "category 13": "Category 13: Downstream Leased Assets",
  "category 14": "Category 14: Franchises",
  "category 15": "Category 15: Investments",
};

const normalizeScope3Category = (value: unknown): string | undefined => {
  if (!value) return undefined;
  const text = String(value).trim();
  const key = text.toLowerCase();
  if (SCOPE3_CATEGORY_MAP[key]) return SCOPE3_CATEGORY_MAP[key];
  const match = key.match(/category\s*(\d{1,2})/);
  if (match) {
    return SCOPE3_CATEGORY_MAP[`category ${match[1]}`] || text;
  }
  return text;
};

const slugify = (value: string) => value.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();

const parseYear = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const match = String(value).match(/(19|20)\d{2}/);
  if (!match) return undefined;
  const year = Number(match[0]);
  return year >= 1990 && year <= 2100 ? year : undefined;
};


const buildHierarchicalActivity = (row: Record<string, unknown>): string | undefined => {
  const dynamicLevelColumns = Object.keys(row)
    .filter((key) => /^Level\s*\d+$/i.test(key))
    .sort((a, b) => {
      const ai = parseInt((a.match(/\d+/) || ["0"])[0], 10);
      const bi = parseInt((b.match(/\d+/) || ["0"])[0], 10);
      return ai - bi;
    });

  const columns = [...dynamicLevelColumns, ...LEVEL_COLUMNS.filter((col) => !dynamicLevelColumns.includes(col))];
  const parts = columns
    .map((col) => row[col])
    .filter((value): value is string | number => value !== undefined && value !== null && String(value).trim() !== "")
    .map((value) => String(value).trim());

  if (parts.length === 0) return undefined;
  return parts.join(" > ");
};

const getEmissionFactorFromRow = (row: Record<string, unknown>): number => {
  for (const col of FACTOR_COLUMNS) {
    const value = row[col];
    if (value !== undefined && value !== null && value !== "") {
      const parsed = parseFloat(String(value));
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  const ghgFactorColumn = Object.keys(row).find((key) => /GHG\s*Conversion\s*Factor/i.test(key));
  if (ghgFactorColumn) {
    const parsed = parseFloat(String(row[ghgFactorColumn]));
    if (!Number.isNaN(parsed)) return parsed;
  }

  return NaN;
};

const detectSource = (fileName: string, sheetNames: string[], headers: string[], rows: any[]): string => {
  const combined = `${fileName} ${sheetNames.join(" ")} ${headers.join(" ")}`.toLowerCase();
  for (const hint of SOURCE_HINTS) {
    if (combined.includes(hint.toLowerCase())) return hint;
  }

  for (const row of rows.slice(0, 5)) {
    for (const col of SOURCE_COLUMNS) {
      if (row[col]) {
        const sourceVal = String(row[col]).toUpperCase();
        for (const hint of SOURCE_HINTS) {
          if (sourceVal.includes(hint)) return hint;
        }
      }
    }
  }

  return "Custom";
};

const detectSheetScopePrefix = (sheetName: string): string => {
  const lower = sheetName.toLowerCase();
  if (lower.includes("scope 1") || lower === "scope1") return "scope1_";
  if (lower.includes("scope 2") || lower === "scope2") return "scope2_";
  if (lower.includes("scope 3") || lower === "scope3") return "scope3_";
  return "";
};

const detectRowScopePrefix = (row: any, fallback: string): string => {
  for (const col of SCOPE_COLUMNS) {
    const scope = row[col];
    if (scope === 1 || scope === "1" || scope === "Scope 1") return "scope1_";
    if (scope === 2 || scope === "2" || scope === "Scope 2") return "scope2_";
    if (scope === 3 || scope === "3" || scope === "Scope 3") return "scope3_";
  }
  return fallback;
};

export default function FileUpload({ onFactorsUploaded }: FileUploadProps) {
  const [fileName, setFileName] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [uploadedBatches, setUploadedBatches] = useState<UploadBatch[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setUploadStatus("uploading");

    try {
      const arrayBuffer = await file.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const workbook = read(data, { type: "array" });

      if (workbook.SheetNames.length === 0) {
        throw new Error("File doesn't contain any data sheets");
      }

      const factors: Record<string, EmissionFactor> = {};
      const yearsFound = new Set<number>();
      let totalFactors = 0;

      const firstSheet = utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]) as any[];
      const firstHeaders = firstSheet[0] ? Object.keys(firstSheet[0]) : [];
      const source = detectSource(file.name, workbook.SheetNames, firstHeaders, firstSheet);

      for (const sheetName of workbook.SheetNames) {
        const sheetRows = utils.sheet_to_json(workbook.Sheets[sheetName]) as any[];
        if (!sheetRows || sheetRows.length === 0) continue;

        const sheetYear = parseYear(sheetName);
        const firstRow = sheetRows[0] || {};
        const hasWasteTypeColumn = "Waste Type" in firstRow;
        const hasDisposalMethodColumns = ["Landfill", "Incineration", "Recycling", "Composting"].some((method) =>
          Object.keys(firstRow).some((key) => key.includes(method)),
        );
        const originalWasteFormat = "Waste Type" in firstRow && "Disposal Method" in firstRow;
        const isWasteFactorSheet = hasWasteTypeColumn && (hasDisposalMethodColumns || originalWasteFormat);

        let scopePrefix = detectSheetScopePrefix(sheetName);
        if (!scopePrefix && isWasteFactorSheet) scopePrefix = "scope3_";

        for (const row of sheetRows) {
          if (Object.keys(row).length < 2) continue;

          const rowScopePrefix = detectRowScopePrefix(row, scopePrefix);
          const rowYear =
            YEAR_COLUMNS.map((col) => parseYear(row[col])).find(Boolean) ?? parseYear(row["Period"]) ?? sheetYear;
          if (rowYear) yearsFound.add(rowYear);

          if (isWasteFactorSheet) {
            const wasteType = row["Waste Type"];
            if (!wasteType) continue;

            if (originalWasteFormat) {
              const disposalMethod = row["Disposal Method"];
              const emissionFactor = parseFloat(row["Emission Factor (kg CO2e/unit)"] ?? row["Emission Factor"]);
              const unit = row["Unit"] || "t";
              if (!disposalMethod || Number.isNaN(emissionFactor)) continue;

              const activityKey = `${rowScopePrefix}waste_${slugify(String(wasteType))}_${slugify(String(disposalMethod))}__${source.toLowerCase()}__${rowYear ?? "na"}`;
              factors[activityKey] = {
                name: `${wasteType} - ${disposalMethod}`,
                factor: emissionFactor,
                unit,
                source,
                year: rowYear,
                wasteType,
                disposalMethod,
                category: "waste",
              };
              totalFactors++;
            } else {
              const disposalMethods = ["Landfill", "Incineration", "Recycling", "Composting"];
              for (const column of Object.keys(row)) {
                const disposalMethod = disposalMethods.find((method) => column.includes(method));
                if (!disposalMethod) continue;

                const emissionFactor = parseFloat(row[column]);
                if (Number.isNaN(emissionFactor)) continue;

                const unitMatch = column.match(/\((.*?)\)/);
                const unit = unitMatch ? unitMatch[1].split("/")[1] || "t" : "t";
                const activityKey = `${rowScopePrefix}waste_${slugify(String(wasteType))}_${slugify(disposalMethod)}__${source.toLowerCase()}__${rowYear ?? "na"}`;

                factors[activityKey] = {
                  name: `${wasteType} - ${disposalMethod}`,
                  factor: emissionFactor,
                  unit,
                  source,
                  year: rowYear,
                  wasteType,
                  disposalMethod,
                  category: "waste",
                };
                totalFactors++;
              }
            }
            continue;
          }

          const hierarchicalActivity = buildHierarchicalActivity(row);
          let activityType = hierarchicalActivity || ACTIVITY_COLUMNS.map((col) => row[col]).find(Boolean);
          if (!activityType) {
            activityType = Object.keys(row)
              .filter((key) => !["Unit", "Scope", ...YEAR_COLUMNS].includes(key))
              .map((key) => row[key])
              .find((value) => typeof value === "string");
          }

          let emissionFactor = getEmissionFactorFromRow(row);

          if (Number.isNaN(emissionFactor)) {
            for (const key of Object.keys(row)) {
              if ([...YEAR_COLUMNS, ...SCOPE_COLUMNS].includes(key)) continue;
              const value = row[key];
              if (typeof value === "number") {
                emissionFactor = value;
                break;
              }
              if (typeof value === "string" && !Number.isNaN(parseFloat(value))) {
                emissionFactor = parseFloat(value);
                break;
              }
            }
          }

          let unit = UNIT_COLUMNS.map((col) => row[col]).find(Boolean) || "";
          if (!unit) unit = "unit";

          const ghgUnit = row["GHG/Unit"] ? String(row["GHG/Unit"]).trim() : "";
          const scope3Category = normalizeScope3Category(row["Category"] ?? row["Scope 3 Category"] ?? row["Scope3 Category"]);

          if (activityType && !Number.isNaN(emissionFactor)) {
            const activityName = String(activityType);
            const keyParts = [
              rowScopePrefix + slugify(activityName),
              slugify(String(unit)),
              ghgUnit ? slugify(ghgUnit) : "",
              row["ID"] ? slugify(String(row["ID"])) : "",
              source.toLowerCase(),
              String(rowYear ?? "na"),
            ].filter(Boolean);

            const activityKey = keyParts.join("__");
            factors[activityKey] = {
              name: activityName,
              factor: emissionFactor,
              unit: String(unit),
              source,
              year: rowYear,
              category: scope3Category,
            };
            totalFactors++;
          }
        }
      }

      if (totalFactors === 0) {
        throw new Error(
          "No valid emission factors found. Please verify columns for activity, factor, unit, and optional year.",
        );
      }

      setUploadStatus("success");
      onFactorsUploaded(factors);

      const yearsArray = Array.from(yearsFound).sort((a, b) => a - b);
      setUploadedBatches((prev) => [
        {
          fileName: file.name,
          source,
          years: yearsArray,
          count: totalFactors,
        },
        ...prev,
      ]);

      toast({
        title: "Upload Successful",
        description: `${totalFactors} factors loaded from ${source}${
          yearsArray.length ? ` for year(s): ${yearsArray.join(", ")}` : " (year not specified)"
        }`,
        variant: "default",
      });
    } catch (error) {
      console.error("File upload error:", error);
      setUploadStatus("error");
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to process the file",
        variant: "destructive",
      });
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <Card className="bg-white">
      <CardContent className="pt-6">
        <div className="flex flex-col items-start space-y-4 md:flex-row md:items-center md:space-x-6 md:space-y-0">
          <div className="flex-grow">
            <h2 className="mb-1 text-lg font-semibold text-neutral-800">Upload Emission Factors</h2>
            <div className="mb-2 text-sm text-neutral-600">
              <p>
                Upload DEFRA/CEA/IEA/EPA or custom flat files (.xlsx, .xls, .csv). You can upload multiple files and
                years.
                <br />
                <span className="text-xs text-neutral-500">
                  Supported columns include activity/factor/unit with optional source and year columns.
                </span>
              </p>
              <div className="mt-1">
                <WasteFactorGuide />
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Button
                type="button"
                variant="outline"
                className="border-neutral-300 bg-white text-neutral-600 hover:border-primary-500 hover:text-primary-600"
                onClick={handleClick}
              >
                <Upload className="mr-2 h-4 w-4" />
                Choose Factor File
              </Button>
              <span className="text-sm text-neutral-500">{fileName || "No file chosen"}</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          </div>

          <div className="flex-shrink-0">
            {uploadStatus === "idle" && (
              <Badge variant="outline" className="bg-blue-100 text-blue-800 hover:bg-blue-100">
                Ready to upload
              </Badge>
            )}
            {uploadStatus === "uploading" && (
              <Badge variant="outline" className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100">
                Uploading...
              </Badge>
            )}
            {uploadStatus === "success" && (
              <Badge variant="outline" className="bg-green-100 text-green-800 hover:bg-green-100">
                <Check className="mr-1 h-3 w-3" />
                Upload Successful
              </Badge>
            )}
            {uploadStatus === "error" && (
              <Badge variant="outline" className="bg-red-100 text-red-800 hover:bg-red-100">
                <AlertCircle className="mr-1 h-3 w-3" />
                Upload Failed
              </Badge>
            )}
          </div>
        </div>

        {uploadedBatches.length > 0 && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2 text-sm font-medium text-slate-700">Uploaded datasets</p>
            <div className="space-y-2">
              {uploadedBatches.slice(0, 5).map((batch, index) => (
                <div key={`${batch.fileName}-${index}`} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                    <Database className="mr-1 h-3 w-3" />
                    {batch.source}
                  </Badge>
                  <span className="font-medium text-slate-700">{batch.fileName}</span>
                  <span>({batch.count} factors)</span>
                  <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
                    <Calendar className="mr-1 h-3 w-3" />
                    {batch.years.length ? batch.years.join(", ") : "Year not provided"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

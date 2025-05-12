import { useState, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmissionFactor } from "@/types/emissions";
import { Upload, Check, AlertCircle } from "lucide-react";
import { read, utils } from "xlsx";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import WasteFactorGuide from "./WasteFactorGuide";

interface FileUploadProps {
  onFactorsUploaded: (factors: Record<string, EmissionFactor>) => void;
}

export default function FileUpload({ onFactorsUploaded }: FileUploadProps) {
  const [fileName, setFileName] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
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
        throw new Error("Excel file doesn't contain any sheets");
      }
      
      const factors: Record<string, EmissionFactor> = {};
      let totalFactors = 0;
      let wasteFactorsFound = false;
      
      // Process all sheets in the workbook
      for (const sheetName of workbook.SheetNames) {
        const sheet = utils.sheet_to_json(workbook.Sheets[sheetName]);
        
        if (!sheet || sheet.length === 0) {
          // Skip empty sheets
          continue;
        }
        
        if (sheet.length === 0) {
          continue; // Skip empty sheets
        }
        
        // Try to detect scope from sheet name
        let scopePrefix = '';
        if (sheetName.toLowerCase().includes('scope 1') || sheetName.toLowerCase() === 'scope1') {
          scopePrefix = 'scope1_';
        } else if (sheetName.toLowerCase().includes('scope 2') || sheetName.toLowerCase() === 'scope2') {
          scopePrefix = 'scope2_';
        } else if (sheetName.toLowerCase().includes('scope 3') || sheetName.toLowerCase() === 'scope3') {
          scopePrefix = 'scope3_';
        }
        
        const firstRow = sheet[0] as any;
        
        // Detect if this is a waste-specific sheet by checking for column headers
        // New format: Waste Type as first column and disposal methods as column headers
        const hasWasteTypeColumn = 'Waste Type' in firstRow;
        const hasDisposalMethodColumns = ['Landfill', 'Incineration', 'Recycling', 'Composting'].some(
          method => Object.keys(firstRow).some(key => key.includes(method))
        );
        
        // Original format: Waste Type and Disposal Method as separate columns
        const originalWasteFormat = 'Waste Type' in firstRow && 'Disposal Method' in firstRow;
        
        const isWasteFactorSheet = hasWasteTypeColumn && (hasDisposalMethodColumns || originalWasteFormat);
        
        // If this is a waste sheet and we don't have a scope, assume it's scope 3
        if (isWasteFactorSheet && !scopePrefix) {
          scopePrefix = 'scope3_';
        }
        
        // Try to get scope from columns if not detected from sheet name
        if (!scopePrefix && 'Scope' in firstRow) {
          // Look at the first few rows to determine the scope
          for (let i = 0; i < Math.min(3, sheet.length); i++) {
            const row = sheet[i] as any;
            const scope = row['Scope'];
            if (scope === 1 || scope === '1' || scope === 'Scope 1') {
              scopePrefix = 'scope1_';
              break;
            } else if (scope === 2 || scope === '2' || scope === 'Scope 2') {
              scopePrefix = 'scope2_';
              break;
            } else if (scope === 3 || scope === '3' || scope === 'Scope 3') {
              scopePrefix = 'scope3_';
              break;
            }
          }
        }
        
        for (const row of sheet as any[]) {
          // Skip rows without essential data
          if (Object.keys(row).length < 2) continue;
          
          // Check if this row has a specific scope
          let rowScopePrefix = scopePrefix;
          if ('Scope' in row) {
            const scope = row['Scope'];
            if (scope === 1 || scope === '1' || scope === 'Scope 1') {
              rowScopePrefix = 'scope1_';
            } else if (scope === 2 || scope === '2' || scope === 'Scope 2') {
              rowScopePrefix = 'scope2_';
            } else if (scope === 3 || scope === '3' || scope === 'Scope 3') {
              rowScopePrefix = 'scope3_';
            }
          }
          
          if (isWasteFactorSheet) {
            // This is a waste factor sheet
            wasteFactorsFound = true;
            const wasteType = row["Waste Type"];
            
            if (!wasteType) {
              continue; // Skip rows without waste type
            }
            
            if (originalWasteFormat) {
              // Original format with Waste Type and Disposal Method columns
              const disposalMethod = row["Disposal Method"];
              const emissionFactor = parseFloat(row["Emission Factor (kg CO2e/unit)"]);
              const unit = row["Unit"] || "";
              
              if (!disposalMethod || isNaN(emissionFactor)) {
                // Skip invalid rows but don't throw error
                continue;
              }
              
              // Create a unique key for the waste type + disposal method combination
              const activityKey = `${rowScopePrefix}waste_${wasteType.replace(/\s+/g, '_').toLowerCase()}_${disposalMethod.replace(/\s+/g, '_').toLowerCase()}`;
              
              factors[activityKey] = {
                name: `${wasteType} - ${disposalMethod}`,
                factor: emissionFactor,
                unit: unit,
                wasteType: wasteType,
                disposalMethod: disposalMethod,
                category: 'waste'
              };
              totalFactors++;
            } else {
              // New format with disposal methods as column headers
              // Process each disposal method column
              const disposalMethods = ['Landfill', 'Incineration', 'Recycling', 'Composting'];
              
              for (const column of Object.keys(row)) {
                // Find which disposal method this column represents
                const disposalMethod = disposalMethods.find(method => column.includes(method));
                if (!disposalMethod) continue;
                
                const emissionFactor = parseFloat(row[column]);
                if (isNaN(emissionFactor)) continue;
                
                // Extract unit from column name - assuming format "Method (kg CO2e/t)"
                const unitMatch = column.match(/\((.*?)\)/);
                const unit = unitMatch ? unitMatch[1].split('/')[1] || 't' : 't';
                
                // Create a unique key for the waste type + disposal method combination
                const activityKey = `${rowScopePrefix}waste_${wasteType.replace(/\s+/g, '_').toLowerCase()}_${disposalMethod.replace(/\s+/g, '_').toLowerCase()}`;
                
                factors[activityKey] = {
                  name: `${wasteType} - ${disposalMethod}`,
                  factor: emissionFactor,
                  unit: unit,
                  wasteType: wasteType,
                  disposalMethod: disposalMethod,
                  category: 'waste'
                };
                totalFactors++;
              }
            }
          } else {
            // Standard emission factors format
            // Determine if we have a generic 'Activity Type' column or a specific activity column
            let activityType = row["Activity Type"];
            
            // If no Activity Type column, try to find other descriptive columns
            if (!activityType) {
              // Look for any column that might contain activity descriptions
              const possibleActivityColumns = [
                "Activity", "Activity Type", "Description", "Source", "Fuel Type", "Energy Source", 
                "Transport Mode", "Vehicle Type", "Material", "Category", "Subcategory",
                "GHG Source", "Emission Source", "Activity Name", "Type", "Source Category",
                "Process", "Equipment", "Industry", "Application", "Resource"
              ];
              
              for (const colName of possibleActivityColumns) {
                if (row[colName]) {
                  activityType = row[colName];
                  break;
                }
              }
              
              // If still no activity type found, try to use the first string column
              if (!activityType) {
                for (const key of Object.keys(row)) {
                  if (typeof row[key] === 'string' && key !== 'Unit' && key !== 'Scope') {
                    activityType = row[key];
                    break;
                  }
                }
              }
            }
            
            // Look for emission factor column with various possible names
            let emissionFactor = NaN;
            let unit = "";
            
            // Common emission factor column names
            const factorColumns = [
              "Emission Factor (kg CO2e/unit)", 
              "Emission Factor",
              "EF",
              "GHG Emission Factor",
              "CO2 Equivalent",
              "CO2e Factor",
              "CO2 Factor",
              "Factor",
              "kg CO2e/unit",
              "tCO2e"
            ];
            
            for (const colName of factorColumns) {
              if (row[colName] !== undefined) {
                emissionFactor = parseFloat(row[colName]);
                break;
              }
            }
            
            // If no emission factor found in standard columns, look for any numeric column
            if (isNaN(emissionFactor)) {
              for (const key of Object.keys(row)) {
                const value = row[key];
                if (
                  typeof value === 'number' || 
                  (typeof value === 'string' && !isNaN(parseFloat(value)))
                ) {
                  if (key !== 'Scope' && !key.includes('Year')) {
                    emissionFactor = typeof value === 'number' ? value : parseFloat(value);
                    break;
                  }
                }
              }
            }
            
            // Get unit from Unit column or derive from other sources
            const unitColumns = ["Unit", "Units", "Measurement Unit", "Unit of Measure"];
            for (const unitCol of unitColumns) {
              if (row[unitCol]) {
                unit = row[unitCol];
                break;
              }
            }
            
            // If no unit found, try to extract from column names or factor names
            if (!unit) {
              // Try to extract unit from column names
              for (const key of Object.keys(row)) {
                // Look for patterns like "(kg CO2e/kWh)" or "/kWh" or "per kWh"
                const unitMatch = key.match(/\((.*?)\)/);
                if (unitMatch) {
                  // Try to get denominator from "kg CO2e/kWh" pattern
                  const parts = unitMatch[1].split('/');
                  if (parts.length > 1) {
                    unit = parts[1];
                  } else {
                    unit = unitMatch[1];
                  }
                  break;
                } else if (key.includes(' per ')) {
                  const parts = key.split(' per ');
                  if (parts.length > 1) {
                    unit = parts[1];
                    break;
                  }
                } else if (key.includes('/')) {
                  const parts = key.split('/');
                  if (parts.length > 1) {
                    unit = parts[1];
                    break;
                  }
                }
              }
              
              // If still no unit, look at activity name for clues
              if (!unit && activityType) {
                if (activityType.toLowerCase().includes('electricity')) {
                  unit = 'kWh';
                } else if (activityType.toLowerCase().includes('fuel') || 
                           activityType.toLowerCase().includes('gas') ||
                           activityType.toLowerCase().includes('oil')) {
                  unit = 'liter';
                } else if (activityType.toLowerCase().includes('travel') || 
                           activityType.toLowerCase().includes('transport') ||
                           activityType.toLowerCase().includes('vehicle')) {
                  unit = 'km';
                } else if (activityType.toLowerCase().includes('waste')) {
                  unit = 'kg';
                }
              }
              
              // Default unit if none found
              if (!unit) {
                unit = 'unit';
              }
            }
            
            // Check if we have both an activity type and emission factor
            if (activityType && !isNaN(emissionFactor)) {
              const activityKey = `${rowScopePrefix}${activityType.replace(/\s+/g, '_').toLowerCase()}`;
              
              factors[activityKey] = {
                name: activityType,
                factor: emissionFactor,
                unit: unit,
              };
              totalFactors++;
            }
          }
        }
      }
      
      if (totalFactors === 0) {
        throw new Error("No valid emission factors found in the file. Please check the file format and try again.");
      }
      
      setUploadStatus("success");
      onFactorsUploaded(factors);
      
      const scope1Count = Object.keys(factors).filter(key => key.startsWith('scope1_')).length;
      const scope2Count = Object.keys(factors).filter(key => key.startsWith('scope2_')).length;
      const scope3Count = Object.keys(factors).filter(key => key.startsWith('scope3_')).length;
      const otherCount = Object.keys(factors).filter(key => !key.startsWith('scope1_') && !key.startsWith('scope2_') && !key.startsWith('scope3_')).length;
      
      let description = '';
      
      if (scope1Count > 0 || scope2Count > 0 || scope3Count > 0) {
        description = `Loaded successfully: `;
        const parts = [];
        if (scope1Count > 0) parts.push(`${scope1Count} Scope 1 factors`);
        if (scope2Count > 0) parts.push(`${scope2Count} Scope 2 factors`);
        if (scope3Count > 0) parts.push(`${scope3Count} Scope 3 factors${wasteFactorsFound ? ' (including waste factors)' : ''}`);
        if (otherCount > 0) parts.push(`${otherCount} other factors`);
        description += parts.join(', ');
      } else {
        description = `${totalFactors} emission factors loaded successfully${wasteFactorsFound ? ' (including waste factors)' : ''}`;
      }
      
      toast({
        title: "Upload Successful",
        description,
        variant: "default"
      });
      
    } catch (error) {
      console.error("File upload error:", error);
      setUploadStatus("error");
      
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to process the Excel file",
        variant: "destructive"
      });
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <Card className="bg-white">
      <CardContent className="pt-6">
        <div className="flex flex-col md:flex-row space-y-4 md:space-y-0 md:space-x-6 items-start md:items-center">
          <div className="flex-grow">
            <h2 className="text-lg font-semibold text-neutral-800 mb-1">Upload Emission Factors</h2>
            <div className="text-sm text-neutral-600 mb-2">
              <p>
                Upload your Excel file containing emission factors for accurate calculations.
                <br />
                <span className="text-xs text-neutral-500">
                  Supports both standard emission factors and waste-specific factors with disposal methods.
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
                className="bg-white border-neutral-300 text-neutral-600 hover:border-primary-500 hover:text-primary-600"
                onClick={handleClick}
              >
                <Upload className="h-4 w-4 mr-2" />
                Choose Excel File
              </Button>
              <span className="text-sm text-neutral-500">
                {fileName || "No file chosen"}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
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
                <Check className="h-3 w-3 mr-1" />
                Upload Successful
              </Badge>
            )}
            {uploadStatus === "error" && (
              <Badge variant="outline" className="bg-red-100 text-red-800 hover:bg-red-100">
                <AlertCircle className="h-3 w-3 mr-1" />
                Upload Failed
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

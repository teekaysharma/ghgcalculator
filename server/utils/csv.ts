import { Emission } from "../../shared/schema";

/**
 * Generates a CSV string from emissions data
 */
export function generateCSV(emissions: Emission[]): string {
  const escapeCsvValue = (value: string | number): string => {
    const stringValue = String(value);
    if (/[",\n]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  // CSV header
  const header = "Year,Product,Scope,Activity,Unit,Quantity,Emission Factor,Emissions (kg CO₂e)";
  
  // Format emission rows
  const rows = emissions.map(emission => {
    const scopeFormatted = emission.scope.replace('scope', 'Scope ');
    const activityFormatted = emission.activity.replace(/_/g, ' ');
    
    return [
      emission.year || "",
      emission.product || "",
      scopeFormatted,
      activityFormatted,
      emission.unit,
      emission.quantity.toString(),
      emission.factor.toString(),
      emission.emission.toFixed(2)
    ]
      .map(escapeCsvValue)
      .join(',');
  });
  
  // Combine header and rows
  return [header, ...rows].join('\n');
}

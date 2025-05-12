import { Emission } from "../../shared/schema";

/**
 * Generates a CSV string from emissions data
 */
export function generateCSV(emissions: Emission[]): string {
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
    ].join(',');
  });
  
  // Combine header and rows
  return [header, ...rows].join('\n');
}

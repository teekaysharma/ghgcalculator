import { Button } from "@/components/ui/button";
import { Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function WasteFactorGuide() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-neutral-600">
          <Info className="h-4 w-4 mr-1" />
          <span>Waste Factor Format Guide</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Waste Emission Factors Format Guide</DialogTitle>
          <DialogDescription>
            Learn how to structure your waste emission factors Excel file
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 mt-4">
          <p className="text-sm text-neutral-600">
            The calculator supports comprehensive emission factor files with multiple scopes and waste formats:
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
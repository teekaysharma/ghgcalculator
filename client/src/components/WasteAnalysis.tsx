import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Emission, WasteDisposalSummary } from "@/types/emissions";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Trash } from "lucide-react";
import { Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement
} from 'chart.js';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
);

interface WasteAnalysisProps {
  emissions: Emission[];
  enabled: boolean;
}

export default function WasteAnalysis({ emissions, enabled }: WasteAnalysisProps) {
  const [wasteSummary, setWasteSummary] = useState<WasteDisposalSummary[]>([]);
  const [totalWasteEmissions, setTotalWasteEmissions] = useState<number>(0);
  const [hasWasteData, setHasWasteData] = useState(false);
  const { toast } = useToast();

  // Check if there's any waste-related emissions data
  useEffect(() => {
    const hasWaste = emissions.some(emission => 
      emission.wasteType && emission.disposalMethod
    );
    
    setHasWasteData(hasWaste);
    
    if (hasWaste && enabled) {
      calculateWasteSummary();
    }
  }, [emissions, enabled]);

  const calculateWasteSummary = () => {
    // Filter waste-related emissions
    const wasteEmissions = emissions.filter(emission => 
      emission.wasteType && emission.disposalMethod
    );
    
    if (wasteEmissions.length === 0) {
      setWasteSummary([]);
      setTotalWasteEmissions(0);
      return;
    }
    
    // Group emissions by waste type
    const wasteTypesMap = new Map<string, Map<string, number>>();
    const wasteQuantityMap = new Map<string, { qty: number, unit: string }>();
    
    for (const emission of wasteEmissions) {
      const wasteType = emission.wasteType!;
      const disposalMethod = emission.disposalMethod!;
      
      // Track emissions by disposal method
      if (!wasteTypesMap.has(wasteType)) {
        wasteTypesMap.set(wasteType, new Map<string, number>());
      }
      
      const methodsMap = wasteTypesMap.get(wasteType)!;
      const currentEmission = methodsMap.get(disposalMethod) || 0;
      methodsMap.set(disposalMethod, currentEmission + emission.emission);
      
      // Track quantity
      if (!wasteQuantityMap.has(wasteType)) {
        wasteQuantityMap.set(wasteType, { qty: 0, unit: emission.unit });
      }
      
      const quantityData = wasteQuantityMap.get(wasteType)!;
      quantityData.qty += emission.quantity;
    }
    
    // Convert to summary format
    const summary: WasteDisposalSummary[] = [];
    let total = 0;
    
    // Convert Map entries to array first to avoid TypeScript iteration issues
    Array.from(wasteTypesMap.entries()).forEach(([wasteType, methodsMap]) => {
      const byMethod: Record<string, number> = {};
      let wasteTypeTotal = 0;
      
      // Convert the nested Map entries to array as well
      Array.from(methodsMap.entries()).forEach(([method, emission]) => {
        byMethod[method] = emission;
        wasteTypeTotal += emission;
      });
      
      const quantityData = wasteQuantityMap.get(wasteType)!;
      
      summary.push({
        wasteType,
        totalEmission: wasteTypeTotal,
        byMethod,
        totalQuantity: quantityData.qty,
        unit: quantityData.unit
      });
      
      total += wasteTypeTotal;
    });
    
    // Sort by highest emissions
    summary.sort((a, b) => b.totalEmission - a.totalEmission);
    
    setWasteSummary(summary);
    setTotalWasteEmissions(total);
  };

  // Prepare chart data for waste types comparison
  const wasteTypesChartData = {
    labels: wasteSummary.map(waste => waste.wasteType),
    datasets: [
      {
        label: 'Emissions (kg CO₂e)',
        data: wasteSummary.map(waste => waste.totalEmission),
        backgroundColor: [
          '#4caf50', '#2196f3', '#f44336', '#ff9800', '#9c27b0', 
          '#3f51b5', '#e91e63', '#009688', '#673ab7', '#ffeb3b'
        ],
        borderWidth: 1
      }
    ]
  };

  // Prepare chart data for disposal methods
  const getDisposalMethodsChartData = () => {
    if (wasteSummary.length === 0) return null;
    
    // Collect all unique disposal methods
    const allMethods = new Set<string>();
    wasteSummary.forEach(waste => {
      Object.keys(waste.byMethod).forEach(method => allMethods.add(method));
    });
    
    // Create dataset for each disposal method
    const datasets = Array.from(allMethods).map((method, index) => {
      return {
        label: method,
        data: wasteSummary.map(waste => waste.byMethod[method] || 0),
        backgroundColor: [
          '#4caf50', '#2196f3', '#f44336', '#ff9800', '#9c27b0', 
          '#3f51b5', '#e91e63', '#009688', '#673ab7', '#ffeb3b'
        ][index % 10],
        borderWidth: 1
      };
    });
    
    return {
      labels: wasteSummary.map(waste => waste.wasteType),
      datasets
    };
  };

  const barChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top' as const,
      },
      tooltip: {
        callbacks: {
          label: function(context: any) {
            return `${context.formattedValue} kg CO₂e`;
          }
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: 'Emissions (kg CO₂e)'
        }
      },
      x: {
        title: {
          display: true,
          text: 'Waste Type'
        }
      }
    }
  };

  const doughnutChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
      },
      tooltip: {
        callbacks: {
          label: function(context: any) {
            const value = context.raw;
            const total = context.dataset.data.reduce((a: number, b: number) => a + b, 0);
            const percentage = Math.round((value / total) * 100);
            return `${context.label}: ${value.toFixed(2)} kg CO₂e (${percentage}%)`;
          }
        }
      }
    }
  };

  if (!enabled || !hasWasteData) {
    return (
      <Card className="bg-white mt-6">
        <CardContent className="pt-6 text-center py-12">
          <div className="flex flex-col items-center justify-center text-neutral-500">
            <Trash className="h-12 w-12 mb-3 text-neutral-400" />
            <h3 className="text-lg font-medium mb-2">No Waste Data Available</h3>
            <p className="text-sm max-w-md">
              To enable waste analysis, please upload a waste-specific emission factors file and assign waste types and disposal methods to your emissions.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-white mt-6">
      <CardContent className="pt-6">
        <h3 className="text-2xl font-medium text-neutral-800 mb-4">Waste Emissions Analysis</h3>
        
        <div className="mb-6 p-4 border border-neutral-200 rounded-lg bg-neutral-50">
          <div className="flex items-center mb-4">
            <div className="p-3 rounded-full bg-green-100 mr-4">
              <Trash className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <h4 className="text-lg font-semibold">
                {totalWasteEmissions.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} kg CO₂e
              </h4>
              <p className="text-sm text-neutral-600">Total waste-related emissions</p>
            </div>
          </div>
          
          <p className="text-sm text-neutral-600 mb-2">
            This analysis shows emissions from different waste types and their disposal methods.
          </p>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Waste Types Chart */}
          <Card className="bg-white">
            <CardContent className="pt-6">
              <h4 className="text-lg font-medium text-neutral-800 mb-4">Emissions by Waste Type</h4>
              <div className="h-64">
                <Bar data={wasteTypesChartData} options={barChartOptions} />
              </div>
            </CardContent>
          </Card>
          
          {/* Disposal Methods Chart */}
          <Card className="bg-white">
            <CardContent className="pt-6">
              <h4 className="text-lg font-medium text-neutral-800 mb-4">Emissions Distribution</h4>
              <div className="h-64">
                <Doughnut 
                  data={{
                    labels: wasteSummary.map(item => item.wasteType),
                    datasets: [{
                      data: wasteSummary.map(item => item.totalEmission),
                      backgroundColor: [
                        '#4caf50', '#2196f3', '#f44336', '#ff9800', '#9c27b0', 
                        '#3f51b5', '#e91e63', '#009688', '#673ab7', '#ffeb3b'
                      ],
                      borderWidth: 1
                    }]
                  }} 
                  options={doughnutChartOptions} 
                />
              </div>
            </CardContent>
          </Card>
        </div>
        
        {/* Detailed Waste Table */}
        <Card className="bg-white">
          <CardContent className="pt-6">
            <h4 className="text-lg font-medium text-neutral-800 mb-4">Detailed Waste Report</h4>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-neutral-200">
                <thead className="bg-neutral-50">
                  <tr>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Waste Type</th>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Quantity</th>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Disposal Methods</th>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Total Emissions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-neutral-200">
                  {wasteSummary.map((waste, index) => (
                    <tr key={index} className={index % 2 === 0 ? 'bg-white' : 'bg-neutral-50'}>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-neutral-800">
                        {waste.wasteType}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-neutral-600">
                        {waste.totalQuantity.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} {waste.unit}
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-600">
                        <div className="space-y-1">
                          {Object.entries(waste.byMethod).map(([method, emission], i) => (
                            <div key={i} className="flex justify-between">
                              <span>{method}:</span>
                              <span className="font-medium">
                                {emission.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} kg CO₂e
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-neutral-800">
                        {waste.totalEmission.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} kg CO₂e
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}
import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScopeType, Emission } from "@/types/emissions";
import { Download, Layers, Calendar, Factory, Trash } from "lucide-react";
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import YearlyComparison from "./YearlyComparison";
import ProductIntensity from "./ProductIntensity";
import WasteAnalysis from "./WasteAnalysis";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

interface ResultsViewProps {
  results: Record<ScopeType, number>;
  emissions: Emission[];
  isLoading: boolean;
}

export default function ResultsView({ results, emissions, isLoading }: ResultsViewProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("summary");
  const [hasYearData, setHasYearData] = useState(false);
  const [hasProductData, setHasProductData] = useState(false);
  const [hasWasteData, setHasWasteData] = useState(false);
  
  useEffect(() => {
    // Check if any emissions have year data
    setHasYearData(emissions.some(emission => emission.year !== undefined));
    
    // Check if any emissions have product data
    setHasProductData(emissions.some(emission => emission.product !== undefined));
    
    // Check if any emissions have waste data
    setHasWasteData(emissions.some(emission => 
      emission.wasteType !== undefined && emission.disposalMethod !== undefined
    ));
  }, [emissions]);
  
  const chartData = {
    labels: ['Scope 1', 'Scope 2', 'Scope 3'],
    datasets: [
      {
        label: 'Emissions (kg CO₂e)',
        data: [results.scope1, results.scope2, results.scope3],
        backgroundColor: ['#e53935', '#0277bd', '#2e7d32'],
      },
    ],
  };
  
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
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
      }
    }
  };

  // Get total emissions
  const totalEmissions = results.scope1 + results.scope2 + results.scope3;
  
  // Get activity count
  const activityCount = emissions.length;

  // Get largest contributor
  const getLargestContributor = () => {
    if (emissions.length === 0) return 'N/A';
    
    let largest = emissions[0];
    
    for (const emission of emissions) {
      if (emission.emission > largest.emission) {
        largest = emission;
      }
    }
    
    return `${largest.activity.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} (${largest.emission.toFixed(2)} kg CO₂e)`;
  };

  const downloadCsvMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/download-csv", {
        emissions: emissions
      });
      return response.blob();
    },
    onSuccess: (blob) => {
      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = "GHG_Emissions_Report.csv";
      a.click();
      
      toast({
        title: "Download Complete",
        description: "CSV file downloaded successfully!",
        variant: "default"
      });
    },
    onError: (error) => {
      toast({
        title: "Download Failed",
        description: error.message || "Failed to download CSV file. Please try again.",
        variant: "destructive"
      });
    }
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
        <span className="ml-2 text-lg">Calculating emissions...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-heading font-semibold text-neutral-800">Emissions Results</h2>
          <p className="text-neutral-600">Analysis and visualization of your greenhouse gas emissions</p>
        </div>
      </div>

      <Tabs defaultValue="summary" value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="w-full bg-neutral-100 p-1">
          <TabsTrigger value="summary" className="flex items-center gap-1">
            <Layers className="h-4 w-4" />
            <span>Summary</span>
          </TabsTrigger>
          <TabsTrigger 
            value="yearly" 
            className="flex items-center gap-1"
            disabled={!hasYearData}
          >
            <Calendar className="h-4 w-4" />
            <span>Yearly Comparison</span>
          </TabsTrigger>
          <TabsTrigger 
            value="products" 
            className="flex items-center gap-1"
            disabled={!hasProductData}
          >
            <Factory className="h-4 w-4" />
            <span>Product Intensity</span>
          </TabsTrigger>
          <TabsTrigger 
            value="waste" 
            className="flex items-center gap-1"
            disabled={!hasWasteData}
          >
            <Trash className="h-4 w-4" />
            <span>Waste Analysis</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Summary Cards */}
            <Card className="bg-white">
              <CardContent className="pt-6">
                <h3 className="text-lg font-medium text-neutral-800 mb-3">Scope 1 Emissions</h3>
                <div className="flex items-center">
                  <div className="p-3 rounded-full bg-red-100 mr-4">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                    </svg>
                  </div>
                  <div>
                    <span className="block text-2xl font-bold text-neutral-800">
                      {results.scope1.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                    </span>
                    <span className="text-neutral-500">kg CO₂e</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white">
              <CardContent className="pt-6">
                <h3 className="text-lg font-medium text-neutral-800 mb-3">Scope 2 Emissions</h3>
                <div className="flex items-center">
                  <div className="p-3 rounded-full bg-blue-100 mr-4">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                  <div>
                    <span className="block text-2xl font-bold text-neutral-800">
                      {results.scope2.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                    </span>
                    <span className="text-neutral-500">kg CO₂e</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-white">
              <CardContent className="pt-6">
                <h3 className="text-lg font-medium text-neutral-800 mb-3">Scope 3 Emissions</h3>
                <div className="flex items-center">
                  <div className="p-3 rounded-full bg-green-100 mr-4">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <span className="block text-2xl font-bold text-neutral-800">
                      {results.scope3.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                    </span>
                    <span className="text-neutral-500">kg CO₂e</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Chart */}
            <Card className="bg-white">
              <CardContent className="pt-6">
                <h3 className="text-lg font-medium text-neutral-800 mb-4">Emissions Distribution</h3>
                <div className="h-64">
                  <Bar data={chartData} options={chartOptions} />
                </div>
              </CardContent>
            </Card>

            {/* Details */}
            <Card className="bg-white">
              <CardContent className="pt-6">
                <h3 className="text-lg font-medium text-neutral-800 mb-4">Emission Details</h3>
                <div className="mb-4">
                  <div className="flex justify-between py-2 border-b border-neutral-200">
                    <span className="font-medium">Total Emissions</span>
                    <span className="font-bold">
                      {totalEmissions.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} kg CO₂e
                    </span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-neutral-200">
                    <span>Number of Activities</span>
                    <span>{activityCount}</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-neutral-200">
                    <span>Largest Contributor</span>
                    <span>{getLargestContributor()}</span>
                  </div>
                </div>
                
                <Button
                  className="mt-2 w-full bg-secondary-600 hover:bg-secondary-700"
                  onClick={() => downloadCsvMutation.mutate()}
                  disabled={downloadCsvMutation.isPending || emissions.length === 0}
                >
                  {downloadCsvMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  Download Results CSV
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Detailed Results Table */}
          {emissions.length > 0 && (
            <Card className="bg-white">
              <CardContent className="pt-6">
                <h3 className="text-lg font-medium text-neutral-800 mb-4">Detailed Activity Report</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-neutral-200">
                    <thead className="bg-neutral-50">
                      <tr>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Scope</th>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Activity</th>
                        {hasYearData && (
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Year</th>
                        )}
                        {hasProductData && (
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Product</th>
                        )}
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Unit</th>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Quantity</th>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Emission Factor</th>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Emissions (kg CO₂e)</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-neutral-200">
                      {emissions.map((emission, index) => (
                        <tr key={index}>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-600">
                            {emission.scope.replace('scope', 'Scope ')}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-800">
                            {emission.activity.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                          </td>
                          {hasYearData && (
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-600">
                              {emission.year || '-'}
                            </td>
                          )}
                          {hasProductData && (
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-600">
                              {emission.product ? emission.product.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '-'}
                            </td>
                          )}
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-600">
                            {emission.unit}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-600">
                            {emission.quantity.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-600">
                            {emission.factor.toFixed(2)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-neutral-800">
                            {emission.emission.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="yearly">
          <YearlyComparison emissions={emissions} enabled={hasYearData} />
        </TabsContent>

        <TabsContent value="products">
          <ProductIntensity emissions={emissions} enabled={hasProductData} />
        </TabsContent>
        
        <TabsContent value="waste">
          <WasteAnalysis emissions={emissions} enabled={hasWasteData} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

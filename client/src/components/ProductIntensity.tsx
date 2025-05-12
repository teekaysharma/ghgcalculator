import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ProductIntensity as ProductIntensityType, ProductData } from "@/types/emissions";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Factory, Plus, Trash2 } from "lucide-react";
import { Bar } from 'react-chartjs-2';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
);

interface ProductIntensityProps {
  emissions: any[];
  enabled: boolean;
}

export default function ProductIntensity({ emissions, enabled }: ProductIntensityProps) {
  const [productIntensities, setProductIntensities] = useState<ProductIntensityType[]>([]);
  const [productionData, setProductionData] = useState<ProductData[]>([]);
  const { toast } = useToast();

  // Get product options from the emissions data
  const getProductOptions = () => {
    const uniqueProducts = new Set<string>();
    
    emissions.forEach(emission => {
      if (emission.product) {
        uniqueProducts.add(emission.product);
      }
    });
    
    return Array.from(uniqueProducts).map(product => ({
      value: product,
      label: product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }));
  };

  // Get year options from the emissions data
  const getYearOptions = () => {
    const uniqueYears = new Set<number>();
    
    emissions.forEach(emission => {
      if (emission.year) {
        uniqueYears.add(emission.year);
      }
    });
    
    return Array.from(uniqueYears)
      .sort((a, b) => a - b)
      .map(year => ({
        value: year.toString(),
        label: year.toString()
      }));
  };

  // Get unit options
  const getUnitOptions = () => {
    return [
      { value: "tonnes", label: "Tonnes" },
      { value: "kg", label: "Kilograms" },
      { value: "units", label: "Units" },
      { value: "hours", label: "Hours" },
      { value: "kwh", label: "kWh" }
    ];
  };

  const productOptions = getProductOptions();
  const yearOptions = getYearOptions();
  const unitOptions = getUnitOptions();

  const intensityMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/product-intensity", {
        emissions,
        productionData
      });
      return response.json();
    },
    onSuccess: (data) => {
      setProductIntensities(data.productIntensities || []);
    },
    onError: (error) => {
      toast({
        title: "Product Intensity Error",
        description: error.message || "Failed to calculate product intensities.",
        variant: "destructive"
      });
    }
  });

  useEffect(() => {
    if (emissions.length > 0 && productionData.length > 0 && enabled) {
      intensityMutation.mutate();
    }
  }, [emissions, productionData, enabled]);

  const addProductionData = () => {
    const defaultProduct = productOptions.length > 0 ? productOptions[0].value : '';
    const defaultYear = yearOptions.length > 0 ? parseInt(yearOptions[0].value) : new Date().getFullYear();
    
    setProductionData([
      ...productionData,
      {
        name: defaultProduct,
        year: defaultYear,
        production: 0,
        unit: 'tonnes'
      }
    ]);
  };

  const removeProductionData = (index: number) => {
    const newData = productionData.filter((_, i) => i !== index);
    setProductionData(newData);
  };

  const updateProductionData = (index: number, field: keyof ProductData, value: string | number) => {
    const newData = [...productionData];
    
    if (field === 'production') {
      newData[index][field] = typeof value === 'string' ? parseFloat(value) || 0 : value;
    } else if (field === 'year') {
      newData[index][field] = typeof value === 'string' ? parseInt(value) : value;
    } else {
      newData[index][field] = value as string;
    }
    
    setProductionData(newData);
  };

  const chartData = {
    labels: productIntensities.map(item => {
      const productName = item.product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return `${productName} (${item.year})`;
    }),
    datasets: [
      {
        label: 'Emissions Intensity',
        data: productIntensities.map(item => item.intensity),
        backgroundColor: productIntensities.map(() => '#3b82f6'),
        borderColor: productIntensities.map(() => '#2563eb'),
        borderWidth: 1
      }
    ]
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top' as const,
      },
      tooltip: {
        callbacks: {
          label: function(context: any) {
            const item = productIntensities[context.dataIndex];
            return `Intensity: ${context.formattedValue} kg CO₂e/${item.unit}`;
          },
          afterLabel: function(context: any) {
            const item = productIntensities[context.dataIndex];
            return [
              `Emissions: ${item.emissions.toFixed(2)} kg CO₂e`,
              `Production: ${item.production.toFixed(2)} ${item.unit}`
            ];
          }
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: 'Emissions Intensity (kg CO₂e/unit)'
        }
      },
      x: {
        title: {
          display: true,
          text: 'Product / Year'
        }
      }
    }
  };

  if (!enabled || (emissions.length === 0 || !emissions.some(e => e.product && e.year))) {
    return (
      <Card className="bg-white mt-6">
        <CardContent className="pt-6 text-center py-12">
          <div className="flex flex-col items-center justify-center text-neutral-500">
            <Factory className="h-12 w-12 mb-3 text-neutral-400" />
            <h3 className="text-lg font-medium mb-2">No Product Data Available</h3>
            <p className="text-sm max-w-md">
              To enable product intensity calculations, please assign products to your emission activities using the "Assign to Product" option in the advanced settings.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-white mt-6">
      <CardContent className="pt-6">
        <h3 className="text-lg font-medium text-neutral-800 mb-4">Product Emissions Intensity</h3>
        
        <div className="mb-6 p-4 border border-neutral-200 rounded-lg bg-neutral-50">
          <h4 className="font-medium text-neutral-700 mb-3">Add Production Data</h4>
          
          <div className="space-y-4">
            {productionData.map((data, index) => (
              <div key={index} className="p-3 border border-neutral-200 rounded-lg bg-white">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div>
                    <Label htmlFor={`product-${index}`} className="mb-1">
                      Product
                    </Label>
                    <Select
                      value={data.name}
                      onValueChange={(value) => updateProductionData(index, "name", value)}
                    >
                      <SelectTrigger id={`product-${index}`}>
                        <SelectValue placeholder="Select product" />
                      </SelectTrigger>
                      <SelectContent>
                        {productOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`year-${index}`} className="mb-1">
                      Year
                    </Label>
                    <Select
                      value={data.year.toString()}
                      onValueChange={(value) => updateProductionData(index, "year", parseInt(value))}
                    >
                      <SelectTrigger id={`year-${index}`}>
                        <SelectValue placeholder="Select year" />
                      </SelectTrigger>
                      <SelectContent>
                        {yearOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`production-${index}`} className="mb-1">
                      Production Volume
                    </Label>
                    <Input
                      id={`production-${index}`}
                      type="number"
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      value={data.production || ""}
                      onChange={(e) => updateProductionData(index, "production", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`unit-${index}`} className="mb-1">
                      Unit
                    </Label>
                    <Select
                      value={data.unit}
                      onValueChange={(value) => updateProductionData(index, "unit", value)}
                    >
                      <SelectTrigger id={`unit-${index}`}>
                        <SelectValue placeholder="Select unit" />
                      </SelectTrigger>
                      <SelectContent>
                        {unitOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-neutral-500 hover:text-red-500"
                    onClick={() => removeProductionData(index)}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
          
          <Button
            variant="ghost"
            className="mt-4 text-primary-700 hover:bg-primary-50"
            onClick={addProductionData}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Production Data
          </Button>
          
          {productionData.length > 0 && (
            <Button
              className="mt-4 ml-2"
              onClick={() => intensityMutation.mutate()}
              disabled={intensityMutation.isPending}
            >
              {intensityMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Calculate Intensity
            </Button>
          )}
        </div>
        
        {intensityMutation.isPending ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
            <span className="ml-2">Calculating product intensities...</span>
          </div>
        ) : productIntensities.length > 0 ? (
          <>
            <div className="h-72 mb-6">
              <Bar data={chartData} options={chartOptions} />
            </div>
            
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-neutral-200">
                <thead className="bg-neutral-50">
                  <tr>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Product</th>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Year</th>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Emissions (kg CO₂e)</th>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Production</th>
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Intensity (kg CO₂e/unit)</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-neutral-200">
                  {productIntensities.map((item, index) => (
                    <tr key={index} className={index % 2 === 0 ? 'bg-white' : 'bg-neutral-50'}>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-neutral-800">
                        {item.product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-neutral-600">{item.year}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-neutral-600">
                        {item.emissions.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-neutral-600">
                        {item.production.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} {item.unit}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-neutral-800">
                        {item.intensity.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-neutral-500">
            <p>No intensity data available. Add production data and calculate to see results.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { YearlyEmissions } from "@/types/emissions";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, FileBarChart } from "lucide-react";
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  BarElement
} from 'chart.js';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
);

interface YearlyComparisonProps {
  emissions: any[];
  enabled: boolean;
}

export default function YearlyComparison({ emissions, enabled }: YearlyComparisonProps) {
  const [yearlyData, setYearlyData] = useState<YearlyEmissions[]>([]);
  const [totalIncreasePercent, setTotalIncreasePercent] = useState<number | null>(null);
  const { toast } = useToast();

  const yearlyComparisonMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/yearly-comparison", {
        emissions
      });
      return response.json();
    },
    onSuccess: (data) => {
      setYearlyData(data.yearlyEmissions || []);
      calculateTrend(data.yearlyEmissions || []);
    },
    onError: (error) => {
      toast({
        title: "Comparison Error",
        description: error.message || "Failed to generate yearly comparison.",
        variant: "destructive"
      });
    }
  });

  useEffect(() => {
    if (emissions.length > 0 && enabled) {
      yearlyComparisonMutation.mutate();
    }
  }, [emissions, enabled]);

  const calculateTrend = (data: YearlyEmissions[]) => {
    if (data.length < 2) {
      setTotalIncreasePercent(null);
      return;
    }

    const firstYear = data[0];
    const lastYear = data[data.length - 1];
    
    if (firstYear.total === 0) {
      setTotalIncreasePercent(null);
      return;
    }
    
    const percentChange = ((lastYear.total - firstYear.total) / firstYear.total) * 100;
    setTotalIncreasePercent(percentChange);
  };

  const chartData = {
    labels: yearlyData.map(item => item.year.toString()),
    datasets: [
      {
        label: 'Scope 1',
        data: yearlyData.map(item => item.scope1),
        borderColor: '#e53935',
        backgroundColor: 'rgba(229, 57, 53, 0.1)',
        borderWidth: 2,
        fill: false,
        tension: 0.1
      },
      {
        label: 'Scope 2',
        data: yearlyData.map(item => item.scope2),
        borderColor: '#0277bd',
        backgroundColor: 'rgba(2, 119, 189, 0.1)',
        borderWidth: 2,
        fill: false,
        tension: 0.1
      },
      {
        label: 'Scope 3',
        data: yearlyData.map(item => item.scope3),
        borderColor: '#2e7d32',
        backgroundColor: 'rgba(46, 125, 50, 0.1)',
        borderWidth: 2,
        fill: false,
        tension: 0.1
      },
      {
        label: 'Total',
        data: yearlyData.map(item => item.total),
        borderColor: '#6200ea',
        backgroundColor: 'rgba(98, 0, 234, 0.1)',
        borderWidth: 3,
        fill: false,
        tension: 0.1
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
            return `${context.dataset.label}: ${context.formattedValue} kg CO₂e`;
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
          text: 'Year'
        }
      }
    }
  };

  if (yearlyComparisonMutation.isPending) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        <span className="ml-2">Generating yearly comparison...</span>
      </div>
    );
  }

  if (!enabled || yearlyData.length === 0) {
    return (
      <Card className="bg-white mt-6">
        <CardContent className="pt-6 text-center py-12">
          <div className="flex flex-col items-center justify-center text-neutral-500">
            <FileBarChart className="h-12 w-12 mb-3 text-neutral-400" />
            <h3 className="text-lg font-medium mb-2">No Yearly Data Available</h3>
            <p className="text-sm max-w-md">
              To enable yearly comparison, please add year information to your emission activities using the "Track by Year" option in the advanced settings.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-white mt-6">
      <CardContent className="pt-6">
        <h3 className="text-lg font-medium text-neutral-800 mb-4">Yearly Emissions Comparison</h3>
        
        <div className="mb-4">
          {totalIncreasePercent !== null && (
            <div className="flex items-center mb-4 p-3 bg-neutral-50 rounded-md">
              <div className={`rounded-full p-2 mr-3 ${totalIncreasePercent > 0 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                {totalIncreasePercent > 0 ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 9-6-6-6 6"/><path d="M12 3v18"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6 6-6-6"/><path d="M12 3v18"/></svg>
                )}
              </div>
              <div>
                <p className="font-medium">
                  {totalIncreasePercent > 0 ? (
                    <span className="text-red-600">{totalIncreasePercent.toFixed(1)}% increase</span>
                  ) : (
                    <span className="text-green-600">{Math.abs(totalIncreasePercent).toFixed(1)}% decrease</span>
                  )}
                </p>
                <p className="text-sm text-neutral-600">
                  in total emissions from {yearlyData[0].year} to {yearlyData[yearlyData.length - 1].year}
                </p>
              </div>
            </div>
          )}
        </div>
        
        <div className="h-72">
          <Line data={chartData} options={chartOptions} />
        </div>
        
        <div className="mt-6 overflow-x-auto">
          <table className="min-w-full divide-y divide-neutral-200">
            <thead className="bg-neutral-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Year</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Scope 1</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Scope 2</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Scope 3</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Total</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-neutral-200">
              {yearlyData.map((yearly, index) => (
                <tr key={index} className={index % 2 === 0 ? 'bg-white' : 'bg-neutral-50'}>
                  <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-neutral-800">{yearly.year}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-neutral-600">
                    {yearly.scope1.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-neutral-600">
                    {yearly.scope2.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-neutral-600">
                    {yearly.scope3.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-neutral-800">
                    {yearly.total.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
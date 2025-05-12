import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import FileUpload from "@/components/FileUpload";
import ScopeInput from "@/components/ScopeInput";
import ResultsView from "@/components/ResultsView";
import { EmissionFactor, EmissionInput, ScopeType, Emission } from "@/types/emissions";
import { 
  Home as HomeIcon, 
  Zap as ZapIcon, 
  Globe as GlobeIcon, 
  BarChart as BarChartIcon 
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function EmissionCalculator() {
  const [emissionFactors, setEmissionFactors] = useState<Record<string, EmissionFactor>>({});
  const [inputs, setInputs] = useState<Record<ScopeType, EmissionInput[]>>({
    scope1: [],
    scope2: [],
    scope3: []
  });
  const [results, setResults] = useState<Record<ScopeType, number>>({
    scope1: 0,
    scope2: 0,
    scope3: 0
  });
  const [calculatedEmissions, setCalculatedEmissions] = useState<Emission[]>([]);
  const [activeTab, setActiveTab] = useState<string>("scope1");
  const { toast } = useToast();

  const calculateMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/calculate", {
        inputs,
        emissionFactors
      });
      return response.json();
    },
    onSuccess: (data) => {
      setResults(data.results);
      setCalculatedEmissions(data.emissions);

      // If the user is on any scope tab, show the results tab after calculation
      if (activeTab !== "results") {
        setActiveTab("results");
      }
    },
    onError: (error) => {
      toast({
        title: "Calculation Error",
        description: error.message || "Failed to calculate emissions. Please try again.",
        variant: "destructive"
      });
    }
  });

  const handleFactorsUploaded = (factors: Record<string, EmissionFactor>) => {
    setEmissionFactors(factors);
    toast({
      title: "Success",
      description: "Emission factors loaded successfully!",
      variant: "default"
    });
  };

  const handleInputChange = (scope: ScopeType, inputs: EmissionInput[]) => {
    setInputs(prevInputs => ({
      ...prevInputs,
      [scope]: inputs
    }));
  };

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    
    // If user switches to results tab, calculate emissions
    if (value === "results") {
      calculateMutation.mutate();
    }
  };

  return (
    <div className="space-y-6">
      <FileUpload onFactorsUploaded={handleFactorsUploaded} />
      
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="scope1" className="flex items-center gap-1">
            <HomeIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Scope 1</span>
            <span className="inline sm:hidden">1</span>
          </TabsTrigger>
          <TabsTrigger value="scope2" className="flex items-center gap-1">
            <ZapIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Scope 2</span>
            <span className="inline sm:hidden">2</span>
          </TabsTrigger>
          <TabsTrigger value="scope3" className="flex items-center gap-1">
            <GlobeIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Scope 3</span>
            <span className="inline sm:hidden">3</span>
          </TabsTrigger>
          <TabsTrigger value="results" className="flex items-center gap-1">
            <BarChartIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Results</span>
            <span className="inline sm:hidden">Results</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scope1" className="space-y-4">
          <ScopeInput 
            title="Scope 1 Emissions" 
            description="Direct emissions from owned or controlled sources"
            scope="scope1"
            inputs={inputs.scope1}
            emissionFactors={emissionFactors}
            onChange={(newInputs) => handleInputChange("scope1", newInputs)}
          />
        </TabsContent>

        <TabsContent value="scope2" className="space-y-4">
          <ScopeInput 
            title="Scope 2 Emissions" 
            description="Indirect emissions from the generation of purchased energy"
            scope="scope2"
            inputs={inputs.scope2}
            emissionFactors={emissionFactors}
            onChange={(newInputs) => handleInputChange("scope2", newInputs)}
          />
        </TabsContent>

        <TabsContent value="scope3" className="space-y-4">
          <ScopeInput 
            title="Scope 3 Emissions" 
            description="Indirect emissions from the value chain (not included in scope 2)"
            scope="scope3"
            inputs={inputs.scope3}
            emissionFactors={emissionFactors}
            onChange={(newInputs) => handleInputChange("scope3", newInputs)}
          />
        </TabsContent>

        <TabsContent value="results" className="space-y-4">
          <ResultsView 
            results={results} 
            emissions={calculatedEmissions}
            isLoading={calculateMutation.isPending}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

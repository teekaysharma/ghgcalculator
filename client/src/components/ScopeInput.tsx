import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmissionFactor, EmissionInput, ScopeType } from "@/types/emissions";
import { Plus, Trash2, Calendar, Package, Trash, Sparkles, ListChecks, CircleGauge } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";

interface ScopeInputProps {
  title: string;
  description: string;
  scope: ScopeType;
  inputs: EmissionInput[];
  emissionFactors: Record<string, EmissionFactor>;
  onChange: (inputs: EmissionInput[]) => void;
}


const SCOPE3_CATEGORIES = [
  "Category 1: Purchased Goods and Services",
  "Category 2: Capital Goods",
  "Category 3: Fuel- and Energy-Related Activities",
  "Category 4: Upstream Transportation and Distribution",
  "Category 5: Waste Generated in Operations",
  "Category 6: Business Travel",
  "Category 7: Employee Commuting",
  "Category 8: Upstream Leased Assets",
  "Category 9: Downstream Transportation and Distribution",
  "Category 10: Processing of Sold Products",
  "Category 11: Use of Sold Products",
  "Category 12: End-of-Life Treatment of Sold Products",
  "Category 13: Downstream Leased Assets",
  "Category 14: Franchises",
  "Category 15: Investments",
];

export default function ScopeInput({
  title,
  description,
  scope,
  inputs,
  emissionFactors,
  onChange
}: ScopeInputProps) {
  const [localInputs, setLocalInputs] = useState<EmissionInput[]>(inputs);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showYearInput, setShowYearInput] = useState(false);
  const [showProductInput, setShowProductInput] = useState(false);
  const [showWasteInput, setShowWasteInput] = useState(false);

  useEffect(() => {
    setLocalInputs(inputs);
  }, [inputs]);

  const addInput = () => {
    const newInputs = [
      ...localInputs,
      { 
        activity: "", 
        unit: "", 
        qty: 0, 
        year: undefined, 
        product: undefined,
        wasteType: undefined,
        disposalMethod: undefined
      }
    ];
    setLocalInputs(newInputs);
    onChange(newInputs);
  };

  const removeInput = (index: number) => {
    const newInputs = localInputs.filter((_, i) => i !== index);
    setLocalInputs(newInputs);
    onChange(newInputs);
  };

  const updateInput = (index: number, field: keyof EmissionInput, value: string | number | undefined) => {
    const newInputs = [...localInputs];
    
    if (field === 'qty') {
      newInputs[index][field] = typeof value === 'string' ? parseFloat(value) || 0 : (value as number);
    } else if (field === 'year') {
      newInputs[index][field] = value !== undefined ? 
        (typeof value === 'string' ? parseInt(value) : (value as number)) : 
        undefined;
    } else {
      newInputs[index][field] = value as string;
    }
    
    setLocalInputs(newInputs);
    onChange(newInputs);
  };

  // Get activity options based on scope
  const getActivityOptions = () => {
    // Filter activities by scope prefix or no scope prefix
    const activities = Object.entries(emissionFactors)
      .filter(([key, factor]) => {
        // If the factor has a scope prefix
        if (key.startsWith('scope1_') || key.startsWith('scope2_') || key.startsWith('scope3_')) {
          // Only include if it matches the current scope
          return key.startsWith(`${scope}_`);
        } else {
          // For backwards compatibility, include factors with no scope prefix
          return true;
        }
      })
      .map(([key, factor]) => {
        // Remove scope prefix for display
        const displayKey = key.replace(/^scope[123]_/, '');
        const hierarchyDisplay = factor.hierarchy && factor.hierarchy.length > 0
          ? factor.hierarchy.join(" > ")
          : undefined;
        const displayName = hierarchyDisplay || factor.name || displayKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        
        // Add unit to display name if available
        const unitDisplay = factor.unit ? ` (${factor.unit})` : '';
        
        // Format the label with additional useful information
        const yearDisplay = factor.year ? ` • ${factor.year}` : "";
        const sourceDisplay = factor.source ? ` • ${factor.source}` : "";

        return {
          value: key,
          label: `${displayName}${unitDisplay}${yearDisplay}${sourceDisplay}`,
          unit: factor.unit, // Make unit available for auto-selection
          year: factor.year,
          category: factor.category,
        };
      });
    
    // Sort alphabetically
    activities.sort((a, b) => a.label.localeCompare(b.label));
    
    return activities;
  };

  // Get unit options
  const getUnitOptions = () => {
    // Get unique units from emission factors
    const uniqueUnits = new Set<string>();
    
    Object.values(emissionFactors).forEach(factor => {
      if (factor.unit) {
        uniqueUnits.add(factor.unit);
      }
    });
    
    // Add the units from the emission factors
    const unitOptions = Array.from(uniqueUnits).map(unit => ({
      value: unit,
      label: unit
    }));
    
    // Add common units if they're not already included
    const commonUnits = [
      { value: "m3", label: "m³" },
      { value: "liters", label: "Liters" },
      { value: "kg", label: "kg" },
      { value: "t", label: "tonnes" },
      { value: "tonne", label: "tonnes" },
      { value: "tonnes", label: "tonnes" },
      { value: "gallons", label: "Gallons" },
      { value: "kWh", label: "kWh" },
      { value: "MWh", label: "MWh" },
      { value: "GJ", label: "GJ" },
      { value: "TJ", label: "TJ" },
      { value: "miles", label: "Miles" },
      { value: "km", label: "Kilometers" },
      { value: "passenger-km", label: "Passenger-km" },
      { value: "tonne-km", label: "Tonne-km" },
      { value: "scf", label: "Standard Cubic Feet" },
      { value: "unit", label: "Unit" },
      { value: "head", label: "Head (Livestock)" },
      { value: "hour", label: "Hour" },
      { value: "day", label: "Day" },
      { value: "month", label: "Month" },
      { value: "year", label: "Year" }
    ];
    
    // Add common units if they're not already included
    for (const unit of commonUnits) {
      if (!unitOptions.some(u => u.value.toLowerCase() === unit.value.toLowerCase())) {
        unitOptions.push(unit);
      }
    }
    
    // Sort alphabetically
    return unitOptions.sort((a, b) => a.label.localeCompare(b.label));
  };

  // Get year options
  const getYearOptions = () => {
    const currentYear = new Date().getFullYear();
    const years = [];
    
    for (let year = 2015; year <= currentYear; year++) {
      years.push({ value: year.toString(), label: year.toString() });
    }
    
    return years;
  };

  // Get product options
  const getProductOptions = () => {
    return [
      { value: "product_a", label: "Product A" },
      { value: "product_b", label: "Product B" },
      { value: "product_c", label: "Product C" },
      { value: "service_a", label: "Service A" },
      { value: "service_b", label: "Service B" }
    ];
  };
  
  // Get waste type options from emission factors
  const getWasteTypeOptions = () => {
    const wasteTypes = new Set<string>();
    
    // Extract waste types from emission factors, filtering by scope
    Object.entries(emissionFactors).forEach(([key, factor]) => {
      // Only include waste factors from the current scope or with no scope prefix
      if (factor.wasteType) {
        if (key.startsWith(`${scope}_`) || 
            !(key.startsWith('scope1_') || key.startsWith('scope2_') || key.startsWith('scope3_'))) {
          wasteTypes.add(factor.wasteType);
        }
      }
    });
    
    // If no waste types in emission factors, provide defaults
    if (wasteTypes.size === 0) {
      return [
        { value: "paper", label: "Paper & Cardboard" },
        { value: "plastic", label: "Plastic" },
        { value: "glass", label: "Glass" },
        { value: "metal", label: "Metal" },
        { value: "food", label: "Food Waste" },
        { value: "ewaste", label: "Electronic Waste" },
        { value: "other", label: "Other Waste" }
      ];
    }
    
    return Array.from(wasteTypes).map(type => ({
      value: type,
      label: type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }));
  };
  
  // Get disposal method options for a selected waste type
  const getDisposalMethodOptions = (wasteType?: string) => {
    if (!wasteType) {
      return [
        { value: "landfill", label: "Landfill" },
        { value: "recycling", label: "Recycling" },
        { value: "incineration", label: "Incineration" },
        { value: "composting", label: "Composting" }
      ];
    }
    
    const methods = new Set<string>();
    
    // Find disposal methods for this waste type from emission factors, filtering by scope
    Object.entries(emissionFactors).forEach(([key, factor]) => {
      // Only include waste factors from the current scope or with no scope prefix
      if (factor.wasteType === wasteType && factor.disposalMethod) {
        if (key.startsWith(`${scope}_`) || 
            !(key.startsWith('scope1_') || key.startsWith('scope2_') || key.startsWith('scope3_'))) {
          methods.add(factor.disposalMethod);
        }
      }
    });
    
    // If no methods found for this waste type, return generic options
    if (methods.size === 0) {
      return [
        { value: "landfill", label: "Landfill" },
        { value: "recycling", label: "Recycling" },
        { value: "incineration", label: "Incineration" },
        { value: "composting", label: "Composting" }
      ];
    }
    
    return Array.from(methods).map(method => ({
      value: method,
      label: method.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }));
  };

  const activityOptions = getActivityOptions();
  const unitOptions = getUnitOptions();
  const yearOptions = getYearOptions();
  const productOptions = getProductOptions();
  const wasteTypeOptions = getWasteTypeOptions();

  const completedRows = localInputs.filter((item) => item.activity && item.unit && (item.qty || 0) > 0).length;
  const totalQuantity = localInputs.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);

  const applyQtyPreset = (index: number, qty: number) => {
    updateInput(index, "qty", qty);
  };

  useEffect(() => {
    // If there are no inputs, add one by default
    if (localInputs.length === 0) {
      addInput();
    }
  }, []);

  const toggleShowYear = () => {
    setShowYearInput(!showYearInput);
    if (showYearInput) {
      // Remove years from all inputs when disabling
      const newInputs = localInputs.map(input => ({
        ...input,
        year: undefined
      }));
      setLocalInputs(newInputs);
      onChange(newInputs);
    }
  };

  const toggleShowProduct = () => {
    setShowProductInput(!showProductInput);
    if (showProductInput) {
      // Remove products from all inputs when disabling
      const newInputs = localInputs.map(input => ({
        ...input,
        product: undefined
      }));
      setLocalInputs(newInputs);
      onChange(newInputs);
    }
  };
  
  const toggleShowWaste = () => {
    setShowWasteInput(!showWasteInput);
    if (showWasteInput) {
      // Remove waste data from all inputs when disabling
      const newInputs = localInputs.map(input => ({
        ...input,
        wasteType: undefined,
        disposalMethod: undefined
      }));
      setLocalInputs(newInputs);
      onChange(newInputs);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-100 bg-gradient-to-r from-emerald-50 to-white p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-heading font-semibold text-neutral-800">{title}</h2>
            <p className="text-neutral-600">{description}</p>
            <p className="mt-1 text-xs text-neutral-500">Choose an activity, confirm unit, and enter quantity. We auto-fill defaults where possible.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
              <ListChecks className="mr-1 h-3.5 w-3.5" />
              Completed {completedRows}/{Math.max(localInputs.length, 1)}
            </Badge>
            <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
              <CircleGauge className="mr-1 h-3.5 w-3.5" />
              Total Qty: {totalQuantity.toLocaleString()}
            </Badge>
            <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700">
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              {activityOptions.length} factors available
            </Badge>
          </div>
        </div>
      </div>

      <Card className="border-slate-200 bg-white shadow-sm">
        <CardContent className="pt-6">
          {/* Advanced options toggle */}
          <Collapsible 
            open={showAdvanced} 
            onOpenChange={setShowAdvanced}
            className="mb-4 space-y-2"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-neutral-700">Advanced Options</h3>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="text-neutral-500 p-0 h-8 w-8">
                  <span className="sr-only">Toggle</span>
                  {showAdvanced ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  )}
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border border-neutral-200 rounded-lg p-4 bg-neutral-50">
                <div className="flex items-center space-x-3">
                  <Switch 
                    id="use-year" 
                    checked={showYearInput}
                    onCheckedChange={toggleShowYear}
                  />
                  <div className="grid gap-1.5 leading-none">
                    <Label 
                      htmlFor="use-year" 
                      className="flex items-center text-sm font-medium leading-none text-neutral-700"
                    >
                      <Calendar className="h-4 w-4 mr-1" />
                      Track by Year
                    </Label>
                    <p className="text-xs text-neutral-500">
                      Enable to compare emissions across different years
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                  <Switch 
                    id="use-product" 
                    checked={showProductInput}
                    onCheckedChange={toggleShowProduct}
                  />
                  <div className="grid gap-1.5 leading-none">
                    <Label 
                      htmlFor="use-product" 
                      className="flex items-center text-sm font-medium leading-none text-neutral-700"
                    >
                      <Package className="h-4 w-4 mr-1" />
                      Assign to Product
                    </Label>
                    <p className="text-xs text-neutral-500">
                      Enable to calculate emissions per product
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                  <Switch 
                    id="use-waste" 
                    checked={showWasteInput}
                    onCheckedChange={toggleShowWaste}
                  />
                  <div className="grid gap-1.5 leading-none">
                    <Label 
                      htmlFor="use-waste" 
                      className="flex items-center text-sm font-medium leading-none text-neutral-700"
                    >
                      <Trash className="h-4 w-4 mr-1" />
                      Waste Management
                    </Label>
                    <p className="text-xs text-neutral-500">
                      Enable to analyze emissions by waste type and disposal method
                    </p>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="space-y-4">
            {localInputs.map((input, index) => (
              <div key={index} className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 transition-colors hover:border-emerald-200 hover:bg-emerald-50/30">
                <div className="mb-3 flex items-center justify-between">
                  <Badge variant="secondary" className="bg-white text-slate-700 border border-slate-200">Activity #{index + 1}</Badge>
                  {input.activity && (input.qty || 0) > 0 ? (
                    <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">Ready</Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">Needs input</Badge>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <Label htmlFor={`activity-${scope}-${index}`} className="mb-1">
                      Activity Type
                    </Label>
                    <Select
                      value={input.activity}
                      onValueChange={(value) => {
                        updateInput(index, "activity", value);
                        // Auto-set unit based on emission factor's unit if available
                        const selectedActivity = activityOptions.find(option => option.value === value);
                        if (selectedActivity && selectedActivity.unit) {
                          updateInput(index, "unit", selectedActivity.unit);
                        }
                        if (selectedActivity?.year && !localInputs[index]?.year) {
                          setShowYearInput(true);
                          updateInput(index, "year", selectedActivity.year);
                        }
                        if (scope === "scope3" && selectedActivity?.category) {
                          updateInput(index, "scope3Category", selectedActivity.category);
                        }
                      }}
                    >
                      <SelectTrigger id={`activity-${scope}-${index}`}>
                        <SelectValue placeholder="Select activity" />
                      </SelectTrigger>
                      <SelectContent>
                        {activityOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`unit-${scope}-${index}`} className="mb-1">
                      Unit
                    </Label>
                    <Select
                      value={input.unit}
                      onValueChange={(value) => updateInput(index, "unit", value)}
                    >
                      <SelectTrigger id={`unit-${scope}-${index}`}>
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
                  <div>
                    <Label htmlFor={`qty-${scope}-${index}`} className="mb-1">
                      Quantity
                    </Label>
                    <Input
                      id={`qty-${scope}-${index}`}
                      type="number"
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      value={input.qty || ""}
                      onChange={(e) => updateInput(index, "qty", e.target.value)}
                    />
                    <div className="mt-2 flex items-center gap-2 text-xs">
                      <span className="text-neutral-500">Quick set:</span>
                      {[1, 10, 100].map((preset) => (
                        <Button
                          key={`${scope}-${index}-${preset}`}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => applyQtyPreset(index, preset)}
                        >
                          {preset}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                {scope === "scope3" && (
                  <div className="mt-4">
                    <Label htmlFor={`scope3-category-${scope}-${index}`} className="mb-1">
                      Scope 3 Category
                    </Label>
                    <Select
                      value={input.scope3Category}
                      onValueChange={(value) => updateInput(index, "scope3Category", value)}
                    >
                      <SelectTrigger id={`scope3-category-${scope}-${index}`}>
                        <SelectValue placeholder="Select Scope 3 category (optional)" />
                      </SelectTrigger>
                      <SelectContent>
                        {SCOPE3_CATEGORIES.map((category) => (
                          <SelectItem key={category} value={category}>
                            {category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Conditional advanced fields */}
                {(showYearInput || showProductInput || showWasteInput) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 pt-4 border-t border-neutral-200">
                    {showYearInput && (
                      <div>
                        <Label htmlFor={`year-${scope}-${index}`} className="mb-1 flex items-center">
                          <Calendar className="h-4 w-4 mr-1" />
                          Year
                        </Label>
                        <Select
                          value={input.year?.toString()}
                          onValueChange={(value) => updateInput(index, "year", value ? parseInt(value) : undefined)}
                        >
                          <SelectTrigger id={`year-${scope}-${index}`}>
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
                    )}
                    
                    {showProductInput && (
                      <div>
                        <Label htmlFor={`product-${scope}-${index}`} className="mb-1 flex items-center">
                          <Package className="h-4 w-4 mr-1" />
                          Product
                        </Label>
                        <Select
                          value={input.product}
                          onValueChange={(value) => updateInput(index, "product", value)}
                        >
                          <SelectTrigger id={`product-${scope}-${index}`}>
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
                    )}
                    
                    {/* Waste type and disposal method fields */}
                    {showWasteInput && (
                      <>
                        <div>
                          <Label htmlFor={`waste-type-${scope}-${index}`} className="mb-1 flex items-center">
                            <Trash className="h-4 w-4 mr-1" />
                            Waste Type
                          </Label>
                          <Select
                            value={input.wasteType}
                            onValueChange={(value) => updateInput(index, "wasteType", value)}
                          >
                            <SelectTrigger id={`waste-type-${scope}-${index}`}>
                              <SelectValue placeholder="Select waste type" />
                            </SelectTrigger>
                            <SelectContent>
                              {wasteTypeOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        
                        <div>
                          <Label htmlFor={`disposal-method-${scope}-${index}`} className="mb-1 flex items-center">
                            <Trash2 className="h-4 w-4 mr-1" />
                            Disposal Method
                          </Label>
                          <Select
                            value={input.disposalMethod}
                            onValueChange={(value) => updateInput(index, "disposalMethod", value)}
                          >
                            <SelectTrigger id={`disposal-method-${scope}-${index}`}>
                              <SelectValue placeholder="Select disposal method" />
                            </SelectTrigger>
                            <SelectContent>
                              {getDisposalMethodOptions(input.wasteType).map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="mt-3 flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-neutral-500 hover:text-red-500"
                    onClick={() => removeInput(index)}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
          
          <Button
            variant="outline"
            className="mt-4 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            onClick={addInput}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Activity
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

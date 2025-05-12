import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { generateCSV } from "./utils/csv";
import { Emission, ProductData, YearlyEmissions, ProductIntensity } from "../shared/schema";

export async function registerRoutes(app: Express): Promise<Server> {
  // Calculate emissions endpoint
  app.post("/api/calculate", (req, res) => {
    try {
      const { inputs, emissionFactors } = req.body;
      
      if (!inputs || !emissionFactors) {
        return res.status(400).json({ message: "Missing inputs or emission factors" });
      }
      
      const results = { scope1: 0, scope2: 0, scope3: 0 };
      const emissions: Emission[] = [];
      
      // Calculate emissions for each scope
      for (const scope of ['scope1', 'scope2', 'scope3'] as const) {
        for (const input of inputs[scope]) {
          // Skip incomplete entries
          if (!input.activity || !input.unit || !input.qty) continue;
          
          const factor = emissionFactors[input.activity]?.factor || 0;
          const emission = factor * input.qty;
          
          results[scope] += emission;
          
          emissions.push({
            scope: scope,
            activity: input.activity,
            unit: input.unit,
            quantity: input.qty,
            factor,
            emission,
            year: input.year,
            product: input.product
          });
        }
      }
      
      return res.json({ 
        results, 
        emissions 
      });
    } catch (error) {
      console.error("Calculation error:", error);
      return res.status(500).json({ message: "Failed to calculate emissions" });
    }
  });
  
  // Download CSV endpoint
  app.post("/api/download-csv", (req, res) => {
    try {
      const { emissions } = req.body;
      
      if (!emissions || !Array.isArray(emissions)) {
        return res.status(400).json({ message: "Invalid emissions data" });
      }
      
      const csv = generateCSV(emissions);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=GHG_Emissions_Report.csv');
      
      return res.send(csv);
    } catch (error) {
      console.error("CSV generation error:", error);
      return res.status(500).json({ message: "Failed to generate CSV" });
    }
  });

  // Calculate yearly comparison
  app.post("/api/yearly-comparison", (req, res) => {
    try {
      const { emissions } = req.body;
      
      if (!emissions || !Array.isArray(emissions)) {
        return res.status(400).json({ message: "Invalid emissions data" });
      }
      
      // Group emissions by year
      const yearlyEmissionsMap = new Map<number, YearlyEmissions>();
      
      for (const emission of emissions) {
        if (!emission.year) continue;
        
        const year = emission.year;
        if (!yearlyEmissionsMap.has(year)) {
          yearlyEmissionsMap.set(year, {
            year,
            scope1: 0,
            scope2: 0,
            scope3: 0,
            total: 0
          });
        }
        
        const yearData = yearlyEmissionsMap.get(year)!;
        // Type-safe update of the appropriate scope
        if (emission.scope === 'scope1') yearData.scope1 += emission.emission;
        else if (emission.scope === 'scope2') yearData.scope2 += emission.emission;
        else if (emission.scope === 'scope3') yearData.scope3 += emission.emission;
        
        yearData.total += emission.emission;
      }
      
      // Convert map to array for response
      const yearlyEmissions = Array.from(yearlyEmissionsMap.values())
        .sort((a, b) => a.year - b.year);
      
      return res.json({ yearlyEmissions });
    } catch (error) {
      console.error("Yearly comparison error:", error);
      return res.status(500).json({ message: "Failed to calculate yearly comparison" });
    }
  });

  // Calculate emissions intensity per product
  app.post("/api/product-intensity", (req, res) => {
    try {
      const { emissions, productionData } = req.body;
      
      if (!emissions || !Array.isArray(emissions) || !productionData || !Array.isArray(productionData)) {
        return res.status(400).json({ message: "Invalid emissions or production data" });
      }
      
      // Calculate total emissions per product per year
      const productEmissionsMap = new Map<string, Map<number, number>>();
      
      for (const emission of emissions) {
        if (!emission.product || !emission.year) continue;
        
        const key = emission.product;
        if (!productEmissionsMap.has(key)) {
          productEmissionsMap.set(key, new Map<number, number>());
        }
        
        const yearMap = productEmissionsMap.get(key)!;
        const year = emission.year;
        
        if (!yearMap.has(year)) {
          yearMap.set(year, 0);
        }
        
        yearMap.set(year, yearMap.get(year)! + emission.emission);
      }
      
      // Calculate intensity
      const productIntensities: ProductIntensity[] = [];
      
      for (const productData of productionData as ProductData[]) {
        const { name, year, production, unit } = productData;
        
        if (!productEmissionsMap.has(name) || !productEmissionsMap.get(name)!.has(year)) {
          continue;
        }
        
        const emissions = productEmissionsMap.get(name)!.get(year)!;
        const intensity = production > 0 ? emissions / production : 0;
        
        productIntensities.push({
          product: name,
          year,
          emissions,
          production,
          intensity,
          unit
        });
      }
      
      return res.json({ productIntensities });
    } catch (error) {
      console.error("Product intensity error:", error);
      return res.status(500).json({ message: "Failed to calculate product intensities" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}

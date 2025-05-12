import { useState } from "react";
import EmissionCalculator from "@/components/EmissionCalculator";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default function Home() {
  return (
    <div className="min-h-screen bg-neutral-50 font-sans">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Header */}
        <header className="mb-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6">
            <div>
              <h1 className="font-heading font-bold text-3xl md:text-4xl text-primary-800 mb-2 font-work-sans">
                GHG Emissions Calculator
              </h1>
              <p className="text-neutral-600">
                Track, calculate, and visualize your carbon footprint
              </p>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main>
          <EmissionCalculator />
        </main>

        {/* Footer */}
        <footer className="mt-10 pt-6 border-t border-neutral-200 text-neutral-600 text-sm">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <p>GHG Emissions Calculator &copy; {new Date().getFullYear()} | All rights reserved</p>
            <div className="mt-4 md:mt-0">
              <a href="#" className="text-primary-600 hover:text-primary-800 mr-4">
                Privacy Policy
              </a>
              <a href="#" className="text-primary-600 hover:text-primary-800">
                Help & Support
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

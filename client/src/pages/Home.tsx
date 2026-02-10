import EmissionCalculator from "@/components/EmissionCalculator";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Leaf, LineChart, UploadCloud, ShieldCheck, Sparkles } from "lucide-react";

const highlights = [
  {
    title: "Emission Intelligence",
    description: "Track Scope 1, 2, and 3 emissions from one workspace with structured entries.",
    icon: LineChart,
  },
  {
    title: "Fast Data Onboarding",
    description: "Upload Excel-based emission factors with flexible column mappings.",
    icon: UploadCloud,
  },
  {
    title: "Audit-Ready Outputs",
    description: "Export normalized results and maintain transparent calculation logic.",
    icon: ShieldCheck,
  },
];

const quickSteps = [
  "Upload your emission factor workbook",
  "Add activity data by scope",
  "Review insights and export your report",
];

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 via-slate-50 to-white text-slate-800">
      <header className="sticky top-0 z-10 border-b border-emerald-100/80 bg-white/85 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-700">
              <Leaf className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Sustainability Platform</p>
              <h1 className="text-lg font-semibold text-slate-900">GHG Emissions Calculator</h1>
            </div>
          </div>
          <Badge variant="secondary" className="border border-emerald-200 bg-emerald-50 text-emerald-700">
            Carbon Analytics Workspace
          </Badge>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl space-y-8 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <section className="grid gap-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:grid-cols-[1.2fr_1fr] lg:p-8">
          <div className="space-y-4">
            <p className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-emerald-700">
              <Sparkles className="h-3.5 w-3.5" />
              Guided Carbon Workflow
            </p>
            <h2 className="text-3xl font-bold leading-tight text-slate-900 sm:text-4xl">
              A calmer, clearer workspace for emissions tracking and reporting.
            </h2>
            <p className="max-w-2xl text-slate-600">
              This redesigned layout is tuned for readability: softer colors, cleaner spacing, and a simple flow your team
              can follow from data upload to final report.
            </p>
            <div className="grid gap-2 pt-2 text-sm text-slate-700 sm:grid-cols-3">
              {quickSteps.map((step, index) => (
                <div key={step} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <span className="mr-2 font-semibold text-emerald-700">{index + 1}.</span>
                  {step}
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {highlights.map((item) => {
              const Icon = item.icon;
              return (
                <Card key={item.title} className="border-emerald-100 bg-emerald-50/50 shadow-none">
                  <CardContent className="p-4">
                    <Icon className="mb-2 h-5 w-5 text-emerald-700" />
                    <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                    <p className="mt-1 text-xs text-slate-600">{item.description}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <EmissionCalculator />
        </section>
      </main>
    </div>
  );
}

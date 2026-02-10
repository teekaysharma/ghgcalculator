import EmissionCalculator from "@/components/EmissionCalculator";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Leaf, LineChart, UploadCloud, ShieldCheck } from "lucide-react";

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

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-emerald-500/20 p-2 text-emerald-400">
              <Leaf className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Sustainability Platform</p>
              <h1 className="text-lg font-semibold">GHG Emissions Calculator</h1>
            </div>
          </div>
          <Badge variant="secondary" className="border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
            Carbon Analytics Workspace
          </Badge>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl space-y-8 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <section className="grid gap-6 rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900 via-slate-900 to-slate-950 p-6 shadow-2xl lg:grid-cols-[1.35fr_1fr] lg:p-8">
          <div className="space-y-4">
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-emerald-300">Enterprise Carbon Management</p>
            <h2 className="text-3xl font-bold leading-tight text-white sm:text-4xl">
              Build a reliable emissions baseline and monitor performance over time.
            </h2>
            <p className="max-w-2xl text-slate-300">
              Inspired by the clean SustainMetrics-style experience: focused dashboards, clear data flow, and
              actionable reporting for sustainability teams.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {highlights.map((item) => {
              const Icon = item.icon;
              return (
                <Card key={item.title} className="border-slate-700/80 bg-slate-900/70">
                  <CardContent className="p-4">
                    <Icon className="mb-2 h-5 w-5 text-emerald-300" />
                    <p className="text-sm font-semibold text-white">{item.title}</p>
                    <p className="mt-1 text-xs text-slate-300">{item.description}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-100 p-4 text-slate-900 shadow-xl sm:p-6">
          <EmissionCalculator />
        </section>
      </main>
    </div>
  );
}

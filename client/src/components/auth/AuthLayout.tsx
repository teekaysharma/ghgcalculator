import { type ReactNode } from "react";
import { Leaf, BarChart3, ShieldCheck, Users } from "lucide-react";

// Shared shell for /login and /register. The app has no existing header,
// logo, or landing page elsewhere (AppShell's own nav is a bare text list,
// confirmed by reading it) -- this is the first real branding treatment,
// so it stays understated and reuses the app's own copy (client/index.html's
// title/description) and its existing --primary token rather than
// inventing new colors or a logo asset that doesn't exist anywhere else.
const VALUE_PROPS = [
  {
    icon: BarChart3,
    title: "Scope 1, 2 & 3 in one place",
    description: "Calculate and consolidate emissions across your full organizational boundary.",
  },
  {
    icon: ShieldCheck,
    title: "Audit-ready by design",
    description: "Built on verified emission factors and IPCC AR6 GWP references, with a clear data trail.",
  },
  {
    icon: Users,
    title: "Built for teams",
    description: "Invite your team and manage multiple facilities and entities under one organization.",
  },
];

export default function AuthLayout({
  heading,
  subheading,
  children,
}: {
  heading: string;
  subheading: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-neutral-50">
      <div className="lg:w-[45%] xl:w-[40%] bg-primary text-primary-foreground px-8 py-5 lg:px-12 lg:py-16 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-foreground/15">
              <Leaf className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold">GHG Emissions Calculator</span>
          </div>

          <div className="hidden lg:block">
            <h1 className="mt-16 text-3xl font-bold leading-tight">
              Measure what matters.
              <br />
              Report with confidence.
            </h1>
            <p className="mt-3 text-primary-foreground/80 max-w-sm">
              Track, consolidate, and report your organization's greenhouse gas emissions across
              every scope and facility.
            </p>
          </div>
        </div>

        <div className="mt-10 space-y-6 hidden lg:block">
          {VALUE_PROPS.map(({ icon: Icon, title, description }) => (
            <div key={title} className="flex gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-foreground/15">
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="font-medium">{title}</p>
                <p className="text-sm text-primary-foreground/70">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-10 lg:py-16">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <h2 className="text-2xl font-semibold text-neutral-900">{heading}</h2>
            <p className="mt-1.5 text-sm text-neutral-500">{subheading}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

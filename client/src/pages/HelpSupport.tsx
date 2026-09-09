import { Link } from "wouter";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-100 text-primary-700 text-xs font-semibold flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div>
        <p className="font-medium text-neutral-900">{title}</p>
        <p className="text-neutral-600 text-sm mt-0.5">{children}</p>
      </div>
    </div>
  );
}

export default function HelpSupport() {
  return (
    <div className="min-h-screen bg-neutral-50 font-sans">
      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <Link href="/" className="text-sm text-primary-600 hover:underline">
          ← Back to app
        </Link>
        <h1 className="font-heading font-bold text-3xl text-primary-800 mt-4 mb-1">Help &amp; Support</h1>
        <p className="text-neutral-500 text-sm mb-8">Getting started, and how to reach us.</p>

        <div className="space-y-8">
          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-4">Getting started</h2>
            <div className="space-y-4">
              <Step n={1} title="Set up your reporting entity">
                On the Setup tab, create the reporting entity — the company or client this GHG inventory is for — and
                set its base year with a short rationale.
              </Step>
              <Step n={2} title="Add at least one facility">
                Every entity needs at least one physical or operational facility before you can record emissions.
              </Step>
              <Step n={3} title="Create a reporting boundary">
                Choose a consolidation approach (operational control, financial control, or equity share) and a
                reporting year — this is the boundary your inventory is measured against.
              </Step>
              <Step n={4} title="Record source streams in the Boundary Workspace">
                Add each identifiable emission source, pick a quantification approach, and let the emission factor
                picker apply a sourced, traceable factor.
              </Step>
              <Step n={5} title="Review and export">
                The Organization Report tab shows your consolidated inventory by scope, gas, and facility, and can
                export a verifier-ready Excel workbook.
              </Step>
            </div>
          </section>

          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-3">Managing your team</h2>
            <p className="text-neutral-600 text-sm">
              Org owners and admins can invite existing accounts, and deactivate or reactivate a member's access —
              either just to your organization, or to their account entirely — from the Team tab. Every change is
              logged with a reason.
            </p>
          </section>

          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-3">Common questions</h2>
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-medium text-neutral-900">I didn't get a verification email.</p>
                <p className="text-neutral-600">
                  Use the resend link on the verification page, and check your spam folder. If it still doesn't
                  arrive, contact us below.
                </p>
              </div>
              <div>
                <p className="font-medium text-neutral-900">I forgot my password.</p>
                <p className="text-neutral-600">
                  Use "Forgot your password?" on the login page — you'll get a one-time link to set a new one. Nobody
                  at this company ever sees or sets your password directly.
                </p>
              </div>
              <div>
                <p className="font-medium text-neutral-900">Can I change my account's email address?</p>
                <p className="text-neutral-600">
                  Not yet, self-service — ask your org's owner/admin, or a platform administrator, to change it for
                  you.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-3">Still stuck?</h2>
            <p className="text-neutral-600 text-sm">
              Reach out on{" "}
              <a
                href="https://github.com/teekaysharma"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-600 hover:underline"
              >
                GitHub
              </a>{" "}
              and we'll help directly.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

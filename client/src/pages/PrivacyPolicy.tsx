import { Link } from "wouter";

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-neutral-50 font-sans">
      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <Link href="/" className="text-sm text-primary-600 hover:underline">
          ← Back to app
        </Link>
        <h1 className="font-heading font-bold text-3xl text-primary-800 mt-4 mb-1">Privacy Policy</h1>
        <p className="text-neutral-500 text-sm mb-8">Last updated {new Date().toLocaleDateString()}</p>

        <div className="space-y-6 text-neutral-700 text-sm leading-relaxed">
          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-2">What we collect</h2>
            <p>
              When you register, we collect your email address, an optional display name, and the name of your
              organization. Once you're using the platform, we store the GHG inventory data you or your team enters:
              reporting entities, facilities, emission factors and records, and any supporting evidence you attach for
              verification purposes. We do not collect payment information — this platform does not currently process
              payments.
            </p>
          </section>

          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-2">How your data is scoped</h2>
            <p>
              This is a multi-tenant platform: every organization's data is isolated from every other organization's.
              Only members of your organization — and, where necessary for platform support, a small number of
              designated administrators — can access your data. Every administrative action taken on your account or
              organization is logged with who did it, what they did, and when.
            </p>
          </section>

          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-2">Third parties we use</h2>
            <p>
              We use <strong>Resend</strong> to deliver account emails (verification links, password resets). We host
              the application and database on <strong>Vercel</strong> and <strong>Neon</strong>. None of these
              providers use your data for anything beyond delivering the service to you.
            </p>
          </section>

          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-2">Data retention</h2>
            <p>
              If you register but never verify your email, that pending registration is automatically removed after a
              short window. Verified accounts and their organizations' data are retained for as long as the account is
              active. Deactivating a membership or account is reversible and does not delete any underlying data —
              nothing in your GHG inventory is ever deleted as a side effect of an access-control change.
            </p>
          </section>

          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-2">Your choices</h2>
            <p>
              You can update your display name at any time from the app's home screen. To request a copy of your
              data, or to request deletion of your account, contact us using the details below.
            </p>
          </section>

          <section>
            <h2 className="font-heading font-semibold text-lg text-neutral-900 mb-2">Contact</h2>
            <p>
              Questions about this policy or your data can be sent via{" "}
              <a
                href="https://github.com/teekaysharma"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-600 hover:underline"
              >
                GitHub
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

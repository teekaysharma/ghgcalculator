# GHG Emissions Calculator

A comprehensive tool for tracking and analyzing Scope 1, 2, and 3 carbon emissions with support for advanced features like multi-year comparisons, product intensity metrics, and waste management tracking.

## `saas-multitenant` branch

This branch rebuilds the persistence and identity layer on top of the working calculator (calculation logic, UI, xlsx upload, and CSV export are unchanged from `main`). What changed:

- **Multi-tenancy**: `organizations`, `users`, and `memberships` (join table, roles: owner/admin/member). Every tenant-scoped table carries `organization_id`; every query in `server/storage.ts` filters on it.
- **Persistence**: `MemStorage` (in-memory, discarded on every request) is replaced with `DbStorage`, backed by Postgres via `@neondatabase/serverless` + `drizzle-orm`. Emission factors (`emission_factors` table) and calculation results (`emission_records` table) now persist, scoped to tenant.
- **Auth**: `passport-local` + `express-session` + `connect-pg-simple`, previously installed but unused. Passwords are hashed with bcrypt. Sessions are stored in Postgres, not memory.
- **API**: every route now requires authentication (`requireAuth`) and resolves the caller's organization (`requireOrg`) before touching any tenant-scoped data.

### Setup

1. Create a free Neon project at [console.neon.tech](https://console.neon.tech) and copy the connection string from **Connection Details**.
2. `cp .env.example .env` and fill in `DATABASE_URL` and a generated `SESSION_SECRET` (command is in the file's comments).
3. `npm install`
4. Apply the schema: `node scripts/manual-migration-001.mjs`. This creates/updates all tables (`organizations`, `users`, `memberships`, `emission_factors`, `emission_records`, `reporting_entities`, `facilities`, `reporting_boundaries`) directly against `DATABASE_URL`, idempotent, safe to re-run. **Do not use `npm run db:push`** — see [MIGRATIONS.md](./MIGRATIONS.md) for why (`drizzle-kit push` failed repeatedly against this schema in testing, confirmed to be a tool issue, not a data or state issue). The `session` table used by `connect-pg-simple` is created automatically on first server start (`createTableIfMissing: true`), no separate step needed.
5. `npm run dev`

### One-shot verification: `npm run verify`

Runs `npm install`, verifies the schema matches `shared/schema.ts` (does not apply migrations itself, run `node scripts/manual-migration-001.mjs` first if this is a fresh database), starts the dev server, then runs a real end-to-end smoke test against the live server (register, fetch session, create a reporting entity/facility/reporting boundary, confirm setup status, create an emission factor, list it back, run a calculation with `persist: true`, confirm it was actually saved, log out), then reverts: stops the server and deletes only the rows that specific run created, tagged by a unique per-run identifier. It does not touch your schema or any other data.

Requires `.env` to already exist and be filled in (step 1-2 above are still manual, on purpose, since `DATABASE_URL` is a live credential this script deliberately never generates or guesses). Exits non-zero if any step fails, with the specific failing step printed.

Works on Windows, macOS, and Linux (uses `taskkill /T` to fully stop the server process tree on Windows, since a plain kill leaves the underlying node process running under Windows' `cmd.exe` wrapper).

### New endpoints

- `POST /api/auth/register` — `{ email, password, name?, organizationName }`. Creates a user, an organization, and an owner membership in one call.
- `POST /api/auth/login` — `{ email, password }`
- `POST /api/auth/logout`
- `GET /api/auth/me` — current user + memberships
- `GET /api/emission-factors`, `POST /api/emission-factors`, `DELETE /api/emission-factors/:id` — tenant-scoped, requires auth
- `GET /api/emission-records` — tenant-scoped, requires auth
- `GET/POST/PUT/DELETE /api/reporting-entities` — the entity being measured (e.g. the client company a tenant is reporting GHG data for). Tenant-scoped.
- `GET/POST/PUT/DELETE /api/facilities` — belongs to a reporting entity, unique name per entity.
- `GET/POST/PUT/DELETE /api/reporting-boundaries` — belongs to a reporting entity, one per (entity, reportingYear).
- `GET /api/setup-status` — `{ reportingEntityCount, facilityCount, boundaryCount, readyForCalculation }` for the caller's tenant.
- `GET /api/team` — list org members. `POST /api/team/invite` — `{ email, role? }`, adds an existing user to the org, owner/admin only.
- Existing `/api/calculate`, `/api/download-csv`, `/api/yearly-comparison`, `/api/product-intensity` are unchanged in behavior but now require auth. `/api/calculate` additionally accepts `persist: true` in the request body to save results to `emission_records`; the existing calculator UI does not send this flag yet, so current behavior (compute and return, nothing saved) is preserved unless a caller opts in. **`/api/calculate` now also requires setup completeness**: at least one reporting entity, facility, and reporting boundary must exist for the tenant, or it returns 400. See "Reconciled from codex" below.

### Reconciled from `codex/review-code-for-gaps-and-improvements`

That branch (32 commits) independently built ISO 14064-1 boundary-setting concepts (reporting entity, facility, reporting boundary, consolidation approach) on top of `MemStorage` + a JSON-file snapshot, no tenant scoping, no real DB tables. Ported here as real Postgres tables, tenant-scoped like everything else on this branch.

**Naming collision, resolved:** that branch called the entity being measured "Organization", which collides with this branch's `organizations` table (the SaaS tenant / paying customer account). These are different concepts — one tenant can report on one or more reporting entities (e.g. a consultancy tenant reporting for several client companies). Renamed to `ReportingEntity` / `reporting_entities` here to keep them permanently distinct. If you're comparing against the `codex` branch directly, `Organization` there = `ReportingEntity` here.

Also ported: `scope3Category` on emission inputs/records, `source`/`year` on emission factors, and a CSV-escaping fix (commas/quotes/newlines in values were previously unescaped, which could corrupt exported CSVs or, worse, enable CSV injection if opened in Excel).

**Not yet ported:** the `SetupBoundaryPanel.tsx` UI (478 lines on `codex`) that gates the calculator UI on setup completeness. The backend gate above is live; nothing in the current UI creates a reporting entity/facility/boundary yet, so the existing calculator will get a 400 from `/api/calculate` until either that UI is ported and adapted for auth/tenancy, or a new one is built against these endpoints.

### New frontend (this session)

- `/login`, `/register` pages, `useAuth()` context, and `ProtectedRoute` gating `/`. This was the actual blocker for using the app in a browser at all, closed now.
- `SetupPanel` — walks through creating a reporting entity, facility, and reporting boundary, matches `/api/setup-status`'s `readyForCalculation` logic exactly, renders the calculator once complete. Not a port of `codex`'s `SetupBoundaryPanel.tsx` — that one predates auth/tenancy and targeted a different API shape, this is a fresh implementation against the current endpoints.
- `TeamPanel` — lists org members, lets owner/admin add an *existing* user by email. No email delivery, no invite tokens, the invited person has to register themselves first. Stated in the UI itself, not hidden.
- `EmissionCalculator` now sends `persist: true` on every calculation — previously computed and discarded even after the backend supported persistence.

### Known gaps in this branch (not done, scoped honestly)

- No real invite flow (email delivery + signup-by-token). Current invite only attaches an already-registered account to an org.
- No rate limiting on `/api/team/invite` or other authenticated write endpoints (login/register are covered).
- The `X-Organization-Id` header path in `requireOrg` (for a user in more than one org) has no UI — not needed while it's one-org-per-user in practice, only relevant once someone's in multiple orgs.
- No password reset / forgot-password flow.
- No UI test coverage — `npm run verify` exercises the API end-to-end but doesn't drive a browser. The UI changes in this session were type-checked and build-verified (`tsc --noEmit`, `npm run build`) but not click-tested by a human yet.
- Compliance/framework layer beyond ISO 14064-1 boundary setup (DEFRA integration, GHG Protocol/CDP/GRI/TCFD/BRSR-specific fields) is still out of scope per the project instructions.

## Features

- **Multi-Scope Emissions Tracking**: Calculate and track Scope 1, 2, and 3 greenhouse gas emissions
- **Multi-Year Comparison**: Track and visualize emissions trends over time
- **Product Intensity Metrics**: Calculate emissions per unit of production for various products
- **Waste Analysis**: Track emissions by waste type and disposal method
- **Flexible Data Import**: Support for various Excel file formats and column naming conventions
- **Visualization**: Charts and graphs for emissions data analysis

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Installation

1. Unzip the downloaded file to a directory of your choice
2. Open a terminal/command prompt and navigate to the project directory
3. Install dependencies:

```bash
npm install
```

or if you use yarn:

```bash
yarn
```

### Running the Application

To start the development server:

```bash
npm run dev
```

This will launch both the backend server and the frontend application. The application will be available at `http://localhost:5000` in your web browser.

### Using the Application

1. **Upload Emission Factors**: Use the "Upload Emission Factors" section to import your Excel file with emission factors
2. **Enter Activity Data**: Enter your activity data in the appropriate scope tabs
3. **View Results**: The Results section will display your calculated emissions and visualizations

## Emission Factor File Format

The application supports various emission factor file formats:

1. **Standard format**: A simple table with columns for Activity Type, Emission Factor, and Unit
2. **Multi-scope format**: Data organized by scope (1, 2, or 3) using sheet names or a Scope column
3. **Waste-specific format**: Detailed tracking of waste types and disposal methods

For detailed format instructions, click the "Waste Factor Format Guide" button in the application.

## Support

# My Vite + Express App

This is a full-stack application using Vite (React) and Express.js backend.

## Scripts

- `npm run dev` — start development server
- `npm run build` — build client
- `npm start` — serve in production mode

## Deployment

Runs on port `5000`. Make sure `dist/public` exists before running in production.

## Build

```bash
npm install
npm run build
npm start





For questions or issues, please contact the development team.

## License

This project is licensed under the MIT License.
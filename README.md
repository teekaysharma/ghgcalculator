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
4. `npm run db:push` — this runs `drizzle-kit push` and creates all tables (`organizations`, `users`, `memberships`, `emission_factors`, `emission_records`) directly from `shared/schema.ts`. The `session` table used by `connect-pg-simple` is created automatically on first server start (`createTableIfMissing: true`), no separate step needed.
5. `npm run dev`

### New endpoints

- `POST /api/auth/register` — `{ email, password, name?, organizationName }`. Creates a user, an organization, and an owner membership in one call.
- `POST /api/auth/login` — `{ email, password }`
- `POST /api/auth/logout`
- `GET /api/auth/me` — current user + memberships
- `GET /api/emission-factors`, `POST /api/emission-factors`, `DELETE /api/emission-factors/:id` — tenant-scoped, requires auth
- `GET /api/emission-records` — tenant-scoped, requires auth
- Existing `/api/calculate`, `/api/download-csv`, `/api/yearly-comparison`, `/api/product-intensity` are unchanged in behavior but now require auth. `/api/calculate` additionally accepts `persist: true` in the request body to save results to `emission_records`; the existing calculator UI does not send this flag yet, so current behavior (compute and return, nothing saved) is preserved unless a caller opts in.

### Known gaps in this branch (not done, scoped honestly)

- The React UI (`EmissionCalculator.tsx` and friends) has not been wired to call `/api/auth/*` or send session cookies. The backend is ready; there's no login screen yet. Same for the `X-Organization-Id` header the multi-org path in `requireOrg` reads — not needed for single-org-per-user, only relevant once a user can belong to more than one org.
- No invite-a-second-user-to-an-org endpoint yet. `storage.createMembership` supports it; there's no route calling it.
- No rate limiting on `/api/auth/login` or `/api/auth/register`.
- Compliance/framework layer (ISO 14064-1 fields, DEFRA integration, multi-framework mapping) is explicitly out of scope for this branch per the project instructions.

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
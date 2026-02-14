# GHG Emissions Calculator

A full-stack greenhouse-gas emissions calculator (React + Express) for tracking Scope 1, 2, and 3 emissions.

## Run on localhost (current phase)

This phase is **localhost-only** and does **not** require a database.

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Start the app

```bash
npm run dev
```

Then open `http://localhost:5000`.

---

## Available scripts

- `npm run dev` — start local development server
- `npm run check` — run TypeScript checks
- `npm run build` — build client and server bundles
- `npm start` — run production server from `dist`
- `npm run standalone` — build and start production locally
- `npm run test:setup-api` — run setup API integration checks

## Notes

- Default port: `5000` (configurable via `PORT`).
- Default host: `localhost` (configurable via `HOST`).
- Persistent DB storage will be introduced in a later phase.

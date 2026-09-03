import { createApp } from "./server/app";

// Vercel's zero-config Express support (docs: vercel.com/docs/frameworks/backend/express)
// requires the entrypoint at one of a fixed set of root-level paths (app.ts,
// index.ts, server.ts, or the src/ equivalents) exporting the Express app as
// a default export -- Vercel bundles it into a single Vercel Function and
// wires up routing automatically, no vercel.json rewrites/functions config
// needed for the API itself. Static assets are served separately from the
// public/** directory at project root (see vercel.json's buildCommand),
// so the function itself never needs to serve static files.
const { app } = await createApp({ skipStaticServing: true });

export default app;

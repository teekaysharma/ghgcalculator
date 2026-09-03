import type { Request, Response } from "express";
import { createApp } from "./app";

// Vercel serverless entrypoint. Built via esbuild --bundle into api/index.js
// -- see vercel.json's buildCommand -- overwriting a placeholder committed
// at that same path (api/index.js is deliberately NOT gitignored; see the
// comment there). Both facts matter and were confirmed the hard way on
// this branch: Vercel's function-to-route wiring requires the file to
// exist in the pre-build git tree (a build-time-only file, even with an
// identical final filename, never got routed to), and Vercel's own
// zero-config TypeScript handling for files under /api transpiles each
// file individually without inlining relative imports, which fails at
// runtime with ERR_MODULE_NOT_FOUND for anything this file imports
// (confirmed via Vercel's runtime logs) -- hence bundling with esbuild
// instead of leaving this as source TS for Vercel to handle natively.
//
// api/index.js only naturally matches the exact path /api, so
// vercel.json's /api/:path* rewrite routes every sub-path here too. A
// [...path] catch-all filename (Vercel/Next.js's dynamic-function naming
// convention) was tried first and deployed fine as a function but was
// never actually invocable at any sub-path -- apparently not parsed as a
// wildcard segment outside a framework that implements that convention
// itself, so this reverted to a plain exact-match filename plus an
// explicit rewrite. A zero-config "Express framework" entrypoint attempt
// (server.ts at the project root) was also tried and hit a different dead
// end: its build-time detector required express to be imported directly
// in the entrypoint file, not via this project's createApp() factory. All
// three approaches are documented in this branch's commit history.
//
// vercel.json's outputDirectory serves dist/public directly for everything
// else, so this function never needs static assets in its own filesystem.
// skipStaticServing avoids createApp() throwing on that directory's
// absence.
//
// Never calls .listen() -- Vercel invokes the exported handler directly
// per request instead of binding a port. server/index.ts (local dev /
// persistent-host) is the other, unrelated consumer of createApp().
let appPromise: ReturnType<typeof createApp> | null = null;

export default async function handler(req: Request, res: Response) {
  if (!appPromise) {
    appPromise = createApp({ skipStaticServing: true });
  }
  const { app } = await appPromise;
  app(req, res);
}

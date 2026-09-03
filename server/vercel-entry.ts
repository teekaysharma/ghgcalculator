import type { Request, Response } from "express";
import { createApp } from "./app";

// Vercel serverless entrypoint. Built (not committed) via esbuild --bundle
// into api/[...path].js -- see vercel.json's buildCommand. Bundling here
// matters: Vercel's own zero-config TypeScript handling for files under
// /api transpiles each file individually without inlining relative
// imports, which fails at runtime with ERR_MODULE_NOT_FOUND for anything
// this file imports (confirmed directly via Vercel's runtime logs during
// this feature's own verification, not assumed).
//
// The [...path] catch-all filename is Vercel's own native dynamic-function
// routing convention (the same one Next.js API routes use) -- it makes
// every request under /api/* invoke this function directly via Vercel's
// filesystem-based routing, with no vercel.json rewrite needed for the API
// itself. This replaced an earlier api/index.js (exact-match only, needed
// a rewrite that never actually routed to it) and, before that, a
// zero-config "Express framework" entrypoint attempt (server.ts at the
// project root) whose build-time detector required express to be imported
// directly in the entrypoint file, not via this project's createApp()
// factory -- both dead ends, documented in this branch's commit history.
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

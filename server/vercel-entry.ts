import path from "path";
import type { Request, Response } from "express";
import { createApp } from "./app";

// Vercel serverless entrypoint. Built (not committed) via esbuild --bundle
// into api/index.js -- see vercel.json's buildCommand. Bundling here
// matters: Vercel's own zero-config TypeScript handling for files under
// /api transpiles each file individually without inlining relative
// imports, which fails at runtime with ERR_MODULE_NOT_FOUND for anything
// this file imports (confirmed directly via Vercel's runtime logs during
// this feature's own verification, not assumed). esbuild --bundle inlines
// everything -- this module, server/app.ts, server/routes.ts, and so on
// -- into one self-contained file, the same reliable approach this
// project's own npm run build already uses for dist/index.js.
//
// Never calls .listen() -- Vercel invokes the exported handler directly
// per request instead of binding a port. server/index.ts (local dev /
// persistent-host) is the other, unrelated consumer of createApp().
let appPromise: ReturnType<typeof createApp> | null = null;

export default async function handler(req: Request, res: Response) {
  if (!appPromise) {
    appPromise = createApp({
      // dist/public is included in this function's deployment via
      // vercel.json's `functions["api/index.js"].includeFiles`, at a path
      // relative to the project root -- process.cwd() -- not this file's
      // own __dirname (which, once bundled to api/index.js, is a
      // different directory than server/vite.ts's default assumes).
      staticDistPath: path.resolve(process.cwd(), "dist", "public"),
    });
  }
  const { app } = await appPromise;
  app(req, res);
}

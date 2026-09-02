import path from "path";
import type { Request, Response } from "express";
import { createApp } from "../server/app";

// Vercel serverless entrypoint. Never calls .listen() -- Vercel invokes
// this exported handler directly per request instead of binding a port.
// server/index.ts (local dev / persistent-host) is the other, unrelated
// consumer of createApp() and is untouched by this file.
//
// staticDistPath is explicit here (see server/vite.ts's serveStatic
// comment): Vercel's own function bundler for this file does not
// preserve the same __dirname-relative layout as this project's own
// esbuild output, so the default (__dirname-relative) path would look in
// the wrong place. dist/public is included in this function's deployment
// via vercel.json's `functions["api/index.ts"].includeFiles`, at a path
// relative to the project root -- process.cwd() -- not this file's
// __dirname.
let appPromise: ReturnType<typeof createApp> | null = null;

export default async function handler(req: Request, res: Response) {
  if (!appPromise) {
    appPromise = createApp({
      staticDistPath: path.resolve(process.cwd(), "dist", "public"),
    });
  }
  const { app } = await appPromise;
  app(req, res);
}

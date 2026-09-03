import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export function serveStatic(app: Express, distPathOverride?: string) {
  // Defaults to __dirname-relative, correct for this app's own esbuild
  // output (dist/index.js sits next to dist/public). Vercel's serverless
  // function (server/vercel-entry.ts, skipStaticServing: true) never
  // calls this at all -- Vercel's own static hosting serves dist/public
  // directly -- so the override only matters for other non-default
  // callers, if any are ever added.
  const distPath = distPathOverride ?? path.resolve(__dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

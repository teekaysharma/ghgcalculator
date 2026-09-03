import { type Express } from "express";
import { type Server } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer, createLogger } from "vite";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";

// Local-dev-only Vite middleware setup, deliberately isolated in its own
// file. server/app.ts imports this via a dynamic import() marked
// --external in the Vercel buildCommand (see vercel.json) so it is never
// inlined into the deployed function bundle -- confirmed the hard way
// on this branch: esbuild inlines any *locally*-imported file regardless
// of whether the import is static or dynamic (no --splitting for a
// single-outfile build), and inlining necessarily hoists that file's own
// top-level `import ... from "vite"` to the top of the combined output,
// making it eager again even when wrapped in `await import(...)`. Only a
// genuinely external (never-inlined) module keeps the import truly lazy.
// vite pulls in rollup, which has a well-known platform-specific
// optional-binary resolution bug (github.com/npm/cli/issues/4828) that
// broke every request on Vercel's Linux runtime before this split
// (confirmed via Vercel's own runtime logs).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const viteLogger = createLogger();

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(__dirname, "..", "client", "index.html");

      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import { type Server } from "http";
import { registerRoutes } from "./routes";
import { serveStatic, log } from "./vite";
import { passport } from "./auth";

if (!process.env.SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET is not set. Set a long random string as SESSION_SECRET in your .env file (see .env.example).",
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. See .env.example.");
}
// Captured once the guards above have run -- TS narrowing doesn't carry
// module-level `process.env` checks across the function boundary into
// createApp() below, since createApp can (in principle) be called at any
// later time. These consts are what actually get used there.
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// Everything needed to build the fully-configured Express app, minus
// actually listening on a port -- shared by server/index.ts (local dev /
// persistent-host, calls .listen() on the returned server) and
// api/index.ts (Vercel serverless function, never listens, just exports
// the app as the request handler).
export async function createApp(options?: {
  staticDistPath?: string;
  // Vercel serves dist/public directly via its own static hosting +
  // rewrites (see vercel.json) -- the function only ever receives /api/*
  // requests, so it never needs dist/public in its own filesystem.
  // Without this flag, serveStatic() would throw on a missing directory
  // it will genuinely never need under that deployment target.
  skipStaticServing?: boolean;
}): Promise<{ app: express.Express; server: Server }> {
  const app = express();

  // Vercel (and any TLS-terminating proxy) forwards to this app over plain
  // HTTP internally -- without trusting the proxy, Express can't tell the
  // original request was HTTPS, which breaks the secure cookie flag below
  // (session/login would silently fail on Vercel). Harmless for local dev
  // (no proxy in front there).
  app.set("trust proxy", 1);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Session store lives in the same Postgres database as everything else.
  // connect-pg-simple talks to it over the standard Postgres wire protocol via
  // `pg`, separate from the @neondatabase/serverless HTTP driver used for app
  // queries in server/db.ts -- both point at the same DATABASE_URL, Neon
  // supports both protocols on one connection string.
  const PgSession = connectPgSimple(session);
  const sessionPool = new Pool({ connectionString: DATABASE_URL });

  app.use(
    session({
      store: new PgSession({ pool: sessionPool, tableName: "session", createTableIfMissing: true }),
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    }),
  );

  app.use(passport.initialize());
  app.use(passport.session());

  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, any> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      const duration = Date.now() - start;
      if (path.startsWith("/api")) {
        let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
        if (capturedJsonResponse) {
          logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
        }

        if (logLine.length > 80) {
          logLine = logLine.slice(0, 79) + "…";
        }

        log(logLine);
      }
    });

    next();
  });

  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  //
  // skipStaticServing is checked first and takes priority over the
  // NODE_ENV check below: it's the explicit signal from the Vercel
  // entrypoint that this is a serverless function invocation, where
  // neither setupVite() nor serveStatic() are ever correct (Vercel's own
  // static hosting serves the built client directly). Checking NODE_ENV
  // first was a real, confirmed bug -- Vercel's Node.js function runtime
  // does not reliably set NODE_ENV=production, so app.get("env") read
  // "development" there too, calling setupVite() for real on every
  // request.
  //
  // setupVite is imported dynamically, from a module (./vite-dev, not
  // ./vite) that vercel.json's buildCommand marks --external for esbuild
  // -- deliberately never inlined into the deployed function bundle.
  // Confirmed the hard way on this branch: esbuild inlines any *locally*
  // imported file regardless of whether the import is static or dynamic
  // (no --splitting for a single-outfile build), and inlining hoists
  // that file's own top-level `import ... from "vite"` (needed by
  // vite.config.ts, which setupVite also loads) to the top of the
  // combined output -- making it eager again even when the import()
  // call site itself is conditional. Only a genuinely external,
  // never-inlined module keeps it truly lazy, so this dynamic import is
  // only ever reached, and only ever attempts to resolve, on this exact
  // branch (never on Vercel).
  if (options?.skipStaticServing) {
    // Nothing to do -- Vercel serves dist/public directly.
  } else if (app.get("env") === "development") {
    const { setupVite } = await import("./vite-dev");
    await setupVite(app, server);
  } else {
    serveStatic(app, options?.staticDistPath);
  }

  return { app, server };
}

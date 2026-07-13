import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../shared/schema";

// DATABASE_URL must be a Neon connection string (see README setup section
// added on this branch). This file intentionally throws at import time if
// it's missing -- fail fast on boot rather than fail confusingly on the
// first query, mirroring the existing behavior of drizzle.config.ts.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Create a Neon project at console.neon.tech, " +
      "copy the connection string, and set it as DATABASE_URL in your .env " +
      "file (see .env.example).",
  );
}

const sql = neon(process.env.DATABASE_URL);

export const db = drizzle(sql, { schema });

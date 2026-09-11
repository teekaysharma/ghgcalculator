# Activity-Data Document Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload a bill/invoice to a source stream's calculation-approach form and have Gemini pre-fill activity-data fields (quantity, unit, fuel/material type), with mandatory human review before anything saves.

**Architecture:** Client uploads the file directly to Vercel Blob (bypassing the ~4.5MB serverless body cap), then calls a new server route with the resulting blob URL; the server fetches the blob, sends it to Gemini in one call with a fixed JSON schema, stores the result as a `documentExtractions` audit row, and returns the extracted fields to prefill the existing, unmodified calculation-approach form. Saving still goes through the existing `PUT /api/source-streams/:id/calculation-approach` route, extended with one optional field that links the confirmed extraction back to the saved data.

**Tech Stack:** Existing stack (React/Vite, Express, Drizzle/Postgres) plus two new dependencies: `@vercel/blob` (file storage) and `@google/genai` (Gemini SDK). `pdf-lib` added as a devDependency, test-fixture generation only.

## Global Constraints

- Intent: `docs/superpowers/intents/2026-09-10-document-extraction-intent.md`. Spec: `docs/superpowers/specs/2026-09-10-document-extraction-design.md`. Every task below implements a specific section of that spec — read it if anything here is ambiguous, but do not deviate from the exact values below without flagging it.
- Every tenant-scoped query filters on `organizationId`. No exceptions.
- All new/modified DB migrations are idempotent (`information_schema` checks, `applied`/`skipped` tracking, wrapped in one transaction) — follow `scripts/manual-migration-015.mjs`'s exact pattern.
- `drizzle-orm/neon-http` throws at runtime on `.transaction()` — never use it. This plan's storage methods are all single-statement, so this doesn't come up, but don't introduce a multi-statement write without using `db.batch()`.
- Extraction NEVER writes `calculationApproaches` directly. It only ever returns data for the client to prefill into form state; the existing, unmodified save path (`PUT /api/source-streams/:id/calculation-approach`) is the only thing that writes calculation-approach data.
- Nothing in this plan changes behavior for any existing caller of `PUT /api/source-streams/:id/calculation-approach` that does not send the new optional `documentExtractionId` field.
- File types accepted end to end: `application/pdf`, `image/png`, `image/jpeg`, `image/webp`. Max size: 20MB.
- `GEMINI_API_KEY` and `BLOB_READ_WRITE_TOKEN` are real external credentials the project owner must provision (Google AI Studio free tier; Vercel Blob store dashboard) — no task in this plan can provision them. Task 5's live-integration test must degrade gracefully (skip with a clear message, not fail) when they're unset.
- Both new SDKs (`@vercel/blob`, `@google/genai`) are genuinely new to this repo — before treating any exact call signature in this plan as final, check it against the installed package's own type definitions (`node_modules/@vercel/blob`, `node_modules/@google/genai`). This plan's code reflects current best knowledge of both APIs, not a confirmed read of this repo's installed copies.
- **Line-reference refresh, 2026-09-11:** this plan was written 2026-09-10. Since then, `server/routes.ts:2478-2657`'s inline calculation was extracted into `server/calculations/emission-calculation.ts` (2026-09-11), and a repo-wide Prettier reformat landed (`printWidth: 120`, commit `bfda6ca`) — both shifted line numbers in every file this plan references. Every `file:line` anchor below has been re-verified against the current tree and corrected in place (not annotated separately, since these are mechanical position updates, not disputed content) — search-based anchors ("search for `export type CalculationApproach...`") were unaffected and needed no changes.

---

### Task 1: Schema & Migration

**Files:**
- Modify: `shared/schema.ts` (insert immediately after `calculationApproaches`' type exports — search for `export type CalculationApproach = typeof calculationApproaches.$inferSelect;` and `export type InsertCalculationApproach`, insert the new block right after them, before the `measurementBasedApproaches` section)
- Create: `scripts/manual-migration-016.mjs`
- Modify: `scripts/verify-branch.mjs:195-212` (extend `step3_dbPush`)

**Interfaces:**
- Produces: `documentExtractions` (pgTable), `insertDocumentExtractionSchema`, `InsertDocumentExtraction`, `DocumentExtraction`, `DocumentExtractionFieldValue<T>`, `DocumentExtractedFields` — all exported from `shared/schema.ts`, consumed by Tasks 2-4.

- [ ] **Step 1: Add the schema block**

In `shared/schema.ts`, insert:

```ts
export const documentExtractionStatuses = ["extracted", "confirmed", "discarded"] as const;
export type DocumentExtractionStatus = (typeof documentExtractionStatuses)[number];

// Shape of the extracted_fields jsonb column. Each field carries its own
// confidence so the client can flag low-confidence values for review --
// value/confidence are both null when the model found nothing for that
// field, never fabricated.
export interface DocumentExtractionFieldValue<T> {
  value: T | null;
  confidence: "high" | "low" | null;
}

export interface DocumentExtractedFields {
  quantity: DocumentExtractionFieldValue<number>;
  unit: DocumentExtractionFieldValue<string>;
  fuelOrMaterialType: DocumentExtractionFieldValue<string>;
  periodStart: DocumentExtractionFieldValue<string>;
  periodEnd: DocumentExtractionFieldValue<string>;
  vendor: DocumentExtractionFieldValue<string>;
}

export const documentExtractions = pgTable(
  "document_extractions",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceStreamId: integer("source_stream_id").notNull().references(() => sourceStreams.id, { onDelete: "cascade" }),
    calculationApproachId: integer("calculation_approach_id").references(() => calculationApproaches.id, { onDelete: "set null" }),
    uploadedBy: integer("uploaded_by").references(() => users.id),
    fileBlobUrl: text("file_blob_url").notNull(),
    fileName: text("file_name").notNull(),
    fileMimeType: text("file_mime_type").notNull(),
    // DocumentExtractedFields shape -- the raw structured response from the
    // extraction call, kept in full even for fields the user later
    // overrides. This is the audit record of what the model actually saw.
    extractedFields: jsonb("extracted_fields").notNull(),
    modelName: text("model_name").notNull(),
    status: text("status").notNull().default("extracted"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("document_extractions_org_idx").on(table.organizationId),
    streamIdx: index("document_extractions_stream_idx").on(table.sourceStreamId),
  }),
);

// calculationApproachId and status are deliberately excluded from the
// insert-pick: status defaults to 'extracted' at the DB level, and
// calculationApproachId is only ever set later, by confirmDocumentExtraction
// (Task 2), when the user actually saves the calculation approach.
export const insertDocumentExtractionSchema = createInsertSchema(documentExtractions).pick({
  organizationId: true,
  sourceStreamId: true,
  uploadedBy: true,
  fileBlobUrl: true,
  fileName: true,
  fileMimeType: true,
  extractedFields: true,
  modelName: true,
});
export type InsertDocumentExtraction = z.infer<typeof insertDocumentExtractionSchema>;
export type DocumentExtraction = typeof documentExtractions.$inferSelect;
```

- [ ] **Step 2: Write the migration**

Create `scripts/manual-migration-016.mjs`:

```js
// scripts/manual-migration-016.mjs
//
// Adds document_extractions -- the audit trail for the activity-data
// document-extraction feature
// (docs/superpowers/specs/2026-09-10-document-extraction-design.md). One row
// per uploaded document a user ran extraction on for a source stream's
// calculation approach, whether or not they went on to save it.
//
// Idempotent like every other migration in this project: information_schema
// checks before any DDL change, safe to re-run, wrapped in one transaction.
//
// Usage: node scripts/manual-migration-016.mjs

import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set. Run this from the project folder with .env filled in.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const applied = [];
const skipped = [];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tableRes = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'document_extractions'`,
    );
    if (tableRes.rowCount > 0) {
      skipped.push("document_extractions table (already exists)");
    } else {
      await client.query(`
        CREATE TABLE document_extractions (
          id serial PRIMARY KEY,
          organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          source_stream_id integer NOT NULL REFERENCES source_streams(id) ON DELETE CASCADE,
          calculation_approach_id integer REFERENCES calculation_approaches(id) ON DELETE SET NULL,
          uploaded_by integer REFERENCES users(id),
          file_blob_url text NOT NULL,
          file_name text NOT NULL,
          file_mime_type text NOT NULL,
          extracted_fields jsonb NOT NULL,
          model_name text NOT NULL,
          status text NOT NULL DEFAULT 'extracted',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `);
      applied.push("CREATE TABLE document_extractions");

      await client.query(`CREATE INDEX document_extractions_org_idx ON document_extractions (organization_id)`);
      applied.push("CREATE INDEX document_extractions_org_idx");

      await client.query(`CREATE INDEX document_extractions_stream_idx ON document_extractions (source_stream_id)`);
      applied.push("CREATE INDEX document_extractions_stream_idx");
    }

    await client.query("COMMIT");

    console.log(`Applied ${applied.length} step(s):`);
    applied.forEach((s) => console.log(`  + ${s}`));
    console.log(`Skipped ${skipped.length}:`);
    skipped.forEach((s) => console.log(`  = ${s}`));
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("ROLLBACK itself failed:", rollbackErr);
    }
    console.error("Migration failed, rolled back. No partial changes were applied.");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Run the migration against the local/dev database**

Run: `node scripts/manual-migration-016.mjs`
Expected: `Applied 3 step(s)` (CREATE TABLE + 2 indexes) on first run.

Run it again: `node scripts/manual-migration-016.mjs`
Expected: `Applied 0 step(s)`, `Skipped 1` — confirms idempotency.

- [ ] **Step 4: Extend `verify-branch.mjs`'s schema check**

In `scripts/verify-branch.mjs`, inside `step3_dbPush` (around line 195, right after the existing `admin_action_log` table check and before the `} finally {`), add:

```js
    const documentExtractionsTable = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'document_extractions'`,
    );
    if (documentExtractionsTable.rowCount === 0) {
      throw new Error(
        "Schema is out of sync: missing table document_extractions. Run scripts/manual-migration-016.mjs " +
          "against DATABASE_URL before re-running verify.",
      );
    }
```

Update the `ok(...)` call right after the `finally` block (around line 208-212) to append `", document_extractions table"` to its message string.

- [ ] **Step 5: Verify**

Run: `node scripts/verify-branch.mjs`
Expected: schema check step passes and mentions `document_extractions table` in its output.

- [ ] **Step 6: Commit**

```bash
git add shared/schema.ts scripts/manual-migration-016.mjs scripts/verify-branch.mjs
git commit -m "feat: add document_extractions table for activity-data extraction"
```

---

### Task 2: Gemini extraction service

**Files:**
- Modify: `package.json` (add `@google/genai` dependency)
- Modify: `.env.example` (add `GEMINI_API_KEY`)
- Create: `server/services/document-extraction.ts`

**Interfaces:**
- Consumes: `DocumentExtractedFields` (from `@shared/schema`, Task 1).
- Produces: `extractActivityDataFromDocument({ fileBytes: ArrayBuffer, mimeType: string }): Promise<{ extractedFields: DocumentExtractedFields; modelName: string }>` — consumed by Task 3's routes.

This is a new, dedicated file rather than logic inlined into `server/routes.ts` — keeps the one LLM-provider call site isolated and swappable, and doesn't add to `routes.ts`'s existing size (already 3,200+ lines before this feature).

- [ ] **Step 1: Add the dependency**

In `package.json`'s `"dependencies"` block, add (alphabetically, near the top):

```json
    "@google/genai": "^1.0.0",
```

Run: `npm install`
Expected: `@google/genai` appears in `node_modules` and `package-lock.json` updates. **Before proceeding, open `node_modules/@google/genai/dist/**/*.d.ts` (or the package's README) and confirm the `GoogleGenAI` class, its `models.generateContent` method, and the `responseSchema`/`responseMimeType` config options referenced below actually exist with these names in the installed version.** If the installed API differs, adjust Step 3 below to match the real signature before writing tests against it — do not guess.

- [ ] **Step 2: Add the env var**

In `.env.example`, add after the `RESEND_API_KEY` block:

```
# Gemini API key for activity-data document extraction (free tier). Get one
# at aistudio.google.com. Optional in the sense that the app runs without it,
# but the "Extract from document" feature returns a clear error until it's set.
GEMINI_API_KEY=
```

- [ ] **Step 3: Write the extraction service**

Create `server/services/document-extraction.ts`:

```ts
// server/services/document-extraction.ts
//
// Calls Gemini's API to extract activity-data fields from an uploaded
// document (PDF or image). Isolated in its own file, not inlined into
// server/routes.ts, so this project's one LLM-provider call site stays
// swappable and routes.ts doesn't grow further.
//
// Verify this against the installed @google/genai package's own type
// definitions before trusting the exact call shape below as final -- see
// Task 2 Step 1's note in the plan this was built from.

import { GoogleGenAI, Type } from "@google/genai";
import type { DocumentExtractedFields } from "@shared/schema";

const MODEL_NAME = "gemini-2.5-flash";

const FIELD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    value: { type: Type.STRING, nullable: true },
    confidence: { type: Type.STRING, enum: ["high", "low"], nullable: true },
  },
  required: ["value", "confidence"],
};

const NUMERIC_FIELD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    value: { type: Type.NUMBER, nullable: true },
    confidence: { type: Type.STRING, enum: ["high", "low"], nullable: true },
  },
  required: ["value", "confidence"],
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    quantity: NUMERIC_FIELD_SCHEMA,
    unit: FIELD_SCHEMA,
    fuelOrMaterialType: FIELD_SCHEMA,
    periodStart: FIELD_SCHEMA,
    periodEnd: FIELD_SCHEMA,
    vendor: FIELD_SCHEMA,
  },
  required: ["quantity", "unit", "fuelOrMaterialType", "periodStart", "periodEnd", "vendor"],
};

const EXTRACTION_PROMPT = `You are extracting GHG activity-data fields from a utility bill, invoice, \
or similar document. Read the document and extract:
- quantity: the numeric activity amount (e.g. kWh consumed, litres of fuel, tonnes of waste)
- unit: the unit that quantity is measured in, exactly as printed (e.g. "kWh", "litres", "m3")
- fuelOrMaterialType: what the quantity measures (e.g. "grid electricity", "diesel", "natural gas")
- periodStart / periodEnd: the billing or activity period, as ISO dates (YYYY-MM-DD) if determinable
- vendor: the supplier or issuer name printed on the document

For each field, also return a confidence: "high" if you are confident in the exact value, "low" if you \
had to infer it or the document was ambiguous. If a field is not present on the document at all, return \
null for both its value and confidence -- do not guess a value you did not actually see.`;

export interface ExtractionResult {
  extractedFields: DocumentExtractedFields;
  modelName: string;
}

export async function extractActivityDataFromDocument(params: {
  fileBytes: ArrayBuffer;
  mimeType: string;
}): Promise<ExtractionResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set -- document extraction is unavailable until it is configured.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const base64Data = Buffer.from(params.fileBytes).toString("base64");

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: params.mimeType, data: base64Data } }, { text: EXTRACTION_PROMPT }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned no content for this document.");
  }

  const extractedFields = JSON.parse(text) as DocumentExtractedFields;
  return { extractedFields, modelName: MODEL_NAME };
}
```

- [ ] **Step 4: Manual smoke test (requires a real `GEMINI_API_KEY` in `.env`)**

Run, from the repo root, a one-off Node REPL check:

```bash
node -e "
import('./server/services/document-extraction.ts').catch(async () => {
  const { extractActivityDataFromDocument } = await import('tsx/esm/api').then(() => import('./server/services/document-extraction.ts'));
});
"
```

If that inline loader is awkward in this project's ESM/tsx setup, instead write a throwaway script at `scripts/scratch-test-extraction.mjs` importing `extractActivityDataFromDocument` from `../server/services/document-extraction.ts`, calling it with a small real PDF/image's bytes read via `fs.readFileSync`, logging the result, then delete the scratch script once it prints a plausible result (non-null `quantity` or `unit` for a document that actually has one).
Expected: a `DocumentExtractedFields`-shaped object logged, no thrown error.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example server/services/document-extraction.ts
git commit -m "feat: add Gemini-backed document-extraction service"
```

---

### Task 3: Server storage methods and routes

**Files:**
- Modify: `package.json` (add `@vercel/blob` dependency)
- Modify: `server/storage.ts` (imports, `IStorage` interface, class methods)
- Modify: `server/routes.ts` (imports, one new schema field, three new routes, one additive change to the existing PUT handler)

**Interfaces:**
- Consumes: `extractActivityDataFromDocument` (Task 2), `DocumentExtraction`/`InsertDocumentExtraction`/`documentExtractions` (Task 1).
- Produces: `storage.createDocumentExtraction`, `storage.getDocumentExtraction`, `storage.listDocumentExtractionsForStream`, `storage.confirmDocumentExtraction` — no other task consumes these directly (Task 4 calls the HTTP routes, not storage).

- [ ] **Step 1: Add the Blob dependency**

In `package.json`'s `"dependencies"`, add:

```json
    "@vercel/blob": "^0.27.0",
```

Run: `npm install`
Expected: `@vercel/blob` in `node_modules`. **Before proceeding, open `node_modules/@vercel/blob/client.d.ts` and confirm `handleUpload`, `HandleUploadBody`, and `put` are exported with the shapes used below** — same verification discipline as Task 2 Step 1.

- [ ] **Step 2: Add the Blob env var**

In `.env.example`, add right after the `GEMINI_API_KEY` block from Task 2:

```
# Vercel Blob read/write token, for storing uploaded documents (activity-data
# extraction feature). Auto-provisioned as a Production env var once a Blob
# store is created and linked in the Vercel project dashboard -- for local
# dev, copy that same token here. Without it, "Extract from document" fails
# at the upload step; manual entry is unaffected.
BLOB_READ_WRITE_TOKEN=
```

- [ ] **Step 3: Add storage methods**

In `server/storage.ts`, add to the import block (around line 4-78): add `documentExtractions,` to the table-import list (after `adminActionLog,`) and `type DocumentExtraction, type InsertDocumentExtraction,` to the type-import list (after `type GwpValue,`).

Add to the `IStorage` interface (`server/storage.ts:269-538`), in a new section right before the interface's closing `}` (line 538), after the existing cross-cutting methods (`listAdminActionLogForOrganization` at line 537):

```ts
  createDocumentExtraction(data: InsertDocumentExtraction): Promise<DocumentExtraction>;
  getDocumentExtraction(organizationId: number, id: number): Promise<DocumentExtraction | undefined>;
  listDocumentExtractionsForStream(organizationId: number, sourceStreamId: number): Promise<DocumentExtraction[]>;
  confirmDocumentExtraction(organizationId: number, id: number, calculationApproachId: number): Promise<void>;
```

Add the implementations to the storage class, right after `getCalculationApproach` (`server/storage.ts:1211-1225`):

```ts
  async createDocumentExtraction(data: InsertDocumentExtraction): Promise<DocumentExtraction> {
    const [row] = await db.insert(documentExtractions).values(data).returning();
    return row;
  }

  async getDocumentExtraction(organizationId: number, id: number): Promise<DocumentExtraction | undefined> {
    const [row] = await db
      .select()
      .from(documentExtractions)
      .where(and(eq(documentExtractions.id, id), eq(documentExtractions.organizationId, organizationId)));
    return row;
  }

  async listDocumentExtractionsForStream(organizationId: number, sourceStreamId: number): Promise<DocumentExtraction[]> {
    return db
      .select()
      .from(documentExtractions)
      .where(and(eq(documentExtractions.sourceStreamId, sourceStreamId), eq(documentExtractions.organizationId, organizationId)))
      .orderBy(desc(documentExtractions.createdAt));
  }

  async confirmDocumentExtraction(organizationId: number, id: number, calculationApproachId: number): Promise<void> {
    await db
      .update(documentExtractions)
      .set({ calculationApproachId, status: "confirmed" })
      .where(and(eq(documentExtractions.id, id), eq(documentExtractions.organizationId, organizationId)));
  }
```

- [ ] **Step 4: Add the routes**

In `server/routes.ts`, add to the top imports (after `import { requireSuperAdmin } from "./middleware/admin";`):

```ts
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { extractActivityDataFromDocument } from "./services/document-extraction";
```

In `calculationApproachSchema` (`server/routes.ts:224-278`), add one line right before the closing `});` (after `notes: z.string().optional(),`):

```ts
  documentExtractionId: z.number().int().positive().optional(),
```

Immediately after the existing `/api/source-streams/:id/calculation-approach` GET/PUT pair (i.e., right after the closing `});` of the PUT handler at `server/routes.ts:2699`, before the `// --- Measurement-based approach detail` comment at line 2701), add three new routes:

```ts
  // --- Activity-data document extraction ---
  app.post("/api/source-streams/:id/document-extractions/upload-url", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    const sourceStream = await storage.getSourceStream(req.organizationId!, sourceStreamId);
    if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });

    try {
      const jsonResponse = await handleUpload({
        body: req.body as HandleUploadBody,
        request: req,
        onBeforeGenerateToken: async () => ({
          allowedContentTypes: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
          maximumSizeInBytes: 20 * 1024 * 1024,
          addRandomSuffix: true,
        }),
        onUploadCompleted: async () => {
          // Intentional no-op. This webhook only fires when Vercel can reach
          // this deployment over the public internet, which local dev can't
          // guarantee. The client's explicit POST to
          // /api/source-streams/:id/document-extractions right after
          // upload() resolves (see Task 4) is what actually creates the
          // documentExtractions row -- never rely on this firing.
        },
      });
      return res.json(jsonResponse);
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Could not issue upload token" });
    }
  });

  const documentExtractionCreateSchema = z.object({
    blobUrl: z.string().url(),
    fileName: z.string().min(1).max(500),
    mimeType: z.enum(["application/pdf", "image/png", "image/jpeg", "image/webp"]),
  });

  app.post("/api/source-streams/:id/document-extractions", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    try {
      const data = parseBody(documentExtractionCreateSchema, req.body);
      const sourceStream = await storage.getSourceStream(req.organizationId!, sourceStreamId);
      if (!sourceStream) return res.status(404).json({ message: "Source stream not found" });

      const blobRes = await fetch(data.blobUrl);
      if (!blobRes.ok) {
        return res.status(400).json({ message: "Could not fetch the uploaded document from storage." });
      }
      const fileBytes = await blobRes.arrayBuffer();
      if (fileBytes.byteLength > 20 * 1024 * 1024) {
        return res.status(400).json({ message: "Document exceeds the 20MB limit." });
      }

      let extraction;
      try {
        extraction = await extractActivityDataFromDocument({ fileBytes, mimeType: data.mimeType });
      } catch (error) {
        return res.status(502).json({
          message:
            error instanceof Error
              ? `Extraction failed: ${error.message}`
              : "Extraction failed. You can still enter values manually below.",
        });
      }

      const user = req.user as { id: number };
      const row = await storage.createDocumentExtraction({
        organizationId: req.organizationId!,
        sourceStreamId,
        uploadedBy: user.id,
        fileBlobUrl: data.blobUrl,
        fileName: data.fileName,
        fileMimeType: data.mimeType,
        extractedFields: extraction.extractedFields,
        modelName: extraction.modelName,
      });

      return res.json({ documentExtractionId: row.id, extractedFields: row.extractedFields });
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid document extraction request" });
    }
  });

  app.get("/api/source-streams/:id/document-extractions", requireAuth, requireOrg, async (req, res) => {
    const sourceStreamId = Number(req.params.id);
    if (!Number.isInteger(sourceStreamId) || sourceStreamId <= 0) return res.status(400).json({ message: "Invalid source stream id" });
    const extractions = await storage.listDocumentExtractionsForStream(req.organizationId!, sourceStreamId);
    return res.json({ documentExtractions: extractions });
  });
```

In the existing PUT handler (`server/routes.ts:2566-2699`), right after the `upsertCalculationApproach` call resolves (after the closing `});` of the `storage.upsertCalculationApproach({...})` call at line 2658, before the `if (computedEmissionKg !== null) {` block at line 2660), add:

```ts
      if (data.documentExtractionId !== undefined) {
        await storage.confirmDocumentExtraction(req.organizationId!, data.documentExtractionId, approach.id);
      }
```

- [ ] **Step 5: Manual verification against a running dev server**

Start the dev server (`npm run dev`), then with a valid session cookie for an org that has at least one source stream:

```bash
curl -X GET http://localhost:5000/api/source-streams/1/document-extractions -H "Cookie: <session cookie>"
```

Expected: `200 { "documentExtractions": [] }` for a source stream with no extractions yet.

```bash
curl -X POST http://localhost:5000/api/source-streams/1/document-extractions -H "Cookie: <session cookie>" -H "Content-Type: application/json" -d '{"blobUrl":"https://example.com/nonexistent.pdf","fileName":"test.pdf","mimeType":"application/pdf"}'
```

Expected: `400 { "message": "Could not fetch the uploaded document from storage." }` (proves the blob-fetch failure path, without needing a real blob or Gemini key yet).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .env.example server/storage.ts server/routes.ts
git commit -m "feat: add document-extraction storage methods and routes"
```

---

### Task 4: Client UI

**Files:**
- Modify: `client/src/components/BoundaryWorkspace.tsx` (imports, `CalculationApproachForm`)

**Interfaces:**
- Consumes: `POST /api/source-streams/:id/document-extractions/upload-url`, `POST /api/source-streams/:id/document-extractions`, and the extended `PUT /api/source-streams/:id/calculation-approach` (all from Task 3).

- [ ] **Step 1: Add the client-side Blob dependency import**

`@vercel/blob` (added server-side in Task 3) also ships a client entry point; no separate package install needed. Add to `client/src/components/BoundaryWorkspace.tsx`'s import block (after the existing `EmissionFactorPicker` import):

```ts
import { upload } from "@vercel/blob/client";
```

- [ ] **Step 2: Add extraction state and handler to `CalculationApproachForm`**

In `CalculationApproachForm` (`client/src/components/BoundaryWorkspace.tsx:629`), after the existing `gasBreakdown` state (lines 665-667) and its hydration `useEffect` (lines 676-680, after line 680, before the `save` mutation which now starts at line 682), add:

```tsx
  const [documentExtractionId, setDocumentExtractionId] = useState<number | null>(null);
  const [extractedFileName, setExtractedFileName] = useState<string | null>(null);
  const [fieldConfidence, setFieldConfidence] = useState<Record<string, "high" | "low" | null>>({});
  const [isExtracting, setIsExtracting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExtract = async (file: File) => {
    setIsExtracting(true);
    try {
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: `/api/source-streams/${sourceStreamId}/document-extractions/upload-url`,
      });
      const res = await apiRequest("POST", `/api/source-streams/${sourceStreamId}/document-extractions`, {
        blobUrl: blob.url,
        fileName: file.name,
        mimeType: file.type,
      });
      const body = await res.json();
      const extracted = body.extractedFields as {
        quantity: { value: number | null; confidence: "high" | "low" | null };
        unit: { value: string | null; confidence: "high" | "low" | null };
        fuelOrMaterialType: { value: string | null; confidence: "high" | "low" | null };
      };
      setDocumentExtractionId(body.documentExtractionId);
      setExtractedFileName(file.name);
      setFields((f) => ({
        ...f,
        activityDataValue: extracted.quantity.value !== null ? String(extracted.quantity.value) : f.activityDataValue,
        activityDataUnit: extracted.unit.value ?? f.activityDataUnit,
        fuelOrMaterialType: extracted.fuelOrMaterialType.value ?? f.fuelOrMaterialType,
      }));
      setFieldConfidence({
        activityDataValue: extracted.quantity.confidence,
        activityDataUnit: extracted.unit.confidence,
        fuelOrMaterialType: extracted.fuelOrMaterialType.confidence,
      });
      toast({ title: "Document extracted", description: "Review the pre-filled values below before saving." });
    } catch (err) {
      toast({
        title: "Extraction failed",
        description: err instanceof Error ? err.message : "You can still enter values manually below.",
        variant: "destructive",
      });
    } finally {
      setIsExtracting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const lowConfidenceBadge = (key: string) =>
    fieldConfidence[key] === "low" ? (
      <span
        className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 ml-1"
        title="Extracted with low confidence -- verify against the document"
      >
        low confidence
      </span>
    ) : null;
```

- [ ] **Step 3: Include `documentExtractionId` in the save mutation**

In the `save` mutation's `mutationFn` (`client/src/components/BoundaryWorkspace.tsx:682-697`), add one line to the `apiRequest` call's body, alongside the existing `gasBreakdown` spread (now at line 691):

```tsx
        ...(gasBreakdown !== undefined ? { gasBreakdown } : {}),
        ...(documentExtractionId !== null ? { documentExtractionId } : {}),
```

- [ ] **Step 4: Add the upload UI and confidence badges to the rendered form**

At the top of the returned JSX (`client/src/components/BoundaryWorkspace.tsx:703`, right after the opening `<div className="space-y-3 bg-neutral-50 rounded-md p-3">`), add:

```tsx
      <div className="bg-white border rounded-md p-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleExtract(file);
            }}
          />
          <Button size="sm" variant="outline" type="button" disabled={isExtracting} onClick={() => fileInputRef.current?.click()}>
            {isExtracting ? "Extracting..." : "Extract from document"}
          </Button>
          {extractedFileName && <span className="text-xs text-neutral-500">Source: {extractedFileName}</span>}
        </div>
        <p className="text-xs text-neutral-500">
          Upload a bill or invoice to pre-fill the fields below. Nothing saves until you review and click Save.
        </p>
      </div>
```

Then replace the existing `Input`s for `fuelOrMaterialType`, `activityDataValue`, and `activityDataUnit` (`client/src/components/BoundaryWorkspace.tsx:705-711` — the reformat wrapped `fuelOrMaterialType`'s onto multiple lines, so this is 7 lines on disk now, not 3; the current exact text to match and replace is:

```tsx
        <Input
          placeholder="Fuel / material type"
          value={fields.fuelOrMaterialType}
          onChange={set("fuelOrMaterialType")}
        />
        <Input placeholder="Activity data value" value={fields.activityDataValue} onChange={set("activityDataValue")} />
        <Input placeholder="Activity data unit" value={fields.activityDataUnit} onChange={set("activityDataUnit")} />
```

) with:

```tsx
        <div>
          <Input placeholder="Fuel / material type" value={fields.fuelOrMaterialType} onChange={set("fuelOrMaterialType")} />
          {lowConfidenceBadge("fuelOrMaterialType")}
        </div>
        <div>
          <Input placeholder="Activity data value" value={fields.activityDataValue} onChange={set("activityDataValue")} />
          {lowConfidenceBadge("activityDataValue")}
        </div>
        <div>
          <Input placeholder="Activity data unit" value={fields.activityDataUnit} onChange={set("activityDataUnit")} />
          {lowConfidenceBadge("activityDataUnit")}
        </div>
```

(The two lines below these, `activityDataSource` and `activityDataTier`, are unchanged.)

- [ ] **Step 5: Type-check and browser verification**

Run: `npm run check`
Expected: clean, no TypeScript errors.

With the dev server running and a real `GEMINI_API_KEY`/`BLOB_READ_WRITE_TOKEN` set: open a source stream's calculation-approach form in a browser, click "Extract from document," upload a real bill, confirm the fields prefill and any low-confidence field shows the amber badge, edit a value, click Save, and confirm the save succeeds exactly as it did before this feature existed.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/BoundaryWorkspace.tsx
git commit -m "feat: add document-extraction upload UI to the calculation-approach form"
```

---

### Task 5: Testing

**Files:**
- Create: `scripts/fixtures/generate-sample-bill.mjs`
- Create: `scripts/fixtures/sample-bill.pdf` (generated output, committed)
- Create: `scripts/verify-document-extraction.mjs`
- Modify: `package.json` (add `pdf-lib` devDependency)

**Interfaces:**
- Consumes: every route and storage method from Tasks 1-3, live against a running dev server.

- [ ] **Step 1: Add the fixture-generation devDependency**

In `package.json`'s `"devDependencies"`, add:

```json
    "pdf-lib": "^1.17.1",
```

Run: `npm install`

- [ ] **Step 2: Write the fixture generator**

Create `scripts/fixtures/generate-sample-bill.mjs`:

```js
// scripts/fixtures/generate-sample-bill.mjs
//
// Generates scripts/fixtures/sample-bill.pdf -- a small, entirely synthetic
// utility-bill-shaped PDF used only by scripts/verify-document-extraction.mjs.
// No real vendor, account, or customer data. Re-run this if the fixture ever
// needs to change; the output is committed so the test doesn't depend on
// pdf-lib being installed to run (only to regenerate).
//
// Usage: node scripts/fixtures/generate-sample-bill.mjs

import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([400, 500]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  page.drawText("Northwind Utilities -- Electricity Statement", { x: 40, y: 450, size: 14, font });
  page.drawText("Account: TEST-FIXTURE-0001", { x: 40, y: 420, size: 11, font });
  page.drawText("Billing Period: 2026-08-01 to 2026-08-31", { x: 40, y: 400, size: 11, font });
  page.drawText("Electricity Usage: 1,250 kWh", { x: 40, y: 380, size: 11, font });
  page.drawText("This is a synthetic test document. Not a real bill.", { x: 40, y: 340, size: 9, font });

  const pdfBytes = await pdfDoc.save();
  const outPath = join(__dirname, "sample-bill.pdf");
  writeFileSync(outPath, pdfBytes);
  console.log(`Wrote ${outPath} (${pdfBytes.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Generate the fixture**

Run: `node scripts/fixtures/generate-sample-bill.mjs`
Expected: `Wrote .../scripts/fixtures/sample-bill.pdf (NNNN bytes)`, a real file appears on disk.

- [ ] **Step 4: Write the standalone verify script**

Create `scripts/verify-document-extraction.mjs`:

```js
// scripts/verify-document-extraction.mjs
//
// Dedicated test for the activity-data document-extraction feature
// (docs/superpowers/specs/2026-09-10-document-extraction-design.md). Kept
// out of npm run verify: it calls the real Gemini API and real Vercel Blob
// storage, not something to run on every check, and both require real
// credentials this script cannot provision.
//
// Requires the dev server already running (npm run dev in another
// terminal), and GEMINI_API_KEY + BLOB_READ_WRITE_TOKEN set in .env. If
// either is missing, this script prints a clear skip message and exits 0
// rather than failing -- those are real external credentials only the
// project owner can provision (see the spec's "Operational prerequisites"
// section), not something a implementer or CI run can supply.
//
// Usage: node scripts/verify-document-extraction.mjs

import "dotenv/config";
import { Pool } from "pg";
import { put } from "@vercel/blob";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || "5000";
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `doctest-${Date.now()}`;
const TEST_PASSWORD = "DocTest12345";

let passed = 0;
let failed = 0;
function ok(step, msg) {
  passed++;
  console.log(`  ✓ ${step}${msg ? " - " + msg : ""}`);
}
function fail(step, msg) {
  failed++;
  console.error(`  ✗ ${step}${msg ? " - " + msg : ""}`);
}

async function registerAndVerify(pool, tag) {
  const email = `${tag}@example.invalid`;
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, organizationName: tag }),
  });
  if (registerRes.status !== 201) throw new Error(`setup: failed to register ${email}, status ${registerRes.status}`);
  const tokenRes = await pool.query("SELECT email_verification_token FROM users WHERE email = $1", [email]);
  const token = tokenRes.rows[0]?.email_verification_token;
  if (!token) throw new Error(`setup: no verification token found for ${email}`);
  const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (verifyRes.status !== 204) throw new Error(`setup: failed to verify ${email}, status ${verifyRes.status}`);
  return email;
}

async function login(email) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`setup: login failed for ${email}, status ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie ? setCookie.split(";")[0] : "";
  if (!cookie) throw new Error(`setup: no session cookie returned for ${email}`);
  return cookie;
}

async function getUserId(pool, email) {
  const res = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  return res.rows[0]?.id;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail("setup", "DATABASE_URL not set");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY || !process.env.BLOB_READ_WRITE_TOKEN) {
    console.log(
      "SKIPPED: GEMINI_API_KEY and/or BLOB_READ_WRITE_TOKEN not set in .env -- both are real external " +
        "credentials the project owner must provision (Google AI Studio, Vercel Blob dashboard). " +
        "Nothing to verify without them.",
    );
    process.exit(0);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const createdEmails = [];
  let orgOwnerUserId;

  try {
    const email = await registerAndVerify(pool, RUN_TAG);
    createdEmails.push(email);
    const cookie = await login(email);
    orgOwnerUserId = await getUserId(pool, email);
    const orgRow = await pool.query("SELECT organization_id FROM memberships WHERE user_id = $1", [orgOwnerUserId]);
    const organizationId = orgRow.rows[0].organization_id;
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    // --- fixture chain: reporting entity -> facility -> reporting boundary -> source stream ---
    const entityRes = await fetch(`${BASE_URL}/api/reporting-entities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `${RUN_TAG}-entity` }),
    });
    const entity = (await entityRes.json()).reportingEntity;
    if (entityRes.status !== 201 || !entity) throw new Error(`setup: reporting entity creation failed, status ${entityRes.status}`);

    const facilityRes = await fetch(`${BASE_URL}/api/facilities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reportingEntityId: entity.id, name: `${RUN_TAG}-facility` }),
    });
    const facility = (await facilityRes.json()).facility;
    if (facilityRes.status !== 201 || !facility) throw new Error(`setup: facility creation failed, status ${facilityRes.status}`);

    const boundaryRes = await fetch(`${BASE_URL}/api/reporting-boundaries`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reportingEntityId: entity.id, reportingYear: 2026, consolidationApproach: "operational_control" }),
    });
    const boundary = (await boundaryRes.json()).boundary;
    if (boundaryRes.status !== 201 || !boundary) throw new Error(`setup: reporting boundary creation failed, status ${boundaryRes.status}`);

    const streamRes = await fetch(`${BASE_URL}/api/reporting-boundaries/${boundary.id}/source-streams`, {
      method: "POST",
      headers,
      body: JSON.stringify({ facilityId: facility.id, name: `${RUN_TAG}-stream`, scope: "scope2" }),
    });
    const sourceStream = (await streamRes.json()).sourceStream;
    if (streamRes.status !== 201 || !sourceStream) throw new Error(`setup: source stream creation failed, status ${streamRes.status}`);

    // --- scenario 1: no extractions yet ---
    {
      const res = await fetch(`${BASE_URL}/api/source-streams/${sourceStream.id}/document-extractions`, { headers: { Cookie: cookie } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && Array.isArray(body.documentExtractions) && body.documentExtractions.length === 0) {
        ok("GET .../document-extractions (empty)", "200, []");
      } else {
        fail("GET .../document-extractions (empty)", `status ${res.status}, body ${JSON.stringify(body)}`);
      }
    }

    // --- scenario 2: real extraction against the synthetic fixture ---
    let documentExtractionId;
    {
      const fixtureBytes = readFileSync(join(__dirname, "fixtures", "sample-bill.pdf"));
      const blob = await put(`${RUN_TAG}-sample-bill.pdf`, fixtureBytes, {
        access: "public",
        contentType: "application/pdf",
      });

      const res = await fetch(`${BASE_URL}/api/source-streams/${sourceStream.id}/document-extractions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ blobUrl: blob.url, fileName: "sample-bill.pdf", mimeType: "application/pdf" }),
      });
      const body = await res.json().catch(() => ({}));
      documentExtractionId = body.documentExtractionId;
      const hasPlausibleQuantity = body.extractedFields?.quantity?.value !== undefined;
      if (res.status === 200 && documentExtractionId && hasPlausibleQuantity) {
        ok("POST .../document-extractions (real Gemini call)", `200, extractedFields ${JSON.stringify(body.extractedFields)}`);
      } else {
        fail("POST .../document-extractions (real Gemini call)", `status ${res.status}, body ${JSON.stringify(body)}`);
      }
    }

    // --- scenario 3: confirming via the calculation-approach save links the two rows ---
    if (documentExtractionId) {
      const res = await fetch(`${BASE_URL}/api/source-streams/${sourceStream.id}/calculation-approach`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ activityDataValue: "1250", activityDataUnit: "kWh", documentExtractionId }),
      });
      const body = await res.json().catch(() => ({}));
      const dbRow = await pool.query(
        "SELECT calculation_approach_id, status FROM document_extractions WHERE id = $1",
        [documentExtractionId],
      );
      const linked = dbRow.rows[0]?.calculation_approach_id === body.calculationApproach?.id && dbRow.rows[0]?.status === "confirmed";
      if (res.status === 200 && linked) {
        ok("PUT .../calculation-approach (with documentExtractionId)", "200, extraction row linked + confirmed");
      } else {
        fail("PUT .../calculation-approach (with documentExtractionId)", `status ${res.status}, db row ${JSON.stringify(dbRow.rows[0])}`);
      }
    }

    // --- scenario 4: wrong-org access is rejected ---
    {
      const otherEmail = await registerAndVerify(pool, `${RUN_TAG}-other`);
      createdEmails.push(otherEmail);
      const otherCookie = await login(otherEmail);
      const res = await fetch(`${BASE_URL}/api/source-streams/${sourceStream.id}/document-extractions`, {
        headers: { Cookie: otherCookie },
      });
      if (res.status === 403 || res.status === 404) {
        ok("GET .../document-extractions (wrong org)", `${res.status}`);
      } else {
        fail("GET .../document-extractions (wrong org)", `expected 403/404, got ${res.status}`);
      }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    // Cleanup: strip this run's org(s) and users. document_extractions rows
    // cascade-delete with their organization_id FK, so no separate cleanup
    // step is needed for them.
    for (const email of createdEmails) {
      const userRes = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
      const userId = userRes.rows[0]?.id;
      if (!userId) continue;
      const orgRows = await pool.query(
        "SELECT organization_id FROM memberships WHERE user_id = $1 AND role = 'owner'",
        [userId],
      );
      for (const row of orgRows.rows) {
        await pool.query("DELETE FROM organizations WHERE id = $1", [row.organization_id]);
      }
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run it**

With the dev server running and both `GEMINI_API_KEY` and `BLOB_READ_WRITE_TOKEN` set in `.env`:

Run: `node scripts/verify-document-extraction.mjs`
Expected: all 4 scenarios pass, ending in `4 passed, 0 failed`.

Without those env vars set, run it again:
Expected: `SKIPPED: ...` message, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/fixtures/generate-sample-bill.mjs scripts/fixtures/sample-bill.pdf scripts/verify-document-extraction.mjs
git commit -m "test: add standalone verification for document extraction"
```

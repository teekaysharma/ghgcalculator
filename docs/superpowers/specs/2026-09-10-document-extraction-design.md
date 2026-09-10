# Activity-Data Document Extraction — Design

**Status:** Approved by product owner in brainstorming session, 2026-09-10. Ready for `writing-plans`.

## Problem

Entering activity data (electricity kWh, fuel litres, waste tonnage, etc.) into a source
stream's calculation approach is entirely manual today — a user reads a number off a bill or
invoice and types it into `CalculationApproachForm`
(`client/src/components/BoundaryWorkspace.tsx:621`), which `PUT`s to
`/api/source-streams/:id/calculation-approach`
(`server/routes.ts:2478`). Confirmed by direct codebase inspection: there is no PDF-parsing
library, no OCR library, no document-AI/vision SDK, and no file-upload middleware anywhere in
this app — extracting data from an uploaded document is a from-scratch capability, not an
extension of something partially built.

This is a **separate concern** from the still-undesigned-for-build emissions-*factors* upload
facility (EPA/EXIOBASE/IPCC reference tables, superadmin-only). This module extracts a tenant's
own **activity data** from their own source documents, and is used by ordinary tenant users on
their own source streams.

## Scope decisions (locked in during brainstorming)

- **Document types:** broad — any activity-data source document (utility bills, fuel/fleet
  invoices, waste manifests, travel receipts, etc.), not just one narrow format. This rules out
  a per-vendor template/recognizer approach (doesn't scale to "any document") in favor of a
  general-purpose multimodal model.
- **Review gate:** extraction always prefills a form for human review — nothing is ever
  auto-saved. Matches this app's existing audit-trail conventions
  (`dataQualityRecords`, per-gas traceability on `calculationApproaches`).
- **Entry point:** a user starts an upload from a specific source stream's
  `CalculationApproachForm`, not a general inbox. The stream context (facility, expected units)
  targets the extraction — no need for the model to guess what kind of document this is.
- **Provider:** a cloud API with a genuinely usable free tier — Google's Gemini API, which
  accepts PDFs and images directly with structured JSON output, no separate OCR step needed.
  No AI/LLM provider is configured anywhere in this app today (confirmed via `.env.example`) —
  this is a new dependency.
- **Retention:** the original uploaded document is kept as verification evidence, not discarded
  after extraction — consistent with this app's verification-ready design throughout
  (`docs/superpowers/specs/2026-08-14-verification-ready-multi-facility-inventory-design.md`).
  Requires file storage; Vercel Blob was chosen since it fits the existing Vercel deployment
  with no new infrastructure category.

## Architecture & data flow

1. `CalculationApproachForm` gets a new "Extract from document" control (file picker, accepts
   `.pdf,.png,.jpg,.jpeg,.webp`).
2. Client requests a scoped Blob client-upload token from
   `POST /api/source-streams/:id/document-extractions/upload-url`
   (`requireAuth + requireOrg`, matching every other source-stream route).
3. Client uploads the file **directly to Vercel Blob** using that token — not through the Express
   function. This sidesteps a real, confirmed constraint: Vercel's Node serverless functions cap
   request bodies around 4.5MB, which a scanned multi-page PDF could exceed. Routing the file
   bytes around the function entirely (via `@vercel/blob`'s client-upload pattern) avoids the
   limit rather than working around it after the fact.
4. Client calls `POST /api/source-streams/:id/document-extractions` with `{ blobUrl, fileName,
   mimeType }` — a small JSON payload, never the raw file.
5. Server fetches the blob content and sends it to the Gemini API in **one call** with a fixed
   JSON response schema: `quantity`, `unit`, `fuelOrMaterialType`, `periodStart`, `periodEnd`,
   `vendor`, each carrying a `confidence: "high" | "low"`. A field the model can't find comes
   back `null` rather than guessed.
6. Server writes a `documentExtractions` row (blob URL, extracted fields, model name, status
   `"extracted"`) and returns `{ documentExtractionId, extractedFields }` to the client. If the
   Gemini call itself fails, no row is written — the already-uploaded blob is kept, so the client
   can retry the extraction call against the same `blobUrl` without re-uploading the file.
7. Client prefills the existing form fields from the response. Any `"low"`-confidence field gets
   a visible warning badge (tooltip: "Extracted with low confidence — verify against the
   document"). The source file name is shown as a link above the fields it populated. Every field
   stays fully editable — manual entry with no upload continues to work exactly as it does today.
8. User reviews/edits, then saves via the **existing, unchanged**
   `PUT /api/source-streams/:id/calculation-approach`, with one additive optional field:
   `documentExtractionId`. When present, the server sets that extraction's
   `calculationApproachId` and `status: "confirmed"` in the same request — linking the saved
   activity data back to its source document. Absent (every pre-existing caller), behavior is
   byte-for-byte identical to today.

Extraction never writes `calculationApproaches` directly — it only ever populates client-side
form state that flows through the existing, unmodified save path.

## Schema

New table, `shared/schema.ts`, same tenant-scoped convention as `sourceStreams`:

```ts
export const documentExtractionStatuses = ["extracted", "confirmed", "discarded"] as const;
export type DocumentExtractionStatus = (typeof documentExtractionStatuses)[number];

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
    // {quantity, unit, fuelOrMaterialType, periodStart, periodEnd, vendor},
    // each {value, confidence: "high"|"low"}. Raw structured response from
    // the extraction call, kept in full even for fields the user later
    // overrides -- this is the audit record of what the model actually saw.
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

export type DocumentExtraction = typeof documentExtractions.$inferSelect;
```

`calculationApproachId` starts null (an extraction can exist before the user has saved anything)
and is set, along with `status: "confirmed"`, only when the calculation-approach save carries a
matching `documentExtractionId`. An extraction the user never confirms simply stays
`"extracted"` — harmless, still visible in the stream's history, no cleanup required.

Migration: `scripts/manual-migration-016.mjs` (016 is next — 013/014/015 are already taken by
the admin-action-log, membership-lifecycle, and has-been-verified migrations, confirmed against
`scripts/` on disk), same idempotent pattern as every prior manual migration in this repo —
`information_schema.tables` existence check gating the `CREATE TABLE`.

## API

All routes `requireAuth + requireOrg`, matching every other source-stream route (no new
middleware needed):

| Route | Purpose |
|---|---|
| `POST /api/source-streams/:id/document-extractions/upload-url` | Issues a scoped Vercel Blob client-upload token. |
| `POST /api/source-streams/:id/document-extractions` | Body `{ blobUrl, fileName, mimeType }`. Fetches the blob, calls Gemini, stores the row, returns `{ documentExtractionId, extractedFields }`. |
| `GET /api/source-streams/:id/document-extractions` | Lists past extractions for the stream — every document ever uploaded for it, confirmed or not, the audit trail. |

One additive change to an existing route: `PUT /api/source-streams/:id/calculation-approach`'s
Zod schema (`server/routes.ts:223`) gains an optional `documentExtractionId: z.number().optional()`.

**Server-side validation, not just client-side:** file type and size are checked again on the
extraction call, not only in the file picker's `accept` filter — a client-side filter can be
bypassed.

## Client UX

New block at the top of `CalculationApproachForm`, above the existing manual fields: file picker
+ "Extract from document" button. On success, the fields below (`activityDataValue`,
`activityDataUnit`, `fuelOrMaterialType`, etc.) prefill from the response; low-confidence fields
carry a small amber badge; the source file name appears as a link above the fields it populated.

## Error handling

- **File too large / wrong type** — checked client-side before upload starts, re-checked
  server-side on the extraction call. Rejected with a clear inline message, no wasted Gemini
  call.
- **Gemini call fails** (network, provider outage) — no `documentExtractions` row is written; the
  uploaded blob is kept so a retry can reuse it without re-uploading the file.
- **Document has nothing GHG-relevant on it** — the model returns all fields empty rather than
  guessing. The form shows "Couldn't find activity data in this document — enter values
  manually" instead of an error, since the upload itself succeeded.
- **A field the model can't find** — returned `null`, left blank on the form rather than
  fabricated.
- **Free-tier rate/quota limit hit** — surfaced as "Extraction is temporarily unavailable —
  please enter values manually," not a crash. Manual entry remains a full fallback at all times,
  never blocked by extraction being unavailable.
- **Wrong unit misread by the model** (e.g. therms read as kWh) — no automated unit-sanity-check
  in v1. This is a real, named limitation: the mandatory human-review step and confidence flags
  are the only safeguard for this failure mode in this version.

## Testing

- `scripts/verify-branch.mjs`'s schema check extended to confirm `document_extractions` exists
  (same pattern as every prior schema addition, most recently the super-admin-panel plan's
  `is_super_admin`/`admin_action_log` check).
- New standalone `scripts/verify-document-extraction.mjs` (parallel to `verify-admin-panel.mjs`)
  — kept **out** of `npm run verify` since it calls the real Gemini API and real Blob storage.
  Creates a tagged test org/source-stream via the real HTTP flow, extracts from a small synthetic
  fixture file committed to the repo (not a real bill — no real vendor/account data), asserts
  plausible fields come back, then cleans up.
- Manual browser pass: upload a real bill on a real source stream, confirm prefill, confidence
  badges, save, and that the saved `calculationApproach` links back to the `documentExtractions`
  row.

## Explicitly out of scope for v1

- Batch/multi-document upload (an inbox with a separate matching step) — stays single-document,
  single-source-stream, per the "extract from a specific stream" decision.
- Automated unit-sanity-checking (catching a therms-read-as-kWh mistake) — the human review step
  is the only safeguard for now.
- Multi-provider support — one Gemini call site, swappable later if ever needed; no abstraction
  layer built now.
- A "discard" action on an unconfirmed extraction — an unused one just sits harmlessly as
  `status: "extracted"`; no delete UI needed.
- Two-stage extraction (describe-then-map) — only worth building if single-call extraction proves
  unreliable on real documents; no evidence of that yet.

## Operational prerequisites (not provisionable from within this design/build process)

Two new real credentials are needed before this can run anywhere:

- `GEMINI_API_KEY` — free tier, obtained from Google AI Studio.
- `BLOB_READ_WRITE_TOKEN` — auto-provisioned once a Blob store is created in the Vercel project
  dashboard for this app.

Both will be documented in `.env.example` as part of the implementation plan, but **the Blob
store and Gemini key need to be created by the project owner** before this feature is testable
end-to-end — this cannot be provisioned by an implementer working from the plan alone.

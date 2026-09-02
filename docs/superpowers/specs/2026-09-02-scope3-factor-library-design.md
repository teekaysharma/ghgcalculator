# Scope 3 Spend-Based Factor Library (EPA NAICS-6 + EXIOBASE) — Design

Session date: 2026-09-02. Branch `scope3-data-quality`, forked from `main` post-merge. First phase of a larger Scope 3 data-quality/lineage/traceability initiative — the factor library both the spend-mapping workflow and the data-quality tiering logic (later phases, separate specs) depend on. Scoped down from an original all-at-once request covering mapping workflow, NAICS/EXIOBASE search, calculation + tiering + audit trail, and UI — those are independent subsystems and get their own specs once this foundation exists.

## Context and decisions made during brainstorming

- **Two source datasets, not one.** The request named "EPA NAICS-6" (via a 26-sheet `Sustainacert_UAE_Scope3_EEIO_Factor_Register` methodology workbook, real file, inspected directly) and, in a follow-up, EXIOBASE. Both are spend-based EEIO/MRIO sources with different strengths: EPA NAICS-6 is US-only but simple (a flat 1,016-row lookup); EXIOBASE is genuinely multi-regional (49 regions) but requires real input-output modeling to turn into usable multipliers, not a lookup table.
- **Two Python "ghg-calculator" projects that looked like prior art were investigated and rejected.** `C:\Users\LENOVO\Documents\ClaudeCowork\SKILLS\ghg-climate\ghg-calculator` and `...\starrygit\ghg-calculator` are the same repo (identical git remote, identical HEAD commit `eaa043c`). Its `exiobase/v3_8.json` is not derived from real EXIOBASE data — traced to `scripts/build_factors.py` (lines 834-908), which generates it procedurally from 7 hardcoded regions, 33 hand-typed uncited "base factor" guesses, and an invented regional multiplier dict. The README's claim of "peer-reviewed" databases is misleading. **Not used as a basis for anything here.**
- **`.zolca` files in Downloads (openLCA database exports of EXIOBASE) were also rejected as a source.** Confirmed via magic bytes (`50 4B 03 04`, ZIP) and internal structure (`seg0/*.dat` H2-database segment files, not human-readable exports) that these are openLCA's raw embedded-database storage, not a parseable data export. Parsing them would mean reverse-engineering openLCA's proprietary schema from raw binary segments — real risk of silent misreads. **User chose instead to source raw EXIOBASE3 directly and compute multipliers with `pymrio`.**
- **EXIOBASE version and year, verified against the actual downloaded files' own metadata (not assumed from search results, which initially surfaced a stale v3.8 claim — corrected mid-session):**
  - Files: `IOT_2022_ixi.zip` and `IOT_2022_pxp.zip`, both EXIOBASE **v3.10.2** (confirmed via each zip's `metadata.json`), from the official Zenodo record `https://zenodo.org/records/20051562` (the concept DOI `10.5281/zenodo.3583070` resolves here as the latest version).
  - `ixi`: 243,201,144 bytes, `pxp`: 234,096,377 bytes (md5 `96f187d8253d4d2363708a07ef3b1c02`) — both verified byte-for-byte against Zenodo's published checksums after download.
  - **2022 chosen over the also-available 2023/2024 within the same release**, per the release's own `Changelog.txt`: the underlying Supply-Use-Table/trade/energy data was rebuilt from real source statistics only through 2021-2022 ("Figaro (aggregate SUT) data to 2021, Bilateral trade data to 2022, Energy balances to 2021" — v3.10.0 notes); GHG emissions extended to 2023 are explicitly logged as "scaling of nowcasting" (v3.10.1 notes); 2024 sits one step further out on that same projection. The record's own "Now-casting" section: *"Caution should be made when using now-casted data, due to the higher levels of data interpolation."* 2022 is the newest year in this release still traceable to measured statistics rather than an extrapolation on top of them.
  - **Both `ixi` (163 industries) and `pxp` (200 products) are seeded**, not just one — `pxp` is the intended default for spend-mapping (better fit for "map the actual purchased item," the rule the Sustainacert workbook's own methodology already commits to), `ixi` stays available as a cross-check / fallback, tagged by a `tableType` column.
- **UAE has no individual EXIOBASE region code.** Confirmed directly from the parsed file's own region index (49 codes: 44 named countries + `WA`/`WL`/`WE`/`WF`/`WM`) and corroborated externally — UAE falls under `WM` (Rest of World – Middle East, which also covers Saudi Arabia, Egypt, Israel). This is a real, disclosed limitation, not a full geography match — moves UAE spend from a Tier 4 (US-only EEIO forced onto AED spend) toward Tier 3 territory per the draft data-quality policy's own tier definitions, not all the way to a UAE-specific figure.
- **Pipeline proven end-to-end on real data before this spec was written**, not just planned: parsed `IOT_2022_ixi.zip` via `pymrio.parse_exiobase3` (20.3s), ran `calc_all()` — a genuine Leontief inverse on the 7,987×7,987 region×sector matrix (109.7s) — and computed real region×sector GHG multipliers. Sample results (kg CO2e per EUR of output, combustion GHGs, direct+indirect, AR6 GWP-100):

  | Region | Sector | kg CO2e / EUR |
  |---|---|---|
  | US | Cultivation of wheat | 0.284 |
  | DE | Cultivation of wheat | 0.306 |
  | WM (UAE's region) | Cultivation of wheat | 0.735 |

  Cross-checked against the already-verified EPA NAICS-6 figure for a comparable sector (US Soybean Farming, NAICS 111110: 0.532 kg CO2e/2022 USD) — same order of magnitude, two independent methodologies (US EEIO vs. EXIOBASE MRIO) landing in a consistent range. This is real evidence the pipeline is sound, not a mockup.
- **A real unit bug was caught and fixed during that validation, not shipped.** EXIOBASE's `Z`/`Y`/`x` matrices are denominated in Million EUR (confirmed both from the root `unit.txt` inside the zip — every row reads `M.EUR` — and programmatically from `pymrio`'s own `io.unit` dataframe). The first computation pass, before catching this, produced multipliers ~1,000,000x too large (e.g. 216,100 kg CO2e/EUR for US rice cultivation — nonsensical). Fixed by dividing the `M` matrix by 1e6. **The production ingestion pipeline must read the unit from the file's own metadata (`io.unit`), not hardcode an assumption** — this is the single easiest way to silently corrupt every downstream figure by six orders of magnitude.
- **Licensing is real and currently unresolved, but explicitly not blocking this build.** EXIOBASE v3.9+ ships under a dual license (`LICENSE.txt`, fetched from the same Zenodo record): free for non-commercial use by universities/NGOs/government bodies only, explicitly excluding *"any use by for-profit or commercial entities"* and *"any use intended to generate revenue."* `ghgcalculator` is a commercial SaaS product. **User's explicit decision**: build now (pre-revenue, no paying customers, no trial data inserted yet), obtain the commercial license directly from `exiobase-support@googlegroups.com` before the product goes commercial. Carried into the migration script and seed data as an explicit, impossible-to-miss comment — see Licensing below.

## Data model — two new global reference tables

Both follow the existing `ipccDefaultFactors`/`gwpValues` pattern already established in `shared/schema.ts`: no `organizationId`, seeded shared reference data, structurally separate from the org-scoped `emissionFactorsTable` (which resolves the `Factor_Geography`/`Source_Dataset` vs. `country`/`source` field-collision that the Sustainacert workbook's column names would otherwise create against `emissionFactorsTable` — new tables mean new field names, not a collision to resolve).

```ts
export const epaNaicsFactors = pgTable("epa_naics_factors", {
  id: serial("id").primaryKey(),
  naicsCode: text("naics_code").notNull(),        // 6-digit 2017 NAICS
  naicsTitle: text("naics_title").notNull(),
  sefKgCo2ePerUsd: numeric("sef_kg_co2e_per_usd", { precision: 20, scale: 8 }).notNull(),   // without margins
  mefKgCo2ePerUsd: numeric("mef_kg_co2e_per_usd", { precision: 20, scale: 8 }),               // margins
  sefPlusMefKgCo2ePerUsd: numeric("sef_plus_mef_kg_co2e_per_usd", { precision: 20, scale: 8 }).notNull(), // headline figure
  referenceUseeioCode: text("reference_useeio_code"),
  factorYear: integer("factor_year").notNull(),    // 2022
  sourceDataset: text("source_dataset").notNull(), // "U.S. EPA Supply Chain GHG Emission Factors v1.3 by NAICS-6"
  sourceUrl: text("source_url").notNull(),
  retrievalDate: timestamp("retrieval_date").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  naicsIdx: index("epa_naics_factors_code_idx").on(table.naicsCode),
}));

export const exiobaseFactors = pgTable("exiobase_factors", {
  id: serial("id").primaryKey(),
  region: text("region").notNull(),                // 2-letter EXIOBASE code, e.g. "WM"
  regionLabel: text("region_label").notNull(),      // "Rest of World - Middle East"
  sector: text("sector").notNull(),
  tableType: text("table_type").notNull(),          // "pxp" | "ixi"
  kgCo2ePerEur: numeric("kg_co2e_per_eur", { precision: 20, scale: 10 }).notNull(),
  factorYear: integer("factor_year").notNull(),      // 2022
  exiobaseVersion: text("exiobase_version").notNull(), // "3.10.2"
  computedAt: timestamp("computed_at").notNull(),
  sourceUrl: text("source_url").notNull(),           // the Zenodo record
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  regionSectorIdx: index("exiobase_factors_region_sector_idx").on(table.region, table.sector, table.tableType),
}));

export const countryExiobaseRegions = pgTable("country_exiobase_regions", {
  id: serial("id").primaryKey(),
  countryCode: text("country_code").notNull().unique(), // ISO 3166-1 alpha-2, e.g. "AE"
  countryName: text("country_name").notNull(),
  exiobaseRegion: text("exiobase_region").notNull(),     // "WM" for AE, self ("US") for the 44 named countries
  isDirectMatch: boolean("is_direct_match").notNull(),   // false for RoW-aggregate mappings -- feeds the data-quality tier's "geography matched" test
});
```

**Deliberately excluded from v1, matching the granularity the EPA CSV itself already has:** per-gas breakdown. The `M` matrix computed by `pymrio` supports it (confirmed: `air_emissions.M` carries CO2/CH4/N2O and their biogenic variants as separate rows), but storing only the combined CO2e figure keeps both new tables schema-consistent with each other and with the source data's own primary granularity. Revisitable later without a rebuild — the pipeline would just sum fewer rows into more columns.

## Offline pipeline

A standalone Python script (`scripts/exiobase/build_factors.py` — name deliberately distinct from the rejected demo repo's `build_factors.py`), not part of the Node app's request path:

1. `pymrio.parse_exiobase3(path=<zip>)` for both `IOT_2022_pxp.zip` and `IOT_2022_ixi.zip`.
2. **Read the unit from `io.unit`, assert it equals `"M.EUR"`** — fail loudly rather than silently compute wrong numbers if a future EXIOBASE release changes this.
3. `io.calc_all()`.
4. Extract `io.air_emissions.M` rows for `CO2 - combustion - air`, `CH4 - combustion - air`, `CH4_bio - combustion - air`, `N2O - combustion - air` (the 4 rows already confirmed present).
5. Apply AR6 GWP-100 weights **read from this app's own `gwpValues` table**, not re-typed — the same verified numbers already used everywhere else in this codebase (CO2=1, CH4 fossil=29.8, CH4 biogenic=27.0, N2O=273).
6. Divide by 1,000,000 (the Million-EUR correction, with a comment explaining why — this is exactly the bug caught during validation).
7. Write one CSV per table type: `region, regionLabel, sector, kgCo2ePerEur, factorYear, exiobaseVersion`.
8. A hand-written idempotent migration (`scripts/manual-migration-010.mjs`, following the established numbering) loads both CSVs plus the EPA NAICS-6 CSV plus a seeded `countryExiobaseRegions` table into the three new tables — matching this project's confirmed-necessary pattern (`drizzle-kit push` is broken for multi-table/FK diffs on this Neon database, per `MIGRATIONS.md`).

Runs once now; re-run only when a newer EXIOBASE release is deliberately adopted (own decision, own re-validation — not an automatic upgrade).

## Licensing — explicit, not implicit

`scripts/exiobase/build_factors.py` and `manual-migration-010.mjs` both carry this comment verbatim, so it survives context loss across sessions:

> EXIOBASE v3.10.2 data. Non-commercial license only as of this migration (see LICENSE.txt at https://zenodo.org/records/20051562) — explicitly excludes "any use by for-profit or commercial entities" and "any use intended to generate revenue." User's explicit decision (2026-09-02): build now, pre-revenue/pre-customer; commercial license to be obtained from exiobase-support@googlegroups.com before this product is sold. Do not remove this comment until that license is confirmed in hand.

The generic-workbook/report-export code path (a later phase, not built yet) must not surface EXIOBASE-derived figures to any org until that license exists — the license's derivative-works clause is explicit that "derived coefficients... scope 1, 2, 3 emission factors" cannot be published without it. That gate belongs in the later mapping/calculation spec, not here, but the requirement itself is recorded now so it isn't lost.

## Explicitly out of scope for this spec

- Spend-line → NAICS/EXIOBASE-sector mapping workflow (confidence scoring, materiality/escalation, reviewer approval — the `Mapping_Workbench`/`Spend_Mapping` sheets in the Sustainacert workbook).
- The keyword/token-based search tool that helps a user find a candidate sector from a free-text procurement description (currently Excel formulas in the same workbook).
- Calculation + automatic data-quality tier assignment + the verifier-facing audit trail.
- Any UI.
- The 4 unresolved `[DECISION]` threshold values in `DATA-QUALITY-POLICY-draft.md` (materiality %, top-spend coverage %, minimum tier by materiality, CBAM strictness) — policy numbers, not blocking this technical foundation; the mapping/tiering phase consumes them as configuration, not hardcoded constants.

Each becomes its own spec once this factor library exists to build on.

# EXIOBASE GHG multiplier pipeline

**This is an offline, local, command-line tool. It is never run by the live app, and it must never
be wired into the deployed server.** It exists to (re-)compute the real region×sector GHG
multipliers that live in this app's `exiobase_factors` table, from EXIOBASE's own raw
multi-regional input-output (MRIO) data. Run it once whenever a new EXIOBASE release needs to be
ingested — this is a rare event (EXIOBASE does not publish new versions often) — then upload/commit
its output the same way this repo already does.

If you are reading this because a new machine needs to run this pipeline, this file is meant to be
everything you need. No other document should be required.

## What this actually computes, and why it can't be a simple lookup table

`build_factors.py` runs a genuine **Leontief inverse** over EXIOBASE's full multi-regional
input-output model (49 regions × ~163 sectors) via the [`pymrio`](https://pymrio.readthedocs.io/)
library — not a spreadsheet lookup, an actual linear-algebra solve against the economy-wide
transaction matrix. The output is a GHG-intensity multiplier (kg CO2e per EUR of output) for every
region-sector pair, derived from EXIOBASE's `air_emissions` satellite account and weighted by this
app's own AR6 GWP-100 values (sourced from the live `gwpValues` table, never hand-typed into this
script).

This is genuinely heavy computation (dense matrix products over thousands of region-sector cells)
and reads multi-gigabyte source files — it does not fit a web request, a serverless function, or
any part of the deployed Node.js app. See the "Why this stays local" section below if you're
weighing whether to change that.

## Prerequisites

- **Python 3.10+** with [`pymrio`](https://pypi.org/project/pymrio/) installed:
  ```bash
  pip install -r scripts/exiobase/requirements.txt
  ```
  (If this is the first time this pipeline has been run on a given machine and `requirements.txt`
  doesn't yet pin an exact version that's known to work, install `pymrio` fresh, run the pipeline
  successfully once, then `pip freeze | grep -i pymrio >> scripts/exiobase/requirements.txt` and
  commit that pin — so the *next* machine doesn't have to rediscover a working version.)
- **Node.js + this repo's `.env`** (a working `DATABASE_URL`) — needed for one prerequisite step
  before the Python script runs (see Step 2 below).
- **Real memory headroom.** This solves a dense linear system over the full EXIOBASE matrix; on the
  one confirmed run of this pipeline, parsing one table type took ~20s and `calc_all()` (the actual
  Leontief inverse + multiplier calculation) took ~110s. Budget several minutes total to process
  both table types, and use a machine with real RAM to spare (a modern laptop, 16GB+ recommended) —
  MRIO matrix products are not lightweight.
- **~500MB of free disk** for the two raw source zips, plus a bit more while they're being parsed.

## Step by step

### 1. Get the raw EXIOBASE source files

Download from Zenodo: **https://zenodo.org/records/20051562** (EXIOBASE v3.10.2, reference year
2022). You need exactly two files:

| File | Confirmed size | Confirmed MD5 |
|---|---|---|
| `IOT_2022_pxp.zip` | 234,096,377 bytes | `96f187d8253d4d2363708a07ef3b1c02` |
| `IOT_2022_ixi.zip` | 243,201,144 bytes | *(verify against the checksum Zenodo publishes for this record — not independently re-confirmed here beyond the pxp file above)* |

Verify at least the `pxp` file's MD5 against the table above before proceeding — this pipeline's
own history includes a real caught bug (a unit-conversion mistake that made every multiplier
~1,000,000× too large), so treat "did I actually get the right, uncorrupted file" as a real step,
not a formality.

**Place both files in `~/Downloads/`** (i.e. `C:\Users\<you>\Downloads\` on Windows,
`/home/<you>/Downloads` or `/Users/<you>/Downloads` elsewhere) — `build_factors.py` reads them from
exactly that location (see the `FILES` dict at the top of the script). If you'd rather keep them
somewhere else, edit that dict; there's no config file for this, it's a plain path in the script.

### 2. Export this app's current GWP-100 weights

From the repo root, with your `.env` pointed at the database you want the weights read from:

```bash
node scripts/manual-migration-011.mjs
```

This writes `scripts/exiobase/gwp_weights.json` from the live `gwpValues` table. The Python script
reads its GWP-100 weights from this file rather than having them hand-typed twice in two languages
— if this step is skipped, `build_factors.py` fails immediately with a clear `FileNotFoundError`
telling you to run this first.

### 3. Run the pipeline

```bash
python scripts/exiobase/build_factors.py
```

This parses both zip files, runs `calc_all()` (the Leontief inverse) on each, applies the GWP-100
weighting, and writes two output files:

- `scripts/exiobase/output/exiobase_pxp_2022.json`
- `scripts/exiobase/output/exiobase_ixi_2022.json`

Each is a flat JSON array of `{region, regionLabel, sector, tableType, kgCo2ePerEur, factorYear,
exiobaseVersion, sourceUrl, computedAt}` objects, one per region-sector pair. A `kgCo2ePerEur` of
`null` is not a bug — it means that region-sector's total output was zero (or unreported), making
the multiplier mathematically undefined (0/0), and the script deliberately stores `null` rather than
a misleading `0.0`.

The script fails loudly (raises, does not silently continue) on:
- Missing source files or a missing `gwp_weights.json` — see the error message, it tells you which
  prerequisite step to run.
- Unexpected units in the source data (it expects everything in `M.EUR`) — if this fires, do not
  proceed without re-deriving the `/1,000,000` conversion; this is the exact class of bug (unit
  mismatch) this pipeline was hardened against once already.
- A different count of GHG-bearing stressor rows than the 25 this script was built against — a
  newer EXIOBASE release may have changed its `air_emissions` extension's row set, which would need
  this script's `GWP_KEY` mapping re-checked by hand against the new release's `air_emissions/unit.txt`,
  not blindly re-run as-is.
- A stressor cell that's `NaN` despite a well-defined, non-zero total output — this previously
  surfaced a real data-quality gap in EXIOBASE's raw `air_emissions.F` that needed a `fillna(0.0)`
  fix (already applied in this script); if it fires again on a new release, the same class of gap
  has likely reappeared somewhere else and needs the same treatment.

### 4. Load the output into the database

```bash
node scripts/manual-migration-010.mjs
```

This is a standard idempotent migration (same pattern as every other `manual-migration-*.mjs` in
this repo): it reads the two JSON files this pipeline just produced and loads them into the
`exiobase_factors` table, `TRUNCATE`-and-reseeding if the table already has older data. Commit the
regenerated `scripts/exiobase/output/*.json` files to git along with any code changes — they're
tracked deliberately, so the computed result (not just the ability to reproduce it) survives even if
nobody re-runs this pipeline for years.

## Licensing — read before using this data anywhere near a paying customer

EXIOBASE v3.10.2's license (see `LICENSE.txt` at the Zenodo record above) is **non-commercial use
only** — it explicitly excludes "any use by for-profit or commercial entities" and "any use intended
to generate revenue." This project's own recorded decision: build and use this now, pre-revenue,
pre-customer, but **do not sell a product surfacing this data without first obtaining a commercial
license** from `exiobase-support@googlegroups.com`. Do not remove the licensing comment block at the
top of `build_factors.py` until that license is confirmed in hand — it's there on purpose, not
leftover boilerplate.

## Why this stays local instead of becoming a server feature

Short version: it's a rare, heavy, offline batch job, not a request-response web action. Running it
server-side would mean standing up a separate Python-capable compute environment (this app's
production deployment is Node.js-only serverless), a background job queue (the computation takes
minutes, not milliseconds), and a way to get multi-gigabyte source files into that environment —
real infrastructure, for something that needs to run maybe once a year. The integration point with
the running app is, and should stay, the already-computed JSON output — produced here, loaded via
`manual-migration-010.mjs` — not a live in-app trigger.

## Files in this folder

- `build_factors.py` — the pipeline itself.
- `requirements.txt` — pinned Python dependencies (see Prerequisites above).
- `gwp_weights.json` — generated by `node scripts/manual-migration-011.mjs`; not hand-edited.
- `output/` — the pipeline's committed output (`exiobase_pxp_2022.json`, `exiobase_ixi_2022.json`).
  Regenerate by re-running this whole pipeline, never hand-edit these either.

# Migrations on this branch

`drizzle-kit push` is unreliable against this project's live Neon database and should not be relied on. Documenting why, so nobody re-discovers this the hard way.

## What happened

Applying the ISO 14064-1 boundary tables (`reporting_entities`, `facilities`, `reporting_boundaries` — 3 new tables, 5 FKs, 2 unique constraints, 2 new columns on existing tables) via `npm run db:push` failed three separate times, on a real Neon database, with the identical error:

```
error: column "id" is in a primary key
code: '42P16'
routine: 'dropconstraint_internal'
```

No table or column name was ever included in the error. Three different hypotheses were tested and ruled out in order:

1. **Interactive rename-ambiguity prompts** (`push` sometimes can't tell if a new table is a create or a rename of an existing one) — real, but resolving them correctly did not fix the underlying crash.
2. **Orphaned rows** left over from an earlier interrupted push (rows in the new tables whose parent had since been deleted, because the FK that would have cascade-deleted them didn't exist yet when the crash happened) — real, found and cleaned up twice, did not fix the underlying crash.
3. **Ruled out entirely**: after manually bringing the database to a state that exactly matches `shared/schema.ts` (verified via `information_schema`/`pg_constraint`/`pg_indexes`, see `scripts/manual-migration-001.mjs`), `db:push` was run again against that already-correct database. It crashed with the exact same error, with nothing left to diff. This means it's not a data problem or a state problem, it's `drizzle-kit push` itself producing a broken statement for this schema shape in this environment.

## What to do instead

Schema changes on this branch are applied with hand-written, idempotent migration scripts, not `drizzle-kit push`. Pattern to follow, see `scripts/manual-migration-001.mjs`:

- Check `information_schema.columns` / `pg_constraint` / `pg_indexes` for whether each expected column/constraint/index already exists before adding it (every statement should be safe to run twice).
- Wrap the whole thing in one transaction, roll back on any failure, no partial migrations.
- Print what was applied vs. skipped.

`npm run verify` reflects this: it does **not** call `db:push`. It checks the live schema matches what's expected and fails with a clear message telling you to run the relevant migration script if not, rather than attempting a push that's proven to crash.

## If you want to try `drizzle-kit push` again anyway

It might work fine for a schema change that doesn't resemble this one (e.g. a single new column with no new tables/FKs involved), the failure here was specific to this particular diff shape. If you do try it and it fails the same way, don't spend time debugging it further, just write a migration script following the pattern above instead. This has already cost more time than it should have.

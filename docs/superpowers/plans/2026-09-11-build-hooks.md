# Build-Time Guardrail Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is the first plan in this project executed via `subagent-driven-development` rather than
> directly in the main session.** Each task below is a genuinely independent, self-contained unit
> with no dependency on session context a fresh implementer subagent wouldn't have — read the task
> and its files, nothing else needed.

**Goal:** Three build-time guardrail hooks wired into `.claude/settings.json`: block edits to
protected paths, block writes containing real-looking credential values, and auto-format every
file Claude touches with Prettier.

**Architecture:** Each guardrail is a small standalone Node script under `scripts/hooks/`, invoked
by a `PreToolUse` or `PostToolUse` hook entry in `.claude/settings.json` (project-scoped, committed
— matches this project's existing `scripts/*.mjs` convention rather than bash/jq, since Node is
already guaranteed on every machine that runs this repo and this is a Windows-primary environment).
`PreToolUse` hooks block by writing `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
"permissionDecision":"deny","permissionDecisionReason":"..."}}` to stdout; an allowed action writes
`{}`. `PostToolUse` hooks run after a legitimate write and can't block — the formatter hook is a
pure side effect.

**Tech Stack:** Node (`.mjs`, matching every other script in `scripts/`), Prettier 3.x, Claude Code's
hook system via `.claude/settings.json`.

## Global Constraints

- Protected paths (from the spec, category 1 — evidence of something already done, not code to
  edit): `scripts/manual-migration-*.mjs` (every file that currently exists), `scripts/exiobase/output/*.json`,
  `scripts/exiobase/gwp_weights.json`, `package-lock.json`. Explicitly NOT protected: `vercel.json`,
  `.env`, specs/plans/intents (see the spec's "Explicitly not protected" section for why).
- Credential scan (category 2) is driven live off `.env.example`'s declared variable names, never a
  hardcoded list, and excludes `.env` itself as the one legitimate place secrets belong.
- Prettier config is one override — `printWidth: 120` — everything else already matches this
  codebase's existing style (double quotes, semicolons, trailing commas), confirmed by direct
  inspection during design, not assumed.
- The one-time reformat is scoped to `.ts .tsx .js .mjs .jsx .css` only, excludes everything listed
  as protected above plus all `*.md` (markdown is out of scope entirely — see spec), runs as its own
  atomic commit, and is immediately followed by `npm run check` to prove `tsc` still passes.
- **This plan's own execution triggers `docs/superpowers/INDEX.md`'s "Next priorities" item 2**: once
  Task 3's reformat lands, `docs/superpowers/plans/2026-09-10-document-extraction.md`'s `file:line`
  references go stale. That refresh is a separate, already-tracked follow-up — not built here.
- Settings changes go to `.claude/settings.json` (project-scoped, git-committed) — NOT
  `.claude/settings.local.json` — since these guardrails are meant to be shared, version-controlled
  policy per the playbook, not a personal override.
- Hook JSON output schema (verified against the `update-config` skill's authoritative reference, not
  guessed): `PreToolUse` hook stdin is `{"session_id":...,"tool_name":"Write"|"Edit"|"MultiEdit",
  "tool_input":{"file_path":...,...}}`. To block: stdout
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
  "permissionDecisionReason":"..."}}`. To allow: stdout `{}`. `PostToolUse` stdin additionally carries
  `tool_response`.
- **Verification workflow for every task below** (from the `update-config` skill, not invented):
  pipe-test the raw script against synthesized stdin before wiring it into settings.json; after
  wiring, validate `.claude/settings.json`'s own JSON structure; then prove the hook actually fires
  through Claude Code itself, not just the script in isolation. **This project's `.claude/settings.json`
  does not exist yet** (confirmed — only `.claude/launch.json` is present), so Task 1 will very likely
  hit the documented "settings watcher isn't watching `.claude/` yet" caveat: if the pipe-test and the
  JSON-structure check both pass but the live end-to-end fire-test doesn't, that means the watcher
  started before this session created the file — tell the user to open `/hooks` once (reloads config)
  or restart, don't treat it as a bug in the hook itself.

---

### Task 1: Protected-path block hook

**Files:**
- Create: `scripts/hooks/protected-paths.mjs`
- Create: `.claude/settings.json` (does not exist yet in this repo)

**Interfaces:**
- Produces: `isProtectedPath(absoluteOrRelativePath: string): boolean`, exported from
  `scripts/hooks/protected-paths.mjs` — reused by Task 4's formatter hook to skip the same paths.

- [ ] **Step 1: Write the hook script**

Create `scripts/hooks/protected-paths.mjs`:

```js
#!/usr/bin/env node
// scripts/hooks/protected-paths.mjs
//
// PreToolUse guardrail hook (Write|Edit|MultiEdit) blocking edits to paths
// that are evidence of something already done, not code to edit -- see
// docs/superpowers/specs/2026-09-11-build-hooks-design.md's methodology
// (category 1). Also exports isProtectedPath() for reuse by
// scripts/hooks/format-on-write.mjs, which excludes the same paths from
// automatic reformatting.
//
// Wired as a PreToolUse hook in .claude/settings.json, matcher
// "Write|Edit|MultiEdit". Reads the hook input JSON from stdin, writes a
// decision to stdout per Claude Code's hook output schema.

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, relative as pathRelative } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// Each entry's own comment states which category-1 test it passes (see the
// spec) -- never add a path here on "feels risky" alone.
const PROTECTED_PATTERNS = [
  // Already-applied migrations: every file matching this glob that
  // currently exists is presumed to have run against the shared dev/
  // production database. New schema work always creates a new numbered
  // file, never edits an old one.
  /^scripts\/manual-migration-\d+\.mjs$/,
  // EXIOBASE pipeline output: scripts/exiobase/README.md's own rule --
  // never hand-edit, regenerate by re-running the pipeline.
  /^scripts\/exiobase\/output\/.+\.json$/,
  /^scripts\/exiobase\/gwp_weights\.json$/,
  // npm-managed lockfile: a generated record of what npm resolved, never
  // hand-edited.
  /^package-lock\.json$/,
];

export function isProtectedPath(absoluteOrRelativePath) {
  const rel = absoluteOrRelativePath.includes(REPO_ROOT)
    ? pathRelative(REPO_ROOT, absoluteOrRelativePath)
    : absoluteOrRelativePath;
  const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write("{}");
    return;
  }

  const filePath = input?.tool_input?.file_path;
  if (!filePath) {
    process.stdout.write("{}");
    return;
  }

  if (isProtectedPath(filePath)) {
    const rel = pathRelative(REPO_ROOT, filePath).replace(/\\/g, "/");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `${rel} is a protected path (evidence of something already done, not code to edit -- ` +
            `see docs/superpowers/specs/2026-09-11-build-hooks-design.md). New work creates a new ` +
            `file instead of editing this one.`,
        },
      }),
    );
    return;
  }

  process.stdout.write("{}");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 2: Pipe-test the raw script against a real protected file**

Run (from the repo root):

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"'"$(pwd)"'/scripts/manual-migration-015.mjs"}}' | node scripts/hooks/protected-paths.mjs
```

Expected: a JSON object with `"permissionDecision":"deny"` and a `permissionDecisionReason`
mentioning `scripts/manual-migration-015.mjs`.

- [ ] **Step 3: Pipe-test against a real non-protected file**

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"'"$(pwd)"'/server/storage.ts"}}' | node scripts/hooks/protected-paths.mjs
```

Expected: `{}`.

- [ ] **Step 4: Pipe-test against the two explicitly-rejected candidates**

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"'"$(pwd)"'/vercel.json"}}' | node scripts/hooks/protected-paths.mjs
echo '{"tool_name":"Edit","tool_input":{"file_path":"'"$(pwd)"'/.env"}}' | node scripts/hooks/protected-paths.mjs
```

Expected: `{}` for both — proves the spec's category-4 rejections actually hold in the
implementation, not just the design.

- [ ] **Step 5: Create `.claude/settings.json` and wire the hook**

This file does not exist yet in this repo. Create it:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/hooks/protected-paths.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Validate the settings file's structure**

```bash
node -e "const s=require('./.claude/settings.json'); const h=s.hooks.PreToolUse.find(e=>e.matcher==='Write|Edit|MultiEdit'); console.log(h.hooks[0].command)"
```

Expected: prints `node scripts/hooks/protected-paths.mjs`. A thrown error here means the JSON is
malformed or misnested — fix before continuing; a broken `settings.json` silently disables every
hook in the file.

- [ ] **Step 7: Prove the hook fires through Claude Code itself, not just the script**

Attempt an `Edit` on `scripts/manual-migration-015.mjs` (any trivial change, e.g. appending a
space to a comment) through the actual Edit tool. Expected: the edit is refused with the
`permissionDecisionReason` message from Step 1.

**If it is NOT refused despite Steps 2, 3, 4, and 6 all passing**: this repo's `.claude/settings.json`
did not exist when this session started, so the settings watcher was not watching `.claude/` yet.
This is the documented, expected caveat, not a bug in the hook — tell the user to open `/hooks` once
(reloads config) or restart the session, then re-attempt this step.

- [ ] **Step 8: Commit**

```bash
git add scripts/hooks/protected-paths.mjs .claude/settings.json
git commit -m "feat: add protected-path block hook"
```

---

### Task 2: Credential-scan hook

**Files:**
- Create: `scripts/hooks/credential-scan.mjs`
- Modify: `.claude/settings.json`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent script), but merges into the same
  `PreToolUse` / `"Write|Edit|MultiEdit"` matcher entry Task 1 created.
- Produces: `findLeakedCredential(content: string, envVarNames: string[]): string | null`, exported
  for direct unit-style pipe-testing below.

- [ ] **Step 1: Write the hook script**

Create `scripts/hooks/credential-scan.mjs`:

```js
#!/usr/bin/env node
// scripts/hooks/credential-scan.mjs
//
// PreToolUse guardrail hook (Write|Edit|MultiEdit) blocking any write that
// contains a real-looking value for a credential named in .env.example,
// outside .env itself -- see
// docs/superpowers/specs/2026-09-11-build-hooks-design.md's methodology
// (category 2). Self-maintaining: reads .env.example live on every
// invocation, so a newly added credential name is protected immediately,
// no separate hook-config update needed.

import { readFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, relative as pathRelative } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

export function getEnvVarNames() {
  const envExamplePath = join(REPO_ROOT, ".env.example");
  let content;
  try {
    content = readFileSync(envExamplePath, "utf8");
  } catch {
    return [];
  }
  const names = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match) names.push(match[1]);
  }
  return names;
}

function isEnvFile(filePath) {
  const rel = pathRelative(REPO_ROOT, filePath).replace(/\\/g, "/");
  return rel === ".env";
}

function extractNewContent(toolName, toolInput) {
  if (toolName === "Write") return toolInput.content ?? "";
  if (toolName === "Edit") return toolInput.new_string ?? "";
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((e) => e.new_string ?? "").join("\n");
  }
  return "";
}

export function findLeakedCredential(content, envVarNames) {
  for (const name of envVarNames) {
    // NAME=<non-empty value>; an empty assignment (NAME=) is a
    // template/placeholder, not a leak.
    const pattern = new RegExp(`\\b${name}=([^\\s"'` + "`" + `]+)`);
    const match = content.match(pattern);
    if (match && match[1].length > 0) return name;
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write("{}");
    return;
  }

  const filePath = input?.tool_input?.file_path;
  if (!filePath || isEnvFile(filePath)) {
    process.stdout.write("{}");
    return;
  }

  const content = extractNewContent(input.tool_name, input.tool_input ?? {});
  const leaked = findLeakedCredential(content, getEnvVarNames());

  if (leaked) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `This write contains what looks like a real value for ${leaked}, a credential declared ` +
            `in .env.example. Credentials belong only in .env, never in source, scripts, or ` +
            `committed docs.`,
        },
      }),
    );
    return;
  }

  process.stdout.write("{}");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 2: Pipe-test with a real-looking leaked credential**

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$(pwd)"'/scratch-test.ts","content":"const x = 1; // DATABASE_URL=postgresql://user:pass@host/db"}}' | node scripts/hooks/credential-scan.mjs
```

Expected: `"permissionDecision":"deny"`, reason mentions `DATABASE_URL`.

- [ ] **Step 3: Pipe-test the same content targeting `.env` — must be allowed**

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$(pwd)"'/.env","content":"DATABASE_URL=postgresql://user:pass@host/db"}}' | node scripts/hooks/credential-scan.mjs
```

Expected: `{}`.

- [ ] **Step 4: Pipe-test a clean write — must be allowed**

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$(pwd)"'/scratch-test.ts","content":"const x = 1;"}}' | node scripts/hooks/credential-scan.mjs
```

Expected: `{}`.

- [ ] **Step 5: Prove the scan is genuinely driven by `.env.example`'s live contents**

```bash
node -e "require('fs').appendFileSync('.env.example', '\nTHROWAWAY_TEST_VAR=\n')"
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$(pwd)"'/scratch-test.ts","content":"THROWAWAY_TEST_VAR=some-real-looking-value"}}' | node scripts/hooks/credential-scan.mjs
```

Expected: `"permissionDecision":"deny"`, reason mentions `THROWAWAY_TEST_VAR` — proves the scan
picked up a name that did not exist when the script was written, with no code change. **Then
revert**:

```bash
git checkout -- .env.example
```

Confirm with `git status` that `.env.example` shows no changes before continuing.

- [ ] **Step 6: Merge into the existing `PreToolUse` matcher entry**

Read `.claude/settings.json` (created by Task 1) and merge — do not replace the existing
`protected-paths.mjs` hook entry, add alongside it in the same matcher's `hooks` array:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/hooks/protected-paths.mjs",
            "timeout": 10
          },
          {
            "type": "command",
            "command": "node scripts/hooks/credential-scan.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 7: Validate the settings file's structure**

```bash
node -e "const s=require('./.claude/settings.json'); const h=s.hooks.PreToolUse.find(e=>e.matcher==='Write|Edit|MultiEdit'); console.log(h.hooks.map(x=>x.command))"
```

Expected: an array containing both `node scripts/hooks/protected-paths.mjs` and
`node scripts/hooks/credential-scan.mjs`.

- [ ] **Step 8: Prove the hook fires through Claude Code itself**

Attempt a `Write` to a new scratch file whose content contains `RESEND_API_KEY=re_realLookingValue123`
through the actual Write tool. Expected: refused, citing `RESEND_API_KEY`. If it is not refused
despite Steps 2-4 and 7 passing, this is the same `.claude/` watcher caveat from Task 1 — direct the
user to `/hooks` or a restart, not a script bug.

- [ ] **Step 9: Commit**

```bash
git add scripts/hooks/credential-scan.mjs .claude/settings.json
git commit -m "feat: add credential-leak scan hook, driven live by .env.example"
```

---

### Task 3: Prettier config and the one-time full repo-wide reformat

**Files:**
- Modify: `package.json` (add `prettier` devDependency)
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: every `.ts .tsx .js .mjs .jsx .css` file not excluded by `.prettierignore` (the reformat
  itself)

**Interfaces:**
- Produces: a working `npx prettier --write <file>` command, consumed by Task 4's hook.

- [ ] **Step 1: Add the dependency**

In `package.json`'s `"devDependencies"`, add:

```json
    "prettier": "^3.3.3",
```

Run: `npm install`

- [ ] **Step 2: Write the config**

Create `.prettierrc.json`:

```json
{
  "printWidth": 120
}
```

One override — direct inspection during design found this codebase already matches Prettier's
other defaults (double quotes, semicolons, trailing commas), confirmed via real counts (571 double-
vs 103 single-quoted lines in `server/routes.ts` alone), not assumed.

- [ ] **Step 3: Write the ignore file**

Create `.prettierignore`:

```
node_modules
dist
scripts/manual-migration-*.mjs
scripts/exiobase/output/
scripts/exiobase/gwp_weights.json
package-lock.json
*.md
```

`*.md` (gitignore-pattern semantics: matches at any depth) covers every markdown file including
root-level `CLAUDE.md`, `HANDOFF-SESSION.md`, and everything under `docs/**` — the spec's decision
to leave all prose docs out of the reformat's scope.

- [ ] **Step 4: Confirm Prettier's own view of what it would touch, before running it**

```bash
npx prettier --check "**/*.{ts,tsx,js,mjs,jsx,css}"
```

Expected: a list of files Prettier considers unformatted. Skim it — it should be the bulk of
`client/src/`, `server/`, `shared/`, `scripts/*.mjs` excluding the protected ones, and should NOT
include anything under `node_modules`, `dist`, or the excluded migration/exiobase/lockfile paths.
If an excluded path appears in this list, fix `.prettierignore` before proceeding.

- [ ] **Step 5: Run the reformat**

```bash
npx prettier --write "**/*.{ts,tsx,js,mjs,jsx,css}"
```

- [ ] **Step 6: Verify nothing broke**

```bash
npm run check
```

Expected: clean, no TypeScript errors — a pure whitespace/quote-style pass should never change
behavior, and this proves it rather than assumes it.

- [ ] **Step 7: Review the diff before committing**

```bash
git status
```

Expected: a large number of modified files, all source code — nothing under `node_modules`,
`dist`, or any excluded path, and no unrelated files (verify no stray scratch files got swept in).
This is a deliberate exception to "stage specific files by name" — virtually every source file
changed, so a scoped `git add` of each individually would be impractical; the review step above is
what keeps this safe.

- [ ] **Step 8: Commit as its own atomic commit — no other change mixed in**

```bash
git add -A
git commit -m "style: apply Prettier formatting repo-wide (printWidth 120)"
```

- [ ] **Step 9: Record the consequence this triggers**

This reformat is what makes `docs/superpowers/plans/2026-09-10-document-extraction.md`'s
`file:line` references stale, per `docs/superpowers/INDEX.md`'s "Next priorities, in order" item 2
(already tracked before this plan existed — nothing to write here, just confirm that entry is
still accurate and do not start refreshing that plan as part of this task; it is separately
scoped work).

---

### Task 4: Format-on-write hook, plus closing status updates

**Files:**
- Create: `scripts/hooks/format-on-write.mjs`
- Modify: `.claude/settings.json`
- Modify: `CLAUDE.md` (remove the now-closed "no hooks configured" line from its known-gaps list)
- Modify: `docs/superpowers/INDEX.md` (Hooks row: Stage → Shipped)

**Interfaces:**
- Consumes: `isProtectedPath` from `scripts/hooks/protected-paths.mjs` (Task 1).

- [ ] **Step 1: Write the hook script**

Create `scripts/hooks/format-on-write.mjs`:

```js
#!/usr/bin/env node
// scripts/hooks/format-on-write.mjs
//
// PostToolUse guardrail hook (Write|Edit|MultiEdit) auto-running Prettier on
// whatever file was just touched -- see
// docs/superpowers/specs/2026-09-11-build-hooks-design.md. Auto-fix, not
// block-and-complain: formatting has a safe, deterministic correction,
// unlike the PreToolUse guardrails in protected-paths.mjs and
// credential-scan.mjs, which must refuse rather than silently correct.
// Reuses the same protected-path exclusion list as the block hook -- no
// value in reformatting a file nobody may write to anyway.

import { execFileSync } from "child_process";
import { extname } from "path";
import { isProtectedPath } from "./protected-paths.mjs";

const FORMATTABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx", ".css"]);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const filePath = input?.tool_response?.filePath ?? input?.tool_input?.file_path;
  if (!filePath) return;
  if (!FORMATTABLE_EXTENSIONS.has(extname(filePath))) return;
  if (isProtectedPath(filePath)) return;

  try {
    execFileSync("npx", ["prettier", "--write", filePath], { stdio: "ignore" });
  } catch {
    // Formatting failures (e.g. a syntax error mid-edit) must never block
    // the turn -- this is a PostToolUse convenience, not a gate.
  }
}

main();
```

- [ ] **Step 2: Pipe-test against a deliberately misformatted scratch file**

```bash
printf 'const x = {a:1,\n\n\nb:2};' > scratch-format-test.ts
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$(pwd)"'/scratch-format-test.ts"}}' | node scripts/hooks/format-on-write.mjs
cat scratch-format-test.ts
```

Expected: the file is now Prettier-formatted (consistent spacing, no triple-blank-line gap,
trailing comma per this project's config). Clean up: `rm scratch-format-test.ts`.

- [ ] **Step 3: Pipe-test against a protected path — must NOT be reformatted**

```bash
node -e "const fs=require('fs'); fs.copyFileSync('scripts/manual-migration-015.mjs','scripts/manual-migration-015.mjs.bak')"
echo '{"tool_name":"Edit","tool_input":{"file_path":"'"$(pwd)"'/scripts/manual-migration-015.mjs"}}' | node scripts/hooks/format-on-write.mjs
diff scripts/manual-migration-015.mjs scripts/manual-migration-015.mjs.bak
rm scripts/manual-migration-015.mjs.bak
```

Expected: `diff` reports no differences — the protected file was left untouched even though the
hook ran, because `isProtectedPath` skipped it before Prettier was ever invoked.

- [ ] **Step 4: Merge into `.claude/settings.json`'s `PostToolUse`**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/hooks/format-on-write.mjs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Merge alongside the existing `PreToolUse` block from Tasks 1-2 — `PreToolUse` and `PostToolUse`
are sibling keys under `hooks`, both must be present afterward.

- [ ] **Step 5: Validate the settings file's full structure**

```bash
node -e "const s=require('./.claude/settings.json'); console.log('PreToolUse hooks:', s.hooks.PreToolUse[0].hooks.map(h=>h.command)); console.log('PostToolUse hooks:', s.hooks.PostToolUse[0].hooks.map(h=>h.command))"
```

Expected: `PreToolUse hooks:` lists both Task 1 and Task 2's commands; `PostToolUse hooks:` lists
this task's command.

- [ ] **Step 6: Prove the formatter fires end to end**

Via the actual Edit tool, introduce a detectable violation into a scratch file (two consecutive
blank lines inside a function, or a missing semicolon on a `const` line) in a file with a
formattable extension outside the protected list, then re-read the file. Expected: the violation
is gone — Prettier corrected it automatically as a side effect of the edit landing. Same watcher
caveat as Tasks 1-2 applies if this fails despite Steps 2-3, 5 passing.

- [ ] **Step 7: Update `CLAUDE.md`'s known-gaps list**

In `CLAUDE.md`'s "Known gaps against the playbook's later stages" bullet list (under Development
Process), remove the line "No hooks configured anywhere." — this gap is now closed. Leave every
other listed gap (test suite, CI/CD, `REVIEW.md`, Stage 6 monitoring) exactly as-is.

- [ ] **Step 8: Update `docs/superpowers/INDEX.md`**

Change the Hooks row's Stage from "Spec approved" to "Shipped," and update its Status cell to
reflect what actually landed: three hooks live in `.claude/settings.json`
(`scripts/hooks/protected-paths.mjs`, `credential-scan.mjs`, `format-on-write.mjs`), plus the
one-time Prettier reformat from Task 3.

- [ ] **Step 9: Commit**

```bash
git add scripts/hooks/format-on-write.mjs .claude/settings.json CLAUDE.md docs/superpowers/INDEX.md
git commit -m "feat: add format-on-write hook; close out the Hooks initiative"
```

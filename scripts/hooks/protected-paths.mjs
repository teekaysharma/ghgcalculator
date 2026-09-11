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
import { dirname, join, relative as pathRelative, resolve, isAbsolute } from "path";

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
  let normalized = absoluteOrRelativePath;
  // Handle Git Bash POSIX paths like /c/Users/... by converting to Windows format
  // Matches /c/, /C/, /d/, etc. and converts to C:\, D:\, etc.
  if (normalized.match(/^\/[a-z]\//i)) {
    const driveLetter = normalized[1].toUpperCase();
    normalized = driveLetter + ":\\" + normalized.substring(3).replace(/\//g, "\\");
  }
  const absolute = isAbsolute(normalized) ? normalized : resolve(REPO_ROOT, normalized);
  const rel = pathRelative(REPO_ROOT, absolute).replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(rel));
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

  let filePath = input?.tool_input?.file_path;
  if (!filePath) {
    process.stdout.write("{}");
    return;
  }

  // Normalize POSIX paths to Windows format for consistent handling
  if (filePath.match(/^\/[a-z]\//i)) {
    const driveLetter = filePath[1].toUpperCase();
    filePath = driveLetter + ":\\" + filePath.substring(3).replace(/\//g, "\\");
  }

  if (isProtectedPath(filePath)) {
    const absolute = isAbsolute(filePath) ? filePath : resolve(REPO_ROOT, filePath);
    const rel = pathRelative(REPO_ROOT, absolute).replace(/\\/g, "/");
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

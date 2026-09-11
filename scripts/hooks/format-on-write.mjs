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

import { spawnSync } from "child_process";
import { extname, dirname, join } from "path";
import { fileURLToPath } from "url";
import { isProtectedPath, toWindowsAbsolutePath } from "./protected-paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

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

  let filePath = input?.tool_response?.filePath ?? input?.tool_input?.file_path;
  if (!filePath) return;
  if (!FORMATTABLE_EXTENSIONS.has(extname(filePath))) return;
  if (isProtectedPath(filePath)) return;

  filePath = toWindowsAbsolutePath(filePath, REPO_ROOT);

  try {
    spawnSync(`npx prettier --write "${filePath}"`, { shell: true, stdio: "ignore" });
  } catch {
    // Formatting failures (e.g. a syntax error mid-edit) must never block
    // the turn -- this is a PostToolUse convenience, not a gate.
  }
}

main();

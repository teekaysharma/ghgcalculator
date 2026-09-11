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
import { dirname, join, relative as pathRelative, resolve, isAbsolute } from "path";

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
  let normalized = filePath;
  // Handle Git Bash POSIX paths like /c/Users/... by converting to Windows format
  // Matches /c/, /C/, /d/, etc. and converts to C:\, D:\, etc.
  if (normalized.match(/^\/[a-z]\//i)) {
    const driveLetter = normalized[1].toUpperCase();
    normalized = driveLetter + ":\\" + normalized.substring(3).replace(/\//g, "\\");
  }
  const absolute = isAbsolute(normalized)
    ? normalized
    : resolve(REPO_ROOT, normalized);
  const rel = pathRelative(REPO_ROOT, absolute).replace(/\\/g, "/").replace(/^\.\//, "");
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

  if (isEnvFile(filePath)) {
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

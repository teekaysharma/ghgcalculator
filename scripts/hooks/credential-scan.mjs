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
import { toWindowsAbsolutePath } from "./protected-paths.mjs";

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
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    // A name declared with a real committed default value (e.g. PORT, which
    // ships with a real port number) is self-evidently not a secret -- only
    // bare `NAME=` placeholders, meant to be filled with a real credential
    // locally, are scanned for.
    if (match && match[2].trim() === "") names.push(match[1]);
  }
  return names;
}

function isEnvFile(filePath) {
  const absolute = toWindowsAbsolutePath(filePath, REPO_ROOT);
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
    const pattern = new RegExp(`\\b${name}=["'` + "`" + `]?([^\\s"'` + "`" + `]+)`);
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
  if (!filePath) {
    process.stdout.write("{}");
    return;
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

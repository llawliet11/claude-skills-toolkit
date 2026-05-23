#!/usr/bin/env bun
// Resolve the target memory folder for the /nf-memoria skill.
//
// Cascade (first match wins):
//   1. $CLAUDE_COWORK_MEMORY_PATH_OVERRIDE in current env
//   2. <toplevel>/.claude/settings.local.json -> .env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
//   3. <toplevel>/.claude/settings.local.json -> .autoMemoryDirectory
//   4. $HOME/.claude/settings.json -> .autoMemoryDirectory
//   5. Binary default: $HOME/.claude/projects/<sanitized-pwd>/memory/
//
// Output: two lines on stdout
//     path=<absolute-resolved-path>
//     source=<env|local-env|local-auto|user|bindef>
// All diagnostics go to stderr.
//
// Exit codes:
//   0 - resolved + mkdir ok
//   2 - recursive-memory conflict (resolved path inside toplevel)
//   4 - mkdir failed

import { existsSync, readFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { $ } from "bun";

const HOME = homedir();

const HELP = `Resolve the target memory folder for the /nf-memoria skill.

Cascade (first match wins):
  1. $CLAUDE_COWORK_MEMORY_PATH_OVERRIDE in current env
  2. <toplevel>/.claude/settings.local.json -> .env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  3. <toplevel>/.claude/settings.local.json -> .autoMemoryDirectory
  4. $HOME/.claude/settings.json -> .autoMemoryDirectory
  5. Binary default: $HOME/.claude/projects/<sanitized-pwd>/memory/

Output:
  path=<absolute>
  source=<env|local-env|local-auto|user|bindef>

Exit codes:
  0 - resolved + mkdir ok
  2 - recursive-memory conflict
  4 - mkdir failed
`;

const args = process.argv.slice(2);
for (const a of args) {
  if (a === "-h" || a === "--help") {
    console.log(HELP);
    process.exit(0);
  } else {
    console.error(`resolve-memory-folder: unknown arg: ${a}`);
  }
}

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return HOME + p.slice(1);
  return p;
}

function readJsonField(file, path) {
  try {
    if (!existsSync(file)) return "";
    const data = JSON.parse(readFileSync(file, "utf8"));
    let v = data;
    for (const p of path.split(".")) {
      if (v == null || typeof v !== "object") return "";
      v = v[p];
    }
    return v != null && v !== "" ? String(v) : "";
  } catch {
    return "";
  }
}

const r = await $`git rev-parse --show-toplevel`.nothrow().quiet();
const TOPLEVEL = r.exitCode === 0 ? r.text().trim() : process.cwd();

const LOCAL_SETTINGS = `${TOPLEVEL}/.claude/settings.local.json`;
const USER_SETTINGS = `${HOME}/.claude/settings.json`;

let RESOLVED = "";
let SOURCE = "";

// Step 1: env
if (process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE) {
  RESOLVED = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE;
  SOURCE = "env";
}

// Step 2: <toplevel>/.claude/settings.local.json -> env override
if (!RESOLVED) {
  const v = readJsonField(LOCAL_SETTINGS, "env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE");
  if (v) {
    RESOLVED = v;
    SOURCE = "local-env";
  }
}

// Step 3: <toplevel>/.claude/settings.local.json -> autoMemoryDirectory
if (!RESOLVED) {
  const v = readJsonField(LOCAL_SETTINGS, "autoMemoryDirectory");
  if (v) {
    RESOLVED = v;
    SOURCE = "local-auto";
  }
}

// Step 4: user settings autoMemoryDirectory
if (!RESOLVED) {
  const v = readJsonField(USER_SETTINGS, "autoMemoryDirectory");
  if (v) {
    RESOLVED = v;
    SOURCE = "user";
  }
}

// Step 5: binary default
if (!RESOLVED) {
  const sanitized = process.cwd().replace(/[/.]/g, "-");
  RESOLVED = `${HOME}/.claude/projects/${sanitized}/memory/`;
  SOURCE = "bindef";
}

RESOLVED = expandTilde(RESOLVED);

// Recursive-memory safeguard: reject if resolved path is inside the toplevel.
// Allow when toplevel itself is under ~/.claude (memory may live there by design).
if (
  (RESOLVED + "/").startsWith(TOPLEVEL + "/") &&
  !TOPLEVEL.startsWith(`${HOME}/.claude`)
) {
  console.error(
    `resolve-memory-folder: refusing to write memory inside repo toplevel (${TOPLEVEL})`,
  );
  console.error(`  resolved=${RESOLVED} source=${SOURCE}`);
  process.exit(2);
}

try {
  mkdirSync(RESOLVED, { recursive: true });
} catch {
  console.error(`resolve-memory-folder: mkdir -p failed for ${RESOLVED}`);
  process.exit(4);
}

console.log(`path=${RESOLVED}`);
console.log(`source=${SOURCE}`);

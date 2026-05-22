#!/usr/bin/env bun
/**
 * Reverse-lookup cwd from an originSessionId.
 *
 * Scans ~/.claude/projects/<encoded-cwd>/ for a JSONL file matching <sessionId>,
 * decodes the cwd from the folder name (encoding: leading `-` + `/` → `-`).
 *
 * Usage:
 *   bun resolve-cwd-from-session.ts <sessionId> [--json]
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const PROJECTS_ROOT = resolve(homedir(), ".claude", "projects");

export function decodeFolderName(folderName: string): string {
  if (!folderName.startsWith("-")) return "";
  const s = folderName.slice(1);
  let decoded = "/" + s.replace(/-/g, "/");
  // `me//claude` → `me/.claude` (hidden-folder pattern)
  decoded = decoded.replace(/\/\//g, "/.");
  return decoded;
}

export interface SessionMatch {
  folder: string;
  cwd: string;
  jsonl: string;
}

export interface ResolveResult {
  ok: boolean;
  matches: SessionMatch[];
  session_id: string;
  error?: string;
}

export function resolveSession(sessionId: string): ResolveResult {
  if (!existsSync(PROJECTS_ROOT)) {
    return { ok: false, matches: [], session_id: sessionId, error: `${PROJECTS_ROOT} does not exist` };
  }
  const matches: SessionMatch[] = [];
  for (const entry of readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folderPath = resolve(PROJECTS_ROOT, entry.name);
    let files: string[];
    try {
      files = readdirSync(folderPath);
    } catch {
      continue;
    }
    const want = `${sessionId}.jsonl`;
    if (files.includes(want)) {
      const cwd = decodeFolderName(entry.name);
      matches.push({ folder: entry.name, cwd, jsonl: resolve(folderPath, want) });
    }
  }
  return { ok: matches.length > 0, matches, session_id: sessionId };
}

interface Args {
  sessionId: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { sessionId: "", json: false, help: false };
  const rest: string[] = [];
  for (const t of argv) {
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--json") a.json = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help) throw new Error("missing <sessionId> argument");
  a.sessionId = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun resolve-cwd-from-session.ts <sessionId> [--json]

Reverse-lookup cwd from an originSessionId by scanning ~/.claude/projects/*/.`);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  const result = resolveSession(args.sessionId);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    console.error(`No match for sessionId ${args.sessionId}`);
    return 1;
  }
  for (const m of result.matches) {
    console.log(`${m.cwd}\t${m.folder}`);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

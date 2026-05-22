#!/usr/bin/env bun
/**
 * which-project.ts — quick "which project does this memory file belong to?"
 *
 * Standalone CLI that runs the full (file → project) fallback chain from
 * `_lib.resolveFileProject`. Useful both as a debugging helper and as a
 * pre-flight check before nf-dream pipeline runs.
 *
 * Usage:
 *   bun which-project.ts <file>            # explain one file
 *   bun which-project.ts <folder>          # summary table per file in folder
 *   bun which-project.ts <path> --json     # JSON output
 *   bun which-project.ts <path> --signals  # show every signal hit (not just winner)
 *
 * In folder mode (default) only the winning signal is printed per row, but
 * collisions and "no project resolved" entries are surfaced at the top.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  basename,
  extractFrontmatterDict,
  iterMemoryFiles,
  loadRegistry,
  parseFrontmatter,
  resolveFileProject,
  type ProjectSignal,
  type ResolvedProject,
} from "./_lib";

interface PerFile {
  file: string;
  resolved: ResolvedProject;
}

function classifyOne(absPath: string, cheap: boolean): PerFile {
  const text = readFileSync(absPath, "utf8");
  const parsed = parseFrontmatter(text);
  const fm = parsed ? extractFrontmatterDict(parsed.fmLines) : {};
  const body = parsed ? parsed.body : text;
  const registry = loadRegistry();
  const resolved = resolveFileProject(absPath, fm, { body, registry, cheap });
  return { file: basename(absPath), resolved };
}

function printOneText(pf: PerFile, allSignals: boolean): void {
  const r = pf.resolved;
  console.log(`which-project — ${pf.file}`);
  console.log(`  resolved: project=${r.slug || "(unresolved)"} signal=${r.signal} confidence=${r.confidence}`);
  if (r.collision) {
    console.log(`  COLLISION: frontmatter='${r.details.fromFrontmatter}' suffix='${r.details.fromFilenameSuffix}' (frontmatter wins)`);
  }
  if (allSignals) {
    console.log(`  signals seen:`);
    const rows: [string, string | undefined][] = [
      ["frontmatter", r.details.fromFrontmatter],
      ["filename_suffix", r.details.fromFilenameSuffix],
      ["filename_token", r.details.fromFilenameToken],
      ["body_path", r.details.fromBodyPath],
      ["body_url", r.details.fromBodyUrl],
    ];
    for (const [k, v] of rows) {
      console.log(`    ${k.padEnd(18)} ${v ? `→ ${v}` : "(none)"}`);
    }
  }
}

interface FolderResult {
  scope: string;
  total: number;
  by_signal: Record<string, number>;
  by_project: Record<string, number>;
  collisions: PerFile[];
  unresolved: PerFile[];
  files: PerFile[];
}

function classifyFolder(scope: string, cheap: boolean): FolderResult {
  const files: PerFile[] = [];
  for (const f of iterMemoryFiles(scope)) {
    files.push(classifyOne(f, cheap));
  }
  const bySignal: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  const collisions: PerFile[] = [];
  const unresolved: PerFile[] = [];
  for (const pf of files) {
    const sig = pf.resolved.signal;
    bySignal[sig] = (bySignal[sig] ?? 0) + 1;
    const proj = pf.resolved.slug || "(unresolved)";
    byProject[proj] = (byProject[proj] ?? 0) + 1;
    if (pf.resolved.collision) collisions.push(pf);
    if (pf.resolved.signal === "none") unresolved.push(pf);
  }
  return {
    scope,
    total: files.length,
    by_signal: bySignal,
    by_project: byProject,
    collisions,
    unresolved,
    files,
  };
}

function printFolderText(r: FolderResult, allSignals: boolean): void {
  console.log(`which-project — ${r.scope}`);
  console.log(`  total files: ${r.total}`);
  console.log();
  console.log(`## By project:`);
  for (const [proj, n] of Object.entries(r.by_project).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${proj.padEnd(28)} ${n}`);
  }
  console.log();
  console.log(`## By signal:`);
  for (const [sig, n] of Object.entries(r.by_signal).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sig.padEnd(20)} ${n}`);
  }
  if (r.collisions.length > 0) {
    console.log();
    console.log(`## Collisions (${r.collisions.length}) — frontmatter ≠ filename suffix:`);
    for (const pf of r.collisions.slice(0, 20)) {
      console.log(`  ${pf.file}`);
      console.log(`    frontmatter='${pf.resolved.details.fromFrontmatter}'  suffix='${pf.resolved.details.fromFilenameSuffix}'`);
    }
    if (r.collisions.length > 20) console.log(`  ... and ${r.collisions.length - 20} more`);
  }
  if (r.unresolved.length > 0) {
    console.log();
    console.log(`## Unresolved (${r.unresolved.length}) — no signal matched:`);
    for (const pf of r.unresolved.slice(0, 30)) {
      console.log(`  ${pf.file}`);
    }
    if (r.unresolved.length > 30) console.log(`  ... and ${r.unresolved.length - 30} more`);
  }
  if (allSignals) {
    console.log();
    console.log(`## Per file:`);
    for (const pf of r.files) {
      const r2 = pf.resolved;
      console.log(`  ${pf.file.padEnd(60)} ${(r2.slug || "(unresolved)").padEnd(20)} ${r2.signal.padEnd(16)} conf=${r2.confidence}`);
    }
  }
}

interface Args {
  path: string;
  json: boolean;
  signals: boolean;
  cheap: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { path: "", json: false, signals: false, cheap: false, help: false };
  const rest: string[] = [];
  for (const t of argv) {
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--json") a.json = true;
    else if (t === "--signals") a.signals = true;
    else if (t === "--cheap") a.cheap = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help) throw new Error("missing <path>");
  a.path = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun which-project.ts <file|folder> [--json] [--signals] [--cheap]

Resolve the project a memory file belongs to (or every file in a folder),
using the full fallback chain: frontmatter → filename suffix → filename token
→ body path → body URL → type=user.

Flags:
  --json     JSON output for scripting
  --signals  Show every signal that fired, not just the winning one
  --cheap    Skip body-based signals (body_path/body_url) — faster, recommended
             for hot paths`);
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
  const absPath = resolve(args.path.replace(/^~/, process.env.HOME ?? ""));
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    console.error(`ERROR: ${absPath} not found`);
    return 1;
  }

  if (stat.isFile()) {
    const pf = classifyOne(absPath, args.cheap);
    if (args.json) {
      console.log(JSON.stringify(pf, null, 2));
      return 0;
    }
    printOneText(pf, args.signals);
    return 0;
  }
  if (stat.isDirectory()) {
    const r = classifyFolder(absPath, args.cheap);
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    printFolderText(r, args.signals);
    return 0;
  }
  console.error(`ERROR: ${absPath} is neither file nor directory`);
  return 1;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

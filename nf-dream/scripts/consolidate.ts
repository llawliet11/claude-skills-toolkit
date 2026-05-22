#!/usr/bin/env bun
/**
 * nf-dream consolidate — move aged session-end states + Stale bucket into
 * archive/YYYY-MM/. Updates archive/README.md breadcrumb + MEMORY.md index.
 *
 * Usage:
 *   bun consolidate.ts <scope> [--apply] [--json] [--project <slug>]
 *                              [--include-generic] [--age-days 14]
 */
import {
  readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { isSessionEnd } from "./_lib";
import { classifyScope } from "./classify";

function deriveArchiveMonth(path: string): string {
  const name = path.split("/").pop() ?? "";
  const m = name.match(/(\d{4})[_-](\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  const mtime = statSync(path).mtime;
  return `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, "0")}`;
}

interface PlanItem {
  src: string;
  target: string;
  bucket: string;
  reason: string;
}

interface BuildOpts {
  scope: string;
  project: string | null;
  includeGeneric: boolean;
  ageDays: number;
}

function buildPlan(opts: BuildOpts): PlanItem[] {
  const classifyData = classifyScope(opts.scope, opts.project, opts.includeGeneric);
  const ageCutoff = Date.now() / 1000 - opts.ageDays * 24 * 3600;
  const plan: PlanItem[] = [];
  for (const entries of Object.values(classifyData.buckets)) {
    for (const entry of entries) {
      const path = resolve(opts.scope, entry.file);
      if (!existsSync(path)) continue;
      let archiveCandidate = false;
      let reason = "";
      if (entry.bucket === "Stale") {
        archiveCandidate = true;
        reason = `Stale (${entry.reason})`;
      } else if (isSessionEnd(entry.file) && entry.mtime < ageCutoff) {
        archiveCandidate = true;
        reason = `session-end older than ${opts.ageDays}d`;
      }
      if (archiveCandidate) {
        const ym = deriveArchiveMonth(path);
        plan.push({
          src: entry.file,
          target: `archive/${ym}/${entry.file}`,
          bucket: entry.bucket,
          reason,
        });
      }
    }
  }
  return plan;
}

function updateArchiveReadme(scope: string, moves: PlanItem[]): void {
  const readmePath = resolve(scope, "archive", "README.md");
  mkdirSync(dirname(readmePath), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const existing = existsSync(readmePath)
    ? readFileSync(readmePath, "utf8")
    : "# Archive\n\nMoved memory files by date.\n";
  const lines = [existing.trimEnd(), ""];
  for (const m of moves) {
    lines.push(`- ${today}: \`${m.src}\` → \`${m.target}\` (${m.reason})`);
  }
  lines.push("");
  writeFileSync(readmePath, lines.join("\n"));
}

function updateMemoryMd(scope: string, archivedNames: Set<string>): number {
  const memoryPath = resolve(scope, "MEMORY.md");
  if (!existsSync(memoryPath)) return 0;
  const text = readFileSync(memoryPath, "utf8");
  const newLines: string[] = [];
  let removed = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/\[[^\]]+\]\(([^)]+\.md)\)/);
    if (m && archivedNames.has(m[1])) { removed++; continue; }
    newLines.push(line);
  }
  let newText = newLines.join("\n");
  if (!newText.includes("- [Archive](archive/README.md)")) {
    newText = newText.trimEnd() + "\n\n- [Archive](archive/README.md) — consolidated session-end states\n";
  }
  writeFileSync(memoryPath, newText);
  return removed;
}

function applyPlan(scope: string, plan: PlanItem[]): { ok: true; moved: number } {
  const movesDone: PlanItem[] = [];
  for (const entry of plan) {
    const src = resolve(scope, entry.src);
    const target = resolve(scope, entry.target);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(src, target);
    movesDone.push(entry);
  }
  if (movesDone.length > 0) {
    updateArchiveReadme(scope, movesDone);
    updateMemoryMd(scope, new Set(movesDone.map((m) => m.src)));
  }
  return { ok: true, moved: movesDone.length };
}

interface Args {
  scope: string;
  apply: boolean;
  json: boolean;
  project: string | null;
  ageDays: number;
  includeGeneric: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    scope: "", apply: false, json: false, project: null,
    ageDays: 14, includeGeneric: false, help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--apply") a.apply = true;
    else if (t === "--json") a.json = true;
    else if (t === "--include-generic") a.includeGeneric = true;
    else if (t === "--project") a.project = argv[++i] ?? null;
    else if (t === "--age-days") a.ageDays = parseInt(argv[++i] ?? "14", 10);
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help) throw new Error("missing <scope>");
  a.scope = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun consolidate.ts <scope> [--apply] [--json] [--project <slug>]
                          [--include-generic] [--age-days 14]

Move aged session-end + Stale bucket into archive/YYYY-MM/.`);
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
  if (args.help) { printHelp(); return 0; }
  const scope = resolve(args.scope.replace(/^~/, process.env.HOME ?? ""));
  try {
    if (!statSync(scope).isDirectory()) throw new Error();
  } catch {
    console.error(`ERROR: ${scope} is not a directory`);
    return 1;
  }

  const plan = buildPlan({
    scope, project: args.project, includeGeneric: args.includeGeneric, ageDays: args.ageDays,
  });
  const byTarget: Record<string, number> = {};
  for (const m of plan) {
    const ym = m.target.split("/")[1];
    byTarget[ym] = (byTarget[ym] ?? 0) + 1;
  }
  const summary = {
    scope, applied: args.apply, candidates: plan.length, by_target: byTarget,
  };

  if (args.apply && plan.length > 0) applyPlan(scope, plan);

  if (args.json) {
    console.log(JSON.stringify({ summary, plan }, null, 2));
    return 0;
  }

  console.log(`nf-dream consolidate — ${scope}${args.apply ? " (APPLIED)" : " (dry-run)"}`);
  console.log(`  candidates: ${plan.length}`);
  if (plan.length === 0) { console.log("  nothing to consolidate"); return 0; }
  for (const [ym, n] of Object.entries(byTarget).sort()) {
    console.log(`  → archive/${ym}/: ${n} files`);
  }
  console.log();
  console.log("Plan:");
  for (const m of plan.slice(0, 30)) {
    console.log(`  ${m.src.padEnd(50)} → ${m.target}  (${m.reason})`);
  }
  if (plan.length > 30) console.log(`  ... and ${plan.length - 30} more`);
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

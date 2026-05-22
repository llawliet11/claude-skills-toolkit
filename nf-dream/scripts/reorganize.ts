#!/usr/bin/env bun
/**
 * nf-dream reorganize — rewrite MEMORY.md grouping current project's entries
 * by bucket (Now/Next/Future/Done/Reference/Stale). Out-of-scope entries
 * remain in their original positions.
 *
 * Usage:
 *   bun reorganize.ts <scope> --project <slug> [--apply] [--json] [--include-generic]
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { extractFrontmatterDict, parseFrontmatter } from "./_lib";
import { classifyScope } from "./classify";

function parseMemoryMd(scope: string): Record<string, string> {
  const memory = resolve(scope, "MEMORY.md");
  if (!existsSync(memory)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(memory, "utf8").split("\n")) {
    const m = line.match(/\[[^\]]+\]\(([^)]+\.md)\)/);
    if (m) out[m[1]] = line;
  }
  return out;
}

function synthesizeHook(scope: string, filename: string): string {
  const path = resolve(scope, filename);
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(text);
  let body: string;
  if (parsed) {
    const fm = extractFrontmatterDict(parsed.fmLines);
    if (fm["description"]) return fm["description"].slice(0, 150);
    body = parsed.body;
  } else {
    body = text;
  }
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("# ")) return line.slice(2, 152);
  }
  return filename;
}

function renderEntry(filename: string, hook: string, existing: Record<string, string>): string {
  if (existing[filename]) return existing[filename];
  const stem = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
  const title = stem.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());
  return `- [${title}](${filename}) — ${hook}`;
}

interface BuildArgs {
  scope: string;
  project: string;
  includeGeneric: boolean;
}

function buildNewMemoryMd(args: BuildArgs): { content: string; bucketCounts: Record<string, number> } {
  const classifyData = classifyScope(args.scope, args.project, args.includeGeneric);
  const existing = parseMemoryMd(args.scope);
  const inScopeFiles = new Set<string>();
  for (const items of Object.values(classifyData.buckets)) {
    for (const e of items) inScopeFiles.add(e.file);
  }

  const outOfScopeLines: string[] = [];
  const memory = resolve(args.scope, "MEMORY.md");
  if (existsSync(memory)) {
    for (const line of readFileSync(memory, "utf8").split("\n")) {
      const m = line.match(/\[[^\]]+\]\(([^)]+\.md)\)/);
      if (m && inScopeFiles.has(m[1])) continue;
      outOfScopeLines.push(line);
    }
  }

  const out: string[] = [];
  out.push("# Memory Index");
  out.push("");
  out.push(`## Project: ${args.project}`);
  out.push("");

  for (const bucket of ["Now", "Next", "Future", "Done", "Reference", "Stale"] as const) {
    const items = classifyData.buckets[bucket];
    if (items.length === 0) continue;
    out.push(`### ${bucket}`);
    out.push("");
    for (const it of items) {
      const hook = synthesizeHook(args.scope, it.file);
      out.push(renderEntry(it.file, hook, existing));
    }
    out.push("");
  }

  out.push("## Other projects (unchanged)");
  out.push("");
  let cleaned = outOfScopeLines.join("\n").trim();
  cleaned = cleaned.replace(/^#\s+Memory.*?\n+/m, "");
  out.push(cleaned);
  return {
    content: out.join("\n"),
    bucketCounts: classifyData.summary.by_bucket,
  };
}

interface Args {
  scope: string;
  project: string;
  apply: boolean;
  json: boolean;
  includeGeneric: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    scope: "", project: "", apply: false, json: false, includeGeneric: false, help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--apply") a.apply = true;
    else if (t === "--json") a.json = true;
    else if (t === "--include-generic") a.includeGeneric = true;
    else if (t === "--project") a.project = argv[++i] ?? "";
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (!a.help) {
    if (rest.length === 0) throw new Error("missing <scope>");
    if (!a.project) throw new Error("--project <slug> is required");
  }
  a.scope = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun reorganize.ts <scope> --project <slug> [--apply] [--json] [--include-generic]

Rewrite MEMORY.md grouping current project's entries by bucket.`);
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
  const scope = resolve(args.scope.replace(/^~/, process.env.HOME ?? ""));
  try {
    if (!statSync(scope).isDirectory()) throw new Error();
  } catch {
    console.error(`ERROR: ${scope} is not a directory`);
    return 1;
  }

  const { content, bucketCounts } = buildNewMemoryMd({
    scope, project: args.project, includeGeneric: args.includeGeneric,
  });
  const summary = {
    scope,
    project: args.project,
    applied: args.apply,
    new_memory_size_bytes: content.length,
    buckets: bucketCounts,
  };

  if (args.apply) {
    writeFileSync(resolve(scope, "MEMORY.md"), content);
    (summary as Record<string, unknown>).written = true;
  }

  if (args.json) {
    const out: Record<string, unknown> = { summary };
    if (!args.apply) out.preview = content.slice(0, 2000);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  console.log(`nf-dream reorganize — ${scope}  (project=${args.project})${args.apply ? " (APPLIED)" : " (dry-run)"}`);
  for (const [b, n] of Object.entries(bucketCounts)) {
    console.log(`  ${b}: ${n}`);
  }
  console.log();
  if (!args.apply) {
    console.log("=== Preview (first 60 lines of new MEMORY.md) ===");
    const allLines = content.split("\n");
    for (const line of allLines.slice(0, 60)) console.log(line);
    if (allLines.length > 60) console.log(`... and ${allLines.length - 60} more lines`);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

#!/usr/bin/env bun
/**
 * nf-dream handoff input bundler.
 *
 * Reads Now bucket (full content) + Next bucket (top section) into a single
 * JSON bundle that Claude session uses to synthesize HANDOFF-<slug>.md.
 *
 * Usage:
 *   bun handoff-prep.ts <scope> --project <slug> [--include-generic]
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { extractFrontmatterDict, fileSizeKb, parseFrontmatter } from "./_lib";
import { classifyScope } from "./classify";

function readFull(scope: string, filename: string): Record<string, unknown> {
  const path = resolve(scope, filename);
  const text = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(text);
  let body: string;
  let description = "";
  if (parsed) {
    const fm = extractFrontmatterDict(parsed.fmLines);
    description = fm["description"] ?? "";
    body = parsed.body;
  } else {
    body = text;
  }
  return {
    file: filename,
    description,
    body: body.slice(0, 5000),
    size_kb: Math.round(fileSizeKb(path) * 10) / 10,
  };
}

function readTopSection(scope: string, filename: string, maxChars = 1500): Record<string, unknown> {
  const path = resolve(scope, filename);
  const text = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(text);
  const body = parsed ? parsed.body : text;
  const sections = body.split(/\n## /);
  let top = body;
  if (sections.length > 1) {
    top = "##" + ["", sections[0], sections[1]].join("##");
  }
  return { file: filename, top_section: top.slice(0, maxChars) };
}

interface Args {
  scope: string;
  project: string;
  includeGeneric: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { scope: "", project: "", includeGeneric: false, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--project") a.project = argv[++i] ?? "";
    else if (t === "--include-generic") a.includeGeneric = true;
    else if (t === "--json") {/* default JSON; ignore for compat */}
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
  console.log(`bun handoff-prep.ts <scope> --project <slug> [--include-generic]

Bundle Now (full body) + Next (top section) JSON for HANDOFF synthesis.
Output is always JSON.`);
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

  const classifyData = classifyScope(scope, args.project, args.includeGeneric);
  const nowFiles = classifyData.buckets.Now ?? [];
  const nextFiles = classifyData.buckets.Next ?? [];

  const bundle = {
    scope,
    project: args.project,
    now_full: nowFiles.map((it) => readFull(scope, it.file)),
    next_top: nextFiles.map((it) => readTopSection(scope, it.file)),
    stats: {
      now_count: nowFiles.length,
      next_count: nextFiles.length,
    },
  };
  console.log(JSON.stringify(bundle, null, 2));
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

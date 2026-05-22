#!/usr/bin/env bun
/**
 * nf-dream translate pre-scan.
 *
 * For each filtered file, count lines containing non-English diacritics.
 * The shipped detection targets Vietnamese diacritics; edit the DIACRITICS
 * constant below to match your own language.
 *
 * Buckets: none / light / mixed / heavy. Candidates: mixed + heavy.
 *
 * Usage:
 *   bun translate-prescan.ts <scope> [--project <slug>] [--json] [--include-generic]
 */
import { readFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { extractFrontmatterDict, iterMemoryFiles, parseFrontmatter } from "./_lib";

const DIACRITICS =
  "àáảãạăắằẳẵặâấầẩẫậ" +
  "èéẻẽẹêếềểễệ" +
  "ìíỉĩị" +
  "òóỏõọôốồổỗộơớờởỡợ" +
  "ùúủũụưứừửữự" +
  "ỳýỷỹỵ" +
  "đ" +
  "ÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬ" +
  "ÈÉẺẼẸÊẾỀỂỄỆ" +
  "ÌÍỈĨỊ" +
  "ÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢ" +
  "ÙÚỦŨỤƯỨỪỬỮỰ" +
  "ỲÝỶỸỴ" +
  "Đ";

function escapeForCharClass(s: string): string {
  return s.replace(/[\\\]\-\^]/g, "\\$&");
}

const DIACRITIC_RE = new RegExp(`[${escapeForCharClass(DIACRITICS)}]`);

function bucketOf(vnLines: number, totalLines: number): "none" | "light" | "mixed" | "heavy" {
  if (vnLines === 0) return "none";
  if (vnLines <= 2) return "light";
  const ratio = vnLines / Math.max(totalLines, 1);
  return ratio >= 0.20 ? "heavy" : "mixed";
}

interface ScanResult {
  file: string;
  total_lines: number;
  vn_lines: number;
  bucket: "none" | "light" | "mixed" | "heavy";
  candidate: boolean;
}

function scanFile(path: string): ScanResult {
  const text = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(text);
  const body = parsed ? parsed.body : text;
  const lines = body.split("\n");
  const vnLines = lines.filter((ln) => DIACRITIC_RE.test(ln)).length;
  const bucket = bucketOf(vnLines, lines.length);
  return {
    file: basename(path),
    total_lines: lines.length,
    vn_lines: vnLines,
    bucket,
    candidate: bucket === "mixed" || bucket === "heavy",
  };
}

function projectMatches(
  fmDict: Record<string, string>,
  slug: string | null,
  includeGeneric: boolean
): boolean {
  if (slug === null) return true;
  const proj = fmDict["metadata.project"] ?? "";
  if (proj.includes(slug)) return true;
  if (includeGeneric && proj.includes("generic")) return true;
  return false;
}

interface Args {
  scope: string;
  project: string | null;
  json: boolean;
  includeGeneric: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { scope: "", project: null, json: false, includeGeneric: false, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--project") a.project = argv[++i] ?? null;
    else if (t === "--json") a.json = true;
    else if (t === "--include-generic") a.includeGeneric = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help) throw new Error("missing <scope>");
  a.scope = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun translate-prescan.ts <scope> [--project <slug>] [--json] [--include-generic]

Pre-scan memory files for non-English content. Reports candidates for translation.`);
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

  const files: ScanResult[] = [];
  for (const f of iterMemoryFiles(scope)) {
    const text = readFileSync(f, "utf8");
    const parsed = parseFrontmatter(text);
    const fm = parsed ? extractFrontmatterDict(parsed.fmLines) : {};
    if (!projectMatches(fm, args.project, args.includeGeneric)) continue;
    files.push(scanFile(f));
  }

  const byBucket: Record<string, number> = { none: 0, light: 0, mixed: 0, heavy: 0 };
  for (const f of files) byBucket[f.bucket]++;
  const summary = {
    scope,
    project: args.project,
    total: files.length,
    by_bucket: byBucket,
    candidates: files.filter((f) => f.candidate).length,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, files }, null, 2));
    return 0;
  }

  console.log(`nf-dream translate pre-scan — ${scope}`);
  console.log(`  total files: ${summary.total}`);
  for (const [b, n] of Object.entries(byBucket)) console.log(`  ${b}: ${n}`);
  console.log(`  candidates (mixed+heavy): ${summary.candidates}`);
  console.log();
  console.log("Candidates:");
  for (const it of files.filter((f) => f.candidate).slice(0, 30)) {
    console.log(`  [${it.bucket.padEnd(5)}] ${it.file}  (${it.vn_lines}/${it.total_lines} non-English lines)`);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

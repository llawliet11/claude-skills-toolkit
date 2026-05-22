#!/usr/bin/env bun
/**
 * nf-dream `lint` mode — read-only health check.
 *
 * Folder-wide regardless of project filter. Reports issues, never writes.
 *
 * Checks:
 *   - MEMORY.md size > 20 KB
 *   - Files > 30 KB
 *   - Missing frontmatter
 *   - Missing name/description/metadata.type/metadata.project/metadata.cwd
 *   - Misplaced top-level keys (type/project/cwd/tags/related at top instead of metadata:)
 *   - MEMORY.md links to non-existent files
 *   - Files on disk but missing from MEMORY.md
 *   - archive/README.md entries pointing to missing files
 *
 * Usage:
 *   bun lint.ts <scope> [--json]
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { extractCwdSlugFromFilename, loadRegistry } from "./_lib";

const TOP_RESERVED = new Set([
  "name", "description", "created", "originSessionId", "last_read", "session_id",
]);
const METADATA_KEYS = new Set(["type", "project", "cwd", "tags", "related"]);
const SKIP_BASENAMES = new Set(["MEMORY.md"]);
const HANDOFF_PATTERN = /^HANDOFF([-_].+)?\.md$/i;

function parseFrontmatterLocal(text: string): { fmLines: string[] } | null {
  if (!text.startsWith("---\n")) return null;
  const lines = text.split("\n");
  let end: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { end = i; break; }
  }
  if (end === null) return null;
  return { fmLines: lines.slice(1, end) };
}

interface FrontmatterAnalysis {
  has: Record<string, boolean>;
  misplacedTop: string[];
}

function analyzeFrontmatter(fmLines: string[]): FrontmatterAnalysis {
  const has = {
    name: false,
    description: false,
    metadata_block: false,
    "metadata.type": false,
    "metadata.project": false,
    "metadata.cwd": false,
  } as Record<string, boolean>;
  const misplacedTop: string[] = [];
  let mdIndentActive = false;
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    if (line.trim() === "") { i++; continue; }
    const mTop = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
    const mNested = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
    if (mTop) {
      const key = mTop[1];
      mdIndentActive = false;
      if (key === "name") has.name = true;
      else if (key === "description") has.description = true;
      else if (key === "metadata") {
        has.metadata_block = true;
        mdIndentActive = true;
      } else if (METADATA_KEYS.has(key)) {
        misplacedTop.push(key);
      }
      i++;
      continue;
    }
    if (mNested && mdIndentActive) {
      const nkey = mNested[1];
      if (nkey === "type") has["metadata.type"] = true;
      else if (nkey === "project") has["metadata.project"] = true;
      else if (nkey === "cwd") has["metadata.cwd"] = true;
      i++;
      continue;
    }
    if (line.startsWith("  ") && mdIndentActive) { i++; continue; }
    mdIndentActive = false;
    i++;
  }
  return { has, misplacedTop };
}

interface Finding {
  kind: string;
  [key: string]: unknown;
}

interface Args {
  scope: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { scope: "", json: false, help: false };
  const rest: string[] = [];
  for (const t of argv) {
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--json") a.json = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help) throw new Error("missing <scope>");
  a.scope = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun lint.ts <scope> [--json]

Read-only health check on memory folder. Folder-wide regardless of project filter.`);
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

  const findings: Finding[] = [];

  const memoryMd = resolve(scope, "MEMORY.md");
  if (existsSync(memoryMd)) {
    const sizeKb = statSync(memoryMd).size / 1024;
    if (sizeKb > 20) {
      findings.push({ kind: "memory_md_large", size_kb: Math.round(sizeKb * 10) / 10 });
    }
  }

  const files = readdirSync(scope, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !SKIP_BASENAMES.has(e.name))
    .map((e) => ({ name: e.name, path: resolve(scope, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const onDisk = new Set(files.map((f) => f.name));

  const indexed = new Set<string>();
  const brokenLinks: string[] = [];
  if (existsSync(memoryMd)) {
    const memoryText = readFileSync(memoryMd, "utf8");
    for (const m of memoryText.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)) {
      const link = m[1];
      indexed.add(link);
      if (!existsSync(resolve(scope, link)) && !link.startsWith("archive/")) {
        brokenLinks.push(link);
      }
    }
  }

  const candidatesForIndex = new Set<string>();
  for (const n of onDisk) if (!HANDOFF_PATTERN.test(n)) candidatesForIndex.add(n);
  const missingIndex: string[] = [];
  for (const n of candidatesForIndex) if (!indexed.has(n)) missingIndex.push(n);
  missingIndex.sort();

  if (brokenLinks.length > 0) findings.push({ kind: "memory_md_broken_links", links: brokenLinks });
  if (missingIndex.length > 0) findings.push({ kind: "files_not_in_memory_md", files: missingIndex });

  const registry = loadRegistry();
  const knownSlugs = new Set([...Object.keys(registry.slugs), "generic"]);

  for (const { name, path } of files) {
    const sizeKb = statSync(path).size / 1024;
    if (sizeKb > 30) findings.push({ kind: "file_large", file: name, size_kb: Math.round(sizeKb * 10) / 10 });
    const text = readFileSync(path, "utf8");
    const parsed = parseFrontmatterLocal(text);
    if (!parsed) {
      findings.push({ kind: "no_frontmatter", file: name });
      continue;
    }
    const info = analyzeFrontmatter(parsed.fmLines);
    const missing = Object.entries(info.has).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) findings.push({ kind: "missing_fields", file: name, missing });
    if (info.misplacedTop.length > 0) findings.push({ kind: "misplaced_top_level", file: name, keys: info.misplacedTop });

    // Filename suffix vs frontmatter.project consistency check.
    // Only enforce when BOTH are present; legacy files (no suffix) are not flagged.
    const candidate = extractCwdSlugFromFilename(name);
    const suffixSlug = candidate && (candidate === "generic" || knownSlugs.has(candidate))
      ? candidate
      : null;
    // Extract frontmatter project (single value, ignore array case for collision lint)
    let fmProject = "";
    for (const line of parsed.fmLines) {
      const m = line.match(/^  project:\s*(.*)$/);
      if (m) { fmProject = m[1].trim().replace(/^['"]|['"]$/g, ""); break; }
    }
    if (suffixSlug && fmProject && !fmProject.startsWith("[") && fmProject !== suffixSlug) {
      findings.push({
        kind: "filename_suffix_mismatch",
        file: name,
        frontmatter_project: fmProject,
        filename_suffix: suffixSlug,
      });
    }
  }

  const archiveReadme = resolve(scope, "archive", "README.md");
  if (existsSync(archiveReadme)) {
    for (const m of readFileSync(archiveReadme, "utf8").matchAll(/archive\/[^\s)]+\.md/g)) {
      const rel = m[0];
      if (!existsSync(resolve(scope, rel))) {
        findings.push({ kind: "archive_breadcrumb_dangling", ref: rel });
      }
    }
  }

  const byKind: Record<string, number> = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  const summary = {
    scope,
    total_files_scanned: onDisk.size,
    findings_count: findings.length,
    by_kind: byKind,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, findings }, null, 2));
    return 0;
  }

  console.log(`nf-dream lint — ${scope}`);
  console.log(`  files scanned: ${summary.total_files_scanned}`);
  console.log(`  findings:      ${summary.findings_count}`);
  if (findings.length === 0) { console.log("  clean — no issues"); return 0; }
  console.log();
  const grouped: Record<string, Finding[]> = {};
  for (const f of findings) {
    grouped[f.kind] = grouped[f.kind] ?? [];
    grouped[f.kind].push(f);
  }
  for (const [kind, items] of Object.entries(grouped)) {
    console.log(`## ${kind} (${items.length})`);
    for (const it of items.slice(0, 30)) {
      const details = Object.entries(it).filter(([k]) => k !== "kind").map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
      console.log(`  - ${details}`);
    }
    if (items.length > 30) console.log(`  ... and ${items.length - 30} more`);
    console.log();
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

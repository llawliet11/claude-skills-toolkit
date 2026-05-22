#!/usr/bin/env bun
/**
 * nf-dream `normalize` mode — structural frontmatter compliance.
 *
 * Three responsibilities (idempotent):
 *   1. Move misplaced top-level YAML keys (type/project/cwd/tags/related)
 *      from top-level into the metadata: block.
 *   2. Add metadata.type from filename prefix.
 *   3. Add metadata.cwd from references/slug-to-cwd.json IF metadata.project
 *      is set and metadata.cwd is missing.
 *
 * Usage:
 *   bun normalize.ts <scope> [--dry-run] [--json]
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { loadRegistry, SKIP_BASENAMES } from "./_lib";

const TOP_RESERVED = new Set([
  "name", "description", "created", "originSessionId", "last_read", "session_id",
]);
const METADATA_KEYS = new Set([
  "type", "project", "cwd", "tags", "related", "node_type", "status", "priority", "owner",
]);

const PREFIX_TO_TYPE: Array<[RegExp, string]> = [
  [/^project[_-]/i, "project"],
  [/^feedback[_-]/i, "feedback"],
  [/^reference[_-]/i, "reference"],
  [/^user[_-]/i, "user"],
  [/^handoff/i, "project"],
  [/^plan[_-]/i, "project"],
];

function inferType(filename: string): string | null {
  for (const [pat, t] of PREFIX_TO_TYPE) {
    if (pat.test(filename)) return t;
  }
  return null;
}

function parseFrontmatterLocal(text: string): { fmLines: string[]; body: string } | null {
  if (!text.startsWith("---\n")) return null;
  const lines = text.split("\n");
  let end: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { end = i; break; }
  }
  if (end === null) return null;
  return { fmLines: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

interface SplitResult {
  top: Array<[string, string]>;
  metadataLines: string[];
  misplaced: Array<[string, string[]]>;
}

function splitTopAndMetadata(fmLines: string[]): SplitResult {
  const top: Array<[string, string]> = [];
  const metadataLines: string[] = [];
  const misplaced: Array<[string, string[]]> = [];
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    if (line.trim() === "") { i++; continue; }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
    if (!m) {
      if (top.length > 0) {
        const [k, raw] = top[top.length - 1];
        top[top.length - 1] = [k, raw + "\n" + line];
      }
      i++;
      continue;
    }
    const key = m[1];
    if (key === "metadata") {
      let j = i + 1;
      while (
        j < fmLines.length &&
        (fmLines[j].startsWith(" ") || fmLines[j].startsWith("\t") || fmLines[j].trim() === "")
      ) {
        if (fmLines[j].trim() !== "") metadataLines.push(fmLines[j]);
        j++;
      }
      i = j;
      continue;
    }
    if (TOP_RESERVED.has(key)) {
      top.push([key, line]);
      i++;
      continue;
    }
    if (METADATA_KEYS.has(key)) {
      const captured: string[] = [line];
      let j = i + 1;
      while (
        j < fmLines.length &&
        (fmLines[j].startsWith(" ") || fmLines[j].startsWith("\t") || fmLines[j].trim().startsWith("- "))
      ) {
        captured.push(fmLines[j]);
        j++;
      }
      misplaced.push([key, captured]);
      i = j;
      continue;
    }
    // unknown top-level key — keep as-is
    top.push([key, line]);
    i++;
  }
  return { top, metadataLines, misplaced };
}

function buildMdMap(metadataLines: string[]): Map<string, string[]> {
  const mdMap = new Map<string, string[]>();
  let curKey: string | null = null;
  let curBlock: string[] = [];
  for (const line of metadataLines) {
    const m = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
    if (m) {
      if (curKey !== null) mdMap.set(curKey, curBlock);
      curKey = m[1];
      curBlock = [line];
    } else {
      curBlock.push(line);
    }
  }
  if (curKey !== null) mdMap.set(curKey, curBlock);
  return mdMap;
}

function reindentMisplaced(captured: string[]): string[] {
  return captured.map((ln) => "  " + ln);
}

function renderFrontmatter(top: Array<[string, string]>, mdMap: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const [, raw] of top) {
    out.push(...raw.split("\n"));
  }
  if (mdMap.size > 0) {
    out.push("metadata:");
    const order = ["node_type", "type", "project", "cwd", "tags", "related", "status", "priority", "owner"];
    const emitted = new Set<string>();
    for (const k of order) {
      if (mdMap.has(k)) {
        out.push(...mdMap.get(k)!);
        emitted.add(k);
      }
    }
    for (const [k, v] of mdMap) {
      if (!emitted.has(k)) out.push(...v);
    }
  }
  return out;
}

function extractValue(blockLines: string[]): string {
  if (blockLines.length === 0) return "";
  const m = blockLines[0].match(/^  [A-Za-z_][A-Za-z0-9_]*:\s*(.*)$/);
  return m ? m[1].trim() : "";
}

interface Report {
  file: string;
  status: "changed" | "would-change" | "unchanged" | "no-frontmatter" | "no-op-write";
  actions?: string[];
  _newContent?: string;
}

function normalizeFile(path: string, slugToCwd: Record<string, string>): Report {
  const name = basename(path);
  const text = readFileSync(path, "utf8");
  const parsed = parseFrontmatterLocal(text);
  if (!parsed) return { file: name, status: "no-frontmatter" };

  const { top, metadataLines, misplaced } = splitTopAndMetadata(parsed.fmLines);
  const mdMap = buildMdMap(metadataLines);
  const actions: string[] = [];

  for (const [key, captured] of misplaced) {
    if (!mdMap.has(key)) {
      mdMap.set(key, reindentMisplaced(captured));
      actions.push(`moved-top:${key}`);
    }
  }

  if (!mdMap.has("type")) {
    const t = inferType(name);
    if (t) {
      mdMap.set("type", [`  type: ${t}`]);
      actions.push(`added-type:${t}`);
    }
  }

  if (mdMap.has("project") && !mdMap.has("cwd")) {
    const projVal = extractValue(mdMap.get("project")!);
    const cwdVal = slugToCwd[projVal];
    if (cwdVal) {
      mdMap.set("cwd", [`  cwd: ${cwdVal}`]);
      actions.push(`added-cwd:${projVal}`);
    }
  }

  const newFm = renderFrontmatter(top, mdMap);
  const newContent = `---\n${newFm.join("\n")}\n---\n${parsed.body}`;

  if (newContent === text) return { file: name, status: "unchanged", actions: [] };
  return {
    file: name,
    status: actions.length > 0 ? "would-change" : "no-op-write",
    actions,
    _newContent: newContent,
  };
}

interface Args {
  scope: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { scope: "", dryRun: false, json: false, help: false };
  const rest: string[] = [];
  for (const t of argv) {
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--json") a.json = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help) throw new Error("missing <scope>");
  a.scope = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun normalize.ts <scope> [--dry-run] [--json]

Structural frontmatter compliance: move misplaced top-level keys to metadata:,
add metadata.type from filename prefix, add metadata.cwd from registry.`);
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

  const registry = loadRegistry();
  const slugToCwd = registry.slugs;
  const reports: Report[] = [];
  let written = 0;

  const entries = readdirSync(scope, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !SKIP_BASENAMES.has(e.name))
    .map((e) => resolve(scope, e.name))
    .sort();

  for (const f of entries) {
    const rep = normalizeFile(f, slugToCwd);
    if (rep._newContent !== undefined && !args.dryRun) {
      writeFileSync(f, rep._newContent);
      rep.status = "changed";
      written++;
    }
    delete rep._newContent;
    reports.push(rep);
  }

  const summary = {
    scope,
    dry_run: args.dryRun,
    total_files: reports.length,
    changed_or_would_change: reports.filter((r) => r.status === "changed" || r.status === "would-change").length,
    written,
    unchanged: reports.filter((r) => r.status === "unchanged").length,
    no_frontmatter: reports.filter((r) => r.status === "no-frontmatter").length,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, files: reports }, null, 2));
    return 0;
  }

  console.log(`nf-dream normalize — ${scope}`);
  console.log(`  total files:  ${summary.total_files}`);
  if (args.dryRun) {
    console.log(`  would-change: ${summary.changed_or_would_change}`);
  } else {
    console.log(`  changed:      ${summary.written}`);
  }
  console.log(`  unchanged:    ${summary.unchanged}`);
  console.log(`  no-frontmatter: ${summary.no_frontmatter}`);
  const flagged = reports.filter((r) => r.status === "changed" || r.status === "would-change");
  if (flagged.length > 0) {
    console.log();
    console.log(args.dryRun ? "Would modify:" : "Files modified:");
    for (const r of flagged.slice(0, 50)) {
      console.log(`  ${r.file}: ${r.actions?.join(", ") || "(no actions but content differs)"}`);
    }
    if (flagged.length > 50) console.log(`  ... and ${flagged.length - 50} more`);
  }
  const noFm = reports.filter((r) => r.status === "no-frontmatter");
  if (noFm.length > 0) {
    console.log();
    console.log(`Files without frontmatter (manual fix needed): ${noFm.length}`);
    for (const r of noFm.slice(0, 10)) console.log(`  ${r.file}`);
    if (noFm.length > 10) console.log(`  ... and ${noFm.length - 10} more`);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

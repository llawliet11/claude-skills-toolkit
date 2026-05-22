#!/usr/bin/env bun
/**
 * nf-dream — Bun TypeScript port of the scan-and-classify core.
 *
 * Mirrors the heuristic taxonomy from `scripts/classify.py` and the lint
 * surface from `scripts/lint.py`. Reads the entire scope folder in parallel,
 * classifies each `*.md` file into Now / Next / Done / Future / Reference /
 * Stale, and emits structured JSON for the prompt to consume.
 *
 * Read-only. Does NOT mutate any memory file. Defaults to JSON output.
 *
 * CLI:
 *   bun dream-scan.ts [--mode <mode>] [--project <slug>] [--memory-path <p>]
 *                     [--no-generic] [--cwd <p>] [--json] [--help]
 *
 * Modes: preview (default) | stale | lint | full
 *   `full` here returns the union of preview + lint findings; expensive write
 *   modes (reorganize/consolidate/handoff/etc.) stay in Python land and are
 *   orchestrated by the prompt — this script is the read-path accelerator.
 */

import { resolve, basename, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";

type Bucket = "Now" | "Next" | "Future" | "Done" | "Reference" | "Stale";

const BUCKETS: Bucket[] = ["Now", "Next", "Future", "Done", "Reference", "Stale"];

const NOW_BODY_MARKERS = [
  /\*\*START HERE\*\*/,
  /\bPending:/,
  /\bOpen:/,
  /\bQueued for next session\b/,
];
const NEXT_HEADING_MARKERS = [
  /^##\s+Next session\b/m,
  /^##\s+TODO\b/m,
  /^##\s+Queued\b/m,
];
const DONE_MARKERS = ["SHIPPED", "COMPLETE", "DONE", "MERGED"];
const FUTURE_MARKERS = ["FUTURE WISHLIST", "DEFERRED", "BLOCKED BY", "Wishlist"];
const REFERENCE_MARKERS = [/\(canonical\)/i, /\(stable reference\)/i];
const STALE_MARKERS = ["obsolete", "superseded by", "mostly obsolete", "legacy"];

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;

const SKIP_BASENAMES = new Set(["MEMORY.md"]);
const HANDOFF_RE = /^HANDOFF([-_].+)?\.md$/i;
const SESSION_END_RE = /^project_session_end_state_/i;

const TOP_RESERVED = new Set([
  "name",
  "description",
  "created",
  "originSessionId",
  "last_read",
  "session_id",
]);
const METADATA_KEYS = new Set([
  "type",
  "project",
  "cwd",
  "tags",
  "related",
  "node_type",
  "status",
  "priority",
  "owner",
]);

interface ParsedFrontmatter {
  raw: string;
  flat: Record<string, string>;
  misplacedTop: string[];
  hasFrontmatter: boolean;
  hasName: boolean;
  hasDescription: boolean;
  hasMetadataBlock: boolean;
}

interface FileRecord {
  path: string;
  name: string;
  body: string;
  mtimeMs: number;
  sizeKb: number;
  fm: ParsedFrontmatter;
  bucket?: Bucket;
  reason?: string;
  inScope: boolean;
}

interface ClassifiedEntry {
  file: string;
  reason: string;
  mtime: number;
  sizeKb: number;
  project: string;
}

interface ScanResult {
  memoryPath: string;
  project: string | null;
  includeGeneric: boolean;
  mode: string;
  scanned: number;
  inScope: number;
  outOfScope: number;
  classified: Record<Bucket, ClassifiedEntry[]>;
  health: {
    memoryMdSizeKb: number | null;
    filesOver30Kb: string[];
    filesMissingFrontmatter: string[];
    filesMissingFields: { file: string; missing: string[] }[];
    filesMisplacedTopLevel: { file: string; keys: string[] }[];
    brokenMemoryMdLinks: string[];
    filesNotInMemoryMd: string[];
  };
  warnings: string[];
  durationMs: number;
}

// ────────────────────────────── CLI ──────────────────────────────

interface Args {
  mode: "preview" | "stale" | "lint" | "full";
  project: string | null;
  memoryPath: string | null;
  cwd: string;
  includeGeneric: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    mode: "preview",
    project: null,
    memoryPath: null,
    cwd: process.cwd(),
    includeGeneric: true,
    json: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--mode":
        out.mode = (argv[++i] ?? "preview") as Args["mode"];
        break;
      case "--project":
        out.project = argv[++i] ?? null;
        break;
      case "--memory-path":
        out.memoryPath = argv[++i] ?? null;
        break;
      case "--cwd":
        out.cwd = argv[++i] ?? process.cwd();
        break;
      case "--no-generic":
        out.includeGeneric = false;
        break;
      case "--json":
        out.json = true;
        break;
      case "--text":
        out.json = false;
        break;
      default:
        if (a.startsWith("--")) {
          throw new Error(`Unknown flag: ${a}`);
        }
    }
  }
  return out;
}

function printHelp(): void {
  const help = `nf-dream / dream-scan.ts — Bun TypeScript scan-and-classify

Reads every *.md file under the resolved memory scope in parallel, classifies
each into Now / Next / Future / Done / Reference / Stale via heuristic markers
(mirrors scripts/classify.py), and reports lint-style health checks. Default
output is JSON. Read-only — no file is modified.

USAGE
  bun dream-scan.ts [--mode <preview|stale|lint|full>]
                    [--project <slug>] [--memory-path <path>]
                    [--cwd <path>] [--no-generic] [--json|--text] [--help]

MODES
  preview   Classify in-scope files into 6 buckets (default)
  stale     Emit only the Stale bucket (for review-before-archive)
  lint      Folder-wide health check (frontmatter shape, broken links, ...)
  full      preview + lint, single JSON payload

FLAGS
  --project <slug>       Filter classification to this slug (+ generic by
                         default). When omitted, auto-detects from --cwd
                         basename via git toplevel.
  --memory-path <path>   Skip auto-resolution; scan this folder.
  --cwd <path>           Working directory for memory-path resolution
                         (default: process.cwd()).
  --no-generic           Exclude files tagged metadata.project: generic.
  --text                 Pretty-print instead of JSON.

EXAMPLES
  bun dream-scan.ts --memory-path ~/.claude/projects/-Users-me--claude/memory \\
                    --project generic --mode preview
  bun dream-scan.ts --memory-path /path/to/scope --mode lint

EXIT CODES
  0  scan completed (even if warnings emitted)
  1  resolution failure or hard error
`;
  process.stdout.write(help);
}

// ─────────────────────────── path helpers ───────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace(/^~/, homedir());
  }
  return p;
}

function sanitizeCwd(absCwd: string): string {
  // Binary default: replace `/` with `-`, prepend `-`.
  return "-" + absCwd.replace(/\//g, "-");
}

// ─────────────────────────── memory path resolution ───────────────────────────

async function readJsonSafe(p: string): Promise<Record<string, unknown> | null> {
  try {
    const f = Bun.file(p);
    if (!(await f.exists())) return null;
    return (await f.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function resolveMemoryPath(
  cwd: string,
  warnings: string[],
): Promise<{ path: string | null; source: string }> {
  const localSettings = await readJsonSafe(join(cwd, ".claude", "settings.local.json"));
  if (localSettings) {
    const env = (localSettings.env as Record<string, string> | undefined) ?? {};
    const envOverride = env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE;
    if (typeof envOverride === "string" && envOverride.length > 0) {
      return { path: expandHome(envOverride), source: "local.env" };
    }
    const mirror = localSettings.autoMemoryDirectory;
    if (typeof mirror === "string" && mirror.length > 0) {
      warnings.push(
        "autoMemoryDirectory found but env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE missing — partial config, run /nf-memory to sync both fields",
      );
      return { path: expandHome(mirror), source: "local.autoMemoryDirectory" };
    }
  }

  const userSettings = await readJsonSafe(join(homedir(), ".claude", "settings.json"));
  if (userSettings) {
    const env = (userSettings.env as Record<string, string> | undefined) ?? {};
    const envOverride = env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE;
    if (typeof envOverride === "string" && envOverride.length > 0) {
      return { path: expandHome(envOverride), source: "user.env" };
    }
    const mirror = userSettings.autoMemoryDirectory;
    if (typeof mirror === "string" && mirror.length > 0) {
      return { path: expandHome(mirror), source: "user.autoMemoryDirectory" };
    }
  }

  const procEnv = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE;
  if (procEnv && procEnv.length > 0) {
    return { path: expandHome(procEnv), source: "process.env" };
  }

  // Binary default fallback
  const sanitized = sanitizeCwd(resolve(cwd));
  const def = join(homedir(), ".claude", "projects", sanitized, "memory");
  if (existsSync(def)) {
    return { path: def, source: "binary-default" };
  }
  return { path: null, source: "none" };
}

// ─────────────────────────── frontmatter parsing ───────────────────────────

function parseFrontmatter(text: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {
    raw: "",
    flat: {},
    misplacedTop: [],
    hasFrontmatter: false,
    hasName: false,
    hasDescription: false,
    hasMetadataBlock: false,
  };

  if (!text.startsWith("---\n")) return result;
  const lines = text.split("\n");
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return result;

  result.hasFrontmatter = true;
  const fmLines = lines.slice(1, endIdx);
  result.raw = fmLines.join("\n");

  let inMetadata = false;
  for (const line of fmLines) {
    if (line.trim() === "") continue;
    const topMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    const nestedMatch = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (topMatch && !line.startsWith(" ")) {
      const key = topMatch[1];
      const value = topMatch[2].trim();
      if (key === "metadata") {
        result.hasMetadataBlock = true;
        inMetadata = true;
        continue;
      }
      inMetadata = false;
      if (key === "name") result.hasName = true;
      else if (key === "description") result.hasDescription = true;
      else if (METADATA_KEYS.has(key) && !TOP_RESERVED.has(key)) {
        result.misplacedTop.push(key);
      }
      result.flat[key] = value;
    } else if (nestedMatch && inMetadata) {
      result.flat[`metadata.${nestedMatch[1]}`] = nestedMatch[2].trim();
    } else if (!line.startsWith(" ")) {
      inMetadata = false;
    }
  }

  return result;
}

// ─────────────────────────── classification ───────────────────────────

function normalizeProjectField(raw: string): string[] {
  // `metadata.project` can be a scalar or YAML array `[a, b]`.
  if (!raw) return [];
  const stripped = raw.replace(/^\[|\]$/g, "");
  return stripped
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function fileInScope(fm: ParsedFrontmatter, slug: string | null, includeGeneric: boolean): boolean {
  if (slug === null) return true;
  const projects = normalizeProjectField(fm.flat["metadata.project"] ?? "");
  if (projects.includes(slug)) return true;
  if (includeGeneric && projects.includes("generic")) return true;
  return false;
}

function classifyOne(
  rec: FileRecord,
  nowReferencedNames: Set<string>,
): { bucket: Bucket; reason: string } {
  const name = rec.name;
  const ageMs = Date.now() - rec.mtimeMs;
  const body = rec.body;
  const bodyLower = body.toLowerCase();

  // Reference (filename-led OR body marker)
  if (name.startsWith("reference_") || name.startsWith("reference-")) {
    return { bucket: "Reference", reason: "filename prefix" };
  }
  for (const re of REFERENCE_MARKERS) {
    if (re.test(body)) return { bucket: "Reference", reason: `body marker ${re.source}` };
  }

  // Now (recent session-end OR body markers)
  if (SESSION_END_RE.test(name) && ageMs < SEVEN_DAYS_MS) {
    return { bucket: "Now", reason: "recent session-end (<7d)" };
  }
  for (const re of NOW_BODY_MARKERS) {
    if (re.test(body)) return { bucket: "Now", reason: `body marker ${re.source}` };
  }

  // Next (queued work)
  for (const re of NEXT_HEADING_MARKERS) {
    if (re.test(body)) return { bucket: "Next", reason: `heading ${re.source}` };
  }

  // Future
  for (const marker of FUTURE_MARKERS) {
    if (body.includes(marker)) return { bucket: "Future", reason: `marker '${marker}'` };
  }

  // Done (shipped + aged + no pending)
  const hasDone = DONE_MARKERS.some((m) => body.includes(m));
  const hasPending = body.includes("Pending") || body.includes("Open:");
  if (hasDone && ageMs > SEVEN_DAYS_MS && !hasPending) {
    return { bucket: "Done", reason: "ship marker + aged > 7d" };
  }

  // Stale (obsolete markers OR >60d unreferenced)
  for (const marker of STALE_MARKERS) {
    if (bodyLower.includes(marker)) return { bucket: "Stale", reason: `body marker '${marker}'` };
  }
  if (ageMs > SIXTY_DAYS_MS && !nowReferencedNames.has(name)) {
    return { bucket: "Stale", reason: "mtime > 60d, unreferenced" };
  }

  if (hasDone) return { bucket: "Done", reason: "ship marker (no aging signal)" };
  return { bucket: "Reference", reason: "default — load-bearing fact" };
}

// ─────────────────────────── scan ───────────────────────────

async function listMemoryFiles(scope: string): Promise<string[]> {
  const glob = new Bun.Glob("*.md");
  const out: string[] = [];
  for await (const rel of glob.scan({ cwd: scope, onlyFiles: true })) {
    if (SKIP_BASENAMES.has(basename(rel))) continue;
    out.push(join(scope, rel));
  }
  return out.sort();
}

async function readFiles(paths: string[]): Promise<FileRecord[]> {
  return Promise.all(
    paths.map(async (p) => {
      const file = Bun.file(p);
      const text = await file.text();
      const statResult = statSync(p);
      const fm = parseFrontmatter(text);
      // Strip frontmatter from body if present for marker matching
      let body = text;
      if (fm.hasFrontmatter) {
        const lines = text.split("\n");
        let endIdx = -1;
        for (let i = 1; i < lines.length; i++) {
          if (lines[i] === "---") {
            endIdx = i;
            break;
          }
        }
        if (endIdx !== -1) body = lines.slice(endIdx + 1).join("\n");
      }
      return {
        path: p,
        name: basename(p),
        body,
        mtimeMs: statResult.mtimeMs,
        sizeKb: statResult.size / 1024,
        fm,
        inScope: false,
      };
    }),
  );
}

function buildNowReferencedNames(records: FileRecord[]): Set<string> {
  const out = new Set<string>();
  // First-pass classify to find Now-bucket files, then collect all `*.md`
  // references from their bodies — used to keep "Stale (>60d unreferenced)"
  // false positives from claiming a still-load-bearing file.
  const provisional: FileRecord[] = [];
  for (const r of records) {
    const { bucket } = classifyOne(r, new Set());
    if (bucket === "Now") provisional.push(r);
  }
  const linkRe = /([a-z][a-z0-9_-]+\.md)/gi;
  for (const r of provisional) {
    for (const m of r.body.matchAll(linkRe)) out.add(m[1]);
  }
  return out;
}

// ─────────────────────────── health checks (lint) ───────────────────────────

async function lintFolder(
  scope: string,
  records: FileRecord[],
): Promise<ScanResult["health"]> {
  const memoryMdPath = join(scope, "MEMORY.md");
  let memoryMdSizeKb: number | null = null;
  let memoryMdText = "";
  if (existsSync(memoryMdPath)) {
    const st = statSync(memoryMdPath);
    memoryMdSizeKb = +(st.size / 1024).toFixed(2);
    memoryMdText = await Bun.file(memoryMdPath).text();
  }

  const onDisk = new Set(records.map((r) => r.name));
  const indexed = new Set<string>();
  const brokenLinks: string[] = [];
  const linkRe = /\[[^\]]+\]\(([^)]+\.md)\)/g;
  for (const m of memoryMdText.matchAll(linkRe)) {
    const link = m[1];
    indexed.add(link);
    if (!existsSync(join(scope, link)) && !link.startsWith("archive/")) {
      brokenLinks.push(link);
    }
  }
  const filesNotInMemoryMd: string[] = [];
  for (const n of onDisk) {
    if (HANDOFF_RE.test(n)) continue;
    if (!indexed.has(n)) filesNotInMemoryMd.push(n);
  }

  const filesOver30Kb: string[] = [];
  const filesMissingFrontmatter: string[] = [];
  const filesMissingFields: { file: string; missing: string[] }[] = [];
  const filesMisplacedTopLevel: { file: string; keys: string[] }[] = [];

  for (const r of records) {
    if (r.sizeKb > 30) filesOver30Kb.push(r.name);
    if (!r.fm.hasFrontmatter) {
      filesMissingFrontmatter.push(r.name);
      continue;
    }
    const missing: string[] = [];
    if (!r.fm.hasName) missing.push("name");
    if (!r.fm.hasDescription) missing.push("description");
    if (!r.fm.hasMetadataBlock) missing.push("metadata");
    else {
      if (!r.fm.flat["metadata.type"]) missing.push("metadata.type");
      if (!r.fm.flat["metadata.project"]) missing.push("metadata.project");
      if (!r.fm.flat["metadata.cwd"]) missing.push("metadata.cwd");
    }
    if (missing.length > 0) filesMissingFields.push({ file: r.name, missing });
    if (r.fm.misplacedTop.length > 0) {
      filesMisplacedTopLevel.push({ file: r.name, keys: r.fm.misplacedTop });
    }
  }

  return {
    memoryMdSizeKb,
    filesOver30Kb: filesOver30Kb.sort(),
    filesMissingFrontmatter: filesMissingFrontmatter.sort(),
    filesMissingFields: filesMissingFields.sort((a, b) => a.file.localeCompare(b.file)),
    filesMisplacedTopLevel: filesMisplacedTopLevel.sort((a, b) => a.file.localeCompare(b.file)),
    brokenMemoryMdLinks: brokenLinks.sort(),
    filesNotInMemoryMd: filesNotInMemoryMd.sort(),
  };
}

// ─────────────────────────── main ───────────────────────────

async function main(): Promise<number> {
  const t0 = performance.now();
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  if (!["preview", "stale", "lint", "full"].includes(args.mode)) {
    process.stderr.write(`ERROR: unknown mode '${args.mode}'. Allowed: preview|stale|lint|full\n`);
    return 1;
  }

  const warnings: string[] = [];

  // Resolve memory path
  let scope: string | null = args.memoryPath
    ? (isAbsolute(args.memoryPath) ? args.memoryPath : resolve(args.cwd, args.memoryPath))
    : null;
  if (scope) scope = expandHome(scope);
  let source = "cli";
  if (!scope) {
    const resolved = await resolveMemoryPath(args.cwd, warnings);
    scope = resolved.path;
    source = resolved.source;
  }
  if (!scope) {
    process.stderr.write(
      "ERROR: could not resolve memory path. Run /nf-memory to configure CLAUDE_COWORK_MEMORY_PATH_OVERRIDE.\n",
    );
    return 1;
  }
  if (!existsSync(scope)) {
    process.stderr.write(`ERROR: memory path does not exist: ${scope}\n`);
    return 1;
  }

  // Project slug auto-detect (basename of cwd) when none provided
  let project = args.project;
  if (project === null) {
    project = basename(resolve(args.cwd));
    // sanitized binary-default folders look like '-Users-me--claude',
    // not a real project slug, treat as null (no filter)
    if (project.startsWith("-") || project === "" || project === "/") project = null;
  }

  // Scan files
  const paths = await listMemoryFiles(scope);
  const records = await readFiles(paths);

  // Classify
  const nowReferenced = buildNowReferencedNames(records);
  for (const r of records) {
    const { bucket, reason } = classifyOne(r, nowReferenced);
    r.bucket = bucket;
    r.reason = reason;
    r.inScope = fileInScope(r.fm, project, args.includeGeneric);
  }

  // Bucket assembly (in-scope only)
  const classified: Record<Bucket, ClassifiedEntry[]> = {
    Now: [],
    Next: [],
    Future: [],
    Done: [],
    Reference: [],
    Stale: [],
  };
  let inScopeCount = 0;
  let outOfScopeCount = 0;
  for (const r of records) {
    if (!r.inScope) {
      outOfScopeCount++;
      continue;
    }
    inScopeCount++;
    const entry: ClassifiedEntry = {
      file: r.name,
      reason: r.reason ?? "",
      mtime: Math.floor(r.mtimeMs / 1000),
      sizeKb: +r.sizeKb.toFixed(2),
      project: r.fm.flat["metadata.project"] ?? "",
    };
    classified[r.bucket!].push(entry);
  }

  // Sort each bucket: newest first
  for (const k of BUCKETS) {
    classified[k].sort((a, b) => b.mtime - a.mtime);
  }

  // Health (folder-wide regardless of filter, per SKILL.md lint exception)
  const health = await lintFolder(scope, records);

  // Mode-specific shaping
  let finalClassified = classified;
  if (args.mode === "stale") {
    finalClassified = {
      Now: [],
      Next: [],
      Future: [],
      Done: [],
      Reference: [],
      Stale: classified.Stale,
    };
  } else if (args.mode === "lint") {
    finalClassified = {
      Now: [],
      Next: [],
      Future: [],
      Done: [],
      Reference: [],
      Stale: [],
    };
  }

  if (records.length < 5) {
    warnings.push(
      `not enough signal to consolidate — found ${records.length} files (<5 minimum)`,
    );
  }

  const result: ScanResult = {
    memoryPath: scope,
    project,
    includeGeneric: args.includeGeneric,
    mode: args.mode,
    scanned: records.length,
    inScope: inScopeCount,
    outOfScope: outOfScopeCount,
    classified: finalClassified,
    health,
    warnings: [`resolved-via: ${source}`, ...warnings],
    durationMs: +(performance.now() - t0).toFixed(1),
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatText(result));
  }
  return 0;
}

function formatText(r: ScanResult): string {
  const lines: string[] = [];
  lines.push(`nf-dream scan — ${r.memoryPath}`);
  lines.push(`  mode: ${r.mode}    project: ${r.project ?? "<all>"}`);
  lines.push(`  scanned: ${r.scanned}    in-scope: ${r.inScope}    out-of-scope: ${r.outOfScope}`);
  lines.push(`  duration: ${r.durationMs}ms`);
  if (r.warnings.length > 0) {
    lines.push("");
    lines.push("WARNINGS");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  lines.push("");
  for (const b of BUCKETS) {
    const items = r.classified[b];
    if (items.length === 0 && r.mode !== "preview" && r.mode !== "full") continue;
    lines.push(`## ${b} (${items.length})`);
    for (const it of items.slice(0, 15)) {
      lines.push(`  - ${it.file}  (${it.reason})`);
    }
    if (items.length > 15) lines.push(`  ... and ${items.length - 15} more`);
    lines.push("");
  }
  if (r.mode === "lint" || r.mode === "full") {
    lines.push("## Health");
    lines.push(`  MEMORY.md size: ${r.health.memoryMdSizeKb ?? "n/a"} KB`);
    lines.push(`  files > 30KB: ${r.health.filesOver30Kb.length}`);
    lines.push(`  missing frontmatter: ${r.health.filesMissingFrontmatter.length}`);
    lines.push(`  missing fields: ${r.health.filesMissingFields.length}`);
    lines.push(`  misplaced top-level keys: ${r.health.filesMisplacedTopLevel.length}`);
    lines.push(`  broken MEMORY.md links: ${r.health.brokenMemoryMdLinks.length}`);
    lines.push(`  files not in MEMORY.md: ${r.health.filesNotInMemoryMd.length}`);
  }
  return lines.join("\n") + "\n";
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`FATAL: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);

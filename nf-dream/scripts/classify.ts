#!/usr/bin/env bun
/**
 * nf-dream classifier — heuristic bucket assignment for memory files.
 *
 * Used by: preview, reorganize, consolidate, stale, full.
 *
 * Buckets: Now > Next > Future > Done > Reference > Stale (tie-break order).
 *
 * Usage:
 *   bun classify.ts <scope> [--json] [--project <slug>] [--include-generic]
 *
 * NOTE: default is to EXCLUDE generic memories. Pass --include-generic to
 * include files tagged `metadata.project: generic` in the filter.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  extractFrontmatterDict,
  fileSizeKb,
  isSessionEnd,
  iterMemoryFiles,
  loadRegistry,
  parseFrontmatter,
  resolveFileProject,
  type ProjectSignal,
  type Registry,
} from "./_lib";

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

const SEVEN_DAYS = 7 * 24 * 3600;
const SIXTY_DAYS = 60 * 24 * 3600;

interface FileData {
  path: string;
  name: string;
  body: string;
  fm: Record<string, string>;
}

interface ClassifyEntry {
  file: string;
  bucket: Bucket;
  reason: string;
  mtime: number;
  size_kb: number;
  project: string;
}

function nowTs(): number {
  return Date.now() / 1000;
}

function classifyFile(
  path: string,
  body: string,
  nowReferenced: Set<string>
): { bucket: Bucket; reason: string } {
  const name = basename(path);
  const mtime = statSync(path).mtime.getTime() / 1000;
  const age = nowTs() - mtime;
  const bodyLower = body.toLowerCase();

  if (name.startsWith("reference_") || name.startsWith("reference-")) {
    return { bucket: "Reference", reason: "filename prefix" };
  }
  for (const pat of REFERENCE_MARKERS) {
    if (pat.test(body)) return { bucket: "Reference", reason: `body marker /${pat.source}/` };
  }

  if (isSessionEnd(name) && age < SEVEN_DAYS) {
    return { bucket: "Now", reason: "recent session-end (<7d)" };
  }
  for (const pat of NOW_BODY_MARKERS) {
    if (pat.test(body)) return { bucket: "Now", reason: `body marker ${pat.source}` };
  }

  for (const pat of NEXT_HEADING_MARKERS) {
    if (pat.test(body)) return { bucket: "Next", reason: `heading ${pat.source}` };
  }

  for (const marker of FUTURE_MARKERS) {
    if (body.includes(marker)) return { bucket: "Future", reason: `marker '${marker}'` };
  }

  const hasDone = DONE_MARKERS.some((m) => body.includes(m));
  const hasPending = body.includes("Pending") || body.includes("Open:");
  if (hasDone && age > SEVEN_DAYS && !hasPending) {
    return { bucket: "Done", reason: "ship marker + aged > 7d" };
  }

  for (const marker of STALE_MARKERS) {
    if (bodyLower.includes(marker)) return { bucket: "Stale", reason: `body marker '${marker}'` };
  }
  if (age > SIXTY_DAYS && !nowReferenced.has(name)) {
    return { bucket: "Stale", reason: "mtime > 60d, unreferenced" };
  }

  if (hasDone) return { bucket: "Done", reason: "ship marker (no aging signal)" };
  return { bucket: "Reference", reason: "default — load-bearing fact" };
}

/**
 * Filter a file in/out of scope for a project filter.
 *
 * Honors the (file → project) fallback chain in _lib.resolveFileProject —
 * but in the hot path we only consider signals #1 (frontmatter) and #2
 * (filename suffix). The hook-enforced filename suffix is reliable enough
 * to expand scope to files without frontmatter; the looser signals
 * (filename_token / body_*) are reserved for backfill / which-project where
 * the user has signed up for fuzziness.
 *
 * Returns: {match, slug, signal} so callers can record the matching signal
 * for reporting (e.g. classify summary, banner).
 */
export function fileMatchesFilter(
  path: string,
  fmDict: Record<string, string>,
  slug: string | null,
  includeGeneric: boolean,
  registry: Registry
): { match: boolean; slug: string; signal: ProjectSignal } {
  if (slug === null) return { match: true, slug: "", signal: "none" };
  // Cheap resolve: only frontmatter + filename_suffix signals
  const resolved = resolveFileProject(path, fmDict, { registry, cheap: true });

  // Multi-project YAML array support: when frontmatter wins, the value may be
  // "[a, b]" or "a, b". Split + match any.
  const expandValues = (raw: string): string[] => {
    const cleaned = raw.replace(/[\[\]]/g, "").trim();
    if (cleaned.length === 0) return [raw];
    return cleaned.split(/[,\s]+/).map((p) => p.replace(/^['"]|['"]$/g, "").trim());
  };

  // For frontmatter signal, expand multi-project arrays.
  const candidates: string[] =
    resolved.signal === "frontmatter"
      ? expandValues(resolved.slug)
      : resolved.slug.length > 0
        ? [resolved.slug]
        : [];

  if (candidates.includes(slug)) {
    return { match: true, slug, signal: resolved.signal };
  }
  if (includeGeneric && candidates.includes("generic")) {
    return { match: true, slug: "generic", signal: resolved.signal };
  }
  return { match: false, slug: "", signal: resolved.signal };
}

interface ClassifyResult {
  summary: {
    scope: string;
    project_filter: string | null;
    include_generic: boolean;
    total_in_scope: number;
    skipped_out_of_filter: number;
    by_bucket: Record<Bucket, number>;
    matched_by_signal: Record<string, number>;
    collisions: { file: string; frontmatter: string; suffix: string }[];
  };
  buckets: Record<Bucket, ClassifyEntry[]>;
}

export function classifyScope(
  scope: string,
  project: string | null,
  includeGeneric: boolean
): ClassifyResult {
  const registry = loadRegistry();
  const filesData: FileData[] = [];
  for (const f of iterMemoryFiles(scope)) {
    const text = readFileSync(f, "utf8");
    const parsed = parseFrontmatter(text);
    const body = parsed ? parsed.body : text;
    const fm = parsed ? extractFrontmatterDict(parsed.fmLines) : {};
    filesData.push({ path: f, name: basename(f), body, fm });
  }

  // First pass: find Now files to build referenced set
  const tmpNow: string[] = [];
  for (const d of filesData) {
    const { bucket } = classifyFile(d.path, d.body, new Set());
    if (bucket === "Now") tmpNow.push(d.path);
  }
  const nowReferenced = new Set<string>();
  for (const p of tmpNow) {
    const body = readFileSync(p, "utf8");
    for (const m of body.matchAll(/([a-z][a-z0-9_-]+\.md)/g)) {
      nowReferenced.add(m[1]);
    }
  }

  // Second pass: classify with filter
  const byBucket: Record<Bucket, ClassifyEntry[]> = {
    Now: [], Next: [], Future: [], Done: [], Reference: [], Stale: [],
  };
  const matchedBySignal: Record<string, number> = {};
  const collisions: { file: string; frontmatter: string; suffix: string }[] = [];
  let skippedFilter = 0;
  for (const d of filesData) {
    // Detect collisions independently of filter match (only when both signals present)
    const probe = resolveFileProject(d.path, d.fm, { registry, cheap: true });
    if (probe.collision) {
      collisions.push({
        file: d.name,
        frontmatter: probe.details.fromFrontmatter ?? "",
        suffix: probe.details.fromFilenameSuffix ?? "",
      });
    }

    const filt = fileMatchesFilter(d.path, d.fm, project, includeGeneric, registry);
    if (!filt.match) {
      skippedFilter++;
      continue;
    }
    matchedBySignal[filt.signal] = (matchedBySignal[filt.signal] ?? 0) + 1;
    const { bucket, reason } = classifyFile(d.path, d.body, nowReferenced);
    byBucket[bucket].push({
      file: d.name,
      bucket,
      reason,
      mtime: Math.floor(statSync(d.path).mtime.getTime() / 1000),
      size_kb: Math.round(fileSizeKb(d.path) * 10) / 10,
      project: d.fm["metadata.project"] ?? "",
    });
  }

  const byBucketCounts = Object.fromEntries(
    BUCKETS.map((b) => [b, byBucket[b].length])
  ) as Record<Bucket, number>;

  return {
    summary: {
      scope,
      project_filter: project,
      include_generic: includeGeneric,
      total_in_scope: BUCKETS.reduce((sum, b) => sum + byBucket[b].length, 0),
      skipped_out_of_filter: skippedFilter,
      by_bucket: byBucketCounts,
      matched_by_signal: matchedBySignal,
      collisions,
    },
    buckets: byBucket,
  };
}

interface Args {
  scope: string;
  json: boolean;
  project: string | null;
  includeGeneric: boolean;
  explain: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    scope: "", json: false, project: null, includeGeneric: false,
    explain: null, help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--json") a.json = true;
    else if (t === "--project") a.project = argv[++i] ?? null;
    else if (t === "--include-generic") a.includeGeneric = true;
    else if (t === "--explain") a.explain = argv[++i] ?? null;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help && !a.explain) {
    throw new Error("missing <scope> argument");
  }
  a.scope = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun classify.ts <scope> [--json] [--project <slug>] [--include-generic]
bun classify.ts --explain <file> [--json]

Heuristic bucket assignment for memory files (Now / Next / Future / Done / Reference / Stale).

Default filter behavior: when --project is given, files tagged 'generic' are EXCLUDED.
Pass --include-generic to also include them.

--explain <file>: print the project resolution chain for ONE file (frontmatter
  / filename suffix / filename token / body path / body URL / type=user). No
  scope traversal, no bucket classification.`);
}

function explainOne(filePath: string, json: boolean): number {
  let absPath: string;
  try {
    absPath = resolve(filePath.replace(/^~/, process.env.HOME ?? ""));
    statSync(absPath);
  } catch {
    console.error(`ERROR: ${filePath} not found`);
    return 1;
  }
  const text = readFileSync(absPath, "utf8");
  const parsed = parseFrontmatter(text);
  const fm = parsed ? extractFrontmatterDict(parsed.fmLines) : {};
  const body = parsed ? parsed.body : text;
  const registry = loadRegistry();
  // Full chain (cheap=false) so body signals also run
  const resolved = resolveFileProject(absPath, fm, { body, registry, cheap: false });

  const out = {
    file: basename(absPath),
    resolved: {
      slug: resolved.slug,
      signal: resolved.signal,
      confidence: resolved.confidence,
      collision: resolved.collision,
    },
    all_signals: resolved.details,
    has_frontmatter: parsed !== null,
  };

  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  console.log(`nf-dream classify --explain — ${out.file}`);
  console.log(`  resolved: project=${resolved.slug || "(none)"} signal=${resolved.signal} confidence=${resolved.confidence}`);
  if (resolved.collision) {
    console.log(`  COLLISION: frontmatter says '${resolved.details.fromFrontmatter}' but filename suffix is '${resolved.details.fromFilenameSuffix}'`);
  }
  console.log(`  signal chain (first hit wins):`);
  const rows: [string, string | undefined][] = [
    ["#1 frontmatter (metadata.project)", resolved.details.fromFrontmatter],
    ["#2 filename_suffix `_<slug>.md`", resolved.details.fromFilenameSuffix],
    ["#3 filename_token (legacy)", resolved.details.fromFilenameToken],
    ["#4 body_path", resolved.details.fromBodyPath],
    ["#5 body_url", resolved.details.fromBodyUrl],
    ["#6 type=user → generic", fm["metadata.type"] === "user" ? "generic" : undefined],
  ];
  for (const [label, val] of rows) {
    console.log(`    ${label.padEnd(36)} ${val ? `→ ${val}` : "(no match)"}`);
  }
  return 0;
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
  if (args.explain) {
    return explainOne(args.explain, args.json);
  }
  const scope = resolve(args.scope.replace(/^~/, process.env.HOME ?? ""));
  try {
    if (!statSync(scope).isDirectory()) throw new Error("not a dir");
  } catch {
    console.error(`ERROR: ${scope} is not a directory`);
    return 1;
  }

  const result = classifyScope(scope, args.project, args.includeGeneric);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(`nf-dream classify — ${scope}`);
  if (args.project) {
    console.log(`  filter: project=${args.project} (+generic=${args.includeGeneric})`);
  }
  console.log(`  in scope: ${result.summary.total_in_scope} files`);
  if (result.summary.skipped_out_of_filter) {
    console.log(`  skipped:  ${result.summary.skipped_out_of_filter} (out of filter)`);
  }
  console.log();
  for (const bucket of BUCKETS) {
    const items = result.buckets[bucket];
    console.log(`## ${bucket} (${items.length})`);
    for (const it of items.slice(0, 15)) {
      console.log(`  - ${it.file}  (${it.reason})`);
    }
    if (items.length > 15) {
      console.log(`  ... and ${items.length - 15} more`);
    }
    console.log();
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

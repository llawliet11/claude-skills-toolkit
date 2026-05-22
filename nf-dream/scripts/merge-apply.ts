#!/usr/bin/env bun
/**
 * nf-dream merge-apply — finalize a staged merge.
 *
 * Workflow (after `merge-stage.ts` + user/LLM edits):
 *   1. Read staged file + .source-paths.json sidecar
 *   2. Move staged file → scope root as final merged file
 *   3. Move source files → scope/archive/<YYYY-MM>/<source>
 *   4. Update archive/README.md breadcrumb ("merged into <final>")
 *   5. Update MEMORY.md (remove source entries, add merged entry)
 *   6. Delete staging dir
 *
 * Usage:
 *   bun merge-apply.ts <staged-file-path> [--dry-run] [--json]
 *
 * Sources of failure:
 *   - sidecar missing or corrupt
 *   - source file moved/renamed since staging (refuse to apply)
 *   - merged final path already exists (collision with another merge)
 *   - filesystem error during rename
 *
 * On failure mid-flight: best-effort report what was moved. No automatic
 * rollback — caller should use snapshot.ts tarball restore.
 */
import {
  readFileSync, writeFileSync, existsSync, statSync, mkdirSync,
  renameSync, rmSync, readdirSync,
} from "node:fs";
import { resolve, dirname, basename as pathBasename } from "node:path";
import { loadRegistry } from "./_lib";

/**
 * Synthesize a human-friendly title from a memory filename for MEMORY.md.
 *
 * Strips, in order:
 *   1. `.md` extension
 *   2. trailing `_<known-slug>` suffix (cwd-slug convention)
 *   3. type prefix `reference_`, `project_`, `feedback_`, `handoff[_-]`, `plan[_-]`
 *   4. trailing `-merged` or `_merged`
 *
 * Then replaces separators with spaces, capitalizes the first letter, and
 * preserves all-uppercase tokens (likely acronyms).
 *
 *   `reference_paas_provider-merged_example-infra.md` → "Paas provider"
 *   `project_aws_infra_example-infra.md`              → "Aws infra"
 *   `handoff-cc-warm-review-20260519_dot-claude.md`   → "Cc warm review 20260519"
 */
function deriveTitle(filename: string, knownSlugs: Set<string>): string {
  let stem = filename.replace(/\.md$/, "");
  // Strip cwd-slug suffix
  const last = stem.lastIndexOf("_");
  if (last > 0) {
    const candidate = stem.slice(last + 1);
    if (knownSlugs.has(candidate)) {
      stem = stem.slice(0, last);
    }
  }
  // Strip type prefix
  stem = stem.replace(/^(reference|project|feedback|handoff|plan)[_-]/i, "");
  // Strip merged tail
  stem = stem.replace(/[-_]merged$/i, "");
  // Replace separators with spaces
  const tokens = stem.split(/[_-]+/).filter(Boolean);
  if (tokens.length === 0) return filename;
  const title = tokens
    .map((t, i) => {
      // Preserve all-uppercase tokens (likely acronyms or model numbers)
      if (/^[A-Z0-9]+$/.test(t) && t.length > 1) return t;
      if (i === 0) return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
      return t.toLowerCase();
    })
    .join(" ");
  return title;
}

function truncateHook(text: string, maxLen = 150): string {
  if (text.length <= maxLen) return text;
  // Try to cut at sentence boundary
  const truncated = text.slice(0, maxLen);
  const lastPunct = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("; "),
    truncated.lastIndexOf(" — "),
    truncated.lastIndexOf(" - ")
  );
  if (lastPunct > maxLen * 0.6) {
    return truncated.slice(0, lastPunct).trim();
  }
  // Cut at word boundary
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? truncated.slice(0, lastSpace) : truncated).trim() + "…";
}

interface Sidecar {
  version: number;
  staged_at: string;
  scope: string;
  merged_name: string;
  target_final_path: string;
  sources: { file: string; path: string; mtime: string; originSessionId: string }[];
}

interface ApplyPlan {
  stagedPath: string;
  sidecar: Sidecar;
  scope: string;
  targetFinalPath: string;
  mergedName: string;
  moves: { src: string; archive: string; archiveRel: string }[];  // source moves
  stagingDir: string;
}

function deriveArchiveMonth(srcPath: string): string {
  const name = pathBasename(srcPath);
  const m = name.match(/(\d{4})[_-](\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  const mtime = statSync(srcPath).mtime;
  return `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, "0")}`;
}

function buildPlan(stagedPath: string): ApplyPlan {
  if (!existsSync(stagedPath)) {
    throw new Error(`staged file not found: ${stagedPath}`);
  }
  const stagingDir = dirname(stagedPath);
  const sidecarPath = resolve(stagingDir, ".source-paths.json");
  if (!existsSync(sidecarPath)) {
    throw new Error(`sidecar not found at ${sidecarPath} — was this file produced by merge-stage.ts?`);
  }
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Sidecar;
  if (sidecar.version !== 1) {
    throw new Error(`unsupported sidecar version: ${sidecar.version}`);
  }
  // Verify sources still exist and haven't been renamed
  for (const s of sidecar.sources) {
    if (!existsSync(s.path)) {
      throw new Error(`source no longer exists: ${s.path}. Refuse to apply.`);
    }
  }
  if (existsSync(sidecar.target_final_path)) {
    throw new Error(`final target already exists: ${sidecar.target_final_path}`);
  }
  const moves = sidecar.sources.map((s) => {
    const ym = deriveArchiveMonth(s.path);
    const archiveRel = `archive/${ym}/${s.file}`;
    return {
      src: s.path,
      archive: resolve(sidecar.scope, archiveRel),
      archiveRel,
    };
  });
  return {
    stagedPath,
    sidecar,
    scope: sidecar.scope,
    targetFinalPath: sidecar.target_final_path,
    mergedName: sidecar.merged_name,
    moves,
    stagingDir,
  };
}

function updateArchiveReadme(scope: string, moves: ApplyPlan["moves"], mergedName: string): void {
  const readmePath = resolve(scope, "archive", "README.md");
  mkdirSync(dirname(readmePath), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const existing = existsSync(readmePath)
    ? readFileSync(readmePath, "utf8")
    : "# Archive\n\nMoved memory files by date.\n";
  const lines = [existing.trimEnd(), ""];
  for (const m of moves) {
    const srcName = pathBasename(m.src);
    lines.push(`- ${today}: \`${srcName}\` → \`${m.archiveRel}\` (merged into ${mergedName})`);
  }
  lines.push("");
  writeFileSync(readmePath, lines.join("\n"));
}

function updateMemoryMd(scope: string, archivedNames: Set<string>, mergedName: string, mergedDescription: string): { removed: number; added: boolean } {
  const memoryPath = resolve(scope, "MEMORY.md");
  if (!existsSync(memoryPath)) return { removed: 0, added: false };
  const text = readFileSync(memoryPath, "utf8");
  const newLines: string[] = [];
  let removed = 0;
  let mergedAlreadyIndexed = false;
  for (const line of text.split("\n")) {
    const m = line.match(/\[[^\]]+\]\(([^)]+\.md)\)/);
    if (m) {
      if (archivedNames.has(m[1])) { removed++; continue; }
      if (m[1] === mergedName) mergedAlreadyIndexed = true;
    }
    newLines.push(line);
  }
  let newText = newLines.join("\n");
  // Ensure archive index link
  if (!newText.includes("- [Archive](archive/README.md)")) {
    newText = newText.trimEnd() + "\n\n- [Archive](archive/README.md) — consolidated session-end states\n";
  }
  // Add merged file index entry if not present
  let added = false;
  if (!mergedAlreadyIndexed) {
    const registry = loadRegistry();
    const knownSlugs = new Set([...Object.keys(registry.slugs), "generic"]);
    const title = deriveTitle(mergedName, knownSlugs);
    const hook = mergedDescription
      ? truncateHook(mergedDescription)
      : `merged from ${archivedNames.size} sources`;
    const entry = `- [${title}](${mergedName}) — ${hook}`;
    // Insert before the Archive link if present, else append
    if (newText.includes("- [Archive](archive/README.md)")) {
      newText = newText.replace(
        "- [Archive](archive/README.md)",
        `${entry}\n- [Archive](archive/README.md)`
      );
    } else {
      newText = newText.trimEnd() + `\n${entry}\n`;
    }
    added = true;
  }
  writeFileSync(memoryPath, newText);
  return { removed, added };
}

function readMergedDescription(stagedPath: string): string {
  const text = readFileSync(stagedPath, "utf8");
  if (!text.startsWith("---\n")) return "";
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") break;
    const m = lines[i].match(/^description:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}

function applyPlan(plan: ApplyPlan): { moved: string[]; promoted: string; archiveReadme: boolean; memoryMd: { removed: number; added: boolean } } {
  // 1. Promote staged file to final path
  renameSync(plan.stagedPath, plan.targetFinalPath);

  // 2. Move each source to archive
  const moved: string[] = [];
  for (const m of plan.moves) {
    mkdirSync(dirname(m.archive), { recursive: true });
    renameSync(m.src, m.archive);
    moved.push(m.archiveRel);
  }

  // 3. Update breadcrumb
  updateArchiveReadme(plan.scope, plan.moves, plan.mergedName);

  // 4. Update MEMORY.md
  const mergedDescription = readMergedDescription(plan.targetFinalPath);
  const archivedNames = new Set(plan.moves.map((m) => pathBasename(m.src)));
  const memUpdate = updateMemoryMd(plan.scope, archivedNames, plan.mergedName, mergedDescription);

  // 5. Clean up staging dir (sidecar + any other staging artifacts)
  // Only delete the specific merge-<stamp>/ folder, not the whole .staging/
  rmSync(plan.stagingDir, { recursive: true, force: true });

  return {
    moved,
    promoted: plan.targetFinalPath,
    archiveReadme: true,
    memoryMd: memUpdate,
  };
}

interface Args {
  stagedPath: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { stagedPath: "", dryRun: false, json: false, help: false };
  const rest: string[] = [];
  for (const t of argv) {
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--json") a.json = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help) throw new Error("missing <staged-file-path>");
  a.stagedPath = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun merge-apply.ts <staged-file-path> [--dry-run] [--json]

Finalize a staged merge produced by merge-stage.ts. Reads the .source-paths.json
sidecar in the staging dir to know which sources to archive. Promotes the staged
file to the scope root, moves sources to archive/<YYYY-MM>/, updates breadcrumb
+ MEMORY.md, cleans up staging dir.`);
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

  const stagedPath = resolve(args.stagedPath.replace(/^~/, process.env.HOME ?? ""));

  let plan: ApplyPlan;
  try {
    plan = buildPlan(stagedPath);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 1;
  }

  if (args.dryRun) {
    const summary = {
      staged: plan.stagedPath,
      promote_to: plan.targetFinalPath,
      archive: plan.moves.map((m) => ({ from: m.src, to: m.archiveRel })),
    };
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`merge-apply (dry-run)`);
      console.log(`  promote: ${plan.stagedPath}`);
      console.log(`        →  ${plan.targetFinalPath}`);
      console.log();
      console.log(`  archive ${plan.moves.length} sources:`);
      for (const m of plan.moves) {
        console.log(`    ${pathBasename(m.src)} → ${m.archiveRel}`);
      }
    }
    return 0;
  }

  let result: ReturnType<typeof applyPlan>;
  try {
    result = applyPlan(plan);
  } catch (err) {
    console.error(`ERROR mid-apply: ${(err as Error).message}`);
    console.error(`Best-effort: some files may already be moved. Inspect manually + use snapshot.ts to restore if needed.`);
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(`merge-apply — finalized merge`);
    console.log(`  promoted:    ${result.promoted}`);
    console.log(`  archived:    ${result.moved.length} files`);
    for (const a of result.moved) console.log(`    → ${a}`);
    console.log(`  MEMORY.md:   removed=${result.memoryMd.removed}, added=${result.memoryMd.added}`);
    console.log(`  staging dir cleaned`);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

#!/usr/bin/env bun
/**
 * nf-dream merge-stage — prepare a draft merged memory file from 2+ sources.
 *
 * The script does the MECHANICAL part: read sources, merge frontmatter via
 * deterministic rules, wrap each source's body with FROM markers, write the
 * draft + provenance sidecar to a staging dir under <scope>/.staging/.
 *
 * It does NOT do the SEMANTIC part: resolving contradictions between sources,
 * de-duplicating overlapping content, picking a final coherent narrative.
 * That work happens AFTER staging — either:
 *   - human user edits the draft, then runs `merge-apply.ts`, OR
 *   - LLM session reads the draft + sources, rewrites the body in place,
 *     then `merge-apply.ts` finalizes.
 *
 * Usage:
 *   # Explicit file pair
 *   bun merge-stage.ts --files <fileA> <fileB> [--name <merged-name>]
 *
 *   # Pick from dedupe candidates JSON output
 *   bun merge-stage.ts --from-dedupe <scope> [--pick <0-based-index>] [--top]
 *
 *   # Inspection
 *   bun merge-stage.ts --files A B --dry-run    # print plan, don't write
 *
 * Exits:
 *   0  staged successfully (path printed last line)
 *   1  argument / IO error
 *   2  refused merge (project/cwd/type mismatch)
 */
import {
  readFileSync, writeFileSync, statSync, existsSync, mkdirSync,
} from "node:fs";
import { resolve, dirname, basename as pathBasename } from "node:path";
import { spawnSync } from "node:child_process";
import {
  basename,
  extractCwdSlugFromFilename,
  extractFrontmatterDict,
  loadRegistry,
  parseFrontmatter,
} from "./_lib";

interface SourceInfo {
  path: string;          // absolute path
  name: string;          // basename
  mtime: string;         // ISO
  originSessionId: string;
  fm: Record<string, string>;
  body: string;
  fmLines: string[];
}

interface MergePlan {
  scope: string;
  sources: SourceInfo[];
  mergedName: string;          // final filename basename
  mergedFmLines: string[];     // composed frontmatter
  mergedBody: string;          // wrapped body
  stagingDir: string;
  stagedPath: string;
  sidecarPath: string;
  targetFinalPath: string;     // where merge-apply will write to (scope root)
}

function readSource(path: string): SourceInfo {
  const text = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(text);
  const fm = parsed ? extractFrontmatterDict(parsed.fmLines) : {};
  const body = parsed ? parsed.body : text;
  const fmLines = parsed ? parsed.fmLines : [];
  const stat = statSync(path);
  return {
    path,
    name: basename(path),
    mtime: stat.mtime.toISOString(),
    originSessionId: fm["originSessionId"] ?? "",
    fm,
    body,
    fmLines,
  };
}

function refuseIfMismatch(sources: SourceInfo[]): string | null {
  const projects = new Set(sources.map((s) => s.fm["metadata.project"] ?? "").filter(Boolean));
  if (projects.size > 1) {
    return `project mismatch — sources have different metadata.project: ${[...projects].join(", ")}`;
  }
  const cwds = new Set(sources.map((s) => s.fm["metadata.cwd"] ?? "").filter(Boolean));
  if (cwds.size > 1) {
    return `cwd mismatch — sources have different metadata.cwd: ${[...cwds].join(", ")}`;
  }
  const types = new Set(sources.map((s) => s.fm["metadata.type"] ?? "").filter(Boolean));
  if (types.size > 1) {
    return `type mismatch — sources have different metadata.type: ${[...types].join(", ")}`;
  }
  return null;
}

function parseYamlList(raw: string): string[] {
  if (!raw) return [];
  const cleaned = raw.replace(/^\[|\]$/g, "").trim();
  if (cleaned.length === 0) return [];
  return cleaned.split(/[,\n]+/).map((s) => s.replace(/^['"]|['"]$/g, "").trim()).filter(Boolean);
}

function emitYamlList(items: string[]): string {
  if (items.length === 0) return "[]";
  return `[${items.join(", ")}]`;
}

function composeFrontmatter(sources: SourceInfo[], mergedName: string): string[] {
  // Single source of truth: first source wins on scalar fields, union on list fields.
  const first = sources[0];
  const description = sources
    .map((s) => s.fm["description"] ?? "")
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const type = first.fm["metadata.type"] ?? "";
  const project = first.fm["metadata.project"] ?? "";
  const cwd = first.fm["metadata.cwd"] ?? "";

  const tags = new Set<string>();
  for (const s of sources) {
    for (const t of parseYamlList(s.fm["metadata.tags"] ?? "")) tags.add(t);
  }
  const related = new Set<string>();
  for (const s of sources) {
    for (const r of parseYamlList(s.fm["metadata.related"] ?? "")) related.add(r);
  }
  // Exclude self-references to the source files
  for (const s of sources) {
    const slug = s.name.replace(/\.md$/, "");
    related.delete(slug);
  }

  const stemName = mergedName.replace(/\.md$/, "");
  const mergedFrom = sources.map((s) => s.name);
  const mergedAt = new Date().toISOString().slice(0, 10);

  const fm: string[] = [];
  fm.push(`name: ${stemName}`);
  if (description) fm.push(`description: ${description}`);
  fm.push(`metadata:`);
  if (type) fm.push(`  type: ${type}`);
  if (project) fm.push(`  project: ${project}`);
  if (cwd) fm.push(`  cwd: ${cwd}`);
  if (tags.size > 0) fm.push(`  tags: ${emitYamlList([...tags])}`);
  if (related.size > 0) fm.push(`  related: ${emitYamlList([...related])}`);
  fm.push(`  merged_from: ${emitYamlList(mergedFrom)}`);
  fm.push(`  merged_at: ${mergedAt}`);
  return fm;
}

function composeBody(sources: SourceInfo[]): string {
  const sections: string[] = [];
  sections.push(`> **Draft merged file.** Edit this body to consolidate the source sections below`);
  sections.push(`> into a single coherent narrative. Then run:`);
  sections.push(`>`);
  sections.push(`>     bun merge-apply.ts <this-file>`);
  sections.push(`>`);
  sections.push(`> to archive the sources and promote this file to the scope root.`);
  sections.push("");
  for (const s of sources) {
    sections.push(`<!-- FROM: ${s.name} (mtime=${s.mtime}, originSessionId=${s.originSessionId || "n/a"}) -->`);
    sections.push("");
    sections.push(s.body.trim());
    sections.push("");
    sections.push(`<!-- END FROM: ${s.name} -->`);
    sections.push("");
    sections.push("---");
    sections.push("");
  }
  // Strip trailing divider
  while (sections.length > 0 && (sections[sections.length - 1] === "---" || sections[sections.length - 1] === "")) {
    sections.pop();
  }
  return sections.join("\n") + "\n";
}

function deriveMergedName(sources: SourceInfo[], cwdSlug: string | null, override?: string): string {
  if (override) {
    // Ensure ends with .md + has suffix matching cwdSlug if available
    let n = override.endsWith(".md") ? override : `${override}.md`;
    const existingSuffix = extractCwdSlugFromFilename(n);
    if (!existingSuffix && cwdSlug) {
      n = n.replace(/\.md$/, `_${cwdSlug}.md`);
    }
    return n;
  }
  // Take longer source's stem (sans suffix) + "-merged" + suffix
  const stems = sources.map((s) => {
    const stem = s.name.replace(/\.md$/, "");
    // strip cwd-slug suffix if present (extract returns slug if valid)
    const sfx = extractCwdSlugFromFilename(s.name);
    if (sfx) {
      const idx = stem.lastIndexOf("_");
      if (idx > 0) return stem.slice(0, idx);
    }
    return stem;
  });
  const longest = stems.sort((a, b) => b.length - a.length)[0];
  const baseName = `${longest}-merged`;
  const suffix = cwdSlug ?? "generic";
  return `${baseName}_${suffix}.md`;
}

function buildPlan(scope: string, sources: SourceInfo[], mergedNameOverride?: string): MergePlan {
  const refuse = refuseIfMismatch(sources);
  if (refuse) {
    const err = new Error(refuse);
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }
  const project = sources[0].fm["metadata.project"] ?? "";
  // Pick cwd-slug from project (registry) or extract from source filename
  const registry = loadRegistry();
  let cwdSlug: string | null = null;
  if (project && project !== "generic") {
    cwdSlug = project;
  } else if (project === "generic") {
    cwdSlug = "generic";
  } else {
    // fallback: try filename suffix from source
    cwdSlug = extractCwdSlugFromFilename(sources[0].name);
  }
  const mergedName = deriveMergedName(sources, cwdSlug, mergedNameOverride);

  const stamp = stampNow();
  const stagingDir = resolve(scope, ".staging", `merge-${stamp}`);
  const stagedPath = resolve(stagingDir, mergedName);
  const sidecarPath = resolve(stagingDir, ".source-paths.json");
  const targetFinalPath = resolve(scope, mergedName);

  if (existsSync(targetFinalPath)) {
    const err = new Error(`merged target already exists: ${targetFinalPath}`);
    (err as Error & { exitCode?: number }).exitCode = 2;
    throw err;
  }

  const mergedFmLines = composeFrontmatter(sources, mergedName);
  const mergedBody = composeBody(sources);

  return {
    scope, sources, mergedName, mergedFmLines, mergedBody,
    stagingDir, stagedPath, sidecarPath, targetFinalPath,
  };
}

function stampNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function writePlan(plan: MergePlan): void {
  mkdirSync(plan.stagingDir, { recursive: true });
  const content = `---\n${plan.mergedFmLines.join("\n")}\n---\n${plan.mergedBody}`;
  writeFileSync(plan.stagedPath, content);
  const sidecar = {
    version: 1,
    staged_at: new Date().toISOString(),
    scope: plan.scope,
    merged_name: plan.mergedName,
    target_final_path: plan.targetFinalPath,
    sources: plan.sources.map((s) => ({
      file: s.name,
      path: s.path,
      mtime: s.mtime,
      originSessionId: s.originSessionId,
    })),
  };
  writeFileSync(plan.sidecarPath, JSON.stringify(sidecar, null, 2));
}

function pickFromDedupe(scope: string, idx: number | null, top: boolean): string[] {
  const dedupePath = resolve(dirname(import.meta.url.replace(/^file:\/\//, "")), "dedupe-candidates.ts");
  const result = spawnSync("bun", [dedupePath, scope, "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`dedupe-candidates.ts failed: ${result.stderr ?? ""}`);
  }
  const data = JSON.parse(result.stdout) as { pairs: { a: string; b: string }[] };
  if (data.pairs.length === 0) {
    throw new Error("no dedupe candidates found");
  }
  const pair = top || idx === null ? data.pairs[0] : data.pairs[idx];
  if (!pair) {
    throw new Error(`pair index ${idx} out of range (have ${data.pairs.length})`);
  }
  return [resolve(scope, pair.a), resolve(scope, pair.b)];
}

interface Args {
  files: string[] | null;
  fromDedupe: string | null;
  pick: number | null;
  top: boolean;
  name: string | null;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    files: null, fromDedupe: null, pick: null, top: false,
    name: null, dryRun: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--files") {
      const collected: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        collected.push(argv[++i]);
      }
      if (collected.length < 2) throw new Error("--files requires 2+ paths");
      a.files = collected;
    } else if (t === "--from-dedupe") a.fromDedupe = argv[++i] ?? null;
    else if (t === "--pick") a.pick = parseInt(argv[++i] ?? "0", 10);
    else if (t === "--top") a.top = true;
    else if (t === "--name") a.name = argv[++i] ?? null;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--json") a.json = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else throw new Error(`unexpected positional arg: ${t}`);
  }
  if (!a.help && !a.files && !a.fromDedupe) {
    throw new Error("need --files <A> <B> ... OR --from-dedupe <scope>");
  }
  return a;
}

function printHelp(): void {
  console.log(`bun merge-stage.ts --files <A> <B> [...] [--name <merged>] [--dry-run] [--json]
bun merge-stage.ts --from-dedupe <scope> [--pick N | --top] [--name <merged>] [--dry-run] [--json]

Stage a draft merged memory file from 2+ source files. Sources stay in place;
only a draft + sidecar are written under <scope>/.staging/merge-<stamp>/.

Refuses merge if sources have different metadata.project, metadata.cwd, or
metadata.type. Merged file inherits scalar fields from first source, unions
list fields (tags, related), excludes self-references in related.

After review/edit the draft, run merge-apply.ts to archive sources + promote.`);
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

  let filePaths: string[];
  let scope: string;
  if (args.files) {
    filePaths = args.files.map((p) => resolve(p.replace(/^~/, process.env.HOME ?? "")));
    for (const p of filePaths) {
      if (!existsSync(p)) {
        console.error(`ERROR: source not found: ${p}`);
        return 1;
      }
    }
    // Infer scope from first source's dirname
    scope = dirname(filePaths[0]);
  } else {
    scope = resolve(args.fromDedupe!.replace(/^~/, process.env.HOME ?? ""));
    try {
      if (!statSync(scope).isDirectory()) throw new Error();
    } catch {
      console.error(`ERROR: ${scope} is not a directory`);
      return 1;
    }
    filePaths = pickFromDedupe(scope, args.pick, args.top);
  }

  const sources = filePaths.map(readSource);

  let plan: MergePlan;
  try {
    plan = buildPlan(scope, sources, args.name ?? undefined);
  } catch (err) {
    const code = (err as Error & { exitCode?: number }).exitCode ?? 2;
    console.error(`REFUSED: ${(err as Error).message}`);
    return code;
  }

  if (args.dryRun) {
    const summary = {
      scope: plan.scope,
      sources: plan.sources.map((s) => s.name),
      mergedName: plan.mergedName,
      stagingDir: plan.stagingDir,
      stagedPath: plan.stagedPath,
      targetFinalPath: plan.targetFinalPath,
      frontmatter_preview: plan.mergedFmLines,
      body_size_chars: plan.mergedBody.length,
    };
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`merge-stage (dry-run) — scope=${plan.scope}`);
      console.log(`  sources:     ${plan.sources.map((s) => s.name).join(", ")}`);
      console.log(`  merged name: ${plan.mergedName}`);
      console.log(`  staging dir: ${plan.stagingDir}`);
      console.log(`  final path:  ${plan.targetFinalPath}`);
      console.log();
      console.log("Frontmatter that will be written:");
      for (const line of plan.mergedFmLines) console.log(`  ${line}`);
    }
    return 0;
  }

  writePlan(plan);

  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      staged_path: plan.stagedPath,
      sidecar_path: plan.sidecarPath,
      target_final_path: plan.targetFinalPath,
      sources: plan.sources.map((s) => s.name),
    }, null, 2));
  } else {
    console.log(`merge-stage — staged ${plan.sources.length} sources into:`);
    console.log(`  ${plan.stagedPath}`);
    console.log(`  ${plan.sidecarPath}  (provenance sidecar)`);
    console.log();
    console.log("Next steps:");
    console.log(`  1. Edit ${pathBasename(plan.stagedPath)} to consolidate content`);
    console.log(`  2. Run: bun merge-apply.ts ${plan.stagedPath}`);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

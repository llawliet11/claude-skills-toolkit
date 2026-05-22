#!/usr/bin/env bun
/**
 * nf-dream / dream-lint.ts — Bun TypeScript focused frontmatter validator.
 *
 * Reads every *.md file under the resolved memory scope and validates against
 * the host setup's memory-frontmatter convention. Reports files with missing
 * required fields (metadata.type, metadata.project, metadata.cwd) and files
 * with misplaced top-level keys (project / cwd / tags / type / related at
 * top level instead of under `metadata:`).
 *
 * Read-only. Always emits JSON unless --text is given. Mirrors lint.ts but
 * folder-scoped to frontmatter compliance only, no broken-link checks, no
 * MEMORY.md indexing checks (those live in dream-scan.ts --mode lint).
 *
 * CLI:
 *   bun dream-lint.ts [--memory-path <path>] [--cwd <path>] [--text] [--help]
 *
 * Exit codes:
 *   0  scan completed and no issues found
 *   2  scan completed with one or more issues (non-fatal; signals user attention)
 *   1  resolution / IO failure
 */

import { resolve, basename, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const SKIP_BASENAMES = new Set(["MEMORY.md"]);
const HANDOFF_RE = /^HANDOFF([-_].+)?\.md$/i;

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
const REQUIRED_METADATA = ["metadata.type", "metadata.project", "metadata.cwd"];
const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);

interface ParsedFrontmatter {
  flat: Record<string, string>;
  misplacedTop: string[];
  hasFrontmatter: boolean;
  hasName: boolean;
  hasDescription: boolean;
  hasMetadataBlock: boolean;
}

interface LintIssue {
  file: string;
  kind:
    | "no_frontmatter"
    | "missing_required"
    | "misplaced_top_level"
    | "invalid_type"
    | "missing_top_fields";
  details: string[];
}

interface LintResult {
  memoryPath: string;
  scanned: number;
  ok: number;
  issues: LintIssue[];
  byKind: Record<string, number>;
  warnings: string[];
  durationMs: number;
}

interface Args {
  memoryPath: string | null;
  cwd: string;
  text: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    memoryPath: null,
    cwd: process.cwd(),
    text: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--memory-path":
        out.memoryPath = argv[++i] ?? null;
        break;
      case "--cwd":
        out.cwd = argv[++i] ?? process.cwd();
        break;
      case "--text":
        out.text = true;
        break;
      case "--json":
        out.text = false;
        break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  const help = `nf-dream / dream-lint.ts — frontmatter validator

Checks every memory file against the host setup's canonical memory-frontmatter
layout. Read-only. Always returns JSON unless --text is given.

USAGE
  bun dream-lint.ts [--memory-path <path>] [--cwd <path>] [--text]

CHECKS
  - no_frontmatter         file lacks YAML frontmatter block
  - missing_required       metadata.type / metadata.project / metadata.cwd absent
  - misplaced_top_level    metadata keys (project/cwd/tags/...) at top level
  - invalid_type           metadata.type not one of user/feedback/project/reference
  - missing_top_fields     top-level name / description / metadata block absent

EXIT CODES
  0  no issues
  2  issues found (informational, not a hard fail)
  1  hard error (scope unresolvable)
`;
  process.stdout.write(help);
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return p.replace(/^~/, homedir());
  return p;
}

function sanitizeCwd(absCwd: string): string {
  return "-" + absCwd.replace(/\//g, "-");
}

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
        "autoMemoryDirectory found but env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE missing — partial config",
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

  const sanitized = sanitizeCwd(resolve(cwd));
  const def = join(homedir(), ".claude", "projects", sanitized, "memory");
  if (existsSync(def)) return { path: def, source: "binary-default" };
  return { path: null, source: "none" };
}

function parseFrontmatter(text: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {
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

async function listMemoryFiles(scope: string): Promise<string[]> {
  const glob = new Bun.Glob("*.md");
  const out: string[] = [];
  for await (const rel of glob.scan({ cwd: scope, onlyFiles: true })) {
    const name = basename(rel);
    if (SKIP_BASENAMES.has(name)) continue;
    if (HANDOFF_RE.test(name)) continue; // handoff files are deliverables, not memory entries
    out.push(join(scope, rel));
  }
  return out.sort();
}

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

  const warnings: string[] = [];
  let scope: string | null = args.memoryPath
    ? (isAbsolute(args.memoryPath) ? args.memoryPath : resolve(args.cwd, args.memoryPath))
    : null;
  if (scope) scope = expandHome(scope);
  let source = "cli";
  if (!scope) {
    const r = await resolveMemoryPath(args.cwd, warnings);
    scope = r.path;
    source = r.source;
  }
  if (!scope) {
    process.stderr.write("ERROR: could not resolve memory path. Run /nf-memory.\n");
    return 1;
  }
  if (!existsSync(scope)) {
    process.stderr.write(`ERROR: memory path does not exist: ${scope}\n`);
    return 1;
  }

  const paths = await listMemoryFiles(scope);
  const issues: LintIssue[] = [];

  const records = await Promise.all(
    paths.map(async (p) => {
      const text = await Bun.file(p).text();
      return { path: p, name: basename(p), fm: parseFrontmatter(text) };
    }),
  );

  let okCount = 0;
  for (const r of records) {
    const fileIssues: LintIssue[] = [];
    if (!r.fm.hasFrontmatter) {
      fileIssues.push({ file: r.name, kind: "no_frontmatter", details: [] });
    } else {
      const missingTop: string[] = [];
      if (!r.fm.hasName) missingTop.push("name");
      if (!r.fm.hasDescription) missingTop.push("description");
      if (!r.fm.hasMetadataBlock) missingTop.push("metadata");
      if (missingTop.length > 0) {
        fileIssues.push({ file: r.name, kind: "missing_top_fields", details: missingTop });
      }

      const missingRequired: string[] = [];
      for (const key of REQUIRED_METADATA) {
        if (!r.fm.flat[key]) missingRequired.push(key);
      }
      if (missingRequired.length > 0) {
        fileIssues.push({ file: r.name, kind: "missing_required", details: missingRequired });
      }

      if (r.fm.misplacedTop.length > 0) {
        fileIssues.push({ file: r.name, kind: "misplaced_top_level", details: r.fm.misplacedTop });
      }

      const typeVal = r.fm.flat["metadata.type"];
      if (typeVal && !VALID_TYPES.has(typeVal)) {
        fileIssues.push({ file: r.name, kind: "invalid_type", details: [typeVal] });
      }
    }
    if (fileIssues.length === 0) okCount++;
    issues.push(...fileIssues);
  }

  const byKind: Record<string, number> = {};
  for (const it of issues) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;

  const result: LintResult = {
    memoryPath: scope,
    scanned: records.length,
    ok: okCount,
    issues,
    byKind,
    warnings: [`resolved-via: ${source}`, ...warnings],
    durationMs: +(performance.now() - t0).toFixed(1),
  };

  if (args.text) {
    const lines: string[] = [];
    lines.push(`nf-dream lint — ${scope}`);
    lines.push(`  scanned: ${result.scanned}    ok: ${result.ok}    issues: ${issues.length}`);
    lines.push(`  duration: ${result.durationMs}ms`);
    if (result.warnings.length > 0) {
      lines.push("");
      lines.push("WARNINGS");
      for (const w of result.warnings) lines.push(`  - ${w}`);
    }
    if (Object.keys(byKind).length > 0) {
      lines.push("");
      lines.push("BY KIND");
      for (const [k, n] of Object.entries(byKind)) lines.push(`  ${k}: ${n}`);
    }
    if (issues.length > 0) {
      lines.push("");
      lines.push("ISSUES");
      for (const it of issues.slice(0, 50)) {
        lines.push(`  - ${it.file}  [${it.kind}]  ${it.details.join(", ")}`);
      }
      if (issues.length > 50) lines.push(`  ... and ${issues.length - 50} more`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  return issues.length > 0 ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`FATAL: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);

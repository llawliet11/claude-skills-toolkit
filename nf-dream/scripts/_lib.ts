/**
 * nf-dream — shared helpers for all CLI scripts. No third-party deps,
 * only `node:*` modules (works under Bun).
 *
 * Ported from `_lib.py`.
 */
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = resolve(SCRIPT_DIR, "..");
export const REGISTRY_PATH = resolve(SKILL_DIR, "references", "slug-to-cwd.json");

export const TOP_RESERVED = new Set([
  "name",
  "description",
  "created",
  "originSessionId",
  "last_read",
  "session_id",
]);

export const METADATA_KEYS = new Set([
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

export const SKIP_BASENAMES = new Set(["MEMORY.md"]);
export const HANDOFF_PATTERN = /^HANDOFF([-_].+)?\.md$/i;
export const SESSION_END_PATTERN = /^project_session_end_state_/i;

export interface Registry {
  slugs: Record<string, string>;
  generic_cwd?: string;
  version?: number;
}

export function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) {
    return { slugs: {}, generic_cwd: `${process.env.HOME}/.claude` };
  }
  try {
    const raw = readFileSync(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as Registry;
  } catch {
    return { slugs: {}, generic_cwd: `${process.env.HOME}/.claude` };
  }
}

export interface ParsedFrontmatter {
  fmLines: string[];
  body: string;
  endIndex: number;
}

export function parseFrontmatter(text: string): ParsedFrontmatter | null {
  if (!text.startsWith("---\n")) return null;
  const lines = text.split("\n");
  let end: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === null) return null;
  return {
    fmLines: lines.slice(1, end),
    body: lines.slice(end + 1).join("\n"),
    endIndex: end,
  };
}

/**
 * Flatten frontmatter into a dict. metadata.* keys are flattened to "metadata.X".
 */
export function extractFrontmatterDict(fmLines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let inMd = false;
  for (const line of fmLines) {
    if (line.trim() === "") continue;
    const mTop = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    const mNested = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (mTop) {
      const key = mTop[1];
      const val = mTop[2].trim();
      if (key === "metadata") {
        inMd = true;
        continue;
      }
      inMd = false;
      out[key] = val;
    } else if (mNested && inMd) {
      out[`metadata.${mNested[1]}`] = mNested[2].trim();
    } else if (!line.startsWith(" ")) {
      inMd = false;
    }
  }
  return out;
}

export function isSkippable(name: string): boolean {
  return SKIP_BASENAMES.has(name);
}

/**
 * Yield *.md files in scope (sorted), excluding MEMORY.md and archive/.
 * Returns absolute paths.
 */
export function iterMemoryFiles(scope: string): string[] {
  const entries = readdirSync(scope, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (isSkippable(e.name)) continue;
    out.push(resolve(scope, e.name));
  }
  out.sort();
  return out;
}

export function fileSizeKb(path: string): number {
  return statSync(path).size / 1024;
}

export function isSessionEnd(name: string): boolean {
  return SESSION_END_PATTERN.test(name);
}

export function isHandoff(name: string): boolean {
  return HANDOFF_PATTERN.test(name);
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// ---------------------------------------------------------------------------
// (file → project) resolution
//
// Backed by the host setup's memory-frontmatter convention ("Filename convention").
// Every memory file should ultimately have:
//   1. metadata.project in YAML frontmatter (authoritative)
//   2. filename suffix `_<cwd-slug>.md` (hook-enforced for new writes)
//
// Older files may have neither — for those we fall back to weaker signals
// (filename-token match against known slugs, body absolute-path match, etc).
// ---------------------------------------------------------------------------

export type ProjectSignal =
  | "frontmatter"
  | "filename_suffix"
  | "filename_token"
  | "body_path"
  | "body_url"
  | "origin_session"
  | "type_user"
  | "none";

export interface ResolvedProject {
  slug: string;            // resolved project slug (empty string when signal = "none")
  signal: ProjectSignal;   // winning signal
  confidence: number;      // 0..1
  collision: boolean;      // frontmatter ≠ filename_suffix when both present
  details: {
    fromFrontmatter?: string;
    fromFilenameSuffix?: string;
    fromFilenameToken?: string;
    fromBodyPath?: string;
    fromBodyUrl?: string;
    fromOriginSession?: string;
  };
}

/**
 * Extract the cwd-slug suffix from a memory filename per the new convention.
 *
 *   `prefers-bun-over-npm_dot-claude.md`        → "dot-claude"
 *   `handoff-statusline-20260522_example-portfolio.md` → "example-portfolio"
 *   `og-template-phase2_example-blog.md`        → "example-blog"
 *   `terse-responses-preference_generic.md`     → "generic"
 *   `project_aws_infra.md`                      → null (no suffix, legacy file)
 *
 * The suffix is the segment after the LAST `_` before `.md`.
 * Returns null if the file basename doesn't end in `.md`, has no `_`, or the
 * candidate suffix doesn't look like a slug (contains uppercase, special chars
 * beyond `-`, or is empty).
 *
 * NOTE: this is heuristic — many legacy files like `project_aws_infra.md`
 * happen to end in `_<word>.md`. To distinguish a true suffix from a legacy
 * pattern, caller should cross-check against the known-slug registry or
 * confirm via `metadata.project` agreement.
 */
export function extractCwdSlugFromFilename(name: string): string | null {
  if (!name.endsWith(".md")) return null;
  const stem = name.slice(0, -3); // strip .md
  const idx = stem.lastIndexOf("_");
  if (idx === -1) return null;
  const candidate = stem.slice(idx + 1);
  if (candidate.length === 0) return null;
  // A valid slug per cwd-slug algorithm is lowercase a-z, 0-9, and `-`.
  // Anything else → not a suffix.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(candidate)) return null;
  return candidate;
}

/**
 * Like extractCwdSlugFromFilename but only returns a slug that is in the
 * registry of known project slugs (plus "generic"). This eliminates false
 * positives from legacy filenames like `project_aws_infra.md` where `infra`
 * is not actually a project slug.
 */
export function extractKnownSuffix(
  name: string,
  knownSlugs: Set<string>
): string | null {
  const candidate = extractCwdSlugFromFilename(name);
  if (candidate === null) return null;
  if (candidate === "generic") return "generic";
  if (knownSlugs.has(candidate)) return candidate;
  return null;
}

/**
 * Filename-token match (legacy precedence #3). Split basename on `_`, `-`, `.`,
 * lowercase tokens; if any known slug's tokens are a subset of file tokens,
 * that slug matches. Returns longest matching slug.
 *
 * Example: `project_aws_infra.md` vs slug `awsinfra` → no match
 *          `aws_infra_2026.md` vs slug `awsinfra`    → no match (slug tokens
 *                                                       are not subset)
 *          `example-blog-deploy.md` vs `example-blog` → match
 */
export function findFilenameTokenMatch(
  name: string,
  knownSlugs: string[]
): string | null {
  const stem = name.endsWith(".md") ? name.slice(0, -3) : name;
  const tokens = new Set(
    stem.split(/[_\-.]+/).filter(Boolean).map((t) => t.toLowerCase())
  );
  // Longest slug first to prefer more-specific matches.
  const sorted = [...knownSlugs].sort((a, b) => b.length - a.length);
  for (const slug of sorted) {
    const slugTokens = new Set(slug.toLowerCase().split(/[_\-.]+/));
    let allPresent = true;
    for (const t of slugTokens) {
      if (!tokens.has(t)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) return slug;
  }
  return null;
}

/**
 * Resolve which project a memory file belongs to via the fallback chain.
 *
 * `opts.cheap` (default true): skip expensive signals (body URL, originSession
 * reverse lookup) — suitable for the classify/lint hot path. When false,
 * caller is responsible for providing body content; we still don't do session
 * lookup here (caller can wire that separately via resolve-cwd-from-session).
 *
 * `opts.body` (optional): body text for path/url scans. If undefined, those
 * signals are skipped.
 *
 * `opts.registry` (required for non-frontmatter signals): slug→cwd map.
 */
export function resolveFileProject(
  path: string,
  fmDict: Record<string, string>,
  opts: {
    body?: string;
    registry?: Registry;
    cheap?: boolean;
  } = {}
): ResolvedProject {
  const name = basename(path);
  const cheap = opts.cheap ?? true;
  const registry = opts.registry ?? { slugs: {} };
  const knownSlugs = new Set([...Object.keys(registry.slugs), "generic"]);

  const details: ResolvedProject["details"] = {};

  // Signal #1 — frontmatter (authoritative)
  const fmProj = (fmDict["metadata.project"] ?? "").trim();
  if (fmProj.length > 0) details.fromFrontmatter = fmProj;

  // Signal #2 — filename suffix (hook-enforced for new writes)
  const suffix = extractKnownSuffix(name, knownSlugs);
  if (suffix !== null) details.fromFilenameSuffix = suffix;

  // Signal #3 — filename token match (legacy)
  const tokenMatch = findFilenameTokenMatch(name, Object.keys(registry.slugs));
  if (tokenMatch !== null) details.fromFilenameToken = tokenMatch;

  // Signal #4 — body absolute-path match (skipped when cheap=true or no body)
  if (!cheap && opts.body) {
    for (const [slug, cwd] of Object.entries(registry.slugs)) {
      if (cwd && opts.body.includes(cwd)) {
        details.fromBodyPath = slug;
        break;
      }
    }
  }

  // Signal #5 — body URL/domain match
  if (!cheap && opts.body) {
    const urlMatches = opts.body.matchAll(/https?:\/\/([a-z0-9.\-]+)/gi);
    outer: for (const m of urlMatches) {
      const host = m[1].toLowerCase();
      const hostKw = new Set(host.split(/[\-.]/));
      for (const slug of Object.keys(registry.slugs)) {
        const sKw = new Set(slug.toLowerCase().split(/[\-.]/));
        let inter = false;
        for (const k of sKw) if (hostKw.has(k)) { inter = true; break; }
        if (inter && slug.length >= 4) {
          details.fromBodyUrl = slug;
          break outer;
        }
      }
    }
  }

  // Signal #6 — type=user fallback to generic
  const isUserType = fmDict["metadata.type"] === "user";

  // Decide winner + collision flag.
  const hasFm = !!details.fromFrontmatter;
  const hasSuffix = !!details.fromFilenameSuffix;
  const collision = hasFm && hasSuffix &&
    details.fromFrontmatter !== details.fromFilenameSuffix;

  if (hasFm) {
    return {
      slug: details.fromFrontmatter!,
      signal: "frontmatter",
      confidence: 1.0,
      collision,
      details,
    };
  }
  if (hasSuffix) {
    return {
      slug: details.fromFilenameSuffix!,
      signal: "filename_suffix",
      confidence: 0.95,
      collision: false,
      details,
    };
  }
  if (details.fromFilenameToken) {
    return {
      slug: details.fromFilenameToken,
      signal: "filename_token",
      confidence: 0.7,
      collision: false,
      details,
    };
  }
  if (details.fromBodyPath) {
    return {
      slug: details.fromBodyPath,
      signal: "body_path",
      confidence: 0.7,
      collision: false,
      details,
    };
  }
  if (details.fromBodyUrl) {
    return {
      slug: details.fromBodyUrl,
      signal: "body_url",
      confidence: 0.6,
      collision: false,
      details,
    };
  }
  if (isUserType) {
    return {
      slug: "generic",
      signal: "type_user",
      confidence: 0.5,
      collision: false,
      details,
    };
  }
  return { slug: "", signal: "none", confidence: 0, collision: false, details };
}

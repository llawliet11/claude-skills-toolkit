#!/usr/bin/env bun
/**
 * nf-dream dedupe candidate pair generator.
 *
 * NEVER auto-merges. Emits candidate pairs JSON for Claude session to judge
 * + user to confirm. Pairs are within the same bucket only.
 *
 * Heuristic: filename-stem Levenshtein similarity ≥ threshold OR first-heading
 * keyword overlap ≥ 2 tokens.
 *
 * Usage:
 *   bun dedupe-candidates.ts <scope> [--project <slug>] [--json]
 *                                    [--threshold 0.6] [--include-generic]
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadRegistry, parseFrontmatter } from "./_lib";
import { classifyScope } from "./classify";

/**
 * Strip the `.md` extension AND the trailing `_<known-slug>` suffix (if any)
 * before computing similarity. Without this, all files in the same project
 * share an identical `_<slug>` tail, which inflates Levenshtein similarity
 * across unrelated files.
 *
 * Example: `project_l4d2_qchat_heniart-devops.md` →
 *          stripped to `project_l4d2_qchat` for similarity comparison.
 */
function stripForSimilarity(name: string, knownSlugs: Set<string>): string {
  let stem = name.endsWith(".md") ? name.slice(0, -3) : name;
  const last = stem.lastIndexOf("_");
  if (last > 0) {
    const candidate = stem.slice(last + 1);
    if (knownSlugs.has(candidate)) {
      stem = stem.slice(0, last);
    }
  }
  return stem;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < b.length) [a, b] = [b, a];
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
    }
    prev = cur;
  }
  return prev[b.length];
}

function stemSimilarity(a: string, b: string, knownSlugs: Set<string>): number {
  const sa = stripForSimilarity(a, knownSlugs);
  const sb = stripForSimilarity(b, knownSlugs);
  const dist = levenshtein(sa, sb);
  const longest = Math.max(sa.length, sb.length) || 1;
  return 1.0 - dist / longest;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "into", "via"]);

function firstHeadingTokens(scope: string, filename: string): Set<string> {
  const path = resolve(scope, filename);
  if (!existsSync(path)) return new Set();
  const text = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(text);
  const body = parsed ? parsed.body : text;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("# ")) {
      const matches = [...line.slice(2).toLowerCase().matchAll(/[a-z][a-z0-9]+/g)].map((m) => m[0]);
      return new Set(matches.filter((t) => !STOPWORDS.has(t)));
    }
  }
  return new Set();
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const v of a) if (b.has(v)) out.push(v);
  return out.sort();
}

interface Pair {
  bucket: string;
  a: string;
  b: string;
  stem_similarity: number;
  heading_overlap_count: number;
  shared_tokens: string[];
}

interface Args {
  scope: string;
  project: string | null;
  threshold: number;
  json: boolean;
  includeGeneric: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    scope: "", project: null, threshold: 0.6, json: false, includeGeneric: false, help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--project") a.project = argv[++i] ?? null;
    else if (t === "--threshold") a.threshold = parseFloat(argv[++i] ?? "0.6");
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
  console.log(`bun dedupe-candidates.ts <scope> [--project <slug>] [--json]
                              [--threshold 0.6] [--include-generic]

Generate dedupe candidate pairs. Never merges. Pairs are within same bucket.`);
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
  const registry = loadRegistry();
  const knownSlugs = new Set([...Object.keys(registry.slugs), "generic"]);
  const pairs: Pair[] = [];
  for (const [bucket, items] of Object.entries(classifyData.buckets)) {
    const names = items.map((it) => it.file);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        const sim = stemSimilarity(a, b, knownSlugs);
        const tokensA = firstHeadingTokens(scope, a);
        const tokensB = firstHeadingTokens(scope, b);
        const shared = intersect(tokensA, tokensB);
        if (sim >= args.threshold || shared.length >= 2) {
          pairs.push({
            bucket,
            a, b,
            stem_similarity: Math.round(sim * 100) / 100,
            heading_overlap_count: shared.length,
            shared_tokens: shared.slice(0, 10),
          });
        }
      }
    }
  }

  pairs.sort((p, q) => (q.stem_similarity + q.heading_overlap_count * 0.1) - (p.stem_similarity + p.heading_overlap_count * 0.1));

  const summary = {
    scope, project: args.project, threshold: args.threshold,
    candidate_pair_count: pairs.length,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, pairs }, null, 2));
    return 0;
  }

  console.log(`nf-dream dedupe candidates — ${scope}`);
  console.log(`  threshold: ${args.threshold}`);
  console.log(`  pairs found: ${pairs.length}`);
  console.log();
  for (const p of pairs.slice(0, 30)) {
    console.log(`  [${p.bucket}] sim=${p.stem_similarity} overlap=${p.heading_overlap_count}`);
    console.log(`    A: ${p.a}`);
    console.log(`    B: ${p.b}`);
    if (p.shared_tokens.length > 0) console.log(`    shared: ${p.shared_tokens.join(", ")}`);
    console.log();
  }
  if (pairs.length > 30) console.log(`  ... and ${pairs.length - 30} more pairs`);
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

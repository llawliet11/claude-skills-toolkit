#!/usr/bin/env bun
/**
 * nf-dream backfill — tag metadata.project + metadata.cwd via 7-step pipeline.
 *
 * 5 steps are mechanical (run by this script). Steps 6 (LLM judge) and 7
 * (user override) are deferred to the calling Claude session for low-confidence
 * files.
 *
 * Pipeline (precedence, first hit wins):
 *   1. Existing metadata.project           → skip (idempotent)
 *   2. Filename token match                → 0.7
 *   3. Body absolute-path match            → 0.7 (or 0.95 combined with filename)
 *   4. Body URL/domain match               → 0.6
 *   5. originSessionId reverse-lookup      → 0.8
 *   6. metadata.type=user fallback         → 0.5 → "generic"
 *   7. LLM judge / user override            (deferred — confidence < 0.7)
 *
 * Usage:
 *   bun backfill.ts <scope> [--apply] [--json]
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  extractFrontmatterDict,
  iterMemoryFiles,
  loadRegistry,
  parseFrontmatter,
  resolveFileProject,
  type Registry,
} from "./_lib";
import { resolveSession } from "./resolve-cwd-from-session";

interface ClassifyResult {
  project: string;
  cwd: string;
  confidence: number;
  signal: string;
  action: "skip" | "write" | "defer";
}

/**
 * Pipeline for backfill — wraps `_lib.resolveFileProject` (which covers signals
 * #1 frontmatter → #6 type=user) and adds the origin-session reverse lookup
 * (#5 in our chain but expensive — kept out of the hot path resolver).
 *
 * If `resolveFileProject` returns `none`, try origin_session before giving up.
 */
function classify(
  filePath: string,
  body: string,
  fmDict: Record<string, string>,
  registry: Registry
): ClassifyResult {
  const slugToCwd = registry.slugs;
  const resolved = resolveFileProject(filePath, fmDict, {
    body,
    registry,
    cheap: false,
  });

  if (resolved.signal === "frontmatter") {
    return {
      project: resolved.slug,
      cwd: fmDict["metadata.cwd"] ?? "",
      confidence: 1.0,
      signal: "frontmatter",
      action: "skip",
    };
  }

  if (resolved.signal !== "none") {
    const cwd = slugToCwd[resolved.slug] ?? "";
    return {
      project: resolved.slug,
      cwd,
      confidence: resolved.confidence,
      signal: resolved.signal,
      action: resolved.confidence >= 0.7 ? "write" : "defer",
    };
  }

  // Last-chance: origin session reverse lookup
  const sessionId = fmDict["originSessionId"] ?? "";
  if (sessionId) {
    const sess = resolveSession(sessionId);
    if (sess.ok && sess.matches.length > 0) {
      const cwd = sess.matches[0].cwd;
      for (const [slug, registeredCwd] of Object.entries(slugToCwd)) {
        if (registeredCwd === cwd) {
          return {
            project: slug,
            cwd,
            confidence: 0.8,
            signal: "origin_session",
            action: "write",
          };
        }
      }
      // cwd known but no slug — surface for inspection
      return {
        project: "",
        cwd,
        confidence: 0.0,
        signal: "origin_session (unmapped cwd)",
        action: "defer",
      };
    }
  }

  return {
    project: "",
    cwd: "",
    confidence: 0.0,
    signal: "none",
    action: "defer",
  };
}

function injectMetadata(fmLines: string[], project: string, cwd: string): string[] {
  const out: string[] = [];
  let foundMetadata = false;
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    out.push(line);
    if (line.trim() === "metadata:") {
      foundMetadata = true;
      let j = i + 1;
      const existingKeys: string[] = [];
      const existingBlock: string[] = [];
      while (
        j < fmLines.length &&
        (fmLines[j].startsWith(" ") || fmLines[j].startsWith("\t") || fmLines[j].trim() === "")
      ) {
        existingBlock.push(fmLines[j]);
        const m = fmLines[j].match(/^  ([A-Za-z_][A-Za-z0-9_]*):/);
        if (m) existingKeys.push(m[1]);
        j++;
      }
      out.push(...existingBlock);
      if (!existingKeys.includes("project") && project) out.push(`  project: ${project}`);
      if (!existingKeys.includes("cwd") && cwd) out.push(`  cwd: ${cwd}`);
      i = j;
      continue;
    }
    i++;
  }

  if (!foundMetadata) {
    out.push("metadata:");
    if (project) out.push(`  project: ${project}`);
    if (cwd) out.push(`  cwd: ${cwd}`);
  }
  return out;
}

interface Entry {
  file: string;
  project: string;
  cwd: string;
  confidence: number;
  signal: string;
  reason?: string;
}

interface Args {
  scope: string;
  apply: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { scope: "", apply: false, json: false, help: false };
  const rest: string[] = [];
  for (const t of argv) {
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--apply") a.apply = true;
    else if (t === "--json") a.json = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (rest.length === 0 && !a.help) throw new Error("missing <scope>");
  a.scope = rest[0] ?? "";
  return a;
}

function printHelp(): void {
  console.log(`bun backfill.ts <scope> [--apply] [--json]

Tag metadata.project + metadata.cwd in memory files via 7-step pipeline.
Default is dry-run; pass --apply to write changes to disk.`);
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

  const plan: { skip: Entry[]; write: Entry[]; defer: Entry[] } = { skip: [], write: [], defer: [] };
  let written = 0;

  for (const f of iterMemoryFiles(scope)) {
    const name = basename(f);
    const text = readFileSync(f, "utf8");
    const parsed = parseFrontmatter(text);
    if (!parsed) {
      plan.defer.push({
        file: name,
        project: "",
        cwd: "",
        confidence: 0,
        signal: "",
        reason: "no-frontmatter — backfill cannot add metadata.project without name/description",
      });
      continue;
    }
    const fmDict = extractFrontmatterDict(parsed.fmLines);
    const result = classify(f, parsed.body, fmDict, registry);
    const entry: Entry = {
      file: name,
      project: result.project,
      cwd: result.cwd,
      confidence: Math.round(result.confidence * 100) / 100,
      signal: result.signal,
    };
    if (result.action === "skip") plan.skip.push(entry);
    else if (result.action === "write") {
      plan.write.push(entry);
      if (args.apply) {
        const newFm = injectMetadata(parsed.fmLines, result.project, result.cwd);
        const newContent = `---\n${newFm.join("\n")}\n---\n${parsed.body}`;
        writeFileSync(f, newContent);
        written++;
      }
    } else plan.defer.push(entry);
  }

  const summary = {
    scope,
    applied: args.apply,
    total_files: plan.skip.length + plan.write.length + plan.defer.length,
    skip_already_tagged: plan.skip.length,
    write_eligible: plan.write.length,
    defer_low_confidence: plan.defer.length,
    written,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, plan }, null, 2));
    return 0;
  }

  console.log(`nf-dream backfill — ${scope}${args.apply ? " (APPLIED)" : " (dry-run)"}`);
  console.log(`  total:    ${summary.total_files}`);
  console.log(`  skip:     ${summary.skip_already_tagged} (already tagged)`);
  console.log(`  write:    ${summary.write_eligible}  (confidence >= 0.7)`);
  console.log(`  defer:    ${summary.defer_low_confidence}  (need LLM judge or user override)`);
  if (args.apply) console.log(`  written:  ${summary.written}`);
  console.log();
  if (plan.write.length > 0) {
    console.log(`## Write plan (${plan.write.length}):`);
    const byProject: Record<string, number> = {};
    for (const it of plan.write) byProject[it.project] = (byProject[it.project] ?? 0) + 1;
    for (const [proj, n] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${proj}: ${n}`);
    }
    console.log();
  }
  if (plan.defer.length > 0) {
    console.log(`## Defer (${plan.defer.length}) — needs human/LLM:`);
    for (const it of plan.defer.slice(0, 20)) {
      const tail = it.signal || it.reason || "";
      console.log(`  ${it.file}  (conf=${it.confidence}, signal=${tail})`);
    }
    if (plan.defer.length > 20) console.log(`  ... and ${plan.defer.length - 20} more`);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

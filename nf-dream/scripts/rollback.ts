#!/usr/bin/env bun
/**
 * nf-dream rollback — undo a previous consolidate/dedupe/reorganize/handoff/
 * full/normalize/backfill run.
 *
 * Two strategies:
 *   A) tarball: full restore from .snapshots/full-<stamp>.tar.gz (preferred)
 *   B) batch:   un-archive only the most recent batch from archive/README.md
 *
 * Usage:
 *   bun rollback.ts list <scope>
 *   bun rollback.ts tarball <scope> <stamp>
 *   bun rollback.ts batch <scope>
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface TarballInfo {
  stamp: string;
  size_kb: number;
  mtime: string;
  path: string;
}

interface ListResult {
  ok: true;
  tarballs: TarballInfo[];
  last_batch_date: string | null;
  last_batch_count: number;
  last_batch_lines: string[];
}

function listState(scope: string): ListResult {
  const snap = resolve(scope, ".snapshots");
  const tarballs: TarballInfo[] = [];
  if (existsSync(snap)) {
    const entries = readdirSync(snap)
      .filter((n) => n.startsWith("full-") && n.endsWith(".tar.gz"))
      .map((n) => ({ name: n, path: resolve(snap, n), mtime: statSync(resolve(snap, n)).mtime }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    for (const e of entries) {
      tarballs.push({
        stamp: e.name.replace(/^full-/, "").replace(/\.tar\.gz$/, ""),
        size_kb: Math.round(statSync(e.path).size / 1024 * 10) / 10,
        mtime: e.mtime.toISOString().slice(0, 19),
        path: e.path,
      });
    }
  }

  const archiveReadme = resolve(scope, "archive", "README.md");
  let lastBatchDate: string | null = null;
  const lastBatchMoves: string[] = [];
  if (existsSync(archiveReadme)) {
    const lines = readFileSync(archiveReadme, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const m = line.match(/^- (\d{4}-\d{2}-\d{2}):/);
      if (m) {
        const date = m[1];
        if (lastBatchDate === null) lastBatchDate = date;
        if (date === lastBatchDate) lastBatchMoves.push(line);
        else break;
      }
    }
  }

  return {
    ok: true,
    tarballs,
    last_batch_date: lastBatchDate,
    last_batch_count: lastBatchMoves.length,
    last_batch_lines: lastBatchMoves.reverse(),
  };
}

interface RestoreResult {
  ok: boolean;
  restored_from?: string;
  pre_rollback_tarball?: string;
  error?: string;
}

function restoreTarball(scope: string, stamp: string): RestoreResult {
  const snap = resolve(scope, ".snapshots");
  const tarball = resolve(snap, `full-${stamp}.tar.gz`);
  if (!existsSync(tarball)) {
    return { ok: false, error: `tarball not found: ${tarball}` };
  }

  const preStamp = `pre-rollback-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const preTar = resolve(snap, `full-${preStamp}.tar.gz`);
  const preResult = spawnSync("tar", [
    "-czf", preTar, "-C", scope,
    "--exclude=.snapshots", "--exclude=archive", ".",
  ], { encoding: "utf8" });
  if (preResult.status !== 0) {
    return { ok: false, error: `pre-rollback snapshot failed: ${preResult.stderr ?? ""}` };
  }

  const result = spawnSync("tar", ["-xzf", tarball, "-C", scope], { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? "").trim(), pre_rollback_tarball: preTar };
  }
  return { ok: true, restored_from: tarball, pre_rollback_tarball: preTar };
}

interface UnArchiveResult {
  ok: boolean;
  error?: string;
  moved?: { name: string; from: string }[];
  failed?: { name: string; reason: string }[];
  batch_date?: string;
}

function unArchiveLastBatch(scope: string): UnArchiveResult {
  const state = listState(scope);
  if (!state.last_batch_date) return { ok: false, error: "no archive batch found" };

  const moved: { name: string; from: string }[] = [];
  const failed: { name: string; reason: string }[] = [];
  const readmePath = resolve(scope, "archive", "README.md");
  const lines = readFileSync(readmePath, "utf8").split("\n");
  const keepLines: string[] = [];
  const targetDate = state.last_batch_date;
  for (const line of lines) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2}): `([^`]+)` → `(archive\/[^`]+)`/);
    if (m && m[1] === targetDate) {
      const srcName = m[2];
      const archivePath = m[3];
      const archiveFull = resolve(scope, archivePath);
      const targetFull = resolve(scope, srcName);
      if (existsSync(archiveFull) && !existsSync(targetFull)) {
        renameSync(archiveFull, targetFull);
        moved.push({ name: srcName, from: archivePath });
      } else {
        failed.push({ name: srcName, reason: "missing or collision" });
      }
      continue;
    }
    keepLines.push(line);
  }
  writeFileSync(readmePath, keepLines.join("\n"));
  return { ok: true, moved, failed, batch_date: targetDate };
}

interface Args {
  action: "list" | "tarball" | "batch" | "";
  scope: string;
  stamp: string | null;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { action: "", scope: "", stamp: null, json: false, help: false };
  const rest: string[] = [];
  for (const t of argv) {
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--json") a.json = true;
    else if (t.startsWith("--")) throw new Error(`unknown flag: ${t}`);
    else rest.push(t);
  }
  if (!a.help) {
    if (rest.length === 0) throw new Error("missing <action>");
    const action = rest[0];
    if (action !== "list" && action !== "tarball" && action !== "batch") {
      throw new Error(`unknown action: ${action}`);
    }
    a.action = action;
    if (rest.length < 2) throw new Error("missing <scope>");
    a.scope = rest[1];
    if (a.action === "tarball") {
      if (rest.length < 3) throw new Error("tarball action requires <stamp>");
      a.stamp = rest[2];
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`bun rollback.ts list <scope>
bun rollback.ts tarball <scope> <stamp>
bun rollback.ts batch <scope>

Roll back a previous nf-dream write run.`);
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

  let result: ListResult | RestoreResult | UnArchiveResult;
  if (args.action === "list") result = listState(scope);
  else if (args.action === "tarball") result = restoreTarball(scope, args.stamp!);
  else result = unArchiveLastBatch(scope);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return ("ok" in result && result.ok) ? 0 : 1;
  }

  if (args.action === "list") {
    const r = result as ListResult;
    console.log(`Tarballs (${r.tarballs.length}):`);
    for (const t of r.tarballs.slice(0, 10)) {
      console.log(`  ${t.mtime}  ${t.size_kb.toFixed(1).padStart(8)} KB  stamp=${t.stamp}`);
    }
    console.log("\nLast batch in archive/README.md:");
    if (r.last_batch_date) {
      console.log(`  date=${r.last_batch_date}  count=${r.last_batch_count}`);
      for (const ln of r.last_batch_lines.slice(0, 10)) console.log(`  ${ln}`);
    } else {
      console.log("  (none)");
    }
  } else if (args.action === "tarball") {
    const r = result as RestoreResult;
    if (r.ok) {
      console.log(`restored from: ${r.restored_from}`);
      console.log(`pre-rollback snapshot saved: ${r.pre_rollback_tarball}`);
    } else {
      console.error(`ERROR: ${r.error}`);
      return 1;
    }
  } else {
    const r = result as UnArchiveResult;
    if (!r.ok) { console.error(`ERROR: ${r.error}`); return 1; }
    console.log(`un-archived ${r.moved!.length} file(s) from batch ${r.batch_date}`);
    for (const m of r.moved!) console.log(`  ${m.name}  (from ${m.from})`);
    if (r.failed!.length > 0) {
      console.log(`failed: ${r.failed!.length}`);
      for (const f of r.failed!) console.log(`  ${f.name}: ${f.reason}`);
    }
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

#!/usr/bin/env bun
/**
 * nf-dream snapshot helper — tarball + per-file index snapshots with
 * retention sweep. Used by all write modes to ensure rollback is possible.
 *
 * Subcommands:
 *   create <scope>     create tarball + MEMORY.md/HANDOFF.md snapshots
 *   sweep <scope>      apply retention (tarballs 14d, per-file 7d)
 *   list <scope>       list available snapshots
 */
import {
  existsSync, statSync, readdirSync, mkdirSync, copyFileSync, unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function stampNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function ensureSnapshotsDir(scope: string): string {
  const snap = resolve(scope, ".snapshots");
  mkdirSync(snap, { recursive: true });
  return snap;
}

interface CreateResult {
  ok: boolean;
  stamp?: string;
  artifacts?: { tarball: string; [key: string]: string | string[] };
  error?: string;
}

function create(scope: string): CreateResult {
  const snap = ensureSnapshotsDir(scope);
  const stamp = stampNow();
  const tarball = resolve(snap, `full-${stamp}.tar.gz`);
  const result = spawnSync("tar", [
    "-czf", tarball, "-C", scope, "--exclude=.snapshots", "--exclude=archive", ".",
  ], { encoding: "utf8" });
  if (result.status !== 0) return { ok: false, error: (result.stderr ?? "").trim() };

  const artifacts: { tarball: string; [key: string]: string | string[] } = { tarball };

  for (const special of ["MEMORY.md", "HANDOFF.md"]) {
    const src = resolve(scope, special);
    if (existsSync(src)) {
      const dest = resolve(snap, `${special}-${stamp}`);
      copyFileSync(src, dest);
      artifacts[special.toLowerCase()] = dest;
    }
  }

  const handoffs: string[] = [];
  for (const entry of readdirSync(scope)) {
    if (/^HANDOFF-.+\.md$/.test(entry)) {
      const dest = resolve(snap, `${entry}-${stamp}`);
      copyFileSync(resolve(scope, entry), dest);
      handoffs.push(dest);
    }
  }
  if (handoffs.length > 0) artifacts.handoffs = handoffs;

  return { ok: true, stamp, artifacts };
}

interface SweepResult {
  ok: true;
  deleted: string[];
}

function sweep(scope: string): SweepResult {
  const snap = ensureSnapshotsDir(scope);
  const deleted: string[] = [];
  const now = Date.now() / 1000;
  const tarballCutoff = now - 14 * 24 * 3600;
  const perFileCutoff = now - 7 * 24 * 3600;
  for (const name of readdirSync(snap)) {
    const path = resolve(snap, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtime.getTime() / 1000;
    } catch {
      continue;
    }
    if (name.startsWith("full-") && name.endsWith(".tar.gz")) {
      if (mtime < tarballCutoff) {
        unlinkSync(path);
        deleted.push(name);
      }
    } else if (name.includes("MEMORY.md-") || name.includes("HANDOFF")) {
      if (mtime < perFileCutoff) {
        unlinkSync(path);
        deleted.push(name);
      }
    }
  }
  return { ok: true, deleted };
}

interface SnapInfo {
  name: string;
  size_kb: number;
  mtime: string;
}

interface ListResult {
  ok: true;
  tarballs: SnapInfo[];
  perfile_snapshots: SnapInfo[];
}

function listSnapshots(scope: string): ListResult {
  const snap = ensureSnapshotsDir(scope);
  const tarballs: SnapInfo[] = [];
  const perfile: SnapInfo[] = [];
  const items = readdirSync(snap).map((n) => ({
    name: n,
    path: resolve(snap, n),
    mtime: statSync(resolve(snap, n)).mtime,
    size: statSync(resolve(snap, n)).size,
  })).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  for (const it of items) {
    const info: SnapInfo = {
      name: it.name,
      size_kb: Math.round(it.size / 1024 * 10) / 10,
      mtime: it.mtime.toISOString().slice(0, 19),
    };
    if (it.name.startsWith("full-") && it.name.endsWith(".tar.gz")) tarballs.push(info);
    else perfile.push(info);
  }
  return { ok: true, tarballs, perfile_snapshots: perfile };
}

interface Args {
  action: "create" | "sweep" | "list" | "";
  scope: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { action: "", scope: "", json: false, help: false };
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
    if (action !== "create" && action !== "sweep" && action !== "list") {
      throw new Error(`unknown action: ${action}`);
    }
    a.action = action;
    if (rest.length < 2) throw new Error("missing <scope>");
    a.scope = rest[1];
  }
  return a;
}

function printHelp(): void {
  console.log(`bun snapshot.ts create <scope>
bun snapshot.ts sweep <scope>
bun snapshot.ts list <scope>`);
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

  let result: CreateResult | SweepResult | ListResult;
  if (args.action === "create") result = create(scope);
  else if (args.action === "sweep") result = sweep(scope);
  else result = listSnapshots(scope);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return ("ok" in result && result.ok) ? 0 : 1;
  }

  if (args.action === "create") {
    const r = result as CreateResult;
    if (r.ok) console.log(`snapshot created: ${r.artifacts!.tarball}`);
    else { console.error(`ERROR: ${r.error}`); return 1; }
  } else if (args.action === "sweep") {
    const r = result as SweepResult;
    console.log(`deleted ${r.deleted.length} aged snapshots`);
    for (const n of r.deleted) console.log(`  - ${n}`);
  } else {
    const r = result as ListResult;
    console.log(`tarballs (${r.tarballs.length}):`);
    for (const t of r.tarballs.slice(0, 10)) {
      console.log(`  ${t.mtime}  ${t.size_kb.toFixed(1).padStart(8)} KB  ${t.name}`);
    }
    console.log(`\nper-file snapshots (${r.perfile_snapshots.length}):`);
    for (const s of r.perfile_snapshots.slice(0, 10)) {
      console.log(`  ${s.mtime}  ${s.size_kb.toFixed(1).padStart(8)} KB  ${s.name}`);
    }
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

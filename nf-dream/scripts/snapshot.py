#!/usr/bin/env python3
"""nf-dream snapshot helper — tarball + per-file index snapshots with retention sweep.

Used by all write modes (normalize, reorganize, consolidate, dedupe, stale, backfill, translate)
to ensure rollback is always possible.

Subcommands:
  create <scope>            create tarball + MEMORY.md/HANDOFF.md snapshots
  sweep <scope>             apply retention (tarballs 14d, per-file 7d)
  list <scope>              list available snapshots
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path


def stamp_now() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def ensure_snapshots_dir(scope: Path) -> Path:
    snap = scope / ".snapshots"
    snap.mkdir(exist_ok=True)
    return snap


def create(scope: Path) -> dict:
    snap = ensure_snapshots_dir(scope)
    stamp = stamp_now()
    tarball = snap / f"full-{stamp}.tar.gz"
    cmd = [
        "tar", "-czf", str(tarball),
        "-C", str(scope),
        "--exclude=.snapshots",
        "--exclude=archive",
        ".",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return {"ok": False, "error": result.stderr.strip()}

    artifacts = {"tarball": str(tarball)}

    for special in ("MEMORY.md", "HANDOFF.md"):
        src = scope / special
        if src.exists():
            dest = snap / f"{special}-{stamp}"
            shutil.copy2(src, dest)
            artifacts[special.lower()] = str(dest)

    # Also snapshot HANDOFF-<slug>.md variants
    for hf in scope.glob("HANDOFF-*.md"):
        dest = snap / f"{hf.name}-{stamp}"
        shutil.copy2(hf, dest)
        artifacts.setdefault("handoffs", []).append(str(dest))

    return {"ok": True, "stamp": stamp, "artifacts": artifacts}


def sweep(scope: Path) -> dict:
    snap = ensure_snapshots_dir(scope)
    deleted: list[str] = []
    now = time.time()
    tarball_cutoff = now - 14 * 24 * 3600
    perfile_cutoff = now - 7 * 24 * 3600
    for p in snap.iterdir():
        try:
            mtime = p.stat().st_mtime
        except FileNotFoundError:
            continue
        if p.name.startswith("full-") and p.name.endswith(".tar.gz"):
            if mtime < tarball_cutoff:
                p.unlink()
                deleted.append(p.name)
        elif "MEMORY.md-" in p.name or "HANDOFF" in p.name:
            if mtime < perfile_cutoff:
                p.unlink()
                deleted.append(p.name)
    return {"ok": True, "deleted": deleted}


def list_snapshots(scope: Path) -> dict:
    snap = ensure_snapshots_dir(scope)
    tarballs = []
    perfile = []
    for p in sorted(snap.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        info = {
            "name": p.name,
            "size_kb": round(p.stat().st_size / 1024, 1),
            "mtime": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
        }
        if p.name.startswith("full-") and p.name.endswith(".tar.gz"):
            tarballs.append(info)
        else:
            perfile.append(info)
    return {"ok": True, "tarballs": tarballs, "perfile_snapshots": perfile}


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream snapshot helper")
    parser.add_argument("action", choices=["create", "sweep", "list"])
    parser.add_argument("scope")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    result = {"create": create, "sweep": sweep, "list": list_snapshots}[args.action](scope)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if args.action == "create":
            if result["ok"]:
                print(f"snapshot created: {result['artifacts']['tarball']}")
            else:
                print(f"ERROR: {result['error']}", file=sys.stderr)
                return 1
        elif args.action == "sweep":
            print(f"deleted {len(result['deleted'])} aged snapshots")
            for n in result["deleted"]:
                print(f"  - {n}")
        elif args.action == "list":
            print(f"tarballs ({len(result['tarballs'])}):")
            for t in result["tarballs"][:10]:
                print(f"  {t['mtime']}  {t['size_kb']:>8.1f} KB  {t['name']}")
            print(f"\nper-file snapshots ({len(result['perfile_snapshots'])}):")
            for s in result["perfile_snapshots"][:10]:
                print(f"  {s['mtime']}  {s['size_kb']:>8.1f} KB  {s['name']}")
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())

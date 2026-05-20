#!/usr/bin/env python3
"""nf-dream rollback — undo a previous consolidate/dedupe/reorganize/handoff/full/normalize/backfill run.

Two strategies:
  A) tarball: full restore from .snapshots/full-<stamp>.tar.gz (preferred — safe)
  B) batch:   un-archive only the most recent batch from archive/README.md

Usage:
  rollback.py list <scope>                # show available snapshots + last archive batch
  rollback.py tarball <scope> <stamp>     # restore tarball at .snapshots/full-<stamp>.tar.gz
  rollback.py batch <scope>               # un-archive last batch (from archive/README.md)
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def list_state(scope: Path) -> dict:
    snap = scope / ".snapshots"
    tarballs = []
    if snap.exists():
        for p in sorted(snap.glob("full-*.tar.gz"), key=lambda x: x.stat().st_mtime, reverse=True):
            tarballs.append({
                "stamp": p.name.removeprefix("full-").removesuffix(".tar.gz"),
                "size_kb": round(p.stat().st_size / 1024, 1),
                "mtime": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
                "path": str(p),
            })

    archive_readme = scope / "archive" / "README.md"
    last_batch_date = None
    last_batch_moves: list[str] = []
    if archive_readme.exists():
        lines = archive_readme.read_text().split("\n")
        # Find most recent date (lines like "- YYYY-MM-DD: ...")
        for line in reversed(lines):
            m = re.match(r"^- (\d{4}-\d{2}-\d{2}):", line)
            if m:
                date = m.group(1)
                if last_batch_date is None:
                    last_batch_date = date
                if date == last_batch_date:
                    last_batch_moves.append(line)
                else:
                    break
    return {
        "ok": True,
        "tarballs": tarballs,
        "last_batch_date": last_batch_date,
        "last_batch_count": len(last_batch_moves),
        "last_batch_lines": list(reversed(last_batch_moves)),
    }


def restore_tarball(scope: Path, stamp: str) -> dict:
    snap = scope / ".snapshots"
    tarball = snap / f"full-{stamp}.tar.gz"
    if not tarball.exists():
        return {"ok": False, "error": f"tarball not found: {tarball}"}

    # First, snapshot current state (rollback itself is reversible)
    pre_stamp = datetime.now().strftime("pre-rollback-%Y%m%d-%H%M%S")
    pre_tar = snap / f"full-{pre_stamp}.tar.gz"
    pre_cmd = [
        "tar", "-czf", str(pre_tar),
        "-C", str(scope),
        "--exclude=.snapshots", "--exclude=archive",
        ".",
    ]
    pre_result = subprocess.run(pre_cmd, capture_output=True, text=True)
    if pre_result.returncode != 0:
        return {"ok": False, "error": f"pre-rollback snapshot failed: {pre_result.stderr}"}

    # Now extract the requested tarball
    cmd = ["tar", "-xzf", str(tarball), "-C", str(scope)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return {"ok": False, "error": result.stderr.strip(), "pre_rollback_tarball": str(pre_tar)}
    return {"ok": True, "restored_from": str(tarball), "pre_rollback_tarball": str(pre_tar)}


def un_archive_last_batch(scope: Path) -> dict:
    """Move last batch of files back from archive/<YYYY-MM>/ to scope root."""
    state = list_state(scope)
    if not state["last_batch_date"]:
        return {"ok": False, "error": "no archive batch found"}

    moved: list[dict] = []
    failed: list[dict] = []
    readme = scope / "archive" / "README.md"
    lines = readme.read_text().split("\n")
    keep_lines: list[str] = []
    target_date = state["last_batch_date"]
    for line in lines:
        m = re.match(r"^- (\d{4}-\d{2}-\d{2}): `([^`]+)` → `(archive/[^`]+)`", line)
        if m and m.group(1) == target_date:
            src_name = m.group(2)
            archive_path = m.group(3)
            archive_full = scope / archive_path
            target_full = scope / src_name
            if archive_full.exists() and not target_full.exists():
                archive_full.rename(target_full)
                moved.append({"name": src_name, "from": archive_path})
            else:
                failed.append({"name": src_name, "reason": "missing or collision"})
            continue
        keep_lines.append(line)
    readme.write_text("\n".join(keep_lines))
    return {"ok": True, "moved": moved, "failed": failed, "batch_date": target_date}


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream rollback")
    parser.add_argument("action", choices=["list", "tarball", "batch"])
    parser.add_argument("scope")
    parser.add_argument("stamp", nargs="?", help="Tarball stamp for `tarball` action")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    if args.action == "list":
        result = list_state(scope)
    elif args.action == "tarball":
        if not args.stamp:
            print("ERROR: tarball action requires <stamp>", file=sys.stderr)
            return 1
        result = restore_tarball(scope, args.stamp)
    else:
        result = un_archive_last_batch(scope)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if args.action == "list":
            print(f"Tarballs ({len(result['tarballs'])}):")
            for t in result["tarballs"][:10]:
                print(f"  {t['mtime']}  {t['size_kb']:>8.1f} KB  stamp={t['stamp']}")
            print(f"\nLast batch in archive/README.md:")
            if result["last_batch_date"]:
                print(f"  date={result['last_batch_date']}  count={result['last_batch_count']}")
                for ln in result["last_batch_lines"][:10]:
                    print(f"  {ln}")
            else:
                print("  (none)")
        elif args.action == "tarball":
            if result["ok"]:
                print(f"restored from: {result['restored_from']}")
                print(f"pre-rollback snapshot saved: {result['pre_rollback_tarball']}")
            else:
                print(f"ERROR: {result['error']}", file=sys.stderr)
                return 1
        else:
            if not result["ok"]:
                print(f"ERROR: {result['error']}", file=sys.stderr)
                return 1
            print(f"un-archived {len(result['moved'])} file(s) from batch {result['batch_date']}")
            for m in result["moved"]:
                print(f"  {m['name']}  (from {m['from']})")
            if result["failed"]:
                print(f"failed: {len(result['failed'])}")
                for f in result["failed"]:
                    print(f"  {f['name']}: {f['reason']}")
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())

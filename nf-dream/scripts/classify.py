#!/usr/bin/env python3
"""nf-dream classifier — heuristic bucket assignment for memory files.

Used by: preview, reorganize, consolidate, stale, full.

Buckets: Now > Next > Future > Done > Reference > Stale (tie-break order).

Usage:
  classify.py <scope> [--json] [--project <slug>] [--include-generic]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import (  # noqa: E402
    extract_frontmatter_dict,
    file_size_kb,
    is_session_end,
    iter_memory_files,
    parse_frontmatter,
)

NOW_BODY_MARKERS = [r"\*\*START HERE\*\*", r"\bPending:", r"\bOpen:", r"\bQueued for next session\b"]
NEXT_HEADINGS = [r"^##\s+Next session\b", r"^##\s+TODO\b", r"^##\s+Queued\b"]
DONE_MARKERS = ["SHIPPED", "COMPLETE", "DONE", "MERGED"]
FUTURE_MARKERS = ["FUTURE WISHLIST", "DEFERRED", "BLOCKED BY", "Wishlist"]
REFERENCE_MARKERS = [r"\(canonical\)", r"\(stable reference\)"]
STALE_MARKERS = ["obsolete", "superseded by", "mostly obsolete", "legacy"]

SEVEN_DAYS = 7 * 24 * 3600
SIXTY_DAYS = 60 * 24 * 3600


def now_ts() -> float:
    return time.time()


def classify_file(path: Path, body: str, fm_dict: dict, now_referenced: set[str]) -> tuple[str, str]:
    """Return (bucket, reason)."""
    name = path.name
    mtime = path.stat().st_mtime
    age = now_ts() - mtime

    # Body content normalized for case-insensitive checks
    body_l = body.lower()

    # Reference (filename-led OR body marker)
    if name.startswith("reference_") or name.startswith("reference-"):
        return "Reference", "filename prefix"
    for pat in REFERENCE_MARKERS:
        if re.search(pat, body, re.IGNORECASE):
            return "Reference", f"body marker /{pat}/"

    # Now (recent session-end + load-bearing markers)
    if is_session_end(name) and age < SEVEN_DAYS:
        return "Now", "recent session-end (<7d)"
    for pat in NOW_BODY_MARKERS:
        if re.search(pat, body):
            return "Now", f"body marker {pat}"

    # Next (queued work)
    for pat in NEXT_HEADINGS:
        if re.search(pat, body, re.MULTILINE):
            return "Next", f"heading {pat}"

    # Future (wishlist / deferred)
    for marker in FUTURE_MARKERS:
        if marker in body:
            return "Future", f"marker {marker!r}"

    # Done (shipped + aged + no Pending/Open)
    has_done = any(m in body for m in DONE_MARKERS)
    has_pending = "Pending" in body or "Open:" in body
    if has_done and age > SEVEN_DAYS and not has_pending:
        return "Done", "ship marker + aged > 7d"

    # Stale (obsolete OR very old + unreferenced)
    for marker in STALE_MARKERS:
        if marker in body_l:
            return "Stale", f"body marker {marker!r}"
    if age > SIXTY_DAYS and name not in now_referenced:
        return "Stale", f"mtime > 60d, unreferenced"

    # Default: Done if shipped, else Reference (load-bearing fact w/o markers)
    if has_done:
        return "Done", "ship marker (no aging signal)"
    return "Reference", "default — load-bearing fact"


def file_matches_filter(fm_dict: dict, slug: str | None, include_generic: bool) -> bool:
    if slug is None:
        return True
    proj = fm_dict.get("metadata.project", "")
    # Multiple projects encoded as YAML array — flatten as text
    proj_norm = proj.strip("[] ").replace(",", " ").split()
    proj_norm = [p.strip().strip("'\"") for p in proj_norm] if proj_norm else [proj]
    if slug in proj_norm:
        return True
    if include_generic and "generic" in proj_norm:
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream classify")
    parser.add_argument("scope")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--project", help="Filter to project slug")
    parser.add_argument("--include-generic", action="store_true", default=True,
                        help="Include files tagged generic when filtering (default true)")
    parser.add_argument("--no-generic", dest="include_generic", action="store_false")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    # Pass 1: read all files, get bodies + frontmatter (for now-reference set)
    files_data: list[dict] = []
    for f in iter_memory_files(scope):
        text = f.read_text()
        parsed = parse_frontmatter(text)
        if parsed is None:
            body = text
            fm_dict = {}
        else:
            fm_lines, body, _ = parsed
            fm_dict = extract_frontmatter_dict(fm_lines)
        files_data.append({"path": f, "body": body, "fm": fm_dict})

    # Build "referenced by a Now bucket file" set — quick pass before classify
    # First-pass classify (no reference info yet) to find Now files
    now_referenced: set[str] = set()
    tmp_now: list[Path] = []
    for d in files_data:
        bucket, _ = classify_file(d["path"], d["body"], d["fm"], set())
        if bucket == "Now":
            tmp_now.append(d["path"])
    for p in tmp_now:
        body = p.read_text()
        for m in re.finditer(r"([a-z][a-z0-9_-]+\.md)", body):
            now_referenced.add(m.group(1))

    # Pass 2: final classify with reference info
    by_bucket: dict[str, list[dict]] = {b: [] for b in ["Now", "Next", "Future", "Done", "Reference", "Stale"]}
    skipped_filter = 0
    for d in files_data:
        if not file_matches_filter(d["fm"], args.project, args.include_generic):
            skipped_filter += 1
            continue
        bucket, reason = classify_file(d["path"], d["body"], d["fm"], now_referenced)
        by_bucket[bucket].append({
            "file": d["path"].name,
            "bucket": bucket,
            "reason": reason,
            "mtime": int(d["path"].stat().st_mtime),
            "size_kb": round(file_size_kb(d["path"]), 1),
            "project": d["fm"].get("metadata.project", ""),
        })

    summary = {
        "scope": str(scope),
        "project_filter": args.project,
        "include_generic": args.include_generic,
        "total_in_scope": sum(len(v) for v in by_bucket.values()),
        "skipped_out_of_filter": skipped_filter,
        "by_bucket": {k: len(v) for k, v in by_bucket.items()},
    }

    if args.json:
        print(json.dumps({"summary": summary, "buckets": by_bucket}, indent=2))
        return 0

    print(f"nf-dream classify — {scope}")
    if args.project:
        print(f"  filter: project={args.project} (+generic={args.include_generic})")
    print(f"  in scope: {summary['total_in_scope']} files")
    if skipped_filter:
        print(f"  skipped:  {skipped_filter} (out of filter)")
    print()
    for bucket in ["Now", "Next", "Future", "Done", "Reference", "Stale"]:
        items = by_bucket[bucket]
        print(f"## {bucket} ({len(items)})")
        for it in items[:15]:
            print(f"  - {it['file']}  ({it['reason']})")
        if len(items) > 15:
            print(f"  ... and {len(items) - 15} more")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())

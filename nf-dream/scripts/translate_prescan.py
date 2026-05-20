#!/usr/bin/env python3
"""nf-dream translate pre-scan.

For each filtered file, count lines containing Vietnamese diacritics. Buckets:
  none   — 0 VN lines
  light  — 1-2 VN lines (skip by default; likely proper noun)
  mixed  — 3+ VN lines but < 20% of total lines
  heavy  — VN lines >= 20% of total

Candidates: mixed + heavy. Output JSON for Claude session to pick translation targets.

Usage:
  translate_prescan.py <scope> [--project <slug>] [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import iter_memory_files, parse_frontmatter, extract_frontmatter_dict  # noqa: E402

DIACRITICS = (
    "àáảãạăắằẳẵặâấầẩẫậ"
    "èéẻẽẹêếềểễệ"
    "ìíỉĩị"
    "òóỏõọôốồổỗộơớờởỡợ"
    "ùúủũụưứừửữự"
    "ỳýỷỹỵ"
    "đ"
    "ÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬ"
    "ÈÉẺẼẸÊẾỀỂỄỆ"
    "ÌÍỈĨỊ"
    "ÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢ"
    "ÙÚỦŨỤƯỨỪỬỮỰ"
    "ỲÝỶỸỴ"
    "Đ"
)
DIACRITIC_RE = re.compile(f"[{re.escape(DIACRITICS)}]")


def bucket_of(vn_lines: int, total_lines: int) -> str:
    if vn_lines == 0:
        return "none"
    if vn_lines <= 2:
        return "light"
    ratio = vn_lines / max(total_lines, 1)
    return "heavy" if ratio >= 0.20 else "mixed"


def scan_file(path: Path) -> dict:
    text = path.read_text()
    parsed = parse_frontmatter(text)
    body = parsed[1] if parsed else text
    lines = body.split("\n")
    vn_lines = sum(1 for ln in lines if DIACRITIC_RE.search(ln))
    bucket = bucket_of(vn_lines, len(lines))
    return {
        "file": path.name,
        "total_lines": len(lines),
        "vn_lines": vn_lines,
        "bucket": bucket,
        "candidate": bucket in ("mixed", "heavy"),
    }


def project_matches(fm_dict: dict, slug: str | None) -> bool:
    if slug is None:
        return True
    proj = fm_dict.get("metadata.project", "")
    return slug in proj or "generic" in proj


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream translate pre-scan")
    parser.add_argument("scope")
    parser.add_argument("--project")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    files: list[dict] = []
    for f in iter_memory_files(scope):
        text = f.read_text()
        parsed = parse_frontmatter(text)
        fm = extract_frontmatter_dict(parsed[0]) if parsed else {}
        if not project_matches(fm, args.project):
            continue
        files.append(scan_file(f))

    summary = {
        "scope": str(scope),
        "project": args.project,
        "total": len(files),
        "by_bucket": {b: sum(1 for f in files if f["bucket"] == b) for b in ["none", "light", "mixed", "heavy"]},
        "candidates": sum(1 for f in files if f["candidate"]),
    }

    if args.json:
        print(json.dumps({"summary": summary, "files": files}, indent=2))
        return 0

    print(f"nf-dream translate pre-scan — {scope}")
    print(f"  total files: {summary['total']}")
    for b, n in summary["by_bucket"].items():
        print(f"  {b}: {n}")
    print(f"  candidates (mixed+heavy): {summary['candidates']}")
    print()
    print("Candidates:")
    for it in [f for f in files if f["candidate"]][:30]:
        print(f"  [{it['bucket']:5s}] {it['file']}  ({it['vn_lines']}/{it['total_lines']} VN lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

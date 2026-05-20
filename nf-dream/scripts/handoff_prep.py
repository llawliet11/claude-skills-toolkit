#!/usr/bin/env python3
"""nf-dream handoff input bundler.

Reads Now bucket (full content) + Next bucket (top section) into a single JSON bundle
that Claude session uses to synthesize HANDOFF-<slug>.md. Avoids round-trips for
file reads during synthesis.

Usage:
  handoff_prep.py <scope> --project <slug> [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import parse_frontmatter, extract_frontmatter_dict  # noqa: E402


def run_classify(scope: Path, project: str) -> dict:
    cmd = [sys.executable, str(Path(__file__).parent / "classify.py"), str(scope), "--project", project, "--json"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"classify.py failed: {result.stderr}")
    return json.loads(result.stdout)


def read_full(scope: Path, filename: str) -> dict:
    text = (scope / filename).read_text()
    parsed = parse_frontmatter(text)
    if parsed:
        fm_lines, body, _ = parsed
        fm = extract_frontmatter_dict(fm_lines)
    else:
        body = text
        fm = {}
    return {
        "file": filename,
        "description": fm.get("description", ""),
        "body": body[:5000],  # cap each file at 5KB
        "size_kb": round((scope / filename).stat().st_size / 1024, 1),
    }


def read_top_section(scope: Path, filename: str, max_chars: int = 1500) -> dict:
    text = (scope / filename).read_text()
    parsed = parse_frontmatter(text)
    body = parsed[1] if parsed else text
    # Take first ## section
    sections = re.split(r"\n## ", body, maxsplit=2)
    top = body if len(sections) == 1 else "##".join(["", sections[0], sections[1]])[:max_chars]
    return {"file": filename, "top_section": top}


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream handoff input bundle")
    parser.add_argument("scope")
    parser.add_argument("--project", required=True)
    parser.add_argument("--json", action="store_true", default=True,
                        help="JSON output (default — this script is intended for programmatic consumption)")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    classify_data = run_classify(scope, args.project)
    now_files = classify_data["buckets"].get("Now", [])
    next_files = classify_data["buckets"].get("Next", [])

    bundle = {
        "scope": str(scope),
        "project": args.project,
        "now_full": [read_full(scope, it["file"]) for it in now_files],
        "next_top": [read_top_section(scope, it["file"]) for it in next_files],
        "stats": {
            "now_count": len(now_files),
            "next_count": len(next_files),
        },
    }
    print(json.dumps(bundle, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

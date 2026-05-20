#!/usr/bin/env python3
"""nf-dream reorganize — rewrite MEMORY.md grouping current project's entries by bucket.

Out-of-scope entries remain in their original positions. Hooks are preserved from
existing MEMORY.md; synthesized from first heading or frontmatter description for
new entries.

Usage:
  reorganize.py <scope> --project <slug> [--apply] [--json]
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


def run_classify(scope: Path, project: str) -> dict:
    cmd = [sys.executable, str(Path(__file__).parent / "classify.py"), str(scope), "--project", project, "--json"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"classify.py failed: {result.stderr}")
    return json.loads(result.stdout)


def parse_memory_md(scope: Path) -> dict[str, str]:
    """Return mapping {filename: full line} from existing MEMORY.md."""
    memory = scope / "MEMORY.md"
    if not memory.exists():
        return {}
    out: dict[str, str] = {}
    for line in memory.read_text().split("\n"):
        m = re.search(r"\[[^\]]+\]\(([^)]+\.md)\)", line)
        if m:
            out[m.group(1)] = line
    return out


def synthesize_hook(scope: Path, filename: str) -> str:
    """Generate a one-line hook for a file without an existing entry."""
    path = scope / filename
    if not path.exists():
        return ""
    text = path.read_text()
    parsed = parse_frontmatter(text)
    if parsed:
        fm_lines, body, _ = parsed
        fm = extract_frontmatter_dict(fm_lines)
        if "description" in fm:
            return fm["description"][:150]
    else:
        body = text
    # Fallback: first markdown heading
    for line in body.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            return line[2:][:150]
    return filename


def render_entry(filename: str, hook: str, existing: dict[str, str]) -> str:
    if filename in existing:
        return existing[filename]
    # Title from filename stem
    title = filename.removesuffix(".md").replace("_", " ").replace("-", " ").capitalize()
    return f"- [{title}]({filename}) — {hook}"


def build_new_memory_md(scope: Path, classify_data: dict, project: str) -> str:
    existing = parse_memory_md(scope)
    in_scope_files = {e["file"] for bucket in classify_data["buckets"].values() for e in bucket}
    out_of_scope_lines: list[str] = []

    # Walk current MEMORY.md and keep lines that are NOT in-scope
    memory = scope / "MEMORY.md"
    if memory.exists():
        for line in memory.read_text().split("\n"):
            m = re.search(r"\[[^\]]+\]\(([^)]+\.md)\)", line)
            if m and m.group(1) in in_scope_files:
                continue
            out_of_scope_lines.append(line)

    out: list[str] = []
    out.append("# Memory Index")
    out.append("")
    out.append(f"## Project: {project}")
    out.append("")

    for bucket in ["Now", "Next", "Future", "Done", "Reference", "Stale"]:
        items = classify_data["buckets"].get(bucket, [])
        if not items:
            continue
        out.append(f"### {bucket}")
        out.append("")
        for it in items:
            hook = synthesize_hook(scope, it["file"])
            out.append(render_entry(it["file"], hook, existing))
        out.append("")

    out.append("## Other projects (unchanged)")
    out.append("")
    # Strip existing # heading and blank top from out_of_scope
    cleaned = "\n".join(out_of_scope_lines).strip()
    cleaned = re.sub(r"^#\s+Memory.*?\n+", "", cleaned)
    out.append(cleaned)
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream reorganize")
    parser.add_argument("scope")
    parser.add_argument("--project", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    classify_data = run_classify(scope, args.project)
    new_content = build_new_memory_md(scope, classify_data, args.project)

    summary = {
        "scope": str(scope),
        "project": args.project,
        "applied": args.apply,
        "new_memory_size_bytes": len(new_content),
        "buckets": classify_data["summary"]["by_bucket"],
    }

    if args.apply:
        (scope / "MEMORY.md").write_text(new_content)
        summary["written"] = True

    if args.json:
        out = {"summary": summary}
        if not args.apply:
            out["preview"] = new_content[:2000]
        print(json.dumps(out, indent=2))
        return 0

    print(f"nf-dream reorganize — {scope}  (project={args.project}){' (APPLIED)' if args.apply else ' (dry-run)'}")
    for b, n in summary["buckets"].items():
        print(f"  {b}: {n}")
    print()
    if not args.apply:
        print("=== Preview (first 60 lines of new MEMORY.md) ===")
        for line in new_content.split("\n")[:60]:
            print(line)
        if new_content.count("\n") > 60:
            print(f"... and {new_content.count(chr(10)) - 60} more lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())

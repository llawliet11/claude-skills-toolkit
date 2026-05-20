#!/usr/bin/env python3
"""nf-dream consolidate — move aged session-end states + Stale bucket into archive/.

Reads classification from classify.py (run automatically). Builds move plan + executes
with --apply. Updates archive/README.md breadcrumb and MEMORY.md index.

Usage:
  consolidate.py <scope> [--apply] [--json] [--project <slug>] [--age-days 14]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import iter_memory_files, parse_frontmatter, extract_frontmatter_dict, is_session_end  # noqa: E402


def run_classify(scope: Path, project: str | None) -> dict:
    cmd = [sys.executable, str(Path(__file__).parent / "classify.py"), str(scope), "--json"]
    if project:
        cmd += ["--project", project]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"classify.py failed: {result.stderr}")
    return json.loads(result.stdout)


def derive_archive_month(file_path: Path) -> str:
    """Extract YYYY-MM from filename like project_session_end_state_2026_05_14.md, else use mtime."""
    name = file_path.name
    m = re.search(r"(\d{4})[_-](\d{2})", name)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    mtime = file_path.stat().st_mtime
    return datetime.fromtimestamp(mtime).strftime("%Y-%m")


def build_plan(scope: Path, classify_data: dict, age_days: int) -> list[dict]:
    age_cutoff = time.time() - age_days * 24 * 3600
    plan: list[dict] = []
    for bucket in classify_data["buckets"].values():
        for entry in bucket:
            path = scope / entry["file"]
            if not path.exists():
                continue
            archive_candidate = False
            reason = ""
            if entry["bucket"] == "Stale":
                archive_candidate = True
                reason = f"Stale ({entry['reason']})"
            elif is_session_end(entry["file"]) and entry["mtime"] < age_cutoff:
                archive_candidate = True
                reason = f"session-end older than {age_days}d"
            if archive_candidate:
                ym = derive_archive_month(path)
                plan.append({
                    "src": entry["file"],
                    "target": f"archive/{ym}/{entry['file']}",
                    "bucket": entry["bucket"],
                    "reason": reason,
                })
    return plan


def update_archive_readme(scope: Path, moves: list[dict]):
    readme = scope / "archive" / "README.md"
    readme.parent.mkdir(exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    existing = readme.read_text() if readme.exists() else "# Archive\n\nMoved memory files by date.\n"
    lines = [existing.rstrip(), ""]
    for m in moves:
        lines.append(f"- {today}: `{m['src']}` → `{m['target']}` ({m['reason']})")
    lines.append("")
    readme.write_text("\n".join(lines))


def update_memory_md(scope: Path, archived_names: set[str]):
    memory = scope / "MEMORY.md"
    if not memory.exists():
        return
    text = memory.read_text()
    new_lines: list[str] = []
    removed = 0
    for line in text.split("\n"):
        m = re.search(r"\[[^\]]+\]\(([^)]+\.md)\)", line)
        if m and m.group(1) in archived_names:
            removed += 1
            continue
        new_lines.append(line)
    # Ensure archive index entry exists
    new_text = "\n".join(new_lines)
    if "- [Archive](archive/README.md)" not in new_text:
        # Append at end before EOF
        new_text = new_text.rstrip() + "\n\n- [Archive](archive/README.md) — consolidated session-end states\n"
    memory.write_text(new_text)
    return removed


def apply_plan(scope: Path, plan: list[dict]) -> dict:
    moves_done: list[dict] = []
    for entry in plan:
        src = scope / entry["src"]
        target = scope / entry["target"]
        target.parent.mkdir(parents=True, exist_ok=True)
        src.rename(target)
        moves_done.append(entry)
    if moves_done:
        update_archive_readme(scope, moves_done)
        update_memory_md(scope, {m["src"] for m in moves_done})
    return {"ok": True, "moved": len(moves_done)}


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream consolidate")
    parser.add_argument("scope")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--project")
    parser.add_argument("--age-days", type=int, default=14)
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    classify_data = run_classify(scope, args.project)
    plan = build_plan(scope, classify_data, args.age_days)
    summary = {
        "scope": str(scope),
        "applied": args.apply,
        "candidates": len(plan),
        "by_target": {},
    }
    for m in plan:
        ym = m["target"].split("/")[1]
        summary["by_target"][ym] = summary["by_target"].get(ym, 0) + 1

    if args.apply and plan:
        apply_plan(scope, plan)

    if args.json:
        print(json.dumps({"summary": summary, "plan": plan}, indent=2))
        return 0

    print(f"nf-dream consolidate — {scope}{' (APPLIED)' if args.apply else ' (dry-run)'}")
    print(f"  candidates: {len(plan)}")
    if not plan:
        print("  nothing to consolidate")
        return 0
    for ym, n in sorted(summary["by_target"].items()):
        print(f"  → archive/{ym}/: {n} files")
    print()
    print("Plan:")
    for m in plan[:30]:
        print(f"  {m['src']:50s} → {m['target']}  ({m['reason']})")
    if len(plan) > 30:
        print(f"  ... and {len(plan) - 30} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())

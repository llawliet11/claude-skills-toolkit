#!/usr/bin/env python3
"""nf-dream `lint` mode — read-only health check.

Folder-wide regardless of project filter (per SKILL.md: lint is the exception).
Reports issues, never writes.

Checks performed:
- MEMORY.md size > 20 KB
- Any file > 30 KB
- Files missing YAML frontmatter
- Files missing `name` / `description` (top-level)
- Files missing `metadata.type` / `metadata.project` / `metadata.cwd`
- Files with MISPLACED top-level keys (`type:` / `project:` / `cwd:` / `tags:` / `related:` at top
  instead of under `metadata:` — silently ignored by some tooling, see user-memory-frontmatter rule)
- MEMORY.md lines linking to files that don't exist
- Files that exist on disk but have no MEMORY.md entry
- archive/README.md entries pointing to files that no longer exist

Usage:
  lint.py <scope-folder> [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

TOP_RESERVED = {"name", "description", "created", "originSessionId", "last_read", "session_id"}
METADATA_KEYS = {"type", "project", "cwd", "tags", "related"}
SKIP_BASENAMES = {"MEMORY.md"}
HANDOFF_PATTERN = re.compile(r"^HANDOFF([-_].+)?\.md$", re.IGNORECASE)


def parse_frontmatter(text: str):
    if not text.startswith("---\n"):
        return None
    lines = text.split("\n")
    end = None
    for i in range(1, len(lines)):
        if lines[i] == "---":
            end = i
            break
    if end is None:
        return None
    return lines[1:end], "\n".join(lines[end + 1:])


def analyze_frontmatter(fm_lines: list[str]) -> dict:
    """Return dict of checks for one file's frontmatter."""
    has = {
        "name": False,
        "description": False,
        "metadata_block": False,
        "metadata.type": False,
        "metadata.project": False,
        "metadata.cwd": False,
    }
    misplaced_top: list[str] = []
    in_md = False
    md_indent_active = False
    i = 0
    while i < len(fm_lines):
        line = fm_lines[i]
        if line.strip() == "":
            i += 1
            continue
        m_top = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):(.*)$", line)
        m_nested = re.match(r"^  ([A-Za-z_][A-Za-z0-9_]*):(.*)$", line)
        if m_top:
            key = m_top.group(1)
            md_indent_active = False
            if key == "name":
                has["name"] = True
            elif key == "description":
                has["description"] = True
            elif key == "metadata":
                has["metadata_block"] = True
                md_indent_active = True
            elif key in METADATA_KEYS:
                misplaced_top.append(key)
            i += 1
            continue
        if m_nested and (in_md or md_indent_active):
            nkey = m_nested.group(1)
            if nkey == "type":
                has["metadata.type"] = True
            elif nkey == "project":
                has["metadata.project"] = True
            elif nkey == "cwd":
                has["metadata.cwd"] = True
            i += 1
            continue
        if line.startswith("  ") and md_indent_active:
            i += 1
            continue
        md_indent_active = False
        i += 1
    return {"has": has, "misplaced_top": misplaced_top}


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream lint")
    parser.add_argument("scope")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    findings: list[dict] = []

    memory_md = scope / "MEMORY.md"
    if memory_md.exists():
        size_kb = memory_md.stat().st_size / 1024
        if size_kb > 20:
            findings.append({"kind": "memory_md_large", "size_kb": round(size_kb, 1)})

    files = sorted(scope.glob("*.md"))
    on_disk = {f.name for f in files if f.name not in SKIP_BASENAMES}

    indexed: set[str] = set()
    broken_links: list[str] = []
    if memory_md.exists():
        # Match Markdown links `[label](target.md)` only — not bare parenthesised text.
        for m in re.finditer(r"\[[^\]]+\]\(([^)]+\.md)\)", memory_md.read_text()):
            link = m.group(1)
            indexed.add(link)
            if not (scope / link).exists() and not link.startswith("archive/"):
                broken_links.append(link)

    # Files that exist on disk but have no MEMORY.md entry. Skip handoff files (they are deliverables
    # for fresh sessions, not memory entries — they reference MEMORY.md, not the other way around).
    candidates_for_index = {n for n in on_disk if not HANDOFF_PATTERN.match(n)}
    missing_index = candidates_for_index - indexed
    if broken_links:
        findings.append({"kind": "memory_md_broken_links", "links": broken_links})
    if missing_index:
        findings.append({"kind": "files_not_in_memory_md", "files": sorted(missing_index)})

    for f in files:
        if f.name in SKIP_BASENAMES:
            continue
        size_kb = f.stat().st_size / 1024
        if size_kb > 30:
            findings.append({"kind": "file_large", "file": f.name, "size_kb": round(size_kb, 1)})
        text = f.read_text()
        parsed = parse_frontmatter(text)
        if parsed is None:
            findings.append({"kind": "no_frontmatter", "file": f.name})
            continue
        fm_lines, _ = parsed
        info = analyze_frontmatter(fm_lines)
        missing = [k for k, v in info["has"].items() if not v]
        if missing:
            findings.append({"kind": "missing_fields", "file": f.name, "missing": missing})
        if info["misplaced_top"]:
            findings.append({"kind": "misplaced_top_level", "file": f.name, "keys": info["misplaced_top"]})

    archive_readme = scope / "archive" / "README.md"
    if archive_readme.exists():
        for m in re.finditer(r"archive/[^\s)]+\.md", archive_readme.read_text()):
            rel = m.group(0)
            if not (scope / rel).exists():
                findings.append({"kind": "archive_breadcrumb_dangling", "ref": rel})

    summary = {
        "scope": str(scope),
        "total_files_scanned": len(on_disk),
        "findings_count": len(findings),
        "by_kind": {},
    }
    for f in findings:
        summary["by_kind"][f["kind"]] = summary["by_kind"].get(f["kind"], 0) + 1

    if args.json:
        print(json.dumps({"summary": summary, "findings": findings}, indent=2))
        return 0

    print(f"nf-dream lint — {scope}")
    print(f"  files scanned: {summary['total_files_scanned']}")
    print(f"  findings:      {summary['findings_count']}")
    if not findings:
        print("  clean — no issues")
        return 0
    print()
    by_kind: dict[str, list[dict]] = {}
    for f in findings:
        by_kind.setdefault(f["kind"], []).append(f)
    for kind, items in by_kind.items():
        print(f"## {kind} ({len(items)})")
        for it in items[:30]:
            details = ", ".join(f"{k}={v}" for k, v in it.items() if k != "kind")
            print(f"  - {details}")
        if len(items) > 30:
            print(f"  ... and {len(items) - 30} more")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""nf-dream `normalize` mode — structural frontmatter compliance.

Operates on every *.md file under <scope> (excluding MEMORY.md, HANDOFF*.md not by filename, and
archive/). Three responsibilities:

1. Move misplaced top-level YAML keys (`type:`, `project:`, `cwd:`, `tags:`, `related:`)
   from top-level into the `metadata:` block. The binary auto-injects top-level fields
   (`name`, `description`, `created`, `originSessionId`, `last_read`); putting
   project/cwd/tags/etc at top-level risks collision and is silently ignored by some tooling.
2. Add `metadata.type` from filename prefix per `references/filename-prefix-to-type.md`.
3. Add `metadata.cwd` from `references/slug-to-cwd.json` IF `metadata.project` is already set
   and `metadata.cwd` is missing. Does NOT classify `metadata.project` — that's `backfill`'s job.

Idempotent: re-running produces no further changes.

Usage:
  normalize.py <scope-folder> [--dry-run] [--json]
  normalize.py ~/.claude/memory/<scope> --dry-run

Output:
  human-readable summary (default) OR JSON report (--json) for skill consumption.
  Exits 0 on success, 1 on argument/IO error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
REGISTRY_PATH = SKILL_DIR / "references" / "slug-to-cwd.json"

TOP_RESERVED = {"name", "description", "created", "originSessionId", "last_read", "session_id"}
METADATA_KEYS = {"type", "project", "cwd", "tags", "related", "node_type", "status", "priority", "owner"}

PREFIX_TO_TYPE = [
    (re.compile(r"^project[_-]", re.IGNORECASE), "project"),
    (re.compile(r"^feedback[_-]", re.IGNORECASE), "feedback"),
    (re.compile(r"^reference[_-]", re.IGNORECASE), "reference"),
    (re.compile(r"^user[_-]", re.IGNORECASE), "user"),
    (re.compile(r"^handoff", re.IGNORECASE), "project"),
    (re.compile(r"^plan[_-]", re.IGNORECASE), "project"),
]

SKIP_BASENAMES = {"MEMORY.md"}


def infer_type(filename: str) -> str | None:
    for pat, t in PREFIX_TO_TYPE:
        if pat.search(filename):
            return t
    return None


def load_slug_registry() -> dict:
    if not REGISTRY_PATH.exists():
        return {"slugs": {}, "generic_cwd": None}
    try:
        return json.loads(REGISTRY_PATH.read_text())
    except json.JSONDecodeError as e:
        print(f"WARN: slug-to-cwd.json is invalid JSON ({e}); proceeding without registry", file=sys.stderr)
        return {"slugs": {}, "generic_cwd": None}


def parse_frontmatter(text: str) -> tuple[list[str], str] | None:
    """Return (frontmatter_lines, body) or None if no frontmatter."""
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


def split_top_and_metadata(fm_lines: list[str]) -> tuple[list[tuple[str, str]], list[str], list[tuple[str, list[str]]]]:
    """Walk frontmatter lines. Returns:
       - top: list of (key, raw-line-incl-continuations) for top-level lines we keep at top
       - metadata_lines: raw lines belonging to the existing metadata: block (without `metadata:` header)
       - misplaced: list of (key, captured-lines) for top-level lines that belong under metadata
    """
    top: list[tuple[str, str]] = []
    metadata_lines: list[str] = []
    misplaced: list[tuple[str, list[str]]] = []
    i = 0
    while i < len(fm_lines):
        line = fm_lines[i]
        if line.strip() == "":
            i += 1
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):(.*)$", line)
        if not m:
            # continuation of previous top-level entry
            if top:
                k, raw = top[-1]
                top[-1] = (k, raw + "\n" + line)
            i += 1
            continue
        key = m.group(1)
        if key == "metadata":
            j = i + 1
            while j < len(fm_lines) and (fm_lines[j].startswith(" ") or fm_lines[j].startswith("\t") or fm_lines[j].strip() == ""):
                if fm_lines[j].strip() != "":
                    metadata_lines.append(fm_lines[j])
                j += 1
            i = j
            continue
        if key in TOP_RESERVED:
            top.append((key, line))
            i += 1
            continue
        if key in METADATA_KEYS:
            captured = [line]
            j = i + 1
            while j < len(fm_lines) and (
                fm_lines[j].startswith(" ")
                or fm_lines[j].startswith("\t")
                or fm_lines[j].strip().startswith("- ")
            ):
                captured.append(fm_lines[j])
                j += 1
            misplaced.append((key, captured))
            i = j
            continue
        # unknown top-level key — keep as-is to be safe
        top.append((key, line))
        i += 1
    return top, metadata_lines, misplaced


def build_md_map(metadata_lines: list[str]) -> dict[str, list[str]]:
    md_map: dict[str, list[str]] = {}
    cur_key: str | None = None
    cur_block: list[str] = []
    for line in metadata_lines:
        m = re.match(r"^  ([A-Za-z_][A-Za-z0-9_]*):(.*)$", line)
        if m:
            if cur_key is not None:
                md_map[cur_key] = cur_block
            cur_key = m.group(1)
            cur_block = [line]
        else:
            cur_block.append(line)
    if cur_key is not None:
        md_map[cur_key] = cur_block
    return md_map


def reindent_misplaced(captured: list[str]) -> list[str]:
    """Top-level `key: val` lines need 2-space prefix. Continuations already indented stay relative."""
    return ["  " + ln for ln in captured]


def render_frontmatter(top: list[tuple[str, str]], md_map: dict[str, list[str]]) -> list[str]:
    out: list[str] = []
    for _, raw in top:
        out.extend(raw.split("\n"))
    if md_map:
        out.append("metadata:")
        order = ["node_type", "type", "project", "cwd", "tags", "related", "status", "priority", "owner"]
        emitted = set()
        for k in order:
            if k in md_map:
                out.extend(md_map[k])
                emitted.add(k)
        for k, v in md_map.items():
            if k not in emitted:
                out.extend(v)
    return out


def extract_value(block_lines: list[str]) -> str:
    """Return scalar value from a `  key: value` (single line). For multi-line values, returns ''."""
    if not block_lines:
        return ""
    first = block_lines[0]
    m = re.match(r"^  [A-Za-z_][A-Za-z0-9_]*:\s*(.*)$", first)
    if not m:
        return ""
    return m.group(1).strip()


def normalize_file(path: Path, registry: dict) -> dict:
    """Apply normalization to one file. Returns a change report dict."""
    text = path.read_text()
    parsed = parse_frontmatter(text)
    if parsed is None:
        return {"file": path.name, "status": "no-frontmatter"}
    fm_lines, body = parsed

    top, metadata_lines, misplaced = split_top_and_metadata(fm_lines)
    md_map = build_md_map(metadata_lines)

    actions: list[str] = []

    # 1) Move misplaced top-level keys → metadata
    for key, captured in misplaced:
        if key not in md_map:
            md_map[key] = reindent_misplaced(captured)
            actions.append(f"moved-top:{key}")

    # 2) Add metadata.type from filename prefix
    if "type" not in md_map:
        t = infer_type(path.name)
        if t:
            md_map["type"] = [f"  type: {t}"]
            actions.append(f"added-type:{t}")

    # 3) Add metadata.cwd from registry if project known + cwd missing
    if "project" in md_map and "cwd" not in md_map:
        proj_val = extract_value(md_map["project"])
        cwd_val = registry.get("slugs", {}).get(proj_val)
        if cwd_val:
            md_map["cwd"] = [f"  cwd: {cwd_val}"]
            actions.append(f"added-cwd:{proj_val}")

    new_fm = render_frontmatter(top, md_map)
    new_content = "---\n" + "\n".join(new_fm) + "\n---\n" + body

    if new_content == text:
        return {"file": path.name, "status": "unchanged", "actions": []}
    return {
        "file": path.name,
        "status": "would-change" if actions else "no-op-write",
        "actions": actions,
        "_new_content": new_content,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream normalize — structural frontmatter compliance")
    parser.add_argument("scope", help="Memory scope folder (e.g. ~/.claude/memory/personal)")
    parser.add_argument("--dry-run", action="store_true", help="Report only, do not write")
    parser.add_argument("--json", action="store_true", help="Emit JSON report instead of human text")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    registry = load_slug_registry()
    reports: list[dict] = []
    written = 0
    for f in sorted(scope.glob("*.md")):
        if f.name in SKIP_BASENAMES:
            continue
        rep = normalize_file(f, registry)
        if rep.get("_new_content") is not None and not args.dry_run:
            f.write_text(rep["_new_content"])
            rep["status"] = "changed"
            written += 1
        rep.pop("_new_content", None)
        reports.append(rep)

    summary = {
        "scope": str(scope),
        "dry_run": args.dry_run,
        "total_files": len(reports),
        "changed_or_would_change": sum(1 for r in reports if r["status"] in ("changed", "would-change")),
        "written": written,
        "unchanged": sum(1 for r in reports if r["status"] == "unchanged"),
        "no_frontmatter": sum(1 for r in reports if r["status"] == "no-frontmatter"),
    }

    if args.json:
        print(json.dumps({"summary": summary, "files": reports}, indent=2))
    else:
        print(f"nf-dream normalize — {scope}")
        print(f"  total files:  {summary['total_files']}")
        print(f"  changed:      {summary['written']}" if not args.dry_run else f"  would-change: {summary['changed_or_would_change']}")
        print(f"  unchanged:    {summary['unchanged']}")
        print(f"  no-frontmatter: {summary['no_frontmatter']}")
        flagged = [r for r in reports if r["status"] in ("changed", "would-change")]
        if flagged:
            print()
            print("Files modified:" if not args.dry_run else "Would modify:")
            for r in flagged[:50]:
                print(f"  {r['file']}: {', '.join(r['actions']) or '(no actions but content differs)'}")
            if len(flagged) > 50:
                print(f"  ... and {len(flagged) - 50} more")
        no_fm = [r for r in reports if r["status"] == "no-frontmatter"]
        if no_fm:
            print()
            print(f"Files without frontmatter (manual fix needed): {len(no_fm)}")
            for r in no_fm[:10]:
                print(f"  {r['file']}")
            if len(no_fm) > 10:
                print(f"  ... and {len(no_fm) - 10} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())

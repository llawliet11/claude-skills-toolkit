#!/usr/bin/env python3
"""Reverse-lookup cwd from an originSessionId.

Scans ~/.claude/projects/<encoded-cwd>/ for a JSONL file matching <sessionId>, decodes
the cwd from the folder name (encoding: `/` → `-` in absolute path, leading `-` from root `/`).

Usage:
  resolve_cwd_from_session.py <sessionId> [--json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECTS_ROOT = Path.home() / ".claude" / "projects"


def decode_folder_name(folder_name: str) -> str:
    """Reverse the binary's encoding: leading `-` + `/` → `-`.

    Examples:
      `-Users-me-projects-example-blog` → `/Users/me/projects/example-blog`
      `-Users-me--claude-memory`        → `/Users/me/.claude/memory`
    """
    if not folder_name.startswith("-"):
        return ""
    s = folder_name[1:]
    # Naive decode: every `-` → `/`. The double-`-` in `me--claude` becomes
    # `me/.claude` after we then collapse `/.` markers. The binary's actual
    # encoding does not preserve dots, so this is heuristic — return best guess.
    decoded = "/" + s.replace("-", "/")
    # Handle `.claude` hidden folder pattern: `//claude` → `/.claude`
    decoded = decoded.replace("//", "/.")
    return decoded


def resolve(session_id: str) -> dict:
    if not PROJECTS_ROOT.exists():
        return {"ok": False, "error": f"{PROJECTS_ROOT} does not exist"}
    matches = []
    for folder in PROJECTS_ROOT.iterdir():
        if not folder.is_dir():
            continue
        for jsonl in folder.glob(f"{session_id}.jsonl"):
            cwd = decode_folder_name(folder.name)
            matches.append({"folder": folder.name, "cwd": cwd, "jsonl": str(jsonl)})
    return {"ok": bool(matches), "matches": matches, "session_id": session_id}


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve cwd from originSessionId")
    parser.add_argument("session_id")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    result = resolve(args.session_id)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if not result["ok"]:
            print(f"No match for sessionId {args.session_id}", file=sys.stderr)
            return 1
        for m in result["matches"]:
            print(f"{m['cwd']}\t{m['folder']}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())

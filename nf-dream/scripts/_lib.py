"""Shared helpers for nf-dream scripts. No third-party deps."""
from __future__ import annotations

import json
import re
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
REGISTRY_PATH = SKILL_DIR / "references" / "slug-to-cwd.json"

TOP_RESERVED = {"name", "description", "created", "originSessionId", "last_read", "session_id"}
METADATA_KEYS = {"type", "project", "cwd", "tags", "related", "node_type", "status", "priority", "owner"}
SKIP_BASENAMES = {"MEMORY.md"}
HANDOFF_PATTERN = re.compile(r"^HANDOFF([-_].+)?\.md$", re.IGNORECASE)
SESSION_END_PATTERN = re.compile(r"^project_session_end_state_", re.IGNORECASE)


def load_registry() -> dict:
    if not REGISTRY_PATH.exists():
        return {"slugs": {}, "generic_cwd": str(Path.home() / ".claude")}
    try:
        return json.loads(REGISTRY_PATH.read_text())
    except json.JSONDecodeError:
        return {"slugs": {}, "generic_cwd": str(Path.home() / ".claude")}


def parse_frontmatter(text: str):
    """Return (frontmatter_lines, body, raw_fm_end_index) or None."""
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
    return lines[1:end], "\n".join(lines[end + 1:]), end


def extract_frontmatter_dict(fm_lines: list[str]) -> dict:
    """Flatten frontmatter into a dict. metadata.* keys flattened to 'metadata.X'."""
    out: dict[str, str] = {}
    in_md = False
    for line in fm_lines:
        if line.strip() == "":
            continue
        m_top = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        m_nested = re.match(r"^  ([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if m_top:
            key = m_top.group(1)
            val = m_top.group(2).strip()
            if key == "metadata":
                in_md = True
                continue
            in_md = False
            out[key] = val
        elif m_nested and in_md:
            out[f"metadata.{m_nested.group(1)}"] = m_nested.group(2).strip()
        elif not line.startswith(" "):
            in_md = False
    return out


def is_skippable(name: str) -> bool:
    return name in SKIP_BASENAMES


def iter_memory_files(scope: Path):
    """Yield *.md files in scope, excluding MEMORY.md and archive/."""
    for f in sorted(scope.glob("*.md")):
        if is_skippable(f.name):
            continue
        yield f


def file_size_kb(p: Path) -> float:
    return p.stat().st_size / 1024


def is_session_end(name: str) -> bool:
    return bool(SESSION_END_PATTERN.match(name))


def is_handoff(name: str) -> bool:
    return bool(HANDOFF_PATTERN.match(name))

#!/usr/bin/env python3
"""nf-dream backfill — tag metadata.project + metadata.cwd via 7-step pipeline.

5 steps are mechanical (run by this script). Steps 6 (LLM judge) and 7 (user override)
are deferred to the calling Claude session for low-confidence files.

Pipeline (precedence, first hit wins):
  1. Existing metadata.project           → skip (idempotent)
  2. Filename token match                → confidence 0.9 (with body path), 0.7 (filename only)
  3. Body absolute-path match            → 0.9 (with filename match), 0.7 (path only)
  4. Body URL/domain match               → 0.6
  5. originSessionId reverse-lookup      → 0.8
  6. metadata.type=user fallback         → 0.5 → "generic"
  7. LLM judge / user override            (deferred — confidence < 0.7 → action=defer)

Usage:
  backfill.py <scope> [--apply] [--json] [--include-cached-only]

  --apply  write metadata.project (+ optional metadata.cwd) to disk.
           Default is dry-run + emit plan.
  --include-cached-only
           when used per-project, still emit "cached_only" entries for other projects
           (default true; pass --no-cached-only to suppress).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import (  # noqa: E402
    extract_frontmatter_dict,
    iter_memory_files,
    load_registry,
    parse_frontmatter,
)
from resolve_cwd_from_session import resolve as resolve_session  # noqa: E402


def split_filename_tokens(name: str) -> list[str]:
    stem = name.removesuffix(".md")
    tokens = re.split(r"[_\-.]+", stem)
    return [t.lower() for t in tokens if t]


def find_filename_match(name: str, slugs: list[str]) -> str | None:
    tokens = set(split_filename_tokens(name))
    for slug in sorted(slugs, key=len, reverse=True):
        slug_tokens = set(re.split(r"[_\-.]+", slug.lower()))
        if slug_tokens.issubset(tokens):
            return slug
    return None


def find_body_path_match(body: str, slug_to_cwd: dict[str, str]) -> str | None:
    for slug, cwd in slug_to_cwd.items():
        if not cwd:
            continue
        if cwd in body:
            return slug
    return None


def find_body_url_match(body: str, slugs: list[str]) -> str | None:
    # Look for slug as a hostname token in URLs / domain references
    for m in re.finditer(r"https?://([a-z0-9.\-]+)", body, re.IGNORECASE):
        host = m.group(1).lower()
        for slug in slugs:
            host_keywords = set(re.split(r"[\-.]", host))
            slug_keywords = set(re.split(r"[\-.]", slug.lower()))
            if slug_keywords & host_keywords and len(slug) >= 4:
                return slug
    return None


def find_session_match(origin_session_id: str, slug_to_cwd: dict[str, str]) -> tuple[str | None, str | None]:
    """Returns (slug, cwd) from session reverse-lookup, or (None, None)."""
    if not origin_session_id:
        return None, None
    res = resolve_session(origin_session_id)
    if not res.get("ok"):
        return None, None
    cwd = res["matches"][0]["cwd"]
    # Match cwd to slug
    for slug, registered_cwd in slug_to_cwd.items():
        if registered_cwd == cwd:
            return slug, cwd
    # cwd resolved but no slug match — return cwd anyway for user inspection
    return None, cwd


def classify(name: str, body: str, fm_dict: dict, slug_to_cwd: dict[str, str]) -> dict:
    """Return classification result with project, cwd, confidence, signal, action."""
    # Step 1: already tagged
    if fm_dict.get("metadata.project"):
        return {
            "project": fm_dict["metadata.project"],
            "cwd": fm_dict.get("metadata.cwd", ""),
            "confidence": 1.0,
            "signal": "frontmatter",
            "action": "skip",
        }

    slugs = list(slug_to_cwd.keys())
    signals: list[str] = []
    candidates: list[tuple[str, float]] = []  # (slug, confidence)

    fn_match = find_filename_match(name, slugs)
    body_match = find_body_path_match(body, slug_to_cwd)
    url_match = find_body_url_match(body, slugs)
    session_id = fm_dict.get("originSessionId", "")
    session_slug, session_cwd = find_session_match(session_id, slug_to_cwd)

    if fn_match and body_match and fn_match == body_match:
        candidates.append((fn_match, 0.95))
        signals.append("filename+body_path")
    elif fn_match and body_match:
        # Disagreement — prefer body path (more specific)
        candidates.append((body_match, 0.75))
        signals.append("body_path (filename conflict)")
    elif fn_match:
        candidates.append((fn_match, 0.7))
        signals.append("filename")
    elif body_match:
        candidates.append((body_match, 0.7))
        signals.append("body_path")
    elif url_match:
        candidates.append((url_match, 0.6))
        signals.append("body_url")
    elif session_slug:
        candidates.append((session_slug, 0.8))
        signals.append("origin_session")

    # type=user fallback to generic
    if not candidates and fm_dict.get("metadata.type") == "user":
        candidates.append(("generic", 0.5))
        signals.append("type_user")

    if not candidates:
        return {
            "project": "",
            "cwd": session_cwd or "",
            "confidence": 0.0,
            "signal": "none",
            "action": "defer",
        }

    slug, conf = candidates[0]
    cwd = slug_to_cwd.get(slug, "") or session_cwd or ""
    action = "write" if conf >= 0.7 else "defer"

    return {
        "project": slug,
        "cwd": cwd,
        "confidence": conf,
        "signal": ", ".join(signals),
        "action": action,
    }


def inject_metadata(fm_lines: list[str], project: str, cwd: str) -> list[str]:
    """Insert metadata.project + metadata.cwd into existing frontmatter. Idempotent."""
    out: list[str] = []
    found_metadata = False
    md_emitted_extras = False
    i = 0
    while i < len(fm_lines):
        line = fm_lines[i]
        out.append(line)
        if line.strip() == "metadata:":
            found_metadata = True
            # Walk and inject after the last existing metadata key
            j = i + 1
            existing_keys: list[str] = []
            existing_block: list[str] = []
            while j < len(fm_lines) and (fm_lines[j].startswith(" ") or fm_lines[j].startswith("\t") or fm_lines[j].strip() == ""):
                existing_block.append(fm_lines[j])
                m = re.match(r"^  ([A-Za-z_][A-Za-z0-9_]*):", fm_lines[j])
                if m:
                    existing_keys.append(m.group(1))
                j += 1
            out.extend(existing_block)
            if "project" not in existing_keys and project:
                out.append(f"  project: {project}")
            if "cwd" not in existing_keys and cwd:
                out.append(f"  cwd: {cwd}")
            md_emitted_extras = True
            i = j
            continue
        i += 1

    if not found_metadata:
        # Append new metadata block at end of frontmatter
        out.append("metadata:")
        if project:
            out.append(f"  project: {project}")
        if cwd:
            out.append(f"  cwd: {cwd}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream backfill")
    parser.add_argument("scope")
    parser.add_argument("--apply", action="store_true", help="Write changes to disk (default: dry-run)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    registry = load_registry()
    slug_to_cwd = registry.get("slugs", {})

    plan = {"skip": [], "write": [], "defer": []}
    written = 0

    for f in iter_memory_files(scope):
        text = f.read_text()
        parsed = parse_frontmatter(text)
        if parsed is None:
            plan["defer"].append({
                "file": f.name,
                "reason": "no-frontmatter — backfill cannot add metadata.project without name/description",
                "confidence": 0.0,
            })
            continue
        fm_lines, body, _ = parsed
        fm_dict = extract_frontmatter_dict(fm_lines)
        result = classify(f.name, body, fm_dict, slug_to_cwd)
        entry = {
            "file": f.name,
            "project": result["project"],
            "cwd": result["cwd"],
            "confidence": round(result["confidence"], 2),
            "signal": result["signal"],
        }
        if result["action"] == "skip":
            plan["skip"].append(entry)
        elif result["action"] == "write":
            plan["write"].append(entry)
            if args.apply:
                new_fm = inject_metadata(fm_lines, result["project"], result["cwd"])
                new_content = "---\n" + "\n".join(new_fm) + "\n---\n" + body
                f.write_text(new_content)
                written += 1
        else:
            plan["defer"].append(entry)

    summary = {
        "scope": str(scope),
        "applied": args.apply,
        "total_files": sum(len(v) for v in plan.values()),
        "skip_already_tagged": len(plan["skip"]),
        "write_eligible": len(plan["write"]),
        "defer_low_confidence": len(plan["defer"]),
        "written": written,
    }

    if args.json:
        print(json.dumps({"summary": summary, "plan": plan}, indent=2))
        return 0

    print(f"nf-dream backfill — {scope}{' (APPLIED)' if args.apply else ' (dry-run)'}")
    print(f"  total:    {summary['total_files']}")
    print(f"  skip:     {summary['skip_already_tagged']} (already tagged)")
    print(f"  write:    {summary['write_eligible']}  (confidence >= 0.7)")
    print(f"  defer:    {summary['defer_low_confidence']}  (need LLM judge or user override)")
    if args.apply:
        print(f"  written:  {summary['written']}")
    print()
    if plan["write"]:
        print(f"## Write plan ({len(plan['write'])}):")
        by_project: dict[str, int] = {}
        for it in plan["write"]:
            by_project[it["project"]] = by_project.get(it["project"], 0) + 1
        for proj, n in sorted(by_project.items(), key=lambda x: -x[1]):
            print(f"  {proj}: {n}")
        print()
    if plan["defer"]:
        print(f"## Defer ({len(plan['defer'])}) — needs human/LLM:")
        for it in plan["defer"][:20]:
            print(f"  {it['file']}  (conf={it.get('confidence', 0)}, signal={it.get('signal', it.get('reason', ''))})")
        if len(plan["defer"]) > 20:
            print(f"  ... and {len(plan['defer']) - 20} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())

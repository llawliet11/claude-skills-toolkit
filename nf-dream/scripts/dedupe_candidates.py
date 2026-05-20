#!/usr/bin/env python3
"""nf-dream dedupe candidate pair generator.

NEVER auto-merges. Emits candidate pairs JSON for Claude session to judge + user
to confirm. Pairs are within the same bucket only (cross-bucket duplicates are rare
and high-risk to auto-merge).

Heuristic: filename-stem Levenshtein similarity > 0.6 OR first-heading keyword overlap >= 2 tokens.

Usage:
  dedupe_candidates.py <scope> [--project <slug>] [--json] [--threshold 0.6]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import parse_frontmatter  # noqa: E402


def run_classify(scope: Path, project: str | None) -> dict:
    cmd = [sys.executable, str(Path(__file__).parent / "classify.py"), str(scope), "--json"]
    if project:
        cmd += ["--project", project]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"classify.py failed: {result.stderr}")
    return json.loads(result.stdout)


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def stem_similarity(a: str, b: str) -> float:
    sa = a.removesuffix(".md")
    sb = b.removesuffix(".md")
    dist = levenshtein(sa, sb)
    longest = max(len(sa), len(sb)) or 1
    return 1.0 - dist / longest


def first_heading_tokens(scope: Path, filename: str) -> set[str]:
    path = scope / filename
    if not path.exists():
        return set()
    text = path.read_text()
    parsed = parse_frontmatter(text)
    body = parsed[1] if parsed else text
    for line in body.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            tokens = re.findall(r"[a-z][a-z0-9]+", line[2:].lower())
            stopwords = {"the", "and", "for", "with", "from", "into", "via"}
            return set(tokens) - stopwords
    return set()


def main() -> int:
    parser = argparse.ArgumentParser(description="nf-dream dedupe candidate pairs")
    parser.add_argument("scope")
    parser.add_argument("--project")
    parser.add_argument("--threshold", type=float, default=0.6)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    scope = Path(args.scope).expanduser().resolve()
    if not scope.is_dir():
        print(f"ERROR: {scope} is not a directory", file=sys.stderr)
        return 1

    classify_data = run_classify(scope, args.project)
    pairs: list[dict] = []
    for bucket, items in classify_data["buckets"].items():
        names = [it["file"] for it in items]
        for a, b in combinations(names, 2):
            sim = stem_similarity(a, b)
            tokens_a = first_heading_tokens(scope, a)
            tokens_b = first_heading_tokens(scope, b)
            heading_overlap = len(tokens_a & tokens_b)
            if sim >= args.threshold or heading_overlap >= 2:
                pairs.append({
                    "bucket": bucket,
                    "a": a,
                    "b": b,
                    "stem_similarity": round(sim, 2),
                    "heading_overlap_count": heading_overlap,
                    "shared_tokens": sorted(tokens_a & tokens_b)[:10],
                })

    pairs.sort(key=lambda p: -(p["stem_similarity"] + p["heading_overlap_count"] * 0.1))

    summary = {
        "scope": str(scope),
        "project": args.project,
        "threshold": args.threshold,
        "candidate_pair_count": len(pairs),
    }

    if args.json:
        print(json.dumps({"summary": summary, "pairs": pairs}, indent=2))
        return 0

    print(f"nf-dream dedupe candidates — {scope}")
    print(f"  threshold: {args.threshold}")
    print(f"  pairs found: {len(pairs)}")
    print()
    for p in pairs[:30]:
        print(f"  [{p['bucket']}] sim={p['stem_similarity']} overlap={p['heading_overlap_count']}")
        print(f"    A: {p['a']}")
        print(f"    B: {p['b']}")
        if p["shared_tokens"]:
            print(f"    shared: {', '.join(p['shared_tokens'])}")
        print()
    if len(pairs) > 30:
        print(f"  ... and {len(pairs) - 30} more pairs")
    return 0


if __name__ == "__main__":
    sys.exit(main())

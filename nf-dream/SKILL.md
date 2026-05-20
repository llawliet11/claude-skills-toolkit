---
name: nf-dream
description: "Memory consolidation for Claude session memory — reads files under the project's configured memory folder (resolved via `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` in `.claude/settings.local.json`, with fallbacks to user-scope settings and the documentation-mirror `autoMemoryDirectory` field), auto-scopes to the current project (via `--project <slug>` or cwd basename), classifies each as Now / Next / Done / Future / Reference / Stale, and (optionally) normalizes legacy frontmatter shape, reorganizes `MEMORY.md`, writes a 1-pager `HANDOFF-<slug>.md`, consolidates aged session-end states into `archive/`, dedupes overlapping topics, surfaces stale memories, backfills `metadata.project` to existing files, lints health, or rolls back the last consolidate. Inspired by similar memory-consolidation systems but operates on filesystem memory, not a database. Slash trigger `/nf-dream [mode] [--project <slug>] [--no-generic]`. Modes: `preview` (default, read-only), `normalize`, `reorganize`, `handoff`, `consolidate`, `dedupe`, `stale`, `lint`, `rollback`, `full`, `backfill`, `translate`. Always project-scoped except `lint` / `normalize` / `backfill` which operate folder-wide. Dry-run by default, never deletes, snapshots before writing."
disable-model-invocation: true
---

# nf-dream — Claude Memory Consolidation

Memory consolidation skill for `~/.claude/memory/<scope>/`. The goal: after running, a fresh Claude session should be able to open the project and know — within 30 seconds — what is **done**, what is **next**, what is **in progress**, what is **future**, and what is **stale**.

Conceptually analogous to memory-consolidation systems that cluster knowledge entries, synthesize durable patterns, and soft-archive sources, but operates on **filesystem memory files** instead of database rows, and uses the **running Claude session itself** as the judge (no extra LLM API key required).

## When NOT to invoke

- The current project has no memory folder configured (no `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` in `.claude/settings.local.json`, no fallback in user-scope settings, and no `autoMemoryDirectory` anywhere). Tell the user to run `/nf-memory` first to set up a memory folder (the companion `nf-memory` skill in this toolkit handles that, or it can be set manually).
- The resolved memory folder contains fewer than 5 `*.md` files (excluding `MEMORY.md`). Not enough signal — say so and stop.
- The user is mid-debug on a live system (prod monitoring, log tailing). Ask first; consolidation is non-urgent.

## Scope resolution — fallback chain

The Claude Code binary reads `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` with highest priority. The top-level `autoMemoryDirectory` field at `localSettings` scope is silently ignored by the binary (only `userSettings` / `policySettings` / `flagSettings` honor it), but the companion `nf-memory` skill writes it anyway as a documentation mirror of the env value (so humans inspecting `settings.local.json` see the path clearly). This skill therefore tries multiple locations in order, preferring the canonical env field, and falls back to the mirror field when the env one is absent (which signals a partial / pre-nf-memory state worth warning about).

Resolve in this order — first hit wins:

1. **`env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` in `<cwd>/.claude/settings.local.json`** (new canonical location). Parse with `jq`:
   ```bash
   jq -r '.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE // empty' "<cwd>/.claude/settings.local.json"
   ```
2. **Top-level `autoMemoryDirectory` in `<cwd>/.claude/settings.local.json`** (documentation mirror, only used as fallback when env field is missing). Reaching this step means `nf-memory` either ran on an older version or the env field was hand-removed — emit a one-line warning: `"autoMemoryDirectory found but env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE missing — partial config, run /nf-memory to sync both fields"`, then use the value.
   ```bash
   jq -r '.autoMemoryDirectory // empty' "<cwd>/.claude/settings.local.json"
   ```
3. **`env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, then `autoMemoryDirectory`, in `~/.claude/settings.json`** (user scope — the binary still honors `autoMemoryDirectory` at this scope):
   ```bash
   jq -r '.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE // .autoMemoryDirectory // empty' "$HOME/.claude/settings.json"
   ```
4. **`process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`** — set via wrapper script outside settings (rare, but supported by the binary's resolver too).
5. **Binary default**: `~/.claude/projects/<sanitized-cwd>/memory/` where `<sanitized-cwd>` is the absolute cwd with `/` replaced by `-` and a leading `-` prepended. Example: cwd `/Users/me/projects/example-blog` → `~/.claude/projects/-Users-me-projects-example-blog/memory/`.

Then:

- Expand `~/` to `$HOME` if present. The env var itself does NOT expand `~/`, but values pulled from settings JSON may use it as a convention — normalize to absolute.
- If a value resolved but the directory does not exist on disk, or it exists but has no `MEMORY.md` AND < 5 `*.md` files → STOP, instruct user to run `/nf-memory` (the folder isn't initialized).
- If NOTHING resolved across all five steps → STOP, instruct user to run `/nf-memory`.
- If the path exists but has < 5 `*.md` files → STOP with a one-line reason ("not enough signal to consolidate").

The skill operates ONLY on this one folder. It does NOT cross into sibling memory folders (e.g. running in `team-a/` will not touch `team-b/`).

## Project-aware filtering (default behavior)

Shared scope folders often mix multiple projects (a `personal/` folder might mix blog, infra, and portfolio notes; a team folder might mix 6+ projects). **Every semantic-write run is auto-scoped to one project**. There is no folder-wide escape hatch for semantic operations — refactoring an entire shared scope's content at once is too risky.

Three modes are explicit folder-wide exceptions, by design:
- `lint` — read-only health check.
- `normalize` — mechanical shape compliance (move misplaced keys + add type from filename prefix). No content classification.
- `backfill` — prompts the user to pick scope (default: current project only). Wider scope is opt-in per run.

### Slug resolution (in order)

1. **`--project <slug>` flag** — use this slug explicitly.
2. **Auto-detect from cwd** — `basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"`. If cwd is inside a worktree (`.claude/worktrees/<branch>`), walk up to the real toplevel.
3. **AskUserQuestion fallback** — if neither flag nor auto-detect produces a valid slug (no git toplevel + pwd is home / unrelated), prompt user with the list of slugs currently tagged in the cache + `Enter new slug`. Refuse to proceed without a slug.

After resolution: AskUserQuestion confirm `"Project detected: <slug>. Filter run to this project + generic memories?"` on first run of every session, so the user can catch a wrong auto-detect early. Skip confirm if `--project` was passed explicitly.

### Source of truth for `(file → project)` mapping

For each `*.md` file in scope, the skill resolves its project tag via this precedence:

1. **`metadata.project` in file's frontmatter** — authoritative. Set by the host setup's memory-frontmatter rule when Claude saves new memories.
2. **`<scope>/.nf-dream/project-tags.json` cache** — if frontmatter missing, check cache (invalidate when file mtime > cache `judged_at`).
3. **Pre-classify pipeline** — if neither, compute on the fly:
   1. Filename token match: split basename on `_`, check if slug appears.
   2. Body absolute-path match: `/Users/.../<slug>/...` or `/home/.../<slug>/...` in body.
   3. Body URL/domain match: domain containing slug.
   4. `originSessionId` reverse-lookup: glob `~/.claude/projects/*/<sessionId>.jsonl`, decode cwd, take basename.
   5. `metadata.type: user` fallback → `["generic"]` (user-profile memory is by definition cross-project).
   6. LLM judge (running Claude session reads body, emits `{projects: [...], confidence}`).
   7. User override via AskUserQuestion if confidence < 0.7.

Write the resolved tags back to `metadata.project` in the file's frontmatter when running `backfill` mode (one-time backfill). Other modes only update the cache, not the file.

### Cache schema `<scope>/.nf-dream/project-tags.json`

```json
{
  "version": 1,
  "files": {
    "project_example_blog.md": {
      "projects": ["example-blog"],
      "confidence": 1.0,
      "signal": "frontmatter|filename_match|body_path|body_url|origin_session|type_user|llm_judge|user_override",
      "mtime": "2026-05-18T02:40:00Z",
      "judged_at": "2026-05-18T12:00:00Z"
    }
  }
}
```

`projects` is an array — a file may belong to multiple projects (rare) or to `["generic"]` (cross-project). Filter logic: include file if `slug ∈ projects` OR `"generic" ∈ projects`. Default behavior; can be tightened with `--no-generic` to require exact slug match.

### Filter application

Once mapping resolved, the scope file list = files tagged for current slug (+ generic). Files NOT in scope are excluded from EVERY operation: classification buckets, MEMORY.md rewrite, HANDOFF.md synthesis, archive plan, dedupe pairs, etc. Out-of-scope files stay untouched on disk.

**Exception**: `lint` mode always runs folder-wide (read-only health check, no destructive action). It reports per-file issues including stale `metadata.project` tags.

### Mode-specific filter behavior

- **`preview`**: report shows ONLY filtered files. Top banner notes "<X> of <Y> files in scope for project '<slug>'".
- **`reorganize`**: writes filtered files into a `## Project: <slug>` section of `MEMORY.md`. Other projects' existing entries in MEMORY.md remain untouched in original positions.
- **`handoff`**: output goes to `<scope>/HANDOFF-<slug>.md` (NOT folder-wide `HANDOFF.md`) so multiple project handoffs can coexist.
- **`consolidate`** / **`stale`**: only filtered files become archive candidates.
- **`dedupe`**: pairs are formed within filtered files only — won't detect cross-project dupes (user accepts this trade-off).
- **`backfill`**: scope picked by user via `AskUserQuestion` at start of run. Default option = current project only (recommended). Other options: all files in folder, specific projects multi-select, cancel. Default first in option list.
- **`normalize`**: folder-wide (exception). Mechanical shape fixes only, no project classification.
- **`lint`**: folder-wide (exception).
- **`full`**: applies filter throughout (= filtered reorganize + filtered consolidate + filtered handoff). Does NOT include `translate`.
- **`translate`**: only filtered files are translated; rest untouched.
- **`rollback`**: full tarball restores are folder-wide regardless of filter (tarball captures whole folder). Per-batch un-archive honors filter.

## Arguments

`/nf-dream [mode] [--project <slug>] [--no-generic]`

Positional `mode`:

- (no arg) → `preview`
- `preview` | `normalize` | `reorganize` | `handoff` | `consolidate` | `dedupe` | `stale` | `lint` | `rollback` | `full` | `backfill` | `translate`

Flags:

- `--project <slug>` — override auto-detect from cwd. Use when running from a folder whose basename doesn't match the desired project, or when targeting a project not in current cwd.
- `--no-generic` — strict: filter to exact slug only, exclude `["generic"]`-tagged files. Default is to include generic.

Any other value → reject with the list of allowed modes and flag usage.

## Classification heuristics (no LLM call needed)

For every `*.md` file under the scope (excluding `MEMORY.md`, `HANDOFF.md`, anything inside `archive/`), assign exactly one bucket:

| Bucket | Signals (any) | Examples |
|---|---|---|
| **Now** | Filename has latest `project_session_end_state_*` AND mtime within 7 days; OR `MEMORY.md` index line marked `**START HERE**`; OR body contains unresolved `Pending` / `Open` / `Queued for next session` |
| **Next** | Body has section labeled `Next session` / `TODO` / `Queued` and items NOT struck through |
| **Done** | Body has `SHIPPED` / `COMPLETE` / `DONE` / `MERGED` AND mtime older than 7 days, no `Pending`/`Open` |
| **Future** | Body has `FUTURE WISHLIST` / `DEFERRED` / `BLOCKED BY` / `Wishlist` |
| **Reference** | Filename starts with `reference_` OR body has `(canonical|stable reference)` marker |
| **Stale** | Body says `obsolete`/`superseded by`/`mostly obsolete`/`legacy` OR mtime > 60 days AND filename NOT referenced in any `Now` bucket file |

**Tie-breaking:** Now > Next > Future > Done > Reference > Stale (i.e. an unresolved `Pending` overrides a `SHIPPED` marker — the file is still Now).

**Per-file LLM judge** (used by `consolidate`, `dedupe`, `stale`): when ambiguous, the running Claude session reads the full file content and answers a binary question — `still load-bearing?` (for stale/consolidate) or `same topic as <other>?` (for dedupe). The judge is the current session, not an external API call.

## Safety rules (apply to ALL write modes)

1. **Dry-run preview first.** Every write mode shows a plan + uses `AskUserQuestion` to confirm before any file changes.
2. **Full tarball snapshot before ANY write.** First action of every write mode (after user confirms intent, before any `mv` / `Write` / `Edit`):
   ```bash
   STAMP=$(date +%Y%m%d-%H%M%S)
   tar -czf <scope>/.snapshots/full-<STAMP>.tar.gz -C <scope> \
     --exclude='.snapshots' --exclude='archive' .
   ```
   This captures EVERY `*.md` in the scope (including `MEMORY.md`, `HANDOFF.md`, and every memory file) at one consistent timestamp. Rollback from this tarball is always possible, even if a per-file `mv` failed mid-batch.
3. **Per-file snapshot for index files.** Before overwriting `MEMORY.md` or `HANDOFF.md`, also copy current version to `<scope>/.snapshots/MEMORY.md-<STAMP>` (and same for `HANDOFF.md`) — quick standalone restore without untarring.
4. **Never `rm`.** Files only get `mv`'d into `<scope>/archive/YYYY-MM/`. Leave `<scope>/archive/README.md` breadcrumb.
5. **Snapshot retention 14 days for tarballs, 7 days for per-file.** At end of every write mode:
   ```bash
   find <scope>/.snapshots -name 'full-*.tar.gz' -mtime +14 -delete
   find <scope>/.snapshots -name 'MEMORY.md-*' -mtime +7 -delete
   find <scope>/.snapshots -name 'HANDOFF.md-*' -mtime +7 -delete
   ```
6. **No cross-scope writes.** Only touch files under the resolved scope folder.
7. **Atomic-ish:** if any step fails mid-write, do NOT continue. Surface error + the tarball path so user can extract to restore: `tar -xzf <scope>/.snapshots/full-<STAMP>.tar.gz -C <restore-dir>`.
8. **Refuse if working tree dirty in memory submodule.** If `<scope>` is inside a git submodule (a common pattern when you want memory tracked separately from your dotfiles repo), run `git -C <scope> status --short` first. If output non-empty, STOP and ask the user to commit/stash existing memory edits before consolidating.
9. **Print tarball path to user** after every successful write run: `Backup: <scope>/.snapshots/full-<STAMP>.tar.gz` so they can save it elsewhere if they want longer retention than 14d.

## Mode: preview (default, read-only)

The default and the one to start with. **Honors project filter** (see Project-aware filtering).

1. Resolve scope + project slug. Refuse if fewer than 5 files in scope (filtered).
2. List all `*.md` files matching filter. For each, read first ~80 lines (enough to detect markers).
3. Classify into 6 buckets via heuristics above.
4. Compute summary stats: total filtered file count, bucket counts, oldest mtime in each bucket, current `MEMORY.md` size in KB.
5. Print to chat:

   ```
   nf-dream preview — <scope> — project: <slug>
   ──────────────────────────────────────
   Scope: <X> of <Y> files (filtered to project '<slug>' + generic)
   MEMORY.md: M KB    archive/: K files
   
   ## Now (load-bearing — read these first)
   - <filename>  (<mtime>, <reason marker>)
   ...
   
   ## Next (queued work)
   - ...
   
   ## Done (completed, may be archivable)
   - ...
   
   ## Future (wishlist / deferred)
   - ...
   
   ## Reference (canonical, leave alone)
   - ...
   
   ## Stale (candidates for archive / removal)
   - ...
   
   ## Health
   - MEMORY.md size: <kb>      (warn if > 20KB)
   - Files > 30KB: <count>     (warn if any)
   - Broken MEMORY.md links: <count>
   - Files missing frontmatter: <count>
   ```

6. End with: "Run `/nf-dream reorganize`, `/nf-dream handoff`, `/nf-dream consolidate`, or `/nf-dream full` to act on this."

No writes, no AskUserQuestion. Just report.

## Mode: normalize

**Folder-wide structural frontmatter compliance.** Brings legacy memory files in line with the canonical frontmatter shape (see `references/filename-prefix-to-type.md`), without classifying project/cwd content.

Three responsibilities (idempotent; re-running produces no further changes):

1. **Move misplaced top-level keys** (`type:` / `project:` / `cwd:` / `tags:` / `related:` written at top level) into the `metadata:` block. Top level is reserved for binary auto-injected fields (`name`, `description`, `created`, `originSessionId`, `last_read`); putting metadata keys there risks collision and is silently ignored by some tooling.
2. **Add `metadata.type`** from filename prefix per `references/filename-prefix-to-type.md` (`project_*` → project, `feedback_*` → feedback, `reference_*` → reference, `user_*` → user, `handoff*` / `plan-*` → project). Files without a recognized prefix are surfaced for manual fix; nothing inferred.
3. **Add `metadata.cwd`** from `references/slug-to-cwd.json` IF `metadata.project` is already set and `metadata.cwd` is missing. Does NOT classify `metadata.project` itself — that's `backfill`'s job. Division of labor: `normalize` handles shape, `backfill` handles semantic project assignment.

### Why a separate mode from `backfill`

`backfill` is per-project (auto-scope + AskUserQuestion picks) because writing `metadata.project` to the wrong file is hard to detect after the fact. `normalize` is folder-wide because moving a top-level `type:` into `metadata:` and adding `type: project` from a `project_*.md` prefix are mechanical, low-risk operations — there's no judgment call to get wrong.

If user wants both: run `normalize` first (mechanical cleanup), then `backfill` per-project (semantic classification).

### Implementation

The mode delegates to `scripts/normalize.py`:

```bash
python3 ~/.claude/skills/nf-dream/scripts/normalize.py <scope> [--dry-run] [--json]
```

The script reads `references/slug-to-cwd.json` for cwd lookups and the prefix table is hard-coded (matches `references/filename-prefix-to-type.md`).

### Flow

1. Resolve scope folder (per "Scope resolution — fallback chain"). Refuse `--project` flag — normalize is folder-wide; passing `--project` is an error with a one-line note about backfill.
2. Refuse if memory submodule has uncommitted changes (per Safety rules — same rule as other write modes).
3. Run `scripts/normalize.py <scope> --dry-run --json` to compute the plan.
4. Print human-readable summary of the plan: per-file action counts (`moved-top:N`, `added-type:M`, `added-cwd:K`), plus list of files that need manual fix (no frontmatter, or no recognized prefix and missing type).
5. `AskUserQuestion` (header `Apply normalize`, single-select): `"Apply N normalizations across <scope>?"` — `Yes, apply` / `Show full diff (first 30 files)` / `Cancel`.
6. On `Show full diff`: pipe through a per-file action list capped at 30 rows, then re-confirm.
7. On `Yes, apply`: full tarball snapshot per Safety rules, then run `scripts/normalize.py <scope>` without `--dry-run`. Print `Backup: <tarball-path>` + count summary.
8. Snapshot retention sweep.

### Limitations

- Does NOT write `metadata.project` — files without a project tag remain untagged. Run `backfill` to tag them.
- Does NOT infer `metadata.type` for files without a recognized prefix (`auth-jwt-trust-model.md`, `obsidian-graph-spec.md`, etc.). They appear in the report's `--needs-manual-type` list.
- Skips `MEMORY.md` and any file matching `archive/**`.
- Trying to normalize a scope with files that have no frontmatter at all surfaces them in the report (`no-frontmatter` status) but does NOT auto-inject — that requires a human picking name + description (manual `Write` / `Edit`).

## Mode: reorganize

Rewrite `MEMORY.md` so entries for the current project are grouped by bucket. Does NOT move any file under the scope. **Honors project filter** — only filtered files are touched; other projects' entries in MEMORY.md remain in their original positions.

1. Run `preview` classification internally (don't re-print the full report, just compute buckets for filtered files).
2. Read current `MEMORY.md`. Parse existing lines (`- [Title](file.md) — hook`) into a map keyed by file path. Separate into `in_scope` (current project) and `out_of_scope` (everything else).
3. For files that have a current entry: preserve the title + hook exactly. For files that don't: synthesize a one-line hook from the file's first heading or frontmatter description (max 150 chars).
4. Compose new `MEMORY.md`:

   ```markdown
   # Memory Index
   
   ## Project: <slug>
   
   ### Now
   - [Title](file.md) — hook
   ...
   
   ### Next
   ...
   
   ### Done / Future / Reference / Stale
   ...
   
   ## Other projects (unchanged)
   <out_of_scope entries in their original order>
   ```

5. Show the user the new structure as a preview (file counts per section, no full content). Highlight which slug section is being rewritten.
6. `AskUserQuestion` (header `Apply reorganize`, single-select): `"Apply rewrite of project '<slug>' section in MEMORY.md? (snapshot will be saved)"` — options `Yes, apply` / `No, cancel`.
7. On Yes: snapshot existing `MEMORY.md`, write new content.
8. Run snapshot retention sweep.

## Mode: handoff

Produce `<scope>/HANDOFF-<slug>.md` — a single-page "what next" file for the current project, optimized for a fresh session to load instantly. Replace-on-each-run (snapshot retained 7d). **Honors project filter** — output file is per-slug so multiple project handoffs coexist.

1. Run classification on filtered files only.
2. Read the FULL content of every filtered file in the `Now` bucket and the top section of every filtered `Next` bucket file.
3. The current Claude session synthesizes — no external API call. Compose `HANDOFF-<slug>.md`:

   ```markdown
   # Handoff — <slug> — <date>
   
   ## TL;DR (3 lines max)
   <2-3 sentence summary of project state>
   
   ## In progress / Pending
   - <item> — source: [file.md](file.md)
   
   ## Next session should
   - <action> — context: [file.md](file.md)
   
   ## Recently shipped (last 7 days)
   - <one-liner>
   
   ## Open questions / blockers
   - <question> — source: [file.md](file.md)
   
   ## Pointers
   - START HERE: [latest session-end](file.md)
   - Project rules: [CLAUDE.md if exists, else skip]
   ```

4. AskUserQuestion confirm. On Yes: snapshot prior `HANDOFF-<slug>.md` (if exists), write new.
5. Cap the file at ~120 lines / ~6KB. If the synthesis overflows, trim "Recently shipped" first, then "Pointers".

`HANDOFF-<slug>.md` is intended as the file a future session for this project reads FIRST. The skill output should make that obvious. Multiple projects in the same scope folder produce coexisting `HANDOFF-example-blog.md`, `HANDOFF-example-portfolio.md`, etc.

## Mode: consolidate

Move aged session-end states into `<scope>/archive/YYYY-MM/`. Uses Claude session per-file judge.

**Honors project filter** — only filtered files become candidates. Cross-project session-end states are NOT touched.

1. Run classification on filtered scope. Build list of candidates:
   - All filtered files matching `project_session_end_state_*.md` with mtime > 14 days, OR
   - All filtered files in the `Stale` bucket.
2. For each candidate, read full content. Ask the running Claude session: `"Is this file still load-bearing for the project (would a future session need to read this to make decisions today)?"` — answer Y/N + 1-line reason.
   - This is internal reasoning, NOT a user prompt. The skill instructs the session to do the judgment in-context.
3. Build move plan: `{ keep: [...], archive: [...] }`. For each archive entry, target path = `<scope>/archive/<YYYY-MM derived from filename or mtime>/<original-name>`.
4. Show the user:

   ```
   Consolidate plan:
   - Move 7 files to archive/2026-04/
   - Move 3 files to archive/2026-05/
   - Keep 4 files in main scope (still load-bearing)
   ```

5. AskUserQuestion `"Proceed with archive moves? (originals will be in archive/, breadcrumb in archive/README.md)"` — `Yes` / `Show full list` / `Cancel`.
6. On `Show full list`: print the full source → target table, ask again.
7. On Yes: snapshot `MEMORY.md`, create `<scope>/archive/<YYYY-MM>/` dirs as needed, `mv` each file, append entry to `<scope>/archive/README.md` (one line per move: `2026-05-17: project_session_end_state_2026_05_14.md → archive/2026-05/project_session_end_state_2026_05_14.md`).
8. Update `MEMORY.md`: remove archived entries from main index, add a single line `- [Archive](archive/README.md) — N session-end states moved` if not already there.
9. Snapshot retention sweep.

**Reversible:** every move is logged in `archive/README.md` with original path. Use `rollback` to undo.

## Mode: dedupe

Find files that overlap in topic and propose merging. NEVER auto-merges — always uses AskUserQuestion per pair. **Honors project filter** — pairs are formed within filtered files only. Cross-project duplicates (e.g. same fact written for two different projects) are NOT detected; user accepts this trade-off as it's rare and folder-wide dedupe is too risky.

1. Run classification on filtered scope.
2. Build candidate pairs from filtered files only:
   - Files in the same bucket (Now ∩ Now, Done ∩ Done, etc.) with filename similarity > 60% (Levenshtein on stem) OR with overlapping topic keywords in first heading.
3. For each pair, the Claude session reads both and judges: `"Same topic? If yes, which file should be the canonical destination?"`.
4. For each pair flagged as "same topic", AskUserQuestion (per pair, header `Merge?`, options):
   - `Merge A into B (B becomes canonical, A moves to archive)`
   - `Merge B into A (A becomes canonical, B moves to archive)`
   - `Different topics — skip`
   - `Cancel dedupe`
5. On merge: the Claude session writes a consolidated version of the canonical file (preserving both sources' load-bearing content). Snapshot the canonical first. Move the absorbed file to `archive/YYYY-MM/`. Append breadcrumb.
6. Update `MEMORY.md` to drop the absorbed entry, keep canonical entry (re-write its hook if needed).

## Mode: stale

Surface stale candidates without writing anything destructive. User decides per file. **Honors project filter** — only filtered files are evaluated.

1. Run classification on filtered scope. Take `Stale` bucket only.
2. For each, the Claude session double-checks: `"Is this truly stale, or is the 'obsolete' marker misleading (e.g. the file is meta-discussion of why something is obsolete, which is itself load-bearing)?"`.
3. Print a table: `file | mtime | reason flagged | session's verdict`.
4. AskUserQuestion (multi-select, header `Mark stale`):
   - List each file. User checks the ones they confirm as stale.
5. For each confirmed: same as consolidate (move to `archive/YYYY-MM/`, breadcrumb, update `MEMORY.md`).

## Mode: lint

Health check, no writes. **Folder-wide exception** — reports issues across the entire scope folder regardless of project filter, since lint is read-only and finds problems that span projects (orphan files, broken cross-links, stale cache entries).

1. Resolve scope.
2. Delegate the structural checks to `scripts/lint.py <scope>`. The script reports:
   - `MEMORY.md` size > 20 KB → warn (recommend `/nf-dream reorganize`).
   - Any file > 30 KB → warn (suggest split).
   - `MEMORY.md` lines that link to a file that doesn't exist (broken link).
   - Files that exist on disk but have no `MEMORY.md` entry.
   - Files missing YAML frontmatter (`---\nname: ...\n---`).
   - Files missing `name` / `description` at top level.
   - Files missing `metadata.type` / `metadata.project` / `metadata.cwd` (recommend `/nf-dream normalize` for type/cwd, `/nf-dream backfill` for project).
   - **Files with misplaced top-level keys** (`type:` / `project:` / `cwd:` / `tags:` / `related:` written at top instead of under `metadata:` — recommend `/nf-dream normalize`). Common in legacy memory files written before the canonical frontmatter rule landed.
   - `archive/README.md` entries pointing to files that no longer exist.
3. Skill-level extra checks (not in script):
   - `[[wikilink]]` references in any file pointing to a slug that doesn't exist.
   - `.nf-dream/project-tags.json` cache entries with stale mtime (file changed since cache `judged_at`).
   - `.nf-dream/project-tags.json` cache entries pointing to files that no longer exist.
4. Print findings grouped by category, with per-project counts where applicable. End with one-line recommendation per finding.

## Mode: rollback

Undo a previous `consolidate` / `dedupe` / `reorganize` / `handoff` / `full` run. Two strategies depending on what's available:

### Strategy A — full tarball restore (preferred, always works)

1. List `<scope>/.snapshots/full-*.tar.gz` sorted by mtime descending.
2. Show user the list with timestamps + tarball size.
3. AskUserQuestion: `"Restore which tarball? (current state will be moved to <scope>/.snapshots/pre-rollback-<NOW>.tar.gz first)"` — options = up to 4 most recent tarballs + `Cancel`.
4. On pick: tar the CURRENT state first (so the rollback itself is reversible), then extract the chosen tarball back into `<scope>/` (overwriting). Files that were created AFTER the snapshot (new memory written by user in the meantime) are preserved if their filenames don't collide with snapshot contents — extract uses `--keep-newer-files` flag.

### Strategy B — per-batch un-archive (faster, granular)

1. Read `<scope>/archive/README.md`. Find the most recent batch of moves (entries with the same date prefix).
2. Show: `"Last batch: 7 files moved on 2026-05-17. Un-archive only? (Strategy B)"`
3. AskUserQuestion confirm.
4. On Yes: for each file in the batch, `mv archive/YYYY-MM/<file>.md <scope>/<file>.md`. Remove those lines from `archive/README.md`.
5. Restore `MEMORY.md` from matching `<scope>/.snapshots/MEMORY.md-<stamp>` if available, else leave as-is.

### Picking the strategy

If both are available, AskUserQuestion: `"Full tarball restore (everything → snapshot state) or per-batch un-archive (only un-move files)?"`. Full tarball is safer for major undo; per-batch is granular for "I accidentally archived one too many".

Cannot rollback further than 14 days for tarball, 7 days for MEMORY.md-only snapshot.

## Mode: backfill

Tags `*.md` files in the scope folder with `metadata.project` (+ `metadata.cwd` if derivable). Brings existing memory up to a consistent format with project tagging. After backfill, filter on subsequent runs works reliably.

**Scope is picked by user at start, NOT folder-wide by default.** The default option is "current project only" — most runs should stay narrow.

### Step 1 — pick scope via AskUserQuestion

After resolving the current project slug (from cwd or `--project <slug>`), ask:

```
Backfill scope?
  ▢ Current project only: <slug>     (Recommended)
  ▢ All files in folder (<N> files)
  ▢ Specific projects (multi-select)
  ▢ Cancel
```

Default option = current project only. Listed first so a fast confirm tags only files belonging to `<slug>`.

- **Current project only**: pre-classify pipeline runs on all files in folder, but `metadata.project` is written ONLY to files whose pipeline result matches `<slug>` (or `generic`). Files belonging to other projects are CACHED (so they appear in cache for future runs) but NOT mutated on disk. User runs backfill again from each project's cwd to progressively tag the whole folder.
- **All**: write `metadata.project` to every file regardless of which slug the pipeline picks. One-shot full tag. Use only when user is confident about the folder layout.
- **Specific projects**: multi-select list of slugs detected during pre-classify. Write `metadata.project` only to files matching the picked slugs.
- **Cancel**: stop without snapshot, no writes.

### Step 2 — pre-classify pipeline

For each `*.md` file (excluding `MEMORY.md`, `HANDOFF*.md`, `archive/`):

1. If frontmatter already has `metadata.project` → skip (idempotent).
2. Else run the 7-step pre-classify pipeline from "Project-aware filtering" (filename match → body path → body URL → originSessionId → type fallback → LLM judge).
3. Confidence < 0.7 → defer to user override at step 4.

### Step 3 — show plan

Build the write plan based on chosen scope:

```
Backfill plan — <scope> — scope: <Current project | All | Specific>
──────────────────────────────────────
Skipped (already tagged):       N files
Will write metadata.project:    M files
  - example-blog: 12
  - generic: 4 (cross-project memories included with current project scope)
Cached only (other projects):   X files          [only shown for "Current project only"]
  - example-portfolio: 1
  - example-infra: 6
Needs user override (conf<0.7): K files
```

### Step 4 — user override for low-confidence files

For each of the K low-confidence files, AskUserQuestion (per file, multi-select tag): list all known slugs + `Enter new slug` + `Mark generic` + `Skip this file`. Claude session pre-fills the most likely candidate.

### Step 5 — final confirm

`AskUserQuestion`: `"Write metadata.project to N files? (snapshot will be saved)"` — `Yes, write` / `Show full table` / `Cancel`. On `Show full table`: print full file → projects table capped at 30 rows + truncation note, then re-confirm.

### Step 6 — write

1. Full tarball snapshot (per Safety rules).
2. For each file in the write plan:
   - Read frontmatter using a YAML parser that preserves key order.
   - Inject `metadata.project: <slug-or-array>`. If multiple slugs, write as YAML array.
   - Inject `metadata.cwd: <absolute-path>` if derivable from `originSessionId` reverse-lookup OR if the slug maps unambiguously to a known cwd from `references/slug-to-cwd.json`. Skip otherwise.
   - Preserve body verbatim. Do NOT re-flow YAML beyond inserting the new keys.
3. Update `<scope>/.nf-dream/project-tags.json` cache with the FULL pipeline output — including cached-only entries (other projects) when scope = "Current project only". Cache is always populated for every classified file, even those not written to disk.
4. Snapshot retention sweep.
5. Print per-slug count summary + `Backup: <tarball-path>`. For "Current project only" scope, end with a hint: `Tip: run /nf-dream backfill again from another project's cwd to tag the remaining X cached files.`

### Idempotency & re-runs

Re-running backfill skips files where `metadata.project` already exists. To force re-tagging, the user must manually delete `metadata.project` from the file's frontmatter first. Re-running with the same scope just refreshes the cache for unchanged files (no-op writes). Re-running with a wider scope picks up files skipped by the previous run.

### Safety

Backfill mutates frontmatter on many files at once. Snapshot before, confirm before, never auto-merge with another write mode in the same run. Reject if the parent submodule has uncommitted changes.

## Mode: full

Equivalent to running:

1. `preview` (print report).
2. `AskUserQuestion`: `"Proceed with reorganize + consolidate + handoff?"` — single confirm, then run all three sequentially using the classification already computed.

Use this as the one-shot "tidy up memory" command. Each sub-step still snapshots independently. Honors project filter throughout. Does NOT include `normalize` or `backfill` — those are folder-wide and write to a different surface (frontmatter shape vs project tagging). Run them separately if needed: `/nf-dream normalize` first (mechanical), then `/nf-dream backfill` (per-project), then `/nf-dream full` (reorganize + consolidate + handoff).

## Mode: translate

Translate non-English memory content into English so the description-based relevance ranking works better in future sessions. **Honors project filter** — only filtered files are touched. Verbatim user quotes and locale-specific named entities are preserved.

Not part of `/nf-dream full` — opt-in only, because semantic transformation deserves explicit invocation.

### Pre-scan

For each filtered `*.md` file (excluding `MEMORY.md`, `HANDOFF*.md`, `archive/`), count lines containing non-ASCII characters that indicate non-English content. The shipped detection targets Vietnamese diacritics; adapt to your own language by editing `scripts/translate_prescan.py`:

```bash
grep -cE "[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀ-Ỹ]" "$f"
```

Bucket per file:

- `none` — 0 non-English lines → skip
- `light` — 1–2 non-English lines → skip by default (likely proper noun or single quote)
- `mixed` — 3+ lines but < 20% of file
- `heavy` — ≥ 20% of lines

`mixed` and `heavy` are candidates.

### Plan + confirm

Show plan with counts per bucket. `AskUserQuestion`: `"Translate <N> files? Snapshot saved. Verbatim quotes and locale-specific entities preserved."` — `Yes, translate all` / `Show file list` / `Pick files (multi-select)` / `Cancel`.

### Translation rules

Per file picked:

- Preserve YAML frontmatter structure and key order. Translate only `description` if it has non-English content. Leave `name`, `metadata.tags`, slug-like values alone.
- Translate body prose into terse, technical English. Preserve code blocks, paths, URLs, identifiers verbatim.
- Preserve original content when:
  - Line is a blockquote (`> `) or attributed quote (`User said:`, etc.).
  - Token is a locale-specific named entity (place, person, brand, internal process label).
  - Section is meta-discussion of a language convention.
- If a passage mixes prose + quote and the judge is uncertain, default to KEEPING the original passage. Better to leave the original than mistranslate.
- `[[wikilink]]` slugs are already ASCII — leave alone even if the target file is still in the source language.

### Write

1. Snapshot tarball (per Safety rules).
2. Rewrite each picked file in place. mtime auto-updates.
3. Append breadcrumb to `<scope>/.nf-dream/translate-log.md`: `<DATE>: translated N files (project <slug>)`.
4. Snapshot retention sweep.
5. Print `Backup: <tarball-path>` + suggest running `/nf-dream reorganize` if `MEMORY.md` hooks still reference non-English content.

### Limitations

- No granular rollback short of tarball restore.
- Cross-file glossary consistency not enforced — each file translated independently.
- Light non-English files skipped to avoid disturbing files that are mostly OK. Adjust threshold manually if needed.

## Output style

- Use the host setup's interface language for headings/summary lines if forced by the system prompt, but keep section keys (`## Now`, `## Next`, ...) in English so they're greppable across sessions.
- Never echo full file contents to chat. Counts, filenames, mtimes, and short reason markers only.
- After every write mode, print one-line summary + path to snapshot for rollback.

## Cross-references

- A companion `nf-memory` skill (also in this toolkit) sets up `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` in `.claude/settings.local.json` (the only working per-project mechanism; `autoMemoryDirectory` at that scope is silently ignored by the binary). Prerequisite if not already configured.
- A memory-frontmatter rule in the host setup (project-level) is what auto-fills `metadata.project`, `metadata.cwd`, `metadata.tags`, `metadata.related` when Claude saves NEW memory. `nf-dream` reads `metadata.project` as the authoritative source-of-truth for filter. For pre-rule files: run `/nf-dream normalize` to fix shape (move misplaced keys + add type) then `/nf-dream backfill` to tag project/cwd.
- `references/slug-to-cwd.json` — authoritative slug → absolute cwd registry consumed by both `normalize` (cwd backfill when project known) and `backfill` (cwd derivation for newly-classified files). Edit when a new project comes online.
- `references/filename-prefix-to-type.md` — convention for inferring `metadata.type` from filename prefix. Used by `normalize`; documented for human eyeballing.
- If `<scope>` is inside a git submodule (e.g. memory tracked as its own repo), commit/push happens INSIDE that submodule, not the parent repo.
- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — source for `originSessionId` reverse-lookup during pre-classify pipeline. Encoding: `/` → `-` in absolute path.

## Scripts inventory

All under `scripts/`. Pure Python, no third-party deps. All accept `--json` for programmatic consumption; write-mode scripts default to dry-run, require `--apply` to mutate disk.

| Script | Mode(s) | Purpose |
|---|---|---|
| `_lib.py` | shared | Frontmatter parser, registry loader, file iteration helpers |
| `classify.py` | preview / reorganize / consolidate / stale / full | Bucket files (Now/Next/Future/Done/Reference/Stale) via heuristics + tie-break |
| `normalize.py` | normalize | Move misplaced top-level keys + add `metadata.type` from prefix + add `metadata.cwd` from registry |
| `backfill.py` | backfill | 5-step mechanical project tagging (filename / body path / body URL / origin session / type=user fallback). Defers low-confidence (< 0.7) to Claude / user |
| `consolidate.py` | consolidate | Build move plan (aged session-end + Stale) + execute `mv` to `archive/YYYY-MM/` + update breadcrumb |
| `dedupe_candidates.py` | dedupe | Filename-stem Levenshtein + heading keyword overlap → candidate pairs JSON for Claude judge |
| `reorganize.py` | reorganize | Rewrite MEMORY.md with per-project bucket sections; preserve out-of-scope entries verbatim |
| `handoff_prep.py` | handoff | Bundle Now bucket (full) + Next bucket (top section) into JSON for Claude to synthesize HANDOFF-<slug>.md |
| `translate_prescan.py` | translate | Per-file non-English diacritic counts + bucket (none/light/mixed/heavy) → JSON for Claude pick |
| `lint.py` | lint | Read-only health check including misplaced-top-level-keys detection |
| `rollback.py` | rollback | List tarballs + last batch, restore tarball (with pre-rollback snapshot), or un-archive last batch |
| `snapshot.py` | all write modes | Create tarball + per-file index snapshots, retention sweep (14d tarball / 7d per-file), list |
| `resolve_cwd_from_session.py` | backfill / lint | Reverse-lookup cwd from `originSessionId` via `~/.claude/projects/<encoded-cwd>/` scan |

### Calling pattern from skill

```bash
SCRIPTS=~/.claude/skills/nf-dream/scripts

# preview = classify
python3 $SCRIPTS/classify.py <scope> [--project <slug>] --json

# normalize (write mode)
python3 $SCRIPTS/snapshot.py create <scope>          # snapshot first
python3 $SCRIPTS/normalize.py <scope>                # apply
python3 $SCRIPTS/snapshot.py sweep <scope>           # retention sweep

# backfill (per-project default)
python3 $SCRIPTS/backfill.py <scope> --json          # dry-run plan
python3 $SCRIPTS/backfill.py <scope> --apply         # write

# consolidate
python3 $SCRIPTS/consolidate.py <scope> --project <slug> --json   # plan
python3 $SCRIPTS/consolidate.py <scope> --project <slug> --apply  # execute

# rollback
python3 $SCRIPTS/rollback.py list <scope>
python3 $SCRIPTS/rollback.py tarball <scope> <stamp>
python3 $SCRIPTS/rollback.py batch <scope>
```

The skill orchestrates: scope resolution + AskUserQuestion confirms + LLM judge for low-confidence backfill / dedupe pairs / consolidate ambiguity. The scripts handle the mechanical heavy lifting (file IO, regex, JSON).

## Anti-patterns

- DO NOT auto-run on session start or session end. Manual only — user must type `/nf-dream`.
- DO NOT delete files. Always `mv` into `archive/`.
- DO NOT touch files outside the resolved scope folder, even if cross-scope dedupe seems valuable.
- DO NOT operate folder-wide by default. Default is auto-scope to current project. Only `lint` is folder-wide. `backfill` prompts the user for scope; default option is "current project only".
- DO NOT add a `--all` flag or any other escape hatch to disable project filtering — too risky, user rarely needs it, and the few legitimate cases can be handled by manually picking each file outside this skill.
- DO NOT auto-fill `metadata.project` mid-run for files that lack it. That's the explicit job of `backfill` mode (with snapshot + user confirm). Other modes should treat unfilled files conservatively: skip them with a note, don't guess.
- DO NOT call external LLM APIs. The judge is the running Claude session.
- DO NOT write to `MEMORY.md` or `HANDOFF-*.md` without first snapshotting.
- DO NOT proceed if the memory submodule has uncommitted edits — risk of losing user's in-progress notes.
- DO NOT bundle `translate` into `full`. Translation is a semantic rewrite; it must be opted into explicitly so the user can review the plan separately from index/archive churn.
- DO NOT translate verbatim user quotes or locale-specific named entities. When uncertain, keep the original passage and translate around it.

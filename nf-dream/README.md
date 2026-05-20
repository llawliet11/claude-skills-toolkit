# nf-dream

A Claude Code skill that **consolidates filesystem-based session memory**. Reads markdown memory files under your configured memory folder, auto-classifies each one (Now, Next, Done, Future, Reference, Stale), and lets you normalize legacy frontmatter shape, reorganize the index, generate a one-page handoff, archive aged session-end states, dedupe overlapping topics, backfill project tags, translate non-English entries to English, or roll back the last consolidate. Project-scoped by default, dry-run by default, snapshots before every write.

This is the white-labeled, shareable version of a skill I use day to day. Examples and references have been generalized so you can drop it into any setup.

## Why this skill exists

Plain markdown memory is cheap and audit-friendly, but it grows quickly. After a few weeks of saving every interesting decision, fact, or workflow into `~/.claude/memory/<scope>/`, the folder becomes a swamp. The index file (`MEMORY.md`) drifts out of date. Session-end states from months ago still live next to today's notes. Two files describe the same fact from different angles. New sessions can't tell what is load-bearing and what is stale.

`nf-dream` is the cleanup pass. It does the boring sorting work a fresh session would otherwise have to do every time it opens the folder.

## Install

1. Copy the `nf-dream/` folder into `~/.claude/skills/`:

   ```bash
   cp -r nf-dream ~/.claude/skills/
   ```

   The end result should be `~/.claude/skills/nf-dream/SKILL.md`.

2. Verify Claude Code sees it. In a new Claude Code session, type `/nf-dream` and the skill should appear in the slash-command list.

## Required environment

The skill reads the memory folder from `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` in the current project's `.claude/settings.local.json` (with fallbacks to the legacy top-level `autoMemoryDirectory` key and user-scope settings). Make sure that key is set before running:

```json
{
  "env": {
    "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE": "~/.claude/memory/personal/"
  }
}
```

The companion `nf-memory` skill in this toolkit sets this up interactively. The folder must contain at least 5 `*.md` files (excluding `MEMORY.md`) or the skill refuses to run, not enough signal to consolidate.

If the memory folder is itself a git submodule (a common pattern when you want memory tracked separately from your dotfiles repo), `nf-dream` refuses to run when the submodule has uncommitted changes. Commit or stash first.

## Usage

Type `/nf-dream [mode] [--project <slug>] [--no-generic]` from a Claude Code session.

| Mode | What it does | Writes? |
|---|---|---|
| `preview` (default) | Classify all in-scope files into 6 buckets (Now, Next, Done, Future, Reference, Stale). Print a report. | No |
| `normalize` | Mechanical frontmatter shape compliance: move misplaced top-level keys into `metadata:`, add `metadata.type` from filename prefix, add `metadata.cwd` from a slug registry. Folder-wide, low risk. | Yes (frontmatter) |
| `reorganize` | Rewrite `MEMORY.md` index with files grouped by bucket. Other projects' entries untouched. | Yes (MEMORY.md) |
| `handoff` | Generate `HANDOFF-<slug>.md`, a one-page "what next" file for fresh sessions. | Yes (HANDOFF) |
| `consolidate` | Move aged session-end states into `archive/YYYY-MM/`. Per-file judge by Claude. | Yes (moves) |
| `dedupe` | Find pairs of files that overlap in topic, propose merges. User confirms per pair. | Yes (merges + moves) |
| `stale` | Surface stale candidates, user picks which to archive. | Yes (moves) |
| `lint` | Health check across the whole folder. No writes. | No |
| `rollback` | Undo a previous run via full tarball restore or per-batch un-archive. | Yes (restore) |
| `full` | `preview` + `reorganize` + `consolidate` + `handoff` in one confirm. Does not include `normalize` or `translate`. | Yes |
| `backfill` | Tag `metadata.project` on files that lack it. Idempotent, scope picked by user. | Yes (frontmatter) |
| `translate` | Rewrite non-English memory bodies into English so future relevance ranking works better. Opt-in, never bundled into `full`. | Yes |

If you omit the mode, you get `preview` (read-only, always safe to start with).

### `normalize` vs `backfill` (when to pick which)

Both modes write `metadata.*` keys. They split by blast radius:

- **`normalize`** is mechanical and folder-wide. It moves misplaced top-level keys into the `metadata:` block, adds `metadata.type` from the filename prefix, and adds `metadata.cwd` from `references/slug-to-cwd.json` when `metadata.project` is already set. No judgment call. Run it once after a Claude Code upgrade introduces a new metadata field.
- **`backfill`** is semantic and per-project by default. It runs a 7-step pipeline to classify `metadata.project` for files that lack it. Use it once per project on a freshly-onboarded scope.

Typical sequence: `normalize` → `backfill` (per project) → daily `preview` / `handoff` / `full`.

## Project filter

Memory folders are usually shared across multiple projects. `nf-dream` auto-scopes every run to one project, derived in this order:

1. `--project <slug>` flag, if you pass one.
2. `basename "$(git rev-parse --show-toplevel)"`, if cwd is in a git repo.
3. AskUserQuestion prompt with the list of slugs found in the cache.

Files belonging to other projects are excluded from every operation. Only `lint` is folder-wide (read-only, so it can't hurt).

To include cross-project memories (tagged `metadata.project: generic`), the default behavior is to include them automatically. Pass `--no-generic` to filter strictly to the named slug.

## Safety guarantees

- **Dry-run by default.** Every write mode shows a plan + asks for confirmation before any file changes.
- **Full tarball snapshot before every write.** Lives in `<scope>/.snapshots/full-<timestamp>.tar.gz`. Retention 14 days. Rollback is always possible from the tarball, even mid-batch.
- **Per-file snapshot for `MEMORY.md` and `HANDOFF-<slug>.md`.** Retention 7 days. Quick standalone restore without untarring.
- **Never `rm`.** Files only get `mv`'d into `<scope>/archive/YYYY-MM/`. Breadcrumb logged in `<scope>/archive/README.md`.
- **Refuses to run if the memory submodule has uncommitted edits.** Commit or stash first.

The `rollback` mode reverses any consolidate / dedupe / reorganize / handoff / full run via tarball restore (within the 14-day window) or per-batch un-archive.

## Memory frontmatter expectations

`nf-dream` reads `metadata.project` from each file's YAML frontmatter as the authoritative project tag. If a file lacks that field, `nf-dream` falls back to a 7-step pre-classify pipeline (filename match, body path, body URL, session ID reverse-lookup, type fallback, in-session LLM judge, user override).

Files saved by Claude after the standard memory-frontmatter rule is in place will already carry `metadata.project`. For pre-rule files, run `/nf-dream backfill` once with snapshot + confirm.

Example frontmatter Claude produces with the rule active:

```yaml
---
name: example-blog-deploy-flow
description: Wrangler deploy mechanism for example-blog (Cloudflare Pages)
metadata:
  type: reference
  project: example-blog
  cwd: ~/projects/example-blog
  tags: [wrangler, cloudflare, deploy]
  related: [example-cloudflare-api-key-conflict]
---
```

The skill does not invent these; it consumes whatever the host setup writes.

## Why no external LLM API

The classification + per-file judge is intentionally done by the running Claude session itself, not by spinning up a separate API call. Two reasons:

1. **No additional cost.** You're already paying for the current session; the judge runs inside its context window.
2. **No additional auth.** No second API key, no Anthropic / OpenAI account juggle. The skill works in offline / restricted environments as long as the Claude Code CLI itself works.

Trade-off: judgments are limited by the current session's context budget. For very large folders (~hundreds of files) you may need to run `nf-dream` in batches across multiple sessions.

## Customizing

The classification heuristics live inside `SKILL.md` under the "Classification heuristics" section. Edit the bucket signals to match your own memory-writing conventions. For example, if your team uses `[Draft]` instead of `Pending`, add it as a Now signal in the table.

The `HANDOFF-<slug>.md` output template also lives in `SKILL.md` under "Mode: handoff". Trim sections you don't need (`Recently shipped`, `Open questions`, etc.).

### Two registries under `references/`

- **`slug-to-cwd.json`** maps a project slug to its absolute cwd. Shipped with placeholder entries (`example-blog`, `example-portfolio`, `example-infra`). Replace with your real slugs and paths before running `normalize` or `backfill`. Both modes consume it.
- **`filename-prefix-to-type.md`** documents the convention for inferring `metadata.type` from filename prefix (`project_*` → project, `feedback_*` → feedback, `reference_*` → reference, `user_*` → user). Hard-coded in `scripts/normalize.py`; this file is the human-readable mirror.

### Scripts architecture

All heavy lifting lives in `scripts/` (pure Python, no third-party deps). The `SKILL.md` orchestrates: scope resolution, AskUserQuestion confirms, in-session LLM judge. Write-mode scripts default to dry-run, require `--apply` to mutate disk. You can call any script directly with `--json` if you want to script around `nf-dream` from another harness.

## Anti-patterns

- Don't auto-run on session start or end. The skill is manual on purpose, you don't want consolidation happening behind your back.
- Don't delete files manually from `archive/`. Use `rollback` if you change your mind.
- Don't run `nf-dream` against a memory folder with fewer than ~10 files. There isn't enough signal for the buckets to mean anything.
- Don't operate folder-wide. The default project filter is there because shared folders mix projects, and one bad reorganize on a 200-file folder is painful even with snapshot rollback.

## License

MIT. See `LICENSE`.

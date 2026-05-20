# nf-cc-sync

A Claude Code skill that **syncs `~/.claude/` between machines** using a **branch-per-machine** git layout. Pull-only, key-level merge for `settings.json`, prefer-newer for skills and rules, never auto-deletes.

This is the white-labeled, shareable version of a skill I use day to day. Examples and references have been generalized so you can drop it into any setup.

Blog write-up: [nf-cc-sync, pull-only sync of `~/.claude/` between machines](https://blog.nghia-pham.com/blog/nf-cc-sync/).

## Why this skill exists

If you keep `~/.claude/` on two or more machines, the single shared branch approach falls apart the first time both machines edit `settings.json` on the same day. The merge picks one machine's terminal flags, drops the other's environment variables, and you find out two days later when a hook stops firing.

This skill replaces that workflow with **one branch per machine**, pull-only sync, and per-key merge for `settings.json`. Each machine pushes its own work. Sync pulls another machine's branch into the current one. The OTHER branch is read-only from the current machine's perspective.

## Install

1. Copy the `nf-cc-sync/` folder into `~/.claude/skills/`:

   ```bash
   cp -r nf-cc-sync ~/.claude/skills/
   ```

   The end result should be `~/.claude/skills/nf-cc-sync/SKILL.md`.

2. **Edit the branch allowlist in `SKILL.md`** (Step 2 of the skill body) to match your branch naming. The default is `^(main|laptop|server|desktop)$`, replace those with whatever you actually use.

3. Verify Claude Code sees it. In a new Claude Code session in `~/.claude/`, type `/nf-cc-sync` and the skill should appear.

## Required environment

- **`~/.claude/` is a git repo with one branch per machine.** Before running the skill, your `~/.claude/` directory must already be initialized as a git repository, each machine must already be on its own branch, and the remote must contain all the per-machine branches you want to sync between. The skill does not set up the branch-per-machine layout for you; it only operates on one that exists.
- **`jq` is available.** Step 5 uses `jq` for the per-key `settings.json` merge. macOS via Homebrew (`brew install jq`), Linux via apt/dnf/pacman.
- **Git ssh-or-token credentials are configured.** The skill auto-commits and pushes; if your push requires interactive credentials, configure them once before running.
- **(Optional) Memory submodule.** If you split memory into a `memory/` git submodule under `~/.claude/`, Step 1 reconciles it independently of the parent repo's branch-per-machine sync. If you do not use a submodule, the skill skips that step.

## Usage

Type the slash command from a Claude Code session whose cwd is `~/.claude/`:

| Invocation | What happens |
|---|---|
| `/nf-cc-sync` | Default policy. Resolves the OTHER branch, computes the change set, applies fast-forwards, merges `settings.json` per-key, commits, pushes CURRENT branch. Skips `hooks/`, `statusline-command.sh`, `channels/`, `plans/` as machine-specific. |
| `/nf-cc-sync --include-machine-config` | Same as default, also syncs `hooks/`, `statusline-command.sh`, `channels/**`. Use sparingly; these often contain OS-specific paths or behavior. |
| `/nf-cc-sync --dry-run` | Computes the plan and prints the final report, applies no changes, makes no commit. |

The skill always prints a summary of which files will change and which `settings.json` keys differ before applying. You confirm via `AskUserQuestion`.

## What the skill does (step by step)

1. **Pre-flight.** Verifies `~/.claude/` is a git repo, captures `OS` and current branch. Auto-commits any dirty working tree on the current branch with a `wip auto-commit before nf-cc-sync` message. Runs `git fetch origin --prune`.
2. **Memory submodule** (if present). Reconciles the optional `memory/` submodule against its own remote; either up-to-date, fast-forward pull, push, or rebase+push.
3. **Resolve OTHER.** Lists remote branches matching the allowlist regex (which you customize for your machine names). One candidate: auto-pick. Multiple: ask the user.
4. **Compute change set.** Computes `merge-base ... origin/<other>` and `merge-base ... HEAD` diffs, builds per-file status (fast-forward, no-op, conflict, skip-delete).
5. **Categorize.** Each path maps to a category by glob: `settings.json` (key-merge), `hooks/`/`statusline-command.sh`/`channels/`/`plans/` (skip unless `--include-machine-config`), submodule pointer (already handled in step 2), everything else (prefer-newer with a 24h conflict window).
6. **Apply, commit, push.** Writes the resolved files into the working tree, stages them, commits with `chore(<current>): sync from <other>, <N> files`, pushes the current branch.
7. **Final report.** Structured summary of fast-forwards, conflicts, skips, settings keys changed, submodule pointer bump, commit SHA, push status.

## The pull-only contract

Two things the skill will never do:

1. **Push to the OTHER branch.** The temptation to "push my new skill to the server from my laptop" is real. The skill refuses by design. Each machine only ever pushes its own branch. Sync pulls. This makes the topology a star instead of a mesh and keeps the merge surface small.
2. **Auto-delete on the receiving side.** If the OTHER branch deleted a file, the skill logs the deletion and skips. The receiving machine might still need that file. You delete manually if you want.

## Customizing

Most customization is done by editing `SKILL.md` in place. Common adjustments:

- **Branch allowlist.** The default regex (`^(main|laptop|server|desktop)$`) is a placeholder. Replace it with your actual branch names. The skill refuses to sync from a branch not in this regex.
- **Categories and globs.** If you have new directories in `~/.claude/` (custom subfolders, plugin-managed dirs), add them to the category table in Step 4. The default is to skip unmatched paths and log them.
- **Conflict window.** The 24h "ask the user" window in Step 4a is a single magic number. If your machines push less frequently than once a day, narrow it; more frequently, widen it.
- **Settings.json per-key rules.** The table in Step 5 encodes "machine-specific, union, recursive merge". If you adopt a new top-level key in your `settings.json`, add a row to that table.

## Anti-patterns

- Do not push to OTHER. The whole branch-per-machine model breaks if you start cross-pushing. Each machine pushes its own branch only.
- Do not check out OTHER from CURRENT. The skill never does this; you should not either during normal use. The OTHER branch is read-only from CURRENT's perspective.
- Do not run the skill from outside `~/.claude/`. Every path it manipulates is relative to that directory. Running it elsewhere either no-ops or, worse, touches the wrong git repo.
- Do not skip the dry-run on the first invocation against a new OTHER branch. `--dry-run` prints the full plan; reviewing it once before applying catches surprises like "I forgot I had unrelated edits on this machine".
- Do not commit machine-specific paths into the synced categories. If `rules/` or `skills/` files contain hard-coded local paths, they will sync to other machines verbatim and break there. Keep machine-specific values in `settings.json` or the explicitly machine-scoped folders (`hooks/`, `statusline-command.sh`, `channels/`, `plans/`).

## License

MIT. See `LICENSE`.

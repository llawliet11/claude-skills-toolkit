# nf-memory

A Claude Code skill that **configures a project to use a shared memory folder** via the `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var in `.claude/settings.local.json`. Picks a target (existing or new) under `~/.claude/memory/`, optionally migrates from the previous shared folder and/or project-local memory into the new target with smart merge, and never touches the source after migration.

This is the white-labeled, shareable version of a skill used in production. Examples and references have been generalized.

**Pairs with [`nf-dream`](../nf-dream/)** (also in this toolkit) to form a complete memory pipeline: `nf-memory` configures the folder, `nf-dream` consolidates it.

## Why this skill exists

Claude Code's auto-memory feature writes notes to a folder that can be customized with the `autoMemoryDirectory` setting. However, **this field is silently ignored when placed in project-scope files** (`.claude/settings.json` or `.claude/settings.local.json`). The binary only honors it at user scope (`~/.claude/settings.json`) or above. Setting it in your project's `settings.local.json` produces no error and no warning — it just does nothing.

The per-project mechanism that actually works is the `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` environment variable. The binary's `env` field in settings files _is_ propagated to `process.env` at startup (unlike `autoMemoryDirectory`), and the memory resolver reads that env var with highest priority.

The default behavior without any configuration is per-project hash paths: `~/.claude/projects/<workdir-hash>/memory/`. This means six projects produce six disconnected memory silos. A lesson learned in project A is invisible to project B, and switching machines loses all context.

Pointing every project at a shared folder under `~/.claude/memory/<scope>/` via the env var fixes that, but the setup is fiddly:

1. Decide which shared folder to use (one big bucket, or one per company/domain).
2. Write the correct `env` block into `.claude/settings.local.json` using the right JSON structure (nested under `"env"`, not at top level).
3. Use an absolute path — the env var is not tilde-expanded by the binary.
4. Make sure `.claude/settings.local.json` is in `.gitignore`.
5. Migrate any existing project-local memory into the new target without losing or duplicating entries.

`nf-memory` does all of this. It asks the right questions via `AskUserQuestion`, validates folder names, refuses to set a target that would cause recursive memory scans, previews the plan before writing, and offers a smart-merge migration that never modifies the source folders.

## Install

1. Copy the `nf-memory/` folder into `~/.claude/skills/`:

   ```bash
   cp -r nf-memory ~/.claude/skills/
   ```

   The end result should be `~/.claude/skills/nf-memory/SKILL.md`.

2. Verify Claude Code sees it. In a new Claude Code session, type `/nf-memory` and the skill should appear in the slash-command list.

## Required environment

- **Cwd must be inside a project directory.** The skill writes to `<cwd>/.claude/settings.local.json` — running from a non-project location would scatter settings files.
- **`.claude/settings.local.json` may or may not exist.** The skill detects which case applies and uses `Write` (for create) or `jq`/`Edit` (for merge) accordingly.
- **`~/.claude/memory/` is the default home** for shared memory folders. The skill lists subfolders under it as picker options. You can also pass an absolute path or `~/`-prefixed path to use a folder anywhere on disk — the skill will expand `~/` to an absolute path before writing.
- **Optional cwd-default hint.** If a project-to-cwd mappings file exists (e.g. `~/.claude/references/nf-memory-mappings.md`), the skill reads it and surfaces a recommended folder. This file is optional.

## Usage

Type `/nf-memory [target]` from a Claude Code session, where `[target]` is optional:

| Invocation | What happens |
|---|---|
| `/nf-memory` | Interactive picker. Shows current path from `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` (or "not set"), suggests the cwd-mapped folder (if any), shows most-recently-modified existing folders, plus "Other". |
| `/nf-memory personal` | Bare-name argument. Resolves to `~/.claude/memory/personal/` (expanded to absolute). Skips the picker. |
| `/nf-memory ~/notes/mem/` | Path-like argument. Expanded to absolute path, used verbatim. Skips the picker. |
| `/nf-memory /abs/path/` | Absolute path. Used verbatim. Skips the picker. |

After the target is resolved, the skill always prints a preview and asks for confirmation before writing anything.

## What the skill does (step by step)

1. **Detect current state.** Reads `<cwd>/.claude/settings.local.json` if it exists; captures the existing `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` value (or "not set"). If a legacy top-level `autoMemoryDirectory` key is present, flags it for removal.
2. **Resolve target.** Either from the argument (bare name → `~/.claude/memory/<name>/`, path-like → absolute expansion) or via the interactive picker.
3. **Validate.** Bare-name targets are checked for slashes, whitespace, and leading dots. Path-like input is trusted. Typo detection asks "did you mean X?" if your input is one or two characters off from an existing folder.
4. **Expand to absolute path.** `~/` is resolved to `$HOME`; relative paths are rejected. The env var must be absolute — the binary does not expand it.
5. **Recursive-memory safeguard.** Refuses if the resolved target would equal or contain the current cwd.
6. **Preview.** Prints target path, status (existing or will-be-created), file count if existing, notes any legacy field that will be removed, and confirms via `AskUserQuestion`.
7. **Apply.** Creates the folder if missing, then either writes a new `.claude/settings.local.json` or uses `jq` to safely merge `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` into the existing file without touching other keys. Removes legacy `autoMemoryDirectory` if present. Adds `.claude/settings.local.json` to `.gitignore` if needed.
8. **Restart prompt.** Prints a clear reminder: env vars are merged at session startup, so the current session is unaffected. The user must relaunch Claude Code to pick up the new path.
9. **Migration (optional).** If the previous memory path and/or a project-local `.claude/memory/` folder exists, offers to migrate. Sources are listed via `AskUserQuestion` (multi-select if there are two). The user can pick none, one, or both.

## The smart-merge migration

When migrating, the skill walks every `*.md` file under the selected sources (excluding `MEMORY.md`) and decides per-file:

| Case | What happens |
|---|---|
| **No conflict** (target lacks file with same name AND no topic overlap in target index) | Copy mechanically. |
| **Filename conflict** (target already has a file with the same name) | Read both, write a consolidated version into target. Prefer newer / more specific entries. |
| **Topic overlap** (different filenames, same subject as detected by scanning target's `MEMORY.md` descriptions) | Read both, write consolidated version. Use whichever filename is clearer. |
| **Contradiction** (sources disagree on facts) | Ask the user via `AskUserQuestion` with both versions as labeled options, plus "Skip this file". |

After all per-file passes, the skill rebuilds the target `MEMORY.md` index, dedupes by file path, keeps lines under ~150 chars.

**Sources are read-only.** Nothing in source folders is ever moved, deleted, or renamed.

## Customizing

- **Default memory root.** The skill uses `~/.claude/memory/` as the home for shared folders. Pass a path-like argument every time to use a different root, or edit the bare-name expansion rule in `SKILL.md`.
- **Cwd-default hint.** Create the optional mappings file and populate it with cwd-prefix-to-folder pairs for automatic per-project recommendations.
- **Migration policy.** The default is "ask per contradiction, auto-consolidate otherwise". Edit the per-file decision table in `SKILL.md` to change this.

## Anti-patterns

- **Do not set `autoMemoryDirectory` in `.claude/settings.local.json` or `.claude/settings.json`.** The binary silently ignores this field at project and local scope. It produces no warning. Use `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` instead.
- **Do not use a `~/`-prefixed path directly in the env var.** The binary does not expand it. You will get a folder literally named `~` in your cwd. The skill handles the expansion for you.
- **Do not use direnv (`.envrc`) to set the env var** if you launch Claude Code via a GUI launcher or IDE integration. Those launchers typically bypass the shell entirely, so direnv hooks never fire. Only the `env` field in settings JSON is reliable.
- **Restart the session after applying.** The env block is merged into `process.env` at startup. Editing settings mid-session has no effect on the current session.
- **Do not commit `.claude/settings.local.json`.** The skill auto-adds it to `.gitignore`, but verify after the run.
- **Do not run the skill from outside a project directory.** It writes to `<cwd>/.claude/settings.local.json`.

## License

MIT. See `LICENSE`.

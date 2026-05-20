---
name: nf-memory
description: Configure a project to use a shared memory folder via env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE in .claude/settings.local.json (the autoMemoryDirectory field at local/project scope is silently ignored by the binary, so the env-var route is the only working per-project mechanism). Accepts an optional argument (folder name or path) to skip the interactive picker; auto-creates the target folder if missing; lists existing folders to choose from; optionally migrates from old shared folder and/or project-local memory into the new target with smart merge. Uses AskUserQuestion for picks and confirmations. Use when user says "config global memory", "setup global memory", "save memory to global", "share memory across projects", "migrate memory to global".
disable-model-invocation: true
---

# Memory Setup

Configure the current project to share memory with other projects via the env var `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` (set in `.claude/settings.local.json` `env` field). The binary merges the `env` map into `process.env` at startup; its memory resolver reads `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` with highest priority.

**Do NOT write to the `autoMemoryDirectory` field at local/project scope** — the binary silently ignores it there for security reasons. Only user-scope (`~/.claude/settings.json`) and policy-scope honor that field.

Optionally migrate existing memory from the previous shared folder and/or project-local memory into the new target.

## Interaction style

This skill uses the `AskUserQuestion` tool for all decision points (picks, confirmations, multi-source choices). Free-form input (custom folder names, custom paths) is collected via the auto-provided "Other" option of `AskUserQuestion`.

Reserve plain prompt-based asks only for cases where `AskUserQuestion` is not a fit (e.g. follow-up clarification after a validation error).

## Resolving the target folder

Resolve in this precedence:

### 1. Explicit argument (always wins)

If invoked with an argument (e.g. `/nf-memory personal`, `/nf-memory ~/notes/mem/`), trust it — never re-prompt with an enum and never validate against any list.

- **Bare name** (no `/`, no `~`, no whitespace) → `~/.claude/memory/<arg>/`
- **Path-like** (starts with `~/`, `/`, or `./`) → expand and use verbatim

Validate the bare-name form (see Validation). On invalid input, show the rule and ask once for a corrected name via `AskUserQuestion` (options: a couple of safe suggestions; user types correction via "Other"). Then proceed to Preview.

### 2. No argument — interactive picker

1. **Read current state** — load `.claude/settings.local.json` and capture current memory path from `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`. Also check for a legacy top-level `autoMemoryDirectory` field — if present, flag it as "legacy / ignored by binary" and offer to remove it during Apply (it is dead config that misleads readers).
2. **List existing folders** under `~/.claude/memory/`. For each, count `.md` files.
3. **Optional cwd-default hint** — if a project-to-cwd mappings file exists (e.g. `~/.claude/references/nf-memory-mappings.md`), find the longest cwd-prefix match; that folder becomes the recommended default.
4. **Ask via `AskUserQuestion`** (header: `Memory dir`, single-select):
   - Question: `"Pick a memory folder. Current: <current path or 'not set'>"`
   - Options (max 4, prioritize in this order):
     1. The cwd-mapped suggestion if any — label `"<name> (recommended)"`, description shows file count
     2. Up to 3 most-recently-modified existing folders (excluding the suggestion already shown)
   - The harness adds "Other" automatically — the user picks "Other" and types a custom name or path. Treat the "Other" payload exactly like an explicit argument (apply bare-name vs path-like rules).

If the user selects an existing folder from the list, proceed to Preview with no further validation.

## Validation (bare-name only)

Reject if the bare name:

- Contains `/`
- Contains whitespace
- Starts with `.`
- Is empty

On rejection, ask once via `AskUserQuestion` for a corrected name (use "Other" for free-form retry). Path-like input is not validated — user is being explicit.

## Typo detection

When the user types a name (via argument or "Other") that does NOT match any existing folder:

- Compare it against each existing folder name (lowercase, character-level similarity).
- If any existing folder name differs by 1-2 characters → ask via `AskUserQuestion` (header: `Did you mean`, single-select):
  - Question: `"'<typed>' doesn't match any folder. Did you mean '<closest>'?"`
  - Options:
    1. `"Yes, use <closest>"`
    2. `"No, create new '<typed>'"`
    3. `"Cancel"`
- Otherwise → skip directly to Preview (creating new folder is normal).

## Recursive-memory safeguard

Reject if the resolved target equals or is a parent of the current working directory. Setting memory dir to a path that contains the project itself causes recursive memory scans.

Show the conflict and ask for a different target via `AskUserQuestion` (header: `Conflict`, options include "Cancel" and "Enter a different path" via Other).

## Path expansion (critical)

The env var `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` is consumed by the binary's memory resolver, which does **NOT** expand `~/`. The value must be an **absolute path** starting with `/`.

Before writing, expand any `~/...` to the actual home directory:
- Bare name `personal` → `~/.claude/memory/personal/` → resolve `~` to `$HOME` → e.g. `/home/user/.claude/memory/personal/`
- `~/notes/mem/` → resolve `~` to `$HOME`
- `/abs/path/` → use verbatim
- `./relative/` → reject (env vars are evaluated at session-startup cwd, not necessarily the project dir)

Use bash to resolve: `realpath -m "<input>"` or `eval echo "<input>"`. Trailing slash is preserved for visual clarity but not required.

## Preview before applying

Before writing anything, print to chat:

- **Target path** (resolved, **absolute**, no `~`)
- **Status** — `existing` or `will be created`
- If existing: **file count** and **last modified**
- **Will update** `.claude/settings.local.json` `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`
- **Will remove** legacy top-level `autoMemoryDirectory` field if present
- **Restart required** — current session will not pick up the env change; user must close and relaunch

Then ask via `AskUserQuestion` (header: `Confirm`, single-select):
- Question: `"Apply this configuration?"`
- Options: `"Yes, apply"`, `"No, cancel"`

Only continue on Yes.

## Apply

1. If target folder does not exist → create it (`mkdir -p`).
2. Ensure parent `.claude/` directory exists (`mkdir -p .claude`).
3. Update `.claude/settings.local.json` — **branch on whether the file exists**:

   **Check existence first** (e.g. `test -f .claude/settings.local.json`).

   - **If file does NOT exist** → use `Write` tool to create with:
     ```json
     {
       "env": {
         "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE": "<absolute-resolved-path>"
       }
     }
     ```

   - **If file EXISTS** → prefer `jq` for safe JSON merge (handles nested keys, trailing commas, formatting cleanly):
     ```bash
     ABS_PATH="<absolute-resolved-path>"
     TMP=$(mktemp)
     jq --arg p "$ABS_PATH" \
        'del(.autoMemoryDirectory) | .env = ((.env // {}) + {"CLAUDE_COWORK_MEMORY_PATH_OVERRIDE": $p})' \
        .claude/settings.local.json > "$TMP" && mv "$TMP" .claude/settings.local.json
     ```
     This: (a) deletes legacy `autoMemoryDirectory` if present, (b) creates `env` object if missing, (c) sets/overwrites `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` without touching other env keys or top-level keys.

     **Fallback if `jq` unavailable**: `Read` the file, parse JSON mentally, use `Edit` to splice in the `env` block — never `Write` an existing populated file (would overwrite permissions/other config).

     If file exists but empty/malformed → warn user in chat, then `Write` the minimal object above.

4. Ensure `.claude/settings.local.json` is in `.gitignore` (append if missing).

**Why `jq` over `Edit` for existing files:** `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` is a **nested** key, harder to splice safely with text-based `Edit` than a flat top-level field. `jq` understands JSON structure, handles missing `env` parent object, preserves other keys deterministically.

## Post-apply: restart instruction

After successful write, print clearly:

```
Configuration saved. The binary applies env vars at session startup.
Your current session is unaffected.

To activate:
1. Exit this session.
2. Relaunch Claude Code from this project folder.
3. Verify: echo $CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
   (should print the absolute path you configured)
4. Save a test memory and check it lands in the new folder.
```

Do not offer to restart automatically — restart is the user's call.

## Migration (optional, hybrid copy + smart merge)

After Apply, offer to migrate memory into the new target.

**All sources are read-only — never moved, deleted, or renamed. Do not suggest removing them.**

### Detect candidate sources

Build a list of sources:

1. **Old shared folder** — the previous memory path captured before Apply (from `env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, or legacy `autoMemoryDirectory`, or the binary default `~/.claude/projects/<sanitized-cwd>/memory/`), if it differs from the new target and exists on disk.
2. **Project-local memory** — `<cwd>/.claude/memory/`, if it exists and differs from the new target.

If the list is empty → skip migration silently.

### Pick sources

If exactly one source → ask via `AskUserQuestion` (header: `Migrate`, single-select):
- Question: `"Migrate N files from '<source>' into '<target>'? (source will not be modified)"`
- Options: `"Yes, migrate"`, `"No, skip"`

If two sources → ask via `AskUserQuestion` (header: `Migrate`, **multiSelect: true**):
- Question: `"Select sources to migrate from. Target: '<target>'. Sources are not modified."`
- Options:
  1. `"Old shared: <old-path> (N files)"`
  2. `"Project-local: <cwd>/.claude/memory/ (N files)"`
- User can pick none, one, or both.

### Per-file decision (run for each selected source)

For each `*.md` file under the source (excluding `MEMORY.md`):

- **No conflict** (target lacks file with same name AND no clear topic overlap in target's `MEMORY.md`) → copy mechanically.
- **Filename conflict** (target has file with same name) → read both, write a consolidated version into target. Prefer newer / more specific entries.
- **Topic overlap** (different filenames, same subject — detected by scanning target `MEMORY.md` descriptions) → read both, write consolidated version. Pick whichever filename is clearer.
- **Contradiction** (sources disagree on facts) → instead of silently picking, ask via `AskUserQuestion` (header: `Conflict`, options include both versions as labels + "Skip this file").

### Index merge

After all per-file passes:

1. Read each source's `MEMORY.md` and target's `MEMORY.md`.
2. For each source entry, add to target index if its target file exists; dedupe by file path.
3. Keep target `MEMORY.md` under ~150 chars per line.

### Report

Print a short summary:

- Copied as-is: N files
- Consolidated (filename conflict): N files
- Consolidated (topic overlap): N files
- Skipped (user declined / contradiction): N files
- Sources processed: `<list of source paths>` (untouched)

Do NOT touch any source after migration.

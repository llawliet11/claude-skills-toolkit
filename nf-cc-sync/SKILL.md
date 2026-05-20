---
name: nf-cc-sync
description: Smart one-way sync of Claude Code config (~/.claude/) from another machine's branch into the current branch. Branch-per-machine convention (one git branch per host, e.g. main / laptop / server). Detects current branch, picks the OTHER machine branch, computes per-file changes, applies safe defaults (additive new files, prefer-newer for conflicts, key-level merge for settings.json), auto-commits dirty tree first, auto-commits + auto-pushes the sync result. NEVER pushes to the OTHER branch; pull-only. Triggers on "/nf-cc-sync", "sync claude config", "sync cc settings", "dong bo claude config".
disable-model-invocation: true
---

# nf-cc-sync, Claude Code Config Sync

One-way pull from another machine's branch into the current branch of `~/.claude/`. Run from `~/.claude/`.

## Convention this skill assumes

You keep `~/.claude/` as a git repo with **one branch per machine** (a "branch-per-machine" layout). Examples:

- Laptop tracks branch `main` (or `laptop`).
- Server tracks branch `server` (or `nas`).
- A third device tracks branch `desktop`.

Each machine only ever pushes its own branch. Sync pulls another machine's branch into the current one. Adjust the allowlist in Step 2 to match your branch names.

## Hard rules

1. **Pull-only.** Never push to the OTHER branch. Never check out OTHER. Only modify the working tree of CURRENT branch.
2. **Never auto-delete files** on receiving side. If OTHER deleted a file, log it and skip.
3. **Auto-commit dirty tree first** before sync. Auto-commit + auto-push at end (the `~/.claude/` repo is private and treats auto-push as the default).
4. **`hooks/`, `statusline-command.sh`, `channels/`, `plans/` are skipped** by default. Pass `--include-machine-config` arg to opt-in.
5. **`settings.json` is merged at key level**, not file level (machines may have different machine-specific keys).
6. Always run from `~/.claude/`. Refuse if run elsewhere.

## Step 1, Pre-flight

```bash
cd ~/.claude
test -d .git || { echo "Not a git repo"; exit 1; }

OS=$(uname -s)
CURRENT=$(git branch --show-current)
```

Sanity: if your branch naming convention encodes OS (e.g. macOS branches start with `m`, Linux branches with `s`), check `OS` against `CURRENT` and warn via `AskUserQuestion` if they disagree. Skip this step if your convention does not encode OS.

If `git status --porcelain` is non-empty:
```bash
git add -A
git commit -m "chore(${CURRENT}): wip auto-commit before nf-cc-sync"
git push
```

```bash
git fetch origin --prune
```

### Memory submodule sync (if used)

If you split memory into a separate git submodule (recommended for cross-machine memory sharing), reconcile it independently before computing the parent-repo diff. The submodule has its own single-branch lifecycle (typically `main`).

```bash
if [ -e memory/.git ] || git submodule status memory >/dev/null 2>&1; then
  if [ ! -e memory/.git ]; then
    git submodule update --init --recursive memory
  fi
  (
    cd memory
    git fetch origin --quiet
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/main)
    BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo "")
    if [ "$LOCAL" = "$REMOTE" ]; then
      echo "memory: up to date ($LOCAL)"
    elif [ "$LOCAL" = "$BASE" ]; then
      git pull --ff-only --quiet && echo "memory: pulled to $(git rev-parse --short HEAD)"
    elif [ "$REMOTE" = "$BASE" ]; then
      git push --quiet && echo "memory: pushed local commits"
    else
      git pull --rebase --autostash --quiet && git push --quiet && echo "memory: rebased + pushed"
    fi
  )
fi
```

After this, the submodule working tree is at the latest submodule HEAD. The parent's pinned SHA may drift; `git add memory` later in Step 6 captures the pointer bump as part of the same sync commit.

If you do not use a memory submodule, skip this section entirely.

## Step 2, Resolve OTHER branch

Machine branches (allowlist). **Edit this list to match your branch naming.** Examples:

```bash
# Replace with your own branch names
ALLOWLIST_REGEX='^(main|laptop|server|desktop)$'
```

```bash
ALL=$(git branch -r | sed 's|^[ *]*origin/||' | grep -vE '^(HEAD|HEAD ->.*)$')
CANDIDATES=$(echo "$ALL" | grep -E "$ALLOWLIST_REGEX" | grep -v "^${CURRENT}$")
```

- 0 candidates: exit with message ("no other machine branch to sync from").
- 1 candidate: auto-pick as `OTHER`.
- 2 or more candidates: use `AskUserQuestion` with one question, options = candidates.

Log: `Syncing FROM origin/${OTHER} INTO ${CURRENT}`.

## Step 3, Compute change set

```bash
MB=$(git merge-base HEAD origin/${OTHER})

git diff --name-status ${MB}..origin/${OTHER} > /tmp/cc-sync-other.txt
git diff --name-status ${MB}..HEAD > /tmp/cc-sync-current.txt
```

Build per-file status by joining the two lists. For each file path:

| OTHER status | CURRENT status | Action |
|---|---|---|
| A or M | (unchanged) | **fast-forward**: copy OTHER's version in (auto) |
| (unchanged) | A or M | **no-op**: keep CURRENT |
| A or M | A or M | **conflict**: resolve per category (Step 4) |
| D | (unchanged) | **skip** (never auto-delete; log warning) |
| D | M | **skip** (CURRENT keeps its version; log) |
| (any) | (any) but content identical | **no-op** |

Verify "content identical" with `git diff origin/${OTHER}:${path} HEAD:${path} --quiet` before treating as no-op.

## Step 4, Categorize each path

Apply category by glob match. First match wins.

| Glob | Category |
|---|---|
| `settings.json` | **key-merge** (Step 5) |
| `hooks/**`, `statusline-command.sh`, `channels/**`, `plans/**` | **skip** (unless `--include-machine-config` was passed) |
| `memory` (gitlink) | **submodule-pointer**, already handled in Step 1; treat as no-op here |
| `agent-memory/**/*.md` | **prefer-newer** (Step 4a) |
| `skills/**`, `rules/**`, `references/**`, `agents/**`, `output-styles/**`, `keybindings.json` | **prefer-newer** (Step 4a) |
| anything else | **skip** (log) |

### 4a, prefer-newer (rules, agents, skills, refs, output-styles, keybindings)

For conflicts (modified on both):
```bash
T_OTHER=$(git log -1 --format=%ct origin/${OTHER} -- "${path}")
T_CURR=$(git log -1 --format=%ct HEAD -- "${path}")
```

- `T_OTHER > T_CURR`: apply OTHER (`git checkout origin/${OTHER} -- "${path}"`).
- `T_OTHER <= T_CURR`: keep CURRENT (no-op).
- If `|T_OTHER - T_CURR| < 86400` (24h window): genuine concurrent edit. Use `AskUserQuestion` with options: `[Use OTHER, Keep CURRENT, Show diff first]`.

## Step 5, settings.json key-level merge

Read `settings.json` from CURRENT (`HEAD:settings.json`) and OTHER (`git show origin/${OTHER}:settings.json`). Use `jq` for deep merge with these per-key rules:

| Key | Rule |
|---|---|
| `$schema`, `language`, `theme`, `autoUpdatesChannel`, `statusLine`, `defaultMode`, `feedbackSurveyState`, `agentPushNotifEnabled`, `skipAutoPermissionPrompt`, `teammateMode`, `remoteControlAtStartup`, `attribution`, `includeCoAuthoredBy`, `includeGitInstructions`, `enableAllProjectMcpServers` | **keep CURRENT** (machine preference) |
| `env` | object union: keys only in OTHER are added; keys in both keep CURRENT's value |
| `permissions.allow` | array union (dedupe), additive |
| `permissions.deny` | array union (dedupe), **never remove a deny entry** (safety) |
| `permissions.additionalDirectories` | keep CURRENT |
| `hooks` | object: per event name, keep CURRENT's commands; events only on OTHER are added |
| `enabledPlugins` | object: per plugin, keep CURRENT's value; plugins only on OTHER are added as-is |

Implementation hint with `jq`:
```bash
git show origin/${OTHER}:settings.json > /tmp/cc-sync-other-settings.json
jq -s '
  .[0] as $cur | .[1] as $oth |
  $cur
  | .env = ($oth.env // {}) + ($cur.env // {})
  | .permissions.allow = (((($cur.permissions.allow // []) + ($oth.permissions.allow // [])) | unique))
  | .permissions.deny  = (((($cur.permissions.deny  // []) + ($oth.permissions.deny  // [])) | unique))
  | .hooks = (($oth.hooks // {}) * ($cur.hooks // {}))
  | .enabledPlugins = (($oth.enabledPlugins // {}) * ($cur.enabledPlugins // {}))
' settings.json /tmp/cc-sync-other-settings.json > /tmp/cc-sync-settings-merged.json
```

(Note: `jq`'s `*` operator does recursive merge with right-hand precedence; that is why CURRENT is on the right for `hooks` and `enabledPlugins`.)

If the merged result is byte-equal to CURRENT's `settings.json`, no-op. Else write it and stage.

Show a summary of which keys changed (added/modified) before applying.

## Step 6, Apply, commit, push

For each path with action `fast-forward` or `apply OTHER`:
```bash
git checkout origin/${OTHER} -- "${path}"
```

For `settings.json`, write merged content directly.

After all changes applied:
```bash
git add -A
COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')
git commit -m "chore(${CURRENT}): sync from ${OTHER}, ${COUNT} files"
git push
```

`git add -A` will pick up the `memory` gitlink change if Step 1 advanced the submodule pointer. The pointer bump is recorded as part of this same sync commit; no separate commit needed.

If `COUNT=0`, no commit; just print "Nothing to sync".

## Step 7, Final report

Print a structured summary:

```
nf-cc-sync: ${CURRENT} <- origin/${OTHER}
  Pre-flight:    [auto-committed N dirty files | clean]
  Memory:        [up to date <sha> | pulled to <sha> | pushed | rebased + pushed | not used]
  Fast-forward:  N files
  Conflicts:     N (auto-resolved by newer-wins)  / N (asked user)
  Skipped:       N (machine-config policy) / N (deletes; never auto-delete)
  Settings.json: keys changed: [env, permissions.allow, ...]
  Pointer bump:  memory <old-sha> -> <new-sha> | (no change)
  Commit:        <sha> "chore(${CURRENT}): sync from ${OTHER}, N files"
  Pushed:        yes
```

## Auto-as-much-as-possible defaults

- Single OTHER candidate: no question, auto-pick.
- Conflict with more than 24h gap: no question, newer wins.
- Conflict within 24h: for rules/skills/etc. default to newer-wins silently and note in report.
- Settings.json with no key-level conflicts: no question, apply.
- Settings.json with new `permissions.deny` entries: silently union (deny is always safe to add).

## Invocation

- `/nf-cc-sync`, run with default policy (skip machine-config).
- `/nf-cc-sync --include-machine-config`, also sync `hooks/`, `statusline-command.sh`, `channels/**`. Use sparingly (these may have OS-specific behavior).
- `/nf-cc-sync --dry-run`, compute the plan and print Step 7 report without applying any changes or commits.

## Out of scope

- Pushing CURRENT's changes to OTHER (forbidden, pull-only).
- Editing `.gitignored` files (`.local/`, `settings.local.json`, `projects/`, etc.).
- Per-context memory file merge, handled by the optional `memory/` submodule's own branch (Step 1). This skill only bumps the parent's pinned SHA pointer when a submodule is used.
- Adding new machine branches automatically; you edit the allowlist in Step 2 by hand.

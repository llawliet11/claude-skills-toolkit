---
name: nf-git-workflow
description: "Install a project-scoped git workflow rule that overrides ~/.claude/rules/safety.md for THIS repo only. Authorizes auto-commit/push/PR/merge within the chosen mode(s), while keeping the current branch as the protected 'head'. Multi-select 1-3 modes: worktree-pr, worktree-local-merge, direct-on-head. Triggers on '/nf-git-workflow', 'setup git workflow', 'install git workflow override', 'tao git workflow override'. Usage: /nf-git-workflow [mode1[,mode2,...]|all]"
disable-model-invocation: true
---

# nf-git-workflow

Install a project-scoped git workflow rule file that overrides the global "ask before every commit/push" safety rule (`~/.claude/rules/safety.md`) for the current repo only. Stack-agnostic. The current branch at install time becomes the protected "head" that must stay safe.

## Concept

- **Head branch** = current branch at install time (detected via `git branch --show-current`). All authorized modes guarantee head stays safe (no force-push, no hard reset, no direct unsanctioned writes).
- **3 modes** of how work lands on head:
  - `worktree-pr` — work in `worktree/<slug>` → PR + auto-merge into head
  - `worktree-local-merge` — work in `worktree/<slug>` → local fast-forward merge into head → push
  - `direct-on-head` — commit directly on head (restricted to declared scope only)
- A project may enable 1, 2, or all 3 modes. Multi-mode means the agent picks the best fit per task.

## Invocation

- `/nf-git-workflow` — interactive multi-select picker
- `/nf-git-workflow worktree-pr` — install single mode
- `/nf-git-workflow worktree-pr,direct-on-head` — install multiple (comma or space separated)
- `/nf-git-workflow all` — install all 3 modes

## Workflow

### Phase 1: Preflight

1. **Check git repo** — `git rev-parse --is-inside-work-tree`
   - If not a git repo: STOP. Tell user this skill only works inside a git repository.
2. **Check not running from a worktree** — `git rev-parse --show-toplevel` vs `git rev-parse --git-common-dir`
   - If toplevel != common-dir's parent (i.e. cwd IS a worktree, not the main checkout): STOP. Tell user to run from the main checkout — installing from inside a worktree would record the wrong head branch.
3. **Detect head branch** — `git branch --show-current`
   - If empty (detached HEAD): STOP. Ask user to checkout a branch first.
   - Save as `HEAD_BRANCH`.

### Phase 2: Resolve mode selection

4. **Parse `$ARGUMENTS`**:
   - Empty → AskUserQuestion **multiSelect** with 3 options:
     - `worktree-pr` (safest, PR + auto-merge)
     - `worktree-local-merge` (no remote PR, local merge)
     - `direct-on-head` (most permissive, scope-restricted)
   - `all` → all 3 modes
   - Comma-separated or space-separated names → split, trim, validate each. Unknown name → STOP with list of valid names.
   - Save as `MODES` (array of selected mode slugs in canonical order: `worktree-pr`, `worktree-local-merge`, `direct-on-head`).

### Phase 3: Resolve output target

5. **Detect candidates**:
   - Check `.claude/rules/` directory exists at repo root.
   - Check `CLAUDE.md` exists at repo root.
6. **Ask user where to write** (AskUserQuestion):
   - Always offer: `.claude/rules/git-workflow.md` (creates `.claude/rules/` if missing). **Recommended** when project has no existing CC config or already uses `.claude/rules/`.
   - If `CLAUDE.md` exists: also offer "Append section to `CLAUDE.md`".
   - Save as `TARGET_PATH` (or `TARGET=CLAUDE.md` for append mode).
7. **Conflict check**:
   - If `TARGET_PATH` exists and contains the install marker `<!-- nf-git-workflow:install -->`: AskUserQuestion → `replace` / `cancel`.
   - If exists without marker: AskUserQuestion → `replace` / `cancel`. Warn the file will be fully overwritten.
   - For `CLAUDE.md` append mode: check if marker section already present. If yes → replace marker block. If no → append at end.

### Phase 4: Render and write

8. **Assemble file content** by concatenating:
   - HEADER (always)
   - One MODE_SECTION per entry in `MODES` (in canonical order)
   - FOOTER (always)
   - Substitute `{{HEAD_BRANCH}}` with the actual branch name, `{{INSTALL_DATE}}` with today's date in YYYY-MM-DD.
9. **Write file** at `TARGET_PATH`. Create parent directories as needed.
   - For CLAUDE.md append: wrap content in `<!-- nf-git-workflow:install -->` ... `<!-- /nf-git-workflow:install -->` and append (or replace existing block).

### Phase 5: Report

10. Print summary:
    - Path written
    - Modes enabled
    - Head branch protected
    - **TODO** items the user must fill in:
      - Preconditions before auto-merge/deploy (tests, lint, build)
      - For `direct-on-head` mode: authorized scope paths
      - NOT-authorized scope paths (infra/config files)
    - Reminder: **reload CC session** so the rule loads into the system prompt.

## Render templates

The skill assembles the output file from these named blocks at runtime. Treat them as literal markdown (after `{{...}}` substitution).

### HEADER (always)

```markdown
<!-- nf-git-workflow:install -->
# Project git workflow

**Head branch**: `{{HEAD_BRANCH}}` — must stay safe at all times.
**Installed**: {{INSTALL_DATE}} via `/nf-git-workflow` skill.

This rule overrides `~/.claude/rules/safety.md` for THIS repo only. Globally, Claude must ask the user before every `git commit` and `git push`. Within this repo, the modes listed below are pre-authorized — Claude (main session and agents) may commit, push, open PRs, and merge without per-action confirmation, provided:

- The work lands on `{{HEAD_BRANCH}}` (directly or via merged PR / local merge).
- The change falls inside the authorized scope (see each mode and the shared NOT-authorized list).
- All preconditions pass (see below).

`{{HEAD_BRANCH}}` is the single source of truth. Keep it safe: no force-push, no hard-reset, no destructive ops without explicit user confirmation.

## Authorized modes

Agent picks whichever enabled mode fits the task. All enabled modes carry the same safety guarantees on `{{HEAD_BRANCH}}`.

```

### MODE_SECTION: worktree-pr

```markdown
### Mode: worktree-pr (safest)

Agent works in an isolated worktree, lands on `{{HEAD_BRANCH}}` via PR.

**Auto-authorized:**
- Spawn agent with `isolation: "worktree"` — `WorktreeCreate` hook (`~/.claude/hooks/worktree-create.sh`) bases the worktree branch on `{{HEAD_BRANCH}}` HEAD.
- Agent: `git commit` and `git push -u origin worktree/<slug>` on the worktree branch.
- Agent: `gh pr create --base {{HEAD_BRANCH}}` from the worktree branch.
- Agent or main session: `gh pr merge <PR#> --merge` (or `--squash`) after preconditions pass.
- Main session: `git pull --ff-only origin {{HEAD_BRANCH}}` to fast-forward after merge.

**NOT permitted in this mode:**
- Main session `git checkout` to the worktree branch — switching branches mid-task resets the working tree and orphans in-flight state. Integrate via pull/merge from the current branch instead.
- Deleting the merged worktree branch — leave branch cleanup to the user in a separate, dedicated session.

```

### MODE_SECTION: worktree-local-merge

```markdown
### Mode: worktree-local-merge (no remote PR)

Same isolation as worktree-pr, but lands on `{{HEAD_BRANCH}}` via local fast-forward merge. Use when the repo has no GitHub remote, or when PR/CI overhead is not worth it.

**Auto-authorized:**
- Spawn agent with `isolation: "worktree"` — `WorktreeCreate` hook bases the worktree branch on `{{HEAD_BRANCH}}` HEAD.
- Agent: `git commit` on the worktree branch.
- Agent: `git push -u origin worktree/<slug>` (optional, for remote backup).
- Main session (already on `{{HEAD_BRANCH}}`): `git fetch origin && git merge --ff-only worktree/<slug>` (or `origin/worktree/<slug>` if push was used).
- Main session: `git push origin {{HEAD_BRANCH}}`.

**NOT permitted in this mode:**
- Non-fast-forward merges (`--no-ff` or merges that would create a merge commit) — require explicit user confirmation.
- Main session `git checkout` to the worktree branch — pull/merge into the current branch instead, to avoid resetting working tree state.

```

### MODE_SECTION: direct-on-head

```markdown
### Mode: direct-on-head (most permissive)

Agent (or main session) commits directly on `{{HEAD_BRANCH}}`. No worktree, no PR. Use for personal/private projects where speed matters more than review.

Restricted to the **authorized scope** below. Anything outside requires explicit user confirmation.

**Authorized scope** — TODO: project owner fills in. Examples:
- `src/content/blog/` (blog content)
- `docs/`
- `notes/`
- `<list paths here>`

**Auto-authorized within scope:**
- `git commit` directly on `{{HEAD_BRANCH}}`.
- `git push origin {{HEAD_BRANCH}}`.

**Always requires confirmation, regardless of scope:**
- Listed in the shared NOT-authorized section below.

```

### FOOTER (always)

```markdown
## Preconditions before auto-merge / auto-deploy / push to `{{HEAD_BRANCH}}`

TODO: project owner fills in. Examples:
- Tests pass (`npm test`, `pytest`, `cargo test`, ...)
- Lint clean (`npm run lint`, `ruff check`, ...)
- Build succeeds (`npm run build`, ...)
- Custom content checks (e.g. for blog: em-dash grep per project rule if present)
- Type check clean (`tsc --noEmit`, `mypy`, ...)

Until filled in, the agent should run any obvious `npm`/`pnpm`/`bun`/`make`/`cargo` test+lint scripts the repo exposes before pushing to `{{HEAD_BRANCH}}` or merging into it.

## NOT auto-authorized (always requires explicit user confirmation)

Regardless of which mode is enabled:

- **Destructive ops**: `git reset --hard`, `git push --force` / `--force-with-lease`, `git branch -d/-D` (local or remote), `git clean -fdx`, `rm -rf` on tracked files.
- **Merging anything other than the active worktree branch into `{{HEAD_BRANCH}}`** (e.g. another env branch, another feature branch).
- **Edits outside authorized scope** — TODO project owner: list paths that should NEVER be auto-edited. Examples:
  - `package.json` (deps, scripts)
  - Build/bundler config (`vite.config.*`, `webpack.config.*`, `tsconfig.json`, `astro.config.*`, ...)
  - CI configs (`.github/workflows/`, `.gitlab-ci.yml`, ...)
  - Deploy configs (`wrangler.toml`, `vercel.json`, `Dockerfile`, `docker-compose.*`, ...)
- **Anything in `.env*`, `.local/`, secrets, credentials, deploy/cloud project config**.
- **Branch cleanup**: deleting merged worktree branches (leave this to the user in a separate, dedicated session).
- **Rebasing or rewriting history** on `{{HEAD_BRANCH}}` or any pushed branch.

## Commit format

Follow standard conventional-commit style (or whatever convention your repo already uses):

- Format: `<prefix>(<branch>): <description>` — branch = `{{HEAD_BRANCH}}` for direct commits, or worktree branch slug when on a worktree.
- Prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `ci:`, `build:`, `revert:`, `security:`, `deps:`.
- Run `git branch --show-current` before every commit (do not trust gitStatus from session start).
- NO `Co-Authored-By:` trailers, NO "Generated with Claude/AI" mentions, NO emoji in commit messages or PR descriptions.

<!-- /nf-git-workflow:install -->
```

## Rules

- NEVER install when cwd is inside a worktree, not the main checkout — would record the wrong head branch. Detect via `git rev-parse --show-toplevel` vs `--git-common-dir`.
- NEVER install on a detached HEAD — `git branch --show-current` returns empty. Stop with a clear error.
- NEVER overwrite an existing rule file silently — always confirm via AskUserQuestion when the target exists.
- NEVER fabricate mode names. Only `worktree-pr`, `worktree-local-merge`, `direct-on-head` are valid. Unknown name → stop with the valid list.
- ALWAYS preserve existing `CLAUDE.md` content when appending — wrap new block in `<!-- nf-git-workflow:install -->` markers so re-install can find and replace it.
- ALWAYS use canonical mode order in the output file (worktree-pr → worktree-local-merge → direct-on-head), regardless of order the user specified.
- ALWAYS remind the user to **reload the CC session** after install — rules load into the system prompt at session start, so a running session will not see the new file until restart.
- ALWAYS leave TODO markers for items the project owner must customize (preconditions, scope paths) — do NOT guess these from the repo structure.

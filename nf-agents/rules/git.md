# Git Convention

## Pre-commit Check

- Before `git commit`, check `git status` for `.env.*` files being staged
- If found, verify `.gitignore` has `.env.*` with `!.env.example` whitelist
- Only `.env.example` (placeholder values, no secrets) should be tracked

## Commit Format

`<prefix>(<ticket-id>): <description>` (max 50 chars, imperative form)

- **MUST run `git branch --show-current` before every commit** to get the actual current branch name. NEVER rely on gitStatus from conversation start - the user may have switched branches
- **Extract ticket ID from that branch name** (e.g., `TICKET-714` from branch `TICKET-714` or `feature/TICKET-714-description`)
- Include ticket ID in parentheses after prefix
- If branch has no ticket ID, use the branch name instead (e.g., `feat(main): ...`, `fix(staging): ...`)

Prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `ci:`, `build:`, `revert:`, `security:`, `deps:`

Breaking changes: add `!` after prefix (e.g., `feat!:`)

Examples:

- `feat(TICKET-714): add background task upload`
- `fix(SCRUM-123): resolve login timeout issue`
- `refactor(JIRA-456): simplify auth logic`

## Branch Naming

`<type>/<ticket-id>-<short-description>`

Types: `feature/`, `fix/`, `hotfix/`, `refactor/`, `docs/`, `test/`

## Attribution

NEVER add to commit messages or PR descriptions:

- `Co-Authored-By:` trailers (any author)
- `Generated with Claude`, `Generated with AI`, or similar lines
- Emojis (no `🤖`, `✨`, `🚀`, etc.)

Keep commit messages and PRs clean and professional.

## GitHub CLI Multi-Account

User manages multiple `gh` accounts. Before any `gh` operation (create repo, PR, issue, etc.):

1. List available accounts: `gh auth status`
2. Check active account vs. required account
3. Infer correct account from remote URL:
   ```bash
   git remote -v  # extract owner/org, match against gh auth status output
   ```
4. Switch if mismatch: `gh auth switch --user <account>`
5. Then proceed

### No remote URL (new repo)

Cannot infer from remote → **MUST ask user before proceeding** which account to use.

### General rule

**NEVER assume which account to use.** Directory path is NOT a reliable signal. When in doubt for any reason — ask the user explicitly.

## Branch Merge Rules

### NEVER merge environment branches into ticket branches

```bash
# FORBIDDEN
git merge origin/development   # NEVER
git merge origin/release       # NEVER
```

### Only `production` (or main) can be merged into a ticket branch

```bash
# ALLOWED - production/main is the source of truth
git merge origin/production    # OK
```

### Ticket-to-ticket dependency is allowed

```bash
# ALLOWED - explicit dependency between tickets
git merge origin/SCRUM-A       # OK if SCRUM-B depends on A
```

## Cross-branch merges — prefer cloud PR, never switch branch

When merging between two existing branches (e.g. promote `main` → `development`, sync `main` into `feature/foo`, post-deploy backmerge): stay on whatever branch you're already on. The hard rule is **don't `git checkout` to another branch just to merge**.

**Cloud PR (preferred — gives audit trail + CI gate)**:
- `gh pr create --base <target> --head <source>` — works from any branch, no checkout
- `gh pr merge <PR#> --merge` (or `--squash`/`--rebase` per project convention)
- `git pull --ff-only origin <current>` only if you're already on `<target>`

**Local merge (acceptable when you don't need review/CI)**:
- If you're already on `<target>`: pull `<source>` directly into your current branch. No checkout, no switch — fine.
  - One-liner: `git pull origin <source>` then `git push`
  - Or two-step: `git fetch origin && git merge origin/<source>` then `git push`
- **Forbidden pattern**: `git checkout <target> && git merge <source> && git push` — switching branches mid-session resets the working tree, orphans scratch files, and breaks any monitoring/debug state.

**User-initiated switch is fine**: if the user explicitly asks to switch to branch X (e.g. "checkout X", "chuyen sang X"), do it. X becomes the new "current branch" and this rule applies to X from then on. The rule only forbids the assistant initiating a checkout as a shortcut to perform a merge — not user-driven workflow changes.

Why: same reasons as `agent-safety.md` "Integration without switching branches" — protect main session state. Applies always, regardless of whether agents are involved.

## Branch Cleanup After Merge

After a PR is merged, do NOT delete the source branch — neither local nor remote.

```bash
# FORBIDDEN after merge
git branch -d feature/SCRUM-123        # NEVER (local)
git branch -D feature/SCRUM-123        # NEVER (local, force)
git push origin --delete feature/...   # NEVER (remote)
gh pr merge --delete-branch ...        # NEVER (use --no-delete-branch or omit)
```

The user manages branch cleanup themselves on their own schedule. Even if a "delete branch" checkbox or flag is the default in a tool, opt out. Leave merged branches alone.

Do NOT ask the user whether to delete the branch after a merge — assume no. The user finds that prompt noisy. Only delete a branch when the user explicitly says so ("delete the branch", "xoa branch", "clean up").

**Why:** The user does branch cleanup in a separate, dedicated session — never mixed with implementation work. Interleaving "implement + delete branch" in the same session is dangerous: full context, fast pace, branch-name typos, and uncertain merge state can lead to deleting the wrong branch or losing unmerged work. Cleanup deserves its own focused pass.

This applies whether the agent merged the PR, the user merged it, or it was auto-merged.

## Branch Case Sensitivity

macOS filesystem is case-insensitive; remote Git servers are case-sensitive. Branches differing only in case (e.g. `feature-SCRUM-884` vs `feature-scrum-884`) appear as one locally but two remotely.

When this situation is detected, inform the user. Do not take corrective action.

---
name: nf-direnv
description: "Set up .envrc with a GitHub token (and future env vars) for the current repo. Detects gh accounts, manages .gitignore, runs direnv allow. Usage: /nf-direnv"
disable-model-invocation: true
---

# direnv Setup

Set up `.envrc` in the current repo with environment variables derived from CLI tools. Currently supports `GH_TOKEN` from `gh auth`; extensible for future variables.

## Workflow

### Phase 1: Preflight checks

1. **Check `direnv` is installed**: run `direnv version`
   - If not found: STOP. Tell user: "direnv is not installed. Install it first: `brew install direnv`" (or your platform's package manager) and exit.
2. **Check this is a git repo**: run `git rev-parse --is-inside-work-tree`
   - If not a git repo: STOP. Tell user this skill only works inside a git repository.

### Phase 2: Select GitHub account

3. **List `gh` accounts**: run `gh auth status` to enumerate all authenticated accounts.
4. **Ask user to select** which account to use for this repo
   - Show all available accounts via `AskUserQuestion`.
   - If only one account is authenticated, auto-pick it after showing the user.
   - Wait for user response before proceeding when there are two or more.

### Phase 3: Prepare .envrc content

5. **Read existing `.envrc`** (if it exists) and check current content.
6. **Prepare changes:**
   - If `.envrc` does not exist: create with full content (see template below).
   - If `.envrc` exists but has no `GH_TOKEN`: append the export line.
   - If `.envrc` exists and already has `GH_TOKEN`: update the value in-place.
7. **Show preview** with three sections, then ask user to confirm before writing:
   - **Before:** current `.envrc` content (or "file does not exist")
   - **After:** full `.envrc` content after changes
   - **Diff:** only the lines added/changed (unified diff style)

### Phase 4: Write .envrc

8. **Write `.envrc`** after user confirms.
9. **Run `direnv allow`** in the repo root to activate.

### Phase 5: Gitignore

10. **Check `.gitignore`** for `.envrc` pattern.
    - If `.envrc` is already ignored: skip, report OK.
    - If `.envrc` is NOT ignored: add `.envrc` to `.gitignore` and show the change.
11. **Ask user to commit** the `.gitignore` change (if any).
    - Only `.gitignore`, NEVER commit `.envrc` itself.
    - If user says yes: commit following git conventions from your host setup (check branch, extract ticket ID, etc.).
    - If user says no: leave uncommitted.

## .envrc template

Use `$(gh auth token --user <account>)` so the token is resolved dynamically each time direnv loads. No plaintext secrets in the file, and token rotation is automatic.

For new files, use this structure:

```bash
# direnv, project environment variables
# Managed by /nf-direnv

# GitHub CLI
export GH_TOKEN=$(gh auth token --user <selected-account>)
```

When appending to an existing file, add a blank line separator and the comment + export line.

## Rules

- NEVER hardcode tokens, always use `$(gh auth token --user ...)` for dynamic resolution.
- NEVER proceed without user confirmation at both the account selection and `.envrc` preview steps.
- NEVER overwrite existing `.envrc` content unrelated to `GH_TOKEN`, only add/update the `GH_TOKEN` line.
- Always run `direnv allow` after writing `.envrc`.
- Always show clear output at each step so user knows what happened.
- If `gh auth token` fails, tell user to run `gh auth login` first.
- `.envrc` should still be gitignored, it contains per-developer config (account selection varies per person).

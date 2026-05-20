# nf-git-workflow

A Claude Code skill that **installs a project-scoped git workflow rule** which overrides the global "ask before every commit/push" safety rule for one specific repo. The current branch at install time becomes the protected head; one or more of three authorization modes (`worktree-pr`, `worktree-local-merge`, `direct-on-head`) define how work lands on it.

This is the white-labeled, shareable version of a skill I use day to day. Examples and references have been generalized so you can drop it into any setup.

## Why this skill exists

The default global rule for my Claude Code setup is: **never `git commit` or `git push` unless the user explicitly says so**. That rule is correct for unfamiliar repos, for client code, for anything where a stray commit would be awkward. It is wrong for repos I own and want to move quickly in: a personal blog, a notes vault, my own config repo. Asking "Commit now?" after every typo fix is friction without payoff.

`nf-git-workflow` is the per-repo opt-in to that override. You run `/nf-git-workflow` inside a repo, pick the level of autonomy you want (`worktree-pr` for safest, `direct-on-head` for fastest), and it writes a `.claude/rules/git-workflow.md` file that the next session loads. From then on, in that repo only, the agent may commit, push, open PRs, and merge without per-action confirmation, as long as the work lands on the protected head branch and stays inside the declared scope.

The skill is intentionally **stack-agnostic**. It does not know if the repo is Node, Rust, Python, or static HTML. It writes scaffolding with TODO markers where project-specific bits go (test commands, deploy commands, authorized paths, NOT-authorized paths). The user fills those in once after install.

The three modes are not exclusive. A project can enable any subset:

- `worktree-pr` — safest, most ceremony. Agent works in `worktree/<slug>`, opens a PR, auto-merges. Audit trail and CI gate.
- `worktree-local-merge` — same isolation, but lands on head via a local fast-forward merge. For repos without a GitHub remote, or where PR overhead is not worth it.
- `direct-on-head` — most permissive, scope-restricted. Agent commits directly on head. Only valid for declared paths (e.g. `src/content/`, `docs/`, `notes/`).

## Install

1. Copy the `nf-git-workflow/` folder into `~/.claude/skills/`:

   ```bash
   cp -r nf-git-workflow ~/.claude/skills/
   ```

   The end result should be `~/.claude/skills/nf-git-workflow/SKILL.md`.

2. Verify Claude Code sees it. In a new Claude Code session, type `/nf-git-workflow` and the skill should appear in the slash-command list.

## Required environment

The skill runs three preflight checks before doing anything:

1. **Cwd must be inside a git repo.** `git rev-parse --is-inside-work-tree` must succeed.
2. **Cwd must NOT be inside a worktree** (the main checkout only). If you run the skill from a worktree, it would record the worktree branch name as the protected head, which is almost certainly wrong. Detected via `git rev-parse --show-toplevel` vs `git rev-parse --git-common-dir`.
3. **HEAD must not be detached.** `git branch --show-current` must return a non-empty branch name. The skill stops with a clear error otherwise.

The output rule file lands at either `.claude/rules/git-workflow.md` (default, recommended) or appended to an existing `CLAUDE.md` (wrapped in marker comments so re-installs can find and replace the block).

## Usage

Type `/nf-git-workflow [mode]` from a Claude Code session, where `[mode]` is one of:

| Invocation | What it installs |
|---|---|
| `/nf-git-workflow` | Interactive multi-select picker. You choose 1-3 modes. |
| `/nf-git-workflow worktree-pr` | Single mode: worktree + PR + auto-merge. |
| `/nf-git-workflow worktree-local-merge` | Single mode: worktree + local fast-forward merge. |
| `/nf-git-workflow direct-on-head` | Single mode: direct commits on head (scope-restricted). |
| `/nf-git-workflow worktree-pr,direct-on-head` | Multi-mode (comma or space separated). |
| `/nf-git-workflow all` | All 3 modes. |

After install, **reload the Claude Code session**. Project rules are loaded into the system prompt at session start; a running session will not see the new file until restart.

## The 3 modes explained

### `worktree-pr` (safest)

Agent spawns into an isolated worktree (`worktree/<slug>`) based on the head's current HEAD. Edits, commits, and pushes happen on the worktree branch. When the work is done, the agent opens a PR with `gh pr create --base <head>`, waits for CI, then auto-merges via `gh pr merge --merge` (or `--squash`). The main session fast-forwards via `git pull --ff-only`.

Use this when the repo is shared (multiple maintainers, code review culture) or when you want a paper trail for every change. The PR provides the audit log and the CI gate.

### `worktree-local-merge` (no remote PR)

Same isolation as `worktree-pr`, but instead of opening a PR, the main session pulls the worktree branch in locally via `git merge --ff-only`. Optionally push to remote for backup. Use this for repos without a GitHub remote, or where PR/CI overhead is not worth it for solo work.

The hard rule: only fast-forward merges. A non-fast-forward merge means scope creep happened or the head moved during the agent's work, and the user should look at the diff before merging.

### `direct-on-head` (most permissive)

Agent commits directly on the head branch. No worktree, no PR. Use this for personal projects where speed matters more than review (a blog, a notes vault, your own dotfiles repo).

This mode is **scope-restricted**. The skill scaffolds an `Authorized scope` section with TODO markers where the user lists which paths are safe to auto-edit (e.g. `src/content/blog/`, `docs/`, `notes/`). Anything outside the scope still requires explicit user confirmation, even with this mode enabled.

## What goes in the generated rule file

The generated `.claude/rules/git-workflow.md` (or marker block in `CLAUDE.md`) has this structure:

1. **Header**: declares the head branch, install date, and the scope of the override (this repo only).
2. **Authorized modes section**: one subsection per mode the user enabled, in canonical order (`worktree-pr` → `worktree-local-merge` → `direct-on-head`).
3. **Preconditions before auto-merge / auto-deploy / push**: TODO scaffold for the project owner to fill in (tests, lint, build commands).
4. **NOT auto-authorized section**: lists destructive ops, edits outside scope, anything in `.env*`/`.local/`/secrets. Always requires explicit user confirmation. The "edits outside scope" subsection has its own TODO scaffold.
5. **Commit format**: re-states the global commit convention so agents do not have to look it up elsewhere.

The whole block is wrapped in `<!-- nf-git-workflow:install -->` ... `<!-- /nf-git-workflow:install -->` markers, so re-running the skill cleanly replaces the previous install without touching anything else in the file.

## Customizing

After install, open the generated `.claude/rules/git-workflow.md` and fill in the TODO scaffolds:

- **Preconditions**: list the actual commands that must pass before pushing or merging to head. Examples: `npm test`, `npm run lint`, `npm run build`, `tsc --noEmit`, `ruff check`, `cargo test`. If the project has a content-quality check (e.g. a forbidden-string grep), add it here.
- **`direct-on-head` authorized scope** (only if you enabled that mode): list paths the agent may edit directly without confirmation. Be specific (`src/content/blog/` is better than `src/`).
- **NOT-authorized scope**: list paths that should NEVER be auto-edited regardless of mode. Examples: `package.json`, `astro.config.*`, `.github/workflows/`, `Dockerfile`, `wrangler.toml`. The skill seeds this list with generic examples; tighten it for your stack.

You can re-run `/nf-git-workflow` at any time to replace the block (the marker comments make the replacement deterministic).

## Anti-patterns

- Do not run this skill in a repo you do not own or have full commit authority on. The whole point is to authorize unattended writes; the wrong repo plus the wrong scope is a recipe for awkward force-pushes you have to apologize for.
- Do not run from inside a worktree. The skill explicitly refuses, but the reason is worth understanding: the worktree branch is temporary and project-specific, and recording it as the protected head would mean the override applies to a branch that gets deleted next week.
- Do not enable `direct-on-head` without filling in the authorized scope. The mode is scope-restricted by design; an empty scope means nothing is authorized, and the agent will keep asking for confirmation anyway.
- Do not edit the marker comments by hand. They are the contract between this skill and any future re-install. If you want to keep custom content alongside the generated block, put it outside the markers.
- Do not forget to reload the Claude Code session after install. Rules load at session start. A running session will not see the new file.

## License

MIT. See `LICENSE`.

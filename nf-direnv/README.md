# nf-direnv

A Claude Code skill that **sets up `.envrc`** in the current repo with a `GH_TOKEN` resolved dynamically via `gh auth`. Picks the right `gh` account for multi-account setups, verifies `.envrc` is gitignored, and runs `direnv allow` so the file actually loads.

This is the white-labeled, shareable version of a skill I use whenever a new repo needs a per-repo `GH_TOKEN`. Examples and references have been generalized so you can drop it into any setup.

Blog write-up: [nf-direnv, a per-repo `.envrc` with a dynamic GitHub token](https://blog.nghia-pham.com/blog/nf-direnv/).

## Why this skill exists

Per-repo environment configuration is one of those tasks that looks trivial until you account for the details. To wire a `GH_TOKEN` into `.envrc` correctly you have to:

1. Check `direnv` is installed and the cwd is a git repo.
2. List authenticated `gh` accounts and pick the right one for this repo.
3. Either create `.envrc` from scratch or edit an existing one without clobbering unrelated exports.
4. Make sure `.envrc` is in `.gitignore`.
5. Run `direnv allow` so the new file actually loads in this shell.

Forget any of those and you get a different failure mode: silent token leak, stale account, `direnv` not loading the new file. The skill is a checklist that runs the same way every time, with the right defaults wired in.

The key trick: use `$(gh auth token --user <account>)` in `.envrc` so the token is resolved dynamically each time `direnv` reloads. No plaintext token on disk, no manual edit when rotation happens, no broken state when you switch the global `gh` account.

## Install

1. Copy the `nf-direnv/` folder into `~/.claude/skills/`:

   ```bash
   cp -r nf-direnv ~/.claude/skills/
   ```

   The end result should be `~/.claude/skills/nf-direnv/SKILL.md`.

2. Verify Claude Code sees it. In a new Claude Code session, type `/nf-direnv` from any git repo and the skill should appear.

## Required environment

- **`direnv` installed.** macOS: `brew install direnv`. Linux: `apt install direnv` or equivalent. The skill checks `direnv version` in preflight and aborts with a clear message if not found.
- **`direnv` hooked into your shell.** Add `eval "$(direnv hook zsh)"` (or `bash`, `fish`) to your shell rc file. Without the hook, `.envrc` files are written but never loaded.
- **`gh` CLI installed and authenticated with at least one account.** `gh auth status` must show at least one logged-in account. If not, the skill prompts you to run `gh auth login`.
- **Cwd is a git repo.** `.envrc` is per-repo; the skill refuses to write outside a git working tree.

## Usage

Invoke from any project root:

```text
/nf-direnv
```

No arguments. The skill walks five phases:

1. **Preflight.** Checks `direnv`, checks the cwd is a git repo, reports versions.
2. **Account selection.** Lists `gh auth status` results, asks via `AskUserQuestion`. Auto-picks if only one account is authenticated.
3. **`.envrc` plan.** Reads any existing file, decides between create/append/update, shows Before/After/Diff preview, asks for confirmation.
4. **Apply.** Writes the file, runs `direnv allow`.
5. **Gitignore.** Verifies `.envrc` is in `.gitignore`, adds if missing. Optionally commits the `.gitignore` change (asks first; never commits `.envrc`).

## What the skill writes

For a fresh repo with no existing `.envrc`:

```bash
# direnv, project environment variables
# Managed by /nf-direnv

# GitHub CLI
export GH_TOKEN=$(gh auth token --user <selected-account>)
```

`<selected-account>` is the literal account name you picked in Phase 2 (e.g. `my-personal`, `acme-client`). The `$(...)` syntax means `direnv` runs `gh auth token --user <name>` on every load; the actual token is never written to disk.

For an existing `.envrc`, the skill appends the `GH_TOKEN` block at the end of the file, preserving any other exports already there. If `GH_TOKEN` already exists, the skill updates the value in place (still using the `$(...)` pattern).

## Customizing

- **Default account.** The skill asks every time; there is no compiled-in default. If you find yourself always picking the same account, you can pre-fill the answer in your invocation phrasing (`/nf-direnv use my-work-account`) and the skill will skip the question. Or edit Phase 2 in `SKILL.md` to hard-code your preferred account.
- **Add more env vars.** The skill currently writes one export (`GH_TOKEN`). Extend `SKILL.md` Phase 3 with additional templates: e.g. AWS via `$(aws configure get aws_access_key_id --profile X)` or `$(op read 'op://Personal/...')` if you use 1Password CLI. Same dynamic-resolution principle applies.
- **Change the account selection UI.** The default uses `AskUserQuestion`. You can also accept the account as a slash-command argument and skip the question for one-line invocations.

## Anti-patterns

- Do not hardcode a token in `.envrc`. Even if the file is gitignored, the plaintext value sits on disk indefinitely. Use `$(gh auth token --user X)` so the value is resolved at load time, never written.
- Do not commit `.envrc`. The skill auto-adds it to `.gitignore`. Verify after the run; if you have a custom gitignore layout, double-check the pattern is present.
- Do not skip `direnv allow`. Without it, `direnv` refuses to load the file (security feature; new and modified `.envrc` files need explicit user approval). The skill runs `direnv allow` automatically; do not strip that step out.
- Do not rely on the global active `gh` account being correct when you `cd` in. The skill writes the account name explicitly in `.envrc` so the repo's credentials do not depend on global state.

## License

MIT. See `LICENSE`.
